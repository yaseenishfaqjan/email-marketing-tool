/**
 * The embeddable signup widget.
 *
 * One <script> tag per site, no dependencies, no build step:
 *
 *   <script src="https://links.scalaro.io/f/<form-id>.js" async></script>
 *   <div data-emk-form="<form-id>"></div>
 *
 * Without the div it renders where the script tag sits, so pasting one line
 * into a page works.
 *
 * Constraints this is written under, because it runs on somebody else's page:
 *
 *  - Everything is scoped. The container gets a unique class and every rule is
 *    written under it, so the host site's CSS reset cannot flatten the form
 *    and the form cannot restyle the host site.
 *  - No globals beyond one namespaced object, and it tolerates being loaded
 *    twice — CMSs duplicate script tags.
 *  - Values are set with textContent and element properties, never innerHTML
 *    with data in it. The brand's own copy is escaped server-side before it
 *    reaches this file.
 *  - It degrades to a plain message rather than a broken layout if the fetch
 *    fails.
 */

/**
 * JSON, with every '<' written as \u003c.
 *
 * The file is served as application/javascript, where a literal `</script>`
 * inside a string is harmless — but somebody will eventually paste this inline
 * into a page, and there it would close the script block early and hand the
 * rest of the brand's copy to the HTML parser. JavaScript reads \u003c back as
 * '<', so nothing about the rendered form changes.
 */
const escapeJs = (value) =>
  JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');

/**
 * @param {object} form    the public view of the form
 * @param {string} baseUrl where to post
 * @returns {string} JavaScript, served as application/javascript
 */
