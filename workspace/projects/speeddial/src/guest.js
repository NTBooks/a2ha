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
import { guestView, getPad, isOn, setOn, isToggle, slotEntity, liveIsOn } from './pads.js';
import { runAction, configured, statesOf } from './ha.js';
import { json, send, readJson, notFound } from './http.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Per-token fire limit. In-memory is fine: a restart clearing it is harmless,
// and a token's blast radius is already bounded to its own pad.
const WINDOW_MS = 60_000;
const MAX_FIRES = 30;
// Reads are cheap and happen on every page load plus twice per press, so they
// get their own budget rather than eating the one that guards the house.
const MAX_READS = 120;
const hits = new Map();

function throttled(token, limit = MAX_FIRES) {
  const now = Date.now();
  const list = (hits.get(token) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= limit) { hits.set(token, list); return true; }
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

// Reading state is a separate, explicit request -- never part of the page. The
// HTML a link preview or crawler fetches therefore still carries nothing but
// digits and labels; state exists only for someone who ran the script.
//
// Cached briefly so several guests opening the same link at once produce one
// round trip to the house rather than one each.
const STATE_TTL_MS = 3000;
const stateCache = new Map();

async function padStates(padName) {
  const hit = stateCache.get(padName);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.value;

  const pad = getPad(padName);
  const slots = (pad?.slots ?? []).filter((s) => s.on);
  const byEntity = await statesOf(slots.map(slotEntity));

  const value = {};
  for (const slot of slots) {
    const entity = slotEntity(slot);
    // null means 'no opinion' -- an assist button, an unavailable entity, or a
    // state we decline to interpret. The page then shows nothing rather than
    // guessing, which is the whole reason this is worth doing.
    value[slot.slot] = entity ? liveIsOn(byEntity[entity]) : null;
  }
  stateCache.set(padName, { at: Date.now(), value });
  return value;
}

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
  .lbl { font-weight:550; flex:1; }
  .dot {
    flex:0 0 auto; width:.6rem; height:.6rem; border-radius:50%;
    background:var(--line); transition:background .25s ease, box-shadow .25s ease;
  }
  .dot.on { background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .dot.off { background:var(--line); }
  .dot.unknown { background:transparent; }
  .key.loading .dot {
    background:transparent; border:2px solid var(--line); border-top-color:var(--muted);
    width:.85rem; height:.85rem; animation:spin .7s linear infinite;
  }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .key.loading .dot { animation:none; } }
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
    var base = location.pathname.replace(/\\/+$/, '');
    var fireUrl = base + '/fire';
    var stateUrl = base + '/state';
    var say = document.getElementById('say'), t;
    function toast(msg, bad) {
      say.textContent = msg;
      say.className = 'show' + (bad ? ' bad' : '');
      clearTimeout(t);
      t = setTimeout(function () { say.className = ''; }, 4200);
    }
    // The page renders instantly with no state, then fills it in. A slow or
    // unreachable house delays the dots, never the buttons.
    function paint(states) {
      document.querySelectorAll('.key').forEach(function (btn) {
        var v = states ? states[btn.getAttribute('data-slot')] : undefined;
        btn.classList.remove('loading');
        var dot = btn.querySelector('.dot');
        dot.className = 'dot ' + (v === true ? 'on' : v === false ? 'off' : 'unknown');
      });
    }
    function refresh() {
      return fetch(stateUrl, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { paint(d && d.states); })
        .catch(function () { paint(null); });
    }
    refresh();
    
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
            // Devices take a beat to report back, so read twice rather than
            // showing a dot that is confidently one press behind.
            setTimeout(refresh, 900);
            setTimeout(refresh, 2600);
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
        <button class="key${live ? ' loading' : ''}" data-slot="${s.slot}"${live ? '' : ' disabled'}>
          <span class="fill"></span><span class="num">${s.slot}</span><span class="lbl">${esc(s.name)}</span><span class="dot"></span>
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

export async function readState(req, res, token) {
  noStore(res);
  const share = resolve(token);
  if (!share) return json(res, 403, { error: 'This link is no longer active.' });
  if (throttled(token, MAX_READS)) return json(res, 429, { error: 'Too fast.' });
  if (!configured()) return json(res, 200, { states: {} });
  try {
    return json(res, 200, { states: await padStates(share.pad) });
  } catch {
    // A pad whose state cannot be read is still a working pad.
    return json(res, 200, { states: {} });
  }
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
  // A plain button is always an 'on' press. For a toggle, ask the house what is
  // actually true before choosing a half -- what we last sent goes stale the
  // moment somebody uses a wall switch, and Fanad could only ever guess here.
  const toggle = isToggle(slot);
  let turningOn = true;
  if (toggle) {
    let live = null;
    try {
      if (slotEntity(slot)) live = (await padStates(share.pad))[slotNo];
    } catch { live = null; }
    turningOn = live === null ? !isOn(share.pad, slotNo) : !live;
  }

  const r = await runAction(turningOn ? slot.on : slot.off);
  if (!r.ok) return json(res, 502, { error: r.text || "The house didn't answer." });
  if (toggle) await setOn(share.pad, slotNo, turningOn);
  stateCache.delete(share.pad);

  return json(res, 200, { ok: true, speech: r.speech, slot: slotNo });
}

// A public helper page, mounted on its own route. The config app sits behind
// Pinata's gateway token, and the only way in is a URL carrying that token --
// which means hand-assembling one from two things copied out of two different
// tabs. This page does the assembling, explains why it is needed, and says the
// part nobody tells you: you do it once, because the gateway sets a cookie.
//
// It handles no secrets itself. The token is pasted in the browser and used to
// build a link there; nothing is sent here.
export function setupPage(req, res) {
  noStore(res);
  const inner = `
  <header>
    <h1>Open the pad editor</h1>
    <p class="sub">One-time setup. About thirty seconds.</p>
  </header>

  <div class="step">
    <h2>1. Copy your gateway token</h2>
    <p>In the Pinata dashboard, open this agent, go to the <b>Secrets</b> tab and
       scroll to the bottom. There is a <b>Gateway Token</b> there. Copy it.</p>
  </div>

  <div class="step">
    <h2>2. Paste it here</h2>
    <input id="tok" type="password" placeholder="Paste the gateway token" autocomplete="off" spellcheck="false">
    <button id="go" class="primary">Open the editor</button>
    <p class="muted" id="err"></p>
  </div>

  <div class="step">
    <h2>3. You should not need to do this again</h2>
    <p>Following that link makes your browser remember the token as a cookie, so
       from then on the plain editor address works on its own. Bookmark it once
       it opens.</p>
    <p class="muted">If it ever stops working, the token was rotated — come back
       here and paste the new one.</p>
  </div>

  <div class="warn">
    <b>Treat that token like a password.</b> It is not a pad-editor login — it
    grants full access to this agent's container. Do not paste it into chat, and
    do not share the address bar of the page it opens.
  </div>

  <script>
  (function () {
    var tok = document.getElementById('tok');
    var err = document.getElementById('err');
    function go() {
      var v = tok.value.trim();
      if (!v) { err.textContent = 'Paste the token first.'; return; }
      // /admin is a top-level route on this agent, so build from the origin.
      // Deriving it from this page's path would produce /pad/admin if /setup
      // ever ended up mounted under another prefix.
      location.href = location.origin + '/admin?token=' + encodeURIComponent(v);
    }
    document.getElementById('go').addEventListener('click', go);
    tok.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  })();
  </script>`;

  const extra = `<style>
    .step { background:var(--card); border:1px solid var(--line); border-radius:12px;
            padding:1rem 1.1rem; margin-bottom:.9rem; text-align:left; }
    .step h2 { font-size:1rem; margin:0 0 .4rem; }
    .step p { margin:.3rem 0; font-size:.92rem; }
    .muted { color:var(--muted); font-size:.85rem; }
    input { width:100%; padding:.65rem .7rem; border-radius:9px; border:1px solid var(--line);
            background:var(--bg); color:var(--ink); font:inherit; margin:.4rem 0; }
    button.primary { background:var(--accent); color:#fff; border:1px solid var(--accent);
                     border-radius:9px; padding:.6rem 1rem; font:inherit; font-weight:600; cursor:pointer; }
    .warn { border:1px solid var(--bad); color:var(--bad); border-radius:12px;
            padding:.85rem 1rem; font-size:.88rem; text-align:left; }
  </style>`;

  return send(res, 200, 'text/html; charset=utf-8', shell('Open the pad editor', inner, extra));
}

export function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Match /r/<token> whether or not the gateway kept its route prefix. The
  // docs say the prefix is stripped; a real deployment showed it is not, and
  // the manifest's own note about setting Vite's base hints the same. Tolerate
  // both rather than betting on either.
  // The /setup route lands here too, since it points at this same server.
  if (/(?:^|\/)setup\/?$/.test(url.pathname)) return setupPage(req, res);

  const m = /(?:^|\/)r\/([^/]+?)(\/fire|\/state)?\/?$/.exec(url.pathname);
  if (!m) return notFound(res);

  const token = decodeURIComponent(m[1]);
  if (m[2] && m[2].endsWith('state')) {
    if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' });
    return readState(req, res, token);
  }
  if (m[2]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    return fire(req, res, token);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Use GET.' });
  return page(req, res, token);
}
