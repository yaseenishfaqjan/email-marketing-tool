import test from 'node:test';
import assert from 'node:assert/strict';

process.env.RESEND_API_KEY = 're_test_key';

const { classifyError, send } = await import('../src/sending/resend.mjs');

/** Swap global fetch for one call, returning what the adapter sent. */
async function capture(response, fn) {
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return response;
  };
  try {
    const result = await fn();
    return { seen, result };
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (json) => new Response(JSON.stringify(json), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('429 is a throttle, not a failure', () => {
  // The distinction decides whether the worker requeues the message or marks
  // it failed. Getting it wrong here loses mail.
  assert.equal(classifyError({ status: 429 }), 'throttle');
});

test('4xx is permanent', () => {
  assert.equal(classifyError({ status: 422 }), 'permanent');
  assert.equal(classifyError({ status: 401 }), 'permanent');
  assert.equal(classifyError({ status: 403 }), 'permanent');
  assert.equal(classifyError({ status: 400 }), 'permanent');
});

test('5xx and network errors are transient', () => {
  assert.equal(classifyError({ status: 500 }), 'transient');
  assert.equal(classifyError({ status: 503 }), 'transient');
  assert.equal(classifyError(new Error('fetch failed')), 'transient');
  assert.equal(classifyError({}), 'transient');
  assert.equal(classifyError(null), 'transient');
});

test('send posts the message and returns the provider id', async () => {
  const { seen, result } = await capture(ok({ id: 'abc-123' }), () => send({
    fromName: 'Kept Portraits',
    fromEmail: 'hello@keptportraits.com',
    to: 'reader@example.com',
    replyTo: 'support@keptportraits.com',
    subject: 'Your order',
    html: '<p>hi</p>',
    text: 'hi',
  }));

  assert.equal(result.messageId, 'abc-123');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer re_test_key');
  assert.equal(seen.body.from, 'Kept Portraits <hello@keptportraits.com>');
  assert.deepEqual(seen.body.to, ['reader@example.com']);
  assert.equal(seen.body.reply_to, 'support@keptportraits.com');
  assert.equal(seen.body.subject, 'Your order');
  assert.equal(seen.body.html, '<p>hi</p>');
  assert.equal(seen.body.text, 'hi');
});

test('an unsubscribe url produces both one-click headers', async () => {
  // Gmail and Yahoo have required these of bulk senders since February 2024.
  // Resend builds the MIME, so they reach the wire only if we pass them.
  const { seen } = await capture(ok({ id: 'x' }), () => send({
    fromName: 'B', fromEmail: 'b@example.com', to: 'r@example.com',
    subject: 's', text: 't',
    unsubscribeUrl: 'https://links.scalaro.io/u/tok',
    unsubscribeMailto: 'unsubscribe@example.com',
  }));

  assert.equal(
    seen.body.headers['List-Unsubscribe'],
    '<https://links.scalaro.io/u/tok>, <mailto:unsubscribe@example.com>'
  );
  assert.equal(seen.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('newlines in header values cannot inject headers', async () => {
  // A contact's first name reaches a header via the campaign id path; a raw
  // newline there would let it append headers of its own.
  const { seen } = await capture(ok({ id: 'x' }), () => send({
    fromName: 'B', fromEmail: 'b@example.com', to: 'r@example.com',
    subject: 's', text: 't',
    headers: { 'X-Campaign-Id': 'abc\r\nBcc: victim@example.com' },
  }));

  assert.equal(seen.body.headers['X-Campaign-Id'], 'abc  Bcc: victim@example.com');
  assert.ok(!seen.body.headers['X-Campaign-Id'].includes('\n'));
});

test('a rejected send throws with the status attached', async () => {
  // classifyError reads err.status, so losing it here would turn every
  // permanent rejection into an infinite requeue.
  const bad = new Response('{"message":"invalid to field"}', { status: 422 });
  await assert.rejects(
    () => capture(bad, () => send({
      fromName: 'B', fromEmail: 'b@example.com', to: 'nope', subject: 's', text: 't',
    })),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(classifyError(err), 'permanent');
      assert.match(err.message, /invalid to field/);
      return true;
    }
  );
});

test('absent optional fields are omitted, not sent empty', async () => {
  // An empty html string would make Resend send an empty HTML part rather
  // than a text-only message.
  const { seen } = await capture(ok({ id: 'x' }), () => send({
    fromName: 'B', fromEmail: 'b@example.com', to: 'r@example.com',
    subject: 's', text: 'plain only',
  }));

  assert.ok(!('html' in seen.body));
  assert.ok(!('reply_to' in seen.body));
  assert.ok(!('headers' in seen.body));
});
