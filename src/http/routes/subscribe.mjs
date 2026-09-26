/**
 * The public subscribe endpoint, called by each product's own site or app with
 * that brand's API key.
 *
 * The key resolves the brand, so a compromised LawnPilot key cannot add a
 * contact to Kept Portraits — there is no brand parameter to tamper with.
 */

import express from 'express';
import { requireApiKey } from '../middleware/auth.mjs';
import * as contacts from '../../contacts/repo.mjs';
import * as suppression from '../../suppression/repo.mjs';
import { query } from '../../db.mjs';
import { onSubscribed, onTagAdded } from '../../automations/enrol.mjs';

const router = express.Router();

// A simple per-IP limiter. Not a substitute for a WAF, but it stops the
// obvious: a script pointed at this endpoint filling the list with junk.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
  } else if (++entry.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many requests.' });
  }
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  }
  next();
}

router.post('/subscribe', requireApiKey('subscribe'), rateLimit, async (req, res, next) => {
  const body = req.body ?? {};

  // Honeypot: a field no human fills in. Bots fill every field they find.
  if (body.website || body.url_field) return res.json({ ok: true });

  if (!contacts.isValidEmail(body.email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const email = contacts.normaliseEmail(body.email);

  try {
    if (await suppression.isSuppressed(req.brandId, email)) {
      // Deliberately indistinguishable from success. Telling the caller that
      // an address is suppressed turns this endpoint into a way to test
      // whether somebody complained about a brand.
      return res.json({ ok: true });
    }

    const contact = await contacts.upsert(req.brandId, {
      email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      // Double opt-in lands in Phase 4 with the form builder; until then a
      // caller can ask for 'pending' and confirm the address itself.
      status: body.double_optin ? 'pending' : 'subscribed',
      source: String(body.source ?? 'api').slice(0, 100),
      consent_at: new Date().toISOString(),
      consent_ip: req.ip ?? null,
      consent_source: String(body.consent_source ?? body.source ?? 'api').slice(0, 200),
      attrs: typeof body.attrs === 'object' && body.attrs ? body.attrs : {},
    });

    const tagNames = [];
    if (Array.isArray(body.tags) && body.tags.length) {
      for (const name of body.tags.slice(0, 10)) {
        const tagName = String(name).slice(0, 64);
        const { rows } = await query(
          `insert into tags (brand_id, name) values ($1,$2)
           on conflict (brand_id, name) do update set name = excluded.name returning id`,
          [req.brandId, tagName],
        );
        await contacts.addTag(req.brandId, contact.id, rows[0].id);
        tagNames.push(tagName);
      }
    }

    res.status(201).json({ ok: true, status: contact.status });

    // Answer first, then enrol. A slow automation lookup must never make the
    // signup form on somebody's pricing page feel broken, and the response
    // carries nothing that depends on the outcome.
    if (contact.status === 'subscribed') {
      onSubscribed({ brandId: req.brandId, contactId: contact.id, source: body.source ?? 'api' })
        .catch((err) => console.error('[subscribe] enrolment failed: %s', err.message));
      for (const tagName of tagNames) {
        onTagAdded({ brandId: req.brandId, contactId: contact.id, tagName })
          .catch((err) => console.error('[subscribe] tag enrolment failed: %s', err.message));
      }
    }
  } catch (err) { next(err); }
});

export default router;
