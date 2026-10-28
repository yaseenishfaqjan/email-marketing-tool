/**
 * The HTTP service entry point. Everything it serves is defined in app.mjs.
 */

import config from './config.mjs';
import { pool } from './db.mjs';
import { createApp } from './app.mjs';

const server = createApp().listen(config.port, () => {
  // Name the provider, and flag the SES sandbox only when SES is the one
  // sending. Printing "SES SANDBOX" while sending through Resend says the
  // service is crippled when it is not — and the startup line is where
  // somebody checks first when mail is not arriving.
  const sandbox = config.provider === 'ses' && config.ses.sandbox ? ' — SES SANDBOX' : '';
  console.log('[api] listening on :%d (%s) via %s%s',
    config.port, config.env, config.provider, sandbox);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[api] shutting down…');
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}

export default server;
