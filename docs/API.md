# API

Two credentials:

- **Admin** — `Authorization: Bearer $ADMIN_TOKEN`. All brands.
- **Brand API key** — `Authorization: Bearer emk_<brand>_…`. One brand, and the
  brand is resolved from the key, so there is no brand parameter to tamper with.

Base URL is the service host. Tracking links live on each brand's own tracking
domain.

## Brands (admin)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/brands` | |
| `POST` | `/v1/brands` | `slug`, `name`, `from_name`, `from_email`, `sending_domain`, `postal_address` required |
| `GET` | `/v1/brands/:id` | |
| `PATCH` | `/v1/brands/:id` | |
| `POST` | `/v1/brands/:id/keys` | Returns the secret **once** |
| `DELETE` | `/v1/brands/:id/keys/:keyId` | Revokes |

```bash
curl -X POST $BASE/v1/brands -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "slug": "kept",
    "name": "Kept Portraits",
    "from_name": "Kept Portraits",
    "from_email": "hello@mail.keptportraits.com",
    "sending_domain": "mail.keptportraits.com",
    "tracking_domain": "links.keptportraits.com",
    "ses_config_set": "kept-portraits",
    "postal_address": "1 Example Street, Example City, EX1 2MP"
  }'
```

## Contacts (admin, per brand)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/brands/:id/contacts` | `?status=`, `?q=`, `?limit=`, `?offset=` |
| `POST` | `/v1/brands/:id/contacts` | Refuses a suppressed address |
| `POST` | `/v1/brands/:id/contacts/import` | `Content-Type: text/csv`, body is the CSV |
| `POST` | `/v1/brands/:id/contacts/:contactId/unsubscribe` | |

```bash
curl -X POST "$BASE/v1/brands/$BRAND/contacts/import?source=webinar-2026-09" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: text/csv' \
  --data-binary @contacts.csv
# {"imported":4812,"updated":37,"skipped":26,"invalid":[...],"total":4875}
```

The header row needs an `email` column; `first_name`/`last_name` are recognised
under common aliases and every other column becomes a contact attribute you can
segment on. Suppressed addresses are skipped and counted, never re-added.

## Suppression (admin, per brand)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/brands/:id/suppressions` | Includes global entries |
| `POST` | `/v1/brands/:id/suppressions` | `{"email":…, "global": true}` for all brands |
| `DELETE` | `/v1/brands/:id/suppressions/:email?confirm=yes` | Needs the confirm |

## Segments (admin, per brand)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/brands/:id/segments` | |
| `POST` | `/v1/brands/:id/segments` | Upsert by name |
| `POST` | `/v1/brands/:id/segments/preview` | Returns the current count |

```json
{ "match": "all",
  "rules": [
    { "field": "attrs.plan",  "op": "eq",          "value": "pro" },
    { "field": "created_at",  "op": "within_days", "value": 30 },
    { "field": "tag",         "op": "has",         "value": "<tag uuid>" }
  ] }
```

Fields: `email`, `first_name`, `last_name`, `status`, `source`, `created_at`,
`consent_at`, `tag`, `attrs.<key>`.
Operators: `eq`, `neq`, `contains`, `starts_with`, `before`, `after`,
`within_days`, `exists`, `not_exists`, `has`/`not_has` (tags).

## Campaigns (admin, per brand)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/brands/:id/campaigns` | |
| `POST` | `/v1/brands/:id/campaigns` | `name`, `subject`, `mjml` |
| `PATCH` | `/v1/brands/:id/campaigns/:cid` | Draft, scheduled or paused only |
| `POST` | `/v1/brands/:id/campaigns/:cid/test` | `{"to": "you@example.com"}` |
| `POST` | `/v1/brands/:id/campaigns/:cid/send` | Materialises; the worker drains |
| `POST` | `/v1/brands/:id/campaigns/:cid/schedule` | `{"at": "2026-10-01T09:00:00Z"}` |
| `POST` | `/v1/brands/:id/campaigns/:cid/pause` | Stops what has not gone |
| `GET` | `/v1/brands/:id/campaigns/:cid/stats` | Counts and rates |

`send` returns as soon as the recipient rows exist — a request that waited for
50,000 emails would time out halfway with nobody able to say what happened.

Merge fields in the subject and body: `{{first_name}}`, `{{last_name}}`,
`{{email}}`, `{{attrs.<key>}}`. Values are HTML-escaped.

## Subscribe (brand API key)

```bash
curl -X POST $BASE/v1/subscribe -H "Authorization: Bearer $BRAND_KEY" \
  -H 'Content-Type: application/json' -d '{
    "email": "dev@company.com",
    "first_name": "Sam",
    "source": "pricing-page",
    "consent_source": "Pricing page newsletter checkbox",
    "tags": ["pricing-page"],
    "attrs": {"plan_interest": "pro"}
  }'
```

