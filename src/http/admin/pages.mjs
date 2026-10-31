/**
 * The admin panel's pages. Pure rendering — every one takes data and returns
 * HTML, so they are trivial to read and impossible to make a query from.
 */

import { esc, num, pct, when, layout, field, textarea, csrfField, statusPill, table } from './ui.mjs';

/* ------------------------------------------------------------- overview -- */

export function overviewPage({ brand, brands, health, warmup, queue, campaigns, flash }) {
  const account = health.account ?? {};
  const level = account.level ?? 'insufficient_data';
  const levelClass = { healthy: 'good', ok: 'good', watch: 'warn', at_risk: 'bad', critical: 'bad' }[level] ?? '';

  const body = `
<h1>${esc(brand.name)}</h1>
<p class="sub">Sending from ${esc(brand.from_email)} · links on ${esc(brand.tracking_domain ?? '—')}</p>

<div class="card">
  <span class="pill ${levelClass}">${esc(String(level).replace(/_/g, ' '))}</span>
  <div class="row" style="margin-top:14px">
    <div class="stat"><div class="label">Sent (30d)</div><div class="big">${num(account.sent)}</div></div>
    <div class="stat"><div class="label">Bounce rate</div><div class="big">${account.bounce_rate != null ? esc(account.bounce_rate) + '%' : '—'}</div></div>
    <div class="stat"><div class="label">Complaint rate</div><div class="big">${account.complaint_rate != null ? esc(account.complaint_rate) + '%' : '—'}</div></div>
  </div>
  <p class="hint">Review begins around 5% bounces or 0.1% complaints; sending is paused at 10% / 0.5%. These are account-wide — every brand shares them.</p>
</div>

<h2>Warm-up</h2>
<div class="card">
  ${warmup
    ? `<div class="row">
         <div class="stat"><div class="label">Day</div><div class="big">${num(warmup.day)}</div></div>
         <div class="stat"><div class="label">Today's cap</div><div class="big">${warmup.cap == null ? 'none' : num(warmup.cap)}</div></div>
         <div class="stat"><div class="label">Sent today</div><div class="big">${num(warmup.sent_today)}</div></div>
         <div class="stat"><div class="label">Remaining</div><div class="big">${warmup.remaining == null ? '∞' : num(warmup.remaining)}</div></div>
       </div>`
    : '<p class="empty">Warm-up has not started — it begins with the first send.</p>'}
</div>

<h2>Queue</h2>
<div class="card">
  <div class="row">
    <div class="stat"><div class="label">Queued</div><div class="big">${num(queue.queued)}</div></div>
    <div class="stat"><div class="label">Sending</div><div class="big">${num(queue.sending)}</div></div>
    <div class="stat"><div class="label">Failed (24h)</div><div class="big">${num(queue.failed_24h)}</div></div>
    <div class="stat"><div class="label">Oldest wait</div><div class="big">${queue.oldest_minutes ? num(queue.oldest_minutes) + 'm' : '—'}</div></div>
  </div>
  ${queue.queued > 0 && !queue.sending
    ? '<p class="hint">Mail is waiting with nothing sending. Either the brand has hit its warm-up cap for today, or the worker is not running.</p>' : ''}
</div>

<h2>Recent campaigns</h2>
${table(
  ['Campaign', 'Status', { label: 'Recipients', right: true }, { label: 'Delivered', right: true }, { label: 'Opens', right: true }, 'When'],
  campaigns.map((c) => `<tr>
    <td><a href="/admin/b/${esc(brand.id)}/campaigns/${esc(c.id)}">${esc(c.name)}</a></td>
    <td>${statusPill(c.status)}</td>
    <td class="right">${num(c.recipients)}</td>
    <td class="right">${num(c.delivered)}</td>
    <td class="right">${num(c.opened)}</td>
    <td class="muted">${esc(when(c.sent_at ?? c.created_at))}</td>
  </tr>`),
  'No campaigns yet.')}
<div class="actions"><a class="btn" href="/admin/b/${esc(brand.id)}/campaigns">All campaigns</a></div>
`;
  return layout({ title: brand.name, body, brand, brands, tab: '', flash });
}

