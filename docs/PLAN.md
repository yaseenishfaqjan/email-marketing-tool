# One Email Platform for All the Businesses

**Date:** 2026-09-25 · **Status:** Phase 1 built and tested; Phases 2–5 pending

> This is the original design. Phase 1 deviates from it in one place: it uses
> no Redis. `messages` is already a durable queue with a partial index, and
> `SKIP LOCKED` already gives safe concurrent claiming, so Redis would have
> been a second moving part holding state Postgres was holding correctly. It
> returns when a second send worker does — see the README.

A single multi-brand email marketing platform, built on Amazon SES, serving Kept Portraits,
LawnPilot, Peach Picks and the other products. Built rather than bought, because the point is to
sell software products whose own signup and trial events need to drive the email — and a rented ESP
can only ever see what you forward to it.

---

## 0. The decision in one paragraph

Build the application; rent the deliverability. Writing an SMTP server and defending your own IP
reputation is a full-time job with no upside. Sending through **Amazon SES** costs $0.10 per 1,000
emails, comes with warmed shared IPs, and hands you bounces and complaints as structured events. At
500,000 sends a month that is **$50**; the same list on Klaviyo or Mailchimp is **$700–1,500 a
month**, and rises with every contact you add. Everything above SES — contacts, segments,
campaigns, automations, forms, tracking, reporting — is yours, with one login across all five
brands and direct access to your own product database.

**The one thing to do today, before any code:** request SES production access. New accounts are
sandboxed to 200 emails a day to verified addresses only, and approval takes 24–48 hours. It is the
only part of this plan you cannot compress.

---

## 1. Scope

| | |
|---|---|
| **Brands** | 4–5, with room for more — adding one must be a database row, not a deployment |
| **Audiences** | Completely separate. A Kept Portraits customer is not a LawnPilot lead |
| **Contacts** | 10k–100k total across brands |
| **Volume** | 100k–500k sends/month |
| **v1 features** | Broadcasts, automations, signup forms and list growth |
| **Deliberately out of v1** | Transactional email — the products keep their own `nodemailer` templates for now (§9) |

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
  5 product sites → │  forms.js  (embed)   POST /v1/subscribe   │
  5 product apps  → │  events API          POST /v1/events      │ ── API key per brand
                    └──────────────────┬───────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────┐
              │  mailer-api  (Node 20 + Express)                  │
              │  contacts · segments · campaigns · automations    │
              └───┬──────────────────────────────┬───────────────┘
                  │                              │
         ┌────────▼────────┐            ┌────────▼─────────┐
         │  PostgreSQL 16  │            │  Redis + BullMQ  │
         │  everything     │            │  job queues      │
         └────────┬────────┘            └────────┬─────────┘
                  │                              │
                  │              ┌───────────────▼────────────────┐
                  │              │  workers                        │
                  │              │  send · automations · imports   │
                  │              └───────────────┬────────────────┘
                  │                              │ SES v2 SendEmail
                  │                     ┌────────▼─────────┐
                  │                     │   Amazon SES     │
                  │                     │  5 config sets   │
                  │                     └────────┬─────────┘
                  │                              │ bounce / complaint / delivery
                  │              ┌───────────────▼────────────────┐
                  └──────────────┤  SNS → POST /webhooks/ses       │
                                 └─────────────────────────────────┘