Answers `200` for a suppressed address rather than saying so — a different
response would make this endpoint a way to test whether somebody complained.

## Public links

| Method | Path | |
|---|---|---|
| `GET` | `/o/:token` | Open pixel. Always returns a GIF |
| `GET` | `/c/:token?u=…` | Click. Redirects only to the link that was in the email |
| `GET` | `/u/:token` | Shows a confirmation page. **Does not unsubscribe** |
| `POST` | `/u/:token` | Unsubscribes. Also the one-click target |
| `POST` | `/webhooks/ses` | SNS. Signature verified |

---

# Automations (Phase 3)

## Events (brand API key)

The endpoint each product calls. This is what the platform was built for: the
product's real state drives the email, instead of a guess.

```bash
curl -X POST $BASE/v1/events -H "Authorization: Bearer $BRAND_KEY" \
  -H 'Content-Type: application/json' -d '{
    "email": "dev@company.com",
    "event": "trial_started",
    "properties": {"plan": "pro", "seats": 5},
    "idempotency_key": "trial-9281"
  }'
```

| Field | |
|---|---|
| `email` | who did it |
| `event` | the event name, e.g. `trial_started` |
| `properties` | anything; segmentable and usable as merge fields |
| `idempotency_key` | optional but **use it**. A retried webhook is ignored rather than firing the sequence twice |
| `subscribe` | see below |
| `create_contact` | `false` to ignore events from people not on the list |

### Consent

An unknown address is created as **`pending`** and enters no sequence — doing
something in an app is not consent to receive marketing email.

If the product *did* collect consent, say so, and say where:

```json
{ "email": "dev@company.com",
  "event": "trial_started",
  "subscribe": { "consent_source": "Signed up at app.scalaro.io/register" } }
```

That records `consent_at` and `consent_source`, and the contact becomes
`subscribed`. Consent you cannot evidence is consent you do not have.

It only ever moves `pending` → `subscribed`. Somebody who unsubscribed stays
unsubscribed whatever a product asserts — that decision is theirs.

### Other event routes

| Method | Path | |
|---|---|---|
| `POST` | `/v1/events/batch` | up to 500 at once, for a product catching up after downtime |
| `GET` | `/v1/events?email=&event=&limit=` | the audit trail behind "why did they get this?" |

## Automations (admin, per brand)

| Method | Path | |
|---|---|---|
| `GET` | `/v1/brands/:id/automations` | with step and active-run counts |
| `POST` | `/v1/brands/:id/automations` | name, trigger, steps |
| `GET` | `/v1/brands/:id/automations/:aid` | with its steps |
| `PUT` | `/v1/brands/:id/automations/:aid/steps` | replaces the sequence wholesale |
| `POST` | `/v1/brands/:id/automations/:aid/activate` | |
| `POST` | `/v1/brands/:id/automations/:aid/pause` | holds runs, never cancels them |
| `POST` | `/v1/brands/:id/automations/:aid/enrol` | by hand, for a manual trigger or a test |
| `GET` | `/v1/brands/:id/automations/:aid/stats` | runs by state, plus per-step engagement |

### Triggers

| `trigger_type` | `trigger_config` |
|---|---|
| `event` | `{"event": "trial_started"}`, optionally `{"match": {"plan": "pro"}}` |
| `tag_added` | `{"tag": "pricing-page"}` |
| `subscribed` | `{}`, or `{"source": "pricing-page"}` for a per-form welcome |
| `manual` | `{}` — enrol through the API |

`match` lets one event name drive several sequences: a pro onboarding and a
free onboarding off the same `purchase`.

### Steps

| Type | Config |
|---|---|
| `wait` | `{"days": 3}` / `{"hours": 48}` / `{"minutes": 30}` |
| `email` | `{"subject": "...", "mjml": "..."}` — merge fields work |
| `condition` | `{"rules": <segment>, "otherwise": "exit" \| "continue"}` |
| `add_tag` / `remove_tag` | `{"tag": "trial-nudged"}` |
| `webhook` | `{"url": "https://...", "payload": {}}` — https only |
| `exit` | `{}` |

Steps are validated when **saved**. A broken rule found at 3am mid-sequence is
a stuck run and a customer who never hears from you again.

### Re-entry

`re_entry: false` (default) — a welcome series must never repeat.
`re_entry: true` with `re_entry_cooldown_hours` — an abandoned-checkout series
must.

Either way only **one active run** per person per automation, so a
double-fired event cannot put somebody through the sequence twice at once.

