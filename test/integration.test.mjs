/**
 * End-to-end against a real PostgreSQL database, with SES stubbed.
 *
 * This is the test that proves Phase 1 is done: a campaign goes out to the
 * right people, the wrong people are excluded, and a bounce coming back from
 * SES updates the database.
 *
 * It needs a database. Without one it skips rather than fails, so `npm test`
 * still works on a machine that has not set one up:
 *
 *   createdb mailer && npm run migrate && npm test
 */

import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const DB_AVAILABLE = await (async () => {
  try {
    const { query } = await import('../src/db.mjs');
    await query('select 1 from brands limit 1');
    return true;
  } catch {
    return false;
  }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { query, tx, close } = await import('../src/db.mjs');
const { materialiseCampaign } = await import('../src/campaigns/materialise.mjs');
const { handleSesEvent } = await import('../src/http/routes/webhooks.mjs');
const { _test: sesTest } = await import('../src/sending/ses.mjs');
const worker = await import('../src/worker/send-worker.mjs');

const MJML = `<mjml><mj-body><mj-section><mj-column>
  <mj-text>Hello {{first_name}}</mj-text>
  <mj-button href="https://example.com/pricing">Pricing</mj-button>
</mj-column></mj-section></mj-body></mjml>`;

/**
 * Wipe everything these tests create.
 *
 * It runs before as well as after, because a run that crashes halfway leaves
 * rows behind, and the next run would then be testing against them —
 * `worker.tick()` drains the whole queue, not one brand's share of it, so a
 * stray queued message from an earlier run shows up as somebody else's
 * failure.
 */
async function resetTestData() {
  await query("delete from brands where slug like 'itest-%'");
  await query("delete from suppressions where email like '%test.example'");
}

/** Everything this suite creates lives under one throwaway brand. */
async function freshBrand(slug) {
  await query('delete from brands where slug = $1', [slug]);
  const { rows } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address, tracking_domain)
     values ($1,$2,'Test Sender','hello@mail.test.example','mail.test.example','1 Test Street','links.test.example')
     returning *`,
    [slug, `Test ${slug}`],
  );
  return rows[0];
}

const addContact = (brandId, email, first, status = 'subscribed', attrs = {}) =>
  query(
    `insert into contacts (brand_id, email, first_name, status, source, attrs)
     values ($1,$2,$3,$4,'test',$5) returning *`,
    [brandId, email, first, status, JSON.stringify(attrs)],
  ).then((r) => r.rows[0]);

/** A stub standing in for SES. Records what it was asked to send. */
function stubSes({ fail = null } = {}) {
  const sent = [];
  sesTest.setClient({
    async send(command) {
      const input = command.input;
      const to = input.Destination.ToAddresses[0];
      if (fail && fail(to)) {
        const err = new Error('Email address is not verified.');
        err.name = 'MessageRejected';
        throw err;
      }
      sent.push({ to, raw: Buffer.from(input.Content.Raw.Data).toString('utf8') });
      return { MessageId: `ses-${sent.length}-${Date.now()}` };
    },
  });
  return sent;
}

test.before(async () => {
  if (DB_AVAILABLE) await resetTestData();
});

test.after(async () => {
  if (DB_AVAILABLE) {
    await resetTestData().catch(() => {});
    await close();
  }
});

suite('a broadcast reaches the right people and nobody else', async () => {
  const brand = await freshBrand('itest-broadcast');
  worker.clearTemplateCache();

  const ada = await addContact(brand.id, 'ada@test.example', 'Ada');
  const grace = await addContact(brand.id, 'grace@test.example', 'Grace');
  await addContact(brand.id, 'gone@test.example', 'Gone', 'unsubscribed');
  const complained = await addContact(brand.id, 'spam@test.example', 'Complained');

  // Suppressed globally, as a complaint would leave them.
  await query("insert into suppressions (brand_id, email, reason) values (null, $1, 'complaint')",
    [complained.email]);

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml)
     values ($1,'Broadcast','Hello {{first_name}}',$2) returning *`,
    [brand.id, MJML],
  );

  const { recipients } = await materialiseCampaign(campaign.id);

  // Two of the four: the unsubscribed and the suppressed are excluded.
  assert.equal(recipients, 2);
  const { rows: queued } = await query(
    'select contact_id from messages where campaign_id = $1 order by contact_id', [campaign.id]);
  assert.deepEqual(
    queued.map((r) => r.contact_id).sort(),
    [ada.id, grace.id].sort(),
  );

  const sent = stubSes();
  await worker.tick();

  assert.equal(sent.length, 2);
  const { rows: after } = await query(
    "select status, ses_message_id from messages where campaign_id = $1", [campaign.id]);
  assert.ok(after.every((m) => m.status === 'sent' && m.ses_message_id));

  // The campaign closes itself once the queue is empty.
  const { rows: [done] } = await query('select status, stats from campaigns where id = $1', [campaign.id]);
  assert.equal(done.status, 'sent');
  assert.equal(done.stats.sent, 2);

  // And the mail itself is complete: merge field, legal footer, one-click header.
  const toAda = sent.find((s) => s.to === 'ada@test.example');
  const body = Buffer.from(
    toAda.raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, ''),
    'base64').toString('utf8');
  assert.match(body, /Hello Ada/);
  assert.match(body, /1 Test Street/);
  assert.match(toAda.raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
});

