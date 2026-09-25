import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/sending/ses.mjs';

test('throttling is retried, not treated as a failure', () => {
  // The message is fine; the account is simply going too fast. Marking it
  // failed would drop real mail on a bad afternoon.
  assert.equal(classifyError({ name: 'TooManyRequestsException' }), 'throttle');
  assert.equal(classifyError({ name: 'ThrottlingException' }), 'throttle');
  assert.equal(classifyError({ $metadata: { httpStatusCode: 429 } }), 'transient');
});

test('a rejected message is permanent — retrying burns quota and reputation', () => {
  assert.equal(classifyError({ name: 'MessageRejected' }), 'permanent');
  assert.equal(classifyError({ name: 'AccountSuspendedException' }), 'permanent');
  assert.equal(classifyError({ name: 'SendingPausedException' }), 'permanent');
  assert.equal(classifyError({ name: 'MailFromDomainNotVerifiedException' }), 'permanent');
});

test('4xx is permanent and 5xx is transient', () => {
  assert.equal(classifyError({ $metadata: { httpStatusCode: 400 } }), 'permanent');
  assert.equal(classifyError({ $metadata: { httpStatusCode: 403 } }), 'permanent');
  assert.equal(classifyError({ $metadata: { httpStatusCode: 500 } }), 'transient');
  assert.equal(classifyError({ $metadata: { httpStatusCode: 503 } }), 'transient');
});

test('an unrecognised error is transient, so nothing is dropped on a guess', () => {
  assert.equal(classifyError(new Error('socket hang up')), 'transient');
  assert.equal(classifyError({}), 'transient');
  assert.equal(classifyError(null), 'transient');
});
