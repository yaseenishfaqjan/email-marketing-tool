# Deploying to the VPS

Your VPS is **209.145.55.76**; cPanel and mail live separately on
95.216.22.216. This deploys only the platform. Nothing here touches your
websites, and nothing touches mail routing.

Work through it in order. Steps 1–4 can be done before AWS grants production
access; step 7 is the only one that needs it.

---

## Before you start

- [ ] `mail.scalaro.io` shows **Verified** in SES
- [ ] SES production access requested (step 7 waits on it)
- [ ] A DNS record you can point at the VPS for tracking links

---

## 1. Get the code onto the server

```bash
ssh root@209.145.55.76
mkdir -p /opt/mailer && cd /opt/mailer
git clone https://github.com/yaseenishfaqjan/email-marketing-tool.git .
```

## 2. Create the environment file

```bash
cp .env.example .env
nano .env
```

Generate the two secrets **on the server**, and paste each one in:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOKEN_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ADMIN_TOKEN
openssl rand -base64 24                                                    # POSTGRES_PASSWORD
```

> **TOKEN_SECRET is permanent.** It signs every unsubscribe link. Rotate it
> and every link already sitting in somebody's inbox stops working — which
> means unsubscribes start failing, which means spam complaints. Back it up
> somewhere you will still have in three years.

Fill in:

```ini
DATABASE_URL=postgres://mailer:<POSTGRES_PASSWORD>@mailer-db:5432/mailer
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
TOKEN_SECRET=<first secret>
ADMIN_TOKEN=<second secret>
PUBLIC_URL=https://links.scalaro.io
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=<from IAM>
AWS_SECRET_ACCESS_KEY=<from IAM>
SES_SANDBOX=true
SES_MAX_SEND_RATE=10
```

```bash
chmod 600 .env
```

## 3. DNS for the tracking domain

```
links.scalaro.io    A    209.145.55.76
```

In cPanel → Zone Editor, the same place you added the SES records.

Links in an email must match the sender's domain. A tracking link on an
unrelated hostname costs deliverability and reader trust both.

## 4. Start it

```bash
cd /opt/mailer/deploy
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f mailer-api
```

Migrations run automatically on start. Then:

```bash
curl -s localhost:8098/health
# {"ok":true,"env":"production","sesSandbox":true}
```

## 5. nginx and TLS

> **On this server nginx runs in a container** (`scalaro-nginx-1`), which holds
> ports 80 and 443. The host's nginx is installed but not serving, so adding a
> file to `/etc/nginx/sites-enabled/` does nothing. The vhost goes into the
> container's config directory, and the container is reloaded.

```bash
# Where that container reads its config from:
docker inspect scalaro-nginx-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}
{{end}}'
```

Add the server block from `deploy/nginx.conf` there, proxying to
`127.0.0.1:8098`, then:

```bash
docker exec scalaro-nginx-1 nginx -t
docker exec scalaro-nginx-1 nginx -s reload
```

Check the public paths answer:

```bash
curl -sI https://links.scalaro.io/f/test.js        # 200, application/javascript
curl -s  https://links.scalaro.io/v1/brands        # 401 — admin is not public
```

## 6. Point SES events at it

In SES → Configuration sets → your set → Event destinations, set the SNS
topic's HTTPS endpoint to:

```
https://links.scalaro.io/webhooks/ses
```

The service auto-confirms the subscription on first delivery — but only after
verifying the signature, so the endpoint has to be reachable first.

Confirm it arrived:

```bash
docker compose -f docker-compose.prod.yml logs mailer-api | grep sns
# [sns] subscription confirmed for arn:aws:sns:eu-north-1:...
```

## 7. When AWS grants production access

```bash
sed -i 's/SES_SANDBOX=true/SES_SANDBOX=false/' /opt/mailer/.env
cd /opt/mailer/deploy
docker compose -f docker-compose.prod.yml up -d --force-recreate mailer-api mailer-worker
```

**`docker restart` does not re-read `env_file`.** The containers must be
recreated or they keep the old value and every send stays sandboxed.

---

## Migrating the five brands

### One brand at a time

Do not set up all five at once. Get one sending cleanly, watch it for a few
days, then do the next. Five brands started together means five brands with
unknown reputation on one account, and no way to tell which one is the problem.

### For each brand

**1. Verify its sending domain in SES** — `mail.<brand>.com`, the DKIM CNAMEs,
the MAIL FROM MX and TXT. Same steps as `docs/SES-SETUP.md`.

**2. Create the brand**

```bash
curl -X POST https://links.scalaro.io/v1/brands \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
    "slug": "kept",
    "name": "Kept Portraits",
    "from_name": "Kept Portraits",
    "from_email": "hello@mail.keptportraits.com",
    "sending_domain": "mail.keptportraits.com",
    "tracking_domain": "links.keptportraits.com",
    "ses_config_set": "kept-portraits",
    "postal_address": "<the real registered address>",
    "timezone": "Europe/London"
  }'
