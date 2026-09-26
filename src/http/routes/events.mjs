/**
 * POST /v1/events — the bridge between each product and its email.
 *
 * This is the endpoint the whole platform was built for. A product posts what
 * actually happened inside it, and the emails follow from that rather than
 * from a guess:
 *
 *   curl -X POST $BASE/v1/events -H "Authorization: Bearer $BRAND_KEY" \
 *     -H 'Content-Type: application/json' -d '{
 *       "email": "dev@company.com",
 *       "event": "trial_started",
 *       "properties": {"plan": "pro", "seats": 5},
 *       "idempotency_key": "trial-9281"
 *     }'
 *
 * The API key resolves the brand, so a key leaked from one product cannot
 * write events against another's contacts.
 */

import express from 'express';
import { requireApiKey } from '../middleware/auth.mjs';
import { recordEvent, EventError } from '../../events/record.mjs';
import { query } from '../../db.mjs';

const router = express.Router();

router.post('/events', requireApiKey('events'), async (req, res, next) => {
  const body = req.body ?? {};
  const name = body.event ?? body.name;

  try {
    const result = await recordEvent({
      brandId: req.brandId,
      email: body.email,
      name,
      properties: typeof body.properties === 'object' && body.properties ? body.properties : {},
      idempotencyKey: body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null,
      createContact: body.create_contact !== false,
      subscribe: body.subscribe ?? null,
    });

    // A duplicate is a success from the caller's point of view: the event they
    // sent is recorded. Answering 4xx would make well-behaved clients retry
    // forever.
    res.status(result.recorded ? 201 : 200).json(result);
  } catch (err) {
    if (err instanceof EventError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/** Several events in one call, for a product catching up after downtime. */
router.post('/events/batch', requireApiKey('events'), async (req, res, next) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!events) return res.status(400).json({ error: 'Send {"events": [...]}.' });
  if (events.length > 500) return res.status(400).json({ error: 'At most 500 events per batch.' });

  const results = [];
  for (const [i, event] of events.entries()) {
    try {
      results.push({
        index: i,
        ...await recordEvent({
          brandId: req.brandId,
          email: event.email,
          name: event.event ?? event.name,
          properties: event.properties ?? {},
          idempotencyKey: event.idempotency_key ? String(event.idempotency_key).slice(0, 200) : null,
          createContact: event.create_contact !== false,
          subscribe: event.subscribe ?? null,
        }),
      });
    } catch (err) {
      // One bad row must not discard the other 499. Report it and carry on.
      results.push({ index: i, recorded: false, error: err.message });
    }
  }
  res.json({ results });
});

/** What a contact has done — the audit trail behind "why did they get this?". */
router.get('/events', requireApiKey('events'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `select e.id, e.name, e.properties, e.at, c.email
         from events e join contacts c on c.id = e.contact_id
        where e.brand_id = $1
          and ($2::text is null or c.email = $2)
          and ($3::text is null or e.name = $3)
        order by e.at desc limit $4`,
      [req.brandId, req.query.email ?? null, req.query.event ?? null,
       Math.min(Number(req.query.limit) || 50, 500)],
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

export default router;
