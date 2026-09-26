/**
 * Signup forms, and the double opt-in that turns a submission into consent.
 *
 * The distinction this module is built around: a submission is a CLAIM, not a
 * fact. Anybody can type anybody's address into a form on the open internet.
 * It becomes consent only when the confirmation link is clicked from that
 * mailbox, and both halves are recorded as evidence.
 */

import { query, tx } from '../db.mjs';
import { mint, verify } from '../tokens.mjs';
import * as contacts from '../contacts/repo.mjs';
import { onSubscribed, onTagAdded } from '../automations/enrol.mjs';

export class FormError extends Error {}

/** How long a confirmation link stays good. */
export const CONFIRM_TTL_HOURS = 168;   // 7 days

const DEFAULT_CONFIRM_SUBJECT = 'Please confirm your subscription';

const DEFAULT_CONFIRM_MJML = `<mjml>
  <mj-body background-color="#f7f5f1">
    <mj-section background-color="#ffffff">
      <mj-column>
        <mj-text font-size="20px">Confirm your subscription</mj-text>
        <mj-text>Click below to confirm you want to hear from us. If you did not
        request this, ignore this email and nothing will happen.</mj-text>
        <mj-button href="{{confirm_url}}">Confirm my subscription</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/**
 * A confirmation body must contain the link, or the email is a dead end and
 * every signup from that form silently fails. Checked when the form is saved.
 */
export function validateConfirmTemplate(mjml) {
  if (!mjml) return true;
  if (!mjml.includes('{{confirm_url}}')) {
    throw new FormError('The confirmation email must contain {{confirm_url}}, or nobody can confirm.');
  }
  return true;
}

const ALLOWED_FIELDS = new Set(['email', 'first_name', 'last_name']);

/** Field definitions are a whitelist: a form cannot invent a column. */
export function validateFields(fields) {
  if (!Array.isArray(fields)) throw new FormError('fields must be an array.');
  for (const field of fields) {
    const name = typeof field === 'string' ? field : field?.name;
    if (!ALLOWED_FIELDS.has(name)) {
      throw new FormError(`Unknown field "${name}". One of: ${[...ALLOWED_FIELDS].join(', ')}.`);
    }
  }
  return true;
}

export async function getPublic(formId) {
  const { rows } = await query(
    // double_optin and tag_ids are load-bearing: without them every form
    // silently falls through to single opt-in and drops its tags.
    `select f.id, f.brand_id, f.name, f.fields, f.headline, f.description,
            f.button_label, f.success_message, f.theme, f.status, f.allowed_origins,
            f.redirect_url, f.double_optin, f.tag_ids,
            b.name as brand_name, b.tracking_domain
       from forms f join brands b on b.id = f.brand_id
      where f.id = $1`,
    [formId],
  );
  return rows[0] ?? null;
}

/**
 * Is this page allowed to post to this form?
 *
 * Without the check, any site on the internet can fill a brand's list with
 * whatever it likes. An empty allowlist means "not yet configured" and is
 * treated as closed, not open — the safe direction to fail.
 */
export function originAllowed(form, origin) {
  if (!Array.isArray(form.allowed_origins) || form.allowed_origins.length === 0) return false;
  if (form.allowed_origins.includes('*')) return true;
  if (!origin) return false;
  try {
    const host = new URL(origin).host.toLowerCase();
    return form.allowed_origins.some((allowed) => {
      const a = String(allowed).trim().toLowerCase();
      if (!a) return false;
      const allowedHost = a.includes('://') ? new URL(a).host : a;
      // A leading dot means "and its subdomains": .scalaro.io covers
      // app.scalaro.io without also matching notscalaro.io.
      if (allowedHost.startsWith('.')) return host === allowedHost.slice(1) || host.endsWith(allowedHost);
      return host === allowedHost;
    });
  } catch {
    return false;
  }
}

/**
 * Record a submission and, if double opt-in is on, queue the confirmation.
 *
 * Everything happens in one transaction. A submission stored without its
 * confirmation email is somebody sitting forever on a "check your inbox"
 * message that never arrives.
 */
export async function submit({ form, email, fields = {}, ip = null, userAgent = null, referer = null }) {
  if (!contacts.isValidEmail(email)) throw new FormError('A valid email address is required.');
  const normalised = contacts.normaliseEmail(email);

  return tx(async (client) => {
    // Global suppression — a hard bounce or a spam complaint — is absolute.
    // That is about protecting the sending account, which every brand shares,
    // and no form submission overrides it.
    const { rows: globallySuppressed } = await client.query(
      "select 1 from suppressions where email = $1 and brand_id is null limit 1",
      [normalised],
    );
    if (globallySuppressed.length) {
      await client.query(
        `insert into form_submissions (form_id, brand_id, email, fields, ip, user_agent, referer, status)
         values ($1,$2,$3,$4,$5,$6,$7,'blocked')`,
        [form.id, form.brand_id, normalised, JSON.stringify(fields), ip, userAgent, referer],
      );
      // Answered as success. Telling the visitor their address is suppressed
      // turns a public form into a way to test whether somebody complained.
      return { accepted: true, suppressed: true };
    }

    // One live confirmation at a time. A double-clicked button, or somebody
    // submitting five times because nothing seemed to happen, must not put
    // five identical emails in their inbox.
    const { rows: pending } = await client.query(
      `select id, confirm_sent_at from form_submissions
        where form_id = $1 and email = $2 and status = 'pending'
          and created_at > now() - ($3 || ' hours')::interval
        order by created_at desc limit 1`,
      [form.id, normalised, String(CONFIRM_TTL_HOURS)],
    );
    if (pending.length) {
      return { accepted: true, resent: false, submissionId: pending[0].id, alreadyPending: true };
    }

    const { rows: submissions } = await client.query(
      `insert into form_submissions (form_id, brand_id, email, fields, ip, user_agent, referer)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [form.id, form.brand_id, normalised, JSON.stringify(fields), ip, userAgent, referer],
    );
    const submission = submissions[0];

    // Single opt-in: subscribe immediately. Available, but not the default —
    // see the note in the migration about why.
    if (!form.double_optin) {
      const contact = await confirmContact(client, { form, submission, ip });
      return { accepted: true, confirmed: true, contactId: contact.id, submissionId: submission.id };
    }

    await queueConfirmation(client, { form, submission });
    return { accepted: true, confirmationQueued: true, submissionId: submission.id };
  });
}

