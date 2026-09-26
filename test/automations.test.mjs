/**
 * The automation engine, end to end against a real database.
 *
 * The test that matters here is "a trial_started event from a product sends
 * the right email" — the whole reason for building the platform rather than
 * renting one. The rest guard the ways a drip sequence goes wrong: double
 * enrolment, mailing somebody who left, sending a step twice after a crash.
 */

import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const DB_AVAILABLE = await (async () => {
  try {
    const { query } = await import('../src/db.mjs');
    await query('select 1 from automations limit 1');
    return true;
  } catch {
    return false;
  }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { query, close } = await import('../src/db.mjs');
const { tick } = await import('../src/automations/engine.mjs');
const { enrol, onEvent } = await import('../src/automations/enrol.mjs');
const { recordEvent } = await import('../src/events/record.mjs');
const { _test: sesTest } = await import('../src/sending/ses.mjs');
const worker = await import('../src/worker/send-worker.mjs');

const MJML = (body) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;

async function resetTestData() {
  await query("delete from brands where slug like 'atest-%'");
  await query("delete from suppressions where email like '%auto.test.example'");
}

test.before(async () => { if (DB_AVAILABLE) await resetTestData(); });
test.after(async () => {
  if (!DB_AVAILABLE) return;
  await resetTestData().catch(() => {});
  await close();
});

async function freshBrand(slug) {
  await query('delete from brands where slug = $1', [slug]);
  const { rows } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address, tracking_domain)
     values ($1,$1,'Test','hello@mail.auto.test.example','mail.auto.test.example','1 Test St','links.auto.test.example')
     returning *`,
    [slug],
  );
  return rows[0];
}

const addContact = (brandId, email, status = 'subscribed') =>
  query(
    `insert into contacts (brand_id, email, first_name, status, source)
     values ($1,$2,'Test',$3,'test') returning *`,
    [brandId, email, status],
  ).then((r) => r.rows[0]);

async function makeAutomation(brand, { trigger_type = 'event', trigger_config = {}, steps, ...rest }) {
  const { rows } = await query(
    `insert into automations (brand_id, name, trigger_type, trigger_config, status, re_entry,
                              re_entry_cooldown_hours)
     values ($1,$2,$3,$4,'active',$5,$6) returning *`,
    [brand.id, `auto-${Math.random().toString(36).slice(2, 8)}`, trigger_type,
     JSON.stringify(trigger_config), rest.re_entry ?? false, rest.re_entry_cooldown_hours ?? 0],
  );
  for (const [position, step] of steps.entries()) {
    await query(
      'insert into automation_steps (automation_id, position, type, config) values ($1,$2,$3,$4)',
      [rows[0].id, position, step.type, JSON.stringify(step.config ?? {})],
    );
  }
  return rows[0];
}

function stubSes() {
  const sent = [];
  sesTest.setClient({
    async send(command) {
      sent.push({
        to: command.input.Destination.ToAddresses[0],
        raw: Buffer.from(command.input.Content.Raw.Data).toString('utf8'),
      });
      return { MessageId: `ses-auto-${sent.length}-${Date.now()}` };
    },
  });
  return sent;
}

/** Pretend a wait expired, so a multi-day sequence is testable in milliseconds. */
const fastForward = (runId) =>
  query("update automation_runs set next_run_at = now() - interval '1 second' where id = $1", [runId]);

/* ------------------------------------------------------------------------ */

suite('a trial_started event from a product sends the right email', async () => {
  // This is the whole point of the platform: the product's real state drives
  // the email, not a guess.
  const brand = await freshBrand('atest-trial');
  worker.clearTemplateCache();

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'trial_started' },
    steps: [
      { type: 'email', config: { subject: 'Welcome to your {{attrs.plan}} trial', mjml: MJML('Hello {{first_name}}') } },
    ],
  });

  const contact = await addContact(brand.id, 'dev@auto.test.example');
  await query("update contacts set attrs = '{\"plan\":\"pro\"}' where id = $1", [contact.id]);

  const result = await recordEvent({
    brandId: brand.id,
    email: 'dev@auto.test.example',
    name: 'trial_started',
    properties: { plan: 'pro', seats: 5 },
  });

  assert.equal(result.recorded, true);
  assert.equal(result.enrolments.length, 1);
  assert.equal(result.enrolments[0].enrolled, true);

  await tick();

  const { rows: messages } = await query(
    'select * from messages where automation_run_id = $1', [result.enrolments[0].runId]);
  assert.equal(messages.length, 1, 'the step should have queued exactly one email');

  const sent = stubSes();
  await worker.tick();

  const toDev = sent.find((s) => s.to === 'dev@auto.test.example');
  assert.ok(toDev, 'the email should have been sent');

  const decoded = Buffer.from(
    toDev.raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, ''),
    'base64').toString('utf8');
  assert.match(decoded, /Hello Test/);
  assert.match(toDev.raw, /Subject: Welcome to your pro trial/);
  assert.match(toDev.raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);

  const { rows: [run] } = await query('select * from automation_runs where id = $1',
    [result.enrolments[0].runId]);
  assert.equal(run.status, 'completed');
});

suite('a multi-step sequence waits between emails', async () => {
  const brand = await freshBrand('atest-sequence');
  worker.clearTemplateCache();
  const contact = await addContact(brand.id, 'drip@auto.test.example');

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'signup' },
    steps: [
      { type: 'email', config: { subject: 'One', mjml: MJML('First') } },
      { type: 'wait', config: { days: 3 } },
      { type: 'email', config: { subject: 'Two', mjml: MJML('Second') } },
    ],
  });

  const { runId } = await enrol({ automation, contactId: contact.id });

  await tick();   // email one
  let { rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]);
  assert.equal(rows[0].n, 1);

  await tick();   // the wait
  const { rows: [waiting] } = await query('select next_run_at, current_step from automation_runs where id = $1', [runId]);
  assert.equal(waiting.current_step, 2);
  const daysAhead = (new Date(waiting.next_run_at) - Date.now()) / 86_400_000;
  assert.ok(daysAhead > 2.9 && daysAhead < 3.1, `expected ~3 days, got ${daysAhead}`);

  await tick();   // nothing is due yet
  ({ rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]));
  assert.equal(rows[0].n, 1, 'the second email must not go out during the wait');

  await fastForward(runId);
  await tick();   // email two
  ({ rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]));
  assert.equal(rows[0].n, 2);
});

suite('a step that runs twice cannot send a second copy', async () => {
  // The engine can die between queueing the email and advancing the step.
  const brand = await freshBrand('atest-idempotent');
  worker.clearTemplateCache();
  const contact = await addContact(brand.id, 'once@auto.test.example');

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'x' },
    steps: [{ type: 'email', config: { subject: 'Once', mjml: MJML('Once') } }],
  });
  const { runId } = await enrol({ automation, contactId: contact.id });

  await tick();
  // Rewind the run as a crashed worker would have left it.
  await query("update automation_runs set current_step = 0, status = 'active', next_run_at = now() where id = $1", [runId]);
  await tick();

  const { rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]);
  assert.equal(rows[0].n, 1, 'the unique index must absorb the re-run');
});

suite('a duplicate event does not enrol anybody twice', async () => {
  const brand = await freshBrand('atest-dup');
  await addContact(brand.id, 'retry@auto.test.example');
  await makeAutomation(brand, {
    trigger_config: { event: 'purchase' },
    steps: [{ type: 'email', config: { subject: 'Thanks', mjml: MJML('Thanks') } }],
  });

  const args = {
    brandId: brand.id, email: 'retry@auto.test.example', name: 'purchase',
    properties: { order: 1 }, idempotencyKey: 'order-1',
  };
  const first = await recordEvent(args);
  const second = await recordEvent(args);   // the product retried its webhook

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, true);

  const { rows } = await query('select count(*)::int as n from events where brand_id = $1', [brand.id]);
  assert.equal(rows[0].n, 1);
});

suite('somebody already in a sequence is not enrolled again', async () => {
  const brand = await freshBrand('atest-once');
  const contact = await addContact(brand.id, 'inflight@auto.test.example');
  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'y' },
    steps: [{ type: 'wait', config: { days: 1 } }, { type: 'email', config: { subject: 'A', mjml: MJML('A') } }],
  });

  const first = await enrol({ automation, contactId: contact.id });
  const second = await enrol({ automation, contactId: contact.id });

  assert.equal(first.enrolled, true);
  assert.equal(second.enrolled, false);
  assert.match(second.reason, /already in this automation/);
});

suite('re-entry is refused by default and allowed when configured', async () => {
  const brand = await freshBrand('atest-reentry');

  // A welcome series must never repeat.
  const welcome = await makeAutomation(brand, {
    trigger_config: { event: 'z' }, re_entry: false,
    steps: [{ type: 'exit', config: {} }],
  });
  const a = await addContact(brand.id, 'welcome@auto.test.example');
  const firstRun = await enrol({ automation: welcome, contactId: a.id });
  await tick();
  assert.equal(firstRun.enrolled, true);
  const again = await enrol({ automation: welcome, contactId: a.id });
  assert.equal(again.enrolled, false);
  assert.match(again.reason, /re-entry disabled/);

  // An abandoned-checkout series must.
  const cart = await makeAutomation(brand, {
    trigger_config: { event: 'checkout_started' }, re_entry: true, re_entry_cooldown_hours: 0,
    steps: [{ type: 'exit', config: {} }],
  });
  const b = await addContact(brand.id, 'cart@auto.test.example');
  await enrol({ automation: cart, contactId: b.id });
  await tick();
  const rejoin = await enrol({ automation: cart, contactId: b.id });
  assert.equal(rejoin.enrolled, true, 'an abandoned-cart sequence must be re-enterable');
});

suite('unsubscribing mid-sequence cancels the run', async () => {
  // Most of a drip series happens days after somebody joined it. Checking
  // their status only at enrolment is not enough.
  const brand = await freshBrand('atest-unsub');
  worker.clearTemplateCache();
  const contact = await addContact(brand.id, 'leaving@auto.test.example');

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'q' },
    steps: [
      { type: 'wait', config: { minutes: 1 } },
      { type: 'email', config: { subject: 'Still here?', mjml: MJML('Hi') } },
    ],
  });
  const { runId } = await enrol({ automation, contactId: contact.id });

  await tick();   // the wait
  await query("update contacts set status = 'unsubscribed' where id = $1", [contact.id]);
  await fastForward(runId);
  await tick();

  const { rows: [run] } = await query('select status, last_error from automation_runs where id = $1', [runId]);
  assert.equal(run.status, 'cancelled');
  assert.match(run.last_error, /unsubscribed/);

  const { rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]);
  assert.equal(rows[0].n, 0, 'no email may be queued after they left');
});

suite('a condition stops the sequence for people it does not match', async () => {
  // The trial-activation flow: trial started, but the feature was never used.
  const brand = await freshBrand('atest-condition');
  worker.clearTemplateCache();

  const idle = await addContact(brand.id, 'idle@auto.test.example');
  const active = await addContact(brand.id, 'active@auto.test.example');

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'trial_started' },
    steps: [
      { type: 'condition', config: { rules: { rules: [{ field: 'event', op: 'not_has', value: 'feature_used' }] }, otherwise: 'exit' } },
      { type: 'email', config: { subject: 'Need a hand getting started?', mjml: MJML('Hi') } },
    ],
  });

  // The active one used the product; the idle one did not.
  await query(
    "insert into events (brand_id, contact_id, name) values ($1,$2,'feature_used')",
    [brand.id, active.id],
  );

  const idleRun = await enrol({ automation, contactId: idle.id });
  const activeRun = await enrol({ automation, contactId: active.id });

  await tick();   // conditions
  await tick();   // the email, for whoever passed

  const { rows: idleMessages } = await query(
    'select count(*)::int as n from messages where automation_run_id = $1', [idleRun.runId]);
  const { rows: activeMessages } = await query(
    'select count(*)::int as n from messages where automation_run_id = $1', [activeRun.runId]);

  assert.equal(idleMessages[0].n, 1, 'the idle user should get the nudge');
  assert.equal(activeMessages[0].n, 0, 'the active user should not');

  const { rows: [run] } = await query('select status from automation_runs where id = $1', [activeRun.runId]);
  assert.equal(run.status, 'completed');
});

suite('a paused automation holds its runs rather than dropping them', async () => {
  const brand = await freshBrand('atest-paused');
  const contact = await addContact(brand.id, 'held@auto.test.example');
  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'p' },
    steps: [{ type: 'email', config: { subject: 'A', mjml: MJML('A') } }],
  });
  const { runId } = await enrol({ automation, contactId: contact.id });

  await query("update automations set status = 'paused' where id = $1", [automation.id]);
  await tick();

  const { rows: [run] } = await query('select status, current_step from automation_runs where id = $1', [runId]);
  assert.equal(run.status, 'active', 'pausing must not cancel people mid-sequence');
  assert.equal(run.current_step, 0, 'and must not advance them');

  const { rows } = await query('select count(*)::int as n from messages where automation_run_id = $1', [runId]);
  assert.equal(rows[0].n, 0);
});

suite('a suppressed address is never enrolled', async () => {
  const brand = await freshBrand('atest-suppressed');
  const contact = await addContact(brand.id, 'complained@auto.test.example');
  await query("insert into suppressions (brand_id, email, reason) values (null,$1,'complaint')",
    [contact.email]);

  const automation = await makeAutomation(brand, {
    trigger_config: { event: 'r' },
    steps: [{ type: 'email', config: { subject: 'A', mjml: MJML('A') } }],
  });

  const result = await enrol({ automation, contactId: contact.id });
  assert.equal(result.enrolled, false);
  assert.equal(result.reason, 'suppressed');
});

suite('an event for an unknown person creates them as pending, not subscribed', async () => {
  // Doing something in an app is not consent to receive marketing email.
  const brand = await freshBrand('atest-newcontact');
  await makeAutomation(brand, {
    trigger_config: { event: 'signup' },
    steps: [{ type: 'email', config: { subject: 'Hi', mjml: MJML('Hi') } }],
  });

  const result = await recordEvent({
    brandId: brand.id, email: 'stranger@auto.test.example', name: 'signup',
  });

  const { rows } = await query('select status from contacts where id = $1', [result.contactId]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(result.enrolments[0].enrolled, false, 'a pending contact must not enter a sequence');
});

suite('a property filter lets one event drive different sequences', async () => {
  const brand = await freshBrand('atest-filter');
  const pro = await addContact(brand.id, 'pro@auto.test.example');

  await makeAutomation(brand, {
    trigger_config: { event: 'purchase', match: { plan: 'pro' } },
    steps: [{ type: 'email', config: { subject: 'Pro onboarding', mjml: MJML('Pro') } }],
  });
  await makeAutomation(brand, {
    trigger_config: { event: 'purchase', match: { plan: 'free' } },
    steps: [{ type: 'email', config: { subject: 'Free onboarding', mjml: MJML('Free') } }],
  });

  const result = await onEvent({
    brandId: brand.id, contactId: pro.id, name: 'purchase', properties: { plan: 'pro' },
  });

  assert.equal(result.length, 1, 'only the matching automation should fire');
  assert.equal(result[0].enrolled, true);
});

suite('a product can assert consent, and only moves pending forward', async () => {
  const brand = await freshBrand('atest-consent');
  await makeAutomation(brand, {
    trigger_config: { event: 'trial_started' },
    steps: [{ type: 'email', config: { subject: 'Welcome', mjml: MJML('Hi') } }],
  });

  // Without the assertion: created pending, enters nothing.
  const quiet = await recordEvent({
    brandId: brand.id, email: 'quiet@auto.test.example', name: 'trial_started',
  });
  assert.equal(quiet.enrolments[0].enrolled, false);

  // With it: subscribed, consent evidenced, sequence starts.
  const loud = await recordEvent({
    brandId: brand.id, email: 'loud@auto.test.example', name: 'trial_started',
    subscribe: { consent_source: 'Signed up at app.example.com/register' },
  });
  assert.equal(loud.enrolments[0].enrolled, true);

  const { rows } = await query('select status, consent_at, consent_source from contacts where id = $1',
    [loud.contactId]);
  assert.equal(rows[0].status, 'subscribed');
  assert.ok(rows[0].consent_at, 'consent must be evidenced, not assumed');
  assert.match(rows[0].consent_source, /app\.example\.com/);

  // A product cannot re-subscribe somebody who left. That decision is theirs.
  const gone = await addContact(brand.id, 'gone@auto.test.example', 'unsubscribed');
  await recordEvent({
    brandId: brand.id, email: gone.email, name: 'trial_started',
    subscribe: { consent_source: 'the product says so' },
  });
  const { rows: after } = await query('select status from contacts where id = $1', [gone.id]);
  assert.equal(after[0].status, 'unsubscribed', 'an unsubscribe must survive any product assertion');
});

suite('asserting consent without saying where is refused', async () => {
  const brand = await freshBrand('atest-noevidence');
  await assert.rejects(
    () => recordEvent({
      brandId: brand.id, email: 'x@auto.test.example', name: 'signup', subscribe: {},
    }),
    /consent_source is required/,
  );
});
