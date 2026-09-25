/**
 * Campaigns: draft, test, schedule, send, report.
 *
 * Sending is two steps on purpose — materialise, then drain — and the API
 * exposes them that way. `POST /send` returns as soon as the recipient rows
 * exist, because a request that waits for 50,000 emails to leave is a request
 * that times out halfway and leaves nobody able to say what happened.
 */

import express from 'express';
import { query } from '../../db.mjs';
import { requireAdmin, resolveBrand } from '../middleware/auth.mjs';
import { materialiseCampaign, CampaignStateError } from '../../campaigns/materialise.mjs';
import { compileTemplate, renderMessage } from '../../sending/renderer.mjs';
import { buildMime } from '../../sending/mime.mjs';
import { sendRaw } from '../../sending/ses.mjs';

const router = express.Router({ mergeParams: true });
router.use(requireAdmin, resolveBrand);

router.get('/campaigns', async (req, res) => {
  const { rows } = await query(
    `select id, name, subject, status, scheduled_at, sent_at, stats, created_at
       from campaigns where brand_id = $1 order by created_at desc limit 100`,
    [req.brandId],
  );
  res.json({ campaigns: rows });
});

router.post('/campaigns', async (req, res, next) => {
  const { name, subject, mjml, preheader = null, segment_id = null } = req.body ?? {};
  if (!name || !subject || !mjml) {
    return res.status(400).json({ error: 'name, subject and mjml are required.' });
  }
  try {
    const { rows } = await query(
      `insert into campaigns (brand_id, name, subject, preheader, mjml, segment_id)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.brandId, name, subject, preheader, mjml, segment_id],
    );
    res.status(201).json({ campaign: rows[0] });
  } catch (err) { next(err); }
});

router.get('/campaigns/:id', async (req, res) => {
  const { rows } = await query('select * from campaigns where id = $1 and brand_id = $2',
    [req.params.id, req.brandId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ campaign: rows[0] });
});

router.patch('/campaigns/:id', async (req, res, next) => {
  const allowed = ['name', 'subject', 'preheader', 'mjml', 'segment_id', 'scheduled_at'];
  const updates = Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

  const sets = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
  try {
    const { rows } = await query(
      `update campaigns set ${sets}, updated_at = now()
        where id = $1 and brand_id = $2 and status in ('draft','scheduled','paused')
        returning *`,
      [req.params.id, req.brandId, ...updates.map(([, v]) => v)],
    );
    if (!rows[0]) {
      return res.status(409).json({ error: 'Only a draft, scheduled or paused campaign can be edited.' });
    }
    res.json({ campaign: rows[0] });
  } catch (err) { next(err); }
});

/**
 * Send one copy to a named address, rendered exactly as a recipient would get
 * it — merge fields, footer, tracking links and all.
 *
 * It does not use the campaign's segment and writes no message row, so it can
 * be run as many times as it takes to get the thing right.
 */
router.post('/campaigns/:id/test', async (req, res, next) => {
  const to = req.body?.to;
  if (!to) return res.status(400).json({ error: 'A "to" address is required.' });

  try {
    const { rows } = await query(
      `select c.*, b.from_name, b.from_email, b.reply_to, b.postal_address,
              b.tracking_domain, b.ses_config_set, b.sending_domain
         from campaigns c join brands b on b.id = c.brand_id
        where c.id = $1 and c.brand_id = $2`,
      [req.params.id, req.brandId],
    );
    const campaign = rows[0];
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const fakeContact = {
      id: '00000000-0000-0000-0000-000000000000',
      email: to,
      first_name: req.body?.first_name ?? 'there',
      last_name: req.body?.last_name ?? '',
      attrs: req.body?.attrs ?? {},
    };
    // A zero uuid as the message id keeps the tracking links syntactically
    // valid while pointing at a row that does not exist, so a test send never
    // pollutes a campaign's statistics.
    const rendered = renderMessage({
      brand: campaign,
      contact: fakeContact,
      messageId: '00000000-0000-0000-0000-000000000000',
      subject: `[TEST] ${campaign.subject}`,
      compiledHtml: compileTemplate(campaign.mjml),
    });

    const { messageId } = await sendRaw({
      raw: buildMime({
        fromName: campaign.from_name,
        fromEmail: campaign.from_email,
        to,
        replyTo: campaign.reply_to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        unsubscribeUrl: rendered.unsubscribeUrl,
      }),
      from: campaign.from_email,
      to,
      configurationSet: campaign.ses_config_set,
    });
    res.json({ sent: true, sesMessageId: messageId });
  } catch (err) { next(err); }
});

/** Materialise now. The worker drains the queue. */
router.post('/campaigns/:id/send', async (req, res, next) => {
  try {
    const { rows } = await query('select id from campaigns where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const { recipients } = await materialiseCampaign(req.params.id);
    res.json({ recipients, status: recipients > 0 ? 'sending' : 'sent' });
  } catch (err) {
    if (err instanceof CampaignStateError) return res.status(409).json({ error: err.message });
    next(err);
  }
});

router.post('/campaigns/:id/schedule', async (req, res, next) => {
  const at = new Date(req.body?.at ?? '');
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'A valid "at" timestamp is required.' });
  if (at.getTime() < Date.now()) return res.status(400).json({ error: 'That time is in the past.' });

  try {
    const { rows } = await query(
      `update campaigns set status = 'scheduled', scheduled_at = $3, updated_at = now()
        where id = $1 and brand_id = $2 and status in ('draft','scheduled','paused') returning *`,
      [req.params.id, req.brandId, at.toISOString()],
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only a draft or paused campaign can be scheduled.' });
    res.json({ campaign: rows[0] });
  } catch (err) { next(err); }
});

/**
 * Pause stops what has not gone yet. It cannot recall what has — there is no
 * such thing — so the response says how many already left.
 */
router.post('/campaigns/:id/pause', async (req, res, next) => {
  try {
    const { rows } = await query(
      `update messages set status = 'skipped', error = 'campaign paused'
        where campaign_id = $1 and status = 'queued' returning id`,
      [req.params.id],
    );
    await query(
      `update campaigns set status = 'paused', updated_at = now()
        where id = $1 and brand_id = $2 and status in ('sending','scheduled')`,
      [req.params.id, req.brandId],
    );
    const { rows: sent } = await query(
      `select count(*)::int as n from messages
        where campaign_id = $1 and status in ('sent','delivered','bounced','complained')`,
      [req.params.id],
    );
    res.json({ paused: rows.length, alreadySent: sent[0].n });
  } catch (err) { next(err); }
});

/** What actually happened. Deliverability first, engagement second. */
router.get('/campaigns/:id/stats', async (req, res, next) => {
  try {
    const { rows: owned } = await query('select id from campaigns where id = $1 and brand_id = $2',
      [req.params.id, req.brandId]);
    if (!owned[0]) return res.status(404).json({ error: 'Not found' });

    const { rows } = await query(
      `select
         count(*)::int                                                as recipients,
         count(*) filter (where status in ('sent','delivered','bounced','complained'))::int as sent,
         count(*) filter (where status = 'delivered')::int            as delivered,
         count(*) filter (where status = 'bounced')::int              as bounced,
         count(*) filter (where status = 'complained')::int           as complained,
         count(*) filter (where status = 'failed')::int               as failed,
         count(*) filter (where status = 'skipped')::int              as skipped,
         count(*) filter (where status in ('queued','sending'))::int  as pending
       from messages where campaign_id = $1`,
      [req.params.id],
    );

    // Unique people, not raw events: one reader opening five times is one open.
    const { rows: engagement } = await query(
      `select
         count(distinct e.message_id) filter (where e.type = 'open')::int  as opened,
         count(distinct e.message_id) filter (where e.type = 'click')::int as clicked,
         count(distinct e.message_id) filter (where e.type = 'unsubscribe')::int as unsubscribed
       from message_events e join messages m on m.id = e.message_id
      where m.campaign_id = $1`,
      [req.params.id],
    );

    const s = { ...rows[0], ...engagement[0] };
    const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : 0);

    res.json({
      counts: s,
      rates: {
        // Rates are against DELIVERED, not sent. Against sent they flatter a
        // bad list, which is the opposite of what these numbers are for.
        delivered: pct(s.delivered, s.sent),
        bounced: pct(s.bounced, s.sent),
        complained: pct(s.complained, s.delivered),
        opened: pct(s.opened, s.delivered),
        clicked: pct(s.clicked, s.delivered),
        unsubscribed: pct(s.unsubscribed, s.delivered),
      },
      note: 'Open rates are inflated by Apple Mail Privacy Protection pre-fetching images. Optimise on clicks.',
    });
  } catch (err) { next(err); }
});

export default router;
