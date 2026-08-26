#!/usr/bin/env node
// pads -- manage guest pads and share links.
//
// This is a thin client for the config server's own API, reached over loopback
// inside the agent's container. It exists so that the server stays the single
// writer of workspace/data: the agent never edits pads.json by hand, because
// the web config app can be writing it at the same moment.
//
// Run `pads` with no arguments for the command list.

import { applyProxy } from './proxy.mjs';

// Loopback is in NO_PROXY so this does not route through the tailnet, but the
// call still has to be made from a process that understands the setting.
applyProxy();

const PORT = process.env.ADMIN_PORT || 4322;
const API = `http://127.0.0.1:${PORT}/api`;

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=', 2);
    flags[k] = v === undefined ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true) : v;
  } else args.push(a);
}

const die = (m, code = 1) => { console.error(m); process.exit(code); };
const pad = (s, n) => String(s).padEnd(n);

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    die(`The pad server is not answering on port ${PORT}.\n` +
        'It is started by scripts.start in manifest.json. Check /tmp/user-start.log.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) die(body.error || `HTTP ${res.status}`);
  return body;
}

// Turns "light.porch" plus a behaviour into the stored action pair. Domains
// that have a real turn_on/turn_off pair get a true toggle; everything else
// gets a single action, because inventing a turn_off for e.g. a scene would
// produce a button that fails on every second press.
const PAIRED = ['light', 'switch', 'fan', 'input_boolean', 'media_player', 'humidifier', 'climate'];

function actionsFor(entity, { toggle = true } = {}) {
  if (!entity || !entity.includes('.')) die('Entity must look like light.porch');
  const domain = entity.split('.')[0];
  if (toggle && PAIRED.includes(domain)) {
    return {
      on: { type: 'service', service: `${domain}.turn_on`, target: { entity_id: entity } },
      off: { type: 'service', service: `${domain}.turn_off`, target: { entity_id: entity } },
    };
  }
  const single = domain === 'button' ? 'press'
    : domain === 'automation' ? 'trigger'
    : domain === 'scene' || domain === 'script' ? 'turn_on'
    : toggle ? 'toggle' : 'turn_on';
  return { on: { type: 'service', service: `${domain}.${single}`, target: { entity_id: entity } }, off: null };
}

const fmtExpiry = (ms) => (ms == null ? 'never expires' : `expires ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}`);

