/**
 * Warm-up: where each brand is on the ramp, and the controls for it.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import * as warmup from '../../sending/warmup.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

/** Every brand's position on the ramp — the operational view during a launch. */
router.get('/warmup', async (req, res, next) => {
  try {
    res.json({ brands: await warmup.status(), schedule: warmup.plan() });
  } catch (err) { next(err); }
});

router.get('/warmup/plan', async (req, res, next) => {
  try {
    const { rows } = await query('select warmup_started_at from brands where id = $1', [req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ plan: warmup.plan(rows[0].warmup_started_at) });
  } catch (err) { next(err); }
});

/**
 * Controls, all reversible.
 *
 * `daily_send_cap: 0` pauses a brand's marketing without touching its
 * transactional mail — the thing you want at 2am when a campaign is going
 * wrong and you need it to stop now.
 */
router.patch('/warmup', async (req, res, next) => {
  const body = req.body ?? {};
  const updates = [];
  const values = [];

  if ('daily_send_cap' in body) {
    const cap = body.daily_send_cap;
    if (cap !== null && (!Number.isInteger(cap) || cap < 0)) {
      return res.status(400).json({ error: 'daily_send_cap must be a whole number of emails, or null to follow the schedule.' });
    }
    updates.push('daily_send_cap'); values.push(cap);
  }

  if ('warmup_enabled' in body) {
    updates.push('warmup_enabled'); values.push(Boolean(body.warmup_enabled));
  }

  if ('warmup_started_at' in body) {
    // Restarting the ramp is the right move after a long pause, or after a
    // reputation problem: the domain is effectively unknown again.
    const at = body.warmup_started_at === null ? null : new Date(body.warmup_started_at);
    if (at !== null && Number.isNaN(at.getTime())) {
      return res.status(400).json({ error: 'warmup_started_at must be a timestamp, or null to restart the ramp on the next send.' });
    }
    updates.push('warmup_started_at'); values.push(at);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    const sets = updates.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const { rows } = await query(
      `update brands set ${sets} where id = $1
       returning id, name, warmup_started_at, daily_send_cap, warmup_enabled`,
      [req.brandId, ...values],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const status = (await warmup.status()).find((b) => b.brand_id === req.brandId);
    res.json({ brand: rows[0], status });
  } catch (err) { next(err); }
});

export default router;
