# SES setup — do this first

Everything else can be built while this waits. This cannot be compressed, so it
goes first.

## 1. Request production access (24–48 hours)

A new SES account is **sandboxed**: 200 emails a day, 1 per second, and only to
addresses you have verified individually. A broadcast from a sandboxed account
fails per-message.

AWS Console → **Amazon SES** → **Account dashboard** → *Request production
access*. Answer honestly and specifically; vague answers get rejected and cost
another round trip:

- **Mail type:** Marketing
- **Website URL:** the real product site
- **Use case:** who is on the list, how they got there (double opt-in on a
  signup form, or existing customers), roughly how many and how often
- **Bounce/complaint handling:** say that bounces and complaints are consumed
  from SNS and suppressed automatically. That is true of this codebase, and it
  is the question they most want answered.

Keep `SES_SANDBOX=true` in `.env` until access is granted.

## 2. Verify each brand's sending domain

Use a **subdomain**, not the root domain: `mail.keptportraits.com`, not
`keptportraits.com`. Marketing mail then builds its own reputation without
putting the root domain — which sends invoices, password resets and replies to
real people — at risk.

SES → **Identities** → *Create identity* → Domain → `mail.<brand>.com`
→ enable **Easy DKIM**, 2048-bit.

SES gives three CNAME records. Add them. Verification is usually minutes.

## 3. Custom MAIL FROM, for SPF alignment

On the identity → **MAIL FROM domain** → `bounce.mail.<brand>.com`.

Two records:

| Type | Name | Value |
|---|---|---|
| MX | `bounce.mail.<brand>.com` | `10 feedback-smtp.<region>.amazonses.com` |
| TXT | `bounce.mail.<brand>.com` | `v=spf1 include:amazonses.com ~all` |

Without this, SPF authenticates an Amazon domain rather than yours, and DMARC
alignment fails even though SPF passes.

## 4. DMARC

Start permissive and tighten once the reports are clean:

```
_dmarc.mail.<brand>.com   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@<brand>.com; pct=100"
```

Google and Yahoo require a DMARC record from bulk senders. `p=none` satisfies
that while you watch. Move to `p=quarantine` after a few weeks of clean reports.

## 5. Tracking domain

```
links.<brand>.com   CNAME or A   → the server running this service
```

Then `certbot --nginx -d links.<brand>.com`, and set `tracking_domain` on the
brand row. Links in the email must match the sender's domain; a link on a
shared or unrelated hostname costs deliverability and reader trust.

## 6. Configuration set and event destination

One configuration set **per brand**, so reputation metrics are readable per
brand rather than as one pooled number:

```bash
aws sesv2 create-configuration-set --configuration-set-name kept-portraits

aws sns create-topic --name ses-events
aws sns subscribe --topic-arn <topic-arn> --protocol https \
  --notification-endpoint https://links.keptportraits.com/webhooks/ses

aws sesv2 create-configuration-set-event-destination \
  --configuration-set-name kept-portraits \
  --event-destination-name sns \
  --event-destination '{
      "Enabled": true,
      "SnsDestination": {"TopicArn": "<topic-arn>"},
      "MatchingEventTypes": ["SEND","DELIVERY","BOUNCE","COMPLAINT","REJECT","DELIVERY_DELAY"]
  }'
```

The service auto-confirms the SNS subscription on first delivery — but only
after verifying the signature, so the endpoint must be reachable over HTTPS
first.

Set `ses_config_set` on the brand row to the configuration set name.

> Open and click events are **not** subscribed above, because this service
> tracks those itself on the brand's own domain. Subscribing to both
> double-counts.

## 7. IAM

The service needs exactly one permission. Do not give it more:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ses:SendEmail"],
    "Resource": "*"
  }]
}
```

## 8. Warm up

Domains have no reputation on day one, even on SES's warmed shared IPs.

| Day | Per brand, per day | Send to |
|---|---|---|
| 1–2 | 500 | the most recently engaged contacts |
| 3–4 | 2,000 | recent openers |
| 5–7 | 10,000 | active contacts |
| 8+ | double every 2–3 days | widen gradually |

Watch bounce and complaint rates before each increase. **Your first send must
never be your whole list** — a cold list mailed at once is the classic way to
have the account suspended in week one.

## Thresholds to stay under

| Metric | Review | Pause |
|---|---|---|
| Bounce rate | 5% | 10% |
| Complaint rate | 0.1% | 0.5% |

Gmail additionally wants spam complaints under 0.3%.

These are **account-level**, shared by all five brands. One brand's bad import
pauses sending for every business at once — which is why imports skip
suppressed addresses, why double opt-in is the default, and why a purchased
list must never go anywhere near this system.

## 9. Dedicated IPs — not yet

Below roughly 100,000 emails a month, shared IPs are better: they are already
warm, and a dedicated IP with low volume looks suspicious rather than
trustworthy. Revisit above that.
