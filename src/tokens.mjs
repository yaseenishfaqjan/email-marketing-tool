/**
 * Signed, self-describing tokens for links that must work with no login:
 * unsubscribe, open pixel, click redirect.
 *
 * The payload is visible but not forgeable. That is the right trade: the link
 * lands in a stranger's inbox and may be forwarded, scanned and replayed, so
 * the only thing that matters is that nobody can mint one for somebody else's
 * address — which is exactly what an opaque random id in a database column
 * would also require a lookup to guarantee, at the cost of a table write per
 * recipient per link.
 */

import crypto from 'node:crypto';
import config from './config.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', config.tokenSecret).update(payload).digest();
}

/**
 * @param {'u'|'o'|'c'} kind  unsubscribe | open | click
 * @param {object} data       small, non-secret claims
 */
export function mint(kind, data) {
  const payload = b64url(JSON.stringify({ k: kind, ...data }));
  return `${payload}.${b64url(sign(payload))}`;
}

/**
 * Verify and decode. Returns null for anything that does not check out —
 * callers must treat null as "ignore this request", never as an error to
 * report, because a bad token is usually a scanner probing.
 */
export function verify(kind, token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(payload);

  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (data?.k !== kind) return null;   // an open pixel token must not unsubscribe anyone
  return data;
}

/** Hash an API key for storage. The plaintext is shown once and never kept. */
export function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function generateApiKey(brandSlug) {
  return `emk_${brandSlug}_${crypto.randomBytes(24).toString('base64url')}`;
}
