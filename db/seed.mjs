#!/usr/bin/env node
/**
 * Seed one brand, a handful of contacts and a draft campaign, so that a fresh
 * database can send something within a minute of `npm run migrate`.
 *
 * Safe to re-run: everything is an upsert.
 */

import { query, close } from '../src/db.mjs';
import { generateApiKey, hashApiKey } from '../src/tokens.mjs';
import { installStarters } from '../src/templates/repo.mjs';

const BRAND = {
  slug: 'demo',
  name: 'Demo Brand',
  from_name: 'Demo Brand',
  from_email: 'hello@mail.example.com',
  sending_domain: 'mail.example.com',
  postal_address: '1 Example Street, Example City, EX1 2MP',
};

const MJML = `<mjml>
  <mj-body background-color="#f7f5f1">
    <mj-section background-color="#ffffff">
      <mj-column>
        <mj-text font-size="22px">Hello {{first_name}},</mj-text>
        <mj-text>This is a test of the email platform. Nothing is being sold.</mj-text>
        <mj-button href="https://example.com/pricing">See the pricing</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

async function seed() {
  // Idempotent, and safe to run on every deploy.
  console.log('starter templates:', await installStarters());

  const { rows: brands } = await query(
    `insert into brands (slug, name, from_name, from_email, sending_domain, postal_address)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (slug) do update set name = excluded.name
     returning *`,
    [BRAND.slug, BRAND.name, BRAND.from_name, BRAND.from_email, BRAND.sending_domain, BRAND.postal_address],
  );
  const brand = brands[0];
  console.log('brand:', brand.id, brand.slug);

  for (const [i, email] of ['ada@example.com', 'grace@example.com', 'alan@example.com'].entries()) {
    await query(
      `insert into contacts (brand_id, email, first_name, status, source, consent_at, consent_source)
       values ($1,$2,$3,'subscribed','seed',now(),'seed script')
       on conflict (brand_id, email) do nothing`,
      [brand.id, email, ['Ada', 'Grace', 'Alan'][i]],
    );
  }
  console.log('contacts: 3');

  const { rows: campaigns } = await query(
    `insert into campaigns (brand_id, name, subject, mjml)
     values ($1,'Seed campaign','A test from {{first_name}}''s platform',$2)
     returning id`,
    [brand.id, MJML],
  );
  console.log('campaign:', campaigns[0].id);

  const secret = generateApiKey(brand.slug);
  await query(
    `insert into api_keys (brand_id, name, key_hash) values ($1,'seed',$2)
     on conflict (key_hash) do nothing`,
    [brand.id, hashApiKey(secret)],
  );
  console.log('api key: ', secret);
  console.log('\nThis key is shown once. Nothing here is verified with SES, so sending will fail');
  console.log('until real brand details and a verified domain are in place.');
}

seed().then(close).catch(async (err) => {
  console.error(err.message);
  await close();
  process.exit(1);
});
