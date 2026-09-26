/**
 * The template library.
 *
 * Two kinds of row. A STARTER belongs to no brand, is visible to all of them
 * and cannot be edited — copying one produces an ordinary brand-owned
 * template. That keeps the starting points stable while every brand still
 * makes them its own.
 */

import { query } from '../db.mjs';
import { STARTERS } from './starters.mjs';
import { lintCampaign } from '../campaigns/lint.mjs';

export class TemplateError extends Error {}

/** Idempotent: safe to run on every deploy. */
export async function installStarters() {
  let installed = 0;
  for (const t of STARTERS) {
    const { rowCount } = await query(
      `insert into templates (brand_id, name, category, description, subject, preheader, mjml, is_starter)
       values (null,$1,$2,$3,$4,$5,$6,true)
       on conflict (coalesce(brand_id::text, 'starter'), name) do update
         set mjml = excluded.mjml, description = excluded.description,
             subject = excluded.subject, preheader = excluded.preheader,
             updated_at = now()`,
      [t.name, t.category, t.description, t.subject, t.preheader, t.mjml],
    );
    installed += rowCount;
  }
  return installed;
}

/** A brand's own templates, plus the starters everybody sees. */
export async function list(brandId, { category = null } = {}) {
  const { rows } = await query(
    `select id, brand_id, name, category, description, subject, preheader,
            is_starter, created_at, updated_at
       from templates
      where (brand_id = $1 or is_starter)
        and ($2::text is null or category = $2)
      order by is_starter, category, name`,
    [brandId, category],
  );
  return rows;
}

export async function get(brandId, id) {
  const { rows } = await query(
    'select * from templates where id = $1 and (brand_id = $2 or is_starter)',
    [id, brandId],
  );
  return rows[0] ?? null;
}

export async function create(brandId, input) {
  if (!input?.name) throw new TemplateError('A name is required.');
  if (!input?.mjml) throw new TemplateError('An mjml body is required.');

  // The same checks a campaign gets, so a broken template cannot sit in the
  // library waiting to be picked.
  const lint = lintCampaign({ subject: input.subject ?? 'placeholder', mjml: input.mjml });
  const fatal = lint.errors.filter((e) => e.code === 'mjml_invalid');
  if (fatal.length) throw new TemplateError(fatal[0].message);

  try {
    const { rows } = await query(
      `insert into templates (brand_id, name, category, description, subject, preheader, mjml)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [brandId, input.name, input.category ?? 'general', input.description ?? null,
       input.subject ?? null, input.preheader ?? null, input.mjml],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new TemplateError('A template with that name already exists.');
    throw err;
  }
}

/** Copy a starter (or another template) into the brand's own library. */
export async function copy(brandId, sourceId, name = null) {
  const source = await get(brandId, sourceId);
  if (!source) throw new TemplateError('Template not found.');

  const base = name ?? `${source.name} copy`;
  // Find a free name rather than failing on the second copy.
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? base : `${base} ${n + 1}`;
    try {
      return await create(brandId, { ...source, name: candidate });
    } catch (err) {
      if (err instanceof TemplateError && /already exists/.test(err.message)) continue;
      throw err;
    }
  }
  throw new TemplateError('Could not find a free name for the copy.');
}

export async function update(brandId, id, input) {
  const existing = await get(brandId, id);
  if (!existing) throw new TemplateError('Template not found.');
  if (existing.is_starter) {
    throw new TemplateError('Starter templates cannot be edited. Copy it first, then edit the copy.');
  }

  const allowed = ['name', 'category', 'description', 'subject', 'preheader', 'mjml'];
  const updates = Object.entries(input ?? {}).filter(([k]) => allowed.includes(k));
  if (!updates.length) throw new TemplateError('Nothing to update.');

  if (input.mjml) {
    const lint = lintCampaign({ subject: input.subject ?? existing.subject ?? 'placeholder', mjml: input.mjml });
    const fatal = lint.errors.filter((e) => e.code === 'mjml_invalid');
    if (fatal.length) throw new TemplateError(fatal[0].message);
  }

  const sets = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
  const { rows } = await query(
    `update templates set ${sets}, updated_at = now()
      where id = $1 and brand_id = $2 returning *`,
    [id, brandId, ...updates.map(([, v]) => v)],
  );
  return rows[0];
}

export async function remove(brandId, id) {
  const { rowCount } = await query(
    'delete from templates where id = $1 and brand_id = $2 and not is_starter',
    [id, brandId],
  );
  return rowCount > 0;
}
