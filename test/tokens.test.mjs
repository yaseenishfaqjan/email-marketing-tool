import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mint, verify, hashApiKey, generateApiKey } from '../src/tokens.mjs';

test('a minted token verifies and round-trips its claims', () => {
  const token = mint('u', { m: 'abc-123' });
  assert.deepEqual(verify('u', token), { k: 'u', m: 'abc-123' });
});

test('a token minted for one purpose does not verify for another', () => {
  // An open pixel is fetched by every mail scanner on the internet. If its
  // token also worked on /u/, those scanners would unsubscribe the list.
  const openToken = mint('o', { m: 'abc-123' });
  assert.equal(verify('u', openToken), null);
});

test('tampering with the payload invalidates the token', () => {
  const token = mint('u', { m: 'abc-123' });
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ k: 'u', m: 'someone-else' })).toString('base64url');
  assert.equal(verify('u', `${forged}.${sig}`), null);
  assert.notEqual(payload, forged);
});

test('malformed input is rejected rather than throwing', () => {
  for (const bad of ['', 'nodot', '.', 'a.b', null, undefined, 42, 'x'.repeat(5000)]) {
    assert.equal(verify('u', bad), null);
  }
});

test('api keys are stored only as a hash', () => {
  const key = generateApiKey('kept');
  assert.match(key, /^emk_kept_[A-Za-z0-9_-]+$/);
  const hash = hashApiKey(key);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, key);
  assert.equal(hash, hashApiKey(key));   // deterministic, so lookup works
});