### Worked example — the trial-activation flow

```json
{
  "name": "Trial activation",
  "trigger_type": "event",
  "trigger_config": { "event": "trial_started" },
  "steps": [
    { "type": "wait", "config": { "hours": 48 } },
    { "type": "condition",
      "config": { "rules": { "rules": [
        { "field": "event", "op": "not_has", "value": "feature_used" } ] },
        "otherwise": "exit" } },
    { "type": "email",
      "config": { "subject": "Need a hand getting started?",
                  "mjml": "<mjml>…</mjml>" } }
  ]
}
```

Started a trial, hasn't used the product after two days → nudge. Already
active → the condition exits and they hear nothing. That is the difference
between a helpful email and an annoying one.

### Segment rules gained an `event` field

Usable in segments and in `condition` steps alike:

```json
{ "field": "event", "op": "has" | "not_has",
  "value": "feature_used", "within_days": 7 }
```

---

# Forms and double opt-in (Phase 4)

## Why double opt-in is the default

It costs perhaps 20% of raw signups, and it is worth it three times over. It
keeps typo'd and hostile addresses off the list, and list hygiene is what keeps
the SES account alive — for **every brand at once**, because SES reputation is
account-level.

A submission is a **claim**, not a fact: anybody can type anybody's address
into a form on the open internet. It becomes consent only when the link is
clicked from that mailbox, and both halves are recorded as evidence.

## Forms (admin, per brand)

| Method | Path | |
|---|---|---|
| `GET` | `/v1/brands/:id/forms` | with submission and confirmation counts |
| `POST` | `/v1/brands/:id/forms` | returns the embed snippet |
| `GET` | `/v1/brands/:id/forms/:fid` | |
| `PATCH` | `/v1/brands/:id/forms/:fid` | |
| `GET` | `/v1/brands/:id/forms/:fid/stats` | including the confirmation rate |
| `GET` | `/v1/brands/:id/forms/:fid/submissions` | |

```bash
curl -X POST $BASE/v1/brands/$BRAND/forms -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "name": "Pricing page",
    "fields": ["email", "first_name"],
    "allowed_origins": ["https://scalaro.io", ".scalaro.io"],
    "headline": "Get the newsletter",
    "button_label": "Sign me up",
    "theme": {"accent": "#9a7b4f", "radius": "6px"}
  }'
```

`allowed_origins` is **required**. It is the list of sites that may post to
this form, and an empty list accepts nothing — the form fails closed, because
the alternative is a brand's list filled with whatever the internet feels like
putting in it.

A leading dot means "and its subdomains": `.scalaro.io` covers
`app.scalaro.io` but **not** `notscalaro.io`.

## Putting it on a site

The create response hands you both lines:

```html
<div data-emk-form="<form-id>"></div>
<script src="https://links.scalaro.io/f/<form-id>.js" async></script>
```

Without the `div` the form renders where the script tag sits, so one pasted
line works.

The widget is ~6 KB, has no dependencies and no build step. Everything is
scoped to a per-form class, so the host site's CSS cannot flatten the form and
the form cannot restyle the host site. It tolerates being loaded twice, which
CMSs do.

Customise with `theme`: `accent`, `radius`, `font`.

## The flow

```
visitor submits        → form_submissions row, contact created as 'pending'
                         (invisible to every campaign and automation)
confirmation email     → queued like any other message: same rate limit, same
                         tracking. Transactional, so no unsubscribe link —
                         there is nothing to leave yet, and not clicking IS
                         the opt-out
visitor clicks         → GET /confirm/:token
                         contact becomes 'subscribed', consent_at and
                         consent_source recorded, tags applied, and any
                         'subscribed' automation starts
```

Confirmation links are valid for **7 days** and are safe to click twice — mail
clients prefetch, people double-click, and somebody will bookmark it.

### Why GET confirms, when GET does not unsubscribe

The opposite rules, deliberately. A scanner prefetching an unsubscribe link
would empty the list; a scanner prefetching a confirmation link can only ever
add somebody who already asked. And requiring a second click here loses real
subscribers to confusion. The safe direction differs, so the design does.

### Confirming after an unsubscribe

They left, then filled in a form again and clicked a link in their own inbox.
That is fresher and better-evidenced consent than the first time, so the
brand-scoped unsubscribe is cleared.

A **hard bounce or spam complaint is different** and is never cleared: that is
global suppression, it protects the account every brand shares, and no form
submission overrides it. Such an address is recorded as `blocked` and the
visitor gets the ordinary success message — a different answer would turn a
public form into a way to test who is on somebody's list.

## Single opt-in

`"double_optin": false` subscribes immediately. Available, and not
recommended — see the top of this section.
