/**
 * The dashboard route.
 *
 * Admin-only and read-only. It answers the three questions somebody has during
 * a launch week — is the account in danger, where is each brand on its ramp,
 * is anything stuck — and nothing else.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin } from '../middleware/auth.mjs';
import { deliverabilityHealth } from '../../reporting/queries.mjs';
import { status as warmupStatus } from '../../sending/warmup.mjs';
import { renderDashboard } from '../dashboard/page.mjs';

const router = express.Router();
router.use(requireAdmin);

/** What is waiting, and how long it has been waiting. */
async function queueDepth() {
  const { rows } = await query(
    `select b.id, b.name,
            count(m.id) filter (where m.status = 'queued')::int  as queued,
            count(m.id) filter (where m.status = 'sending')::int as sending,
            count(m.id) filter (where m.status = 'failed'
                            and m.queued_at > now() - interval '24 hours')::int as failed_24h,
            -- A long wait with nothing sending is the signal that matters: the
            -- brand is capped, or the worker is not running at all.
            extract(epoch from (now() - min(m.queued_at) filter (where m.status = 'queued')))::int / 60
              as oldest_minutes
       from brands b left join messages m on m.brand_id = b.id
      group by b.id, b.name
     having count(m.id) filter (where m.status in ('queued','sending','failed')) > 0
      order by queued desc`,
  );
  return rows.map((r) => ({ ...r, oldest_minutes: r.oldest_minutes === null ? null : Math.round(r.oldest_minutes) }));
}

async function recentCampaigns(limit = 10) {
  const { rows } = await query(
    `select c.id, c.name, c.subject, c.status, b.name as brand_name,
            count(m.id)::int as recipients,
            count(m.id) filter (where m.status = 'delivered')::int as delivered,
            count(distinct e.message_id) filter (where e.type = 'click')::int as clicked
       from campaigns c
       join brands b on b.id = c.brand_id
       left join messages m on m.campaign_id = c.id
       left join message_events e on e.message_id = m.id
      group by c.id, b.name
      order by coalesce(c.sent_at, c.scheduled_at, c.created_at) desc
      limit $1`,
    [limit],
  );

  const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0);
  return rows.map((c) => ({
    ...c,
    delivered_pct: pct(c.delivered, c.recipients),
    // Against delivered, not recipients: a bounce was never a chance to click.
    clicked_pct: pct(c.clicked, c.delivered),
  }));
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const [health, warmup, queues, campaigns] = await Promise.all([
      deliverabilityHealth({ days }),
      warmupStatus(),
      queueDepth(),
      recentCampaigns(),
    ]);

    const data = { health, warmup, queues, campaigns, generatedAt: new Date().toISOString() };
    if (req.query.format === 'json') return res.json(data);

    res.type('html').send(renderDashboard(data));
  } catch (err) { next(err); }
});

export default router;
