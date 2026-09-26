/**
 * Reports. Admin only.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import * as reports from '../../reporting/queries.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

const days = (req, fallback = 30) => Math.min(Math.max(Number(req.query.days) || fallback, 1), 365);

const ownsCampaign = async (campaignId, brandId) => {
  const { rows } = await query('select id from campaigns where id = $1 and brand_id = $2',
    [campaignId, brandId]);
  return rows.length > 0;
};

/**
 * The one to look at first, and the one worth a weekly glance even when
 * nothing seems wrong: SES pauses the whole account, not one brand.
 */
router.get('/reports/deliverability', async (req, res, next) => {
  try {
    res.json(await reports.deliverabilityHealth({ brandId: req.brandId, days: days(req) }));
  } catch (err) { next(err); }
});

router.get('/reports/growth', async (req, res, next) => {
  try {
    res.json(await reports.listGrowth(req.brandId, { days: days(req) }));
  } catch (err) { next(err); }
});

router.get('/reports/campaigns/:id', async (req, res, next) => {
  try {
    if (!await ownsCampaign(req.params.id, req.brandId)) return res.status(404).json({ error: 'Not found' });
    res.json(await reports.campaignReport(req.params.id));
  } catch (err) { next(err); }
});

router.get('/reports/campaigns/:id/links', async (req, res, next) => {
  try {
    if (!await ownsCampaign(req.params.id, req.brandId)) return res.status(404).json({ error: 'Not found' });
    res.json(await reports.linkReport(req.params.id, { limit: Number(req.query.limit) || 50 }));
  } catch (err) { next(err); }
});

router.get('/reports/campaigns/:id/timeline', async (req, res, next) => {
  try {
    if (!await ownsCampaign(req.params.id, req.brandId)) return res.status(404).json({ error: 'Not found' });
    res.json(await reports.engagementOverTime(req.params.id, { hours: Number(req.query.hours) || 72 }));
  } catch (err) { next(err); }
});

router.get('/reports/campaigns/:id/providers', async (req, res, next) => {
  try {
    if (!await ownsCampaign(req.params.id, req.brandId)) return res.status(404).json({ error: 'Not found' });
    res.json(await reports.providerBreakdown(req.params.id));
  } catch (err) { next(err); }
});

export default router;
