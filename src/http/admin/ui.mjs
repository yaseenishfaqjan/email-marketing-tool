/**
 * The admin UI's chrome: one layout, one stylesheet, a handful of helpers.
 *
 * Server-rendered HTML with no build step and no framework, matching the rest
 * of the codebase. The whole panel is a few hundred lines of markup; a React
 * app would be more code to achieve the same thing, plus a toolchain to keep
 * alive on a server that already runs fifteen applications.
 *
 * Everything user-supplied goes through `esc`. A contact's first name is
 * attacker-controlled — somebody can type one into a public signup form — and
 * it is rendered on a page that can send mail to the entire list.
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const num = (n) => (Number(n) || 0).toLocaleString('en-US');

export function pct(part, whole) {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

const STYLE = `
:root{--ink:#1a1714;--muted:#6b655e;--line:#e6e2dc;--bg:#f7f5f1;--card:#fff;
      --accent:#9a7b4f;--good:#1a7f5a;--warn:#a06a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){
  :root{--ink:#f2efea;--muted:#a49c92;--line:#332f2a;--bg:#16130f;--card:#1f1b17;
        --accent:#c9a46d}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);line-height:1.5;
     font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
a{color:var(--accent)}
header.top{background:var(--card);border-bottom:1px solid var(--line);
           padding:0 20px;position:sticky;top:0;z-index:5}
header.top .inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;
                  gap:18px;flex-wrap:wrap;min-height:56px}
.brandmark{font-weight:700;letter-spacing:-.01em;margin-right:4px}
nav a{display:inline-block;padding:16px 2px;font-size:14px;text-decoration:none;
      color:var(--muted);border-bottom:2px solid transparent}
nav a:hover{color:var(--ink)}
nav a.on{color:var(--ink);border-bottom-color:var(--accent)}
nav{display:flex;gap:16px;flex-wrap:wrap}
.spacer{flex:1}
main{max-width:1100px;margin:0 auto;padding:28px 20px 72px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 24px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
   margin:30px 0 12px;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
      padding:20px;margin-bottom:16px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:520px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
   color:var(--muted);font-weight:600;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child,th:first-child{padding-left:0}
tr:last-child td{border-bottom:0}
.right{text-align:right}
.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:14px;padding:14px 0}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;
      color:var(--muted);margin:16px 0 6px;font-weight:600}
input[type=text],input[type=email],input[type=password],input[type=number],
input[type=datetime-local],select,textarea{
  width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);color:var(--ink);font-size:14px;font-family:inherit}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5}
button,.btn{display:inline-block;border:1px solid var(--line);background:var(--card);
            color:var(--ink);padding:9px 16px;border-radius:8px;font-size:14px;
            font-family:inherit;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{border-color:var(--muted)}
button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
button.danger{color:var(--bad);border-color:var(--bad)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;align-items:center}
.pill{display:inline-block;font-size:11px;padding:2px 9px;border-radius:99px;
      border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pill.good{color:var(--good);border-color:var(--good)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.bad{color:var(--bad);border-color:var(--bad)}
.flash{border-left:4px solid var(--good);background:var(--card);padding:12px 16px;
       border-radius:0 8px 8px 0;margin-bottom:18px;font-size:14px}
.flash.bad{border-left-color:var(--bad)}
.hint{font-size:13px;color:var(--muted);margin-top:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}
.stat .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.stat .big{font-size:26px;font-weight:700;letter-spacing:-.02em}
.row{display:flex;gap:28px;flex-wrap:wrap}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px;
    overflow-x:auto;font-size:12.5px;margin:0}
iframe.preview{width:100%;height:620px;border:1px solid var(--line);border-radius:8px;background:#fff}
.searchbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.searchbar input{flex:1;min-width:220px}
.pager{display:flex;gap:10px;margin-top:18px;align-items:center;font-size:14px}
`;

const TABS = [
  ['', 'Overview'],
  ['campaigns', 'Campaigns'],
  ['contacts', 'Contacts'],
  ['automations', 'Automations'],
  ['forms', 'Forms'],
  ['suppressions', 'Suppressed'],
];

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.body        already-escaped HTML
 * @param {object} [o.brand]     the brand in scope, if any
 * @param {string} [o.tab]       which nav item to mark current
 * @param {Array}  [o.brands]    for the brand switcher
 * @param {object} [o.flash]     {text, bad}
 */
