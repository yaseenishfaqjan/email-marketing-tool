/**
 * Contacts, segments and suppression. Admin only, always under a brand.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import * as contacts from '../../contacts/repo.mjs';
import { importCsv } from '../../contacts/import.mjs';
import * as suppression from '../../suppression/repo.mjs';
import { compileSegment, SegmentError } from '../../segments/compile.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

/* ------------------------------------------------------------ contacts -- */

router.get('/contacts', async (req, res) => {
  const rows = await contacts.list(req.brandId, {
    status: req.query.status,
    search: req.query.q,
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
  });
  res.json({ contacts: rows });
});

router.post('/contacts', async (req, res, next) => {
  const body = req.body ?? {};
  if (!contacts.isValidEmail(body.email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  try {
    if (await suppression.isSuppressed(req.brandId, contacts.normaliseEmail(body.email))) {
      return res.status(409).json({
        error: 'That address is suppressed. Remove it from the suppression list first, and only if they asked.',
      });
    }
    const contact = await contacts.upsert(req.brandId, {
      ...body,
      consent_at: body.consent_at ?? new Date().toISOString(),
      consent_ip: body.consent_ip ?? null,
      source: body.source ?? 'admin',
    });
    res.status(contact.created ? 201 : 200).json({ contact });
  } catch (err) { next(err); }
});

router.post('/contacts/import', express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }),
  async (req, res, next) => {
    if (!req.body || typeof req.body !== 'string') {
      return res.status(400).json({ error: 'Post the CSV as the request body with Content-Type: text/csv.' });
    }
    try {
      const report = await importCsv(req.body, {
        brandId: req.brandId,
        source: req.query.source ? String(req.query.source).slice(0, 100) : `import:${new Date().toISOString().slice(0, 10)}`,
        consentSource: req.query.consent ? String(req.query.consent).slice(0, 200) : null,
      });
      res.json(report);
    } catch (err) {
      if (err.message.includes('email column')) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

router.post('/contacts/:contactId/unsubscribe', async (req, res, next) => {
  try {
    const contact = await contacts.getById(req.brandId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'Not found' });
    await contacts.setStatus(req.brandId, contact.id, 'unsubscribed');
    await suppression.suppress({ brandId: req.brandId, email: contact.email, reason: 'unsubscribe' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------- suppression -- */

router.get('/suppressions', async (req, res) => {
  res.json({ suppressions: await suppression.list(req.brandId, {
    limit: Number(req.query.limit) || 100,
    offset: Number(req.query.offset) || 0,
  }) });
});

router.post('/suppressions', async (req, res, next) => {
  const { email, reason = 'manual', note = null, global: isGlobal = false } = req.body ?? {};
  if (!contacts.isValidEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  try {
    await suppression.suppress({
      brandId: isGlobal ? null : req.brandId,
      email: contacts.normaliseEmail(email),
      reason, note,
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Removing a suppression is deliberately awkward to do by accident: it takes
 * an explicit confirm, because re-mailing somebody who complained is how an
 * SES account gets paused for every brand at once.
 */
router.delete('/suppressions/:email', async (req, res, next) => {
  if (req.query.confirm !== 'yes') {
    return res.status(400).json({
      error: 'Add ?confirm=yes. Only remove a suppression when the person has asked to be re-added.',
    });
  }
  try {
    const removed = await suppression.unsuppress(req.brandId, contacts.normaliseEmail(req.params.email));
    res.json({ removed });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ segments -- */

router.get('/segments', async (req, res) => {
  const { rows } = await query('select * from segments where brand_id = $1 order by name', [req.brandId]);
  res.json({ segments: rows });
});

router.post('/segments', async (req, res, next) => {
  const { name, definition } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  try {
    compileSegment(definition);   // reject a broken definition now, not at send time
    const { rows } = await query(
      `insert into segments (brand_id, name, definition) values ($1,$2,$3)
       on conflict (brand_id, name) do update set definition = excluded.definition
       returning *`,
      [req.brandId, name, JSON.stringify(definition ?? { match: 'all', rules: [] })],
    );
    res.status(201).json({ segment: rows[0] });
  } catch (err) {
    if (err instanceof SegmentError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/** How many people a segment selects right now — the number shown before a send. */
router.post('/segments/preview', async (req, res, next) => {
  try {
    const count = await contacts.countSegment(req.brandId, req.body?.definition);
    res.json({ count });
  } catch (err) {
    if (err instanceof SegmentError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

export default router;