```

**Stack, and why:**

| Choice | Reason |
|---|---|
| **Node 20 + Express** | Same language and framework as `api/`. One skillset, shared code, no second runtime on the box |
| **PostgreSQL 16** | Segments are queries. JSON attributes, partial indexes, `FOR UPDATE SKIP LOCKED` for the automation scheduler — none of which SQLite or flat files give you at 100k contacts |
| **Redis + BullMQ** | Send batching, retries with backoff, rate limiting against the SES quota, per-brand priority |
| **AWS SES v2** | $0.10/1,000, warmed shared IPs, structured bounce/complaint events, per-brand configuration sets |
| **MJML** | Compiles to the table-based HTML that Outlook actually renders. Do not hand-write email HTML |
| **React admin (Vite) behind nginx** | Internal tool. Matches the existing nginx + Docker deploy pattern exactly |

It runs as two more containers in the existing `docker-compose.yml` — `mailer-api` and
`mailer-worker` — plus Postgres and Redis. The current VPS handles this volume; if it is tight,
Postgres moves to a managed instance for ~$20/month and nothing else changes.

---

## 3. Multi-brand isolation

Audiences are completely separate, so isolation is enforced in three places, not one:

1. **Every table carries `brand_id`.** There is no cross-brand query. Every API route resolves a
   brand from the API key or the session and scopes the query — and a repository layer that takes
   `brand_id` as its first argument, rather than trusting each call site to remember, is what stops
   a leak the day somebody adds a feature in a hurry.
2. **Suppression is per-brand, with a global override.** Unsubscribing from LawnPilot must not
   remove someone from Kept Portraits. But a spam complaint or a hard bounce suppresses that
   address **everywhere**, immediately — that one is about protecting the sending account, not
   about the brand.
3. **Each brand sends from its own domain**, with its own SPF, DKIM, DMARC, MAIL FROM and click
   tracking domain, and its own SES configuration set so reputation metrics are readable per brand.

> **The risk worth understanding before you start:** SES reputation is **account-level**. One brand
> importing a stale list can get sending paused for all five. Configuration sets give you
> per-brand *visibility*, not per-brand *isolation*. Mitigations: double opt-in everywhere, never
> import a purchased or scraped list, and if one product's list is genuinely riskier than the
> others, give it a separate AWS account. Splitting accounts later is easy; recovering a paused one
> is not.

---

## 4. Data model

The core of it. Types are PostgreSQL; `attrs jsonb` carries anything brand-specific so the schema
does not grow a column per product.

```sql
create table brands (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,          -- 'kept', 'lawnpilot', 'peachpicks'
  name            text not null,
  from_name       text not null,
  from_email      text not null,                 -- hello@mail.keptportraits.com
  reply_to        text,
  sending_domain  text not null,                 -- mail.keptportraits.com
  tracking_domain text not null,                 -- links.keptportraits.com
  ses_config_set  text not null,
  postal_address  text not null,                 -- CAN-SPAM requires this in every footer
  timezone        text not null default 'UTC',
  created_at      timestamptz not null default now()
);

create table contacts (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brands on delete cascade,
  email           citext not null,
  first_name      text,
  last_name       text,
  status          text not null default 'subscribed',  -- subscribed|pending|unsubscribed|bounced|complained
  source          text,                                -- 'form:pricing-page', 'import:2026-09', 'api'
  consent_at      timestamptz,
  consent_ip      inet,
  consent_source  text,                                -- what they actually agreed to. GDPR wants this
  attrs           jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (brand_id, email)
);
create index on contacts (brand_id, status);
create index on contacts using gin (attrs);

create table tags (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  unique (brand_id, name)
);
create table contact_tags (
  contact_id uuid references contacts on delete cascade,
  tag_id     uuid references tags on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

-- A segment is a stored filter, compiled to SQL at send time, never a frozen list of ids.
create table segments (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  definition jsonb not null
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  subject text not null,
  preheader text,
  mjml text not null,
  segment_id uuid references segments,
  status text not null default 'draft',   -- draft|scheduled|sending|sent|paused|failed
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per person per send. Written BEFORE sending; this is the idempotency record.
create table messages (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  contact_id uuid not null references contacts on delete cascade,
  campaign_id uuid references campaigns on delete cascade,
  automation_run_id uuid,
  status text not null default 'queued',  -- queued|sent|delivered|bounced|complained|failed|skipped
  ses_message_id text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (campaign_id, contact_id)        -- the same broadcast can never hit someone twice
);
create index on messages (status, queued_at) where status = 'queued';

-- Append-only. Opens and clicks are many-per-message; never overwrite a timestamp column.
create table message_events (
  id bigserial primary key,
  message_id uuid not null references messages on delete cascade,
  type text not null,        -- sent|delivered|open|click|bounce|complaint|unsubscribe|delivery_delay
  url text,
  at timestamptz not null default now(),
  meta jsonb
);
create index on message_events (message_id, type);

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references brands on delete cascade,   -- NULL = global, all brands
  email citext not null,
  reason text not null,      -- unsubscribe|hard_bounce|complaint|manual
  created_at timestamptz not null default now()
);
create unique index on suppressions (coalesce(brand_id::text,'global'), email);

create table automations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  trigger_type text not null,     -- tag_added|form_submitted|event|date_field|manual
  trigger_config jsonb not null,  -- {"event":"trial_started"}
  status text not null default 'draft',
  created_at timestamptz not null default now()
);
create table automation_steps (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations on delete cascade,
  position int not null,
  type text not null,             -- wait|email|condition|add_tag|remove_tag|webhook|exit
  config jsonb not null,
  unique (automation_id, position)
);

