-- Phase 3: automations, and the product events that trigger them.
--
-- This is the part the whole platform exists for. Each product posts its own
-- lifecycle events -- trial_started, trial_expiring, upgraded -- and the emails
-- follow from the product's real state rather than from a guess.

-- ------------------------------------------------------------------ events --

-- Append-only record of what a contact did inside a product.
--
-- It serves three jobs at once: it triggers automations, it answers "has this
-- person done X?" inside a segment, and it is the audit trail when somebody
-- asks why an email went out.
create table events (
  id              bigserial primary key,
  brand_id        uuid not null references brands on delete cascade,
  contact_id      uuid references contacts on delete cascade,
  name            text not null,
  properties      jsonb not null default '{}',
  idempotency_key text,
  at              timestamptz not null default now()
);

create index events_brand_name_at_idx on events (brand_id, name, at desc);
create index events_contact_name_idx on events (contact_id, name);

-- Products retry webhooks. Without this, one network blip turns a single
-- "purchase" into two, and the customer gets the post-purchase sequence twice.
create unique index events_idempotency_idx on events (brand_id, idempotency_key)
  where idempotency_key is not null;

comment on column events.idempotency_key is
  'Caller-supplied de-duplication key. A repeat delivery of the same event is silently ignored.';

-- ------------------------------------------------------------- automations --

create table automations (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references brands on delete cascade,
  name           text not null,
  description    text,
  trigger_type   text not null
                 check (trigger_type in ('event','tag_added','subscribed','manual')),
  trigger_config jsonb not null default '{}',
  status         text not null default 'draft'
                 check (status in ('draft','active','paused')),
  -- Whether somebody who finished may start again. A welcome series must never
  -- repeat; an abandoned-checkout series must.
  re_entry       boolean not null default false,
  re_entry_cooldown_hours int not null default 24,
  stats          jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (brand_id, name)
);

create index automations_trigger_idx on automations (brand_id, trigger_type, status);

create table automation_steps (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations on delete cascade,
  position      int not null,
  name          text,
  type          text not null
                check (type in ('wait','email','condition','add_tag','remove_tag','webhook','exit')),
  config        jsonb not null default '{}',
  unique (automation_id, position)
);

-- The scheduler's entire state: one row per person in flight.
--
-- A row with a next_run_at can be inspected, reported on and rescheduled. A
-- three-day wait parked inside a job queue is invisible and lost on a flush.
create table automation_runs (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations on delete cascade,
  contact_id    uuid not null references contacts on delete cascade,
  current_step  int not null default 0,
  next_run_at   timestamptz not null default now(),
  status        text not null default 'active'
                check (status in ('active','completed','cancelled','failed')),
  run_count     int not null default 1,
  last_error    text,
  context       jsonb not null default '{}',   -- the triggering event's properties
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- The whole scheduler loop reads this index. Partial, so it stays small no
-- matter how many runs have already finished.
create index automation_runs_due_idx on automation_runs (next_run_at)
  where status = 'active';
create index automation_runs_contact_idx on automation_runs (contact_id);

-- Re-entry needs more than one run per contact over time, but never two at
-- once -- otherwise a double-fired event puts somebody through the sequence
-- twice in parallel. A partial unique index says exactly that: one ACTIVE run.
create unique index automation_runs_one_active_idx
  on automation_runs (automation_id, contact_id)
  where status = 'active';

-- ---------------------------------------------------------------- messages --

-- An automation's email is a message like any other: same queue, same
-- suppression checks, same tracking, same worker. It just has a step instead
-- of a campaign.
alter table messages
  add column automation_run_id  uuid references automation_runs  on delete cascade,
  add column automation_step_id uuid references automation_steps on delete set null;

alter table messages
  add constraint messages_source_chk
  check (campaign_id is not null or automation_run_id is not null);

-- The idempotency record for automation sends, mirroring what
-- (campaign_id, contact_id) does for broadcasts: a step that runs twice
-- because the engine died mid-tick cannot send a second copy.
create unique index messages_automation_step_idx
  on messages (automation_run_id, automation_step_id)
  where automation_run_id is not null;
