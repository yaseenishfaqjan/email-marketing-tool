/**
 * Warm-up enforcement and list hygiene.
 *
 * The risk these guard against is not a bug in an email. It is sending a cold
 * list too fast and having SES suspend the account — which takes every brand
 * down together, and is far harder to undo than to avoid.
 */

import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { capForDay, dayOfWarmup, allowance, plan, WARM } from '../src/sending/warmup.mjs';
import { inspect, report } from '../src/contacts/hygiene.mjs';

/* ------------------------------------------------------------- schedule -- */

test('the ramp starts small and only widens', () => {
  const caps = [1, 2, 3, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 20].map(capForDay);
  for (let i = 1; i < caps.length; i += 1) {
    assert.ok(caps[i] >= caps[i - 1], `day ${i} must not allow less than the day before`);
  }
  assert.equal(capForDay(1), 500, 'day one is deliberately tiny');
  assert.equal(capForDay(21), WARM, 'past the schedule the domain is warm');
});

test('day one is day 1, not day 0', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  assert.equal(dayOfWarmup(new Date('2026-10-10T09:00:00Z'), now), 1);
  assert.equal(dayOfWarmup(new Date('2026-10-09T09:00:00Z'), now), 2);
  assert.equal(dayOfWarmup(null, now), 1, 'a brand that has never sent starts at day one');
});

test('a brand that has never sent gets the smallest allowance, not an unlimited one', () => {
  // The failure that matters: treating "no start date" as "no limit" would let
  // a brand's very first campaign go out at full volume.
  const a = allowance({ warmup_enabled: true, warmup_started_at: null, daily_send_cap: null }, 0);
  assert.equal(a.cap, 500);
  assert.equal(a.remaining, 500);
});

test('an explicit cap of 0 pauses a brand', () => {
  // The control you want at 2am when a campaign is going wrong.
  const a = allowance({ daily_send_cap: 0, warmup_enabled: true }, 0);
  assert.equal(a.remaining, 0);
  assert.match(a.reason, /paused/);
});

test('an explicit cap overrides the schedule in both directions', () => {
  const started = new Date(Date.now() - 86_400_000);   // day 2, schedule says 500
  assert.equal(allowance({ daily_send_cap: 50_000, warmup_enabled: true, warmup_started_at: started }, 0).remaining, 50_000);
  assert.equal(allowance({ daily_send_cap: 100, warmup_enabled: true, warmup_started_at: started }, 0).remaining, 100);
});

test('remaining never goes negative when a cap is lowered mid-day', () => {
  const a = allowance({ daily_send_cap: 100, warmup_enabled: true }, 250);
  assert.equal(a.remaining, 0);
});

test('disabling warm-up removes the limit, and says so', () => {
  const a = allowance({ warmup_enabled: false, daily_send_cap: null }, 0);
  assert.equal(a.remaining, WARM);
  assert.match(a.reason, /disabled/);
});

test('the plan marks where a brand currently is', () => {
  const started = new Date(Date.now() - 5 * 86_400_000);   // day 6
  const steps = plan(started);
  const current = steps.filter((s) => s.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].daily_cap, 10_000);
  assert.equal(plan(null).filter((s) => s.current).length, 0);
});

/* -------------------------------------------------------------- hygiene -- */

test('malformed addresses are caught', () => {
  for (const bad of ['', 'not-an-email', 'no@domain', '@example.com', 'two@@at.com']) {
    assert.equal(inspect(bad).valid, false, `${bad} should be invalid`);
  }
  assert.equal(inspect('ada@scalaro.io').valid, true);
});

test('role accounts are flagged but never rejected', () => {
  // They reach shared inboxes and are a common source of complaints — but
  // plenty are real customers, and silently dropping them is worse.
  const r = inspect('info@company.com');
  assert.equal(r.valid, true);
  assert.ok(r.flags.includes('role_account'));
});

test('a likely typo comes with the correction', () => {
  // Every one of these is a real customer who mistyped their own address.
  const r = inspect('grace@gmial.com');
  assert.ok(r.flags.includes('likely_typo'));
  assert.equal(r.suggestion, 'grace@gmail.com');
});