-- The scheduler's whole state. One row per person in flight.
create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations on delete cascade,
  contact_id uuid not null references contacts on delete cascade,
  current_step int not null default 0,
  next_run_at timestamptz not null default now(),
  status text not null default 'active',   -- active|completed|cancelled|failed
  started_at timestamptz not null default now(),
  unique (automation_id, contact_id)       -- no double enrolment
);
create index on automation_runs (next_run_at) where status = 'active';

create table forms (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  fields jsonb not null default '[]',
  double_optin boolean not null default true,
  tags uuid[] not null default '{}',
  redirect_url text,
  allowed_origins text[] not null default '{}',   -- CORS allowlist. Without it, anyone can post
  created_at timestamptz not null default now()
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands on delete cascade,
  name text not null,
  key_hash text not null,      -- sha256. The plaintext is shown once and never stored
  scopes text[] not null default '{subscribe,events}',
  last_used_at timestamptz,
  revoked_at timestamptz
);
```

**Why `messages` rows are written before sending:** the unique constraint on
`(campaign_id, contact_id)` is what makes a crashed or retried send safe. A worker that loops over
contacts in memory and calls SES will, the first time it dies at 40%, either stop or start again
from the top — and you cannot un-send the duplicates. Write the rows in one transaction, then
drain them.

---

## 5. The sending pipeline

1. **Schedule.** The campaign moves to `scheduled`; a job is enqueued for `scheduled_at`.
2. **Materialise.** A `campaign.prepare` job compiles the segment to SQL and inserts `messages`
   rows in batches of 5,000 — excluding anyone `unsubscribed`, `bounced`, `complained`, or present
   in the brand's or the global suppression list. Suppression is checked **here** and again at send
   time, because a complaint can arrive in between.
3. **Drain.** The send worker takes batches of queued messages, renders the MJML per contact,
   and calls SES `SendEmail` with the brand's configuration set.
4. **Rate limit.** A Redis token bucket held at **80% of the current SES send rate**. SES throttles
   hard at the limit, and a `Throttling` error mid-broadcast is far more expensive than sending a
   little slower.
5. **Feed back.** SES publishes to SNS, SNS posts to `/webhooks/ses`, the handler verifies the SNS
   signature, writes a `message_events` row and updates the message. Hard bounces and complaints
   write a **global** suppression immediately.

**Two queues, not one.** Automation and transactional mail run on a high-priority queue; broadcasts
on a low-priority one. Otherwise a 50,000-recipient newsletter for Peach Picks delays a LawnPilot
welcome email by an hour, and the welcome email is the one that converts.

**Every send carries these headers**, without exception:

```
List-Unsubscribe: <https://links.<brand>/u/<token>>, <mailto:unsub@mail.<brand>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Google and Yahoo have required one-click unsubscribe from bulk senders since February 2024. Without
it your mail goes to spam regardless of how good it is. The token is an HMAC of the message id —
it works with no login and cannot be enumerated to unsubscribe somebody else.

