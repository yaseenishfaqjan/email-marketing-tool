/**
 * Contacts, always scoped by brand.
 *
 * Every function takes brandId first. That is deliberate: it makes an
 * unscoped query impossible to write by accident, because there is no
 * function here that will run without one.
 */

import { query } from '../db.mjs';
import { compileSegment } from '../segments/compile.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Cheap structural check. Real validation is a confirmed opt-in, not a regex. */
export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

export function normaliseEmail(email) {
  return String(email).trim().toLowerCase();
}

export async function getByEmail(brandId, email) {
  const { rows } = await query(
    'select * from contacts where brand_id = $1 and email = $2',
    [brandId, normaliseEmail(email)],
  );
  return rows[0] ?? null;
}

export async function getById(brandId, id) {
  const { rows } = await query('select * from contacts where brand_id = $1 and id = $2', [brandId, id]);
  return rows[0] ?? null;
}

/**
 * Create or update.
 *
 * Re-subscribing someone who previously unsubscribed is NOT done here. An
 * import must never quietly resurrect a person who asked to be left alone —
 * that is the single fastest way to earn spam complaints. The status is only
 * moved forward from 'pending' to 'subscribed'; anything else is left as it is
 * and reported back to the caller.
 */
export async function upsert(brandId, input, client = null) {
  const run = client ? client.query.bind(client) : query;
  const email = normaliseEmail(input.email);

  const { rows } = await run(
    `insert into contacts (brand_id, email, first_name, last_name, status,
                           source, consent_at, consent_ip, consent_source, attrs)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (brand_id, email) do update set
       first_name = coalesce(excluded.first_name, contacts.first_name),
       last_name  = coalesce(excluded.last_name,  contacts.last_name),
       attrs      = contacts.attrs || excluded.attrs,
       status     = case
                      when contacts.status = 'pending' and excluded.status = 'subscribed'
                        then 'subscribed'
                      else contacts.status
                    end,
       consent_at = coalesce(contacts.consent_at, excluded.consent_at),
       updated_at = now()
     returning *, (xmax = 0) as created`,
    [
      brandId,
      email,
      input.first_name ?? null,
      input.last_name ?? null,
      input.status ?? 'subscribed',
      input.source ?? null,
      input.consent_at ?? null,
      input.consent_ip ?? null,
      input.consent_source ?? null,
      JSON.stringify(input.attrs ?? {}),
    ],
  );
  return rows[0];
}

export async function setStatus(brandId, contactId, status, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    'update contacts set status = $3, updated_at = now() where brand_id = $1 and id = $2 returning *',
    [brandId, contactId, status],
  );
  return rows[0] ?? null;
}

export async function list(brandId, { status, search, limit = 50, offset = 0 } = {}) {
  const params = [brandId];
  let where = 'c.brand_id = $1';
  if (status) {
    params.push(status);
    where += ` and c.status = $${params.length}`;
  }
  if (search) {
    params.push(search);
    where += ` and (c.email ilike '%' || $${params.length} || '%'
                 or c.first_name ilike '%' || $${params.length} || '%'
                 or c.last_name  ilike '%' || $${params.length} || '%')`;
  }
  params.push(Math.min(limit, 500), offset);

  const { rows } = await query(
    `select c.* from contacts c where ${where}
      order by c.created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return rows;
}

/** How many contacts a segment currently selects — the number shown before a send. */
export async function countSegment(brandId, definition) {
  const { sql, params } = compileSegment(definition, 2);
  const { rows } = await query(
    `select count(*)::int as n from contacts c
      where c.brand_id = $1 and c.status = 'subscribed' and ${sql}`,
    [brandId, ...params],
  );
  return rows[0].n;
}

export async function addTag(brandId, contactId, tagId) {
  await query(
    `insert into contact_tags (contact_id, tag_id)
     select $2, $3 where exists (select 1 from contacts where id = $2 and brand_id = $1)
                     and exists (select 1 from tags where id = $3 and brand_id = $1)
     on conflict do nothing`,
    [brandId, contactId, tagId],
  );
}