const commands = {
  async status() {
    const s = await api('/status');
    console.log(s.house.connected ? 'House: connected' : `House: UNREACHABLE ${s.house.error ? `(${s.house.error})` : ''}`);
    console.log(`Links:  ${s.publicBase || 'no public URL yet - links come back as paths'}`);
    console.log(`Pads:   ${s.pads.length ? s.pads.map((p) => `${p.name} (${p.slots})`).join(', ') : 'none yet'}`);
  },

  async list() {
    const { pads } = await api('/pads');
    if (!pads.length) return console.log('No pads yet. Create one with: pads new <name>');
    for (const p of pads) console.log(`${pad(p.name, 20)} ${pad(`${p.slots} buttons`, 12)} ${p.title}`);
  },

  async show() {
    const name = args[0] || die('usage: pads show <pad>');
    const { pad: p, shares } = await api(`/pads/${encodeURIComponent(name)}`);
    console.log(`${p.title} (${p.name})\n`);
    for (const s of (p.slots || []).sort((a, b) => a.slot - b.slot)) {
      const a = s.on;
      const what = a.type === 'assist' ? `say "${a.text}"` : `${a.domain}.${a.service} ${a.target?.entity_id ?? ''}`;
      console.log(`  ${s.slot}  ${pad(s.label || '(no label)', 24)} ${what}${s.off ? '  [toggle]' : ''}`);
    }
    const live = shares.filter((s) => s.active);
    console.log(`\n  ${live.length} live link${live.length === 1 ? '' : 's'}`);
    for (const s of live) console.log(`    ${pad(s.id, 18)} ${pad(s.label || '-', 20)} ${fmtExpiry(s.expiresAt)}`);
  },

  async new() {
    const name = args[0] || die('usage: pads new <name> [--title "Guest room"]');
    const r = await api('/pads', { method: 'POST', body: JSON.stringify({ name, title: flags.title || name }) });
    console.log(`Created pad "${r.pad.name}".`);
  },

  async delete() {
    const name = args[0] || die('usage: pads delete <pad>');
    await api(`/pads/${encodeURIComponent(name)}`, { method: 'DELETE' });
    console.log(`Deleted "${name}". Any live links to it stopped working.`);
  },

  async set() {
    // pads set guest 1 --entity light.porch --label "Porch light"
    // pads set guest 3 --say "start movie night" --label "Movie night"
    const [name, slot] = args;
    if (!name || slot == null) {
      die('usage: pads set <pad> <1-9> (--entity light.porch | --say "phrase") [--label "..."] [--once]');
    }
    let body;
    if (flags.say) {
      body = {
        label: flags.label || '',
        on: { type: 'assist', text: String(flags.say) },
        off: flags.sayoff ? { type: 'assist', text: String(flags.sayoff) } : null,
      };
    } else if (flags.entity) {
      const a = actionsFor(String(flags.entity), { toggle: !flags.once });
      body = { label: flags.label || '', on: a.on, off: a.off };
    } else {
      die('Give the button something to do: --entity light.porch or --say "turn on the lights"');
    }
    const r = await api(`/pads/${encodeURIComponent(name)}/slots/${slot}`, { method: 'PUT', body: JSON.stringify(body) });
    console.log(`Button ${slot} on "${name}" set${r.slot.off ? ' (toggle)' : ''}.`);
  },

  async clear() {
    const [name, slot] = args;
    if (!name || slot == null) die('usage: pads clear <pad> <1-9>');
    await api(`/pads/${encodeURIComponent(name)}/slots/${slot}`, { method: 'DELETE' });
    console.log(`Button ${slot} on "${name}" cleared.`);
  },

  async test() {
    const [name, slot] = args;
    if (!name || slot == null) die('usage: pads test <pad> <1-9> [--off]');
    const r = await api(`/pads/${encodeURIComponent(name)}/test/${slot}`, {
      method: 'POST', body: JSON.stringify({ which: flags.off ? 'off' : 'on' }),
    });
    console.log(r.speech || 'Done.');
  },

  async share() {
    const name = args[0] || die('usage: pads share <pad> [--ttl 7|30|never] [--label "dog sitter"]');
    const r = await api('/shares', {
      method: 'POST',
      body: JSON.stringify({ pad: name, ttl: flags.ttl ?? 7, label: flags.label || '' }),
    });
    // Shown once. Only a hash is stored, so this cannot be recovered later.
    console.log(r.url || r.path);
    console.log(`\n${fmtExpiry(r.expiresAt)}. id ${r.id}`);
    if (!r.url) console.log('No public URL is configured, so that is a path. Prefix it with the agent URL.');
    console.log('This link is shown once and cannot be recovered - send it now or mint another.');
  },

  async links() {
    const { shares } = await api(`/shares${args[0] ? `?pad=${encodeURIComponent(args[0])}` : ''}`);
    if (!shares.length) return console.log('No links yet.');
    for (const s of shares) {
      const status = s.revokedAt ? 'revoked' : s.active ? fmtExpiry(s.expiresAt) : 'expired';
      console.log(`${pad(s.id, 18)} ${pad(s.pad, 14)} ${pad(s.label || '-', 20)} ${status}`);
    }
  },

  async revoke() {
    const id = args[0] || die('usage: pads revoke <link-id>');
    await api(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
    console.log('Revoked. That link stops working immediately.');
  },
};

const USAGE = `pads -- guest pads and share links

  pads status                     house + pads at a glance
  pads list                       every pad
  pads show <pad>                 buttons and live links for one pad

  pads new <pad> [--title "..."]
  pads delete <pad>

  pads set <pad> <1-9> --entity light.porch [--label "Porch light"] [--once]
  pads set <pad> <1-9> --say "start movie night" [--sayoff "..."] [--label "..."]
  pads clear <pad> <1-9>
  pads test  <pad> <1-9> [--off]

  pads share <pad> [--ttl 1|7|30|never] [--label "dog sitter"]
  pads links [pad]
  pads revoke <link-id>

--entity makes a real on/off toggle where the domain supports it; --once forces
a single action. --say sends a phrase to HA Assist instead of a service call.`;

const cmd = args.shift();
if (!cmd || cmd === 'help' || flags.help) { console.log(USAGE); process.exit(0); }
if (!commands[cmd]) { console.error(`Unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1); }

commands[cmd]().catch((err) => { console.error(err.message); process.exit(1); });
