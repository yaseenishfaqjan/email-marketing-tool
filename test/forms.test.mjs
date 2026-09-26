/**
 * Signup forms and double opt-in.
 *
 * A public form is the only part of this system that hostile traffic can reach
 * without a credential, so most of these tests are abuse cases: forging
 * somebody else's address, testing whether an address is on the list, posting
 * from a site that was never authorised.
 */

import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const DB_AVAILABLE = await (async () => {
  try {
    const { query } = await import('../src/db.mjs');
    await query('select 1 from form_submissions limit 1');
    return true;
  } catch {
    return false;
  }
})();

const suite = DB_AVAILABLE ? test : test.skip;

const { query, close } = await import('../src/db.mjs');
const { createApp } = await import('../src/app.mjs');
const forms = await import('../src/forms/repo.mjs');
const { buildEmbedScript } = await import('../src/forms/embed.mjs');
const { _test: sesTest } = await import('../src/sending/ses.mjs');
const worker = await import('../src/worker/send-worker.mjs');

let server;
let base;

async function resetTestData() {
  await query("delete from brands where slug like 'ftest-%'");
  await query("delete from suppressions where email like '%form.test.example'");
}

test.before(async () => {
  if (!DB_AVAILABLE) return;
  await resetTestData();
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
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address)
     values ($1,$1,'Test','hello@mail.form.test.example','mail.form.test.example','1 Test St')
     returning *`,
    [slug],
  );
  return rows[0];
}

async function makeForm(brand, overrides = {}) {
  const { rows } = await query(
    `insert into forms (brand_id, name, fields, double_optin, allowed_origins,
                        confirm_subject, confirm_mjml, success_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [
      brand.id, overrides.name ?? 'Newsletter',
      JSON.stringify(overrides.fields ?? ['email', 'first_name']),
      overrides.double_optin ?? true,
      overrides.allowed_origins ?? ['https://scalaro.io'],
      'Please confirm',
      '<mjml><mj-body><mj-section><mj-column><mj-text><a href="{{confirm_url}}">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      'Check your inbox.',
    ],
  );
  return rows[0];
}

