/**
 * Reports.
 *
 * Two principles run through all of them.
 *
 * Rates are measured against DELIVERED, not against sent. Against sent, a list
 * full of dead addresses flatters itself: bounce 30% and the open rate still
 * looks respectable because the denominator includes mail nobody could have
 * received.
 *
 * Opens are reported but never optimised on. Apple Mail Privacy Protection
 * pre-fetches images for a large share of readers, which registers as an open
 * whether or not anybody looked. Clicks are the honest number, and every
 * report here says so.
 */

import { query } from '../db.mjs';

const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(2)) : 0);

/* ---------------------------------------------------------- deliverability -- */

/**
 * The report that keeps the sending account alive.
 *
 * SES reviews an account whose bounce rate passes 5% or complaint rate passes
 * 0.1%, and pauses it at 10% / 0.5% — for EVERY brand at once, because the
 * reputation is account-level. So this reports each brand's contribution
 * against those thresholds, with enough warning to act.
 */
export async function deliverabilityHealth({ brandId = null, days = 30 } = {}) {
  const { rows } = await query(
    `select b.id as brand_id, b.name as brand_name,
            count(m.id)::int                                           as sent,
            count(m.id) filter (where m.status = 'delivered')::int      as delivered,
            count(m.id) filter (where m.status = 'bounced')::int        as bounced,
            count(m.id) filter (where m.status = 'complained')::int     as complained,
            count(m.id) filter (where m.status = 'failed')::int         as failed
       from brands b
       left join messages m on m.brand_id = b.id
        and m.sent_at > now() - ($2 || ' days')::interval
      where ($1::uuid is null or b.id = $1)
      group by b.id, b.name
      order by sent desc`,
    [brandId, String(days)],
  );

  const brands = rows.map((r) => {
    // Against sent, not delivered: these are the ratios SES itself measures.
    const bounceRate = pct(r.bounced, r.sent);
    const complaintRate = pct(r.complained, r.sent);
    return {
      ...r,
      rates: { bounce: bounceRate, complaint: complaintRate, delivered: pct(r.delivered, r.sent) },
      status: verdict(bounceRate, complaintRate, r.sent),
    };
  });

  const totals = rows.reduce((acc, r) => ({
    sent: acc.sent + r.sent,
    bounced: acc.bounced + r.bounced,
    complained: acc.complained + r.complained,
  }), { sent: 0, bounced: 0, complained: 0 });

  return {
    window_days: days,
    brands,
    account: {
      ...totals,
      rates: {
        bounce: pct(totals.bounced, totals.sent),
        complaint: pct(totals.complained, totals.sent),
      },
      status: verdict(pct(totals.bounced, totals.sent), pct(totals.complained, totals.sent), totals.sent),
      thresholds: {
        bounce: { review: 5, pause: 10 },
        complaint: { review: 0.1, pause: 0.5 },
        note: 'SES thresholds. They apply to the whole account, so one brand can pause sending for all of them.',
      },
    },
  };
}

function verdict(bounceRate, complaintRate, sent) {
  // Below a few hundred sends the ratios are noise: one bounce in fifty is 2%.
  if (sent < 200) return { level: 'insufficient_data', message: 'Too few sends yet to judge.' };
  if (bounceRate >= 10 || complaintRate >= 0.5) {
    return { level: 'critical', message: 'At or past the level where SES pauses sending. Stop and fix the list now.' };
  }
  if (bounceRate >= 5 || complaintRate >= 0.1) {
    return { level: 'at_risk', message: 'Past the level where SES starts reviewing accounts. Pause imports and clean the list.' };
  }
  if (bounceRate >= 2 || complaintRate >= 0.05) {
    return { level: 'watch', message: 'Rising. Worth looking at where these contacts came from.' };
  }
  return { level: 'healthy', message: 'Comfortably inside the thresholds.' };
}

/* --------------------------------------------------------------- campaign -- */

export async function campaignReport(campaignId) {
  const { rows: counts } = await query(
    `select count(*)::int                                               as recipients,
            count(*) filter (where status in ('sent','delivered','bounced','complained'))::int as sent,
            count(*) filter (where status = 'delivered')::int            as delivered,
            count(*) filter (where status = 'bounced')::int              as bounced,
            count(*) filter (where status = 'complained')::int           as complained,
            count(*) filter (where status = 'failed')::int               as failed,
            count(*) filter (where status = 'skipped')::int              as skipped,
            count(*) filter (where status in ('queued','sending'))::int  as pending
       from messages where campaign_id = $1`,
    [campaignId],
  );

  // Unique people, not raw events: one reader opening five times is one open.
  const { rows: engagement } = await query(
    `select count(distinct e.message_id) filter (where e.type = 'open')::int        as opened,
            count(distinct e.message_id) filter (where e.type = 'click')::int       as clicked,
            count(distinct e.message_id) filter (where e.type = 'unsubscribe')::int as unsubscribed,
            count(*) filter (where e.type = 'click')::int                           as total_clicks
       from message_events e join messages m on m.id = e.message_id
      where m.campaign_id = $1`,
    [campaignId],
  );

  const c = counts[0];
  const e = engagement[0];

  return {
    counts: { ...c, ...e },
    rates: {
      delivered: pct(c.delivered, c.sent),
      bounced: pct(c.bounced, c.sent),
      complained: pct(c.complained, c.delivered),
      opened: pct(e.opened, c.delivered),
      clicked: pct(e.clicked, c.delivered),
      // The number worth optimising: of the people who opened, how many acted.
      click_to_open: pct(e.clicked, e.opened),
      unsubscribed: pct(e.unsubscribed, c.delivered),
    },
    note: 'Open rates are inflated by Apple Mail Privacy Protection pre-fetching images. Judge a campaign on clicks.',
  };
}

