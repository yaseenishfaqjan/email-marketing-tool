/**
 * The SES client.
 *
 * Errors are classified rather than merely logged, because the right response
 * to each is different and getting it wrong is costly:
 *
 *   permanent  — a bad address or a rejected message. Retrying burns quota and
 *                damages the account's reputation. Mark the message failed.
 *   throttle   — back off and retry; the message is fine.
 *   transient  — network or 5xx. Retry with backoff.
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import config from '../config.mjs';
import { buildMime } from './mime.mjs';

let client = null;
function getClient() {
  if (!client) {
    client = new SESv2Client({
      region: config.ses.region,
      maxAttempts: 1,   // retries are the worker's job; it owns the message row
    });
  }
  return client;
}

const PERMANENT = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
]);

export function classifyError(err) {
  const name = err?.name || err?.Code || '';
  if (name === 'TooManyRequestsException' || name === 'ThrottlingException') return 'throttle';
  if (PERMANENT.has(name)) return 'permanent';
  const status = err?.$metadata?.httpStatusCode;
  if (status && status >= 400 && status < 500 && status !== 429) return 'permanent';
  return 'transient';
}

/**
 * @param {object} args
 * @param {Buffer} args.raw            the full MIME message
 * @param {string} args.from           envelope from, must be a verified identity
 * @param {string} args.to
 * @param {string} [args.configurationSet]
 * @returns {Promise<{messageId: string}>}
 */
export async function sendRaw({ raw, from, to, configurationSet }) {
  const command = new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Raw: { Data: raw } },
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
  });
  const res = await getClient().send(command);
  return { messageId: res.MessageId };
}

/**
 * Send a message spec. The provider-neutral entry point: both adapters take
 * the same shape, and each assembles what its API wants. SES takes raw MIME,
 * so this builds it with our own builder — which is what keeps List-Unsubscribe
 * and the one-click POST header under our control rather than a vendor's.
 *
 * @param {object} m   the spec buildMime takes, plus `from` and
 *                     `configurationSet`
 */
export async function send(m) {
  return sendRaw({
    raw: buildMime(m),
    from: m.from,
    to: m.to,
    configurationSet: m.configurationSet,
  });
}

export const _test = { setClient: (c) => { client = c; } };
