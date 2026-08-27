// ui.js -- the owner's config app, as one string.
//
// No framework and no build step, for the same reason the guest page has none:
// this has to still boot in a container two years from now without npm
// resolving anything. It is served only on the gateway-protected route.

export const UI = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>A2HA - pads</title>
<style>
  :root {
    --bg:#f6f7f8; --card:#fff; --ink:#16181d; --muted:#5b6472;
    --line:#e3e6ea; --accent:#0f766e; --bad:#b42318; --good:#0a7d38;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#101215; --card:#181b20; --ink:#eef1f5; --muted:#9aa4b2;
      --line:#272c33; --accent:#1d8a86; --bad:#ff8b80; --good:#4ad07f;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  main { max-width:56rem; margin:0 auto; padding:1.5rem 1rem 5rem; }
  h1 { font-size:1.4rem; margin:0 0 .2rem; }
  h2 { font-size:1.05rem; margin:0; }
  .sub { color:var(--muted); font-size:.88rem; margin:0 0 1.5rem; }
  .card {
    background:var(--card); border:1px solid var(--line);
    border-radius:12px; padding:1rem; margin-bottom:1rem;
  }
  .row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
  /* [hidden] loses to display:flex above, so hiding needs its own class. */
  .row.gone { display:none; }
  .row + .row { margin-top:.6rem; }
  .spread { justify-content:space-between; }
  input, select, button, textarea {
    font:inherit; color:inherit; border-radius:9px;
    border:1px solid var(--line); background:var(--bg); padding:.5rem .65rem;
  }
  input, select, textarea { min-width:0; }
  input:focus-visible, select:focus-visible, button:focus-visible, textarea:focus-visible {
    outline:2px solid var(--accent); outline-offset:1px;
  }
  button { cursor:pointer; background:var(--card); }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
  button.danger { color:var(--bad); }
  .grow { flex:1 1 12rem; }
  .pill {
    font-size:.75rem; padding:.14rem .5rem; border-radius:999px;
    border:1px solid var(--line); color:var(--muted);
  }
  .pill.on { color:var(--good); border-color:currentColor; }
  .pill.off { color:var(--bad); border-color:currentColor; }
  .slot { border-top:1px solid var(--line); padding:.8rem 0; }
  .slot:first-of-type { border-top:0; }
  .slotno {
    flex:0 0 1.9rem; height:1.9rem; display:grid; place-items:center;
    border-radius:8px; border:1px solid var(--line); background:var(--bg);
    font-weight:650; font-variant-numeric:tabular-nums; color:var(--muted);
  }
  .slot.set .slotno { color:var(--accent); border-color:var(--accent); }
  .muted { color:var(--muted); font-size:.85rem; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.82rem; }
  code.url {
    display:block; word-break:break-all; padding:.5rem .65rem;
    background:var(--bg); border:1px solid var(--line); border-radius:8px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem;
  }
  details.adv summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
  details.adv[open] summary { margin-bottom:.6rem; }
  #toast {
    position:fixed; left:50%; bottom:1.25rem; transform:translate(-50%,1.5rem);
    padding:.7rem 1rem; border-radius:10px; background:var(--card);
    border:1px solid var(--line); box-shadow:0 8px 28px rgb(0 0 0 / .18);
    opacity:0; pointer-events:none; transition:opacity .18s, transform .18s;
    max-width:calc(100vw - 2rem); font-size:.9rem;
  }
  #toast.show { opacity:1; transform:translate(-50%,0); }
  #toast.bad { border-color:var(--bad); color:var(--bad); }
</style>
</head><body>
<main>
  <h1>Pads</h1>
  <p class="sub" id="status">Loading...</p>
  <div id="app"></div>

  <div class="card">
    <div class="row">
      <input id="newpad" class="grow" placeholder="New pad name, e.g. guest or dog-sitter" maxlength="40">
      <button class="primary" id="addpad">Create pad</button>
    </div>
    <p class="muted" style="margin:.6rem 0 0">
      A pad is a set of numbered buttons. Share a link to a pad and whoever opens it
      can press those buttons and nothing else. Click a pad's name to rename it —
      that name is the heading your guests see.
    </p>
  </div>
