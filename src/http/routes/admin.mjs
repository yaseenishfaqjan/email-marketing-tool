/**
 * The admin panel.
 *
 * It drives the same functions the JSON API drives — nothing here reaches
 * into the database with logic of its own, and nothing bypasses a check the
 * API makes. A campaign sent from this panel goes through the same lint, the
 * same suppression filter and the same warm-up cap as one sent by curl.
 *
 * Cookie sessions rather than bearer tokens, because a token in a URL ends up
 * in browser history and nginx logs. CSRF on every POST, because one of them
 * sends mail to the whole list and that is not undoable.
 */

import express from 'express';
import config from '../../config.mjs';
import { query } from '../../db.mjs';
import { issue, clear, requireSession, requireCsrf, login } from '../admin/session.mjs';
import { loginPage } from '../admin/ui.mjs';
import * as pages from '../admin/pages.mjs';

import * as contactsRepo from '../../contacts/repo.mjs';
import { importCsv } from '../../contacts/import.mjs';
import { report as hygieneReport } from '../../contacts/hygiene.mjs';
import { parse as parseCsv } from 'csv-parse/sync';
import * as suppression from '../../suppression/repo.mjs';
import * as formsRepo from '../../forms/repo.mjs';
import { materialiseCampaign, CampaignStateError } from '../../campaigns/materialise.mjs';
import { lintCampaign } from '../../campaigns/lint.mjs';
import { lintContext } from '../../campaigns/lint-context.mjs';
import { previewCampaign } from '../../campaigns/preview.mjs';
import { compileTemplate, renderMessage } from '../../sending/renderer.mjs';
import { send } from '../../sending/provider.mjs';
import { deliverabilityHealth } from '../../reporting/queries.mjs';
import { status as warmupStatus } from '../../sending/warmup.mjs';

const router = express.Router();

// Forms, not JSON. The limit carries a pasted CSV, which is the largest thing
// this panel ever posts.
router.use(express.urlencoded({ extended: false, limit: '25mb' }));

/* ----------------------------------------------------------------- auth -- */

router.get('/login', (req, res) => {
  res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
});

router.post('/login', (req, res) => {
  const ip = req.ip ?? 'unknown';

  if (login.tooManyAttempts(ip)) {
    return res.status(429).type('html')
      .send(loginPage({ error: 'Too many attempts. Wait ten minutes.', next: safeNext(req.body?.next) }));
  }

  if (!login.matches(req.body?.token)) {
    login.recordAttempt(ip);
    return res.status(401).type('html')
      .send(loginPage({ error: 'That token is not right.', next: safeNext(req.body?.next) }));
  }

  login.clearAttempts(ip);
  issue(res);
  res.redirect(302, safeNext(req.body?.next));
});

router.get('/logout', (req, res) => {
  clear(res);
  res.redirect(302, '/admin/login');
});

/** Only ever redirect within this panel: an open redirect on a login page is
 *  how a convincing phishing link gets built. */
function safeNext(value) {
  const s = String(value ?? '');
  return s.startsWith('/admin') && !s.startsWith('//') ? s : '/admin';
}

/* --------------------------------------------------------------- shared -- */

router.use(requireSession);

const flashOf = (req) => (req.query.msg
  ? { text: String(req.query.msg).slice(0, 300), bad: req.query.bad === '1' }
  : null);

const back = (res, url, msg, bad = false) =>
  res.redirect(302, `${url}?msg=${encodeURIComponent(msg)}${bad ? '&bad=1' : ''}`);

async function allBrands() {
  const { rows } = await query('select * from brands order by name');
  return rows;
}

/**
 * Every brand-scoped page needs the brand and the switcher list.
 *
 * Ordered AFTER requireCsrf on the POST routes: a forged request should be
 * turned away before it costs a database round trip, and before its brand id
 * can be used to probe which ones exist.
 */
async function withBrand(req, res, next) {
  try {
    const brands = await allBrands();
    const brand = brands.find((b) => b.id === req.params.brandId);
    if (!brand) return res.status(404).send('No such brand.');
    req.brand = brand;
    req.brands = brands;
    next();
  } catch (err) { next(err); }
}

/* ------------------------------------------------------------- overview -- */

router.get('/', async (req, res, next) => {
  try {
    const brands = await allBrands();
    // One brand is the common case; making somebody choose from a list of one
    // is a click that teaches nothing.
    if (brands.length === 1) return res.redirect(302, `/admin/b/${brands[0].id}`);
    res.type('html').send(pages.brandsPage({ brands }));
  } catch (err) { next(err); }
});

