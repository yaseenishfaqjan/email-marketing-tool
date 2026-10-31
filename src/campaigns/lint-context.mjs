/**
 * What the linter needs to know about a brand's actual data.
 *
 * Both the API and the admin UI lint before sending, and a check that exists
 * in one place and not the other is worse than no check: it teaches people
 * the warning is optional.
 */

import { query } from '../db.mjs';

/** Attribute keys that really exist, so {{attrs.typo}} can be caught. */
export async function knownAttributes(brandId) {
  const { rows } = await query(
    `select distinct k from contacts c, lateral jsonb_object_keys(c.attrs) k
      where c.brand_id = $1 limit 200`,
    [brandId],
  );
  return rows.map((r) => r.k);
}

/** How many subscribers would read "Hi ," — the number that decides whether
 *  a bare first-name greeting is a problem or a non-issue. */
export async function contactsMissingName(brandId) {
  const { rows } = await query(
    `select count(*)::int as n from contacts
      where brand_id = $1 and status = 'subscribed' and (first_name is null or first_name = '')`,
    [brandId],
  );
  return rows[0].n;
}

/** Both, for the common case. */
export async function lintContext(brandId) {
  return {
    knownAttributes: await knownAttributes(brandId),
    contactsMissingName: await contactsMissingName(brandId),
  };
}