suite('re-running a campaign cannot send anyone a second copy', async () => {
  const brand = await freshBrand('itest-idempotent');
  worker.clearTemplateCache();
  await addContact(brand.id, 'once@test.example', 'Once');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Once','Subject',$2) returning *`,
    [brand.id, MJML],
  );

  await materialiseCampaign(campaign.id);

  // A crashed materialiser, re-run: the unique constraint absorbs it.
  await query("update campaigns set status = 'draft' where id = $1", [campaign.id]);
  const second = await materialiseCampaign(campaign.id);

  assert.equal(second.recipients, 0, 'the second pass must add no rows');
  const { rows } = await query('select count(*)::int as n from messages where campaign_id = $1', [campaign.id]);
  assert.equal(rows[0].n, 1);
});

suite('someone who unsubscribes mid-send is not sent to', async () => {
  const brand = await freshBrand('itest-midsend');
  worker.clearTemplateCache();
  const late = await addContact(brand.id, 'late@test.example', 'Late');
  await addContact(brand.id, 'early@test.example', 'Early');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Mid','Subject',$2) returning *`,
    [brand.id, MJML],
  );
  await materialiseCampaign(campaign.id);

  // The unsubscribe lands after the rows were written, as it would during a
  // broadcast that takes an hour to drain.
  await query("update contacts set status = 'unsubscribed' where id = $1", [late.id]);

  const sent = stubSes();
  await worker.tick();

  // Assert on this campaign's own recipients: tick() drains the whole queue,
  // so a count of everything SES was handed would also include other tests'
  // leftovers.
  const addressed = sent.map((s) => s.to);
  assert.ok(addressed.includes('early@test.example'), 'the still-subscribed contact should be sent to');
  assert.ok(!addressed.includes('late@test.example'), 'the mid-send unsubscribe must be honoured');

  const { rows } = await query(
    'select status, error from messages where campaign_id = $1 and contact_id = $2', [campaign.id, late.id]);
  assert.equal(rows[0].status, 'skipped');
  assert.match(rows[0].error, /unsubscribed/);
});

suite('a hard bounce suppresses the address for every brand', async () => {
  const brand = await freshBrand('itest-bounce');
  worker.clearTemplateCache();
  const doomed = await addContact(brand.id, 'nobody@bounce.test.example', 'Doomed');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Bounce','Subject',$2) returning *`,
    [brand.id, MJML],
  );
  await materialiseCampaign(campaign.id);
  stubSes();
  await worker.tick();

  const { rows: [message] } = await query(
    'select id, ses_message_id from messages where campaign_id = $1', [campaign.id]);

  await handleSesEvent({
    eventType: 'Bounce',
    mail: { messageId: message.ses_message_id },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: doomed.email, diagnosticCode: '550 5.1.1 user unknown' }],
    },
  });

  const { rows: [after] } = await query('select status from messages where id = $1', [message.id]);
  assert.equal(after.status, 'bounced');

  const { rows: [contact] } = await query('select status from contacts where id = $1', [doomed.id]);
  assert.equal(contact.status, 'bounced');

  // Global, not brand-scoped: a dead mailbox is dead everywhere, and repeatedly
  // hitting it is what raises the shared account's bounce rate.
  const { rows: sup } = await query('select brand_id, reason from suppressions where email = $1', [doomed.email]);
  assert.equal(sup.length, 1);
  assert.equal(sup[0].brand_id, null);
  assert.equal(sup[0].reason, 'hard_bounce');

  const { rows: events } = await query(
    "select meta from message_events where message_id = $1 and type = 'bounce'", [message.id]);
  assert.match(events[0].meta.diagnostic, /550 5\.1\.1/);
});

