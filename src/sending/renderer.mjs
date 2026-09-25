/**
 * Turn a campaign plus a contact into the exact bytes SES will send.
 *
 * Three things happen here that are easy to get wrong and expensive to get
 * wrong late:
 *
 *  1. Every email carries a working unsubscribe link and the brand's postal
 *     address. Both are legal requirements, so neither is left to whoever
 *     writes the template.
 *  2. Merge fields are HTML-escaped. A contact's name arrives from a public
 *     form; without escaping, a signup called `</td><script>` is a stored XSS
 *     in an email client.
 *  3. A plain-text part is always produced. Plenty of people read mail with
 *     HTML off, and a missing text/plain part is itself a spam signal.
 */

import crypto from 'node:crypto';
import mjml2html from 'mjml';
import { mint } from '../tokens.mjs';
import config from '../config.mjs';

/**
 * A short digest of the destination, carried inside the click token.
 *
 * Without it, /c/<token>?u=<anything> is an open redirect on a domain the
 * recipient has been taught to trust — which is exactly what a phisher wants
 * from a marketing platform. With it, the token only redirects to the link
 * that was actually in the email.
 */
export const urlDigest = (url) =>
  crypto.createHash('sha256').update(url).digest('base64url').slice(0, 16);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

/** Base URL for this brand's tracking links, falling back to the service itself. */
export function trackingBase(brand) {
  return brand.tracking_domain ? `https://${brand.tracking_domain}` : config.publicUrl;
}

/**
 * MJML compilation is slow (tens of milliseconds) and identical for every
 * recipient, so it happens once per campaign and the result is reused. At
 * 50,000 recipients this is the difference between a send that takes minutes
 * and one that takes an hour.
 */
export function compileTemplate(mjml) {
  const { html, errors } = mjml2html(mjml, { validationLevel: 'soft' });
  if (errors?.length) {
    const fatal = errors.filter((e) => e.formattedMessage);
    if (fatal.length) console.warn('[render] MJML warnings:', fatal.map((e) => e.formattedMessage).join('; '));
  }
  return html;
}

function substitute(template, contact, { escape }) {
  const values = {
    first_name: contact.first_name ?? '',
    last_name: contact.last_name ?? '',
    email: contact.email ?? '',
    ...Object.fromEntries(Object.entries(contact.attrs ?? {}).map(([k, v]) => [`attrs.${k}`, v])),
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]{1,64})\s*\}\}/g, (whole, key) => {
    const v = values[key];
    if (v === undefined || v === null) return '';
    return escape ? escapeHtml(v) : String(v);
  });
}

/**
 * Rewrite outbound links through the click tracker.
 *
 * Anchors marked `data-no-track` and the unsubscribe link itself are left
 * alone — an unsubscribe that depends on the tracking pipeline being healthy
 * is an unsubscribe that will one day fail, and that is the one link that must
 * never fail.
 */
function rewriteLinks(html, messageId, base) {
  return html.replace(
    /<a\s([^>]*?)href="(https?:\/\/[^"]+)"([^>]*)>/gi,
    (whole, pre, url, post) => {
      if (/data-no-track/i.test(pre + post)) return whole;
      if (url.startsWith(`${base}/u/`)) return whole;
      const token = mint('c', { m: messageId, h: urlDigest(url) });
      const tracked = `${base}/c/${token}?u=${encodeURIComponent(url)}`;
      return `<a ${pre}href="${tracked}"${post}>`;
    },
  );
}

function footer(brand, unsubUrl) {
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8177;
              padding:24px 16px;text-align:center;">
    ${escapeHtml(brand.postal_address)}<br>
    <a href="${unsubUrl}" style="color:#8a8177;">Unsubscribe</a>
  </div>`;
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n\n')
    // The destination is emitted in parentheses, not angle brackets: the tag
    // stripper on the next line cannot tell `<https://…>` from markup, and
    // would silently eat every link in the plain-text part.
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) =>
      `${text.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/**
 * @param {object} args
 * @param {object} args.brand
 * @param {object} args.contact
 * @param {string} args.messageId
 * @param {string} args.subject
 * @param {string} args.compiledHtml  output of compileTemplate()
 * @returns {{subject: string, html: string, text: string, unsubscribeUrl: string}}
 */
export function renderMessage({ brand, contact, messageId, subject, compiledHtml }) {
  const base = trackingBase(brand);
  const unsubscribeUrl = `${base}/u/${mint('u', { m: messageId })}`;

  let html = substitute(compiledHtml, contact, { escape: true });
  html = rewriteLinks(html, messageId, base);

  const text = `${htmlToText(html)}\n\n--\n${brand.postal_address}\nUnsubscribe: ${unsubscribeUrl}`;

  // The pixel goes last so a client that stops rendering early still counts
  // the body as read, and the footer is appended after link rewriting so the
  // unsubscribe href is never itself rewritten.
  html = html.replace(
    /<\/body>/i,
    `${footer(brand, unsubscribeUrl)}<img src="${base}/o/${mint('o', { m: messageId })}" width="1" height="1" alt="" style="display:block;border:0;">\n</body>`,
  );
  if (!/<\/body>/i.test(compiledHtml)) {
    html += footer(brand, unsubscribeUrl);
  }

  return {
    subject: substitute(subject, contact, { escape: false }),
    html,
    text,
    unsubscribeUrl,
  };
}

export const _internals = { escapeHtml, substitute, rewriteLinks, htmlToText };