const postForm = (formId, body, origin = 'https://scalaro.io') =>
  fetch(`${base}/f/${formId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });

function stubSes() {
  const sent = [];
  sesTest.setClient({
    async send(command) {
      sent.push({
        to: command.input.Destination.ToAddresses[0],
        raw: Buffer.from(command.input.Content.Raw.Data).toString('utf8'),
      });
      return { MessageId: `ses-form-${sent.length}-${Date.now()}` };
    },
  });
  return sent;
}

/** Decode a base64 MIME part back to readable text. */
const decodePart = (raw, index) => Buffer.from(
  raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[index].split('\r\n--')[0].replace(/\r\n/g, ''),
  'base64').toString('utf8');

/**
 * The link as the recipient sees it, re-pointed at the ephemeral test server.
 *
 * The real link carries the brand's tracking domain (or PUBLIC_URL); only the
 * token matters here.
 */
const confirmLinkFrom = (raw) => {
  const href = decodePart(raw, 2).match(/href="([^"]*\/confirm\/[^"]+)"/)?.[1];
  if (!href) return null;
  return `${base}/confirm/${href.split('/confirm/')[1]}`;
};

/* ------------------------------------------------------------------------ */

suite('a signup is not a subscriber until the link in their inbox is clicked', async () => {
  const brand = await freshBrand('ftest-optin');
  worker.clearTemplateCache();
  const form = await makeForm(brand);

  const res = await postForm(form.id, { email: 'new@form.test.example', first_name: 'Ada' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).message, 'Check your inbox.');

  // Pending, and invisible to every campaign and automation until confirmed.
  const { rows: before } = await query(
    'select status from contacts where brand_id = $1 and email = $2',
    [brand.id, 'new@form.test.example']);
  assert.equal(before[0].status, 'pending');

  const sent = stubSes();
  await worker.tick();

  const confirmation = sent.find((s) => s.to === 'new@form.test.example');
  assert.ok(confirmation, 'a confirmation email should have been sent');

  // Transactional: nothing to unsubscribe from yet, and not clicking IS the
  // opt-out.
  assert.ok(!/^List-Unsubscribe:/m.test(confirmation.raw), 'a confirmation carries no unsubscribe header');
  assert.match(decodePart(confirmation.raw, 2), /1 Test St/,
    'but it still carries the postal address');

  const link = confirmLinkFrom(confirmation.raw);
  assert.ok(link, 'the confirmation email must contain the link');

  const confirmed = await fetch(link, { redirect: 'manual' });
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /subscribed/i);

  const { rows: after } = await query(
    'select status, consent_at, consent_source from contacts where brand_id = $1 and email = $2',
    [brand.id, 'new@form.test.example']);
  assert.equal(after[0].status, 'subscribed');
  assert.ok(after[0].consent_at, 'consent must be evidenced');
  assert.match(after[0].consent_source, /Double opt-in confirmed/);
});

suite('clicking the confirmation link twice is not an error', async () => {
  // Mail clients prefetch, people double-click, and somebody will bookmark it.
  const brand = await freshBrand('ftest-twice');
  worker.clearTemplateCache();
  const form = await makeForm(brand);
  await postForm(form.id, { email: 'twice@form.test.example' });

  const sent = stubSes();
  await worker.tick();
  const link = confirmLinkFrom(sent.find((s) => s.to === 'twice@form.test.example').raw);

  assert.equal((await fetch(link, { redirect: 'manual' })).status, 200);
  const second = await fetch(link, { redirect: 'manual' });
  assert.equal(second.status, 200);
  assert.match(await second.text(), /already subscribed/i);
});

suite('a form only accepts posts from the sites it lists', async () => {
  // Without this, any site on the internet can fill a brand's list.
  const brand = await freshBrand('ftest-origin');
  const form = await makeForm(brand, { allowed_origins: ['https://scalaro.io'] });

  const wrong = await postForm(form.id, { email: 'x@form.test.example' }, 'https://attacker.example');
  assert.equal(wrong.status, 403);

  const right = await postForm(form.id, { email: 'y@form.test.example' }, 'https://scalaro.io');
  assert.equal(right.status, 200);
});

suite('a form with no origins configured accepts nothing', async () => {
  // Fails closed. An empty allowlist means "not set up yet", not "open".
  const brand = await freshBrand('ftest-noorigin');
  const form = await makeForm(brand, { allowed_origins: [] });
  const res = await postForm(form.id, { email: 'z@form.test.example' });
  assert.equal(res.status, 403);
});

suite('subdomains are matched only when explicitly allowed', () => {
  const withDot = { allowed_origins: ['.scalaro.io'] };
  assert.equal(forms.originAllowed(withDot, 'https://app.scalaro.io'), true);
  assert.equal(forms.originAllowed(withDot, 'https://scalaro.io'), true);
  // The trap: a naive endsWith would match this.
  assert.equal(forms.originAllowed(withDot, 'https://notscalaro.io'), false);

  const exact = { allowed_origins: ['https://scalaro.io'] };
  assert.equal(forms.originAllowed(exact, 'https://scalaro.io'), true);
  assert.equal(forms.originAllowed(exact, 'https://app.scalaro.io'), false);
  assert.equal(forms.originAllowed(exact, null), false);
  assert.equal(forms.originAllowed({ allowed_origins: [] }, 'https://scalaro.io'), false);
});

suite('the honeypot absorbs bots silently', async () => {
  const brand = await freshBrand('ftest-honeypot');
  const form = await makeForm(brand);

  const res = await postForm(form.id, { email: 'bot@form.test.example', website: 'http://spam.example' });
  assert.equal(res.status, 200);

  const { rows } = await query('select 1 from form_submissions where email = $1', ['bot@form.test.example']);
  assert.equal(rows.length, 0, 'nothing should be recorded');
});

suite('a public form cannot be used to test who is on the list', async () => {
  // A different answer for a suppressed address turns the form into an oracle.
  const brand = await freshBrand('ftest-oracle');
  const form = await makeForm(brand);
  await query("insert into suppressions (brand_id, email, reason) values (null,$1,'complaint')",
    ['complained@form.test.example']);

  const suppressed = await postForm(form.id, { email: 'complained@form.test.example' });
  const normal = await postForm(form.id, { email: 'fine@form.test.example' });

  assert.equal(suppressed.status, normal.status);
  assert.deepEqual(await suppressed.json(), await normal.json());

  // Recorded as blocked, and no contact created.
  const { rows } = await query("select status from form_submissions where email = $1",
    ['complained@form.test.example']);
  assert.equal(rows[0].status, 'blocked');
  const { rows: contacts } = await query('select 1 from contacts where email = $1',
    ['complained@form.test.example']);
  assert.equal(contacts.length, 0);
});

suite('a complaint is never cleared by a form submission', async () => {
  const brand = await freshBrand('ftest-globalsup');
  worker.clearTemplateCache();
  const form = await makeForm(brand);
  await query("insert into suppressions (brand_id, email, reason) values (null,$1,'hard_bounce')",
    ['dead@form.test.example']);

  await postForm(form.id, { email: 'dead@form.test.example' });
  const sent = stubSes();
  await worker.tick();

  assert.ok(!sent.some((s) => s.to === 'dead@form.test.example'),
    'a globally suppressed address must never be mailed, confirmation or not');
  const { rows } = await query('select 1 from suppressions where email = $1 and brand_id is null',
    ['dead@form.test.example']);
  assert.equal(rows.length, 1, 'and the suppression must survive');
});

suite('confirming after an unsubscribe re-subscribes them', async () => {
  // They left, then filled in a form again and clicked a link in their own
  // inbox. That is fresher and better-evidenced consent than the first time.
  const brand = await freshBrand('ftest-resub');
  worker.clearTemplateCache();
  const form = await makeForm(brand);

  await query(
    `insert into contacts (brand_id, email, status, source) values ($1,$2,'unsubscribed','test')`,
    [brand.id, 'back@form.test.example']);
  await query("insert into suppressions (brand_id, email, reason) values ($1,$2,'unsubscribe')",
    [brand.id, 'back@form.test.example']);

  await postForm(form.id, { email: 'back@form.test.example' });
  const sent = stubSes();
  await worker.tick();

  const link = confirmLinkFrom(sent.find((s) => s.to === 'back@form.test.example').raw);
  await fetch(link, { redirect: 'manual' });

  const { rows } = await query('select status from contacts where brand_id = $1 and email = $2',
    [brand.id, 'back@form.test.example']);
  assert.equal(rows[0].status, 'subscribed');

  const { rows: sup } = await query(
    "select 1 from suppressions where email = $1 and brand_id = $2 and reason = 'unsubscribe'",
    ['back@form.test.example', brand.id]);
  assert.equal(sup.length, 0, 'the brand unsubscribe should be cleared by fresh consent');
});

suite('submitting repeatedly does not send a pile of confirmations', async () => {
  const brand = await freshBrand('ftest-repeat');
  worker.clearTemplateCache();
  const form = await makeForm(brand);

  for (let i = 0; i < 3; i += 1) {
    await postForm(form.id, { email: 'eager@form.test.example' });
  }

  const { rows } = await query(
    `select count(*)::int as n from messages m
       join form_submissions s on s.id = m.form_submission_id
      where s.email = $1`,
    ['eager@form.test.example']);
  assert.equal(rows[0].n, 1, 'one confirmation, however many times they hit the button');
});

suite('an expired confirmation link is refused', async () => {
  const brand = await freshBrand('ftest-expired');
  const form = await makeForm(brand);
  await postForm(form.id, { email: 'slow@form.test.example' });

  const { rows } = await query('select id from form_submissions where email = $1',
    ['slow@form.test.example']);
  await query("update form_submissions set created_at = now() - interval '30 days' where id = $1",
    [rows[0].id]);

  const result = await forms.confirm({ submissionId: rows[0].id });
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'expired');

  const { rows: after } = await query('select status from form_submissions where id = $1', [rows[0].id]);
  assert.equal(after[0].status, 'expired');
});

suite('a forged confirmation token confirms nobody', async () => {
  const res = await fetch(`${base}/confirm/not-a-real-token`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not valid/i);
});

suite('confirming triggers the welcome automation', async () => {
  const brand = await freshBrand('ftest-welcome');
  worker.clearTemplateCache();
  const form = await makeForm(brand, { name: 'Pricing page' });

  const { rows: [automation] } = await query(
    `insert into automations (brand_id, name, trigger_type, trigger_config, status)
     values ($1,'Welcome','subscribed','{}','active') returning *`,
    [brand.id]);
  await query(
    `insert into automation_steps (automation_id, position, type, config)
     values ($1,0,'email',$2)`,
    [automation.id, JSON.stringify({ subject: 'Welcome', mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>' })]);

  await postForm(form.id, { email: 'welcome@form.test.example' });
  const sent = stubSes();
  await worker.tick();
  const link = confirmLinkFrom(sent.find((s) => s.to === 'welcome@form.test.example').raw);
  await fetch(link, { redirect: 'manual' });

  // Enrolment runs after the confirmation transaction commits.
  await new Promise((r) => setTimeout(r, 200));

  const { rows } = await query(
    `select r.status from automation_runs r
       join contacts c on c.id = r.contact_id
      where r.automation_id = $1 and c.email = $2`,
    [automation.id, 'welcome@form.test.example']);
  assert.equal(rows.length, 1, 'confirming should start the welcome sequence');
});

suite('single opt-in subscribes immediately when explicitly chosen', async () => {
  const brand = await freshBrand('ftest-single');
  const form = await makeForm(brand, { double_optin: false });

  await postForm(form.id, { email: 'instant@form.test.example', first_name: 'Sam' });

  const { rows } = await query('select status, first_name from contacts where brand_id = $1 and email = $2',
    [brand.id, 'instant@form.test.example']);
  assert.equal(rows[0].status, 'subscribed');
  assert.equal(rows[0].first_name, 'Sam');
});

suite('a form template without the confirm link is refused at save time', () => {
  // Otherwise every signup from that form silently dead-ends.
  assert.throws(
    () => forms.validateConfirmTemplate('<mjml><mj-body>No link here</mj-body></mjml>'),
    /must contain \{\{confirm_url\}\}/,
  );
  assert.doesNotThrow(() => forms.validateConfirmTemplate('<mjml>{{confirm_url}}</mjml>'));
});

suite('a form cannot invent a contact field', () => {
  assert.throws(() => forms.validateFields(['email', 'is_admin']), forms.FormError);
  assert.doesNotThrow(() => forms.validateFields(['email', 'first_name', 'last_name']));
});

suite('the embed script is valid JavaScript and escapes brand copy', () => {
  const js = buildEmbedScript({
    id: 'abcd1234-0000-0000-0000-000000000000',
    name: 'Newsletter',
    fields: ['email'],
    headline: 'It\'s here: "the" newsletter </script><script>alert(1)</script>',
    button_label: 'Go',
    success_message: 'Thanks',
    theme: {},
  }, 'https://links.example.com');

  assert.doesNotThrow(() => new Function(js), 'the generated file must parse');
  // Copy is carried as JSON data and written with textContent, never as markup.
  assert.ok(!js.includes('</script><script>alert(1)</script>'),
    'raw markup from brand copy must not reach the page');
});

suite('the embed script 404s as valid JavaScript', async () => {
  // A 404 HTML body executed as a script is a syntax error in somebody's
  // marketing site console.
  const res = await fetch(`${base}/f/00000000-0000-0000-0000-000000000000.js`);
  const body = await res.text();
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.doesNotThrow(() => new Function(body));
});
