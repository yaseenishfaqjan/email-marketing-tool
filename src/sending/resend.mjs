/**
 * The Resend client.
 *
 * Resend has no raw-MIME endpoint, so this adapter sends the structured
 * message — subject, html, text, headers — and lets Resend assemble the MIME
 * itself. That is why `send()` takes a message spec rather than a Buffer: it
 * is the one shape both providers can be driven from. SES builds the MIME
 * with our own builder; Resend builds its own.
 *
 * The consequence worth knowing: List-Unsubscribe and the one-click POST
 * header are passed through `headers` rather than written by us. Resend
 * forwards custom headers verbatim, so the result is the same on the wire —
 * but if that ever changes, one-click unsubscribe is what breaks, and Gmail
 * and Yahoo have required it for bulk senders since February 2024.
 *
 * Errors are classified the same three ways as SES, because the worker's
 * response to each is what matters, not which provider produced it.
 */

import config from '../config.mjs';
import { formatAddress } from './mime.mjs';

const ENDPOINT = 'https://api.resend.com/emails';

export function classifyError(err) {
  const status = err?.status;

  // 429 is Resend's rate limit. Unlike a 4xx it says nothing about the
  // message, so the worker should requeue rather than fail it.
  if (status === 429) return 'throttle';

  // 422 is a malformed or rejected recipient — retrying cannot help.
  // 401/403 are a bad API key, which is permanent until someone fixes the
  // environment, and retrying would burn the whole queue against a wall.
  if (status && status >= 400 && status < 500) return 'permanent';

  return 'transient';
}

/**
 * @param {object} m            the same spec buildMime takes, plus `from`
 * @returns {Promise<{messageId: string}>}
 */
export async function send(m) {
  const headers = { ...(m.headers ?? {}) };

  if (m.unsubscribeUrl) {
    const targets = [`<${m.unsubscribeUrl}>`];
    if (m.unsubscribeMailto) targets.push(`<mailto:${m.unsubscribeMailto}>`);
    headers['List-Unsubscribe'] = targets.join(', ');
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  // Same defence as the MIME builder: a newline in a merge field would
  // otherwise let a contact's first name append headers of its own.
  for (const [k, v] of Object.entries(headers)) {
    headers[k] = String(v).replace(/[\r\n]/g, ' ');
  }

  const body = {
    from: formatAddress(m.fromName, m.fromEmail),
    to: [m.to],
    subject: m.subject,
    ...(m.html ? { html: m.html } : {}),
    ...(m.text ? { text: m.text } : {}),
    ...(m.replyTo ? { reply_to: m.replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.resend.timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    err.name = 'ResendError';
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  return { messageId: json.id };
}

export const _test = { classifyError, send };
