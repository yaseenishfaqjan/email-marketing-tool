/**
 * The database pool, plus the two helpers every query in this codebase uses.
 *
 * `tx` exists because the correctness of the send pipeline depends on
 * materialising a campaign's messages in one transaction. Half a campaign's
 * rows is not a recoverable state.
 */

import pg from 'pg';
import config from './config.mjs';

// Return BIGINT as a Number rather than a string. Safe here: the only bigint
// is message_events.id, and Number.MAX_SAFE_INTEGER is 9e15 events away.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Without this a dropped connection hangs a worker forever instead of
  // failing the job and letting it retry.
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function close() {
  await pool.end();
}
