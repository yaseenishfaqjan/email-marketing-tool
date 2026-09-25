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
import { query, tx } from '../../db.mjs';
import { verifySnsSignature } from '../sns.mjs';
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
