/**
 * The public endpoints, driven over real HTTP.
 *
 * These are the routes opened from a stranger's inbox, by mail clients and
 * scanners nobody controls, so they are tested the way they are actually
 * reached rather than by calling the handlers directly.
 *
 * Needs a database; skips without one.
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

const { query, close } = await import('../src/db.mjs');
const { createApp } = await import('../src/app.mjs');
const { mint } = await import('../src/tokens.mjs');
const { urlDigest } = await import('../src/sending/renderer.mjs');

let server;
let base;

test.before(async () => {
  if (!DB_AVAILABLE) return;
  await query("delete from brands where slug like 'htest-%'");
  await query("delete from suppressions where email like '%@http.test.example'");
  // Port 0: the OS picks a free one, so the suite cannot collide with a dev
  // server already running on 8080.
  server = createApp({ logErrors: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!DB_AVAILABLE) return;
  await query("delete from brands where slug like 'htest-%'").catch(() => {});
  await query("delete from suppressions where email like '%@http.test.example'").catch(() => {});
  await new Promise((r) => server.close(r));
  await close();
});

/** A brand, a contact and a message row, which is all a tracking link needs. */
async function fixture(slug) {
  const { rows: [brand] } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address)
     values ($1,$1,'T','hello@mail.http.test.example','mail.http.test.example','1 Test St') returning *`,
    [slug],
  );
  const { rows: [contact] } = await query(
    `insert into contacts (brand_id, email, first_name, status, source)
     values ($1,$2,'Test','subscribed','test') returning *`,
    [brand.id, `${slug}@http.test.example`],
  );
  // Every message belongs to a campaign or an automation -- the schema enforces
  // it -- so the fixture builds a real campaign rather than a source-less row.
  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml)
     values ($1,'Fixture','Subject','<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>')
     returning *`,
    [brand.id],
  );
  const { rows: [message] } = await query(
    'insert into messages (brand_id, contact_id, campaign_id, status) values ($1,$2,$3,$4) returning *',
    [brand.id, contact.id, campaign.id, 'sent'],
  );
  return { brand, contact, campaign, message };
}

suite('GET on an unsubscribe link does NOT unsubscribe anyone', async () => {
  // Corporate scanners and link-preview bots fetch every URL in an email
  // before the recipient sees it. A GET that unsubscribed would quietly empty
  // the list — one of the most expensive mistakes in this whole domain.
  const { contact, message } = await fixture('htest-getunsub');
  const token = mint('u', { m: message.id });

  const res = await fetch(`${base}/u/${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Unsubscribe me/);

  const { rows } = await query('select status from contacts where id = $1', [contact.id]);
  assert.equal(rows[0].status, 'subscribed', 'a GET must never change anything');
});

suite('POST on an unsubscribe link unsubscribes and suppresses for that brand only', async () => {
  const { brand, contact, message } = await fixture('htest-postunsub');
  const token = mint('u', { m: message.id });

  const res = await fetch(`${base}/u/${token}`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You have been unsubscribed/);

  const { rows } = await query('select status from contacts where id = $1', [contact.id]);
  assert.equal(rows[0].status, 'unsubscribed');

  // Brand-scoped, not global: leaving one list must not remove them from the
  // other four businesses, which they never asked for.
  const { rows: sup } = await query('select brand_id, reason from suppressions where email = $1', [contact.email]);
  assert.equal(sup.length, 1);
  assert.equal(sup[0].brand_id, brand.id);
  assert.equal(sup[0].reason, 'unsubscribe');
});

suite('unsubscribing twice still reports success', async () => {
  // Telling somebody their unsubscribe failed is how you get a spam complaint.
  const { message } = await fixture('htest-twice');
  const token = mint('u', { m: message.id });
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${base}/u/${token}`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /You have been unsubscribed/);
  }
});

suite('a forged unsubscribe token changes nothing', async () => {
  const { contact } = await fixture('htest-forged');
  const res = await fetch(`${base}/u/not-a-real-token`, { method: 'POST' });
  assert.equal(res.status, 400);

  const { rows } = await query('select status from contacts where id = $1', [contact.id]);
  assert.equal(rows[0].status, 'subscribed');
});

