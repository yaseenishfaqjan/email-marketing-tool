-- Phase 1 schema.
--
-- Everything is scoped by brand_id. There is no cross-brand query anywhere in
-- the application, and the repository layer takes brand_id as its first
-- argument so that a leak needs a deliberate act rather than a forgotten
-- WHERE clause.

create extension if not exists citext;

-- ------------------------------------------------------------------ brands --

create table brands (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  from_name       text not null,
  from_email      citext not null,
  reply_to        citext,
  sending_domain  text not null,
  tracking_domain text,
  ses_config_set  text,
  postal_address  text not null,
  timezone        text not null default 'UTC',
  created_at      timestamptz not null default now()
);

comment on column brands.postal_address is
  'CAN-SPAM requires a physical address in every marketing email. Rendered into every footer.';
comment on column brands.tracking_domain is
  'Brand-owned CNAME for open/click/unsubscribe links. Falls back to PUBLIC_URL when null.';

-- ---------------------------------------------------------------- contacts --

create table contacts (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references brands on delete cascade,
  email          citext not null,
  first_name     text,
  last_name      text,
  status         text not null default 'subscribed'
                 check (status in ('subscribed','pending','unsubscribed','bounced','complained')),
  source         text,
  consent_at     timestamptz,
  consent_ip     inet,
  consent_source text,
  attrs          jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (brand_id, email)
);

create index contacts_brand_status_idx on contacts (brand_id, status);
create index contacts_attrs_idx on contacts using gin (attrs);

comment on column contacts.consent_source is
  'What the person actually agreed to. Under GDPR, consent you cannot evidence is consent you do not have.';

-- -------------------------------------------------------------------- tags --

create table tags (
  id       uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name     text not null,
  unique (brand_id, name)
);

create table contact_tags (
  contact_id uuid not null references contacts on delete cascade,
  tag_id     uuid not null references tags on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create index contact_tags_tag_idx on contact_tags (tag_id);

-- ---------------------------------------------------------------- segments --

-- A stored filter compiled to SQL at send time, never a frozen list of ids.
create table segments (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid not null references brands on delete cascade,
  name       text not null,
  definition jsonb not null default '{"match":"all","rules":[]}',
  created_at timestamptz not null default now(),
  unique (brand_id, name)
);

-- --------------------------------------------------------------- campaigns --

create table campaigns (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brands on delete cascade,
  name         text not null,
  subject      text not null,
  preheader    text,
  mjml         text not null,
  segment_id   uuid references segments on delete set null,
  status       text not null default 'draft'
               check (status in ('draft','scheduled','materialising','sending','sent','paused','failed')),
  scheduled_at timestamptz,
  started_at   timestamptz,
  sent_at      timestamptz,
  stats        jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index campaigns_due_idx on campaigns (scheduled_at)
  where status = 'scheduled';

-- ---------------------------------------------------------------- messages --

-- One row per person per send, written BEFORE anything is handed to SES.
--
-- This table is both the outbox and the idempotency record. A worker that
-- looped over contacts in memory and called SES would, the first time it died
-- at 40%, either stop or start again from the top -- and you cannot un-send
-- the duplicates. The unique constraint makes the retry safe.
create table messages (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references brands on delete cascade,
  contact_id     uuid not null references contacts on delete cascade,
  campaign_id    uuid references campaigns on delete cascade,
  status         text not null default 'queued'
                 check (status in ('queued','sending','sent','delivered','bounced',
                                   'complained','failed','skipped')),
  attempts       int not null default 0,
  ses_message_id text,
  error          text,
  queued_at      timestamptz not null default now(),
  locked_at      timestamptz,
  sent_at        timestamptz,
  unique (campaign_id, contact_id)
);

-- The send worker's whole working set: partial index, so it stays small no
-- matter how many million messages have already been sent.
create index messages_queued_idx on messages (queued_at)
  where status = 'queued';
create index messages_campaign_status_idx on messages (campaign_id, status);
create unique index messages_ses_id_idx on messages (ses_message_id)
  where ses_message_id is not null;

-- Append-only. Opens and clicks are many-per-message; never overwrite a
-- timestamp column and lose the second one.
create table message_events (
  id         bigserial primary key,
  message_id uuid not null references messages on delete cascade,
  type       text not null
             check (type in ('sent','delivered','open','click','bounce','complaint',
                             'unsubscribe','delivery_delay','reject','failed')),
  url        text,
  at         timestamptz not null default now(),
  meta       jsonb
);

create index message_events_message_idx on message_events (message_id, type);
create index message_events_at_idx on message_events (at);

-- ------------------------------------------------------------ suppressions --

-- brand_id null means global: every brand, no exceptions. Reserved for hard
-- bounces and spam complaints, which are about protecting the sending account
-- rather than about one brand's list.
create table suppressions (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid references brands on delete cascade,
  email      citext not null,
  reason     text not null
             check (reason in ('unsubscribe','hard_bounce','complaint','manual','import')),
  note       text,
  created_at timestamptz not null default now()
);

-- One row per (scope, address). coalesce() gives global rows a stable key that
-- a plain unique constraint cannot, because NULL never equals NULL.
create unique index suppressions_scope_email_idx
  on suppressions (coalesce(brand_id::text, 'global'), email);
create index suppressions_email_idx on suppressions (email);

-- ---------------------------------------------------------------- api keys --

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brands on delete cascade,
  name         text not null,
  key_hash     text not null unique,   -- sha256. The plaintext is shown once, never stored.
  scopes       text[] not null default '{subscribe,events}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------ forms --

create table forms (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brands on delete cascade,
  name            text not null,
  fields          jsonb not null default '[]',
  double_optin    boolean not null default true,
  tag_ids         uuid[] not null default '{}',
  redirect_url    text,
  allowed_origins text[] not null default '{}',
  created_at      timestamptz not null default now()
);

comment on column forms.allowed_origins is
  'CORS allowlist. Without it, any site on the internet can post to this brand''s list.';
