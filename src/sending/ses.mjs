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

export const _test = { setClient: (c) => { client = c; } };
