/**
 * The operations dashboard.
 *
 * One page, server-rendered, no build step and no framework — the same
 * constraint the rest of this codebase works under. It is not a replacement
 * for an admin UI; it answers the three questions somebody actually has
 * during a launch week:
 *
 *   Is the sending account in danger?
 *   Where is each brand on its warm-up?
 *   Is anything stuck?
 *
 * Deliberately read-only. A dashboard that can also delete things is a
 * dashboard nobody dares leave open on a second monitor.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const LEVEL_COLOURS = {
  healthy: '#1a7f5a', ok: '#1a7f5a', watch: '#a06a00',
  at_risk: '#c2410c', critical: '#b3261e', insufficient_data: '#6b655e',
};

const num = (n) => (n ?? 0).toLocaleString('en-GB');

export function renderDashboard({ health, warmup, queues, campaigns, generatedAt }) {
  const account = health.account;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sending dashboard</title>
<meta name="robots" content="noindex">
<style>
  :root{--ink:#1a1714;--muted:#6b655e;--line:#e6e2dc;--bg:#f7f5f1;--card:#fff}
  @media (prefers-color-scheme:dark){
    :root{--ink:#f2efea;--muted:#a49c92;--line:#332f2a;--bg:#16130f;--card:#1f1b17}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--ink);
       font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5}
  main{max-width:1000px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 28px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
     margin:32px 0 12px;font-weight:600}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
  .banner{border-left:4px solid var(--level);padding-left:16px}
  .level{color:var(--level);font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:.06em}
  .big{font-size:30px;font-weight:700;letter-spacing:-.02em}
  .row{display:flex;gap:28px;flex-wrap:wrap;margin-top:8px}
  .stat .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  /* Somebody will open this on a phone during a launch. The TABLE scrolls,
     not the page: a dashboard you have to drag sideways to read is one you
     stop opening. */
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
  table{width:100%;border-collapse:collapse;font-size:14px;min-width:520px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
     font-weight:600;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
  td{padding:11px 10px 11px 0;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .right{text-align:right}
  .muted{color:var(--muted)}
  .bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:6px;max-width:220px}
  .bar span{display:block;height:100%;background:#1a7f5a}
  .pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;
        border:1px solid var(--line);color:var(--muted)}
  .empty{color:var(--muted);font-size:14px;padding:8px 0}
  footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style></head><body><main>

<h1>Sending dashboard</h1>
<p class="sub">Last ${health.window_days} days · generated ${esc(generatedAt)}</p>

<div class="card banner" style="--level:${LEVEL_COLOURS[account.status.level] ?? 'var(--muted)'}">
  <div class="level">Account · ${esc(account.status.level.replace(/_/g, ' '))}</div>
  <div class="big">${account.rates.bounce}% bounces · ${account.rates.complaint}% complaints</div>
  <p class="muted" style="margin:6px 0 0">${esc(account.status.message)}</p>
  <div class="row">
    <div class="stat"><div class="label">Sent</div><div>${num(account.sent)}</div></div>
    <div class="stat"><div class="label">SES review at</div><div>5% · 0.1%</div></div>
    <div class="stat"><div class="label">SES pauses at</div><div>10% · 0.5%</div></div>
  </div>
  <p class="muted" style="margin:10px 0 0;font-size:12px">
    These thresholds apply to the whole AWS account. One brand can pause sending for all of them.</p>
</div>

<h2>Deliverability by brand</h2>
<div class="card">
${health.brands.length ? `<div class="scroll"><table>
<tr><th>Brand</th><th class="right">Sent</th><th class="right">Delivered</th>
    <th class="right">Bounced</th><th class="right">Complained</th><th>Verdict</th></tr>
${health.brands.map((b) => `<tr>
  <td><strong>${esc(b.brand_name)}</strong></td>
  <td class="right">${num(b.sent)}</td>
  <td class="right">${b.rates.delivered}%</td>
  <td class="right" ${b.rates.bounce >= 5 ? 'style="color:#b3261e;font-weight:700"' : ''}>${b.rates.bounce}%</td>
  <td class="right" ${b.rates.complaint >= 0.1 ? 'style="color:#b3261e;font-weight:700"' : ''}>${b.rates.complaint}%</td>
  <td><span class="level" style="--level:${LEVEL_COLOURS[b.status.level] ?? 'var(--muted)'};color:var(--level)">${esc(b.status.level.replace(/_/g, ' '))}</span></td>
</tr>`).join('')}
</table></div>` : '<p class="empty">No brands have sent yet.</p>'}
</div>

<h2>Warm-up</h2>
<div class="card">
${warmup.length ? `<div class="scroll"><table>
<tr><th>Brand</th><th>Day</th><th class="right">Today</th><th class="right">Cap</th><th>Used</th></tr>
${warmup.map((w) => {
  const used = w.cap ? Math.min(100, Math.round((w.sent_today / w.cap) * 100)) : 0;
  return `<tr>
  <td><strong>${esc(w.name)}</strong><br><span class="muted" style="font-size:12px">${esc(w.reason)}</span></td>
  <td>${w.complete ? '<span class="pill">warm</span>' : (w.day ?? '—')}</td>
  <td class="right">${num(w.sent_today)}</td>
  <td class="right">${w.cap === null ? '<span class="muted">no limit</span>' : num(w.cap)}</td>
  <td>${w.cap === null ? '' : `<div class="bar"><span style="width:${used}%;${used >= 100 ? 'background:#a06a00' : ''}"></span></div>`}</td>
</tr>`;
}).join('')}
</table></div>` : '<p class="empty">No brands configured yet.</p>'}
</div>

<h2>Queue</h2>
<div class="card">
${queues.length ? `<div class="scroll"><table>
<tr><th>Brand</th><th class="right">Queued</th><th class="right">Sending</th>
    <th class="right">Failed (24h)</th><th class="right">Oldest wait</th></tr>
${queues.map((q) => `<tr>
  <td><strong>${esc(q.name)}</strong></td>
  <td class="right">${num(q.queued)}</td>
  <td class="right">${num(q.sending)}</td>
  <td class="right" ${q.failed_24h > 0 ? 'style="color:#c2410c"' : ''}>${num(q.failed_24h)}</td>
  <td class="right ${q.oldest_minutes > 60 ? '' : 'muted'}">${q.oldest_minutes === null ? '—' : `${num(q.oldest_minutes)} min`}</td>
</tr>`).join('')}
</table></div>
<p class="muted" style="margin:12px 0 0;font-size:12px">
  A long wait with nothing sending usually means the brand is at its daily cap, or the worker is not running.</p>`
  : '<p class="empty">Nothing queued.</p>'}
</div>

<h2>Recent campaigns</h2>
<div class="card">
${campaigns.length ? `<div class="scroll"><table>
<tr><th>Campaign</th><th>Brand</th><th>Status</th><th class="right">Recipients</th>
    <th class="right">Delivered</th><th class="right">Clicked</th></tr>
${campaigns.map((c) => `<tr>
  <td><strong>${esc(c.name)}</strong><br><span class="muted" style="font-size:12px">${esc(c.subject)}</span></td>
  <td>${esc(c.brand_name)}</td>
  <td><span class="pill">${esc(c.status)}</span></td>
  <td class="right">${num(c.recipients)}</td>
  <td class="right">${c.delivered_pct}%</td>
  <td class="right">${c.clicked_pct}%</td>
</tr>`).join('')}
</table></div>
<p class="muted" style="margin:12px 0 0;font-size:12px">
  Click rates are against delivered. Open rates are left out on purpose: Apple Mail
  pre-fetches images, so an open means somebody <em>might</em> have looked.</p>`
  : '<p class="empty">No campaigns yet.</p>'}
</div>

<footer>
  Read-only. Refresh for current numbers, or fetch <code>?format=json</code> for the same data.
</footer>
</main></body></html>`;
}
