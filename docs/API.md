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
