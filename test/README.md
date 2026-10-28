# Tests

```bash
cp .env.example .env    # first time only
npm test
```

The `.env` is not optional even without a database. `src/config.mjs` fails the
process on a missing `DATABASE_URL` — deliberately, because a missing
`TOKEN_SECRET` silently falling back to a default would make every unsubscribe
link ever issued forgeable. The cost is that a fresh clone cannot run a single
test until the file exists. `.env.example` has working defaults; only
`TOKEN_SECRET` needs a value, and any 32+ characters will do for tests.

**195 tests.** The 85 that need PostgreSQL skip cleanly without one, so the
suite is useful before a database is set up:

```
# pass 110
# skipped 85
```

With a database (`createdb mailer && npm run migrate`) all 195 run.

## Why `--test-concurrency=1`

Every database-backed test file shares one database. Node's test runner
defaults to running files in parallel, and two files then race: one file's
cleanup deletes rows another is mid-assertion on, and you get a failure that
does not reproduce when you run that file alone.

Running serially costs about a second. Chasing a phantom failure costs an
afternoon.

If the suite ever needs to be parallel, the fix is a schema per file
(`search_path`), not a retry.

## Layout

| File | Needs a DB | What it covers |
|---|---|---|
| `tokens.test.mjs` | no | signing, tamper resistance, purpose separation |
| `segments.test.mjs` | no | the jsonb → SQL compiler, injection attempts |
| `mime.test.mjs` | no | headers, encoding, header injection |
| `renderer.test.mjs` | no | merge fields, escaping, link rewriting, footers |
| `rate-limit.test.mjs` | no | the token bucket |
| `sns.test.mjs` | no | SNS signature verification |
| `ses.test.mjs` | no | error classification |
| `steps.test.mjs` | no | automation step validation |
| `integration.test.mjs` | **yes** | the send pipeline, bounces, idempotency |
| `http.test.mjs` | **yes** | the public endpoints over real HTTP |
| `automations.test.mjs` | **yes** | the automation engine end to end |
| `lint.test.mjs` | no | the pre-send checks |
| `forms.test.mjs` | **yes** | signup forms, double opt-in, and the abuse cases |
| `composer.test.mjs` | **yes** | templates, preview, preheader, and the reports |
| `warmup.test.mjs` | partly | the ramp and list hygiene (unit), enforcement (DB) |
