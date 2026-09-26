/**
 * Warm-up enforcement.
 *
 * A new sending domain has no reputation, even on SES's already-warm shared
 * IPs. Mailing a cold list at full volume on day one is the classic way to
 * have an account suspended in week one — and because SES reputation is
 * account-level, that suspension takes all five businesses down together.
 *
 * The ramp therefore lives in code, not in a runbook. A worker cannot forget
 * it, and nobody can skip it at 9pm on a launch day because the numbers looked
 * fine yesterday.
 *
 * Nothing is dropped when a cap is hit: the messages stay queued and go out
 * tomorrow. A send that is a day late is a send; a suspended account is not.
 */

import { query } from '../db.mjs';

/**
 * Days are inclusive and 1-based: the first day of sending is day 1.
 *
 * The shape matters more than the exact numbers. Small and slow while the
 * domain is unknown, doubling roughly every three days once it is not, and
 * always to your most engaged contacts first — which is the campaign's job,
 * not this module's.
 */
export const SCHEDULE = [
  { throughDay: 2, cap: 500 },
  { throughDay: 4, cap: 2_000 },
  { throughDay: 7, cap: 10_000 },
  { throughDay: 10, cap: 25_000 },
  { throughDay: 13, cap: 50_000 },
  { throughDay: 16, cap: 100_000 },
  { throughDay: 20, cap: 250_000 },
];

/** Past the end of the schedule the domain is warm; the SES account limit governs. */
export const WARM = Infinity;

export function capForDay(day) {
  if (!Number.isFinite(day) || day < 1) return SCHEDULE[0].cap;
  for (const step of SCHEDULE) {
    if (day <= step.throughDay) return step.cap;
  }
  return WARM;
}

/** Whole days since the brand's first send, 1-based. */
export function dayOfWarmup(startedAt, now = new Date()) {
  if (!startedAt) return 1;
  const elapsed = now.getTime() - new Date(startedAt).getTime();
  return Math.floor(elapsed / 86_400_000) + 1;
}

/**
 * What this brand may still send today.
 *
 * @returns {{cap: number, sent: number, remaining: number, day: number|null, reason: string}}
 */
export function allowance(brand, sentToday, now = new Date()) {
  // An explicit cap overrides the schedule in both directions — including 0,
  // which pauses a brand's marketing without touching its transactional mail.
  if (brand.daily_send_cap !== null && brand.daily_send_cap !== undefined) {
    return {
      cap: brand.daily_send_cap,
      sent: sentToday,
      remaining: Math.max(0, brand.daily_send_cap - sentToday),
      day: brand.warmup_started_at ? dayOfWarmup(brand.warmup_started_at, now) : null,
      reason: brand.daily_send_cap === 0 ? 'paused by an explicit cap of 0' : 'explicit daily cap',
    };
  }

  if (!brand.warmup_enabled) {
    return { cap: WARM, sent: sentToday, remaining: WARM, day: null, reason: 'warm-up disabled' };
  }

  const day = dayOfWarmup(brand.warmup_started_at, now);
  const cap = capForDay(day);
  return {
    cap,
    sent: sentToday,
    remaining: cap === WARM ? WARM : Math.max(0, cap - sentToday),
    day,
    reason: cap === WARM ? 'warm-up complete' : `warm-up day ${day}`,
  };
}

/* ----------------------------------------------------------- the ledger -- */

/** Today in the brand's own timezone: a "daily cap" that rolls at UTC midnight is nobody's day. */
async function todayFor(brandId) {
  const { rows } = await query(
    `select (now() at time zone coalesce(b.timezone, 'UTC'))::date as day
       from brands b where b.id = $1`,
    [brandId],
  );
  return rows[0]?.day ?? new Date().toISOString().slice(0, 10);
}

export async function sentToday(brandId) {
  const day = await todayFor(brandId);
  const { rows } = await query(
    'select sent from daily_send_counts where brand_id = $1 and day = $2',
    [brandId, day],
  );
  return rows[0]?.sent ?? 0;
}

/**
 * Record sends against today's total, and start the clock on first use.
 *
 * `warmup_started_at` is set on the first send rather than when the brand is
 * created: a brand configured in advance and left for a fortnight would
 * otherwise arrive at day 15 having never sent anything.
 */
export async function recordSends(brandId, count, client = null) {
  if (count <= 0) return;
  const run = client ? client.query.bind(client) : query;
  const day = await todayFor(brandId);

  await run(
    `insert into daily_send_counts (brand_id, day, sent) values ($1,$2,$3)
     on conflict (brand_id, day) do update set sent = daily_send_counts.sent + excluded.sent`,
    [brandId, day, count],
  );

  await run(
    'update brands set warmup_started_at = now() where id = $1 and warmup_started_at is null',
    [brandId],
  );
}

/**
 * How much each brand with queued mail may still send today.
 *
 * Returned per brand rather than as one number, because the whole point is
 * that a big send for one brand must not eat another brand's allowance.
 */
export async function headroom() {
  const { rows } = await query(
    `select b.id, b.name, b.slug, b.timezone, b.warmup_started_at, b.daily_send_cap,
            b.warmup_enabled,
            coalesce(d.sent, 0)::int as sent_today,
            count(m.id) filter (where m.status = 'queued')::int as queued
       from brands b
       left join daily_send_counts d
         on d.brand_id = b.id
        and d.day = (now() at time zone coalesce(b.timezone, 'UTC'))::date
       left join messages m on m.brand_id = b.id and m.status = 'queued'
      group by b.id, d.sent
     having count(m.id) filter (where m.status = 'queued') > 0`,
  );

  return rows.map((b) => {
    const a = allowance(b, b.sent_today);
    return {
      brandId: b.id,
      name: b.name,
      queued: b.queued,
      ...a,
      // Infinity does not survive JSON; the caller wants a number to slice a
      // batch with anyway.
      take: a.remaining === WARM ? b.queued : Math.min(a.remaining, b.queued),
    };
  });
}

/** The warm-up state of every brand, for the dashboard and the reports. */
export async function status() {
  const { rows } = await query(
    `select b.id, b.name, b.slug, b.timezone, b.warmup_started_at, b.daily_send_cap,
            b.warmup_enabled,
            coalesce(d.sent, 0)::int as sent_today
       from brands b
       left join daily_send_counts d
         on d.brand_id = b.id
        and d.day = (now() at time zone coalesce(b.timezone, 'UTC'))::date
      order by b.name`,
  );

  return rows.map((b) => {
    const a = allowance(b, b.sent_today);
    return {
      brand_id: b.id,
      name: b.name,
      slug: b.slug,
      started_at: b.warmup_started_at,
      day: a.day,
      sent_today: a.sent,
      cap: a.cap === WARM ? null : a.cap,
      remaining: a.remaining === WARM ? null : a.remaining,
      reason: a.reason,
      complete: a.cap === WARM,
    };
  });
}

/** The ramp as a plan, for showing somebody what the next fortnight looks like. */
export function plan(startedAt = null) {
  const today = startedAt ? dayOfWarmup(startedAt) : null;
  return SCHEDULE.map((step, i) => {
    const from = i === 0 ? 1 : SCHEDULE[i - 1].throughDay + 1;
    return {
      days: from === step.throughDay ? `${from}` : `${from}–${step.throughDay}`,
      daily_cap: step.cap,
      current: today !== null && today >= from && today <= step.throughDay,
    };
  }).concat([{ days: `${SCHEDULE.at(-1).throughDay + 1}+`, daily_cap: null, current: today !== null && today > SCHEDULE.at(-1).throughDay }]);
}