suite('the open pixel records an open and always returns an image', async () => {
  const { message } = await fixture('htest-open');
  const res = await fetch(`${base}/o/${mint('o', { m: message.id })}`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.match(res.headers.get('cache-control'), /no-store/);

  // Recording is best-effort and happens after the response, so give it a beat.
  await new Promise((r) => setTimeout(r, 120));
  const { rows } = await query(
    "select count(*)::int as n from message_events where message_id = $1 and type = 'open'", [message.id]);
  assert.equal(rows[0].n, 1);
});

suite('a bad open token still returns a pixel rather than an error', async () => {
  // A broken image in the middle of an email looks like a broken sender.
  const res = await fetch(`${base}/o/rubbish`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
});

suite('a click redirects to the original link and records it', async () => {
  const { message } = await fixture('htest-click');
  const url = 'https://example.com/pricing?utm=1';
  const token = mint('c', { m: message.id, h: urlDigest(url) });

  const res = await fetch(`${base}/c/${token}?u=${encodeURIComponent(url)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), url);

  await new Promise((r) => setTimeout(r, 120));
  const { rows } = await query(
    "select url from message_events where message_id = $1 and type = 'click'", [message.id]);
  assert.equal(rows[0].url, url);
});

suite('the click tracker cannot be turned into an open redirect', async () => {
  // Without the digest check, /c/<valid token>?u=<anything> would redirect
  // from a domain recipients have been taught to trust — exactly what a
  // phisher wants from a marketing platform.
  const { message } = await fixture('htest-redirect');
  const real = 'https://example.com/pricing';
  const token = mint('c', { m: message.id, h: urlDigest(real) });

  const res = await fetch(
    `${base}/c/${token}?u=${encodeURIComponent('https://phishing.example/login')}`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
});

suite('a javascript: destination is refused even with a matching digest', async () => {
  const { message } = await fixture('htest-scheme');
  const bad = 'javascript:alert(1)';
  const token = mint('c', { m: message.id, h: urlDigest(bad) });

  const res = await fetch(`${base}/c/${token}?u=${encodeURIComponent(bad)}`, { redirect: 'manual' });
  assert.equal(res.status, 400);
});

suite('admin routes reject a missing or wrong token', async () => {
  assert.equal((await fetch(`${base}/v1/brands`)).status, 401);
  assert.equal((await fetch(`${base}/v1/brands`, {
    headers: { authorization: 'Bearer wrong-token' },
  })).status, 401);
  assert.equal((await fetch(`${base}/v1/brands`, {
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  })).status, 200);
});

suite('a forged SNS notification is refused', async () => {
  const res = await fetch(`${base}/webhooks/ses`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({
      Type: 'Notification',
      Message: JSON.stringify({ eventType: 'Complaint' }),
      Signature: 'forged',
      SignatureVersion: '1',
      SigningCertURL: 'https://attacker.example/cert.pem',
    }),
  });
  assert.equal(res.status, 403);
});

suite('the subscribe endpoint needs a brand API key', async () => {
  const res = await fetch(`${base}/v1/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@http.test.example' }),
  });
  assert.equal(res.status, 401);
});

suite('a valid API key subscribes only to its own brand', async () => {
  const { brand } = await fixture('htest-apikey');
  const other = await fixture('htest-otherbrand');

  const { generateApiKey, hashApiKey } = await import('../src/tokens.mjs');
  const secret = generateApiKey('htest');
  await query('insert into api_keys (brand_id, name, key_hash) values ($1,$2,$3)',
    [brand.id, 'test', hashApiKey(secret)]);

  const res = await fetch(`${base}/v1/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ email: 'newcomer@http.test.example', first_name: 'New', source: 'test-form' }),
  });
  assert.equal(res.status, 201);

  // The key resolves the brand; there is no brand parameter to tamper with.
  const { rows } = await query('select brand_id, consent_at, consent_source from contacts where email = $1',
    ['newcomer@http.test.example']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brand_id, brand.id);
  assert.notEqual(rows[0].brand_id, other.brand.id);
  assert.ok(rows[0].consent_at, 'consent must be evidenced, not assumed');
  assert.equal(rows[0].consent_source, 'test-form');
});

suite('a suppressed address cannot be re-added through the public endpoint', async () => {
  const { brand } = await fixture('htest-suppressed');
  const { generateApiKey, hashApiKey } = await import('../src/tokens.mjs');
  const secret = generateApiKey('htest');
  await query('insert into api_keys (brand_id, name, key_hash) values ($1,$2,$3)',
    [brand.id, 'test', hashApiKey(secret)]);

  const email = 'complained@http.test.example';
  await query("insert into suppressions (brand_id, email, reason) values (null,$1,'complaint')", [email]);

  const res = await fetch(`${base}/v1/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ email }),
  });

  // Answers 200 either way on purpose: a different response would turn this
  // endpoint into a way to test whether somebody complained about a brand.
  assert.equal(res.status, 200);
  const { rows } = await query('select 1 from contacts where email = $1', [email]);
  assert.equal(rows.length, 0, 'the contact must not have been created');
});

suite('the honeypot field silently absorbs bots', async () => {
  const { brand } = await fixture('htest-honeypot');
  const { generateApiKey, hashApiKey } = await import('../src/tokens.mjs');
  const secret = generateApiKey('htest');
  await query('insert into api_keys (brand_id, name, key_hash) values ($1,$2,$3)',
    [brand.id, 'test', hashApiKey(secret)]);

  const res = await fetch(`${base}/v1/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ email: 'bot@http.test.example', website: 'http://spam.example' }),
  });
  assert.equal(res.status, 200);

  const { rows } = await query('select 1 from contacts where email = $1', ['bot@http.test.example']);
  assert.equal(rows.length, 0);
});
