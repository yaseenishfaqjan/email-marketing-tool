/**
 * Automations: build them, publish them, watch them.
 *
 * Steps are replaced wholesale rather than patched one at a time. A sequence
 * is a single thing whose order matters — editing step 3 of 5 through a
 * separate endpoint is how you end up with two steps at position 4.
 */

import express from 'express';
import { query, tx } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import { validateSteps, StepError } from '../../automations/steps.mjs';
import { enrol } from '../../automations/enrol.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

const TRIGGERS = ['event', 'tag_added', 'subscribed', 'manual'];

router.get('/automations', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select a.*,
              (select count(*)::int from automation_steps s where s.automation_id = a.id) as step_count,
              (select count(*)::int from automation_runs r
                where r.automation_id = a.id and r.status = 'active') as active_runs
         from automations a
        where a.brand_id = $1
        order by a.created_at desc`,
      [req.brandId],
    );
    res.json({ automations: rows });
  } catch (err) { next(err); }
});

router.post('/automations', async (req, res, next) => {
  const { name, description = null, trigger_type, trigger_config = {}, steps,
          re_entry = false, re_entry_cooldown_hours = 24 } = req.body ?? {};

  if (!name) return res.status(400).json({ error: 'A name is required.' });
  if (!TRIGGERS.includes(trigger_type)) {
    return res.status(400).json({ error: `trigger_type must be one of: ${TRIGGERS.join(', ')}.` });
  }
  if (trigger_type === 'event' && !trigger_config?.event) {
    return res.status(400).json({ error: 'An event trigger needs trigger_config.event.' });
  }
  if (trigger_type === 'tag_added' && !trigger_config?.tag) {
    return res.status(400).json({ error: 'A tag_added trigger needs trigger_config.tag.' });
  }

  try {
    validateSteps(steps);

    const automation = await tx(async (client) => {
      const { rows } = await client.query(
        `insert into automations (brand_id, name, description, trigger_type, trigger_config,
                                  re_entry, re_entry_cooldown_hours)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.brandId, name, description, trigger_type, JSON.stringify(trigger_config),
         Boolean(re_entry), Number(re_entry_cooldown_hours) || 24],
      );
      await insertSteps(client, rows[0].id, steps);
      return rows[0];
    });

    res.status(201).json({ automation });
  } catch (err) {
    if (err instanceof StepError) return res.status(400).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'An automation with that name already exists.' });
    next(err);
  }
});

async function insertSteps(client, automationId, steps) {
  await client.query('delete from automation_steps where automation_id = $1', [automationId]);
  for (const [position, step] of steps.entries()) {
    await client.query(
      `insert into automation_steps (automation_id, position, name, type, config)
       values ($1,$2,$3,$4,$5)`,
      [automationId, position, step.name ?? null, step.type, JSON.stringify(step.config ?? {})],
    );
  }
}

router.get('/automations/:id', async (req, res, next) => {
  try {
    const { rows } = await query('select * from automations where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: steps } = await query(
      'select * from automation_steps where automation_id = $1 order by position', [req.params.id]);
    res.json({ automation: rows[0], steps });
  } catch (err) { next(err); }
});

router.put('/automations/:id/steps', async (req, res, next) => {
  try {
    validateSteps(req.body?.steps);
    const { rows } = await query('select id from automations where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    await tx((client) => insertSteps(client, req.params.id, req.body.steps));

    const { rows: steps } = await query(
      'select * from automation_steps where automation_id = $1 order by position', [req.params.id]);
    res.json({ steps });
  } catch (err) {
    if (err instanceof StepError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * Publishing is separate from saving on purpose: a half-written sequence must
 * never start mailing people because somebody hit save.
 *
 * Pausing does NOT cancel the people already in it — the author is usually
 * mid-edit. Their runs hold, and resume when the automation goes active again.
 */
router.post('/automations/:id/:action(activate|pause)', async (req, res, next) => {
  const status = req.params.action === 'activate' ? 'active' : 'paused';
  try {
    if (status === 'active') {
      const { rows: steps } = await query(
        'select count(*)::int as n from automation_steps where automation_id = $1', [req.params.id]);
      if (steps[0].n === 0) {
        return res.status(400).json({ error: 'An automation needs at least one step before it can go live.' });
      }
    }
    const { rows } = await query(
      'update automations set status = $3, updated_at = now() where id = $1 and brand_id = $2 returning *',
      [req.params.id, req.brandId, status],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ automation: rows[0] });
  } catch (err) { next(err); }
});

/** Put one contact in by hand — for a manual trigger, or for testing a sequence. */
router.post('/automations/:id/enrol', async (req, res, next) => {
  try {
    const { rows } = await query('select * from automations where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    let contactId = req.body?.contact_id;
    if (!contactId && req.body?.email) {
      const { rows: c } = await query('select id from contacts where brand_id = $1 and email = $2',
        [req.brandId, String(req.body.email).trim().toLowerCase()]);
      if (!c[0]) return res.status(404).json({ error: 'No such contact.' });
      contactId = c[0].id;
    }
    if (!contactId) return res.status(400).json({ error: 'A contact_id or email is required.' });

    res.json(await enrol({ automation: rows[0], contactId, context: { manual: true } }));
  } catch (err) { next(err); }
});

/** Who is in it, how far they got, and what it has actually sent. */
router.get('/automations/:id/stats', async (req, res, next) => {
  try {
    const { rows: owned } = await query('select id from automations where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!owned[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: runs } = await query(
      `select count(*)::int as total,
              count(*) filter (where status = 'active')::int    as active,
              count(*) filter (where status = 'completed')::int as completed,
              count(*) filter (where status = 'cancelled')::int as cancelled,
              count(*) filter (where status = 'failed')::int    as failed
         from automation_runs where automation_id = $1`,
      [req.params.id],
    );

    const { rows: byStep } = await query(
      `select s.position, s.type, s.name,
              count(m.id)::int                                      as queued,
              count(m.id) filter (where m.status = 'delivered')::int as delivered,
              count(distinct e.message_id) filter (where e.type = 'open')::int  as opened,
              count(distinct e.message_id) filter (where e.type = 'click')::int as clicked
         from automation_steps s
         left join messages m on m.automation_step_id = s.id
         left join message_events e on e.message_id = m.id
        where s.automation_id = $1
        group by s.id, s.position, s.type, s.name
        order by s.position`,
      [req.params.id],
    );

    res.json({ runs: runs[0], steps: byStep });
  } catch (err) { next(err); }
});

export default router;
