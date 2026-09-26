/**
 * List hygiene: what an import would actually do, before it does it.
 *
 * Imports are where lists get poisoned, and a bad one is not a local mistake —
 * it raises the bounce rate on an account every brand shares. The cost of
 * finding out afterwards is measured in weeks of suspended sending.
 *
 * So an import can be run as a dry run first, and the report tells you what
 * you would be adding: how many are dead on arrival, how many are role
 * accounts nobody reads, how many are obvious typos worth fixing rather than
 * discarding.
 *
 * Nothing here rejects an address on its own. It reports, and the person
 * importing decides — a heuristic that silently drops real customers is worse
 * than the bounce it prevented.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Addresses that reach a team inbox rather than a person.
 *
 * They bounce less often than they go unread, get forwarded to people who
 * never subscribed, and are the most common source of spam complaints from an
 * otherwise clean list.
 */
const ROLE_PREFIXES = new Set([
  'admin', 'billing', 'contact', 'enquiries', 'hello', 'help', 'info', 'jobs',
  'mail', 'marketing', 'noreply', 'no-reply', 'office', 'postmaster', 'sales',
  'support', 'team', 'webmaster',
]);

/** Domains that exist to be thrown away. Nobody reads mail sent to one twice. */
const DISPOSABLE = new Set([
  '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'trashmail.com', 'yopmail.com',
  'getnada.com', 'dispostable.com', 'fakeinbox.com', 'sharklasers.com',
]);

/**
 * Typos common enough to be worth correcting rather than discarding.
 *
 * Every one of these is a real customer who mistyped their own address. Left
 * alone each is a guaranteed hard bounce; corrected, each is a subscriber.
 */
const TYPOS = new Map(Object.entries({
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gmaill.com': 'gmail.com', 'gnail.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com',
  'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com',
}));

export function inspect(rawEmail) {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  const flags = [];

  if (!email) return { email, valid: false, flags: ['empty'] };
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { email, valid: false, flags: ['malformed'] };
  }

  const [local, domain] = email.split('@');

  if (ROLE_PREFIXES.has(local)) flags.push('role_account');
  if (DISPOSABLE.has(domain)) flags.push('disposable');

  const suggestion = TYPOS.get(domain);
  if (suggestion) flags.push('likely_typo');

  // Two dots in a row, or a leading/trailing dot in the local part: almost
  // always a paste that went wrong.
  if (/\.\./.test(email) || local.startsWith('.') || local.endsWith('.')) {
    flags.push('suspicious_dots');
  }

  return {
    email,
    valid: true,
    flags,
    ...(suggestion ? { suggestion: `${local}@${suggestion}` } : {}),
  };
}

/**
 * Inspect a whole list.
 *
 * @param {string[]} emails
 * @returns a report a person can act on, not a pass/fail
 */
export function report(emails) {
  const seen = new Map();
  const rows = [];

  const counts = {
    total: emails.length, valid: 0, malformed: 0, duplicates: 0,
    role_accounts: 0, disposable: 0, likely_typos: 0, suspicious_dots: 0, clean: 0,
  };

  const samples = { malformed: [], role_accounts: [], disposable: [], likely_typos: [] };
  const push = (bucket, value) => { if (samples[bucket].length < 10) samples[bucket].push(value); };

  for (const raw of emails) {
    const r = inspect(raw);

    if (!r.valid) {
      counts.malformed += 1;
      push('malformed', String(raw).slice(0, 80));
      rows.push(r);
      continue;
    }

    if (seen.has(r.email)) {
      counts.duplicates += 1;
      continue;
    }
    seen.set(r.email, true);

    counts.valid += 1;
    if (r.flags.includes('role_account')) { counts.role_accounts += 1; push('role_accounts', r.email); }
    if (r.flags.includes('disposable')) { counts.disposable += 1; push('disposable', r.email); }
    if (r.flags.includes('likely_typo')) {
      counts.likely_typos += 1;
      push('likely_typos', `${r.email} → ${r.suggestion}`);
    }
    if (r.flags.includes('suspicious_dots')) counts.suspicious_dots += 1;
    if (r.flags.length === 0) counts.clean += 1;

    rows.push(r);
  }

  return { counts, samples, rows, verdict: verdict(counts) };
}

/**
 * A plain answer to "is this list safe to import?".
 *
 * The threshold is deliberately conservative. SES reviews an account at 5%
 * bounces; a list where 5% of addresses are already visibly wrong will land
 * well past that once the invisible ones bounce too.
 */
function verdict(c) {
  if (c.total === 0) return { level: 'empty', message: 'Nothing to import.' };

  const badShare = ((c.malformed + c.disposable) / c.total) * 100;
  const typoShare = (c.likely_typos / c.total) * 100;

  if (badShare >= 5) {
    return {
      level: 'do_not_import',
      message: `${badShare.toFixed(1)}% of this list is malformed or disposable. Importing it risks the sending account for every brand.`,
      action: 'Find out where this list came from before importing any of it.',
    };
  }
  if (badShare >= 2 || typoShare >= 2) {
    return {
      level: 'clean_first',
      message: 'This list has enough visible problems to be worth cleaning first.',
      action: 'Fix the suggested typos, drop the disposable addresses, then import.',
    };
  }
  if (c.role_accounts / c.total >= 0.2) {
    return {
      level: 'check_consent',
      message: `${((c.role_accounts / c.total) * 100).toFixed(0)}% are role accounts (info@, sales@, …).`,
      action: 'These reach shared inboxes and are a common source of complaints. Confirm they opted in.',
    };
  }
  return { level: 'ok', message: 'Nothing obviously wrong with this list.' };
}

export const _internals = { ROLE_PREFIXES, DISPOSABLE, TYPOS };
