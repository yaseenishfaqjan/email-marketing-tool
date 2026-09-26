-- Phase 4: signup forms, the embeddable widget, and double opt-in.
--
-- Double opt-in is the default and it is not decoration. It costs perhaps 20%
-- of raw signups and it is what keeps typo'd and hostile addresses off the
-- list -- and list hygiene is what keeps the SES account alive for every brand
-- at once, because SES reputation is account-level.

alter table forms
  add column status           text not null default 'active'
                              check (status in ('active','disabled')),
  add column headline         text,
  add column description      text,
  add column button_label     text not null default 'Subscribe',
  add column success_message  text not null default 'Thank you — please check your inbox to confirm.',
  add column confirm_subject  text,
  add column confirm_mjml     text,
  add column confirmed_redirect_url text,
  add column theme            jsonb not null default '{}',
  add column updated_at       timestamptz not null default now();

comment on column forms.confirm_mjml is
  'The double opt-in email. Must contain {{confirm_url}}; validated when the form is saved.';

-- --------------------------------------------------------- submissions --

-- One row per time somebody hits Subscribe.
--
-- Kept separate from `contacts` because a submission is a claim, not a fact:
-- anybody can type anybody's address into a form on the open internet. It
-- becomes consent only once the confirmation link is clicked, and this row is
-- the evidence of both halves.
create table form_submissions (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references forms on delete cascade,
  brand_id      uuid not null references brands on delete cascade,
  contact_id    uuid references contacts on delete set null,
  email         citext not null,
  fields        jsonb not null default '{}',
  ip            inet,
  user_agent    text,
  referer       text,
  status        text not null default 'pending'
                check (status in ('pending','confirmed','expired','blocked')),
  confirm_sent_at timestamptz,
  confirmed_at  timestamptz,
  confirmed_ip  inet,
  created_at    timestamptz not null default now()
);

create index form_submissions_form_idx on form_submissions (form_id, created_at desc);
create index form_submissions_email_idx on form_submissions (brand_id, email);
create index form_submissions_status_idx on form_submissions (status, created_at);

-- --------------------------------------------------------------- messages --

-- The confirmation email is a message like any other -- same queue, same rate
-- limit, same tracking -- but it belongs to neither a campaign nor an
-- automation, so the source check gains a third arm.
alter table messages
  add column form_submission_id uuid references form_submissions on delete cascade;

alter table messages drop constraint messages_source_chk;
alter table messages
  add constraint messages_source_chk
  check (campaign_id is not null
      or automation_run_id is not null
      or form_submission_id is not null);

-- One confirmation per submission. A double-clicked Subscribe button must not
-- put two identical emails in somebody's inbox.
create unique index messages_form_submission_idx
  on messages (form_submission_id)
  where form_submission_id is not null;
