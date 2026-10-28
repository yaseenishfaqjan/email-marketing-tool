/**
 * SES event notifications, delivered by SNS.
 *
 * This is the feedback loop that keeps the sending account alive. SES reviews
 * an account whose bounce rate passes 5% or complaint rate passes 0.1%, and
 * pauses it at 10% / 0.5% — for every brand at once. So a hard bounce or a
 * complaint suppresses the address GLOBALLY and immediately, before anything
 * else is done with the event.
 */

import express from 'express';
import config from '../../config.mjs';
import { query, tx } from '../../db.mjs';
import { verifySnsSignature } from '../sns.mjs';
import { verifySvixSignature } from '../svix.mjs';
import { suppress } from '../../suppression/repo.mjs';

const router = express.Router();

// SNS posts with Content-Type: text/plain, which the JSON body parser ignores.
router.use(express.text({ type: '*/*', limit: '512kb' }));

router.post('/ses', async (req, res) => {
  let envelope;
  try {
    envelope = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).send('bad json');
  }

  let valid = false;
  try {
    valid = await verifySnsSignature(envelope);
  } catch (err) {
    console.warn('[sns] verification error: %s', err.message);
  }
  if (!valid) return res.status(403).send('bad signature');

  // Answer SNS straight away. It retries on anything slow or non-2xx, and a
  // retry storm during a big bounce event is the last thing you want.
  res.status(200).send('ok');

  try {
    if (envelope.Type === 'SubscriptionConfirmation') {
      // Confirming completes the subscription. The URL is on an AWS host —
      // the signature check above is what makes following it safe.
      await fetch(envelope.SubscribeURL, { signal: AbortSignal.timeout(5000) });
      console.log('[sns] subscription confirmed for %s', envelope.TopicArn);
      return;
    }
    if (envelope.Type !== 'Notification') return;

    await handleSesEvent(JSON.parse(envelope.Message));
  } catch (err) {
    console.error('[sns] handling failed: %s', err.message);
  }
});

const EVENT_TYPE = {
  Bounce: 'bounce',
  Complaint: 'complaint',
  Delivery: 'delivered',
  Send: 'sent',
  Reject: 'reject',
  Open: 'open',
  Click: 'click',
  DeliveryDelay: 'delivery_delay',
};

export async function handleSesEvent(event) {
  // Configuration-set destinations use eventType; the older per-identity
  // notifications use notificationType. Both are in the wild.
  const kind = event.eventType || event.notificationType;
  const type = EVENT_TYPE[kind];
  const sesMessageId = event.mail?.messageId;
  if (!type || !sesMessageId) return;

  const { rows } = await query(
    'select id, brand_id, contact_id from messages where ses_message_id = $1',
    [sesMessageId],
  );
  const message = rows[0];

  // An event for a message we did not send (another system on the same SES
  // account, or a test from the console) is recorded nowhere and ignored.
  if (!message) return;

  const { rows: contactRows } = await query('select email from contacts where id = $1', [message.contact_id]);
  const email = contactRows[0]?.email;

  await tx(async (client) => {
    await client.query(
      'insert into message_events (message_id, type, meta) values ($1, $2, $3)',
      [message.id, type, JSON.stringify(summarise(event, kind))],
    );

    if (kind === 'Bounce') {
      const permanent = event.bounce?.bounceType === 'Permanent';
      await client.query('update messages set status = $2 where id = $1',
        [message.id, permanent ? 'bounced' : 'sent']);
      if (permanent && email) {
        await client.query("update contacts set status = 'bounced', updated_at = now() where id = $1",
          [message.contact_id]);
        // Global: a dead mailbox is dead for every brand, and repeatedly
        // hitting it is what raises the account's bounce rate.
        await suppress({ brandId: null, email, reason: 'hard_bounce',
          note: event.bounce?.bouncedRecipients?.[0]?.diagnosticCode?.slice(0, 300) ?? null }, client);
      }
    }

    if (kind === 'Complaint' && email) {
      await client.query("update messages set status = 'complained' where id = $1", [message.id]);
      await client.query("update contacts set status = 'complained', updated_at = now() where id = $1",
        [message.contact_id]);
      await suppress({ brandId: null, email, reason: 'complaint',
        note: event.complaint?.complaintFeedbackType ?? null }, client);
    }

    if (kind === 'Delivery') {
      // Never move backwards: a delivery event arriving after a complaint must
      // not overwrite the complaint.
      await client.query("update messages set status = 'delivered' where id = $1 and status = 'sent'",
        [message.id]);
    }

    if (kind === 'Reject') {
      await client.query("update messages set status = 'failed', error = $2 where id = $1",
        [message.id, `rejected: ${event.reject?.reason ?? 'unknown'}`]);
    }
  });
}