</main>
<div id="toast"></div>
<script>
(function () {
  // Build the API base from where this page actually is, rather than hardcoding
  // "/api" -- the route prefix may or may not survive the gateway.
  //
  // The gateway wants its token on every request, not just the one that loaded
  // this page. It may set a cookie when you arrive with ?token=, but it may not,
  // so carry it forward explicitly rather than finding out the hard way.
  var GW = new URLSearchParams(location.search).get("token") || "";
  var API = location.pathname.replace(/\\/+$/, '') + '/api';
  function apiUrl(path) {
    var u = API + path;
    if (!GW) return u;
    return u + (u.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(GW);
  }
  var app = document.getElementById('app');
  var statusEl = document.getElementById('status');
  var entities = [];
  var open = {};   // pad name -> expanded?

  function toast(msg, bad) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.className = ''; }, 4000);
  }

  function api(path, opts) {
    return fetch(apiUrl(path), Object.assign({
      headers: { 'content-type': 'application/json' }
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  function fmtDate(ms) {
    if (ms == null) return 'never expires';
    var d = new Date(ms);
    return 'expires ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function actionSummary(a) {
    if (!a) return '';
    if (a.type === 'assist') return 'say: ' + a.text;
    var t = a.target && (a.target.entity_id || a.target.area_id || a.target.device_id);
    return a.domain + '.' + a.service + (t ? ' -> ' + t : '');
  }

  // --- rendering ------------------------------------------------------------

  function slotRow(pad, n) {
    var s = (pad.slots || []).filter(function (x) { return x.slot === n; })[0];
    var set = !!s;
    var label = s ? s.label : '';
    var onA = s ? s.on : null;
    var offA = s ? s.off : null;
    var isAssist = onA && onA.type === 'assist';

    var entityVal = onA && onA.target ? (onA.target.entity_id || '') : '';
    var assistOn = isAssist ? onA.text : '';
    var assistOff = offA && offA.type === 'assist' ? offA.text : '';
    // A fresh slot is almost always a light or a switch, so default to a
    // toggle. An existing slot shows whatever it actually is.
    var wantToggle = set ? !!offA : true;

    return '<div class="slot ' + (set ? 'set' : '') + '" data-slot="' + n + '">' +
      '<div class="row">' +
        '<span class="slotno">' + n + '</span>' +
        '<input class="grow f-label" placeholder="Button label, e.g. Porch light" value="' + esc(label) + '" maxlength="60">' +
        '<select class="f-mode">' +
          '<option value="service"' + (!isAssist ? ' selected' : '') + '>Pick a device</option>' +
          '<option value="assist"' + (isAssist ? ' selected' : '') + '>Say it in words</option>' +
        '</select>' +
      '</div>' +
      '<div class="row f-service' + (isAssist ? ' gone' : '') + '">' +
        '<input class="grow f-entity" list="entlist" placeholder="Type a device name, e.g. Porch light" value="' + esc(entityVal) + '">' +
        '<select class="f-behaviour">' +
          '<option value="toggle"' + (wantToggle ? ' selected' : '') + '>On / off toggle</option>' +
          '<option value="once"' + (!wantToggle ? ' selected' : '') + '>Single action</option>' +
        '</select>' +
      '</div>' +
      '<div class="row f-assist' + (isAssist ? '' : ' gone') + '">' +
        '<input class="grow f-assist-on" placeholder="What to say, e.g. turn on the porch light" value="' + esc(assistOn) + '">' +
        '<input class="grow f-assist-off" placeholder="Off phrase (optional, makes it a toggle)" value="' + esc(assistOff) + '">' +
      '</div>' +
      '<div class="row">' +
        '<button class="f-save">Save</button>' +
        '<button class="f-test"' + (set ? '' : ' disabled') + '>Test</button>' +
        '<button class="f-testoff"' + (set && offA ? '' : ' disabled') + '>Test off</button>' +
        '<button class="danger f-clear"' + (set ? '' : ' disabled') + '>Clear</button>' +
        '<span class="muted mono">' + esc(actionSummary(onA)) + '</span>' +
      '</div>' +
    '</div>';
  }

  function padCard(pad, links) {
    var expanded = !!open[pad.name];
    var active = links.filter(function (l) { return l.active; });

    var head = '<div class="row spread">' +
        '<div class="row">' +
          '<h2 class="f-title" title="Click to rename" style="cursor:text">' + esc(pad.title || pad.name) + '</h2>' +
          '<span class="pill">' + (pad.slots || []).length + ' button' + ((pad.slots || []).length === 1 ? '' : 's') + '</span>' +
          '<span class="pill">' + active.length + ' live link' + (active.length === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="row">' +
          '<button class="f-toggle">' + (expanded ? 'Hide' : 'Edit') + '</button>' +
          '<button class="danger f-delpad">Delete</button>' +
        '</div>' +
      '</div>';

    if (!expanded) return '<div class="card" data-pad="' + esc(pad.name) + '">' + head + '</div>';

    var slots = '';
    for (var n = 1; n <= 9; n++) slots += slotRow(pad, n);

    var linkRows = links.length
      ? links.map(function (l) {
          return '<div class="row spread" style="border-top:1px solid var(--line);padding-top:.5rem">' +
            '<span class="muted">' + esc(l.label || 'unlabelled') + ' &middot; ' +
              (l.revokedAt ? 'revoked' : (l.active ? fmtDate(l.expiresAt) : 'expired')) + '</span>' +
            (l.active ? '<button class="danger f-revoke" data-id="' + esc(l.id) + '">Revoke</button>' : '') +
          '</div>';
        }).join('')
      : '<p class="muted">No links yet.</p>';

    return '<div class="card" data-pad="' + esc(pad.name) + '">' + head +
      '<div style="margin-top:.8rem">' + slots + '</div>' +
      '<details class="adv" style="margin-top:1rem"><summary>Share links</summary>' +
        '<div class="row">' +
          '<input class="grow f-linklabel" placeholder="Who is this for? e.g. dog sitter">' +
          '<select class="f-ttl">' +
            '<option value="1">1 day</option>' +
            '<option value="7" selected>7 days</option>' +
            '<option value="30">30 days</option>' +
            '<option value="0">Never expires</option>' +
          '</select>' +
          '<button class="primary f-mint">Create link</button>' +
        '</div>' +
        '<div class="f-minted" style="margin-top:.6rem"></div>' +
        '<div style="margin-top:.8rem">' + linkRows + '</div>' +
      '</details>' +
    '</div>';
  }

  // --- loading --------------------------------------------------------------

  function refresh() {
    return api('/status').then(function (st) {
      var bits = [];
      bits.push(st.house.connected ? 'House connected' : ('House unreachable' + (st.house.error ? ': ' + st.house.error : '')));
      if (st.publicBase) bits.push('links at ' + st.publicBase);
      else bits.push('no public URL yet - links will come back as paths');
      statusEl.textContent = bits.join(' \\u00b7 ');

      if (st.house.connected && !entities.length) {
        api('/ha/entities').then(function (d) {
          entities = d.entities || [];
          var dl = document.getElementById('entlist');
          if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'entlist';
            document.body.appendChild(dl);
          }
          dl.innerHTML = entities.map(function (e) {
            // value is what lands in the box; label is the hint beside it.
            return '<option value="' + esc(e.name) + '">' + esc(e.entity_id) + '</option>';
          }).join('');
        }).catch(function () {});
      }

      return Promise.all((st.pads || []).map(function (p) {
        return api('/pads/' + encodeURIComponent(p.name));
      }));
    }).then(function (details) {
      if (!details.length) {
        app.innerHTML = '<div class="card"><p class="muted">No pads yet. Create one below, or just ask the agent in chat.</p></div>';
        return;
      }
      app.innerHTML = details.map(function (d) { return padCard(d.pad, d.shares || []); }).join('');
    }).catch(function (e) { toast(e.message, true); });
  }

  // --- events ---------------------------------------------------------------

  document.getElementById('addpad').addEventListener('click', function () {
    var el = document.getElementById('newpad');
    var name = el.value.trim();
    if (!name) return toast('Give the pad a name.', true);
    api('/pads', { method: 'POST', body: JSON.stringify({ name: name, title: name }) })
      .then(function (d) { el.value = ''; open[d.pad.name] = true; return refresh(); })
      .then(function () { toast('Pad created.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  // Owners know their devices by name, not by entity id. Accept either, and
  // when a name is ambiguous say which ones it matched instead of guessing.
  // A pad button controls something. Sensors sharing a name with the thing they
  // measure ("Bedroom Lamp Power") would otherwise crowd out the actual lamp.
  var CONTROLLABLE = ['light','switch','fan','cover','lock','media_player','scene','script','button','input_boolean','climate','humidifier','vacuum','automation'];
  function controllable(list) {
    var hit = list.filter(function (e) { return CONTROLLABLE.indexOf(e.domain) >= 0; });
    return hit.length ? hit : list;
  }

  function resolveEntity(typed) {
    var q = typed.toLowerCase();
    var byId = entities.filter(function (e) { return e.entity_id.toLowerCase() === q; });
    if (byId.length) return byId[0].entity_id;

    var exact = controllable(entities.filter(function (e) { return (e.name || '').toLowerCase() === q; }));
    if (exact.length === 1) return exact[0].entity_id;
    if (exact.length > 1) {
      throw new Error('Several devices are called "' + typed + '": ' +
        exact.map(function (e) { return e.entity_id; }).join(', ') +
        '. Type the one you want.');
    }

    var partial = controllable(entities.filter(function (e) {
      return (e.name || '').toLowerCase().indexOf(q) >= 0 || e.entity_id.toLowerCase().indexOf(q) >= 0;
    }));
    if (partial.length === 1) return partial[0].entity_id;
    if (partial.length > 1 && partial.length <= 6) {
      throw new Error('Did you mean: ' + partial.map(function (e) {
        return e.name + ' (' + e.entity_id + ')';
      }).join(' / ') + '?');
    }
    if (partial.length > 6) {
      throw new Error('"' + typed + '" matches ' + partial.length + ' devices. Be more specific.');
    }
    if (!entities.length) {
      throw new Error('No device list loaded yet - is the house connected?');
    }
    throw new Error('No device called "' + typed + '". Start typing and pick from the list.');
  }

  function buildActions(slotEl) {
    var mode = slotEl.querySelector('.f-mode').value;
    if (mode === 'assist') {
      var on = slotEl.querySelector('.f-assist-on').value.trim();
      var off = slotEl.querySelector('.f-assist-off').value.trim();
      if (!on) throw new Error('Enter a phrase for this button.');
      return { on: { type: 'assist', text: on }, off: off ? { type: 'assist', text: off } : null };
    }
    var typed = slotEl.querySelector('.f-entity').value.trim();
    if (!typed) throw new Error('Which device? Start typing its name.');
    var ent = resolveEntity(typed);
    var domain = ent.split('.')[0];
    var behaviour = slotEl.querySelector('.f-behaviour').value;
    // turn_on/turn_off exist across light, switch, fan, cover-ish domains; for
    // anything else a single "toggle" is the safe default.
    var pair = ['light', 'switch', 'fan', 'input_boolean', 'media_player', 'humidifier', 'climate'];
    if (behaviour === 'toggle' && pair.indexOf(domain) >= 0) {
      return {
        on:  { type: 'service', domain: domain, service: 'turn_on',  target: { entity_id: ent } },
        off: { type: 'service', domain: domain, service: 'turn_off', target: { entity_id: ent } }
      };
    }
    var single = domain === 'scene' ? 'turn_on'
      : domain === 'script' ? 'turn_on'
      : domain === 'button' ? 'press'
      : domain === 'automation' ? 'trigger'
      : behaviour === 'toggle' ? 'toggle' : 'turn_on';
    return { on: { type: 'service', domain: domain, service: single, target: { entity_id: ent } }, off: null };
  }

  // The title was display-only, so a pad created as "guest" was stuck being
  // called "guest" on the page every visitor sees. Click it to rename.
  app.addEventListener('click', function (ev) {
    var h = ev.target.closest('.f-title');
    if (!h || h.dataset.editing) return;
    var card = h.closest('[data-pad]');
    var padName = card.getAttribute('data-pad');
    var current = h.textContent;
    h.dataset.editing = '1';
    h.innerHTML = '';
    var input = document.createElement('input');
    input.value = current;
    input.maxLength = 60;
    input.style.font = 'inherit';
    h.appendChild(input);
    input.focus();
    input.select();
    function done(save) {
      var v = input.value.trim();
      h.removeAttribute('data-editing');
      if (!save || !v || v === current) { h.textContent = current; return; }
      api('/pads', { method: 'POST', body: JSON.stringify({ name: padName, title: v }) })
        .then(refresh).then(function () { toast('Renamed to "' + v + '".'); })
        .catch(function (e) { toast(e.message, true); h.textContent = current; });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', function () { done(true); });
  });

  app.addEventListener('change', function (ev) {
    if (!ev.target.classList.contains('f-mode')) return;
    var slotEl = ev.target.closest('.slot');
    var assist = ev.target.value === 'assist';
    slotEl.querySelector('.f-service').classList.toggle('gone', assist);
    slotEl.querySelector('.f-assist').classList.toggle('gone', !assist);
  });

  app.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    var card = btn.closest('[data-pad]');
    if (!card) return;
    var pad = card.getAttribute('data-pad');
    var slotEl = btn.closest('.slot');
    var slot = slotEl ? Number(slotEl.getAttribute('data-slot')) : null;

    if (btn.classList.contains('f-toggle')) {
      open[pad] = !open[pad];
      return refresh();
    }

    if (btn.classList.contains('f-delpad')) {
      if (!confirm('Delete the "' + pad + '" pad? Any live links to it stop working immediately.')) return;
      return api('/pads/' + encodeURIComponent(pad), { method: 'DELETE' })
        .then(refresh).then(function () { toast('Pad deleted.'); })
        .catch(function (e) { toast(e.message, true); });
    }

    if (btn.classList.contains('f-save')) {
      var payload;
      try {
        var a = buildActions(slotEl);
        payload = { label: slotEl.querySelector('.f-label').value.trim(), on: a.on, off: a.off };
      } catch (e) { return toast(e.message, true); }
      var what = payload.on && payload.on.target && payload.on.target.entity_id;
      return api('/pads/' + encodeURIComponent(pad) + '/slots/' + slot, {
        method: 'PUT', body: JSON.stringify(payload)
      }).then(refresh).then(function () {
        toast('Button ' + slot + ' saved' + (what ? ' - ' + what : '') + '.');
      }).catch(function (e) { toast(e.message, true); });
    }

    if (btn.classList.contains('f-test') || btn.classList.contains('f-testoff')) {
      var which = btn.classList.contains('f-testoff') ? 'off' : 'on';
      return api('/pads/' + encodeURIComponent(pad) + '/test/' + slot, {
        method: 'POST', body: JSON.stringify({ which: which })
      }).then(function (d) { toast(d.speech || 'Done.'); })
        .catch(function (e) { toast(e.message, true); });
    }

    if (btn.classList.contains('f-clear')) {
      return api('/pads/' + encodeURIComponent(pad) + '/slots/' + slot, { method: 'DELETE' })
        .then(refresh).then(function () { toast('Button ' + slot + ' cleared.'); })
        .catch(function (e) { toast(e.message, true); });
    }

    if (btn.classList.contains('f-mint')) {
      var label = card.querySelector('.f-linklabel').value.trim();
      var ttl = card.querySelector('.f-ttl').value;
      return api('/shares', {
        method: 'POST', body: JSON.stringify({ pad: pad, ttl: ttl, label: label })
      }).then(function (d) {
        // Shown exactly once. We store only a hash, so this cannot be recovered.
        card.querySelector('.f-minted').innerHTML =
          '<p class="muted" style="margin:.2rem 0">Copy this now - it is not shown again.</p>' +
          '<code class="url">' + esc(d.url || d.path) + '</code>';
        toast('Link created.');
      }).catch(function (e) { toast(e.message, true); });
    }

    if (btn.classList.contains('f-revoke')) {
      return api('/shares/' + encodeURIComponent(btn.getAttribute('data-id')) + '?pad=' + encodeURIComponent(pad), {
        method: 'DELETE'
      }).then(refresh).then(function () { toast('Link revoked.'); })
        .catch(function (e) { toast(e.message, true); });
    }
  });

  refresh();
})();
</script>
</body></html>`;
