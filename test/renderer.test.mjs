import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessage, compileTemplate, urlDigest, _internals } from '../src/sending/renderer.mjs';
import { verify } from '../src/tokens.mjs';

const brand = {
  from_name: 'Kept Portraits',
  from_email: 'hello@mail.keptportraits.com',
  postal_address: '1 Example Street, Example City',
  tracking_domain: 'links.keptportraits.com',
};

const MESSAGE_ID = '11111111-2222-3333-4444-555555555555';

const render = (html, contact = { email: 'a@b.com', first_name: 'Ada', attrs: {} }) =>
  renderMessage({ brand, contact, messageId: MESSAGE_ID, subject: 'Hello {{first_name}}', compiledHtml: html });

test('merge fields are substituted in the subject and the body', () => {
  const out = render('<html><body><p>Hi {{first_name}}</p></body></html>');
  assert.equal(out.subject, 'Hello Ada');
  assert.match(out.html, /Hi Ada/);
});

test('a missing merge field renders as empty, not as the placeholder', () => {
  const out = render('<html><body><p>Hi {{first_name}}.</p></body></html>',
    { email: 'a@b.com', first_name: null, attrs: {} });
  assert.match(out.html, /Hi \./);
  assert.ok(!out.html.includes('{{'));
});

test('merge values are HTML-escaped', () => {
  // first_name arrives from a public signup form.
  const out = render('<html><body><p>Hi {{first_name}}</p></body></html>', {
    email: 'a@b.com',
    first_name: '</p><script>alert(1)</script>',
    attrs: {},
  });
  assert.ok(!out.html.includes('<script>'), 'a contact name must not become markup');
  assert.match(out.html, /&lt;script&gt;/);
});

test('every email carries the postal address and a working unsubscribe link', () => {
  const out = render('<html><body><p>Hi</p></body></html>');
  assert.match(out.html, /1 Example Street/);
  assert.match(out.html, /links\.keptportraits\.com\/u\//);
  assert.match(out.text, /Unsubscribe: https:\/\/links\.keptportraits\.com\/u\//);

  const token = out.unsubscribeUrl.split('/u/')[1];
  assert.deepEqual(verify('u', token), { k: 'u', m: MESSAGE_ID });
});

test('links are rewritten through the click tracker, carrying a digest of the destination', () => {
  const out = render('<html><body><a href="https://example.com/pricing">Pricing</a></body></html>');
  const match = out.html.match(/\/c\/([^?"]+)\?u=([^"]+)/);
  assert.ok(match, 'the link should be rewritten');

  const data = verify('c', match[1]);
  assert.equal(data.m, MESSAGE_ID);
  // Without this the tracker is an open redirect on a trusted domain.
  assert.equal(data.h, urlDigest('https://example.com/pricing'));
  assert.equal(decodeURIComponent(match[2]), 'https://example.com/pricing');
});

test('the unsubscribe link itself is never rewritten', () => {
  // An unsubscribe that depends on the tracking pipeline is one that will
  // eventually fail, and that is the one link that must not.
  const out = render('<html><body><p>Hi</p></body></html>');
  const unsubHref = out.html.match(/href="([^"]*\/u\/[^"]*)"/)[1];
  assert.ok(!unsubHref.includes('/c/'));
});

test('an anchor marked data-no-track is left alone', () => {
  const out = render('<html><body><a data-no-track href="https://example.com/legal">Legal</a></body></html>');
  assert.match(out.html, /href="https:\/\/example\.com\/legal"/);
});

test('a plain-text part is produced with links preserved', () => {
  const out = render('<html><body><p>Read the <a href="https://example.com/x">guide</a>.</p></body></html>');
  // Links must survive into the plain-text part; a tag stripper that cannot
  // tell a URL in angle brackets from markup would eat them.
  assert.match(out.text, /guide \(https:\/\/links\.keptportraits\.com\/c\//);
  assert.ok(!out.text.includes('<p>'));
});

test('the open pixel is added inside the body', () => {
  const out = render('<html><body><p>Hi</p></body></html>');
  const pixel = out.html.match(/\/o\/([^"]+)" width="1"/);
  assert.ok(pixel);
  assert.equal(verify('o', pixel[1]).m, MESSAGE_ID);
});

test('MJML compiles to table-based HTML', () => {
  const html = compileTemplate('<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>');
  assert.match(html, /<table/);
  assert.match(html, /Hi/);
});

test('htmlToText strips styles and collapses blank lines', () => {
  const text = _internals.htmlToText('<html><style>p{color:red}</style><body><p>One</p><p>Two</p></body></html>');
  assert.equal(text, 'One\n\nTwo');
});
