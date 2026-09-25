#!/usr/bin/env node
/**
 * Migrations, applied in filename order, each in its own transaction.
 *
 * Applied files are recorded by name, so re-running is a no-op. Editing a file
 * that has already been applied does nothing — write a new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx, close } from '../src/db.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function run() {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);

  const { rows } = await pool.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    console.log(`  applied ${file}`);
    count += 1;
  }

  console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
}

run()
  .then(() => close())
  .catch(async (err) => {
    console.error('Migration failed:', err.message);
    await close();
    process.exit(1);
  });
