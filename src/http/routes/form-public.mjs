/**
 * The public face of a signup form: the embed script, the submit endpoint and
 * the confirmation link.
 *
 * All three are reachable by anybody, from any page, so each one is written
 * assuming hostile traffic: an origin allowlist, a honeypot, a per-IP rate
 * limit, and answers that never reveal whether a given address is on the list.
 */

import express from 'express';
import config from '../../config.mjs';
import * as forms from '../../forms/repo.mjs';
import { buildEmbedScript, confirmationPage } from '../../forms/embed.mjs';
import { query } from '../../db.mjs';

const router = express.Router();

/* -------------------------------------------------------- rate limiting -- */

const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

function rateLimit(req, res, next) {
  const key = `${req.ip}|${req.params.formId}`;
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
  } else if (++entry.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  if (hits.size > 20_000) {
    for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  }
  next();
}

/* ---------------------------------------------------------------- CORS -- */

/**
 * The allowlist is per form and it fails closed: a form with no origins
 * configured accepts nothing. An open form is a brand's list filled with
 * whatever the internet feels like putting in it.
 */
function corsFor(form, req, res) {
  const origin = req.get('origin');
  if (!forms.originAllowed(form, origin)) return false;
  res.set({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  return true;
}

/* --------------------------------------------------------- embed script -- */

router.get('/f/:formId.js', async (req, res, next) => {
  try {
    const form = await forms.getPublic(req.params.formId);
    if (!form || form.status !== 'active') {
      // Valid JavaScript either way: a 404 body executed as a script throws a
      // syntax error in the console of somebody's marketing site.
      res.type('application/javascript');
      return res.send('/* form not found */');
    }
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',   // a <script> tag, readable by design
    });
    res.send(buildEmbedScript(form, publicBase(form)));
  } catch (err) { next(err); }
});

const publicBase = (form) =>
  (form.tracking_domain ? `https://${form.tracking_domain}` : config.publicUrl);

/* --------------------------------------------------------------- submit -- */

router.options('/f/:formId', async (req, res) => {
  const form = await forms.getPublic(req.params.formId);
  if (!form || !corsFor(form, req, res)) return res.status(403).end();
  res.status(204).end();
});

router.post('/f/:formId', express.json({ limit: '32kb' }), rateLimit, async (req, res, next) => {
  try {
    const form = await forms.getPublic(req.params.formId);
    if (!form || form.status !== 'active') return res.status(404).json({ error: 'This form is not available.' });
    if (!corsFor(form, req, res)) {
      return res.status(403).json({ error: 'This form is not enabled for this site.' });
    }

    const body = req.body ?? {};

    // Honeypot. Answered as success so the bot has nothing to learn from.
    if (body.website || body.url_field) {
      return res.json({ ok: true, message: form.success_message });
    }

    const result = await forms.submit({
      form,
      email: body.email,
      fields: {
        first_name: typeof body.first_name === 'string' ? body.first_name.slice(0, 100) : null,
        last_name: typeof body.last_name === 'string' ? body.last_name.slice(0, 100) : null,
      },
      ip: req.ip ?? null,
      userAgent: (req.get('user-agent') || '').slice(0, 300),
      referer: (req.get('referer') || '').slice(0, 500),
    });

    // Identical answer whatever happened underneath — confirmation sent,
    // already pending, or silently blocked. A public form must not become a
    // way to test who is on somebody's list.
    res.json({ ok: true, message: form.success_message, redirect: form.redirect_url ?? null });
    void result;
  } catch (err) {
    if (err instanceof forms.FormError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/* ---------------------------------------------------------- confirmation -- */

/**
 * GET confirms.
 *
 * This is the opposite of the unsubscribe rule, and deliberately so. An
 * unsubscribe link must not act on GET because scanners prefetch it and would
 * empty the list. A confirmation link acting on a prefetch can only ever add
 * somebody who already asked — and requiring a second click here loses real
 * subscribers to confusion. The safe direction differs, so the design does.
 */
router.get('/confirm/:token', async (req, res, next) => {
  try {
    const submissionId = forms.readConfirmToken(req.params.token);
    if (!submissionId) {
      return res.status(400).send(confirmationPage({
        heading: 'This link is not valid',
        body: 'It may have been mistyped or truncated by your email client. Please sign up again.',
      }));
    }

    const result = await forms.confirm({ submissionId, ip: req.ip ?? null });

    if (!result.confirmed) {
      const messages = {
        expired: ['This link has expired', 'Confirmation links are valid for seven days. Please sign up again.'],
        blocked: ['This address cannot be subscribed', 'Please contact us if you think this is a mistake.'],
        'not found': ['This link is not valid', 'Please sign up again.'],
      };
      const [heading, body] = messages[result.reason] ?? messages['not found'];
      return res.status(410).send(confirmationPage({ heading, body }));
    }

    // Welcome sequences run after the transaction commits, so they read the
    // confirmed status rather than the pre-commit one.
    forms.enrolAfterConfirm(result);

    if (result.redirect) return res.redirect(302, result.redirect);

    const { rows } = await query(
      'select b.name from brands b join forms f on f.brand_id = b.id where f.id = (select form_id from form_submissions where id = $1)',
      [submissionId],
    );

    res.send(confirmationPage({
      heading: result.already ? "You're already subscribed" : "You're subscribed",
      body: result.already
        ? 'This address was confirmed earlier. Nothing more to do.'
        : 'Thank you for confirming. You can unsubscribe from any email we send.',
      brandName: rows[0]?.name ?? '',
    }));
  } catch (err) { next(err); }
});

export default router;
