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

  ses: {
    region: process.env.AWS_REGION || 'us-east-1',
    maxSendRate: num('SES_MAX_SEND_RATE', 10),
    sandbox: bool('SES_SANDBOX', true),
  },

  worker: {
    batchSize: num('SEND_BATCH_SIZE', 100),
    pollMs: num('WORKER_POLL_MS', 2000),
  },
};

if (config.tokenSecret.length < 32) {
  throw new Error('TOKEN_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

export default config;