/* ------------------------------------------------------------ campaigns -- */

export function campaignsPage({ brand, brands, campaigns, templates, csrf, flash }) {
  const body = `
<h1>Campaigns</h1>
<p class="sub">${num(campaigns.length)} total</p>

<div class="card">
  <form method="post" action="/admin/b/${esc(brand.id)}/campaigns">
    ${csrfField(csrf)}
    <strong>New campaign</strong>
    ${field('name', 'Name', '', { placeholder: 'November newsletter', hint: 'Internal only — recipients never see it.' })}
    ${field('subject', 'Subject line', '', { placeholder: 'What you missed this month' })}
    <label for="template_id">Start from</label>
    <select id="template_id" name="template_id">
      ${templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.description ?? '')}</option>`).join('')}
    </select>
    <div class="actions"><button class="primary" type="submit">Create draft</button></div>
  </form>
</div>

${table(
  ['Campaign', 'Status', { label: 'Recipients', right: true }, { label: 'Delivered', right: true }, { label: 'Bounced', right: true }, 'Created'],
  campaigns.map((c) => `<tr>
    <td><a href="/admin/b/${esc(brand.id)}/campaigns/${esc(c.id)}">${esc(c.name)}</a>
        <div class="muted" style="font-size:12.5px">${esc(c.subject)}</div></td>
    <td>${statusPill(c.status)}</td>
    <td class="right">${num(c.recipients)}</td>
    <td class="right">${num(c.delivered)}</td>
    <td class="right">${num(c.bounced)}</td>
    <td class="muted">${esc(when(c.created_at))}</td>
  </tr>`),
  'Nothing here yet. Create a draft above.')}
`;
  return layout({ title: 'Campaigns', body, brand, brands, tab: 'campaigns', flash });
}

export function campaignEditorPage({ brand, brands, campaign, lint, stats, sampleContacts, csrf, flash }) {
  const base = `/admin/b/${esc(brand.id)}/campaigns/${esc(campaign.id)}`;
  const editable = ['draft', 'paused'].includes(campaign.status);

  const problems = [
    ...lint.errors.map((e) => ({ ...e, bad: true })),
    ...lint.warnings.map((w) => ({ ...w, bad: false })),
  ];

  const lintHtml = problems.length
    ? `<div class="card">
         <strong>Before you send</strong>
         <ul style="margin:10px 0 0;padding-left:20px;font-size:14px">
           ${problems.map((p) => `<li style="margin-bottom:6px">
             <span class="pill ${p.bad ? 'bad' : 'warn'}">${p.bad ? 'error' : 'warning'}</span>
             ${esc(p.message ?? p.code)}</li>`).join('')}
         </ul>
         ${lint.ok ? '' : '<p class="hint">Errors have to be fixed before sending. They are the ones that cannot be undone once mail has left.</p>'}
       </div>`
    : '<div class="card"><span class="pill good">no problems found</span></div>';

  const statsHtml = stats && stats.recipients
    ? `<h2>Results</h2>
       <div class="card"><div class="row">
         <div class="stat"><div class="label">Recipients</div><div class="big">${num(stats.recipients)}</div></div>
         <div class="stat"><div class="label">Delivered</div><div class="big">${num(stats.delivered)}</div></div>
         <div class="stat"><div class="label">Opened</div><div class="big">${pct(stats.opened, stats.delivered)}</div></div>
         <div class="stat"><div class="label">Clicked</div><div class="big">${pct(stats.clicked, stats.delivered)}</div></div>
         <div class="stat"><div class="label">Bounced</div><div class="big">${num(stats.bounced)}</div></div>
         <div class="stat"><div class="label">Complaints</div><div class="big">${num(stats.complained)}</div></div>
       </div></div>` : '';

  const body = `
<h1>${esc(campaign.name)}</h1>
<p class="sub">${statusPill(campaign.status)} · created ${esc(when(campaign.created_at))}${campaign.sent_at ? ' · sent ' + esc(when(campaign.sent_at)) : ''}</p>

${lintHtml}
${statsHtml}

