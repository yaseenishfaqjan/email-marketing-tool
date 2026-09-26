# Email marketing platform

One platform for all the businesses. Contacts, segments, broadcasts and
deliverability, with hard separation between brands, sending through Amazon SES.

**Phases 1 through 4 are complete and tested** — the whole platform except the
admin UI. Sending: brands and API keys, contacts, CSV import, segments,
campaigns, the send pipeline, SES feedback handling, tracking, one-click
unsubscribe. Automations: the events API each product calls, the scheduler,
six step types, conditions over product behaviour. Forms: an embeddable
widget, double opt-in, and the consent record behind it. Composer: a template
library, preview against real contacts, a pre-send linter, and the reports
that keep the sending account alive.

```
src/
  app.mjs              the express app (no listener, so tests can bind it)
  server.mjs           the service entry point
  config.mjs           validated at startup; missing secrets fail the process
  db.mjs               pool, query, tx
  tokens.mjs           signed unsubscribe / open / click tokens
  automations/         the engine, the step vocabulary, enrolment
  events/              recording what a product reports
  forms/               signup forms, double opt-in, the embed widget
  templates/           the library, and the four starters
  reporting/           deliverability health, campaign and list reports
  contacts/            repository + CSV import
  segments/            the jsonb → SQL compiler
  campaigns/           materialise, preview, and the pre-send linter
  sending/             SES client, MIME builder, renderer, rate limiter
  suppression/         per-brand and global
  http/                routes, auth, SNS signature verification
  worker/              the send worker
db/                    migrations, migrate runner, seed
deploy/                docker-compose, nginx
docs/                  SES-SETUP.md, API.md
test/                  71 tests
```

## Running it locally

```bash
npm install
cp .env.example .env          # then fill in TOKEN_SECRET and ADMIN_TOKEN
createdb mailer
npm run migrate
npm run seed                  # a demo brand, three contacts, one draft campaign

npm start                     # the API, on :8080
npm run worker                # the send worker, in another terminal
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`npm test` runs all 149 tests. The 78 that need a database skip cleanly without
one, so the suite is useful before Postgres is set up. See
[test/README.md](test/README.md) for why they run serially.

## Before it can send anything

Work through **[docs/SES-SETUP.md](docs/SES-SETUP.md)**, and start it today:
a new SES account is sandboxed to 200 emails a day to verified addresses only,
and production access takes 24–48 hours to be granted. Nothing else in this
project has a queue you cannot jump.

Keep `SES_SANDBOX=true` until it is granted.

## How a send works

```
POST /campaigns/:id/send
        │
        ▼
materialise ── one INSERT…SELECT ── messages rows, one per recipient
        │                            unique (campaign_id, contact_id)
        │                            excludes unsubscribed, bounced, suppressed
        ▼
send worker ── FOR UPDATE SKIP LOCKED ── claim a batch
        │      re-check suppression      (an unsubscribe can land mid-send)
        │      render + MIME
        │      token bucket at 80% of the SES rate
        ▼
      SES ──▶ SNS ──▶ POST /webhooks/ses ──▶ events, statuses, suppressions
