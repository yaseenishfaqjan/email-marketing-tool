/**
 * The three public links that appear in every email: open pixel, click
 * redirect, unsubscribe.
 *
 * None of them can require a login — they are opened from a stranger's inbox.
 * All three therefore carry a signed token rather than an id, and all three
 * answer identically whether the token was good or not. A scanner probing
 * /u/<random> must learn nothing.
 */

import express from 'express';
import { verify } from '../../tokens.mjs';
import { query } from '../../db.mjs';
import { urlDigest } from '../../sending/renderer.mjs';
import { suppress } from '../../suppression/repo.mjs';

const router = express.Router();

// A 1x1 transparent GIF, served whatever happens.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const sendPixel = (res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.end(PIXEL);
};

/* --------------------------------------------------------------- opens -- */

router.get('/o/:token', async (req, res) => {
  sendPixel(res);   // answer first; the recording is best-effort

  const data = verify('o', req.params.token);
  if (!data?.m) return;

  try {
    await query(
      `insert into message_events (message_id, type, meta)
       select $1, 'open', $2
        where exists (select 1 from messages where id = $1)`,
      [data.m, JSON.stringify({ ua: (req.get('user-agent') || '').slice(0, 200) })],
    );
  } catch {
    // An unreadable open is not worth an error log per scanner hit.
  }
});

/* -------------------------------------------------------------- clicks -- */

router.get('/c/:token', async (req, res) => {
  const data = verify('c', req.params.token);
  const url = typeof req.query.u === 'string' ? req.query.u : null;

  // The token carries a digest of the link that was in the email. A mismatch
  // means somebody changed ?u= — refuse rather than redirect.
  if (!data?.m || !url || data.h !== urlDigest(url)) {
    return res.status(400).send('This link is not valid.');
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).send('This link is not valid.');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).send('This link is not valid.');
  }

  res.redirect(302, target.toString());

  try {
    await query(
      `insert into message_events (message_id, type, url)
       select $1, 'click', $2
        where exists (select 1 from messages where id = $1)`,
      [data.m, url.slice(0, 2000)],
    );
  } catch {
    // Same: a lost click is not worth failing the redirect the reader wanted.
  }
});

/* -------------------------------------------------------- unsubscribes -- */

/**
 * GET shows a confirmation page. It does NOT unsubscribe.
 *
 * Corporate mail scanners and link-preview bots fetch every URL in an email
 * before the recipient ever sees it. A GET that unsubscribes would quietly
 * empty the list — this is one of the most common and most expensive mistakes
 * in this whole domain.
 */
router.get('/u/:token', (req, res) => {
  const data = verify('u', req.params.token);
  if (!data?.m) return res.status(400).send(page('This link is not valid.', ''));

  res.send(page(
    'Unsubscribe',
    `<p>Click below to stop receiving these emails.</p>
     <form method="post" action="/u/${encodeURIComponent(req.params.token)}">
       <button type="submit">Unsubscribe me</button>
     </form>`,
  ));
});

/**
 * POST does the work, and is also what a one-click unsubscribe sends: the
 * List-Unsubscribe-Post header tells Gmail and Yahoo to POST here when the
 * reader uses their client's own unsubscribe button.
 */
router.post('/u/:token', async (req, res) => {
  const data = verify('u', req.params.token);
  if (!data?.m) return res.status(400).send(page('This link is not valid.', ''));

  try {
    const { rows } = await query(
      `select m.id, m.brand_id, c.id as contact_id, c.email
         from messages m join contacts c on c.id = m.contact_id
        where m.id = $1`,
      [data.m],
    );
    const row = rows[0];

    // Already gone, or the message was deleted: still say yes. Telling somebody
    // their unsubscribe did not work is how you get a spam complaint instead.
    if (row) {
      await query(
        "update contacts set status = 'unsubscribed', updated_at = now() where id = $1",
        [row.contact_id],
      );
      await suppress({ brandId: row.brand_id, email: row.email, reason: 'unsubscribe' });
      await query(
        "insert into message_events (message_id, type) values ($1, 'unsubscribe')",
        [row.id],
      );
    }
  } catch (err) {
    console.error('[unsubscribe] %s', err.message);
  }

  res.send(page('You have been unsubscribed.', '<p>You will not receive further emails from this list.</p>'));
});

function page(heading, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>
  body{font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;background:#f7f5f1;color:#141210;
       margin:0;padding:48px 16px;display:flex;justify-content:center}
  main{background:#fff;border:1px solid #e2dcd2;border-radius:8px;padding:32px;max-width:480px;width:100%}
  h1{font-size:22px;font-weight:600;margin:0 0 12px}
  p{color:#4a443d;line-height:1.6}
  button{background:#141210;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;cursor:pointer}
</style></head>
<body><main><h1>${heading}</h1>${body}</main></body></html>`;
}

export default router;
