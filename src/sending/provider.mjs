/**
 * Which email provider the sender talks to.
 *
 * Everything else in this codebase — rendering, suppression, warm-up caps,
 * automations, unsubscribe tokens — is provider-neutral. Only the two adapters
 * behind this module know whose API they are calling, which is what made
 * adding a second provider a day's work rather than a rewrite.
 *
 * The lookup happens per call rather than once at import. That costs a
 * property access and buys two things: switching provider needs only a
 * restart, not a redeploy, and the test suite can stub an adapter's client
 * after this module has already been imported.
 */

import config from '../config.mjs';
import * as ses from './ses.mjs';
import * as resend from './resend.mjs';

const ADAPTERS = { ses, resend };

function adapter() {
  const a = ADAPTERS[config.provider];
  if (!a) {
    throw new Error(
      `Unknown EMAIL_PROVIDER "${config.provider}". Expected one of: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }
  return a;
}

export function send(spec) {
  return adapter().send(spec);
}

/**
 * 'permanent' | 'throttle' | 'transient'.
 *
 * The worker acts on this, so the classification has to mean the same thing
 * whichever provider raised the error: permanent marks the message failed,
 * the other two requeue it.
 */
export function classifyError(err) {
  return adapter().classifyError(err);
}

export function providerName() {
  return config.provider;
}