/** Put the confirmation email in the same queue everything else uses. */
async function queueConfirmation(client, { form, submission }) {
  // The contact exists as 'pending' from here, so the confirmation can be
  // rendered and tracked like any other message. Pending contacts are excluded
  // from every campaign and automation until they confirm.
  const contact = await contacts.upsert(form.brand_id, {
    email: submission.email,
    first_name: submission.fields?.first_name ?? null,
    last_name: submission.fields?.last_name ?? null,
    status: 'pending',
    source: `form:${form.name}`,
  }, client);

  await client.query('update form_submissions set contact_id = $2 where id = $1',
    [submission.id, contact.id]);

  await client.query(
    `insert into messages (brand_id, contact_id, form_submission_id)
     values ($1,$2,$3) on conflict do nothing`,
    [form.brand_id, contact.id, submission.id],
  );

  await client.query('update form_submissions set confirm_sent_at = now() where id = $1', [submission.id]);
  return contact;
}

/** The signed link that appears in the confirmation email. */
export function confirmUrl(baseUrl, submissionId) {
  return `${baseUrl}/confirm/${mint('v', { s: submissionId })}`;
}

export function readConfirmToken(token) {
  const data = verify('v', token);
  return data?.s ?? null;
}

/**
 * Turn a confirmed submission into a subscriber.
 *
 * This is also where a previous unsubscribe is undone. Someone who left, then
 * filled in a form again and clicked a link in their own inbox, has given
 * fresh and better-evidenced consent than they did the first time. A hard
 * bounce or complaint is different and is never cleared here — that is
 * global suppression, and it stays.
 */
