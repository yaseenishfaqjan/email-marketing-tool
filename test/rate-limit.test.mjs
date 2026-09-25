import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/sending/rate-limit.mjs';

test('a fresh bucket allows a burst up to its capacity, then makes the caller wait', () => {
  const bucket = new TokenBucket(10);        // capacity 10
  for (let i = 0; i < 10; i += 1) {
    assert.equal(bucket.delayFor(), 0, `token ${i + 1} should be free`);
    bucket.tokens -= 1;
  }
  assert.ok(bucket.delayFor() > 0, 'the eleventh must wait');
});

test('the wait is proportional to the configured rate', () => {
  const now = Date.now();
  const slow = new TokenBucket(1);
  slow.tokens = 0;
  slow.last = now;
  // One token per second, none left: about a second.
  assert.ok(slow.delayFor(now) >= 900 && slow.delayFor(now) <= 1100, `got ${slow.delayFor(now)}`);

  const fast = new TokenBucket(100);
  fast.tokens = 0;
  fast.last = now;
  assert.ok(fast.delayFor(now) <= 20, `got ${fast.delayFor(now)}`);
});

test('tokens refill over time but never exceed capacity', () => {
  const bucket = new TokenBucket(10);
  bucket.tokens = 0;
  bucket.last = Date.now() - 500;            // half a second at 10/s = 5 tokens
  assert.equal(bucket.delayFor(), 0);
  assert.ok(bucket.tokens >= 4 && bucket.tokens <= 6, `got ${bucket.tokens}`);

  bucket.last = Date.now() - 60_000;         // a minute idle
  bucket.delayFor();
  assert.equal(bucket.tokens, bucket.capacity, 'an idle bucket must not bank a minute of sends');
});

test('take() actually waits and consumes', async () => {
  const bucket = new TokenBucket(50, 1);
  await bucket.take();
  const started = Date.now();
  await bucket.take();
  assert.ok(Date.now() - started >= 15, 'the second take should have waited ~20ms');
});

test('a non-positive rate is refused rather than dividing by zero', () => {
  assert.throws(() => new TokenBucket(0));
  assert.throws(() => new TokenBucket(-1));
});
