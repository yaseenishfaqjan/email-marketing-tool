/**
 * Recording a product event.
 *
 * The write and the automation enrolment happen in ONE transaction. If the
 * enrolment failed after the event was already stored, a retry from the
 * product would be de-duplicated by the idempotency key and the automation
 * would never start — the customer's trial email simply never arrives, and
 * nothing anywhere says why.
 */

import { tx } from '../db.mjs';
import { onEvent } from '../automations/enrol.mjs';
import * as contacts from '../contacts/repo.mjs';

export class EventError extends Error {}

/**
 * @param {object} args
 * @param {string} args.brandId
 * @param {string} args.email          who did it
 * @param {string} args.name           the event name, e.g. 'trial_started'
 * @param {object} [args.properties]
 * @param {string} [args.idempotencyKey]
 * @param {boolean} [args.createContact]  create the contact if unknown
 * @param {object|null} [args.subscribe]   the caller asserting opt-in consent:
 *   { consent_source: 'Signed up at app.example.com/register', consent_ip?: '…' }
 */
export async function recordEvent({
  brandId, email, name, properties = {}, idempotencyKey = null, createContact = true,
  subscribe = null,
}) {
  if (!contacts.isValidEmail(email)) throw new EventError('A valid email address is required.');
  if (typeof name !== 'string' || !name.trim()) throw new EventError('An event name is required.');
  if (name.length > 100) throw new EventError('Event names are limited to 100 characters.');

  const normalised = contacts.normaliseEmail(email);

  return tx(async (client) => {
    let contact = await contacts.getByEmail(brandId, normalised);

    // Doing something in an app is not, by itself, consent to receive
    // marketing email — so an unknown address is created as 'pending' and
    // enters no sequence.
    //
    // A product that DID collect consent says so explicitly, and says where.
    // That is the difference between a lifecycle email somebody asked for and
    // a spam complaint, and `consent_source` is the evidence when one of them
    // asks why they are on the list.
    const consented = subscribe && typeof subscribe === 'object';
    if (consented && !subscribe.consent_source) {
      throw new EventError('subscribe.consent_source is required — record what the person actually agreed to.');
    }

    if (!contact && createContact) {
      contact = await contacts.upsert(brandId, {
        email: normalised,
        status: consented ? 'subscribed' : 'pending',
        source: `event:${name}`,
        consent_at: consented ? new Date().toISOString() : null,
        consent_ip: consented ? (subscribe.consent_ip ?? null) : null,
        consent_source: consented ? String(subscribe.consent_source).slice(0, 200) : null,
      }, client);
    } else if (contact && consented && contact.status === 'pending') {
      // Moves 'pending' forward only. Somebody who unsubscribed stays
      // unsubscribed whatever a product asserts — that decision is theirs, not
      // the product's.
      const { rows: updated } = await client.query(
        `update contacts
            set status = 'subscribed', updated_at = now(),
                consent_at = coalesce(consent_at, now()),
                consent_source = coalesce(consent_source, $3)
          where id = $1 and brand_id = $2 and status = 'pending'
          returning *`,
        [contact.id, brandId, String(subscribe.consent_source).slice(0, 200)],
      );
      if (updated[0]) contact = updated[0];
    }

    if (!contact) return { recorded: false, reason: 'contact not found' };

    const { rows } = await client.query(
      `insert into events (brand_id, contact_id, name, properties, idempotency_key)
       values ($1,$2,$3,$4,$5)
       on conflict (brand_id, idempotency_key) where idempotency_key is not null
       do nothing
       returning id`,
      [brandId, contact.id, name.trim(), JSON.stringify(properties ?? {}), idempotencyKey],
    );

    // A repeat delivery of the same event. Answer success — the product did
    // its job — but do not enrol anybody a second time.
    if (!rows[0]) return { recorded: false, duplicate: true, contactId: contact.id };

    const enrolments = await onEvent({
      brandId, contactId: contact.id, name: name.trim(), properties,
    }, client);

    return { recorded: true, eventId: rows[0].id, contactId: contact.id, enrolments };
  });
}
