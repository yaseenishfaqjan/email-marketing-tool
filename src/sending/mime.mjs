/**
 * Build the raw MIME message.
 *
 * SES's "simple" send shape cannot carry the headers this needs, and those
 * headers are not decoration:
 *
 *   List-Unsubscribe / List-Unsubscribe-Post
 *     Google and Yahoo have required one-click unsubscribe from bulk senders
 *     since February 2024. Without it, good mail goes to spam.
 *
 * Bodies are base64 with wrapped lines. Quoted-printable would be smaller, but
 * base64 cannot be corrupted by a stray line ending or an 8-bit character, and
 * a mangled body is a far worse outcome than a few extra kilobytes.
 */

import crypto from 'node:crypto';

const wrap76 = (b64) => b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
const isAscii = (s) => /^[\x20-\x7E]*$/.test(s);

/** RFC 2047 encoded-word, so non-ASCII subjects survive every mail server. */
export function encodeHeaderValue(value) {
  const v = String(value).replace(/[\r\n]/g, ' ');
  if (isAscii(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** A display name that contains a comma or a quote must be quoted, or the address parses wrong. */
export function formatAddress(name, email) {
  if (!name) return email;
  const encoded = encodeHeaderValue(name);
  const needsQuotes = /[",;:<>@\[\]\\]/.test(encoded);
  return `${needsQuotes ? `"${encoded.replace(/"/g, '\\"')}"` : encoded} <${email}>`;
}

/**
 * @param {object} m
 * @param {string} m.fromName
 * @param {string} m.fromEmail
 * @param {string} m.to
 * @param {string} [m.replyTo]
 * @param {string} m.subject
 * @param {string} m.text
 * @param {string} m.html
 * @param {string} [m.unsubscribeUrl]  enables one-click unsubscribe
 * @param {string} [m.unsubscribeMailto]
 * @param {Object<string,string>} [m.headers]  extra headers, e.g. correlation ids
 * @returns {Buffer}
 */
export function buildMime(m) {
  const boundary = `----=_Part_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${formatAddress(m.fromName, m.fromEmail)}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderValue(m.subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
  ];

  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);

  if (m.unsubscribeUrl) {
    const targets = [`<${m.unsubscribeUrl}>`];
    if (m.unsubscribeMailto) targets.push(`<mailto:${m.unsubscribeMailto}>`);
    lines.push(`List-Unsubscribe: ${targets.join(', ')}`);
    lines.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  for (const [key, value] of Object.entries(m.headers ?? {})) {
    // Header injection defence: a newline in a value would let a merge field
    // append headers of its own.
    lines.push(`${key}: ${String(value).replace(/[\r\n]/g, ' ')}`);
  }

  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push('');

  // Plain text first. In multipart/alternative the LAST part is the preferred
  // one, so HTML must come second or text-capable clients will show the source.
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap76(Buffer.from(m.text, 'utf8').toString('base64')));

  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap76(Buffer.from(m.html, 'utf8').toString('base64')));

  lines.push(`--${boundary}--`);
  lines.push('');

  return Buffer.from(lines.join('\r\n'), 'utf8');
}
