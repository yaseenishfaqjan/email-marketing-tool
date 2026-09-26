import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintCampaign } from '../src/campaigns/lint.mjs';

const body = (inner) =>
  `<mjml><mj-body><mj-section><mj-column>${inner}</mj-column></mj-section></mj-body></mjml>`;

const codes = (r) => [...r.errors, ...r.warnings].map((f) => f.code);
const good = {
  subject: 'A short, clear subject',
  preheader: 'The line the inbox shows next to it.',
  mjml: body('<mj-text>Hello, here is the <a href="https://scalaro.io/pricing">pricing page</a>.</mj-text>'),
};

test('a clean campaign passes with nothing to say', () => {
  const r = lintCampaign(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('a missing subject blocks the send', () => {
  const r = lintCampaign({ ...good, subject: '' });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('subject_missing'));
});

test('a link to localhost or staging blocks the send', () => {
  // Dead for every single recipient, and there is no undo.
  for (const url of ['http://localhost:3000/x', 'https://staging.scalaro.io/x', 'http://127.0.0.1/x']) {
    const r = lintCampaign({ ...good, mjml: body(`<mj-text><a href="${url}">go</a></mj-text>`) });
    assert.equal(r.ok, false, `${url} should block`);
    assert.ok(codes(r).includes('local_link'));
  }
});

test('a typo in a merge field blocks the send', () => {
  // {{frist_name}} renders as empty text, so "Hi ," goes to the whole list.
  const r = lintCampaign({ ...good, subject: 'Hi {{frist_name}}' });
  assert.equal(r.ok, false);
  const finding = r.errors.find((e) => e.code === 'unknown_merge_field');
  assert.match(finding.message, /frist_name/);
});

test('a real contact attribute is accepted as a merge field', () => {
  const r = lintCampaign(
    { ...good, subject: 'Your {{attrs.plan}} plan' },
    { knownAttributes: ['plan'] },
  );
  assert.equal(r.ok, true);

  const unknown = lintCampaign({ ...good, subject: 'Your {{attrs.planm}} plan' }, { knownAttributes: ['plan'] });
  assert.equal(unknown.ok, false);
});

test('a template that does not compile blocks the send', () => {
  const r = lintCampaign({ ...good, mjml: 'not mjml at all <<<' });
  assert.equal(r.ok, false);
});

test('warnings advise but never block', () => {
  const r = lintCampaign({
    subject: 'A subject so long that it will certainly be cut off by every single mail client in use today',
    preheader: '',
    mjml: body('<mj-text>Words with no link at all.</mj-text>'),
  });
  assert.equal(r.ok, true, 'warnings must not stop a send');
  assert.ok(codes(r).includes('subject_long'));
  assert.ok(codes(r).includes('preheader_missing'));
  assert.ok(codes(r).includes('no_links'));
});

test('the bare-greeting warning fires only when the list actually has nameless contacts', () => {
  // A rule that fires on every template is a rule nobody reads.
  const greeting = { ...good, mjml: body('<mj-text>Hi {{first_name}}, welcome.</mj-text>') };

  assert.ok(!codes(lintCampaign(greeting, { contactsMissingName: 0 })).includes('bare_name_greeting'));

  const warned = lintCampaign(greeting, { contactsMissingName: 412 });
  assert.ok(codes(warned).includes('bare_name_greeting'));
  assert.match(warned.warnings.find((w) => w.code === 'bare_name_greeting').message, /412/);
});

test('an image with no alt text is flagged', () => {
  const r = lintCampaign({
    ...good,
    mjml: body('<mj-text>Hi</mj-text><mj-image src="https://scalaro.io/a.png" /><mj-text>Read the <a href="https://scalaro.io">news</a></mj-text>'),
  });
  assert.ok(codes(r).includes('image_no_alt'));
});

test('an image-only email is flagged', () => {
  // Filters distrust it, and plenty of people read with images off.
  const r = lintCampaign({
    ...good,
    mjml: body('<mj-image src="https://scalaro.io/whole-email.png" alt="Everything" />'),
  });
  assert.ok(codes(r).includes('image_only'));
});

test('shouting and excess punctuation in the subject are flagged', () => {
  assert.ok(codes(lintCampaign({ ...good, subject: 'LAST CHANCE TODAY' })).includes('subject_shouting'));
  assert.ok(codes(lintCampaign({ ...good, subject: 'Really?! Are you sure?!' })).includes('subject_punctuation'));
});

test('the links and merge fields it found are reported back', () => {
  const r = lintCampaign({
    ...good,
    subject: 'Hi {{first_name}}',
    mjml: body('<mj-text><a href="https://a.example">a</a> <a href="https://b.example">b</a></mj-text>'),
  });
  assert.deepEqual(r.stats.links.sort(), ['https://a.example', 'https://b.example']);
  assert.ok(r.stats.mergeFields.includes('first_name'));
});