<div class="grid2">
  <div>
    <h2>Content</h2>
    <form method="post" action="${base}">
      ${csrfField(csrf)}
      ${field('subject', 'Subject', campaign.subject)}
      ${field('preheader', 'Preheader', campaign.preheader ?? '', { hint: 'The grey line after the subject in most inboxes.' })}
      ${textarea('mjml', 'MJML', campaign.mjml, { rows: 22 })}
      <div class="actions">
        <button class="primary" type="submit"${editable ? '' : ' disabled'}>Save</button>
        ${editable ? '' : '<span class="hint">A campaign that has started cannot be edited.</span>'}
      </div>
    </form>
  </div>
  <div>
    <h2>Preview</h2>
    <iframe class="preview" src="${base}/preview.html" title="Preview"></iframe>
    <p class="hint">Rendered against a real contact where one exists — a template that looks right with a name in it often breaks on the rows without one.</p>
  </div>
</div>

<h2>Send a test</h2>
<div class="card">
  <form method="post" action="${base}/test">
    ${csrfField(csrf)}
    ${field('to', 'To', '', { type: 'email', placeholder: 'you@example.com' })}
    <div class="actions"><button type="submit">Send test</button></div>
  </form>
  <p class="hint">Goes straight out, bypassing the queue and the warm-up cap. It is not recorded against this campaign's numbers.</p>
</div>

<h2>Send for real</h2>
<div class="card">
  ${['sending', 'sent'].includes(campaign.status)
    ? `<p class="empty">Already ${esc(campaign.status)}.</p>
       ${campaign.status === 'sending' ? `<form method="post" action="${base}/pause">${csrfField(csrf)}
         <div class="actions"><button class="danger" type="submit">Pause</button></div></form>
         <p class="hint">Pausing stops what has not left yet. What has already gone cannot be recalled.</p>` : ''}`
    : `<form method="post" action="${base}/send" onsubmit="return confirm('Send to every subscribed contact in ${esc(brand.name).replace(/'/g, '')}? This cannot be undone.')">
         ${csrfField(csrf)}
         <p style="font-size:14px;margin:0 0 4px">This sends to every subscribed contact, minus anyone suppressed.</p>
         <div class="actions">
           <button class="primary" type="submit"${lint.ok ? '' : ' disabled'}>Send now</button>
           ${lint.ok ? '' : '<span class="hint">Fix the errors above first.</span>'}
         </div>
       </form>`}
</div>
`;
  return layout({ title: campaign.name, body, brand, brands, tab: 'campaigns', flash });
}

/* ------------------------------------------------------------- contacts -- */

export function contactsPage({ brand, brands, contacts, q, status, offset, limit, csrf, flash }) {
  const base = `/admin/b/${esc(brand.id)}/contacts`;
  const qs = (o) => {
    const p = new URLSearchParams({ q: q ?? '', status: status ?? '', ...o });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return p.toString();
  };

  const body = `
<h1>Contacts</h1>
<p class="sub">Showing ${num(contacts.length)} from ${num(offset + 1)}</p>

<form class="searchbar" method="get" action="${base}">
  <input type="text" name="q" value="${esc(q ?? '')}" placeholder="Search name or email">
  <select name="status">
    ${['', 'subscribed', 'pending', 'unsubscribed', 'bounced', 'complained']
      .map((s) => `<option value="${s}"${s === (status ?? '') ? ' selected' : ''}>${s || 'any status'}</option>`).join('')}
  </select>
  <button type="submit">Search</button>
  <a class="btn" href="${base}/import">Import CSV</a>
</form>

${table(
  ['Email', 'Name', 'Status', 'Consent', 'Added'],
  contacts.map((c) => `<tr>
    <td>${esc(c.email)}</td>
    <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' ')) || '<span class="muted">—</span>'}</td>
    <td>${statusPill(c.status)}</td>
    <td class="muted" style="font-size:12.5px">${esc(c.consent_source ?? '—')}<br>${esc(when(c.consent_at))}</td>
    <td class="muted">${esc(when(c.created_at))}</td>
  </tr>`),
  q || status ? 'Nothing matched that search.' : 'No contacts yet. Import a CSV or point a signup form at this brand.')}

