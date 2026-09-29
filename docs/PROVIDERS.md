# Sending providers

The platform sends through one of two adapters. Everything upstream of them —
rendering, merge fields, suppression, warm-up caps, automations, signup forms,
unsubscribe tokens, tracking links — is identical whichever is active.

```
                     src/sending/provider.mjs
                        │            │
              src/sending/ses.mjs    src/sending/resend.mjs
                     │                     │
                Amazon SES              Resend
```

Set `EMAIL_PROVIDER` to `ses` or `resend` and restart. There is no data
migration and no redeploy; messages already queued send through whichever
provider is active when the worker picks them up.

## Why two

Amazon SES declined production access for this account on 2026-09-28. AWS does
not state its reasons, so the practical read is the usual one for a days-old
account: no billing history, a first request typed as MARKETING rather than
transactional, and a description of consolidating five brands that reads, to a
reviewer, like bulk mail.

Rather than wait on a re-application with no guaranteed date, the platform
gained a second adapter. SES remains configured and can be switched back to in
one environment variable once access is granted.

## What differs in practice

|  | SES | Resend |
|---|---|---|
| Message format | Raw MIME, built by `src/sending/mime.mjs` | Structured fields; Resend builds the MIME |
| Rate limit | `SES_MAX_SEND_RATE`, from the account's quota | `RESEND_MAX_SEND_RATE`, default 8/s against a documented 10/s |
| Event feed | SNS → `/webhooks/ses` | Resend webhooks — **not yet wired** |
| Cost at 500k/month | ~$80 | Higher; check current pricing |

The MIME difference is the one worth keeping in mind. Under SES we write
`List-Unsubscribe` and `List-Unsubscribe-Post` ourselves. Under Resend we pass
them as custom headers and Resend writes them. The result on the wire is the
same, and `test/resend.test.mjs` asserts both headers are sent — because
one-click unsubscribe has been a Gmail and Yahoo requirement for bulk senders
since February 2024, and losing it silently is expensive.

## Bounces and complaints under Resend

**Still to do.** The SNS webhook at `/webhooks/ses` handles SES events —
hard bounces and complaints are written to the global suppression list
automatically. Resend has its own webhook format and nothing consumes it yet.

Until that exists, sending through Resend means bounces and complaints are
**not** automatically suppressed. For the low volumes of a first brand that is
survivable if someone watches the Resend dashboard; it is not survivable at
scale, and it should be built before the second brand is onboarded.

## Switching

```bash
# in /opt/mailer/.env
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
```

```bash
cd /opt/mailer/deploy
docker compose --env-file ../.env -f docker-compose.prod.yml up -d \
  --force-recreate mailer-api mailer-worker
```

The worker's startup line names the active provider, so the logs confirm the
switch took:

```
[worker] started — resend at 8/s in batches of 100, automations every pass
```

## Re-applying to SES

Worth doing; the adapter is already written and SES is cheaper at volume.
What to change from the request that was declined:

- Wait for a month or two of billing history on the account.
- Request **transactional** first, not marketing.
- Ask for one brand and a modest volume, not 500k/month across five.
- Make sure `scalaro.io` has a visible privacy policy, terms and contact page.
- State the verified identity exactly as the SES console shows it. The
  declined request said `mail.scalaro.io`; confirm what is actually verified
  before claiming it.
- Open a new request rather than replying to the closed case.
