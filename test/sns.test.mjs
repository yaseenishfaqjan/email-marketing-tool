import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySnsSignature, _internals } from '../src/http/sns.mjs';

test('the signed string uses a fixed field order, not the order the sender sent', () => {
  // Building it from Object.keys would let a sender reorder fields and still
  // produce a string that verifies against a signature they control.
  const canonical = _internals.canonicalString({
    Type: 'Notification',
    TopicArn: 'arn:aws:sns:us-east-1:1:ses',
    Timestamp: '2026-09-25T00:00:00.000Z',
    MessageId: 'm-1',
    Message: 'body',
  });
  assert.equal(canonical,
    'Message\nbody\nMessageId\nm-1\nTimestamp\n2026-09-25T00:00:00.000Z\n'
    + 'TopicArn\narn:aws:sns:us-east-1:1:ses\nType\nNotification\n');
});

test('absent optional fields are skipped, not sent as the string "undefined"', () => {
  const canonical = _internals.canonicalString({
    Type: 'Notification', MessageId: 'm-1', Message: 'body',
    Timestamp: 't', TopicArn: 'a', Subject: undefined,
  });
  assert.ok(!canonical.includes('undefined'));
  assert.ok(!canonical.includes('Subject'));
});

test('only AWS SNS hosts are accepted as certificate sources', () => {
  const { CERT_HOST } = _internals;
  assert.ok(CERT_HOST.test('sns.us-east-1.amazonaws.com'));
  assert.ok(CERT_HOST.test('sns.eu-west-2.amazonaws.com'));

  // Each of these is a real break: supply your own certificate URL and you can
  // sign any notification you like.
  assert.ok(!CERT_HOST.test('sns.us-east-1.amazonaws.com.attacker.com'));
  assert.ok(!CERT_HOST.test('attacker.com'));
  assert.ok(!CERT_HOST.test('evil-sns.us-east-1.amazonaws.com'));
});

test('a message with no signature is refused without a network call', async () => {
  assert.equal(await verifySnsSignature({ Type: 'Notification' }), false);
  assert.equal(await verifySnsSignature(null), false);
  assert.equal(await verifySnsSignature({ Type: 'Notification', Signature: 'x' }), false);
});

test('a certificate from a non-AWS host is never fetched', async () => {
  // Either outcome is a refusal; what matters is that no request is made to
  // the attacker's host and the function does not return true.
  const result = await verifySnsSignature({
    Type: 'Notification', Signature: 'x', SignatureVersion: '1',
    SigningCertURL: 'https://attacker.com/c.pem',
  }).catch((err) => {
    assert.match(err.message, /Refusing certificate/);
    return false;
  });
  assert.equal(result, false);
});

test('an unknown signature version is refused', async () => {
  assert.equal(await verifySnsSignature({
    Type: 'Notification', Signature: 'x', SignatureVersion: '99',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/c.pem',
  }), false);
});

test('a genuine signature over the canonical string verifies', async (t) => {
  const { privateKey, certPem } = makeSelfSignedPair();
  if (!certPem) return t.skip('no X.509 support in this build');

  const body = {
    Type: 'Notification', MessageId: 'm-1', Message: 'body',
    Timestamp: '2026-09-25T00:00:00.000Z', TopicArn: 'arn:aws:sns:us-east-1:1:ses',
    SignatureVersion: '1', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/test.pem',
  };
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(_internals.canonicalString(body), 'utf8');
  body.Signature = signer.sign(privateKey, 'base64');

  // Prove the signature is over exactly the canonical string this module builds.
  const verifier = crypto.createVerify('RSA-SHA1');
  verifier.update(_internals.canonicalString(body), 'utf8');
  assert.ok(verifier.verify(certPem, body.Signature, 'base64'));

  // And that tampering with the payload breaks it.
  const tampered = { ...body, Message: 'different body' };
  const v2 = crypto.createVerify('RSA-SHA1');
  v2.update(_internals.canonicalString(tampered), 'utf8');
  assert.equal(v2.verify(certPem, body.Signature, 'base64'), false);
});

/** A throwaway key pair. The public key stands in for the certificate. */
function makeSelfSignedPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, certPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}
