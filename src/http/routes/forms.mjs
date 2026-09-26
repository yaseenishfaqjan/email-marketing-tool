/**
 * Form management. Admin only, always under a brand.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import * as forms from '../../forms/repo.mjs';
import config from '../../config.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

const EDITABLE = [
  'name', 'fields', 'double_optin', 'redirect_url', 'allowed_origins', 'headline',
  'description', 'button_label', 'success_message', 'confirm_subject', 'confirm_mjml',
  'confirmed_redirect_url', 'theme', 'status', 'tag_ids',
];

router.get('/forms', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select f.*,
              (select count(*)::int from form_submissions s where s.form_id = f.id) as submissions,
              (select count(*)::int from form_submissions s
                where s.form_id = f.id and s.status = 'confirmed') as confirmed
         from forms f where f.brand_id = $1 order by f.created_at desc`,
      [req.brandId],
    );
    res.json({ forms: rows });
  } catch (err) { next(err); }
});

router.post('/forms', async (req, res, next) => {
  const b = req.body ?? {};
  if (!b.name) return res.status(400).json({ error: 'A name is required.' });

  try {
    forms.validateFields(b.fields ?? ['email']);
    forms.validateConfirmTemplate(b.confirm_mjml);

    // An empty allowlist means the form accepts nothing. Say so at creation
    // rather than letting somebody discover it from a silent 403 later.
    const origins = Array.isArray(b.allowed_origins) ? b.allowed_origins : [];
    if (origins.length === 0) {
      return res.status(400).json({
        error: 'allowed_origins is required — list the sites that may post to this form, e.g. ["https://scalaro.io"].',
      });
    }

    const { rows } = await query(
      `insert into forms (brand_id, name, fields, double_optin, redirect_url, allowed_origins,
                          headline, description, button_label, success_message,
                          confirm_subject, confirm_mjml, confirmed_redirect_url, theme, tag_ids)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [
        req.brandId, b.name, JSON.stringify(b.fields ?? ['email']),
        b.double_optin !== false, b.redirect_url ?? null, origins,
        b.headline ?? null, b.description ?? null,
        b.button_label ?? 'Subscribe',
        b.success_message ?? 'Thank you — please check your inbox to confirm.',
        b.confirm_subject ?? forms.DEFAULTS.DEFAULT_CONFIRM_SUBJECT,
        b.confirm_mjml ?? forms.DEFAULTS.DEFAULT_CONFIRM_MJML,
        b.confirmed_redirect_url ?? null,
        JSON.stringify(b.theme ?? {}), b.tag_ids ?? [],
      ],
    );
    res.status(201).json({ form: rows[0], embed: embedSnippet(rows[0]) });
  } catch (err) {
    if (err instanceof forms.FormError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/** The two lines somebody pastes into a site. */
function embedSnippet(form) {
  const base = config.publicUrl;
  return {
    script: `<script src="${base}/f/${form.id}.js" async></script>`,
    container: `<div data-emk-form="${form.id}"></div>`,
    note: 'Drop both on the page. Without the div, the form renders where the script tag sits.',
  };
}

router.get('/forms/:id', async (req, res, next) => {
  try {
    const { rows } = await query('select * from forms where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ form: rows[0], embed: embedSnippet(rows[0]) });
  } catch (err) { next(err); }
});

router.patch('/forms/:id', async (req, res, next) => {
  const updates = Object.entries(req.body ?? {}).filter(([k]) => EDITABLE.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    for (const [key, value] of updates) {
      if (key === 'fields') forms.validateFields(value);
      if (key === 'confirm_mjml') forms.validateConfirmTemplate(value);
      if (key === 'allowed_origins' && (!Array.isArray(value) || value.length === 0)) {
        return res.status(400).json({ error: 'allowed_origins cannot be empty — the form would accept nothing.' });
      }
    }

    const sets = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const values = updates.map(([k, v]) =>
      (['fields', 'theme'].includes(k) ? JSON.stringify(v) : v));

    const { rows } = await query(
      `update forms set ${sets}, updated_at = now() where id = $1 and brand_id = $2 returning *`,
      [req.params.id, req.brandId, ...values],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ form: rows[0], embed: embedSnippet(rows[0]) });
  } catch (err) {
    if (err instanceof forms.FormError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * How the form is actually doing.
 *
 * The number that matters is the confirmation rate. A form collecting plenty
 * of submissions but confirming few of them is usually one whose confirmation
 * email is landing in spam — and that is worth knowing before the list goes
 * quiet, not after.
 */
router.get('/forms/:id/stats', async (req, res, next) => {
  try {
    const { rows: owned } = await query('select id from forms where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!owned[0]) return res.status(404).json({ error: 'Not found' });

    const { rows } = await query(
      `select count(*)::int as submissions,
              count(*) filter (where status = 'confirmed')::int as confirmed,
              count(*) filter (where status = 'pending')::int   as pending,
              count(*) filter (where status = 'expired')::int   as expired,
              count(*) filter (where status = 'blocked')::int   as blocked,
              count(*) filter (where created_at > now() - interval '7 days')::int as last_7_days
         from form_submissions where form_id = $1`,
      [req.params.id],
    );

    const s = rows[0];
    const rate = s.submissions > 0 ? Number(((s.confirmed / s.submissions) * 100).toFixed(1)) : 0;

    res.json({
      counts: s,
      confirmation_rate: rate,
      note: rate > 0 && rate < 40
        ? 'A low confirmation rate usually means the confirmation email is landing in spam. Check DKIM and the sending domain before assuming people changed their minds.'
        : undefined,
    });
  } catch (err) { next(err); }
});

router.get('/forms/:id/submissions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select s.id, s.email, s.status, s.created_at, s.confirmed_at, s.referer
         from form_submissions s join forms f on f.id = s.form_id
        where s.form_id = $1 and f.brand_id = $2
        order by s.created_at desc limit $3`,
      [req.params.id, req.brandId, Math.min(Number(req.query.limit) || 100, 500)],
    );
    res.json({ submissions: rows });
  } catch (err) { next(err); }
});

export default router;
