/**
 * Render a campaign the way a recipient would see it, without sending
 * anything or touching its statistics.
 *
 * Previewing against a REAL contact is the point. A template that looks fine
 * with "Ada" in it can fall over on the contact whose first name is empty, or
 * whose company name is 60 characters long, and those are exactly the rows an
 * imported list is full of.
 */

import { query } from '../db.mjs';
import { compileTemplate, renderMessage } from '../sending/renderer.mjs';

// A preview renders with this in place of a real message id, so its tracking
// links are syntactically valid but point at a row that does not exist. Opens
// and clicks from a preview therefore cannot pollute a campaign's numbers.
const PREVIEW_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

const SAMPLE = {
  id: PREVIEW_MESSAGE_ID,
  email: 'sample@example.com',
  first_name: 'Sam',
  last_name: 'Taylor',
  attrs: { plan: 'pro', company: 'Example Ltd' },
};

/**
 * @param {object} args
 * @param {object} args.brand
 * @param {object} args.campaign   { subject, preheader, mjml }
 * @param {string} [args.contactId]  preview as this real contact
 * @returns {Promise<{subject, html, text, contact, links}>}
 */
export async function previewCampaign({ brand, campaign, contactId = null }) {
  let contact = SAMPLE;

  if (contactId) {
    const { rows } = await query(
      'select id, email, first_name, last_name, attrs from contacts where id = $1 and brand_id = $2',
      [contactId, brand.id],
    );
    if (rows[0]) contact = { ...rows[0], id: PREVIEW_MESSAGE_ID };
  }

  const rendered = renderMessage({
    brand,
    contact,
    messageId: PREVIEW_MESSAGE_ID,
    subject: campaign.subject ?? '',
    preheader: campaign.preheader ?? null,
    compiledHtml: compileTemplate(campaign.mjml ?? ''),
  });

  return {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    contact: { email: contact.email, first_name: contact.first_name, last_name: contact.last_name },
    // The destinations as they were written, not the tracked rewrites — this
    // is for checking where the email actually points.
    links: extractOriginalLinks(campaign.mjml ?? ''),
  };
}

function extractOriginalLinks(mjml) {
  return [...new Set(
    [...mjml.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]),
  )];
}

/**
 * A handful of real contacts a campaign will actually reach, for previewing
 * against the awkward ones rather than the tidy ones.
 */
export async function sampleContacts(brandId, limit = 5) {
  const { rows } = await query(
    `select id, email, first_name, last_name
       from contacts
      where brand_id = $1 and status = 'subscribed'
      order by
        -- Contacts with a missing first name first: they are where templates
        -- break, and they are the ones nobody thinks to preview.
        (first_name is null or first_name = '') desc,
        created_at desc
      limit $2`,
    [brandId, Math.min(limit, 20)],
  );
  return rows;
}

export const _internals = { PREVIEW_MESSAGE_ID, SAMPLE };
