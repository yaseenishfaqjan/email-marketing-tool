/**
 * Enrolment: deciding who starts an automation, and making sure they start it
 * exactly once.
 *
 * Every trigger funnels through `enrol`, so the rules about double enrolment,
 * re-entry and suppression are written down once instead of once per trigger
 * type.
 */

import { query } from '../db.mjs';

/**
 * Put one contact into one automation.
 *
 * @returns {Promise<{enrolled: boolean, reason?: string, runId?: string}>}
 */
export async function enrol({ automation, contactId, context = {} }, client = null) {
  const run = client ? client.query.bind(client) : query;

  const { rows: contacts } = await run(
    'select id, email, status from contacts where id = $1 and brand_id = $2',
    [contactId, automation.brand_id],
  );
  const contact = contacts[0];
  if (!contact) return { enrolled: false, reason: 'contact not found' };

  // Only a subscribed contact enters a sequence. Somebody who unsubscribed
  // last week must not be pulled back in by an event their product fires.
  if (contact.status !== 'subscribed') {
    return { enrolled: false, reason: `contact is ${contact.status}` };
  }

  const { rows: sup } = await run(
    'select 1 from suppressions where email = $2 and (brand_id is null or brand_id = $1) limit 1',
    [automation.brand_id, contact.email],
  );
  if (sup.length) return { enrolled: false, reason: 'suppressed' };

  // One ACTIVE run per person per automation, enforced by a partial unique
  // index. A double-fired event must not put somebody through the sequence
  // twice in parallel.
  const { rows: active } = await run(
    "select id from automation_runs where automation_id = $1 and contact_id = $2 and status = 'active'",
    [automation.id, contactId],
  );
  if (active.length) return { enrolled: false, reason: 'already in this automation' };

  const { rows: previous } = await run(
    `select id, completed_at, run_count from automation_runs
      where automation_id = $1 and contact_id = $2
      order by started_at desc limit 1`,
    [automation.id, contactId],
  );

  if (previous.length) {
    // A welcome series must never repeat. An abandoned-checkout series must.
    // The automation says which it is.
    if (!automation.re_entry) return { enrolled: false, reason: 'already completed, re-entry disabled' };

    const finishedAt = previous[0].completed_at;
    const cooldownMs = (automation.re_entry_cooldown_hours ?? 24) * 3_600_000;
    if (finishedAt && Date.now() - new Date(finishedAt).getTime() < cooldownMs) {
      return { enrolled: false, reason: 'within re-entry cooldown' };
    }
  }

  const { rows } = await run(
    `insert into automation_runs (automation_id, contact_id, context, run_count)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning id`,
    [automation.id, contactId, JSON.stringify(context), (previous[0]?.run_count ?? 0) + 1],
  );

  // A concurrent enrolment won the race. That is the index doing its job.
  if (!rows[0]) return { enrolled: false, reason: 'already in this automation' };

  return { enrolled: true, runId: rows[0].id };
}

/** Active automations for a brand matching a trigger type. */
async function triggersFor(brandId, triggerType, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `select * from automations
      where brand_id = $1 and trigger_type = $2 and status = 'active'`,
    [brandId, triggerType],
  );
  return rows;
}

/**
 * A product event arrived. Start every automation listening for it.
 *
 * Several automations may watch the same event — a trial-activation sequence
 * and an internal alert, say — so this enrols into all of them.
 */
export async function onEvent({ brandId, contactId, name, properties = {} }, client = null) {
  const automations = await triggersFor(brandId, 'event', client);
  const results = [];

  for (const automation of automations) {
    if (automation.trigger_config?.event !== name) continue;

    // Optional property filter, so one event name can drive several sequences:
    // {"event": "purchase", "match": {"plan": "pro"}}
    const match = automation.trigger_config?.match;
    if (match && typeof match === 'object') {
      const ok = Object.entries(match).every(([k, v]) => String(properties?.[k]) === String(v));
      if (!ok) continue;
    }

    const result = await enrol({ automation, contactId, context: { event: name, properties } }, client);
    results.push({ automation: automation.id, name: automation.name, ...result });
  }

  return results;
}

export async function onTagAdded({ brandId, contactId, tagName }, client = null) {
  const automations = await triggersFor(brandId, 'tag_added', client);
  const results = [];
  for (const automation of automations) {
    if (automation.trigger_config?.tag !== tagName) continue;
    const result = await enrol({ automation, contactId, context: { tag: tagName } }, client);
    results.push({ automation: automation.id, name: automation.name, ...result });
  }
  return results;
}

export async function onSubscribed({ brandId, contactId, source = null }, client = null) {
  const automations = await triggersFor(brandId, 'subscribed', client);
  const results = [];
  for (const automation of automations) {
    // An optional source filter lets each signup form have its own welcome
    // sequence without a separate trigger type.
    const wanted = automation.trigger_config?.source;
    if (wanted && wanted !== source) continue;
    const result = await enrol({ automation, contactId, context: { source } }, client);
    results.push({ automation: automation.id, name: automation.name, ...result });
  }
  return results;
}