export function layout({ title, body, brand, tab = '', brands = [], flash = null }) {
  const base = brand ? `/admin/b/${brand.id}` : '/admin';

  const nav = brand
    ? TABS.map(([slug, label]) =>
        `<a href="${base}${slug ? '/' + slug : ''}"${tab === slug ? ' class="on"' : ''}>${label}</a>`).join('')
    : '';

  const switcher = brands.length > 1 && brand
    ? `<select onchange="location.href='/admin/b/'+this.value">
         ${brands.map((b) => `<option value="${esc(b.id)}"${b.id === brand.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
       </select>`
    : brand ? `<span class="pill">${esc(brand.name)}</span>` : '';

  const flashHtml = flash
    ? `<div class="flash${flash.bad ? ' bad' : ''}">${esc(flash.text)}</div>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Scalaro Mailer</title>
<meta name="robots" content="noindex,nofollow">
<style>${STYLE}</style></head><body>
<header class="top"><div class="inner">
  <span class="brandmark"><a href="/admin" style="text-decoration:none;color:inherit">Scalaro Mailer</a></span>
  <nav>${nav}</nav>
  <span class="spacer"></span>
  ${switcher}
  <a class="muted" href="/admin/logout" style="font-size:13px">Sign out</a>
</div></header>
<main>${flashHtml}${body}</main>
</body></html>`;
}

/** A form field. `value` is escaped here so callers cannot forget. */
export function field(name, label, value = '', { type = 'text', hint = '', placeholder = '' } = {}) {
  return `<label for="${name}">${esc(label)}</label>
<input id="${name}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}">
${hint ? `<p class="hint">${esc(hint)}</p>` : ''}`;
}

export function textarea(name, label, value = '', { rows = 18, hint = '' } = {}) {
  return `<label for="${name}">${esc(label)}</label>
<textarea id="${name}" name="${name}" rows="${rows}">${esc(value)}</textarea>
${hint ? `<p class="hint">${esc(hint)}</p>` : ''}`;
}

export function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}

const STATUS_CLASS = {
  subscribed: 'good', sent: 'good', delivered: 'good', active: 'good', sending: '',
  pending: 'warn', queued: 'warn', paused: 'warn', draft: '', scheduled: 'warn',
  unsubscribed: '', bounced: 'bad', complained: 'bad', failed: 'bad',
};

export function statusPill(status) {
  const cls = STATUS_CLASS[status] ?? '';
  return `<span class="pill${cls ? ' ' + cls : ''}">${esc(status)}</span>`;
}

/** An empty table should say why it is empty, not just sit there blank. */
export function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${esc(emptyText)}</p>`;
  return `<div class="scroll"><table>
<thead><tr>${headers.map((h) => `<th${h.right ? ' class="right"' : ''}>${esc(h.label ?? h)}</th>`).join('')}</tr></thead>
<tbody>${rows.join('')}</tbody></table></div>`;
}

export function loginPage({ error = '', next = '/admin' } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Scalaro Mailer</title><meta name="robots" content="noindex,nofollow">
<style>${STYLE}
body{display:grid;place-items:center;min-height:100vh}
.box{width:100%;max-width:380px;padding:0 20px}
</style></head><body><div class="box">
<h1>Scalaro Mailer</h1>
<p class="sub">Paste the admin token to sign in.</p>
${error ? `<div class="flash bad">${esc(error)}</div>` : ''}
<form method="post" action="/admin/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="token">Admin token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
  <div class="actions"><button class="primary" type="submit">Sign in</button></div>
</form>
<p class="hint">It is the <code>ADMIN_TOKEN</code> from the server's <code>.env</code>.</p>
</div></body></html>`;
}