suite('a delivery event arriving after a complaint does not overwrite it', async () => {
  const brand = await freshBrand('itest-ordering');
  worker.clearTemplateCache();
  const contact = await addContact(brand.id, 'cranky@test.example', 'Cranky');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Order','Subject',$2) returning *`,
    [brand.id, MJML],
  );
  await materialiseCampaign(campaign.id);
  stubSes();
  await worker.tick();

  const { rows: [message] } = await query(
    'select id, ses_message_id from messages where campaign_id = $1', [campaign.id]);

  await handleSesEvent({
    eventType: 'Complaint',
    mail: { messageId: message.ses_message_id },
    complaint: { complaintFeedbackType: 'abuse' },
  });
  // SNS makes no ordering guarantee, so this genuinely happens.
  await handleSesEvent({ eventType: 'Delivery', mail: { messageId: message.ses_message_id }, delivery: {} });

  const { rows: [after] } = await query('select status from messages where id = $1', [message.id]);
  assert.equal(after.status, 'complained', 'a late delivery must not erase a complaint');

  const { rows: [c] } = await query('select status from contacts where id = $1', [contact.id]);
  assert.equal(c.status, 'complained');
});

suite('a permanently rejected message is failed, not retried forever', async () => {
  const brand = await freshBrand('itest-reject');
  worker.clearTemplateCache();
  await addContact(brand.id, 'rejected@test.example', 'Rejected');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Reject','Subject',$2) returning *`,
    [brand.id, MJML],
  );
  await materialiseCampaign(campaign.id);

  stubSes({ fail: () => true });
  await worker.tick();

  const { rows: [message] } = await query(
    'select status, attempts, error from messages where campaign_id = $1', [campaign.id]);
  assert.equal(message.status, 'failed');
  assert.equal(message.attempts, 1, 'a permanent rejection must not be retried');
  assert.match(message.error, /MessageRejected/);
});

suite('a segment selects only the contacts it describes', async () => {
  const brand = await freshBrand('itest-segment');
  worker.clearTemplateCache();
  await addContact(brand.id, 'pro@test.example', 'Pro', 'subscribed', { plan: 'pro' });
  await addContact(brand.id, 'free@test.example', 'Free', 'subscribed', { plan: 'free' });

  const { rows: [segment] } = await query(
    `insert into segments (brand_id, name, definition) values ($1,'Pro users',$2) returning *`,
    [brand.id, JSON.stringify({ match: 'all', rules: [{ field: 'attrs.plan', op: 'eq', value: 'pro' }] })],
  );
  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml, segment_id)
     values ($1,'Segmented','Subject',$2,$3) returning *`,
    [brand.id, MJML, segment.id],
  );

  const { recipients } = await materialiseCampaign(campaign.id);
  assert.equal(recipients, 1);

  const { rows } = await query(
    `select c.email from messages m join contacts c on c.id = m.contact_id where m.campaign_id = $1`,
    [campaign.id]);
  assert.equal(rows[0].email, 'pro@test.example');
});

suite('a message stranded by a dead worker goes back in the queue', async () => {
  const brand = await freshBrand('itest-stuck');
  worker.clearTemplateCache();
  await addContact(brand.id, 'stranded@test.example', 'Stranded');

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'Stuck','Subject',$2) returning *`,
    [brand.id, MJML],
  );
  await materialiseCampaign(campaign.id);

  // A worker claimed it and died: not queued, so never claimed again; not
  // sent, so the campaign never finishes.
  await query(
    `update messages set status = 'sending', locked_at = now() - interval '30 minutes'
      where campaign_id = $1`, [campaign.id]);

  await worker.recoverStuck();

  const { rows: [message] } = await query(
    'select status from messages where campaign_id = $1', [campaign.id]);
  assert.equal(message.status, 'queued');
});