**Tracking.** Opens are a 1×1 GIF at `https://links.<brand>/o/<token>`; clicks are rewritten to
`https://links.<brand>/c/<token>?u=<signed-url>`. Run them on the brand's **own** tracking domain,
not a shared one — a link whose hostname does not match the sender is both a deliverability
penalty and the thing that makes a careful reader not click. Treat open rates as directional only;
Apple Mail Privacy Protection pre-fetches images and inflates them.

---

## 6. Automations

The scheduler is a Postgres poll, not a pile of delayed Redis jobs. A three-day wait sitting in
BullMQ is invisible and lost on a flush; a row with a `next_run_at` can be inspected, reported on,
and rescheduled.

```sql
-- The entire scheduler loop, run every 30 seconds.
select * from automation_runs
 where status = 'active' and next_run_at <= now()
 order by next_run_at
 limit 500
 for update skip locked;
```

`SKIP LOCKED` is what lets several workers run the same query without processing anyone twice.

Each tick executes the current step and either sets `next_run_at` (a `wait`), advances
`current_step` (an `email`, `add_tag`, `webhook`), branches (a `condition`), or completes the run.

**Triggers:** a tag added, a form submitted, a date field reached — and the one that matters for
selling software:

```
POST /v1/events
Authorization: Bearer <brand api key>

{ "email": "dev@company.com",
  "event": "trial_started",
  "properties": { "plan": "pro", "seats": 5 } }
```

Each of the five products posts its own lifecycle events — `signup`, `trial_started`,
`trial_expiring`, `feature_used`, `upgraded`, `churned` — and the emails follow from the product's
real state rather than from a guess. This is the capability you are building the platform for; a
rented ESP can only react to what you remember to forward to it.

The flows to build first, in order of what they earn:

| Flow | Trigger | Why |
|---|---|---|
| Welcome / onboarding (3–5 emails) | subscribe, double opt-in confirmed | Highest engagement window you will ever get |
| Trial activation | `trial_started` + no `feature_used` after 48h | Directly attacks the reason trials die |
| Trial expiring | `trial_expiring` at −7, −3, −1 days | The conversion moment |
| Abandoned checkout | `checkout_started` + no `purchase` after 1h | The single highest-ROI flow in ecommerce |
| Win-back | no open in 90 days | Also keeps the list clean, which protects the SES account |

---

## 7. Forms and list growth

A ~2 KB script per brand: `<script src="https://links.<brand>/f/<form-id>.js">`. Inline or modal,
posts to `/v1/subscribe`.

Non-negotiable on the endpoint: the brand's `allowed_origins` CORS allowlist, a honeypot field, a
per-IP rate limit, and **double opt-in on by default**. Double opt-in costs perhaps 20% of raw
signups and is worth it three times over — it is what keeps typo'd and hostile addresses out of
your list, and list hygiene is what keeps the SES account alive for all five brands.

Record `consent_at`, `consent_ip` and `consent_source` on confirmation. Under GDPR, consent you
cannot evidence is consent you do not have.

---

## 8. Compliance, non-optional

- **Physical postal address in every footer** (CAN-SPAM). It is a column on `brands` for that reason.
- **Unsubscribe honoured within 10 days** — in practice, instantly.
- **SPF, DKIM and DMARC** on every sending domain. SES Easy DKIM is three CNAME records; set a
  custom MAIL FROM subdomain so SPF aligns; start DMARC at `p=none` with an `rua` address and
  tighten once reports are clean.
- **Keep bounces under 5% and complaints under 0.1%.** SES reviews the account at those thresholds
  and pauses sending at 10% / 0.5%. Gmail wants spam complaints under 0.3%.
- **Never import a purchased, scraped or rented list.** It is the fastest way to lose the account,
  and it takes all five brands down with it.

---

## 9. Transactional email

Out of v1 by choice, but worth knowing the end state: each product currently has its own
`nodemailer` + SMTP setup and its own hand-written templates — `api/src/email.mjs` in Kept
Portraits is a good example, and the pattern is duplicated per product. Once the platform is
sending reliably, those become `POST /v1/send` calls with a template id, which gets you one place
to edit templates, one log of every email any business ever sent to a customer, and suppression
that understands the difference between marketing (respect the unsubscribe) and transactional
(send the receipt regardless).