test('disposable domains are flagged', () => {
  assert.ok(inspect('x@mailinator.com').flags.includes('disposable'));
  assert.ok(!inspect('x@gmail.com').flags.includes('disposable'));
});

test('duplicates are counted once', () => {
  const r = report(['a@x.com', 'a@x.com', 'A@X.COM', 'b@x.com']);
  assert.equal(r.counts.valid, 2);
  assert.equal(r.counts.duplicates, 2, 'case differences are the same address');
});

test('a list full of junk is refused outright', () => {
  const emails = [];
  for (let i = 0; i < 90; i += 1) emails.push(`real${i}@company.com`);
  for (let i = 0; i < 10; i += 1) emails.push(`junk${i}@mailinator.com`);

  const r = report(emails);
  assert.equal(r.verdict.level, 'do_not_import');
  assert.match(r.verdict.message, /risks the sending account/);
});

test('a list with a few fixable problems says clean it first', () => {
  const emails = [];
  for (let i = 0; i < 97; i += 1) emails.push(`real${i}@company.com`);
  emails.push('a@gmial.com', 'b@yaho.com', 'c@hotmial.com');

  const r = report(emails);
  assert.equal(r.verdict.level, 'clean_first');
  assert.equal(r.counts.likely_typos, 3);
});

test('a list that is mostly role accounts asks about consent', () => {
  const emails = [];
  for (let i = 0; i < 70; i += 1) emails.push(`person${i}@company${i}.com`);
  for (let i = 0; i < 30; i += 1) emails.push(`info@company${i}.org`);

  const r = report(emails);
  assert.equal(r.verdict.level, 'check_consent');
});

test('a clean list passes without complaint', () => {
  const emails = Array.from({ length: 50 }, (_, i) => `person${i}@company.com`);
  assert.equal(report(emails).verdict.level, 'ok');
});

test('the report carries examples, not just counts', () => {
  // A number tells you something is wrong; an example tells you what.
  const r = report(['bad', 'info@x.com', 'a@gmial.com', 'b@mailinator.com']);
  assert.ok(r.samples.malformed.includes('bad'));
  assert.ok(r.samples.role_accounts.includes('info@x.com'));
  assert.ok(r.samples.likely_typos.some((s) => s.includes('→')));
  assert.ok(r.samples.disposable.includes('b@mailinator.com'));
});

/* ------------------------------------------- enforcement, against the DB -- */

const DB_AVAILABLE = await (async () => {
  try {
    const { query } = await import('../src/db.mjs');
    await query('select 1 from daily_send_counts limit 1');
    return true;
  } catch {
    return false;
  }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { query, close } = await import('../src/db.mjs');
const { headroom, recordSends, sentToday, status } = await import('../src/sending/warmup.mjs');
const { _test: sesTest } = await import('../src/sending/ses.mjs');
const worker = await import('../src/worker/send-worker.mjs');

const resetTestData = () => query("delete from brands where slug like 'wtest-%'");

test.before(async () => { if (DB_AVAILABLE) await resetTestData(); });
test.after(async () => {
  if (!DB_AVAILABLE) return;
  await resetTestData().catch(() => {});
  await close();
});

async function brandWithQueue(slug, { count, cap = null, startedAt = null }) {
  await query('delete from brands where slug = $1', [slug]);
  const { rows: [brand] } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address,
                         daily_send_cap, warmup_started_at)
     values ($1,$1,'T','hello@mail.w.test','mail.w.test','1 St',$2,$3) returning *`,
    [slug, cap, startedAt],
  );
  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml, status)
     values ($1,'C','S','<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>','sending')
     returning *`, [brand.id]);

  for (let i = 0; i < count; i += 1) {
    const { rows: [contact] } = await query(
      `insert into contacts (brand_id, email, status, source) values ($1,$2,'subscribed','test') returning *`,
      [brand.id, `w${i}@${slug}.test`]);
    await query('insert into messages (brand_id, contact_id, campaign_id) values ($1,$2,$3)',
      [brand.id, contact.id, campaign.id]);
  }
  return brand;
}

