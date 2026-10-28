/**
 * Svix webhook signature verification — the scheme Resend uses.
 *
 * Without this, anyone who learns the endpoint URL can POST a forged
 * `email.bounced` and have us suppress any address they name. Suppression is
 * global and deliberate to undo, so that is a denial-of-service on a
 * customer's mail, not a cosmetic problem.
 *
 * Three headers carry the proof:
 *
 *   svix-id         unique per delivery
 *   svix-timestamp  unix seconds
 *   svix-signature  one or more "v1,<base64>" entries, space separated
 *
 * The signed string is `${id}.${timestamp}.${body}` — the id and timestamp are
 * in there so a captured delivery cannot be replayed later or against another
 * endpoint. The raw body matters: re-serialising parsed JSON changes key order
 * and whitespace, and the signature stops matching.
 *
 * Svix sends several signatures during a secret rotation, so any one matching
 * is a pass.
 */

import crypto from 'node:crypto';

/** Deliveries older than this are refused, so a captured one cannot be replayed. */
const TOLERANCE_SECONDS = 5 * 60;

/** Svix also sends these under a `webhook-` prefix; accept both. */
function header(headers, name) {
  return headers[`svix-${name}`] ?? headers[`webhook-${name}`] ?? null;
}

function keyFrom(secret) {
  // Secrets are issued as `whsec_<base64>`. The prefix is a label, not part of
  // the key; a raw base64 secret is accepted too since people paste both.
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(base64, 'base64');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare lengths first and return the same way either way.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {object} args
 * @param {object} args.headers   lowercased request headers
 * @param {string} args.body      the raw request body, exactly as received
 * @param {string} args.secret    the endpoint's signing secret
 * @param {number} [args.now]     unix seconds; injectable for tests
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifySvixSignature({ headers, body, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };

  const id = header(headers, 'id');
  const timestamp = header(headers, 'timestamp');
  const signature = header(headers, 'signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'bad_timestamp' };
  // Both directions: a future timestamp is as suspect as an old one, and
  // clock skew beyond five minutes is a problem worth seeing.
  if (Math.abs(now - sent) > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = crypto
    .createHmac('sha256', keyFrom(secret))
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');

  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) continue;
    if (timingSafeEqual(value, expected)) return { ok: true };
  }

  return { ok: false, reason: 'no_matching_signature' };
}

export const _test = { TOLERANCE_SECONDS, keyFrom };
