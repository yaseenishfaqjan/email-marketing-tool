#!/usr/bin/env node
/**
 * The send worker.
 *
 * Claims batches of queued messages with FOR UPDATE SKIP LOCKED, renders each
 * one, and hands it to SES under a rate limit. SKIP LOCKED is what lets more
 * than one worker run the same query without any message being claimed twice.
 *
 * Run it as its own process: `npm run worker`.
 */

import { pathToFileURL } from 'node:url';
import config from '../config.mjs';
import { pool, query, tx, close } from '../db.mjs';
import { compileTemplate, renderMessage } from '../sending/renderer.mjs';
import { buildMime } from '../sending/mime.mjs';
import { sendRaw, classifyError } from '../sending/ses.mjs';
import { TokenBucket } from '../sending/rate-limit.mjs';
import { finaliseIfDone } from '../campaigns/materialise.mjs';
import { tick as automationTick } from '../automations/engine.mjs';

const MAX_ATTEMPTS = 5;
const bucket = new TokenBucket(config.ses.maxSendRate);

let running = true;

/**
 * Compiled MJML, keyed by campaign or automation step.
 *
 * Compiling MJML takes tens of milliseconds and produces identical output for
 * every recipient. At 50,000 recipients, caching it is the difference between
 * a send that takes minutes and one that takes an hour.
 */
const templateCache = new Map();

const brandFrom = (row) => ({
  id: row.brand_id,
  name: row.brand_name,
  from_name: row.from_name,
  from_email: row.from_email,
  reply_to: row.reply_to,
  postal_address: row.postal_address,
  tracking_domain: row.tracking_domain,
  ses_config_set: row.ses_config_set,
  sending_domain: row.sending_domain,
});

const BRAND_COLUMNS = `b.name as brand_name, b.from_name, b.from_email, b.reply_to,
       b.postal_address, b.tracking_domain, b.ses_config_set, b.sending_domain`;

/**
 * Everything needed to render one message, whatever produced it.
 *
 * A campaign send and an automation send are the same thing downstream: same
 * queue, same rate limit, same suppression re-check, same tracking. Only the
 * source of the subject and body differs.
 */
async function loadMessageContext(message) {
  const key = message.campaign_id
    ? `campaign:${message.campaign_id}`
    : `step:${message.automation_step_id}`;
  if (templateCache.has(key)) return templateCache.get(key);

  let ctx = null;

  if (message.campaign_id) {
    const { rows } = await query(
      `select c.id, c.subject, c.mjml, c.brand_id, ${BRAND_COLUMNS}
         from campaigns c join brands b on b.id = c.brand_id
        where c.id = $1`,
      [message.campaign_id],
    );
    if (rows[0]) {
      ctx = {
        source: { kind: 'campaign', id: rows[0].id },
        subject: rows[0].subject,
        brand: brandFrom(rows[0]),
        compiledHtml: compileTemplate(rows[0].mjml),
      };
    }
  } else if (message.automation_step_id) {
    const { rows } = await query(
      `select s.id, s.config, a.id as automation_id, a.brand_id, ${BRAND_COLUMNS}
         from automation_steps s
         join automations a on a.id = s.automation_id
         join brands b on b.id = a.brand_id
        where s.id = $1`,
      [message.automation_step_id],
    );
    if (rows[0]?.config?.mjml) {
      ctx = {
        source: { kind: 'automation', id: rows[0].automation_id, stepId: rows[0].id },
        subject: rows[0].config.subject,
        brand: brandFrom(rows[0]),
        compiledHtml: compileTemplate(rows[0].config.mjml),
      };
    }
  }

  if (ctx) templateCache.set(key, ctx);
  return ctx;
}

/** Take up to `limit` messages, marking them 'sending' so nobody else picks them up. */
export async function claimBatch(limit) {
  const { rows } = await query(
    `with claimed as (
       select id from messages
        where status = 'queued'
        order by queued_at
        limit $1
        for update skip locked
     )
     update messages m
        set status = 'sending', attempts = m.attempts + 1, locked_at = now()
       from claimed
      where m.id = claimed.id
      returning m.id, m.campaign_id, m.automation_run_id, m.automation_step_id,
                m.contact_id, m.brand_id, m.attempts`,
    [limit],
  );
  return rows;
}

async function markSent(message, sesMessageId) {
  await tx(async (client) => {
    await client.query(
      `update messages set status = 'sent', ses_message_id = $2, sent_at = now(), error = null
        where id = $1`,
      [message.id, sesMessageId],
    );
    await client.query(
      "insert into message_events (message_id, type) values ($1, 'sent')",
      [message.id],
    );
  });
}

async function markFailed(message, reason) {
  await tx(async (client) => {
    await client.query(
      "update messages set status = 'failed', error = $2 where id = $1",
      [message.id, String(reason).slice(0, 500)],
    );
    await client.query(
      "insert into message_events (message_id, type, meta) values ($1, 'failed', $2)",
      [message.id, JSON.stringify({ reason: String(reason).slice(0, 500) })],
    );
  });
}

/** Put it back in the queue for another attempt, or give up after MAX_ATTEMPTS. */
async function requeue(message, reason) {
  if (message.attempts >= MAX_ATTEMPTS) {
    await markFailed(message, `gave up after ${message.attempts} attempts: ${reason}`);
    return;
  }
  await query(
    "update messages set status = 'queued', locked_at = null, error = $2 where id = $1",
    [message.id, String(reason).slice(0, 500)],
  );
}

async function skip(message, reason) {
  await query(
    "update messages set status = 'skipped', error = $2 where id = $1",
    [message.id, reason],
  );
}

