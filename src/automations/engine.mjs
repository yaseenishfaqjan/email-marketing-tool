/**
 * The automation engine.
 *
 * One tick claims the runs whose time has come, executes a single step for
 * each, and schedules the next. The scheduler is a Postgres poll, not a pile
 * of delayed jobs:
 *
 *   select * from automation_runs
 *    where status = 'active' and next_run_at <= now()
 *    order by next_run_at limit N
 *    for update skip locked;
 *
 * SKIP LOCKED is what lets several workers run that query at once without
 * anybody being processed twice. And a row with a next_run_at can be
 * inspected, counted and rescheduled -- a three-day wait parked inside a job
 * queue is invisible, and gone the moment somebody flushes it.
 *
 * One step per tick, deliberately. A run that executes its whole sequence in
 * one pass would hold a transaction open across a webhook call, and a crash
 * halfway would leave no record of how far it got.
 */

import { query, tx } from '../db.mjs';
import { compileSegment } from '../segments/compile.mjs';
import { waitMs } from './steps.mjs';
import { isSuppressed } from '../suppression/repo.mjs';

const DEFAULT_BATCH = 200;

/**
 * Lock one run for this transaction, or return null if another worker has it.
 *
 * SKIP LOCKED is what makes several workers safe on the same table: the second
 * one silently gets nothing back instead of blocking or double-processing.
 * The status is re-checked under the lock, because the run may have been
 * cancelled between being listed and being claimed.
 */
async function claimOne(client, id) {
  const { rows } = await client.query(
    `select r.*, a.brand_id, a.status as automation_status
       from automation_runs r
       join automations a on a.id = r.automation_id
      where r.id = $1 and r.status = 'active' and r.next_run_at <= now()
      for update of r skip locked`,
    [id],
  );
  return rows[0] ?? null;
}

async function stepsFor(client, automationId) {
  const { rows } = await client.query(
    'select * from automation_steps where automation_id = $1 order by position',
    [automationId],
  );
  return rows;
}

async function complete(client, run, status = 'completed', error = null) {
  await client.query(
    `update automation_runs
        set status = $2, completed_at = now(), last_error = $3
      where id = $1`,
    [run.id, status, error],
  );
}

/**
 * Move the run forward — or finish it, if that was the last step.
 *
 * Completing here rather than on the next pass matters twice over: a run left
 * 'active' with nothing left to do is counted as in-flight in every report,
 * and it costs one more scheduler pass per person for no reason.
 */
async function advance(client, run, steps, { toStep, nextRunAt = new Date() }) {
  if (toStep >= steps.length) {
    await complete(client, run);
    return true;
  }
  await client.query(
    'update automation_runs set current_step = $2, next_run_at = $3, last_error = null where id = $1',
    [run.id, toStep, nextRunAt],
  );
  return false;
}

/**
 * Queue an automation email.
 *
 * It becomes an ordinary row in `messages`, so it inherits the whole sending
 * pipeline: the rate limiter, the suppression re-check at send time, tracking,
 * one-click unsubscribe. The partial unique index on
 * (automation_run_id, automation_step_id) makes a re-executed step a no-op
 * rather than a second copy in somebody's inbox.
 */
