/**
 * The template library. Admin only, per brand.
 */

import express from 'express';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import * as templates from '../../templates/repo.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

const handle = (res, err, next) => {
  if (err instanceof templates.TemplateError) {
    return res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
  }
  next(err);
};

router.get('/templates', async (req, res, next) => {
  try {
    res.json({ templates: await templates.list(req.brandId, { category: req.query.category ?? null }) });
  } catch (err) { next(err); }
});

router.get('/templates/:id', async (req, res, next) => {
  try {
    const template = await templates.get(req.brandId, req.params.id);
    if (!template) return res.status(404).json({ error: 'Not found' });
    res.json({ template });
  } catch (err) { next(err); }
});

router.post('/templates', async (req, res, next) => {
  try {
    res.status(201).json({ template: await templates.create(req.brandId, req.body) });
  } catch (err) { handle(res, err, next); }
});

/** Copy a starter into the brand's own library, where it can be edited. */
router.post('/templates/:id/copy', async (req, res, next) => {
  try {
    res.status(201).json({ template: await templates.copy(req.brandId, req.params.id, req.body?.name ?? null) });
  } catch (err) { handle(res, err, next); }
});

router.patch('/templates/:id', async (req, res, next) => {
  try {
    res.json({ template: await templates.update(req.brandId, req.params.id, req.body) });
  } catch (err) { handle(res, err, next); }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    const removed = await templates.remove(req.brandId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found, or it is a starter template.' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

export default router;
