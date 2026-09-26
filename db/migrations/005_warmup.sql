-- Phase 5: warm-up enforcement, and the record of what was sent when.
--
-- The single largest risk to this platform is not a bug. It is sending a cold
-- list too fast in week one and having SES suspend the account -- which takes
-- every brand down at once, and is far harder to undo than to avoid.
--
-- So the ramp is enforced by the code rather than written in a runbook and
-- trusted to somebody's memory at 9pm on a launch day.

alter table brands
  add column warmup_started_at  timestamptz,
  -- A hard ceiling that overrides the schedule, in either direction. Set it
  -- to pause a brand's marketing entirely without touching its transactional
  -- mail: 0 means nothing marketing goes out.
  add column daily_send_cap     int,
  add column warmup_enabled     boolean not null default true;

comment on column brands.warmup_started_at is
  'When this brand first sent. Null means it has not started; the schedule counts days from here.';
comment on column brands.daily_send_cap is
  'Overrides the warm-up schedule. Null follows the schedule; 0 pauses marketing sends.';

-- Counting a day's sends from `messages` is correct but gets slower as the
-- table grows, and the worker asks on every batch. This is the running total,
-- one row per brand per day.
create table daily_send_counts (
  brand_id uuid not null references brands on delete cascade,
  day      date not null,
  sent     int  not null default 0,
  primary key (brand_id, day)
);

create index daily_send_counts_day_idx on daily_send_counts (day desc);