async function confirmContact(client, { form, submission, ip = null }) {
  const contact = await contacts.upsert(form.brand_id, {
    email: submission.email,
    first_name: submission.fields?.first_name ?? null,
    last_name: submission.fields?.last_name ?? null,
    status: 'pending',
    source: `form:${form.name}`,
    consent_at: new Date().toISOString(),
    consent_ip: ip,
    consent_source: `Double opt-in confirmed — form "${form.name}"`,
  }, client);

  await client.query(
    `update contacts
        set status = 'subscribed', updated_at = now(),
            consent_at = coalesce(consent_at, now()),
            consent_ip = coalesce($3, consent_ip),
            consent_source = $4
      where id = $1 and brand_id = $2 and status in ('pending','unsubscribed')`,
    [contact.id, form.brand_id, ip, `Double opt-in confirmed — form "${form.name}"`],
  );

  await client.query(
    "delete from suppressions where email = $1 and brand_id = $2 and reason = 'unsubscribe'",
    [submission.email, form.brand_id],
  );

  for (const tagId of form.tag_ids ?? []) {
    await client.query(
      `insert into contact_tags (contact_id, tag_id)
       select $1, $2 where exists (select 1 from tags where id = $2 and brand_id = $3)
       on conflict do nothing`,
      [contact.id, tagId, form.brand_id],
    );
  }

  return contact;
}

/**
 * The confirmation link was clicked.
 *
 * Idempotent: mail clients prefetch links, people double-click, and somebody
 * will bookmark it. A second visit reports success rather than an error.
 */
export async function confirm({ submissionId, ip = null }) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `select s.*, f.id as form_id, f.name as form_name, f.brand_id, f.tag_ids,
              f.confirmed_redirect_url, f.double_optin
         from form_submissions s join forms f on f.id = s.form_id
        where s.id = $1
        for update of s`,
      [submissionId],
    );
    const submission = rows[0];
    if (!submission) return { confirmed: false, reason: 'not found' };

    if (submission.status === 'confirmed') {
      return { confirmed: true, already: true, redirect: submission.confirmed_redirect_url };
    }
    if (submission.status === 'blocked') return { confirmed: false, reason: 'blocked' };

    const ageHours = (Date.now() - new Date(submission.created_at).getTime()) / 3_600_000;
    if (ageHours > CONFIRM_TTL_HOURS) {
      await client.query("update form_submissions set status = 'expired' where id = $1", [submission.id]);
      return { confirmed: false, reason: 'expired' };
    }

    const form = {
      id: submission.form_id,
      name: submission.form_name,
      brand_id: submission.brand_id,
      tag_ids: submission.tag_ids,
    };
    const contact = await confirmContact(client, { form, submission, ip });

    await client.query(
      `update form_submissions
          set status = 'confirmed', confirmed_at = now(), confirmed_ip = $2, contact_id = $3
        where id = $1`,
      [submission.id, ip, contact.id],
    );

    return {
      confirmed: true,
      contactId: contact.id,
      brandId: submission.brand_id,
      formName: submission.form_name,
      tagIds: submission.tag_ids ?? [],
      redirect: submission.confirmed_redirect_url,
    };
  });
}

/**
 * Fire the welcome automations, once the confirmation transaction has
 * committed.
 *
 * Deliberately outside the transaction: enrolment reads the contact's status,
 * and inside the same transaction it would read the pre-commit value. It is
 * also the slow part, and nobody should stare at a blank page while a welcome
 * sequence is looked up.
 */
export async function enrolAfterConfirm(result) {
  if (!result?.confirmed || result.already || !result.contactId) return;
  try {
    await onSubscribed({
      brandId: result.brandId,
      contactId: result.contactId,
      source: `form:${result.formName}`,
    });
    for (const tagId of result.tagIds) {
      const { rows } = await query('select name from tags where id = $1', [tagId]);
      if (rows[0]) {
        await onTagAdded({ brandId: result.brandId, contactId: result.contactId, tagName: rows[0].name });
      }
    }
  } catch (err) {
    // A failed welcome sequence must never make a successful confirmation
    // look like a failure to the person who just confirmed.
    console.error('[forms] post-confirm enrolment failed: %s', err.message);
  }
}

export const DEFAULTS = { DEFAULT_CONFIRM_SUBJECT, DEFAULT_CONFIRM_MJML };