export async function processMessage(message) {
  const ctx = await loadMessageContext(message);
  if (!ctx) return markFailed(message, 'the campaign, automation step or brand is missing');

  const { rows } = await query(
    'select id, email, first_name, last_name, status, attrs from contacts where id = $1',
    [message.contact_id],
  );
  const contact = rows[0];
  if (!contact) return skip(message, 'contact deleted');

  // Re-check at send time, not only when the campaign was materialised. A big
  // broadcast can take an hour to drain, and an unsubscribe or a complaint
  // that lands in the middle of it must be honoured.
  if (contact.status !== 'subscribed') return skip(message, `contact is ${contact.status}`);
  const { rows: sup } = await query(
    `select 1 from suppressions where email = $2 and (brand_id is null or brand_id = $1) limit 1`,
    [message.brand_id, contact.email],
  );
  if (sup.length) return skip(message, 'suppressed');

  const rendered = renderMessage({
    brand: ctx.brand,
    contact,
    messageId: message.id,
    subject: ctx.subject,
    compiledHtml: ctx.compiledHtml,
  });

  const raw = buildMime({
    fromName: ctx.brand.from_name,
    fromEmail: ctx.brand.from_email,
    to: contact.email,
    replyTo: ctx.brand.reply_to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    unsubscribeUrl: rendered.unsubscribeUrl,
    unsubscribeMailto: `unsubscribe@${ctx.brand.sending_domain}`,
    headers: {
      [ctx.source.kind === 'campaign' ? 'X-Campaign-Id' : 'X-Automation-Id']: ctx.source.id,
      'X-Message-Id': message.id,
    },
  });

  await bucket.take();

  try {
    const { messageId } = await sendRaw({
      raw,
      from: ctx.brand.from_email,
      to: contact.email,
      configurationSet: ctx.brand.ses_config_set,
    });
    await markSent(message, messageId);
  } catch (err) {
    const kind = classifyError(err);
    if (kind === 'permanent') {
      await markFailed(message, `${err.name}: ${err.message}`);
    } else {
      // Throttling means the bucket is set too high for the real quota; say so
      // once per batch rather than silently sending slower forever.
      if (kind === 'throttle') console.warn('[worker] throttled by SES — lower SES_MAX_SEND_RATE');
      await requeue(message, `${err.name}: ${err.message}`);
    }
  }
}

export async function tick() {
  const batch = await claimBatch(config.worker.batchSize);
  if (batch.length === 0) return 0;

  // Sequential, not parallel: the rate limiter already decides the pace, and
  // running them in parallel just means more sockets waiting on the same
  // bucket.
  for (const message of batch) {
    if (!running) break;
    try {
      await processMessage(message);
    } catch (err) {
      console.error('[worker] message %s failed unexpectedly: %s', message.id, err.message);
      await requeue(message, err.message).catch(() => {});
    }
  }

  for (const campaignId of new Set(batch.map((m) => m.campaign_id).filter(Boolean))) {
    await finaliseIfDone(campaignId).catch((err) =>
      console.error('[worker] finalise %s: %s', campaignId, err.message));
  }

  return batch.length;
}

/**
 * Messages left 'sending' by a worker that died are invisible to everybody:
 * not queued, so never claimed; not sent, so the campaign never finishes.
 * Anything stuck for more than ten minutes goes back in the queue.
 */
export async function recoverStuck() {
  const { rowCount } = await query(
    `update messages set status = 'queued', locked_at = null
      where status = 'sending' and locked_at < now() - interval '10 minutes'`,
  );
  if (rowCount) console.warn('[worker] recovered %d stuck message(s)', rowCount);
}

/** Campaigns whose scheduled time has arrived. */
export async function startDueCampaigns() {
  const { rows } = await query(
    `select id from campaigns where status = 'scheduled' and scheduled_at <= now() limit 10`,
  );
  for (const { id } of rows) {
    const { materialiseCampaign } = await import('../campaigns/materialise.mjs');
    try {
      const { recipients } = await materialiseCampaign(id);
      console.log('[worker] campaign %s materialised: %d recipient(s)', id, recipients);
    } catch (err) {
      console.error('[worker] campaign %s failed to start: %s', id, err.message);
      await query("update campaigns set status = 'failed', updated_at = now() where id = $1", [id]);
    }
  }
}

async function main() {
  console.log('[worker] started — sending at %d/s in batches of %d, automations every pass%s',
    config.ses.maxSendRate, config.worker.batchSize,
    config.ses.sandbox ? ' — SES SANDBOX' : '');

  let sinceHousekeeping = 0;

  while (running) {
    try {
      if (sinceHousekeeping++ % 30 === 0) {
        await recoverStuck();
        await startDueCampaigns();
      }

      // Automations advance first. A wait that expired needs to queue its
      // email before this pass drains the queue, or it sits idle until the
      // next one -- which at a two-second poll nobody notices, but at a slow
      // poll on a quiet night is an hour's delay on a trial-expiry email.
      const auto = await automationTick();
      if (auto.processed) {
        console.log('[worker] automations: %d step(s) %j', auto.processed, auto.actions);
      }

      const n = await tick();
      if (n === 0 && auto.processed === 0) {
        await new Promise((r) => setTimeout(r, config.worker.pollMs));
      }
    } catch (err) {
      console.error('[worker] loop error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await close();
  console.log('[worker] stopped');
}

/** Compiled templates are cached for the life of the process; tests need them fresh. */
export function clearTemplateCache() {
  templateCache.clear();
}

// Only run the loop when this file IS the process, so the module can be
// imported by a test without a worker starting underneath it.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!running) process.exit(1);   // second signal: stop waiting
      console.log('[worker] finishing the current batch…');
      running = false;
    });
  }

  main().catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
