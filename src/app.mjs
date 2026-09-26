/**
 * The Express app, with no listener attached.
 *
 * Kept separate from server.mjs so tests can bind it to an ephemeral port
 * instead of importing a module that starts listening as a side effect.
 *
 * Route order matters in one place: the SES webhook is mounted BEFORE the JSON
 * body parser. SNS posts its envelope with Content-Type: text/plain, and the
 * signature is computed over the exact bytes — letting a JSON parser near it
 * first is how signature verification starts failing for reasons nobody can
 * reproduce.
 */

import express from 'express';
import config from './config.mjs';
import { pool } from './db.mjs';

import webhooks from './http/routes/webhooks.mjs';
import tracking from './http/routes/tracking.mjs';
import brands from './http/routes/brands.mjs';
import contacts from './http/routes/contacts.mjs';
import campaigns from './http/routes/campaigns.mjs';
import subscribe from './http/routes/subscribe.mjs';
import events from './http/routes/events.mjs';
import automations from './http/routes/automations.mjs';
import formsAdmin from './http/routes/forms.mjs';
import formPublic from './http/routes/form-public.mjs';
import templates from './http/routes/templates.mjs';
import reports from './http/routes/reports.mjs';
import warmupRoutes from './http/routes/warmup.mjs';
import dashboard from './http/routes/dashboard.mjs';

export function createApp({ logErrors = true } = {}) {
  const app = express();

  // Behind nginx. Without this req.ip is the proxy's address, which makes the
  // rate limiter useless and records the wrong consent IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use('/webhooks', webhooks);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('select 1');
      res.json({ ok: true, env: config.env, sesSandbox: config.ses.sandbox });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // Public, token-signed: open pixel, click redirect, unsubscribe.
  app.use('/', tracking);

  // Public signup forms: the embed script, the submit endpoint, the
  // confirmation link. Mounted before the JSON parser sees them, because the
  // submit route sets its own limit for a body that arrives from the open web.
  app.use('/', formPublic);

  // Brand-scoped, API key: what each product calls.
  app.use('/v1', subscribe);
  app.use('/v1', events);

  // Admin.
  app.use('/', dashboard);
  app.use('/v1/brands', brands);
  app.use('/v1/brands/:brandId', contacts);
  app.use('/v1/brands/:brandId', campaigns);
  app.use('/v1/brands/:brandId', automations);
  app.use('/v1/brands/:brandId', formsAdmin);
  app.use('/v1/brands/:brandId', templates);
  app.use('/v1/brands/:brandId', reports);
  app.use('/v1/brands/:brandId', warmupRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // The error handler never echoes err.message to the client: these messages
  // carry table names, constraint names and occasionally fragments of SQL.
  app.use((err, req, res, next) => {
    if (logErrors) console.error('[http] %s %s — %s', req.method, req.originalUrl, err.stack || err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

export default createApp;
