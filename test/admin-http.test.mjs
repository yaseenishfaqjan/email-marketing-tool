/**
 * The admin panel over real HTTP: who gets in, and what a request without a
 * session or a CSRF token is allowed to do.
 *
 * These paths matter more than most. One of the POSTs behind them sends mail
 * to an entire list, and that cannot be recalled.
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
  } catch { return false; }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { close } = await import('../src/db.mjs');
const { createApp } = await import('../src/app.mjs');
const config = (await import('../src/config.mjs')).default;

let server;
let base;

test.before(async () => {
  if (!DB_AVAILABLE) return;
  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (DB_AVAILABLE) await close();
});

const form = (obj) => new URLSearchParams(obj).toString();
const POST = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: form(body),
});

suite('the panel redirects to login when signed out', async () => {
  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

suite('the login page renders without a session', async () => {
  const res = await fetch(`${base}/admin/login`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Admin token/);
});

suite('a wrong token does not sign you in', async () => {
  const res = await POST('/admin/login', { token: 'definitely-not-it' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

suite('the right token sets a session cookie', async () => {
  const res = await POST('/admin/login', { token: config.adminToken, next: '/admin' });
  assert.equal(res.status, 302);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /mailer_admin=/);
  assert.match(cookie, /HttpOnly/);
});

suite('next= cannot be pointed off-site', async () => {
  // An open redirect on a login page is how a convincing phishing link is
  // built: the victim really does land on the real login first.
  for (const evil of ['https://evil.example/x', '//evil.example/x', '/not-admin']) {
    const res = await POST('/admin/login', { token: config.adminToken, next: evil });
    assert.equal(res.headers.get('location'), '/admin', `rejected: ${evil}`);
  }
});

suite('a POST with a session but no CSRF token is refused', async () => {
  const signIn = await POST('/admin/login', { token: config.adminToken });
  const cookie = signIn.headers.get('set-cookie').split(';')[0];

  const res = await POST('/admin/b/00000000-0000-0000-0000-000000000000/campaigns',
    { name: 'x', subject: 'y' }, { cookie });
  assert.equal(res.status, 403);
});

suite('a POST with no session at all redirects rather than acting', async () => {
  const res = await POST('/admin/b/00000000-0000-0000-0000-000000000000/campaigns',
    { name: 'x', subject: 'y' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

suite('an unknown brand is a 404, not a crash', async () => {
  const signIn = await POST('/admin/login', { token: config.adminToken });
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/admin/b/00000000-0000-0000-0000-000000000000`,
    { headers: { cookie }, redirect: 'manual' });
  assert.equal(res.status, 404);
});

suite('the panel is not reachable with a bearer token', async () => {
  // The API takes bearer auth; the panel deliberately does not, so that a
  // token cannot be put in a URL or a header by a browser extension.
  const res = await fetch(`${base}/admin`, {
    headers: { authorization: `Bearer ${config.adminToken}` }, redirect: 'manual',
  });
  assert.equal(res.status, 302);
});
