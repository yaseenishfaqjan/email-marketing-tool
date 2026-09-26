/**
 * The composer and the reports: templates, preview, and the numbers that
 * decide whether the sending account survives.
 */

import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const DB_AVAILABLE = await (async () => {
  try {
    const { query } = await import('../src/db.mjs');
    await query('select 1 from templates limit 1');
    return true;
  } catch {
    return false;
  }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { query, close } = await import('../src/db.mjs');
const { createApp } = await import('../src/app.mjs');
const templates = await import('../src/templates/repo.mjs');
const { previewCampaign, sampleContacts } = await import('../src/campaigns/preview.mjs');
const reports = await import('../src/reporting/queries.mjs');
const { _internals: renderInternals } = await import('../src/sending/renderer.mjs');

let server;
let base;
const ADMIN = { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' };

const resetTestData = async () => {
  await query("delete from brands where slug like 'ctest-%'");
};

test.before(async () => {
  if (!DB_AVAILABLE) return;
  await resetTestData();
  await templates.installStarters();
  server = createApp({ logErrors: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!DB_AVAILABLE) return;
  await resetTestData().catch(() => {});
  await new Promise((r) => server.close(r));
  await close();
});

async function freshBrand(slug) {
  await query('delete from brands where slug = $1', [slug]);
  const { rows } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address, tracking_domain)
     values ($1,$1,'Test','hello@mail.c.test','mail.c.test','1 Test St','links.c.test') returning *`,
    [slug],
  );
  return rows[0];
}

const MJML = (inner) =>
  `<mjml><mj-body><mj-section><mj-column>${inner}</mj-column></mj-section></mj-body></mjml>`;

/* ------------------------------------------------------------- templates -- */

suite('every brand starts with a usable library it did not have to write', async () => {
  const brand = await freshBrand('ctest-library');
  const list = await templates.list(brand.id);

  assert.ok(list.length >= 4);
  assert.ok(list.every((t) => t.is_starter), 'a new brand sees only starters');
  assert.ok(list.some((t) => t.category === 'newsletter'));
  assert.ok(list.some((t) => t.category === 'transactional'));
});

suite('a starter cannot be edited, only copied', async () => {
  // Otherwise one brand editing a starter changes it for all of them.
  const brand = await freshBrand('ctest-starter');
  // list() omits the bodies to keep listings small, so fetch the full row.
  const [listed] = await templates.list(brand.id);
  const starter = await templates.get(brand.id, listed.id);

  await assert.rejects(
    () => templates.update(brand.id, starter.id, { mjml: MJML('<mj-text>mine</mj-text>') }),
    /cannot be edited/,
  );

  const copy = await templates.copy(brand.id, starter.id);
  assert.equal(copy.brand_id, brand.id);
  assert.equal(copy.is_starter, false);
  assert.equal(copy.mjml, starter.mjml);

  const edited = await templates.update(brand.id, copy.id, { subject: 'Mine now' });
  assert.equal(edited.subject, 'Mine now');
});

suite('copying twice finds a free name instead of failing', async () => {
  const brand = await freshBrand('ctest-copytwice');
  const [starter] = await templates.list(brand.id);
  const a = await templates.copy(brand.id, starter.id);
  const b = await templates.copy(brand.id, starter.id);
  assert.notEqual(a.name, b.name);
});

suite('one brand cannot see or touch another brand\'s templates', async () => {
  const mine = await freshBrand('ctest-mine');
  const theirs = await freshBrand('ctest-theirs');

  const secret = await templates.create(theirs.id, { name: 'Secret', mjml: MJML('<mj-text>x</mj-text>') });

  assert.equal(await templates.get(mine.id, secret.id), null);
  const visible = await templates.list(mine.id);
  assert.ok(!visible.some((t) => t.id === secret.id));
  assert.equal(await templates.remove(mine.id, secret.id), false);
});

suite('a template that does not compile is refused at save time', async () => {
  const brand = await freshBrand('ctest-badtemplate');
  await assert.rejects(
    () => templates.create(brand.id, { name: 'Broken', mjml: 'not mjml <<<' }),
    templates.TemplateError,
  );
});

suite('a campaign can be built from a template in one call', async () => {
  const brand = await freshBrand('ctest-fromtemplate');
  const [listed] = await templates.list(brand.id);
  const starter = await templates.get(brand.id, listed.id);

  const res = await fetch(`${base}/v1/brands/${brand.id}/campaigns`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ name: 'From template', template_id: starter.id }),
  });
  assert.equal(res.status, 201);

  const { campaign } = await res.json();
  assert.equal(campaign.mjml, starter.mjml);
  assert.equal(campaign.subject, starter.subject);
  assert.equal(campaign.preheader, starter.preheader);
  assert.equal(campaign.template_id, starter.id);
});

/* --------------------------------------------------------------- preview -- */

suite('preview renders against a real contact, not an invented one', async () => {
  const brand = await freshBrand('ctest-preview');
  const { rows: [contact] } = await query(
    `insert into contacts (brand_id, email, first_name, status, source, attrs)
     values ($1,'real@c.test','Grace','subscribed','test','{"plan":"pro"}') returning *`,
    [brand.id],
  );

  const preview = await previewCampaign({
    brand,
    campaign: {
      subject: 'Hello {{first_name}}',
      preheader: 'Your {{attrs.plan}} plan',
      mjml: MJML('<mj-text>Hi {{first_name}}, on {{attrs.plan}}. <a href="https://scalaro.io/x">Go</a></mj-text>'),
    },
    contactId: contact.id,
  });

  assert.equal(preview.subject, 'Hello Grace');
  assert.match(preview.html, /Hi Grace, on pro/);
  assert.deepEqual(preview.links, ['https://scalaro.io/x']);
});

suite('a preview cannot pollute a campaign\'s numbers', async () => {
  // Its tracking links are valid but point at a message row that does not exist.
  const brand = await freshBrand('ctest-nopollute');
  const preview = await previewCampaign({
    brand,
    campaign: { subject: 'S', mjml: MJML('<mj-text><a href="https://scalaro.io">go</a></mj-text>') },
  });

  const messageId = preview.html.match(/\/o\/([^"]+)"/)?.[1];
  assert.ok(messageId);

  const { verify } = await import('../src/tokens.mjs');
  assert.equal(verify('o', messageId).m, '00000000-0000-0000-0000-000000000000');

  const { rows } = await query('select 1 from messages where id = $1',
    ['00000000-0000-0000-0000-000000000000']);
  assert.equal(rows.length, 0, 'the preview message id must match no real row');
});

suite('sample contacts put the awkward ones first', async () => {
  // A template that looks right with "Ada" in it falls over on the row with no
  // first name, and an imported list is full of those.
  const brand = await freshBrand('ctest-samples');
  await query(
    `insert into contacts (brand_id, email, first_name, status, source) values
       ($1,'named@c.test','Ada','subscribed','test'),
       ($1,'nameless@c.test',null,'subscribed','test')`,
    [brand.id]);

  const samples = await sampleContacts(brand.id, 5);
  assert.equal(samples[0].email, 'nameless@c.test');
});

/* ------------------------------------------------------------- preheader -- */

suite('the preheader is injected hidden, and padded so it is not extended', () => {
  const html = renderInternals.injectPreheader(
    '<html><body><p>The real body text starts here.</p></body></html>',
    'The line the inbox shows.',
  );
  assert.match(html, /display:none/);
  assert.match(html, /The line the inbox shows\./);
  // Without the padding, clients keep scraping and append the body's first
  // words to the preview.
  assert.ok((html.match(/&#8204;/g) ?? []).length > 20);
  assert.ok(html.indexOf('The line the inbox shows') < html.indexOf('The real body text'));
});

suite('no preheader means no injected markup at all', () => {
  const html = '<html><body><p>Body</p></body></html>';
  assert.equal(renderInternals.injectPreheader(html, ''), html);
});

/* --------------------------------------------------------------- reports -- */

/** A campaign with a known, hand-built set of outcomes to report on. */
async function campaignWithResults(brand, outcomes) {
  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml, status, sent_at)
     values ($1,'Report','S',$2,'sent', now() - interval '2 hours') returning *`,
    [brand.id, MJML('<mj-text>x</mj-text>')],
  );

  for (const [i, o] of outcomes.entries()) {
    const { rows: [contact] } = await query(
      `insert into contacts (brand_id, email, status, source)
       values ($1,$2,'subscribed','test') returning *`,
      [brand.id, o.email ?? `r${i}@${o.domain ?? 'c.test'}`],
    );
    const { rows: [message] } = await query(
      `insert into messages (brand_id, contact_id, campaign_id, status, sent_at)
       values ($1,$2,$3,$4, now() - interval '2 hours') returning *`,
      [brand.id, contact.id, campaign.id, o.status],
    );
    for (const event of o.events ?? []) {
      await query(
        `insert into message_events (message_id, type, url, at)
         values ($1,$2,$3, now() - interval '1 hour')`,
        [message.id, event.type, event.url ?? null]);
    }
  }
  return campaign;
}

suite('campaign rates are measured against delivered, not against sent', async () => {
  // Against sent, a list full of dead addresses flatters itself.
  const brand = await freshBrand('ctest-rates');
  const campaign = await campaignWithResults(brand, [
    { status: 'delivered', events: [{ type: 'open' }, { type: 'click', url: 'https://a.example' }] },
    { status: 'delivered', events: [{ type: 'open' }] },
    { status: 'bounced' },
    { status: 'bounced' },
  ]);

  const report = await reports.campaignReport(campaign.id);
  assert.equal(report.counts.sent, 4);
  assert.equal(report.counts.delivered, 2);
  assert.equal(report.counts.opened, 2);
  assert.equal(report.counts.clicked, 1);

  assert.equal(report.rates.opened, 100, '2 opens of 2 delivered');
  assert.equal(report.rates.clicked, 50);
  assert.equal(report.rates.bounced, 50);
  // Of those who opened, how many acted — the number worth optimising.
  assert.equal(report.rates.click_to_open, 50);
});

suite('repeat opens by one reader count once', async () => {
  const brand = await freshBrand('ctest-unique');
  const campaign = await campaignWithResults(brand, [
    { status: 'delivered', events: [{ type: 'open' }, { type: 'open' }, { type: 'open' }] },
  ]);
  const report = await reports.campaignReport(campaign.id);
  assert.equal(report.counts.opened, 1);
});

suite('the link report shows which links people actually clicked', async () => {
  const brand = await freshBrand('ctest-links');
  const campaign = await campaignWithResults(brand, [
    { status: 'delivered', events: [{ type: 'click', url: 'https://a.example' }] },
    { status: 'delivered', events: [{ type: 'click', url: 'https://a.example' }] },
    { status: 'delivered', events: [{ type: 'click', url: 'https://b.example' }] },
  ]);

  const { links, total_unique_clicks } = await reports.linkReport(campaign.id);
  assert.equal(total_unique_clicks, 3);
  assert.equal(links[0].url, 'https://a.example');
  assert.equal(links[0].unique_clicks, 2);
  assert.equal(links[0].share, 66.67);
});

suite('the provider breakdown exposes a problem at one mailbox provider', async () => {
  // Gmail fine and Outlook silent is an authentication problem at one
  // provider, and it is invisible in the overall rate.
  const brand = await freshBrand('ctest-providers');
  const outcomes = [];
  for (let i = 0; i < 6; i += 1) {
    outcomes.push({ domain: 'gmail.com', status: 'delivered', events: [{ type: 'open' }] });
  }
  for (let i = 0; i < 6; i += 1) outcomes.push({ domain: 'outlook.com', status: 'bounced' });
  const campaign = await campaignWithResults(brand, outcomes);

  const { domains } = await reports.providerBreakdown(campaign.id);
  const gmail = domains.find((d) => d.domain === 'gmail.com');
  const outlook = domains.find((d) => d.domain === 'outlook.com');

  assert.equal(gmail.rates.opened, 100);
  assert.equal(outlook.rates.bounced, 100);
});

suite('a domain with too few recipients is left out rather than reported as noise', async () => {
  const brand = await freshBrand('ctest-noise');
  const campaign = await campaignWithResults(brand, [
    { domain: 'tiny.example', status: 'delivered', events: [{ type: 'open' }] },
  ]);
  const { domains } = await reports.providerBreakdown(campaign.id);
  assert.equal(domains.length, 0, 'one recipient at 100% opens is not a statistic');
});

suite('deliverability health judges each brand against the SES thresholds', async () => {
  const brand = await freshBrand('ctest-health');
  const outcomes = [];
  // 300 sends, 30 bounced: 10%, the level at which SES pauses the account.
  for (let i = 0; i < 270; i += 1) outcomes.push({ status: 'delivered' });
  for (let i = 0; i < 30; i += 1) outcomes.push({ status: 'bounced' });
  await campaignWithResults(brand, outcomes);

  const health = await reports.deliverabilityHealth({ brandId: brand.id, days: 30 });
  const row = health.brands[0];

  assert.equal(row.sent, 300);
  assert.equal(row.rates.bounce, 10);
  assert.equal(row.status.level, 'critical');
  assert.match(row.status.message, /pauses sending/);
  // The thresholds are account-level, and the report says so.
  assert.match(health.account.thresholds.note, /whole account/);
});

suite('health says so plainly when there is not enough data to judge', async () => {
  // One bounce in fifty is 2%, which means nothing.
  const brand = await freshBrand('ctest-tiny');
  await campaignWithResults(brand, [{ status: 'bounced' }, { status: 'delivered' }]);

  const health = await reports.deliverabilityHealth({ brandId: brand.id });
  assert.equal(health.brands[0].status.level, 'insufficient_data');
});

suite('list growth shows which source is spending the shared reputation', async () => {
  const brand = await freshBrand('ctest-growth');
  await query(
    `insert into contacts (brand_id, email, status, source) values
       ($1,'a@c.test','subscribed','form:pricing'),
       ($1,'b@c.test','subscribed','form:pricing'),
       ($1,'c@c.test','bounced','import:old-list'),
       ($1,'d@c.test','bounced','import:old-list'),
       ($1,'e@c.test','subscribed','import:old-list')`,
    [brand.id]);

  const growth = await reports.listGrowth(brand.id, { days: 30 });
  const form = growth.sources.find((s) => s.source === 'form:pricing');
  const imported = growth.sources.find((s) => s.source === 'import:old-list');

  assert.equal(form.bounce_rate, 0);
  assert.equal(imported.bounce_rate, 66.67);
  assert.equal(form.retention, 100);
});

/* ----------------------------------------------------------------- gates -- */

suite('the linter blocks a send that cannot be undone', async () => {
  const brand = await freshBrand('ctest-gate');
  await query(
    `insert into contacts (brand_id, email, status, source)
     values ($1,'someone@c.test','subscribed','test')`, [brand.id]);

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml)
     values ($1,'Broken','Hi {{frist_name}}',$2) returning *`,
    [brand.id, MJML('<mj-text><a href="http://localhost:3000/x">go</a></mj-text>')],
  );

  const blocked = await fetch(`${base}/v1/brands/${brand.id}/campaigns/${campaign.id}/send`,
    { method: 'POST', headers: ADMIN });
  assert.equal(blocked.status, 422);

  const body = await blocked.json();
  const codes = body.errors.map((e) => e.code);
  assert.ok(codes.includes('unknown_merge_field'));
  assert.ok(codes.includes('local_link'));

  const { rows } = await query('select count(*)::int as n from messages where campaign_id = $1',
    [campaign.id]);
  assert.equal(rows[0].n, 0, 'nothing may be queued while it is blocked');

  // The linter advises; it does not overrule the person writing the email.
  const forced = await fetch(`${base}/v1/brands/${brand.id}/campaigns/${campaign.id}/send?force=yes`,
    { method: 'POST', headers: ADMIN });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).recipients, 1);
});

suite('a clean campaign sends without argument', async () => {
  const brand = await freshBrand('ctest-clean');
  await query(
    `insert into contacts (brand_id, email, first_name, status, source)
     values ($1,'ok@c.test','Ada','subscribed','test')`, [brand.id]);

  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, preheader, mjml)
     values ($1,'Good','A clear subject','A useful preheader',$2) returning *`,
    [brand.id, MJML('<mj-text>Hello. <a href="https://scalaro.io">Read more</a></mj-text>')],
  );

  const res = await fetch(`${base}/v1/brands/${brand.id}/campaigns/${campaign.id}/send`,
    { method: 'POST', headers: ADMIN });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).recipients, 1);
});

suite('preview is available as raw HTML for an iframe', async () => {
  const brand = await freshBrand('ctest-iframe');
  const { rows: [campaign] } = await query(
    `insert into campaigns (brand_id, name, subject, mjml) values ($1,'P','S',$2) returning *`,
    [brand.id, MJML('<mj-text>Preview me</mj-text>')],
  );

  const res = await fetch(`${base}/v1/brands/${brand.id}/campaigns/${campaign.id}/preview?format=html`,
    { method: 'POST', headers: ADMIN, body: '{}' });
  assert.match(res.headers.get('content-type'), /html/);
  assert.match(await res.text(), /Preview me/);
});

suite('a listing omits the bodies, and fetching one returns it', async () => {
  // A library listing of forty templates should not carry forty MJML bodies.
  const brand = await freshBrand('ctest-listshape');
  const [listed] = await templates.list(brand.id);

  assert.equal(listed.mjml, undefined, 'listings stay small');
  assert.ok(listed.name && listed.category);

  const full = await templates.get(brand.id, listed.id);
  assert.ok(full.mjml.includes('<mjml>'));
});
