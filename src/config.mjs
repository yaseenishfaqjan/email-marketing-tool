/**
 * Configuration, read once at startup.
 *
 * Anything whose absence would cause silent wrong behaviour is validated here
 * and fails the process. A missing TOKEN_SECRET must never fall back to a
 * default — every unsubscribe link ever issued would then be forgeable.
 */

import 'dotenv/config';

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
};

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num('PORT', 8080),
  databaseUrl: required('DATABASE_URL'),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),

  tokenSecret: required('TOKEN_SECRET'),
  adminToken: required('ADMIN_TOKEN'),

  // Which adapter in src/sending/ actually talks to a provider: 'ses' or
  // 'resend'. Everything upstream of the adapter is identical either way.
  provider: (process.env.EMAIL_PROVIDER || 'ses').toLowerCase(),

  ses: {
    region: process.env.AWS_REGION || 'us-east-1',
    maxSendRate: num('SES_MAX_SEND_RATE', 10),
    sandbox: bool('SES_SANDBOX', true),
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    maxSendRate: num('RESEND_MAX_SEND_RATE', 8),
    timeoutMs: num('RESEND_TIMEOUT_MS', 15000),
  },

  worker: {
    batchSize: num('SEND_BATCH_SIZE', 100),
    pollMs: num('WORKER_POLL_MS', 2000),
  },
};

// Fail at startup rather than on the first send. A worker that starts
// cleanly and then fails every message against a missing key looks like a
// deliverability problem, and costs an afternoon before anyone checks the
// environment.
if (config.provider === 'resend' && !config.resend.apiKey) {
  throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is not set');
}

if (config.tokenSecret.length < 32) {
  throw new Error('TOKEN_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

export default config;
