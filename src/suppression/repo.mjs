/**
 * Suppression: the list of addresses that must not be sent to.
 *
 * Two scopes, and the distinction matters:
 *
 *   brand-scoped (brand_id set)  — an unsubscribe. Leaving LawnPilot's list
 *                                  must not remove somebody from Kept
 *                                  Portraits; they never asked for that.
 *   global (brand_id null)       — a hard bounce or a spam complaint. That is
 *                                  about protecting the sending account, which
 *                                  every brand shares, so it applies to all.
 */

import { query } from '../db.mjs';

export async function suppress({ brandId = null, email, reason, note = null }, client = null) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `insert into suppressions (brand_id, email, reason, note)
     values ($1, $2, $3, $4)
     on conflict (coalesce(brand_id::text, 'global'), email) do nothing`,
    [brandId, email, reason, note],
  );
}

/** True if this address must not receive mail for this brand. */
export async function isSuppressed(brandId, email) {
  const { rows } = await query(
    `select 1 from suppressions
      where email = $2 and (brand_id is null or brand_id = $1)
      limit 1`,
    [brandId, email],
  );
  return rows.length > 0;
}

export async function unsuppress(brandId, email) {
  const { rowCount } = await query(
    `delete from suppressions
      where email = $2 and brand_id is not distinct from $1`,
    [brandId, email],
  );
  return rowCount;
}

export async function list(brandId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `select id, brand_id, email, reason, note, created_at
       from suppressions
      where brand_id is null or brand_id = $1
      order by created_at desc
      limit $2 offset $3`,
    [brandId, Math.min(limit, 1000), offset],
  );
  return rows;
}

/**
 * The SQL fragment used inside the campaign materialiser, where checking
 * row-by-row would mean one round trip per contact.
 */
export const NOT_SUPPRESSED_SQL = `
  not exists (
    select 1 from suppressions s
     where s.email = c.email
       and (s.brand_id is null or s.brand_id = c.brand_id)
  )`;