<div class="pager">
  ${offset > 0 ? `<a class="btn" href="${base}?${qs({ offset: Math.max(0, offset - limit) })}">Previous</a>` : ''}
  ${contacts.length === limit ? `<a class="btn" href="${base}?${qs({ offset: offset + limit })}">Next</a>` : ''}
</div>
`;
  return layout({ title: 'Contacts', body, brand, brands, tab: 'contacts', flash });
}

export function importPage({ brand, brands, dryRun, csv, csrf, flash }) {
  const base = `/admin/b/${esc(brand.id)}/contacts/import`;

  const verdictClass = { ok: 'good', check_consent: 'warn', clean_first: 'warn', do_not_import: 'bad' };

  const resultHtml = dryRun ? `
<div class="card">
  <span class="pill ${verdictClass[dryRun.verdict?.level] ?? ''}">${esc(String(dryRun.verdict?.level ?? '').replace(/_/g, ' '))}</span>
  ${dryRun.verdict?.reason ? `<p style="margin:10px 0 0;font-size:14px">${esc(dryRun.verdict.reason)}</p>` : ''}
  <div class="row" style="margin-top:16px">
    <div class="stat"><div class="label">Rows</div><div class="big">${num(dryRun.counts.total)}</div></div>
    <div class="stat"><div class="label">Valid</div><div class="big">${num(dryRun.counts.valid)}</div></div>
    <div class="stat"><div class="label">Malformed</div><div class="big">${num(dryRun.counts.malformed)}</div></div>
    <div class="stat"><div class="label">Duplicates</div><div class="big">${num(dryRun.counts.duplicates)}</div></div>
    <div class="stat"><div class="label">Role accounts</div><div class="big">${num(dryRun.counts.role)}</div></div>
    <div class="stat"><div class="label">Disposable</div><div class="big">${num(dryRun.counts.disposable)}</div></div>
    <div class="stat"><div class="label">Already suppressed</div><div class="big">${num(dryRun.counts.already_suppressed)}</div></div>
  </div>
  <p class="hint" style="margin-top:14px"><strong>${num(dryRun.would_import)}</strong> would be imported. Nothing has been written yet.</p>
</div>

${Object.entries(dryRun.samples ?? {}).filter(([, v]) => v?.length).map(([k, v]) => `
<div class="card"><strong>${esc(k.replace(/_/g, ' '))}</strong>
  <pre style="margin-top:10px">${esc(v.slice(0, 10).join('\n'))}</pre></div>`).join('')}

<form method="post" action="${base}">
  ${csrfField(csrf)}
  <input type="hidden" name="csv" value="${esc(csv)}">
  <input type="hidden" name="confirm" value="yes">
  ${field('consent', 'How did these people consent?', '', {
    placeholder: 'Checkout opt-in, 2024–2026',
    hint: 'Recorded against every contact. If you cannot answer it, do not import the list.' })}
  <div class="actions">
    <button class="primary" type="submit"${dryRun.verdict?.level === 'do_not_import' ? ' disabled' : ''}>Import ${num(dryRun.would_import)} contacts</button>
    <a class="btn" href="${base}">Start over</a>
  </div>
</form>` : '';

  const body = `
<h1>Import contacts</h1>
<p class="sub">Paste a CSV with an <code>email</code> column. Checked first, written only when you confirm.</p>

${resultHtml || `
<div class="card">
  <form method="post" action="${base}">
    ${csrfField(csrf)}
    ${textarea('csv', 'CSV', '', { rows: 14, hint: 'First row is the header. An "email" column is required; "first_name", "last_name" and any other columns are kept as attributes.' })}
    <div class="actions"><button class="primary" type="submit">Check this list</button></div>
  </form>
</div>
<div class="card">
  <strong>Why the check matters</strong>
  <p style="font-size:14px;margin:8px 0 0">Every brand you run sends from the same domain, so one bad list does not damage one brand's reputation — it damages all of them at once. The dry run reports malformed addresses, disposable domains, role accounts, duplicates and anyone already suppressed, before a single row is written.</p>
</div>`}
`;
  return layout({ title: 'Import', body, brand, brands, tab: 'contacts', flash });
}

/* ---------------------------------------------------------- suppressed -- */

export function suppressionsPage({ brand, brands, rows, csrf, flash }) {
  const base = `/admin/b/${esc(brand.id)}/suppressions`;
  const body = `
