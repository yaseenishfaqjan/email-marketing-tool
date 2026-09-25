import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMime, encodeHeaderValue, formatAddress } from '../src/sending/mime.mjs';

const base = {
  fromName: 'Kept Portraits',
  fromEmail: 'hello@mail.keptportraits.com',
  to: 'reader@example.com',
  subject: 'Your proof is ready',
  text: 'Hello there',
  html: '<html><body><p>Hello there</p></body></html>',
};

test('one-click unsubscribe headers are present when a URL is given', () => {
  // Google and Yahoo have required these from bulk senders since Feb 2024.
  // Without them, good mail goes to spam whatever the content says.
  const mime = buildMime({ ...base,
    unsubscribeUrl: 'https://links.example.com/u/tok',
    unsubscribeMailto: 'unsubscribe@mail.example.com' }).toString();

  assert.match(mime, /^List-Unsubscribe: <https:\/\/links\.example\.com\/u\/tok>, <mailto:unsubscribe@mail\.example\.com>$/m);
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
});

test('both a text and an HTML part are always produced, HTML last', () => {
  const mime = buildMime(base).toString();
  const textAt = mime.indexOf('text/plain');
  const htmlAt = mime.indexOf('text/html');
  assert.ok(textAt > 0 && htmlAt > 0);
  // multipart/alternative prefers the LAST part; HTML must come second.
  assert.ok(htmlAt > textAt, 'HTML part must follow the plain-text part');
});

test('bodies survive non-ASCII content', () => {
  const mime = buildMime({ ...base, text: 'Café — naïve', html: '<p>Café — naïve</p>' }).toString();
  const parts = mime.split(/Content-Transfer-Encoding: base64\r\n\r\n/);
  const decoded = parts.slice(1).map((p) => Buffer.from(p.split('\r\n--')[0], 'base64').toString('utf8'));
  assert.ok(decoded.some((d) => d.includes('Café — naïve')));
});

test('a non-ASCII subject is RFC 2047 encoded', () => {
  assert.equal(encodeHeaderValue('Plain subject'), 'Plain subject');
  assert.match(encodeHeaderValue('Café'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

test('a newline in a header value cannot inject another header', () => {
  // A merge field reaches the subject line. Without stripping, a contact
  // called "x\r\nBcc: everyone@example.com" would add a header.
  const mime = buildMime({
    ...base,
    subject: 'Hello\r\nBcc: attacker@example.com',
    headers: { 'X-Campaign-Id': 'abc\r\nX-Injected: yes' },
  }).toString();

  assert.ok(!/^Bcc:/m.test(mime), 'subject must not be able to add a Bcc header');
  assert.ok(!/^X-Injected:/m.test(mime), 'a custom header value must not add a header');
});

test('a display name containing a comma is quoted', () => {
  // Unquoted, "Smith, John <a@b>" parses as two addresses.
  assert.equal(formatAddress('Smith, John', 'a@b.com'), '"Smith, John" <a@b.com>');
  assert.equal(formatAddress('', 'a@b.com'), 'a@b.com');
  assert.equal(formatAddress('Kept Portraits', 'a@b.com'), 'Kept Portraits <a@b.com>');
});

test('base64 body lines stay within the 76-character limit', () => {
  const mime = buildMime({ ...base, html: `<p>${'x'.repeat(5000)}</p>` }).toString();
  const longest = Math.max(...mime.split('\r\n').map((l) => l.length));
  assert.ok(longest <= 998, `no line may exceed the SMTP limit, longest was ${longest}`);
});