```

The recipient rows are written **before** anything reaches SES. That is what
makes the send restartable: a worker can die at any point and the unique
constraint absorbs the retry. A worker that looped over contacts in memory
would, the first time it died at 40%, either stop or start again from the top —
and there is no way to un-send the duplicates.

## The decisions worth knowing

**Suppression has two scopes.** Unsubscribing from LawnPilot must not remove
somebody from Kept Portraits — they never asked for that, so an unsubscribe is
brand-scoped. A hard bounce or a spam complaint is **global**: that is about
protecting the sending account, which every brand shares.

**SES reputation is account-level.** Configuration sets give per-brand
visibility, not per-brand isolation. One brand importing a stale list can get
sending paused for all five. Hence: double opt-in, imports that skip suppressed
addresses, and a suppression removal that demands `?confirm=yes`. If one
product's list is ever genuinely riskier than the others, give it a separate
AWS account — splitting later is easy, recovering a paused account is not.

**GET on an unsubscribe link does nothing.** Corporate scanners and
link-preview bots fetch every URL in an email before the recipient sees it. A
GET that unsubscribed would quietly empty the list. The link shows a page; the
POST does the work, and is also what Gmail's own unsubscribe button sends.

**Every email carries `List-Unsubscribe` and `List-Unsubscribe-Post`.** Google
and Yahoo have required one-click unsubscribe from bulk senders since February
2024. Without it, good mail goes to spam whatever the content says.

**Nothing that cannot be undone ships without a check.** A linter runs before
every send. Its errors block — a link pointing at staging, a merge field
that renders as empty text so the whole list gets "Hi ,". Its warnings advise
and never block, because a linter that overrules the person writing the email
is a linter they route around.

**Rates are measured against delivered, not sent.** Against sent, a list full
of dead addresses flatters itself. And opens are reported but never optimised
on: Apple Mail Privacy Protection pre-fetches images, so an open means someone
*might* have looked. Clicks are the honest number.

**A signup is not a subscriber.** Double opt-in is the default. A form
submission is a claim — anybody can type anybody's address into a form on the
open internet — and it becomes consent only when the link is clicked from that
mailbox. Both halves are recorded, because consent you cannot evidence is
consent you do not have.

**Forms fail closed.** Every form carries an allowlist of sites that may post
to it, and an empty list accepts nothing. The alternative is a brand's list
filled with whatever the internet feels like putting in it.

**The click tracker cannot be an open redirect.** Each click token carries a
digest of the destination that was in the email. Without it,
`/c/<token>?u=<anything>` would redirect from a domain your recipients have
been taught to trust.

**Phase 1 has no Redis.** The design called for BullMQ, but `messages` is
already a durable queue with a partial index, and `SKIP LOCKED` already gives
safe concurrent claiming — so Redis would have been a second moving part
holding state Postgres was holding correctly. The one thing it is needed for is
the send rate limiter once a **second** worker starts: each process currently
owns its own token bucket, so two workers would exceed the SES rate. Until
then, run one worker. `src/sending/rate-limit.mjs` is the only file that
changes.

## Where this is going

| Phase | | Status |
|---|---|---|
| 1 | Contacts, imports, segments, campaigns, sending, SES feedback, tracking | **done** |
| 3 | Automations engine + `/v1/events` from each product | **done** |
| 4 | Form builder, embed script, double opt-in | **done** |
| 2 | Campaign composer, template library, richer reporting | **done** |
| 5 | Migrate the brands, warm up, dashboards | next |

Phase 3 was built before Phase 2 because it is the one the whole platform is
for: each product posts its own lifecycle events — `trial_started`,
`trial_expiring`, `upgraded` — and the emails follow from the product's real
state rather than from a guess. A rented ESP can only ever react to what you
remember to forward it.

## How an automation runs

```
POST /v1/events  ── trial_started ──▶ enrol (one active run per person)
                                          │
        ┌─────────────────────────────────▼──────────────────────────────┐
        │  automation_runs: one row per person, with a next_run_at        │
        │  scheduler: SELECT … WHERE next_run_at <= now()                 │
        │             FOR UPDATE SKIP LOCKED                              │
        └─────────────────────────────────┬──────────────────────────────┘
                                          │ one step per tick
             wait ──▶ condition ──▶ email ──▶ … ──▶ completed
                                          │
                                          ▼
                        messages ── the same queue broadcasts use
```

The scheduler is a Postgres poll, not a pile of delayed jobs. A three-day wait
parked inside a job queue is invisible and gone the moment somebody flushes it;
a row with a `next_run_at` can be inspected, counted and rescheduled.
`SKIP LOCKED` is what lets several workers share the table without anybody
being processed twice.

Two things stop the classic failures. A partial unique index allows only **one
active run** per person per automation, so a double-fired event cannot start
the sequence twice. Another on `(automation_run_id, automation_step_id)` means
a step re-executed after a crash **cannot send a second copy** — the same
trick the broadcast pipeline uses with `(campaign_id, contact_id)`.

Subscriber status is re-checked at **every step**, not only at enrolment. Most
of a drip series happens days after somebody joined it, and the person who
unsubscribed on Tuesday must not get Thursday's email.