export function buildEmbedScript(form, baseUrl) {
  const config = {
    id: form.id,
    endpoint: `${baseUrl}/f/${form.id}`,
    headline: form.headline ?? '',
    description: form.description ?? '',
    button: form.button_label ?? 'Subscribe',
    success: form.success_message ?? 'Thank you — please check your inbox to confirm.',
    fields: (form.fields ?? []).map((f) => (typeof f === 'string' ? { name: f } : f)),
    redirect: form.redirect_url ?? null,
    theme: form.theme ?? {},
  };

  // A form named "foo */ alert(1) /*" must not break out of the comment.
  const safeName = String(form.name).split('*/').join('* /');
  return `/* ${safeName} — signup form */
(function () {
  "use strict";
  var CONFIG = ${escapeJs(JSON.stringify(config))};
  var cfg = JSON.parse(CONFIG);
  var NS = "emk-" + cfg.id.slice(0, 8);

  // CMSs duplicate script tags. Rendering twice would give the page two
  // identical forms and two sets of event handlers.
  window.__emkForms = window.__emkForms || {};
  if (window.__emkForms[cfg.id]) return;
  window.__emkForms[cfg.id] = true;

  var t = cfg.theme || {};
  var accent = t.accent || "#141210";
  var radius = t.radius || "6px";
  var font = t.font || "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

  function styles() {
    if (document.getElementById(NS + "-style")) return;
    var css = [
      "." + NS + "{font-family:" + font + ";max-width:420px;box-sizing:border-box}",
      "." + NS + " *{box-sizing:border-box}",
      "." + NS + " h3{margin:0 0 6px;font-size:18px;line-height:1.3;color:inherit}",
      "." + NS + " p." + NS + "-desc{margin:0 0 14px;font-size:14px;line-height:1.5;opacity:.75}",
      "." + NS + " label{display:block;font-size:13px;margin:0 0 4px;opacity:.8}",
      "." + NS + " input{width:100%;padding:10px 12px;font-size:15px;font-family:inherit;",
      "border:1px solid rgba(0,0,0,.2);border-radius:" + radius + ";margin:0 0 10px;background:#fff;color:#111}",
      "." + NS + " input:focus{outline:2px solid " + accent + ";outline-offset:1px}",
      "." + NS + " button{width:100%;padding:11px 18px;font-size:15px;font-family:inherit;cursor:pointer;",
      "border:0;border-radius:" + radius + ";background:" + accent + ";color:#fff}",
      "." + NS + " button[disabled]{opacity:.6;cursor:default}",
      "." + NS + " ." + NS + "-msg{font-size:14px;line-height:1.5;margin:10px 0 0}",
      "." + NS + " ." + NS + "-err{color:#b3261e}",
      // The honeypot must be unreachable by people and invisible to screen
      // readers, but present in the DOM for bots to fill in.
      "." + NS + " ." + NS + "-hp{position:absolute!important;left:-9999px!important;",
      "width:1px!important;height:1px!important;overflow:hidden!important}"
    ].join("");
    var el = document.createElement("style");
    el.id = NS + "-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function field(name, label, type) {
    var wrap = document.createDocumentFragment();
    var l = document.createElement("label");
    l.textContent = label;
    l.setAttribute("for", NS + "-" + name);
    var i = document.createElement("input");
    i.type = type || "text";
    i.name = name;
    i.id = NS + "-" + name;
    if (name === "email") { i.required = true; i.autocomplete = "email"; }
    wrap.appendChild(l);
    wrap.appendChild(i);
    return wrap;
  }

  var LABELS = { email: "Email address", first_name: "First name", last_name: "Last name" };

  function render(target) {
    styles();
    var root = document.createElement("div");
    root.className = NS;

    if (cfg.headline) {
      var h = document.createElement("h3");
      h.textContent = cfg.headline;
      root.appendChild(h);
    }
    if (cfg.description) {
      var d = document.createElement("p");
      d.className = NS + "-desc";
      d.textContent = cfg.description;
      root.appendChild(d);
    }

    var form = document.createElement("form");
    form.noValidate = false;

    var names = cfg.fields.length ? cfg.fields.map(function (f) { return f.name; }) : ["email"];
    if (names.indexOf("email") === -1) names.unshift("email");
    names.forEach(function (n) {
      form.appendChild(field(n, LABELS[n] || n, n === "email" ? "email" : "text"));
    });

    // Honeypot. A person never sees it; a bot fills every field it finds.
    var hp = document.createElement("div");
    hp.className = NS + "-hp";
    hp.setAttribute("aria-hidden", "true");
    var hpi = document.createElement("input");
    hpi.type = "text";
    hpi.name = "website";
    hpi.tabIndex = -1;
    hpi.autocomplete = "off";
    hp.appendChild(hpi);
    form.appendChild(hp);

    var button = document.createElement("button");
    button.type = "submit";
    button.textContent = cfg.button;
    form.appendChild(button);

    var msg = document.createElement("p");
    msg.className = NS + "-msg";
    msg.setAttribute("role", "status");
    msg.setAttribute("aria-live", "polite");
    form.appendChild(msg);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = NS + "-msg";
      msg.textContent = "";
      button.disabled = true;

      var body = { website: hpi.value };
      names.forEach(function (n) {
        var input = form.querySelector("#" + NS + "-" + n);
        if (input) body[n] = input.value.trim();
      });

      fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          return { ok: r.ok, body: j };
        });
      }).then(function (res) {
        if (!res.ok) {
          button.disabled = false;
          msg.className = NS + "-msg " + NS + "-err";
          msg.textContent = res.body.error || "Something went wrong. Please try again.";
          return;
        }
        if (cfg.redirect) { window.location.href = cfg.redirect; return; }
        form.replaceChildren(msg);
        msg.textContent = cfg.success;
      }).catch(function () {
        button.disabled = false;
        msg.className = NS + "-msg " + NS + "-err";
        msg.textContent = "Could not reach the server. Please try again.";
      });
    });

    root.appendChild(form);
    target.appendChild(root);
  }

  function mount() {
    var targets = document.querySelectorAll('[data-emk-form="' + cfg.id + '"]');
    if (targets.length) {
      Array.prototype.forEach.call(targets, render);
      return;
    }
    // No container: render where the script tag sits, so one pasted line works.
    var script = document.currentScript || document.querySelector('script[src*="/f/' + cfg.id + '"]');
    if (script && script.parentNode) {
      var slot = document.createElement("div");
      script.parentNode.insertBefore(slot, script.nextSibling);
      render(slot);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
`;
}

/** The page shown after somebody clicks the confirmation link. */
export function confirmationPage({ heading, body, brandName = '' }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title>
<meta name="robots" content="noindex">
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#f7f5f1;
       color:#141210;margin:0;padding:48px 16px;display:flex;justify-content:center}
  main{background:#fff;border:1px solid #e2dcd2;border-radius:10px;padding:36px;max-width:480px;width:100%}
  h1{font-size:22px;font-weight:600;margin:0 0 12px}
  p{color:#4a443d;line-height:1.6;margin:0 0 8px}
  .brand{font-size:13px;color:#8a8177;margin-top:20px}
</style></head>
<body><main><h1>${esc(heading)}</h1><p>${esc(body)}</p>
${brandName ? `<p class="brand">${esc(brandName)}</p>` : ''}</main></body></html>`;
}