function stubSes() {
  const sent = [];
  sesTest.setClient({
    async send(command) {
      sent.push(command.input.Destination.ToAddresses[0]);
      return { MessageId: `ses-w-${sent.length}-${Date.now()}` };
    },
  });
  return sent;
}

suite('the cap actually stops the worker, and the rest waits for tomorrow', async () => {
  const brand = await brandWithQueue('wtest-cap', { count: 10, cap: 4 });
  worker.clearTemplateCache();
  const sent = stubSes();

  await worker.tick();
  await worker.tick();   // a second pass must not sneak past the cap

  const mine = sent.filter((e) => e.endsWith('@wtest-cap.test'));
  assert.equal(mine.length, 4, 'exactly the allowance, no more');

  const { rows } = await query(
    "select count(*)::int as n from messages where brand_id = $1 and status = 'queued'", [brand.id]);
  assert.equal(rows[0].n, 6, 'the rest stay queued — nothing is dropped');

  assert.equal(await sentToday(brand.id), 4);
});

suite('one brand at its cap does not block another', async () => {
  // The reason the allowance is per brand: a capped brand must not stall the
  // queue for the other four.
  const capped = await brandWithQueue('wtest-blocked', { count: 5, cap: 0 });
  const free = await brandWithQueue('wtest-free', { count: 3, cap: 100 });
  worker.clearTemplateCache();
  const sent = stubSes();

  await worker.tick();

  assert.equal(sent.filter((e) => e.endsWith('@wtest-blocked.test')).length, 0);
  assert.equal(sent.filter((e) => e.endsWith('@wtest-free.test')).length, 3);
  void capped; void free;
});

suite('skipped messages do not spend the allowance', async () => {
  // A suppressed contact never reached SES, so it cost no reputation and must
  // not cost somebody else's send.
  const brand = await brandWithQueue('wtest-skip', { count: 4, cap: 4 });
  worker.clearTemplateCache();

  await query("update contacts set status = 'unsubscribed' where brand_id = $1 and email like 'w0%'",
    [brand.id]);
  await query("update contacts set status = 'unsubscribed' where brand_id = $1 and email like 'w1%'",
    [brand.id]);

  const sent = stubSes();
  await worker.tick();

  assert.equal(sent.filter((e) => e.endsWith('@wtest-skip.test')).length, 2);
  assert.equal(await sentToday(brand.id), 2, 'only the two that actually went out');
});

suite('the first send starts the clock', async () => {
  // Set at creation instead, a brand configured a fortnight early would arrive
  // at day 15 having never sent anything.
  const brand = await brandWithQueue('wtest-clock', { count: 1, cap: 10 });
  const { rows: before } = await query('select warmup_started_at from brands where id = $1', [brand.id]);
  assert.equal(before[0].warmup_started_at, null);

  worker.clearTemplateCache();
  stubSes();
  await worker.tick();

  const { rows: after } = await query('select warmup_started_at from brands where id = $1', [brand.id]);
  assert.ok(after[0].warmup_started_at, 'sending for the first time starts the ramp');
});

suite('headroom reports only brands with mail waiting', async () => {
  const busy = await brandWithQueue('wtest-busy', { count: 3, cap: 10 });
  await brandWithQueue('wtest-idle', { count: 0 });

  const rows = await headroom();
  assert.ok(rows.some((r) => r.brandId === busy.id));
  assert.ok(!rows.some((r) => r.name === 'wtest-idle'));
});

suite('the day ledger accumulates rather than overwriting', async () => {
  const brand = await brandWithQueue('wtest-ledger', { count: 0 });
  await recordSends(brand.id, 10);
  await recordSends(brand.id, 5);
  assert.equal(await sentToday(brand.id), 15);
});

suite('status reports each brand position on the ramp', async () => {
  const brand = await brandWithQueue('wtest-status', {
    count: 0, startedAt: new Date(Date.now() - 5 * 86_400_000),   // day 6
  });
  const row = (await status()).find((b) => b.brand_id === brand.id);
  assert.equal(row.day, 6);
  assert.equal(row.cap, 10_000);
  assert.equal(row.complete, false);
});
