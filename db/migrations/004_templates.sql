-- Phase 2: a template library, and the indexes the reports need.

create table templates (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid references brands on delete cascade,
  name        text not null,
  category    text not null default 'general',
  description text,
  subject     text,
  preheader   text,
  mjml        text not null,
  -- A starter template belongs to no brand and cannot be edited. Every brand
  -- sees it; copying one makes an ordinary brand-owned template.
  is_starter  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Starter templates are global (brand_id null); a brand's own names are unique
-- within that brand. coalesce gives the global rows a stable key, since NULL
-- never equals NULL.
create unique index templates_name_idx
  on templates (coalesce(brand_id::text, 'starter'), name);
create index templates_brand_idx on templates (brand_id, category);

alter table campaigns
  add column template_id uuid references templates on delete set null;

-- --------------------------------------------------------------- reports --

-- Click reports group by URL; without this they sequential-scan the events
-- table, which is the largest one here and grows forever.
create index message_events_click_url_idx on message_events (type, url)
  where type = 'click';

-- The time-series and health reports bucket by hour over a date range.
create index message_events_type_at_idx on message_events (type, at desc);

-- The brand health report counts messages by status over a window.
create index messages_brand_sent_idx on messages (brand_id, sent_at desc)
  where sent_at is not null;