router.get('/b/:brandId', withBrand, async (req, res, next) => {
  try {
    const health = await deliverabilityHealth({ brandId: req.brand.id, days: 30 });

    // warmupStatus() reports every brand; pick ours out rather than assuming
    // a per-brand overload that does not exist.
    let warmup = null;
    try {
      const all = await warmupStatus();
      warmup = (Array.isArray(all) ? all : all?.brands ?? []).find((w) => w.id === req.brand.id) ?? null;
    } catch { warmup = null; }

    const { rows: q } = await query(
      `select count(*) filter (where status = 'queued')::int  as queued,
              count(*) filter (where status = 'sending')::int as sending,
              count(*) filter (where status = 'failed' and queued_at > now() - interval '24 hours')::int as failed_24h,
              (extract(epoch from (now() - min(queued_at) filter (where status = 'queued'))) / 60)::int as oldest_minutes
         from messages where brand_id = $1`,
      [req.brand.id],
    );

    const campaigns = await campaignRows(req.brand.id, 8);

    res.type('html').send(pages.overviewPage({
      brand: req.brand, brands: req.brands, health, warmup,
      queue: q[0] ?? {}, campaigns, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

/** Campaigns with their counts, which is what anybody actually wants to see. */
async function campaignRows(brandId, limit = 100) {
  const { rows } = await query(
    `select c.id, c.name, c.subject, c.status, c.scheduled_at, c.sent_at, c.created_at,
            count(m.id)::int                                        as recipients,
            count(m.id) filter (where m.status = 'delivered')::int   as delivered,
            count(m.id) filter (where m.status = 'bounced')::int     as bounced,
            count(distinct e.message_id) filter (where e.type = 'open')::int as opened
       from campaigns c
       left join messages m on m.campaign_id = c.id
       left join message_events e on e.message_id = m.id and e.type = 'open'
      where c.brand_id = $1
      group by c.id
      order by c.created_at desc
      limit $2`,
    [brandId, limit],
  );
  return rows;
}

/* ------------------------------------------------------------ campaigns -- */

router.get('/b/:brandId/campaigns', withBrand, async (req, res, next) => {
  try {
    const { rows: templates } = await query(
      'select id, name, description from templates where brand_id = $1 or is_starter order by is_starter, name',
      [req.brand.id],
    );
    res.type('html').send(pages.campaignsPage({
      brand: req.brand, brands: req.brands,
      campaigns: await campaignRows(req.brand.id),
      templates, csrf: req.csrf, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

router.post('/b/:brandId/campaigns', requireCsrf, withBrand, async (req, res, next) => {
  const base = `/admin/b/${req.brand.id}/campaigns`;
  try {
    const { name, subject, template_id } = req.body;
    if (!name || !subject) return back(res, base, 'A name and a subject are both required.', true);

    const { rows: t } = await query(
      'select * from templates where id = $1 and (brand_id = $2 or is_starter)',
      [template_id, req.brand.id],
    );
    if (!t[0]) return back(res, base, 'That template no longer exists.', true);

    const { rows } = await query(
      `insert into campaigns (brand_id, name, subject, preheader, mjml, template_id)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [req.brand.id, name, subject, t[0].preheader, t[0].mjml, t[0].id],
    );
    res.redirect(302, `${base}/${rows[0].id}`);
  } catch (err) { next(err); }
});

async function loadCampaign(brandId, id) {
  const { rows } = await query('select * from campaigns where id = $1 and brand_id = $2', [id, brandId]);
  return rows[0] ?? null;
}

router.get('/b/:brandId/campaigns/:id', withBrand, async (req, res, next) => {
  try {
    const campaign = await loadCampaign(req.brand.id, req.params.id);
    if (!campaign) return res.status(404).send('No such campaign.');

    const lint = lintCampaign(campaign, await lintContext(req.brand.id));
    const { rows: stats } = await query(
      `select count(*)::int as recipients,
              count(*) filter (where status = 'delivered')::int  as delivered,
              count(*) filter (where status = 'bounced')::int    as bounced,
              count(*) filter (where status = 'complained')::int as complained
         from messages where campaign_id = $1`,
      [campaign.id],
    );
    const { rows: eng } = await query(
      `select count(distinct message_id) filter (where type = 'open')::int  as opened,
              count(distinct message_id) filter (where type = 'click')::int as clicked
         from message_events e
        where exists (select 1 from messages m where m.id = e.message_id and m.campaign_id = $1)`,
      [campaign.id],
    );

    res.type('html').send(pages.campaignEditorPage({
      brand: req.brand, brands: req.brands, campaign, lint,
      stats: { ...stats[0], ...eng[0] }, csrf: req.csrf, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

router.post('/b/:brandId/campaigns/:id', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/campaigns/${req.params.id}`;
  try {
    const { rows } = await query(
      `update campaigns set subject = $3, preheader = $4, mjml = $5, updated_at = now()
        where id = $1 and brand_id = $2 and status in ('draft','paused')
        returning id`,
      [req.params.id, req.brand.id, req.body.subject, req.body.preheader || null, req.body.mjml],
    );
    if (!rows[0]) return back(res, url, 'Only a draft or paused campaign can be edited.', true);
    back(res, url, 'Saved.');
  } catch (err) { next(err); }
});

/** The iframe's source. Its own route so the editor page stays cacheable. */
router.get('/b/:brandId/campaigns/:id/preview.html', withBrand, async (req, res, next) => {
  try {
    const campaign = await loadCampaign(req.brand.id, req.params.id);
    if (!campaign) return res.status(404).send('No such campaign.');
    const preview = await previewCampaign({ brand: req.brand, campaign, contactId: null });
    // The preview is the campaign's own HTML, which an author controls. It is
    // sandboxed by the iframe and served on the admin host only.
    res.type('html').send(preview.html);
  } catch (err) { next(err); }
});

router.post('/b/:brandId/campaigns/:id/test', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/campaigns/${req.params.id}`;
  try {
    const campaign = await loadCampaign(req.brand.id, req.params.id);
    if (!campaign) return res.status(404).send('No such campaign.');

    const to = String(req.body.to ?? '').trim();
    if (!contactsRepo.isValidEmail(to)) return back(res, url, 'That does not look like an email address.', true);

    const rendered = renderMessage({
      brand: { ...req.brand, ...campaign },
      contact: { email: to, first_name: '', last_name: '', attrs: {} },
      // A zero uuid keeps the tracking links syntactically valid while
      // pointing at a row that does not exist, so a test never shows up in
      // the campaign's numbers.
      messageId: '00000000-0000-0000-0000-000000000000',
      subject: `[TEST] ${campaign.subject}`,
      compiledHtml: compileTemplate(campaign.mjml),
    });

    await send({
      fromName: req.brand.from_name,
      fromEmail: req.brand.from_email,
      to,
      replyTo: req.brand.reply_to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      unsubscribeUrl: rendered.unsubscribeUrl,
      from: req.brand.from_email,
      configurationSet: req.brand.ses_config_set,
    });

    back(res, url, `Test sent to ${to}.`);
  } catch (err) {
    back(res, `/admin/b/${req.brand.id}/campaigns/${req.params.id}`, `Test failed: ${err.message}`, true);
  }
});

router.post('/b/:brandId/campaigns/:id/send', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/campaigns/${req.params.id}`;
  try {
    const campaign = await loadCampaign(req.brand.id, req.params.id);
    if (!campaign) return res.status(404).send('No such campaign.');

    // The same gate the API applies. The panel's button is disabled when lint
    // fails, but a disabled button is a suggestion, not a control.
    const lint = lintCampaign(campaign, await lintContext(req.brand.id));
    if (!lint.ok) return back(res, url, 'This campaign still has errors that cannot be undone once sent.', true);

    const { recipients } = await materialiseCampaign(campaign.id);
    back(res, url, recipients > 0
      ? `Queued for ${recipients.toLocaleString('en-US')} recipients. The worker is draining it now.`
      : 'Nobody matched — nothing was queued.');
  } catch (err) {
    if (err instanceof CampaignStateError) {
      return back(res, `/admin/b/${req.brand.id}/campaigns/${req.params.id}`, err.message, true);
    }
    next(err);
  }
});

router.post('/b/:brandId/campaigns/:id/pause', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/campaigns/${req.params.id}`;
  try {
    const { rows } = await query(
      `update messages set status = 'skipped', error = 'campaign paused'
        where campaign_id = $1 and status = 'queued' returning id`,
      [req.params.id],
    );
    await query(
      `update campaigns set status = 'paused', updated_at = now()
        where id = $1 and brand_id = $2 and status in ('sending','scheduled')`,
      [req.params.id, req.brand.id],
    );
    back(res, url, `Paused. ${rows.length} held back; anything already sent cannot be recalled.`);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- contacts -- */

router.get('/b/:brandId/contacts', withBrand, async (req, res, next) => {
  try {
    const limit = 50;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const contacts = await contactsRepo.list(req.brand.id, {
      status: req.query.status || undefined,
      search: req.query.q || undefined,
      limit, offset,
    });
    res.type('html').send(pages.contactsPage({
      brand: req.brand, brands: req.brands, contacts,
      q: req.query.q, status: req.query.status, offset, limit,
      csrf: req.csrf, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

router.get('/b/:brandId/contacts/import', withBrand, (req, res) => {
  res.type('html').send(pages.importPage({
    brand: req.brand, brands: req.brands, dryRun: null, csv: '',
    csrf: req.csrf, flash: flashOf(req),
  }));
});

router.post('/b/:brandId/contacts/import', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/contacts`;
  const csv = String(req.body.csv ?? '');
  try {
    if (!csv.trim()) return back(res, `${url}/import`, 'Paste a CSV first.', true);

    // Two posts, one handler: the first checks, the second writes. Nothing is
    // written until somebody has seen the numbers and said yes.
    if (req.body.confirm !== 'yes') {
      const dryRun = await dryRunCsv(req.brand.id, csv);
      if (dryRun.error) return back(res, `${url}/import`, dryRun.error, true);
      return res.type('html').send(pages.importPage({
        brand: req.brand, brands: req.brands, dryRun, csv,
        csrf: req.csrf, flash: null,
      }));
    }

    const report = await importCsv(csv, {
      brandId: req.brand.id,
      source: `admin:${new Date().toISOString().slice(0, 10)}`,
      consentSource: String(req.body.consent ?? '').slice(0, 200) || null,
    });
    back(res, url, `Imported ${report.imported ?? 0}, updated ${report.updated ?? 0}, skipped ${report.skipped ?? 0}.`);
  } catch (err) {
    back(res, `${url}/import`, err.message.slice(0, 200), true);
  }
});

/** The same checks the API's dry-run endpoint runs. */
async function dryRunCsv(brandId, csv) {
  const records = parseCsv(csv, { skip_empty_lines: true, relax_column_count: true, bom: true });
  if (!records.length) return { error: 'That CSV is empty.' };

  const header = records[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const emailAt = header.findIndex((h) => ['email', 'email_address', 'e-mail', 'mail'].includes(h));
  if (emailAt === -1) return { error: 'No email column found. The header row needs a column called "email".' };

  const emails = records.slice(1).map((r) => r[emailAt]);
  const { counts, samples, verdict } = hygieneReport(emails);

  const { rows } = await query(
    `select count(*)::int as n from suppressions
      where (brand_id is null or brand_id = $1) and email = any($2::citext[])`,
    [brandId, emails.filter((e) => typeof e === 'string').map((e) => e.trim().toLowerCase())],
  );

  return {
    counts: { ...counts, already_suppressed: rows[0].n },
    samples, verdict,
    would_import: Math.max(0, counts.valid - rows[0].n),
  };
}

/* ---------------------------------------------------------- suppression -- */

router.get('/b/:brandId/suppressions', withBrand, async (req, res, next) => {
  try {
    res.type('html').send(pages.suppressionsPage({
      brand: req.brand, brands: req.brands,
      rows: await suppression.list(req.brand.id, { limit: 200 }),
      csrf: req.csrf, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

router.post('/b/:brandId/suppressions', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/suppressions`;
  try {
    const email = String(req.body.email ?? '').trim();
    if (!contactsRepo.isValidEmail(email)) return back(res, url, 'That does not look like an email address.', true);
    await suppression.suppress({
      brandId: req.body.global === 'yes' ? null : req.brand.id,
      email: contactsRepo.normaliseEmail(email),
      reason: 'manual',
      note: String(req.body.note ?? '').slice(0, 300) || null,
    });
    back(res, url, `${email} will not be sent to.`);
  } catch (err) { next(err); }
});

router.post('/b/:brandId/suppressions/remove', requireCsrf, withBrand, async (req, res, next) => {
  const url = `/admin/b/${req.brand.id}/suppressions`;
  try {
    const email = contactsRepo.normaliseEmail(String(req.body.email ?? ''));
    const removed = await suppression.unsuppress(req.brand.id, email);
    back(res, url, removed
      ? `${email} removed. They will receive mail again.`
      : `${email} was not on this brand's list — a global suppression is removed from the brand that owns it.`, !removed);
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- forms -- */

router.get('/b/:brandId/forms', withBrand, async (req, res, next) => {
  try {
    const { rows } = await query(
      'select id, name, status, double_optin from forms where brand_id = $1 order by created_at desc',
      [req.brand.id],
    );
    res.type('html').send(pages.formsPage({
      brand: req.brand, brands: req.brands, forms: rows,
      publicUrl: req.brand.tracking_domain ? `https://${req.brand.tracking_domain}` : config.publicUrl,
      flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------- automations -- */

router.get('/b/:brandId/automations', withBrand, async (req, res, next) => {
  try {
    const { rows } = await query(
      `select a.id, a.name, a.status, a.trigger_type, a.trigger_config,
              (select count(*)::int from automation_steps s where s.automation_id = a.id) as step_count,
              (select count(*)::int from automation_runs r where r.automation_id = a.id and r.status = 'active') as active_runs
         from automations a where a.brand_id = $1 order by a.created_at desc`,
      [req.brand.id],
    );
    res.type('html').send(pages.automationsPage({
      brand: req.brand, brands: req.brands, automations: rows, flash: flashOf(req),
    }));
  } catch (err) { next(err); }
});

export default router;
