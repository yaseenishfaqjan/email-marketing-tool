/**
 * The HTTP service entry point. Everything it serves is defined in app.mjs.
 */

import config from './config.mjs';
import { pool } from './db.mjs';
import { createApp } from './app.mjs';

const server = createApp().listen(config.port, () => {
  console.log('[api] listening on :%d (%s)%s',
    config.port, config.env, config.ses.sandbox ? ' — SES SANDBOX' : '');
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
