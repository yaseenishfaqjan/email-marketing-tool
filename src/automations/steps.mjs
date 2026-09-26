/**
 * The step vocabulary, and the validation that keeps a broken automation from
 * reaching the scheduler.
 *
 * Validation happens when a step is SAVED, not when it runs. A malformed wait
 * discovered at 3am, half way through somebody's onboarding sequence, is a
 * stuck run and a customer who never hears from you again; the same mistake
 * caught at save time is a 400 and a typo fixed in ten seconds.
 */

import { compileSegment, SegmentError } from '../segments/compile.mjs';

export class StepError extends Error {}

export const STEP_TYPES = ['wait', 'email', 'condition', 'add_tag', 'remove_tag', 'webhook', 'exit'];

const MAX_WAIT_DAYS = 365;

/**
 * Turn a wait config into milliseconds.
 * Accepts { days, hours, minutes } in any combination.
 */
export function waitMs(config) {
  const days = Number(config.days ?? 0);
  const hours = Number(config.hours ?? 0);
  const minutes = Number(config.minutes ?? 0);

  for (const [name, n] of [['days', days], ['hours', hours], ['minutes', minutes]]) {
    if (!Number.isFinite(n) || n < 0) throw new StepError(`wait.${name} must be a positive number.`);
  }

  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (ms <= 0) throw new StepError('A wait step needs a duration greater than zero.');
  if (ms > MAX_WAIT_DAYS * 86_400_000) throw new StepError(`A wait may not exceed ${MAX_WAIT_DAYS} days.`);
  return ms;
}

export function validateStep(step) {
  if (!step || typeof step !== 'object') throw new StepError('Each step must be an object.');
  const { type, config = {} } = step;
  if (!STEP_TYPES.includes(type)) {
    throw new StepError(`Unknown step type "${type}". One of: ${STEP_TYPES.join(', ')}.`);
  }

  switch (type) {
    case 'wait':
      waitMs(config);
      break;

    case 'email':
      if (!config.subject) throw new StepError('An email step needs a subject.');
      if (!config.mjml) throw new StepError('An email step needs an mjml body.');
      break;

    case 'condition': {
      try {
        compileSegment(config.rules ?? config.definition);
      } catch (err) {
        throw new StepError(err instanceof SegmentError ? `condition: ${err.message}` : err.message);
      }
      // What happens when the condition is false. Default is to stop: a
      // sequence that keeps going when its precondition failed is how somebody
      // who already bought gets the "you forgot to buy" email.
      const otherwise = config.otherwise ?? 'exit';
      if (!['exit', 'continue'].includes(otherwise)) {
        throw new StepError('condition.otherwise must be "exit" or "continue".');
      }
      break;
    }

    case 'add_tag':
    case 'remove_tag':
      if (!config.tag) throw new StepError(`A ${type} step needs a tag name.`);
      break;

    case 'webhook': {
      if (!config.url) throw new StepError('A webhook step needs a url.');
      let url;
      try {
        url = new URL(config.url);
      } catch {
        throw new StepError('webhook.url is not a valid URL.');
      }
      // https only: the payload carries a contact's email address, and a
      // webhook step is configured once and then forgotten about for years.
      if (url.protocol !== 'https:') throw new StepError('webhook.url must be https.');
      break;
    }

    case 'exit':
      break;
  }

  return true;
}

export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new StepError('An automation needs at least one step.');
  }
  if (steps.length > 100) throw new StepError('An automation may not have more than 100 steps.');
  steps.forEach(validateStep);
  return true;
}
