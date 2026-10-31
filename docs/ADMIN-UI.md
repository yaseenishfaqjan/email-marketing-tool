# The admin panel

`https://mailer.scalaro.io/admin` — contacts, campaigns, suppression and
reports in a browser, so running a brand does not require a terminal.

## Signing in

There is one credential, `ADMIN_TOKEN`, the same one the JSON API takes. The
login form exchanges it for a signed, HttpOnly cookie that lasts eight hours.

The panel deliberately does **not** accept `Authorization: Bearer`. A token in
a URL ends up in browser history, in screenshots and in nginx access logs; a
cookie does not. The API still takes bearer auth, because that is right for
scripts.

## What it does

| Page | What you can do |
|---|---|
| Overview | Bounce and complaint rates, warm-up position, queue depth, recent campaigns |
| Campaigns | Create from a template, edit subject and MJML, live preview, lint, test send, send, pause |
| Contacts | Search and filter, CSV import with a dry run first |
| Suppressed | See who is blocked and why; add or remove by hand |
| Forms | Each form's embed snippet |
| Automations | What exists, how many runs are active |

Automations and forms are read-only here. They are created through the API,
which is where their shape is easiest to express.

## It is not a second code path

Every action calls the same function the API calls. A campaign sent from the
panel goes through the same lint, the same suppression filter and the same
warm-up cap as one sent by curl. A check that existed in one and not the
other would be worse than no check — it would teach people the warning is
optional.

## Why CSRF, specifically

Cookie auth means a form on another site can post to this one with the
browser's cookie attached. `SameSite=Strict` stops that on its own in every
current browser; the per-session token behind it is there because one of
these POSTs sends mail to an entire list, and that cannot be recalled. One
browser bug is not a risk worth carrying for a page with that button on it.

The CSRF check runs *before* the brand lookup, so a forged request is turned
away without costing a database round trip, and without its brand id being
usable to probe which brands exist.

## Serving it

The panel must not be on `links.scalaro.io`. That hostname is printed in
every marketing email and only serves the public paths — tracking, forms,
unsubscribe. The admin surface belongs on its own name:

```
mailer.scalaro.io    A    209.145.55.76
```

```bash
certbot certonly --standalone -d mailer.scalaro.io \
  --email yasinishfaq5@gmail.com --agree-tos --non-interactive
```

Then the server block in `deploy/nginx.conf` — the one commented out at the
bottom — proxies the whole host to `mailer-api:8080`.
