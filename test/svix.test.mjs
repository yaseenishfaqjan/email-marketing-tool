import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifySvixSignature } from '../src/http/svix.mjs';

const SECRET = 'whsec_' + Buffer.from('a'.repeat(24)).toString('base64');
const NOW = 1_800_000_000;

function sign(body, { id = 'msg_1', timestamp = NOW, secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${mac}`,
  };
}

const BODY = '{"type":"email.bounced","data":{"email_id":"abc"}}';

test('a correctly signed delivery passes', () => {
  const r = verifySvixSignature({ headers: sign(BODY), body: BODY, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
});

test('webhook- prefixed headers work too', () => {
  const svix = sign(BODY);
  const headers = {
    'webhook-id': svix['svix-id'],
    'webhook-timestamp': svix['svix-timestamp'],
    'webhook-signature': svix['svix-signature'],
  };
  assert.equal(verifySvixSignature({ headers, body: BODY, secret: SECRET, now: NOW }).ok, true);
});

test('a tampered body fails', () => {
  // The whole point: someone forging a bounce for an address they want
  // suppressed must not get past this.
  const headers = sign(BODY);
  const forged = '{"type":"email.bounced","data":{"email_id":"someone-elses"}}';
  const r = verifySvixSignature({ headers, body: forged, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_matching_signature');
});

test('the wrong secret fails', () => {
  const other = 'whsec_' + Buffer.from('b'.repeat(24)).toString('base64');
  const r = verifySvixSignature({ headers: sign(BODY, { secret: other }), body: BODY, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
});

test('a replayed delivery outside the window fails', () => {
  const old = NOW - 6 * 60;
  const r = verifySvixSignature({ headers: sign(BODY, { timestamp: old }), body: BODY, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timestamp_out_of_tolerance');
});

test('a future timestamp fails as well', () => {
  const ahead = NOW + 6 * 60;
  const r = verifySvixSignature({ headers: sign(BODY, { timestamp: ahead }), body: BODY, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
});

test('inside the window passes', () => {
  const r = verifySvixSignature({
    headers: sign(BODY, { timestamp: NOW - 4 * 60 }), body: BODY, secret: SECRET, now: NOW,
  });
  assert.equal(r.ok, true);
});

test('changing the id invalidates the signature', () => {
  // The id is in the signed string, so a delivery cannot be replayed under a
  // different id.
  const headers = sign(BODY);
  headers['svix-id'] = 'msg_2';
  assert.equal(verifySvixSignature({ headers, body: BODY, secret: SECRET, now: NOW }).ok, false);
});

test('several signatures pass if any one matches', () => {
  // Svix sends old and new during a secret rotation.
  const headers = sign(BODY);
  headers['svix-signature'] = `v1,AAAAinvalidAAAA ${headers['svix-signature']}`;
  assert.equal(verifySvixSignature({ headers, body: BODY, secret: SECRET, now: NOW }).ok, true);
});

test('missing headers fail rather than throw', () => {
  const r = verifySvixSignature({ headers: {}, body: BODY, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_headers');
});

test('no configured secret refuses everything', () => {
  // Fail closed. An endpoint with no secret must not accept forged bounces.
  const r = verifySvixSignature({ headers: sign(BODY), body: BODY, secret: '', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_secret_configured');
});

test('a non-numeric timestamp fails', () => {
  const headers = sign(BODY);
  headers['svix-timestamp'] = 'not-a-number';
  assert.equal(verifySvixSignature({ headers, body: BODY, secret: SECRET, now: NOW }).reason, 'bad_timestamp');
});

test('a secret without the whsec_ prefix works', () => {
  const bare = Buffer.from('c'.repeat(24)).toString('base64');
  const r = verifySvixSignature({
    headers: sign(BODY, { secret: bare }), body: BODY, secret: bare, now: NOW,
  });
  assert.equal(r.ok, true);
});