```

The postal address goes in every email by law. Use the real one.

**3. Dry-run the list before importing it**

```bash
curl -X POST "https://links.scalaro.io/v1/brands/$BRAND/contacts/import/dry-run" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: text/csv' \
  --data-binary @contacts.csv
```

Read the verdict before doing anything else:

| Verdict | What to do |
|---|---|
| `ok` | import it |
| `check_consent` | mostly role accounts — confirm they opted in |
| `clean_first` | fix the suggested typos, drop the disposables, re-run |
| `do_not_import` | **stop.** Find out where this list came from |

A bad import is not a local mistake. It raises the bounce rate on an account
all five brands share, and the cost of finding out afterwards is weeks of
suspended sending.

**4. Import**

```bash
curl -X POST "https://links.scalaro.io/v1/brands/$BRAND/contacts/import?source=migration-2026-10&consent=Existing%20customers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: text/csv' \
  --data-binary @contacts.csv
```

**5. Send a test to yourself, then a small real send**

The warm-up caps the first day at 500 automatically. Send to your most engaged
contacts first — recent buyers, recent signups. They open, and early
engagement is what teaches the providers your domain is wanted.

---

## The warm-up

Enforced in code. You do not have to remember it, and you cannot accidentally
skip it.

| Days | Cap per brand per day |
|---|---|
| 1–2 | 500 |
| 3–4 | 2,000 |
| 5–7 | 10,000 |
| 8–10 | 25,000 |
| 11–13 | 50,000 |
| 14–16 | 100,000 |
| 17–20 | 250,000 |
| 21+ | no limit — the SES account quota governs |

The clock starts on a brand's **first send**, not when you create it.

```bash
curl -s "https://links.scalaro.io/v1/brands/$BRAND/warmup" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Hitting a cap drops nothing: the rest of the queue goes out tomorrow.

### Stopping a send

```bash
# Pause this brand's marketing. Transactional mail is unaffected.
curl -X PATCH "https://links.scalaro.io/v1/brands/$BRAND/warmup" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"daily_send_cap": 0}'

# Resume on the schedule.
-d '{"daily_send_cap": null}'
```

---

## Watching it

**The dashboard**, once a day during a migration:

```
https://links.scalaro.io/dashboard
```

(Admin token required. Read-only.)

**What to act on**

| Sign | What it means |
|---|---|
| Any brand `at_risk` or `critical` | Stop that brand now — `daily_send_cap: 0` — and find out where its contacts came from |
| Account bounce ≥ 5% | SES is reviewing you. Stop all imports |
| Queue deep, nothing sending | The brand is capped, or the worker is not running |
| Failed rising | Check `docker compose logs mailer-worker` |

**Google Postmaster Tools** — add each sending domain at
<https://postmaster.google.com>. It is the only place you see what Gmail
thinks of you, and Gmail is most of any consumer list.

---

## Backups

The contacts are the asset. Everything else is replaceable.

```bash
cat > /opt/mailer/backup.sh <<'SH'
#!/bin/sh
set -e
DEST=/var/backups/mailer
mkdir -p "$DEST"
docker exec mailer-db pg_dump -U mailer mailer | gzip > "$DEST/mailer-$(date +%F).sql.gz"
find "$DEST" -name 'mailer-*.sql.gz' -mtime +30 -delete
SH
chmod +x /opt/mailer/backup.sh
echo "0 3 * * * /opt/mailer/backup.sh" | crontab -
```

**Copy them off the box.** A backup on the same server is not a backup.

**Test a restore once, now**, before you need it:

```bash
gunzip -c /var/backups/mailer/mailer-$(date +%F).sql.gz | \
  docker exec -i mailer-db psql -U mailer -d postgres -c 'create database restore_test' -
```

---

## Updating

```bash
cd /opt/mailer && git pull
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run on start and are idempotent. The worker finishes its current
batch before stopping, so an update mid-send loses nothing.

---

## If something goes wrong

**Nothing is sending.** Check the worker is up
(`docker compose ps`), then the dashboard's warm-up row — the brand may simply
be at its cap. Then `SES_SANDBOX` in `.env`.

**Mail is arriving in spam.** Check DKIM and DMARC are still passing on the
sending domain, then the provider breakdown report: if it is one provider
only, it is authentication, not content.

**SES suspended the account.** Stop all sending
(`daily_send_cap: 0` on every brand), work out which brand's list caused it
from the deliverability report, and reply to AWS with what you found and what
you changed. Do not resume until they answer.

**A campaign is going out and should not be.**

```bash
curl -X POST ".../campaigns/$ID/pause" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Stops everything not yet sent. What has gone cannot be recalled — there is no
such thing.
