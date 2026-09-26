/**
 * Pre-send checks.
 *
 * Every rule here is something that cannot be undone once the campaign has
 * gone out, and that a person reading their own draft reliably misses: the
 * merge field they typo'd, the link they left pointing at staging, the
 * preheader they never set so Gmail shows "View in browser" next to the
 * subject line.
 *
 * Errors block the send. Warnings do not — this advises, it does not overrule
 * the person who writes the emails, and a rule that cries wolf gets ignored
 * along with the ones that matter.
 */

import mjml2html from 'mjml';

const KNOWN_FIELDS = new Set(['first_name', 'last_name', 'email', 'confirm_url']);

const err = (code, message, hint) => ({ level: 'error', code, message, hint });
const warn = (code, message, hint) => ({ level: 'warning', code, message, hint });

/**
 * @param {object} campaign  { subject, preheader, mjml }
 * @param {object} [options]
 * @param {string[]} [options.knownAttributes]  attribute names your contacts carry
 * @param {number|null} [options.contactsMissingName]  how many recipients have
 *   no first name. Turns a guess into a fact, so the warning only fires when
 *   it is actually true of this brand's list.
 * @returns {{ok: boolean, errors: object[], warnings: object[], stats: object}}
 */
export function lintCampaign(campaign, { knownAttributes = [], contactsMissingName = null } = {}) {
  const findings = [];
  const subject = campaign.subject ?? '';
  const mjml = campaign.mjml ?? '';

  /* ---------------------------------------------------------- subject -- */

  if (!subject.trim()) {
    findings.push(err('subject_missing', 'The campaign has no subject line.',
      'An email with no subject is usually filtered before anybody sees it.'));
  } else {
    // Gmail on a phone shows roughly the first 35 characters; desktop clients
    // cut around 70. Past that the words are paid for and never read.
    if (subject.length > 70) {
      findings.push(warn('subject_long',
        `The subject is ${subject.length} characters; most clients cut it around 70.`,
        'Put the point in the first 35 characters.'));
    }
    if (subject === subject.toUpperCase() && /[A-Z]{4,}/.test(subject)) {
      findings.push(warn('subject_shouting', 'The subject is in capitals.',
        'Filters weight this, and so do readers.'));
    }
    if ((subject.match(/[!?]/g) ?? []).length > 2) {
      findings.push(warn('subject_punctuation', 'The subject has a lot of ! or ?.',
        'A common spam signal.'));
    }
  }

  if (!campaign.preheader?.trim()) {
    findings.push(warn('preheader_missing', 'No preheader is set.',
      'Clients will show whatever text comes first instead — often "View in browser".'));
  }

  /* ------------------------------------------------------------- body -- */

  let html = '';
  try {
    const compiled = mjml2html(mjml, { validationLevel: 'soft' });
    html = compiled.html;
    for (const e of compiled.errors ?? []) {
      findings.push(warn('mjml_warning', e.formattedMessage ?? String(e), 'Check the template markup.'));
    }
  } catch (e) {
    findings.push(err('mjml_invalid', `The template does not compile: ${e.message}`,
      'Fix the MJML before sending.'));
    return summarise(findings, { links: [], mergeFields: [] });
  }

  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...html.matchAll(/<a\s[^>]*href="([^"]+)"/gi)].map((m) => m[1])
    .filter((u) => !u.startsWith('mailto:') && !u.startsWith('tel:'));

  if (text.length < 40 && images.length > 0) {
    findings.push(warn('image_only',
      'The email is nearly all image and almost no text.',
      'Filters distrust image-only mail, and many people read with images off.'));
  }

  // MJML emits alt="" whether or not one was given, so the signal is an EMPTY
  // alt, not a missing attribute. Checking for the attribute's presence — the
  // obvious thing to write — never fires at all.
  const withoutAlt = images.filter((tag) => !/\balt\s*=\s*"[^"]+"/i.test(tag));
  if (withoutAlt.length) {
    findings.push(warn('image_no_alt',
      `${withoutAlt.length} image(s) have no alt text.`,
      'Alt text is what the reader sees before images load, and what a screen reader reads.'));
  }

  /* ------------------------------------------------------------ links -- */

  if (links.length === 0) {
    findings.push(warn('no_links', 'The email contains no links.',
      'Nothing for the reader to do, and nothing to measure but opens — which are unreliable.'));
  }

  const insecure = links.filter((u) => u.startsWith('http://'));
  if (insecure.length) {
    findings.push(warn('insecure_link', `${insecure.length} link(s) use http:// rather than https://.`,
      'Some clients warn on these, and it costs trust.'));
  }

  const local = links.filter((u) => /localhost|127\.0\.0\.1|\.local\b|staging\.|\.test\b/i.test(u));
  if (local.length) {
    findings.push(err('local_link',
      `${local.length} link(s) point at a local or staging address: ${local.slice(0, 3).join(', ')}`,
      'These are dead for every recipient.'));
  }

  const placeholder = links.filter((u) => /example\.com|#$|^#/.test(u));
  if (placeholder.length) {
    findings.push(warn('placeholder_link', `${placeholder.length} link(s) still look like placeholders.`,
      'Check they were meant to ship.'));
  }

  /* ----------------------------------------------------- merge fields -- */

  const used = [...new Set([
    ...[...subject.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]),
    ...[...mjml.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]),
  ])];

  const allowed = new Set([...KNOWN_FIELDS, ...knownAttributes.map((a) => `attrs.${a}`)]);
  const unknown = used.filter((f) => !allowed.has(f));
  if (unknown.length) {
    // A merge field that resolves to nothing renders as an empty string, so
    // "Hi {{frist_name}}," silently becomes "Hi ,".
    findings.push(err('unknown_merge_field',
      `Unrecognised merge field(s): ${unknown.join(', ')}.`,
      'These render as empty text. Check the spelling, or the attribute exists on your contacts.'));
  }

  // Greeting a nameless contact reads as broken — but only warn when this
  // brand's list actually contains some. Counted, not guessed: a warning that
  // fires on every template is a warning nobody reads.
  const greetsByName = used.includes('first_name')
    && /\{\{\s*first_name\s*\}\}\s*[,!.]/.test(mjml);
  if (greetsByName && contactsMissingName > 0) {
    findings.push(warn('bare_name_greeting',
      `${contactsMissingName} recipient(s) have no first name and will see "Hi ,".`,
      'Give the greeting a fallback, or drop the name from it.'));
  }

  return summarise(findings, { links: [...new Set(links)], mergeFields: used, textLength: text.length });
}

function summarise(findings, stats) {
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');
  return { ok: errors.length === 0, errors, warnings, stats };
}