<h1>Suppressed addresses</h1>
<p class="sub">Mail is never sent to these, whatever a list says.</p>

${table(
  ['Email', 'Reason', 'Scope', 'Added', ''],
  rows.map((s) => `<tr>
    <td>${esc(s.email)}</td>
    <td>${statusPill(s.reason)}</td>
    <td class="muted">${s.brand_id ? 'this brand' : 'all brands'}</td>
    <td class="muted">${esc(when(s.created_at))}</td>
    <td class="right">
      <form method="post" action="${base}/remove" onsubmit="return confirm('Remove ${esc(s.email).replace(/'/g, '')} from the suppression list? Only do this if they asked to be re-added.')">
        ${csrfField(csrf)}
        <input type="hidden" name="email" value="${esc(s.email)}">
        <button class="danger" type="submit">Remove</button>
      </form>
    </td>
  </tr>`),
  'Nothing suppressed yet.')}

<h2>Add one by hand</h2>
<div class="card">
  <form method="post" action="${base}">
    ${csrfField(csrf)}
    ${field('email', 'Email', '', { type: 'email' })}
    ${field('note', 'Note', '', { placeholder: 'Asked by phone not to be contacted' })}
    <label><input type="checkbox" name="global" value="yes" style="width:auto"> Apply to every brand</label>
    <div class="actions"><button type="submit">Suppress</button></div>
  </form>
</div>
`;
  return layout({ title: 'Suppressed', body, brand, brands, tab: 'suppressions', flash });
}

/* --------------------------------------------------------------- forms -- */

export function formsPage({ brand, brands, forms, publicUrl, flash }) {
  const body = `
<h1>Signup forms</h1>
<p class="sub">Drop one of these on a site and subscribers land here.</p>

${forms.length ? forms.map((f) => `
<div class="card">
  <strong>${esc(f.name)}</strong> ${statusPill(f.status)}
  ${f.double_optin ? '<span class="pill good">double opt-in</span>' : '<span class="pill warn">single opt-in</span>'}
  <p class="hint">Paste this where the form should appear:</p>
  <pre>&lt;script src="${esc(publicUrl)}/f/${esc(f.id)}.js" async&gt;&lt;/script&gt;</pre>
</div>`).join('') : '<p class="empty">No forms yet. They are created through the API for now.</p>'}
`;
  return layout({ title: 'Forms', body, brand, brands, tab: 'forms', flash });
}

/* ---------------------------------------------------------- automations -- */

export function automationsPage({ brand, brands, automations, flash }) {
  const body = `
<h1>Automations</h1>
<p class="sub">Sequences that send themselves when something happens.</p>

${table(
  ['Name', 'Trigger', 'Status', { label: 'Steps', right: true }, { label: 'Active runs', right: true }],
  automations.map((a) => `<tr>
    <td>${esc(a.name)}</td>
    <td class="muted">${esc(a.trigger_type)}${a.trigger_config?.event ? ': ' + esc(a.trigger_config.event) : ''}</td>
    <td>${statusPill(a.status)}</td>
    <td class="right">${num(a.step_count)}</td>
    <td class="right">${num(a.active_runs)}</td>
  </tr>`),
  'No automations yet. They are created through the API for now.')}
`;
  return layout({ title: 'Automations', body, brand, brands, tab: 'automations', flash });
}

/* --------------------------------------------------------- brand picker -- */

export function brandsPage({ brands }) {
  const body = `
<h1>Choose a brand</h1>
<p class="sub">Each one has its own contacts, campaigns and suppression scope.</p>
${brands.length ? `<div class="card">${brands.map((b) => `
  <p style="margin:0 0 12px"><a href="/admin/b/${esc(b.id)}"><strong>${esc(b.name)}</strong></a>
     <span class="muted">— ${esc(b.from_email)}</span></p>`).join('')}</div>`
  : '<p class="empty">No brands yet.</p>'}
`;
  return layout({ title: 'Brands', body, brands: [] });
}