async function queueEmail(client, run, step) {
  const { rowCount } = await client.query(
    `insert into messages (brand_id, contact_id, automation_run_id, automation_step_id)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [run.brand_id, run.contact_id, run.id, step.id],
  );
  return rowCount > 0;
}

async function evaluateCondition(client, run, step) {
  const { sql, params } = compileSegment(step.config.rules ?? step.config.definition, 2);
  const { rows } = await client.query(
    `select 1 from contacts c where c.id = $1 and ${sql} limit 1`,
    [run.contact_id, ...params],
  );
  return rows.length > 0;
}

async function applyTag(client, run, step, add) {
  const name = String(step.config.tag).slice(0, 64);
  if (add) {
    const { rows } = await client.query(
      `insert into tags (brand_id, name) values ($1,$2)
       on conflict (brand_id, name) do update set name = excluded.name returning id`,
      [run.brand_id, name],
    );
    await client.query(
      'insert into contact_tags (contact_id, tag_id) values ($1,$2) on conflict do nothing',
      [run.contact_id, rows[0].id],
    );
  } else {
    await client.query(
      `delete from contact_tags ct using tags t
        where ct.tag_id = t.id and ct.contact_id = $1 and t.brand_id = $2 and t.name = $3`,
      [run.contact_id, run.brand_id, name],
    );
  }
}

/**
 * Webhook steps are fire-and-forget with a short timeout.
 *
 * A receiving endpoint that is slow or down must never stall somebody's
 * onboarding sequence, so a failure is recorded on the run and the sequence
 * carries on. Anything that genuinely must not be lost belongs in a queue the
 * receiver owns, not in an email automation.
 */
async function callWebhook(run, step, contact) {
  try {
    await fetch(step.config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        automation_run_id: run.id,
        contact: { id: contact.id, email: contact.email, attrs: contact.attrs },
        context: run.context,
        ...(step.config.payload ?? {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    return null;
  } catch (err) {
    return `webhook failed: ${err.message}`;
  }
}

/**
 * Execute exactly one step of one run.
 * @returns {Promise<{action: string, detail?: string}>}
 */
export async function executeStep(client, run, steps) {
  // Paused or un-published automations stop where they are rather than being
  // cancelled: the author is usually mid-edit, and cancelling would silently
  // drop everyone already in the sequence.
  if (run.automation_status !== 'active') {
    await client.query(
      "update automation_runs set next_run_at = now() + interval '10 minutes' where id = $1",
      [run.id],
    );
    return { action: 'held', detail: `automation is ${run.automation_status}` };
  }

  const step = steps[run.current_step];
  if (!step) {
    await complete(client, run);
    return { action: 'completed' };
  }

  const { rows: contacts } = await client.query(
    'select id, email, first_name, last_name, status, attrs from contacts where id = $1',
    [run.contact_id],
  );
  const contact = contacts[0];

  // Somebody who unsubscribed or hard-bounced leaves the sequence entirely.
  // Checking once at enrolment is not enough -- most of a drip series happens
  // days after the person joined it.
  if (!contact) {
    await complete(client, run, 'cancelled', 'contact deleted');
    return { action: 'cancelled', detail: 'contact deleted' };
  }
  if (contact.status !== 'subscribed') {
    await complete(client, run, 'cancelled', `contact is ${contact.status}`);
    return { action: 'cancelled', detail: `contact is ${contact.status}` };
  }

  const next = run.current_step + 1;

  switch (step.type) {
    case 'wait': {
      // The wait is applied to THIS step, then the run moves on. Storing the
      // target time rather than a countdown means a worker that was down for
      // an hour resumes correctly instead of adding an hour to everybody.
      const done = await advance(client, run, steps, {
        toStep: next,
        nextRunAt: new Date(Date.now() + waitMs(step.config)),
      });
      return { action: done ? 'completed' : 'waiting' };
    }

    case 'email': {
      if (await isSuppressed(run.brand_id, contact.email)) {
        await complete(client, run, 'cancelled', 'suppressed');
        return { action: 'cancelled', detail: 'suppressed' };
      }
      const queued = await queueEmail(client, run, step);
      await advance(client, run, steps, { toStep: next });
      return { action: queued ? 'queued_email' : 'email_already_queued' };
    }

    case 'condition': {
      const matched = await evaluateCondition(client, run, step);
      if (matched) {
        await advance(client, run, steps, { toStep: next });
        return { action: 'condition_true' };
      }
      if ((step.config.otherwise ?? 'exit') === 'continue') {
        await advance(client, run, steps, { toStep: next });
        return { action: 'condition_false_continue' };
      }
      await complete(client, run);
      return { action: 'condition_false_exit' };
    }

    case 'add_tag':
    case 'remove_tag': {
      await applyTag(client, run, step, step.type === 'add_tag');
      await advance(client, run, steps, { toStep: next });
      return { action: step.type };
    }

    case 'webhook': {
      const error = await callWebhook(run, step, contact);
      await advance(client, run, steps, { toStep: next });
      if (error) {
        await client.query('update automation_runs set last_error = $2 where id = $1', [run.id, error]);
      }
      return { action: 'webhook', detail: error ?? 'ok' };
    }

    case 'exit':
    default:
      await complete(client, run);
      return { action: 'completed' };
  }
}

/**
 * One pass of the scheduler.
 *
 * Each run gets its own transaction: a failure in one person's sequence must
 * not roll back everybody else's progress in the same batch.
 */
export async function tick({ limit = DEFAULT_BATCH } = {}) {
  const { rows: due } = await query(
    `select r.id from automation_runs r
      where r.status = 'active' and r.next_run_at <= now()
      order by r.next_run_at limit $1`,
    [limit],
  );
  if (due.length === 0) return { processed: 0, actions: {} };

  const actions = {};
  let processed = 0;

  for (const { id } of due) {
    try {
      const result = await tx(async (client) => {
        const run = await claimOne(client, id);
        if (!run) return null;   // another worker took it, or it is no longer due
        const steps = await stepsFor(client, run.automation_id);
        return executeStep(client, run, steps);
      });
      if (!result) continue;
      actions[result.action] = (actions[result.action] ?? 0) + 1;
      processed += 1;
    } catch (err) {
      console.error('[automations] run %s failed: %s', id, err.message);
      await query(
        // Back off rather than retry instantly: a step that throws will throw
        // again, and a tight loop would burn the worker on one broken run.
        `update automation_runs
            set last_error = $2, next_run_at = now() + interval '15 minutes'
          where id = $1`,
        [id, String(err.message).slice(0, 500)],
      ).catch(() => {});
    }
  }

  return { processed, actions };
}
