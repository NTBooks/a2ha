// guest.js -- the public surface. Two routes, nothing else.
//
//   GET  /r/:token        the pad page
//   POST /r/:token/fire   press a button
//
// Ported from Fanad's server/routes/remote.js. The invariants below came out of
// that implementation and every one of them is deliberate:
//
//   * The GET is strictly side-effect-free. Chat apps prefetch links to build
//     previews; if GET fired anything, pasting a link into a group chat would
//     turn on the lights.
//   * A dead link answers 200 with a plain notice, not 404. A crawler rendering
//     a 404 for a link you just texted your dog-sitter looks alarming, and a
//     404 also tells a prober that a real-shaped token missed.
//   * The page contains no entity ids, no service names, no pad name and no
//     on/off state -- only digits and labels.
//   * The token is re-resolved on every single request. The page is never
//     trusted, so revoking a link kills it on the guest's next tap.

import { resolve } from './shares.js';
import { guestView, getPad, isOn, setOn, isToggle } from './pads.js';
import { runAction, configured } from './ha.js';
import { json, send, readJson, notFound } from './http.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Per-token fire limit. In-memory is fine: a restart clearing it is harmless,
// and a token's blast radius is already bounded to its own pad.
const WINDOW_MS = 60_000;
const MAX_FIRES = 30;
const hits = new Map();

function throttled(token) {
  const now = Date.now();
  const list = (hits.get(token) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_FIRES) { hits.set(token, list); return true; }
  list.push(now);
  hits.set(token, list);
  return false;
}

// Keep the map from growing forever on a long-lived agent.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) {
    const keep = v.filter((t) => now - t < WINDOW_MS);
    if (keep.length) hits.set(k, keep); else hits.delete(k);
  }
}, WINDOW_MS);
sweep.unref?.();

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

const STYLE = `
  :root {
    --bg:#f6f7f8; --card:#fff; --ink:#16181d; --muted:#5b6472;
    --line:#e3e6ea; --accent:#0f766e; --bad:#b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#101215; --card:#181b20; --ink:#eef1f5; --muted:#9aa4b2;
      --line:#272c33; --accent:#1d8a86; --bad:#ff8b80;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-text-size-adjust:100%;
  }
  main { max-width:26rem; margin:0 auto; padding:1.5rem 1rem 4rem; }
  header { text-align:center; margin-bottom:1.5rem; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:.9rem; margin:0; }
  .pad { display:flex; flex-direction:column; gap:.75rem; }
  .key {
    position:relative; overflow:hidden; isolation:isolate;
    display:flex; align-items:center; gap:.85rem; width:100%;
    padding:1.15rem 1.1rem; border:1px solid var(--line); border-radius:14px;
    background:var(--card); color:inherit; font:inherit; text-align:left;
    cursor:pointer; -webkit-tap-highlight-color:transparent;
    transition:transform .06s ease, border-color .15s ease;
  }
  .key:active { transform:scale(.985); }
  .key:disabled { opacity:.5; cursor:not-allowed; }
  .key:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .num {
    flex:0 0 2.1rem; height:2.1rem; display:grid; place-items:center;
    border-radius:9px; background:var(--bg); border:1px solid var(--line);
    font-weight:650; font-variant-numeric:tabular-nums; color:var(--muted);
  }
  .lbl { font-weight:550; }
  .fill {
    position:absolute; inset:0; z-index:-1; transform-origin:left center;
    transform:scaleX(0); background:var(--accent); opacity:.16;
  }
  .key.pressed .fill { animation:keyfill 1.8s ease-out forwards; }
  .key.pressed { border-color:var(--accent); }
  @keyframes keyfill { from { transform:scaleX(0); } to { transform:scaleX(1); } }
  @media (prefers-reduced-motion: reduce) {
    .key.pressed .fill { animation:none; transform:scaleX(1); }
  }
  .empty, .notice { color:var(--muted); text-align:center; padding:2rem 1rem; }
  .notice h1 { color:var(--ink); }
  footer { margin-top:2.5rem; text-align:center; color:var(--muted); font-size:.78rem; }
  #say {
    position:fixed; left:50%; bottom:1.25rem; transform:translate(-50%,1.5rem);
    max-width:calc(100vw - 2rem); padding:.7rem 1rem; border-radius:11px;
    background:var(--card); border:1px solid var(--line); color:var(--ink);
    box-shadow:0 8px 28px rgb(0 0 0 / .16); font-size:.9rem;
    opacity:0; pointer-events:none; transition:opacity .18s ease, transform .18s ease;
  }
  #say.show { opacity:1; transform:translate(-50%,0); }
  #say.bad { border-color:var(--bad); color:var(--bad); }
`;

