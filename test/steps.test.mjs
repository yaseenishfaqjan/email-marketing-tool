import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStep, validateSteps, waitMs, StepError } from '../src/automations/steps.mjs';

test('wait durations combine days, hours and minutes', () => {
  assert.equal(waitMs({ minutes: 30 }), 1_800_000);
  assert.equal(waitMs({ hours: 2 }), 7_200_000);
  assert.equal(waitMs({ days: 1, hours: 12 }), 129_600_000);
});

test('a zero or negative wait is refused', () => {
  // A wait of zero turns a drip sequence into five emails in one second.
  assert.throws(() => waitMs({}), StepError);
  assert.throws(() => waitMs({ days: 0 }), StepError);
  assert.throws(() => waitMs({ hours: -1 }), StepError);
  assert.throws(() => waitMs({ days: 400 }), StepError);
});

test('an email step needs both a subject and a body', () => {
  assert.throws(() => validateStep({ type: 'email', config: { subject: 'Hi' } }), StepError);
  assert.throws(() => validateStep({ type: 'email', config: { mjml: '<mjml/>' } }), StepError);
  assert.doesNotThrow(() => validateStep({ type: 'email', config: { subject: 'Hi', mjml: '<mjml/>' } }));
});

test('a condition is validated when saved, not when it runs', () => {
  // A broken rule found at 3am mid-sequence is a stuck run and a customer who
  // never hears from you again.
  assert.throws(() => validateStep({
    type: 'condition', config: { rules: { rules: [{ field: 'password', op: 'eq', value: 'x' }] } },
  }), StepError);

  assert.doesNotThrow(() => validateStep({
    type: 'condition',
    config: { rules: { rules: [{ field: 'event', op: 'not_has', value: 'feature_used' }] } },
  }));
});

test('a condition may only exit or continue when false', () => {
  assert.throws(() => validateStep({
    type: 'condition', config: { rules: {}, otherwise: 'explode' },
  }), StepError);
});

test('webhooks must be https', () => {
  // The payload carries a contact's email address, and a webhook step is
  // configured once and then forgotten about for years.
  assert.throws(() => validateStep({ type: 'webhook', config: { url: 'http://example.com/hook' } }), StepError);
  assert.throws(() => validateStep({ type: 'webhook', config: { url: 'not a url' } }), StepError);
  assert.doesNotThrow(() => validateStep({ type: 'webhook', config: { url: 'https://example.com/hook' } }));
});

test('unknown step types are refused', () => {
  assert.throws(() => validateStep({ type: 'send_sms', config: {} }), StepError);
  assert.throws(() => validateStep(null), StepError);
});

test('an automation needs at least one step', () => {
  assert.throws(() => validateSteps([]), StepError);
  assert.throws(() => validateSteps(undefined), StepError);
  assert.doesNotThrow(() => validateSteps([{ type: 'exit', config: {} }]));
});