/** Which links people actually clicked — usually the surprise in any report. */
export async function linkReport(campaignId, { limit = 50 } = {}) {
  const { rows } = await query(
    `select e.url,
            count(*)::int                        as clicks,
            count(distinct e.message_id)::int    as unique_clicks
       from message_events e join messages m on m.id = e.message_id
      where m.campaign_id = $1 and e.type = 'click' and e.url is not null
      group by e.url
      order by unique_clicks desc
      limit $2`,
    [campaignId, Math.min(limit, 200)],
  );

  const total = rows.reduce((n, r) => n + r.unique_clicks, 0);
  return {
    links: rows.map((r) => ({ ...r, share: pct(r.unique_clicks, total) })),
    total_unique_clicks: total,
  };
}

/**
 * Opens and clicks by hour since the send.
 *
 * The shape tells you when to send next: most engagement lands in the first
 * two hours, and a second bump usually marks the time zone you forgot about.
 */
export async function engagementOverTime(campaignId, { hours = 72 } = {}) {
  const { rows } = await query(
    `with sent as (
       select min(sent_at) as t0 from messages where campaign_id = $1
     )
     select floor(extract(epoch from (e.at - sent.t0)) / 3600)::int as hour,
            count(distinct e.message_id) filter (where e.type = 'open')::int  as opens,
            count(distinct e.message_id) filter (where e.type = 'click')::int as clicks
       from message_events e
       join messages m on m.id = e.message_id
       cross join sent
      where m.campaign_id = $1
        and e.at between sent.t0 and sent.t0 + ($2 || ' hours')::interval
      group by hour order by hour`,
    [campaignId, String(hours)],
  );
  return { hours, buckets: rows };
}

/**
 * How each mailbox provider treated the campaign.
 *
 * The most useful deliverability signal there is. Gmail at 12% opens while
 * Outlook sits at 2% is not a content problem — it is an authentication or
 * reputation problem at one provider, and it is invisible in the overall rate.
 */
export async function providerBreakdown(campaignId) {
  const { rows } = await query(
    `select split_part(c.email, '@', 2)                                   as domain,
            count(distinct m.id)::int                                     as sent,
            count(distinct m.id) filter (where m.status = 'delivered')::int as delivered,
            count(distinct m.id) filter (where m.status = 'bounced')::int   as bounced,
            count(distinct e.message_id) filter (where e.type = 'open')::int  as opened,
            count(distinct e.message_id) filter (where e.type = 'click')::int as clicked
       from messages m
       join contacts c on c.id = m.contact_id
       left join message_events e on e.message_id = m.id
      where m.campaign_id = $1
      group by domain
      having count(distinct m.id) >= 5
      order by sent desc limit 25`,
    [campaignId],
  );

  return {
    domains: rows.map((r) => ({
      ...r,
      rates: {
        delivered: pct(r.delivered, r.sent),
        bounced: pct(r.bounced, r.sent),
        opened: pct(r.opened, r.delivered),
        clicked: pct(r.clicked, r.delivered),
      },
    })),
    note: 'Domains with fewer than 5 recipients are omitted — the rates would be noise. A provider well below the others usually means an authentication or reputation problem there, not a content problem.',
  };
}

/** List growth: where subscribers came from, and what it is costing to keep them. */
export async function listGrowth(brandId, { days = 30 } = {}) {
  const { rows: bySource } = await query(
    `select coalesce(source, 'unknown') as source,
            count(*)::int as added,
            count(*) filter (where status = 'subscribed')::int   as still_subscribed,
            count(*) filter (where status = 'unsubscribed')::int as unsubscribed,
            count(*) filter (where status = 'bounced')::int      as bounced
       from contacts
      where brand_id = $1 and created_at > now() - ($2 || ' days')::interval
      group by source order by added desc limit 25`,
    [brandId, String(days)],
  );

  const { rows: totals } = await query(
    `select count(*) filter (where status = 'subscribed')::int as subscribed,
            count(*) filter (where status = 'pending')::int    as pending,
            count(*) filter (where created_at > now() - ($2 || ' days')::interval)::int as added_in_window,
            count(*) filter (where status = 'unsubscribed'
                             and updated_at > now() - ($2 || ' days')::interval)::int as lost_in_window
       from contacts where brand_id = $1`,
    [brandId, String(days)],
  );

  return {
    window_days: days,
    totals: { ...totals[0], net: totals[0].added_in_window - totals[0].lost_in_window },
    // A source with a high bounce rate is a source to stop using: it is
    // spending the account's shared reputation.
    sources: bySource.map((s) => ({
      ...s,
      bounce_rate: pct(s.bounced, s.added),
      retention: pct(s.still_subscribed, s.added),
    })),
  };
}
