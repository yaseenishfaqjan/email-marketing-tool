import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://mailer:mailer@localhost:5432/mailer';
process.env.TOKEN_SECRET ??= '0'.repeat(64);
process.env.ADMIN_TOKEN ??= '1'.repeat(64);

const { issue, clear, requireSession, requireCsrf, csrfFor, login, _test } =
  await import('../src/http/admin/session.mjs');

/** A res stub that records what was set. */
function resStub() {
  return {
    headers: {}, statusCode: 200, redirected: null, sent: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.sent = b; return this; },
    redirect(code, url) { this.statusCode = code; this.redirected = url; return this; },
  };
}

function reqStub(cookie = '', body = {}) {
  return { get: (h) => (h.toLowerCase() === 'cookie' ? cookie : undefined), body, originalUrl: '/admin' };
}

/** Run issue(), then hand the cookie it set back as a request. */
function signedIn() {
  const res = resStub();
  issue(res);
  const raw = res.headers['set-cookie'].split(';')[0];
  return { cookieHeader: raw, setCookie: res.headers['set-cookie'] };
}

test('the session cookie is HttpOnly, Secure and SameSite=Strict', () => {
  // Any one of these missing turns the cookie into something a script or a
  // cross-site form can reach.
  const { setCookie } = signedIn();
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
});

test('a valid cookie is accepted', () => {
  const { cookieHeader } = signedIn();
  const req = reqStub(cookieHeader);
  let passed = false;
  requireSession(req, resStub(), () => { passed = true; });
  assert.equal(passed, true);
  assert.ok(req.csrf);
});

test('no cookie redirects to login, carrying where you were going', () => {
  const res = resStub();
  requireSession({ ...reqStub(''), originalUrl: '/admin/b/123/campaigns' }, res, () => {
    assert.fail('should not have continued');
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.redirected, /^\/admin\/login\?next=/);
  assert.match(res.redirected, /campaigns/);
});

test('a tampered cookie is rejected', () => {
  const { cookieHeader } = signedIn();
  // Flip a character in the signature half.
  const tampered = cookieHeader.slice(0, -2) + (cookieHeader.endsWith('A') ? 'B' : 'A');
  const res = resStub();
  requireSession(reqStub(tampered), res, () => assert.fail('forged cookie accepted'));
  assert.equal(res.statusCode, 302);
});

test('an expired session is rejected', async () => {
  const { mint } = await import('../src/tokens.mjs');
  const stale = mint('s', { exp: Date.now() - 1000, n: 'x' });
  const res = resStub();
  requireSession(reqStub(`mailer_admin=${encodeURIComponent(stale)}`), res,
    () => assert.fail('expired session accepted'));
  assert.equal(res.statusCode, 302);
});

test('a token of another kind cannot act as a session', async () => {
  // An unsubscribe token is public — it travels in every email. If it could
  // be replayed as a session cookie, every recipient would be an admin.
  const { mint } = await import('../src/tokens.mjs');
  const unsub = mint('u', { c: 'contact-id', b: 'brand-id' });
  const res = resStub();
  requireSession(reqStub(`mailer_admin=${encodeURIComponent(unsub)}`), res,
    () => assert.fail('unsubscribe token accepted as a session'));
  assert.equal(res.statusCode, 302);
});

test('clear() expires the cookie', () => {
  const res = resStub();
  clear(res);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});

test('CSRF: the right token passes, a wrong one does not', () => {
  const { cookieHeader } = signedIn();
  const req = reqStub(cookieHeader);
  requireSession(req, resStub(), () => {});

  let passed = false;
  requireCsrf({ ...req, body: { _csrf: req.csrf } }, resStub(), () => { passed = true; });
  assert.equal(passed, true);

  const res = resStub();
  requireCsrf({ ...req, body: { _csrf: 'nope' } }, res, () => assert.fail('bad CSRF accepted'));
  assert.equal(res.statusCode, 403);
});

test('CSRF: a missing token is refused', () => {
  const { cookieHeader } = signedIn();
  const req = reqStub(cookieHeader);
  requireSession(req, resStub(), () => {});
  const res = resStub();
  requireCsrf({ ...req, body: {} }, res, () => assert.fail('missing CSRF accepted'));
  assert.equal(res.statusCode, 403);
});

test("CSRF: one session's token does not work in another", () => {
  // Otherwise a token lifted from anywhere would work everywhere.
  const a = signedIn();
  const b = signedIn();
  const reqA = reqStub(a.cookieHeader);
  const reqB = reqStub(b.cookieHeader);
  requireSession(reqA, resStub(), () => {});
  requireSession(reqB, resStub(), () => {});
  assert.notEqual(reqA.csrf, reqB.csrf);

  const res = resStub();
  requireCsrf({ ...reqA, body: { _csrf: reqB.csrf } }, res, () => assert.fail('cross-session CSRF accepted'));
  assert.equal(res.statusCode, 403);
});

test('login.matches is exact', () => {
  assert.equal(login.matches('1'.repeat(64)), true);
  assert.equal(login.matches('1'.repeat(63) + '2'), false);
  assert.equal(login.matches('1'.repeat(63)), false);   // length mismatch must not throw
  assert.equal(login.matches(''), false);
  assert.equal(login.matches(undefined), false);
});

test('login throttling trips after the limit and clears on success', () => {
  const ip = '203.0.113.9';
  assert.equal(login.tooManyAttempts(ip), false);
  for (let i = 0; i < _test.MAX_ATTEMPTS; i += 1) login.recordAttempt(ip);
  assert.equal(login.tooManyAttempts(ip), true);
  login.clearAttempts(ip);
  assert.equal(login.tooManyAttempts(ip), false);
});

test('cookie parsing survives the junk browsers send', () => {
  const p = _test.parseCookies;
  assert.equal(p('a=1; mailer_admin=xyz; b=2').mailer_admin, 'xyz');
  assert.equal(p('mailer_admin=a%20b').mailer_admin, 'a b');
  assert.deepEqual(p(''), {});
  assert.deepEqual(p(undefined), {});
  assert.equal(p('broken; mailer_admin=ok').mailer_admin, 'ok');
});
