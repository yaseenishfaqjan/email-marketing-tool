/**
 * Amazon SNS message signature verification.
 *
 * This endpoint is public — it has to be, SNS posts to it from AWS with no
 * shared secret. Without signature verification, anyone who learns the URL can
 * post a forged complaint for any address and have it suppressed, or forge a
 * delivery for mail that never arrived.
 *
 * Two rules do the real work:
 *   1. The signing certificate URL must be an https AWS SNS host. Skipping
 *      this check is the classic break: an attacker supplies their own cert
 *      URL and signs the payload themselves.
 *   2. The signed string is built from a FIXED field list in a FIXED order,
 *      from our own parse of the body, never from anything the sender chose.
 */

import crypto from 'node:crypto';

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;

const SIGNED_FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

const certCache = new Map();

async function fetchCertificate(url) {
  if (certCache.has(url)) return certCache.get(url);

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !CERT_HOST.test(parsed.hostname)) {
    throw new Error(`Refusing certificate from ${parsed.hostname}`);
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Certificate fetch failed: ${res.status}`);
  const pem = await res.text();

  certCache.set(url, pem);
  if (certCache.size > 20) certCache.delete(certCache.keys().next().value);
  return pem;
}

function canonicalString(body) {
  const fields = SIGNED_FIELDS[body.Type];
  if (!fields) throw new Error(`Unknown SNS message type "${body.Type}"`);
  let out = '';
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null) continue;
    out += `${field}\n${body[field]}\n`;
  }
  return out;
}

/**
 * @param {object} body  the parsed SNS envelope
 * @returns {Promise<boolean>}
 */
export async function verifySnsSignature(body) {
  if (!body?.SigningCertURL || !body?.Signature) return false;

  // SNS still sends version 1 (SHA1) by default; version 2 is SHA256.
  const algorithm = body.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  if (!['1', '2'].includes(String(body.SignatureVersion))) return false;

  const pem = await fetchCertificate(body.SigningCertURL);
  const verifier = crypto.createVerify(algorithm);
  verifier.update(canonicalString(body), 'utf8');
  return verifier.verify(pem, body.Signature, 'base64');
}

export const _internals = { canonicalString, CERT_HOST };
