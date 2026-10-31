/**
 * Browser sessions for the admin UI.
 *
 * The API authenticates with `Authorization: Bearer <ADMIN_TOKEN>`, which is
 * right for scripts and wrong for a browser: a token in a URL ends up in
 * history, in screenshots and in nginx access logs. So the login form takes
 * the same token once and exchanges it for a signed, HttpOnly cookie.
 *
 * No new credential is introduced — ADMIN_TOKEN remains the only secret. The
 * cookie is a short-lived, signed assertion that somebody proved they had it.
 *
 * CSRF matters more here than on most admin panels. A GET cannot change
 * anything, but one of the POSTs sends a campaign to the entire list, and
 * that is not undoable. SameSite=Strict stops a cross-site form post on its
 * own; the per-session token is the belt to that braces, since a single
 * browser bug or a future SameSite relaxation would otherwise be enough.
 */

import crypto from 'node:crypto';
import config from '../../config.mjs';
import { mint, verify } from '../../tokens.mjs';

const COOKIE = 'mailer_admin';

/** Eight hours: long enough for a working day, short enough that a forgotten
 *  laptop stops being a key overnight. */
const TTL_MS = 8 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sameToken(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------- login throttle -- */

/**
 * The admin token is 64 hex characters, so it is not guessable in any
 * practical sense; this is here to make a scripted attempt expensive and
 * noisy rather than free and silent. In memory on purpose — one process, and
 * a restart clearing it costs nothing.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function tooManyAttempts(ip) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.first > WINDOW_MS) return false;
  return record.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.first > WINDOW_MS) {
    attempts.set(ip, { first: now, count: 1 });
  } else {
    record.count += 1;
  }
  // Bounded: without this the map is a slow memory leak fed by the internet.
  if (attempts.size > 5000) attempts.clear();
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

/* -------------------------------------------------------------- session -- */

export function issue(res) {
  const token = mint('s', { exp: Date.now() + TTL_MS, n: crypto.randomUUID() });
  // Secure is unconditional: the admin UI is served over TLS behind nginx, and
  // a cookie that would travel in clear is worse than no cookie.
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}`);
}

export function clear(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function readSession(req) {
  const raw = parseCookies(req.get('cookie'))[COOKIE];
  if (!raw) return null;
  const data = verify('s', raw);
  if (!data) return null;
  if (!data.exp || Date.now() > data.exp) return null;
  return { raw, ...data };
}

/** The CSRF token is derived from the session cookie, so it is valid only for
 *  the browser holding that cookie and needs no server-side store. */
export function csrfFor(session) {
  return crypto.createHmac('sha256', config.tokenSecret)
    .update(`csrf.${session.raw}`)
    .digest('base64url');
}

export function requireSession(req, res, next) {
  const session = readSession(req);
  if (!session) {
    const next_ = encodeURIComponent(req.originalUrl || '/admin');
    return res.redirect(302, `/admin/login?next=${next_}`);
  }
  req.session = session;
  req.csrf = csrfFor(session);
  next();
}

/** Applied to every state-changing admin POST. */
export function requireCsrf(req, res, next) {
  const given = req.body?._csrf;
  if (!given || !sameToken(given, req.csrf)) {
    return res.status(403).send('This form expired. Go back, reload the page and try again.');
  }
  next();
}

export const login = {
  tooManyAttempts,
  recordAttempt,
  clearAttempts,
  /** Constant-time: the token must not be recoverable a byte at a time. */
  matches: (given) => Boolean(given) && sameToken(given, config.adminToken),
};

export const _test = { parseCookies, COOKIE, TTL_MS, MAX_ATTEMPTS };
