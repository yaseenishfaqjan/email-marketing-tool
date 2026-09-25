/**
 * CSV import.
 *
 * Imports are where lists get poisoned, so this is strict on purpose:
 *
 *  - Rows that are not valid addresses are reported, not guessed at.
 *  - Addresses already suppressed are skipped and counted. Re-adding somebody
 *    who complained or hard-bounced is how an SES account gets paused, and the
 *    account is shared by every brand.
 *  - An existing unsubscribed contact is never flipped back to subscribed.
 *
 * Callers get a per-row report rather than a single success/failure, because
 * "4,812 imported, 26 skipped, 3 invalid" is the only outcome anybody can act
 * on.
 */

import { parse } from 'csv-parse/sync';
import { tx } from '../db.mjs';
import { isValidEmail, normaliseEmail, upsert } from './repo.mjs';

const ALIASES = {
  email: ['email', 'email_address', 'e-mail', 'mail'],
  first_name: ['first_name', 'firstname', 'first', 'given_name', 'fname'],
  last_name: ['last_name', 'lastname', 'last', 'surname', 'family_name', 'lname'],
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(key)) map[field] = i;
    }
    if (map.email === undefined && key === 'email') map.email = i;
  });
  return map;
}

/**
 * @param {string} csvText
 * @param {{brandId: string, source: string, consentSource?: string}} opts
 */
export async function importCsv(csvText, { brandId, source, consentSource = null }) {
  const records = parse(csvText, { skip_empty_lines: true, relax_column_count: true, bom: true });
  if (records.length === 0) return { imported: 0, updated: 0, skipped: 0, invalid: [], total: 0 };

  const headerMap = mapHeaders(records[0]);
  if (headerMap.email === undefined) {
    throw new Error('No email column found. The header row needs a column called "email".');
  }

  const rows = records.slice(1);
  const report = { imported: 0, updated: 0, skipped: 0, invalid: [], total: rows.length };

  // Extra columns become attrs, so a CSV carrying "plan" or "company" is not
  // silently thrown away.
  const extraColumns = records[0]
    .map((h, i) => ({ name: String(h).trim().toLowerCase().replace(/\s+/g, '_'), i }))
    .filter(({ i }) => !Object.values(headerMap).includes(i))
    .filter(({ name }) => name && name.length <= 64);

  await tx(async (client) => {
    for (const [index, row] of rows.entries()) {
      const rawEmail = row[headerMap.email];
      if (!isValidEmail(rawEmail)) {
        if (report.invalid.length < 100) {
          report.invalid.push({ line: index + 2, value: String(rawEmail ?? '').slice(0, 120) });
        }
        continue;
      }
      const email = normaliseEmail(rawEmail);

      // Suppressed addresses never re-enter the list, whatever the CSV says.
      const { rows: sup } = await client.query(
        `select 1 from suppressions
          where email = $2 and (brand_id is null or brand_id = $1) limit 1`,
        [brandId, email],
      );
      if (sup.length) {
        report.skipped += 1;
        continue;
      }

      const attrs = {};
      for (const { name, i } of extraColumns) {
        const v = row[i];
        if (v !== undefined && v !== '') attrs[name] = String(v).slice(0, 500);
      }

      const contact = await upsert(
        brandId,
        {
          email,
          first_name: headerMap.first_name !== undefined ? row[headerMap.first_name] || null : null,
          last_name: headerMap.last_name !== undefined ? row[headerMap.last_name] || null : null,
          status: 'subscribed',
          source,
          consent_source: consentSource,
          attrs,
        },
        client,
      );

      if (contact.created) report.imported += 1;
      else report.updated += 1;
    }
  });

  return report;
}