Do it after the marketing side is proven. A receipt that fails to arrive is a worse outcome than a
newsletter that does.

---

## 10. Build sequence

Estimates assume one developer working steadily.

| Phase | Work | Time | Done when |
|---|---|---|---|
| **0** | AWS account, **SES production access request**, verify 5 domains, DKIM/SPF/DMARC/MAIL FROM, tracking CNAMEs | 1 day, then 24–48h waiting | SES shows production access, all domains verified |
| **1** | Schema, migrations, contacts CRUD, CSV import, suppression, send core, SES→SNS webhook, signed unsubscribe | 2 weeks | A real broadcast reaches a 100-person list and bounces update the database |
| **2** | Campaign composer, MJML templates, segment builder, open/click tracking, per-campaign stats | 2 weeks | A non-developer can send a newsletter without help |
| **3** | Automation engine, step types, `/v1/events` API, the five flows in §6 | 2 weeks | A `trial_started` event from a live product sends the right email |
| **4** | Form builder, embed script, double opt-in, per-form reporting | 1 week | A form on each of the five sites is producing confirmed subscribers |
| **5** | Migrate the brands, ramp volume gradually, dashboards | 1 week | All five brands sending from the platform |

**Total: 8 weeks to all five brands live.** Phase 1 alone already replaces a paid ESP for basic
broadcasts.

**Ramp, don't blast.** Even on SES's warmed shared IPs, your *domains* have no reputation. Start at
a few thousand a day per brand, to your most engaged contacts first, and roughly double every two
or three days while bounce and complaint rates stay clean. Your first send should never be your
whole list.

---

## 11. Cost

At 50,000 contacts and 500,000 sends a month:

| | Monthly |
|---|---|
| SES, 500k sends | $50 |
| Postgres + Redis (existing VPS, or a small managed instance) | $0–25 |
| S3 for images and assets | ~$2 |
| Route 53, 5 hosted zones | $2.50 |
| **Total** | **≈ $55–80** |
| *The same list on Klaviyo / Mailchimp* | *$700–1,500* |

Build cost is roughly 8 developer-weeks. Against a $700/month floor that pays back inside a year,
and the gap widens with every contact and every new brand.

---

## 12. Repository layout

A separate repo from the product codebases — it serves all of them and must not be coupled to any
one.

```
mailer/
  api/
    src/
      server.mjs
      db/            migrations, query helpers
      brands/        resolution, isolation, API keys
      contacts/      CRUD, import, suppression
      segments/      the jsonb → SQL compiler
      campaigns/
      automations/   engine, step types, scheduler
      forms/
      sending/       SES client, rate limiter, renderer
      tracking/      open, click, unsubscribe endpoints
      webhooks/      SNS handler + signature verification
  worker/            send, automations, imports
  admin/             React (Vite)
  embed/             the form script
  deploy/            docker-compose, nginx
```

---

## 13. The things that go wrong

| Failure | Why it happens | The defence |
|---|---|---|
| Duplicate sends after a crash | The worker iterated contacts in memory | `messages` rows written first, unique on `(campaign_id, contact_id)` |
| SES pauses the whole account | One brand imported a stale list | Double opt-in, no bought lists, per-brand monitoring, separate AWS account for a risky brand |
| A blast delays a welcome email | One queue | Separate priorities for broadcast and automation |
| Someone unsubscribed still receives mail | Suppression checked only when materialising the campaign | Check again at send time, inside the worker |
| Unsubscribing from one brand removes them from all | Global-only suppression | Per-brand suppression; global reserved for bounces and complaints |
| Mail lands in spam despite good content | Missing one-click unsubscribe, unaligned SPF, mismatched tracking domain | §5 and §8, all of it |
| Open rates look implausible | Apple MPP pre-fetching | Optimise on clicks and replies, not opens |
