/**
 * Brands and their API keys. Admin only.
 *
 * Adding the fifth business must be a row, not a deployment — that is the
 * whole premise of building one platform instead of five.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin } from '../middleware/auth.mjs';
import { generateApiKey, hashApiKey } from '../../tokens.mjs';

const router = express.Router();
router.use(requireAdmin);

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

router.get('/', async (req, res) => {
  const { rows } = await query('select * from brands order by name');
  res.json({ brands: rows });
});

router.post('/', async (req, res, next) => {
  const b = req.body ?? {};
  const missing = ['slug', 'name', 'from_name', 'from_email', 'sending_domain', 'postal_address']
    .filter((f) => !b[f]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  }
  if (!SLUG.test(b.slug)) {
    return res.status(400).json({ error: 'slug must be lowercase letters, numbers and hyphens.' });
  }

  try {
    const { rows } = await query(
      `insert into brands (slug, name, from_name, from_email, reply_to, sending_domain,
                           tracking_domain, ses_config_set, postal_address, timezone)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [b.slug, b.name, b.from_name, b.from_email, b.reply_to ?? null, b.sending_domain,
       b.tracking_domain ?? null, b.ses_config_set ?? null, b.postal_address, b.timezone ?? 'UTC'],
    );
    res.status(201).json({ brand: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That slug is already in use.' });
    next(err);
  }
});

router.get('/:brandId', async (req, res) => {
  const { rows } = await query('select * from brands where id = $1', [req.params.brandId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ brand: rows[0] });
});

router.patch('/:brandId', async (req, res, next) => {
  const allowed = ['name', 'from_name', 'from_email', 'reply_to', 'sending_domain',
                   'tracking_domain', 'ses_config_set', 'postal_address', 'timezone'];
  const updates = Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

  const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await query(
      `update brands set ${sets} where id = $1 returning *`,
      [req.params.brandId, ...updates.map(([, v]) => v)],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ brand: rows[0] });
  } catch (err) { next(err); }
});

/**
 * Issue an API key. The plaintext is returned exactly once and never stored —
 * only its sha256 goes in the database, so a dump of this table cannot be used
 * to send mail.
 */
router.post('/:brandId/keys', async (req, res, next) => {
  try {
    const { rows: brands } = await query('select slug from brands where id = $1', [req.params.brandId]);
    if (!brands[0]) return res.status(404).json({ error: 'Not found' });

    const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
      ? req.body.scopes.filter((s) => ['subscribe', 'events', 'send'].includes(s))
      : ['subscribe', 'events'];

    const plaintext = generateApiKey(brands[0].slug);
    const { rows } = await query(
      `insert into api_keys (brand_id, name, key_hash, scopes)
       values ($1,$2,$3,$4) returning id, name, scopes, created_at`,
      [req.params.brandId, req.body?.name || 'default', hashApiKey(plaintext), scopes],
    );
    res.status(201).json({
      key: rows[0],
      secret: plaintext,
      warning: 'This is the only time the secret is shown. Store it now.',
    });
  } catch (err) { next(err); }
});

router.delete('/:brandId/keys/:keyId', async (req, res) => {
  const { rowCount } = await query(
    'update api_keys set revoked_at = now() where id = $1 and brand_id = $2 and revoked_at is null',
    [req.params.keyId, req.params.brandId],
  );
  res.json({ revoked: rowCount > 0 });
});

export default router;