/* ------------------------------------------------------------------ resend --
 *
 * Same job as the SES handler above, different vocabulary. Resend signs with
 * Svix rather than an AWS certificate, and names its events `email.bounced`
 * rather than `Bounce`, but a hard bounce still has to suppress the address
 * globally and immediately.
 *
 * Resend's limits are its own, not SES's: it reviews an account whose bounce
 * rate climbs and suspends at the extreme. The shape of the risk is identical
 * — every brand sends from scalaro.io, so one bad list burns all five.
 */

const RESEND_EVENT_TYPE = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delay',
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
  'email.opened': 'open',
  'email.clicked': 'click',
};

router.post('/resend', async (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';

  const check = verifySvixSignature({
    headers: req.headers,
    body: raw,
    secret: config.resend.webhookSecret,
  });
  if (!check.ok) {
    console.warn('[resend] rejected webhook: %s', check.reason);
    return res.status(403).send('bad signature');
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).send('bad json');
  }

  // Answer first. Resend retries non-2xx, and a retry storm during a bounce
  // event is exactly when you least want one.
  res.status(200).send('ok');

  try {
    await handleResendEvent(event);
  } catch (err) {
    console.error('[resend] handling failed: %s', err.message);
  }
});

export async function handleResendEvent(event) {
  const type = RESEND_EVENT_TYPE[event?.type];
  const providerId = event?.data?.email_id;
  if (!type || !providerId) return;

  // ses_message_id holds whichever provider's id sent the message; the column
  // predates there being a second provider. The worker writes Resend's id
  // here too, so the lookup is the same either way.
  const { rows } = await query(
    'select id, brand_id, contact_id from messages where ses_message_id = $1',
    [providerId],
  );
  const message = rows[0];

  // An event for something we did not send — another app on the same Resend
  // account, or a test from their dashboard — is ignored.
  if (!message) return;

  const { rows: contactRows } = await query('select email from contacts where id = $1', [message.contact_id]);
  const email = contactRows[0]?.email;

  await tx(async (client) => {
    await client.query(
      'insert into message_events (message_id, type, meta) values ($1, $2, $3)',
      [message.id, type, JSON.stringify(summariseResend(event))],
    );

    if (event.type === 'email.bounced') {
      // Resend reports Permanent / Transient / Undetermined, and older
      // payloads omit the object entirely. An unknown subtype counts as
      // permanent on purpose: suppressing a live address costs one subscriber
      // and is undone with one call, while continuing to hit a dead one
      // raises the bounce rate for all five brands at once.
      const permanent = event.data?.bounce?.type !== 'Transient';

      await client.query('update messages set status = $2 where id = $1',
        [message.id, permanent ? 'bounced' : 'sent']);

      if (permanent && email) {
        await client.query("update contacts set status = 'bounced', updated_at = now() where id = $1",
          [message.contact_id]);
        await suppress({ brandId: null, email, reason: 'hard_bounce',
          note: event.data?.bounce?.message?.slice(0, 300) ?? null }, client);
      }
    }

    if (event.type === 'email.complained' && email) {
      await client.query("update messages set status = 'complained' where id = $1", [message.id]);
      await client.query("update contacts set status = 'complained', updated_at = now() where id = $1",
        [message.contact_id]);
      await suppress({ brandId: null, email, reason: 'complaint', note: null }, client);
    }

    if (event.type === 'email.delivered') {
      // Never move backwards: a delivery arriving after a complaint must not
      // overwrite it.
      await client.query("update messages set status = 'delivered' where id = $1 and status = 'sent'",
        [message.id]);
    }
  });
}

function summariseResend(event) {
  if (event.type === 'email.bounced') {
    return {
      bounceType: event.data?.bounce?.type,
      bounceSubType: event.data?.bounce?.subType,
      diagnostic: event.data?.bounce?.message?.slice(0, 300),
    };
  }
  if (event.type === 'email.clicked') return { link: event.data?.click?.link };
  if (event.type === 'email.delivery_delayed') return { reason: event.data?.reason };
  return {};
}

function summarise(event, kind) {
  if (kind === 'Bounce') {
    return {
      bounceType: event.bounce?.bounceType,
      bounceSubType: event.bounce?.bounceSubType,
      diagnostic: event.bounce?.bouncedRecipients?.[0]?.diagnosticCode?.slice(0, 300),
    };
  }
  if (kind === 'Complaint') return { feedbackType: event.complaint?.complaintFeedbackType };
  if (kind === 'DeliveryDelay') return { delayType: event.deliveryDelay?.delayType };
  if (kind === 'Click') return { link: event.click?.link };
  return {};
}

export default router;