const shell = (title, inner, extraHead = '') => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0f766e">
<title>${esc(title)}</title>
<style>${STYLE}</style>${extraHead}
</head><body><main>${inner}</main>
<div id="say" role="status" aria-live="polite"></div>
</body></html>`;

const noticePage = (title, body) => shell(title, `
  <div class="notice">
    <h1>${esc(title)}</h1>
    <p>${esc(body)}</p>
  </div>`);

// The gateway strips the route prefix before the request reaches us, so this
// script cannot hardcode "/r/...". From the browser an absolute path would
// resolve to the origin root and miss "/pad". Deriving the fire URL from
// location.pathname keeps it correct under any prefix, including a custom
// domain mounted at "/".
const CLIENT_JS = `
  (function () {
    var fireUrl = location.pathname.replace(/\\/+$/, '') + '/fire';
    var say = document.getElementById('say'), t;
    function toast(msg, bad) {
      say.textContent = msg;
      say.className = 'show' + (bad ? ' bad' : '');
      clearTimeout(t);
      t = setTimeout(function () { say.className = ''; }, 4200);
    }
    document.querySelectorAll('.key').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // The wash animation IS the cooldown: it runs for the same ~2s that
        // the button refuses a second tap, so a double-tap can't fire twice.
        if (btn.disabled || btn.classList.contains('pressed')) return;
        btn.classList.add('pressed');
        setTimeout(function () { btn.classList.remove('pressed'); }, 2000);
        fetch(fireUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ slot: Number(btn.getAttribute('data-slot')) })
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok || !d.ok) toast(d.error || "That didn't go through - try again.", true);
            else toast(d.speech && d.speech !== 'Done.' ? d.speech : 'Done.');
          });
        }).catch(function () {
          toast("Couldn't reach the house - check your connection.", true);
        });
      });
    });
  })();
`;

export function page(req, res, token) {
  noStore(res);

  const share = resolve(token);
  if (!share) {
    // 200, not 404 -- see the header comment.
    return send(res, 200, 'text/html; charset=utf-8', noticePage(
      "This remote link isn't active",
      'The link you followed has expired or was switched off. Ask whoever shared it for a new one.',
    ));
  }

  const view = guestView(share.pad);
  if (!view) {
    return send(res, 200, 'text/html; charset=utf-8', noticePage(
      "This remote link isn't active",
      'The buttons it pointed at are gone. Ask whoever shared it for a new one.',
    ));
  }

  const live = configured();
  const slots = view.slots;

  // We know the pad's rendered height here, so we can emit a media query that
  // only goes two-up when one column genuinely won't fit the viewport.
  const padHeight = 200 + slots.length * 94;
  const twoUp = slots.length >= 2
    ? `<style>@media (min-width:40rem) and (max-height:${padHeight}px){` +
      'main{max-width:46rem}' +
      '.pad{display:grid;grid-template-columns:1fr 1fr;align-content:start}' +
      '}</style>'
    : '';

  const body = !slots.length
    ? '<p class="empty">There are no buttons on this remote yet. Ask whoever shared it to set some up.</p>'
    : `<div class="pad">${slots.map((s) => `
        <button class="key" data-slot="${s.slot}"${live ? '' : ' disabled'}>
          <span class="fill"></span><span class="num">${s.slot}</span><span class="lbl">${esc(s.name)}</span>
        </button>`).join('')}</div>`;

  const inner = `
  <header>
    <h1>${esc(view.title)}</h1>
    <p class="sub">${live
      ? 'Tap a button to run it in the house. No account needed.'
      : "The house isn't reachable right now."}</p>
  </header>
  ${body}
  <footer>This link only reaches these buttons.</footer>
  <script>${CLIENT_JS}</script>`;

  return send(res, 200, 'text/html; charset=utf-8', shell(view.title, inner, twoUp));
}

export async function fire(req, res, token) {
  noStore(res);

  const share = resolve(token);
  if (!share) return json(res, 403, { error: 'This link is no longer active.' });
  if (throttled(token)) return json(res, 429, { error: 'Too fast - give it a moment and try again.' });

  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: 'Pick a button.' }); }

  const slotNo = Number(body?.slot);
  if (!Number.isInteger(slotNo) || slotNo < 0 || slotNo > 9) {
    return json(res, 400, { error: 'Pick a button.' });
  }

  const pad = getPad(share.pad);
  const slot = (pad?.slots || []).find((s) => s.slot === slotNo);
  if (!slot) return json(res, 400, { error: 'That button is not set up.' });

  // A plain button is always an "on" press. A toggle alternates, driven by what
  // we last sent -- never by reading HA back.
  const toggle = isToggle(slot);
  const turningOn = toggle ? !isOn(share.pad, slotNo) : true;

  const r = await runAction(turningOn ? slot.on : slot.off);
  if (!r.ok) return json(res, 502, { error: r.text || "The house didn't answer." });
  if (toggle) await setOn(share.pad, slotNo, turningOn);

  return json(res, 200, { ok: true, speech: r.speech, slot: slotNo });
}

export function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const m = /^\/r\/([^/]+?)(\/fire)?\/?$/.exec(url.pathname);
  if (!m) return notFound(res);

  const token = decodeURIComponent(m[1]);
  if (m[2]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    return fire(req, res, token);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Use GET.' });
  return page(req, res, token);
}
