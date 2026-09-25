# Email marketing platform

One platform for all the businesses. Contacts, segments, broadcasts and
deliverability, with hard separation between brands, sending through Amazon SES.

**Phase 1 is complete and tested:** brands and API keys, contacts, CSV import,
segments, campaigns, the send pipeline, SES feedback handling, open and click
tracking, and one-click unsubscribe. Automations, the form builder and the
admin UI are Phases 3–4 — see [the plan](#where-this-is-going).

```
src/
  app.mjs              the express app (no listener, so tests can bind it)
  server.mjs           the service entry point
  config.mjs           validated at startup; missing secrets fail the process
  db.mjs               pool, query, tx
  tokens.mjs           signed unsubscribe / open / click tokens
  contacts/            repository + CSV import
  segments/            the jsonb → SQL compiler
  campaigns/           materialise a campaign into message rows
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

`npm test` runs all 71 tests. The 23 that need a database skip cleanly without
one, so the suite is useful before Postgres is set up.

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
| 2 | Campaign composer, template library, richer reporting | next |
| 3 | Automations engine + `/v1/events` from each product | |
| 4 | Form builder, embed script, double opt-in | |
| 5 | Migrate the brands, warm up, dashboards | |

Phase 3 is the one the whole platform is for: each product posts its own
lifecycle events — `trial_started`, `trial_expiring`, `upgraded` — and the
emails follow from the product's real state rather than from a guess. A rented
ESP can only ever react to what you remember to forward it.
