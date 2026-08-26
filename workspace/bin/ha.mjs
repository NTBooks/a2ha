#!/usr/bin/env node
// ha -- Home Assistant from the terminal.
//
// This is the agent's hands. It talks to HA_BASE_URL with HA_TOKEN over the
// REST API, and drops to the WebSocket API for the registries (helpers, areas,
// labels, devices) which REST does not expose.
//
// Output is deliberately terse. A real house has hundreds of entities and a
// raw /api/states dump is a few hundred kilobytes -- enough to blow a small
// model context in one command. So reads summarise by default and you opt in
// to the full thing with --json.
//
// Run `ha` with no arguments for the command list.

const BASE = String(process.env.HA_BASE_URL ?? '').trim().replace(/\/+$/, '');
const TOKEN = String(process.env.HA_TOKEN ?? '').trim();

if (!BASE || !TOKEN) {
  console.error('HA_BASE_URL and HA_TOKEN are not set on this agent.');
  console.error('Add them as secrets in the Pinata dashboard, then restart the agent.');
  process.exit(2);
}

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

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// --- backups -----------------------------------------------------------------
// Nothing that edits a config object is allowed to do so without first writing
// down what was there. Overwriting someone's automation with a bad body is an
// easy mistake and, without this, an unrecoverable one -- Home Assistant keeps
// no history of its own.
//
// A backup of an object that did not exist yet is recorded as a tombstone, so
// restoring it correctly deletes rather than resurrecting something invented.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BACKUP_DIR = process.env.BACKUP_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function snapshot(kind, id, reason) {
  let before = null;
  let existed = true;
  try {
    before = await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.status === 404) existed = false;
    else {
      // We could not read the current value, so we cannot promise a rollback.
      // Say so loudly rather than proceeding as if the net were there.
      throw new Error(
        `Refusing to ${reason} ${kind}.${id}: could not read its current value to back it up (${err.message}).\n` +
        'Re-run with --no-backup if you have decided to proceed without a rollback.');
    }
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = join(BACKUP_DIR, `${kind}.${id}.${stamp()}.json`);
  writeFileSync(file, `${JSON.stringify({
    kind, id, reason, savedAt: new Date().toISOString(), existed, body: before,
  }, null, 2)}\n`, 'utf8');
  return { file, existed };
}

function listBackups(filter = '') {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json') && (!filter || f.includes(filter)))
    .sort()
    .reverse();
}

async function rest(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${path}${text ? ` :: ${text.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// --- WebSocket ---------------------------------------------------------------
// REST cannot create a helper or list areas. The frontend uses the WebSocket
// API for those, and so do we. Node has had a built-in WebSocket since 22.

async function ws(command, { timeout = 15000 } = {}) {
  const url = BASE.replace(/^http/, 'ws') + '/api/websocket';
  const sock = new WebSocket(url);
  let id = 0;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { sock.close(); } catch {} reject(new Error('websocket timed out')); }, timeout);
    const finish = (fn, v) => { clearTimeout(timer); try { sock.close(); } catch {} fn(v); };

    sock.addEventListener('error', () => finish(reject, new Error(`could not open a websocket to ${url}`)));
    sock.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'auth_required') {
        sock.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
      } else if (msg.type === 'auth_invalid') {
        finish(reject, new Error('HA rejected the token over websocket'));
      } else if (msg.type === 'auth_ok') {
        id += 1;
        sock.send(JSON.stringify({ id, ...command }));
      } else if (msg.type === 'result') {
        if (msg.success) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error?.message || 'websocket command failed'));
      }
    });
  });
}

// --- helpers -----------------------------------------------------------------

const parseJsonFlag = (v, what) => {
  if (v == null || v === true) return undefined;
  try { return JSON.parse(v); } catch { die(`--${what} must be JSON, got: ${v}`); }
};

function targetFromFlags() {
  if (flags.target) return parseJsonFlag(flags.target, 'target');
  const t = {};
  if (flags.entity) t.entity_id = flags.entity;
  if (flags.area) t.area_id = flags.area;
  if (flags.device) t.device_id = flags.device;
  return Object.keys(t).length ? t : undefined;
}

const pad = (s, n) => String(s).padEnd(n);

// --- commands ----------------------------------------------------------------

const commands = {
  async doctor() {
    // Probes everything the agent depends on, including the two undocumented
    // surfaces, so a broken one is discovered here rather than mid-task.
    const checks = [];
    const probe = async (name, fn) => {
      try { checks.push([name, 'ok', await fn()]); }
      catch (e) { checks.push([name, 'FAIL', e.message]); }
    };

    await probe('REST /api/', async () => (await rest('/api/'))?.message);
    await probe('read states', async () => `${(await rest('/api/states')).length} entities`);
    await probe('render template', () => rest('/api/template', { method: 'POST', body: { template: '{{ 1 + 1 }}' } }));
    await probe('list automations (config API)', async () => {
      // Undocumented but used by the HA UI editor. If this fails, automation
      // writing is unavailable and HA.md's playbook needs the websocket route.
      const list = await rest('/api/config/automation/config');
      return Array.isArray(list) ? `${list.length} automations` : 'reachable';
    });
    await probe('websocket auth + area registry', async () => {
      const areas = await ws({ type: 'config/area_registry/list' });
      return `${areas.length} areas`;
    });

    const width = Math.max(...checks.map((c) => c[0].length));
    for (const [name, status, detail] of checks) {
      console.log(`${pad(name, width)}  ${pad(status, 5)}  ${detail ?? ''}`);
    }
    if (checks.some((c) => c[1] === 'FAIL')) process.exit(1);
  },

  async states() {
    const filter = (args[0] || flags.filter || '').toLowerCase();
    const all = await rest('/api/states');

    if (!filter) {
      // No filter: never dump the house. Show the shape of it instead.
      const byDomain = {};
      for (const s of all) {
        const d = s.entity_id.split('.')[0];
        byDomain[d] = (byDomain[d] || 0) + 1;
      }
      console.log(`${all.length} entities. Pass a filter to list them, e.g. "ha states light".\n`);
      for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
        console.log(`${pad(d, 24)} ${n}`);
      }
      return;
    }

    const hits = all.filter((s) =>
      s.entity_id.toLowerCase().includes(filter) ||
      String(s.attributes?.friendly_name ?? '').toLowerCase().includes(filter));

    if (flags.json) return out(hits);
    if (!hits.length) return console.log(`No entities matching "${filter}".`);

    const w = Math.min(46, Math.max(...hits.map((h) => h.entity_id.length)));
    for (const h of hits.slice(0, Number(flags.limit || 60))) {
      console.log(`${pad(h.entity_id, w)}  ${pad(h.state, 12)}  ${h.attributes?.friendly_name ?? ''}`);
    }
    if (hits.length > Number(flags.limit || 60)) {
      console.log(`... and ${hits.length - Number(flags.limit || 60)} more. Narrow the filter or pass --limit.`);
    }
  },

  async get() {
    const id = args[0] || die('usage: ha get <entity_id>');
    out(await rest(`/api/states/${encodeURIComponent(id)}`));
  },

  async call() {
    const spec = args[0] || die('usage: ha call <domain.service> [--entity X | --target JSON] [--data JSON]');
    const [domain, service] = spec.includes('.') ? spec.split('.', 2) : [spec, args[1]];
    if (!domain || !service) die('usage: ha call <domain.service> ...');
    const body = { ...(parseJsonFlag(flags.data, 'data') || {}), ...(targetFromFlags() || {}) };
    out(await rest(`/api/services/${domain}/${service}`, { method: 'POST', body }));
  },

  async template() {
    const t = args[0] || die('usage: ha template \'{{ states("light.porch") }}\'');
    out(await rest('/api/template', { method: 'POST', body: { template: t } }));
  },

  async services() {
    const filter = (args[0] || '').toLowerCase();
    const all = await rest('/api/services');
    for (const d of all) {
      if (filter && !d.domain.includes(filter)) continue;
      console.log(`${d.domain}: ${Object.keys(d.services).join(', ')}`);
    }
  },

  async logs() {
    const text = await rest('/api/error_log');
    const lines = String(text).trim().split('\n');
    console.log(lines.slice(-Number(flags.lines || 40)).join('\n'));
  },

  async ws() {
    const raw = args[0] || die('usage: ha ws \'{"type":"config/area_registry/list"}\'');
    out(await ws(JSON.parse(raw)));
  },

  async backups() {
    const files = listBackups(args[0] || '');
    if (!files.length) return console.log('No backups yet.');
    for (const f of files.slice(0, Number(flags.limit || 40))) {
      let note = '';
      try {
        const s = JSON.parse(readFileSync(join(BACKUP_DIR, f), 'utf8'));
        note = `${s.reason}${s.existed ? '' : ' (did not exist)'}${s.body?.alias ? ` :: ${s.body.alias}` : ''}`;
      } catch {}
      console.log(`${pad(f, 56)} ${note}`);
    }
    if (files.length > Number(flags.limit || 40)) console.log(`... and ${files.length - Number(flags.limit || 40)} older.`);
  },

  async restore() {
    const kind = args.shift();
    if (!['automation', 'script', 'scene'].includes(kind)) {
      die('usage: ha restore <automation|script|scene> <id> [--file <path>]');
    }
    args.unshift('restore');
    // configObject reads verb from args[0] and id from args[1].
    return configObject(kind);
  },

  async areas() { out(await ws({ type: 'config/area_registry/list' })); },
  async devices() { out(await ws({ type: 'config/device_registry/list' })); },
  async labels() { out(await ws({ type: 'config/label_registry/list' })); },

  // --- config objects: automation / script / scene ---------------------------
  // These use /api/config/<kind>/config/<id>, which the HA UI editor uses but
  // which is not in the published REST docs. `ha doctor` probes it; if it is
  // unavailable on a given HA build, say so rather than silently failing.
  async automation() { return configObject('automation'); },
  async script() { return configObject('script'); },
  async scene() { return configObject('scene'); },
};

async function configObject(kind) {
  const verb = args[0] || 'list';
  const id = args[1];

  if (verb === 'list') {
    const list = await rest(`/api/config/${kind}/config`).catch(() => null);
    if (Array.isArray(list)) {
      for (const item of list) {
        console.log(`${pad(item.id ?? '?', 22)} ${item.alias ?? item.name ?? ''}`);
      }
      return;
    }
    // Fall back to the entity list, which always works.
    const states = await rest('/api/states');
    for (const s of states.filter((x) => x.entity_id.startsWith(`${kind}.`))) {
      console.log(`${pad(s.entity_id, 44)} ${pad(s.state, 10)} ${s.attributes?.friendly_name ?? ''}`);
    }
    return;
  }

  if (verb === 'get') {
    if (!id) die(`usage: ha ${kind} get <id>`);
    return out(await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`));
  }

  if (verb === 'put') {
    if (!id) die(`usage: ha ${kind} put <id> --body '<json>'   (or pipe JSON on stdin)`);
    const body = flags.body ? JSON.parse(flags.body) : JSON.parse(await readStdin());

    let saved = null;
    if (!flags['no-backup']) saved = await snapshot(kind, id, 'overwrite');

    const r = await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`, { method: 'POST', body });
    out(r ?? { ok: true });
    if (saved) {
      console.error(saved.existed
        ? `Backed up the previous version to ${saved.file}`
        : `${kind}.${id} is new; recorded a tombstone at ${saved.file}`);
    }
    console.error(`Saved ${kind}.${id}. Reload it with: ha call ${kind}.reload`);
    return;
  }

  if (verb === 'delete') {
    if (!id) die(`usage: ha ${kind} delete <id>`);
    let saved = null;
    if (!flags['no-backup']) saved = await snapshot(kind, id, 'delete');
    const r = await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`, { method: 'DELETE' });
    out(r ?? { ok: true });
    if (saved?.existed) console.error(`Backed up to ${saved.file} - restore with: ha restore ${kind} ${id}`);
    return;
  }

  if (verb === 'restore') {
    if (!id) die(`usage: ha ${kind} restore <id> [--file <path>]`);
    const file = flags.file || (() => {
      const hit = listBackups(`${kind}.${id}.`)[0];
      if (!hit) die(`No backup found for ${kind}.${id}. See: ha backups`);
      return join(BACKUP_DIR, hit);
    })();

    const snap = JSON.parse(readFileSync(file, 'utf8'));
    if (!snap.existed) {
      // The object did not exist when we took the snapshot, so restoring that
      // moment means removing it again.
      await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      console.error(`${kind}.${id} did not exist at that point, so it has been removed again.`);
    } else {
      await rest(`/api/config/${kind}/config/${encodeURIComponent(id)}`, { method: 'POST', body: snap.body });
      console.error(`Restored ${kind}.${id} from ${snap.savedAt}.`);
    }
    console.error(`Reload it with: ha call ${kind}.reload`);
    return;
  }

  die(`usage: ha ${kind} <list|get|put|delete|restore> [id]`);
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => resolve(d.trim() || '{}'));
  });
}

const USAGE = `ha -- Home Assistant control

  ha doctor                       check everything this agent depends on
  ha states [filter]              summary, or entities matching a filter
  ha get <entity_id>              one entity, in full
  ha call <domain.service> [--entity X | --target JSON] [--data JSON]
  ha template '<jinja>'           render a template (the best read primitive)
  ha services [domain]            what services exist
  ha logs [--lines N]             tail the HA error log

  ha automation <list|get|put|delete|restore> [id] [--body JSON]
  ha script     <list|get|put|delete|restore> [id] [--body JSON]
  ha scene      <list|get|put|delete|restore> [id] [--body JSON]

  ha backups [filter]             what has been backed up, newest first
  ha restore <kind> <id> [--file] roll one object back

  ha areas | ha devices | ha labels
  ha ws '<json command>'          raw websocket command

Reads summarise by default; pass --json for the raw payload.

Every put and delete snapshots the object first, into data/backups/. That is
the only rollback that exists -- Home Assistant keeps no history of its own.
--no-backup skips it and is not something to reach for casually.`;

const cmd = args.shift();
if (!cmd || cmd === 'help' || flags.help) { console.log(USAGE); process.exit(0); }
if (!commands[cmd]) { console.error(`Unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1); }

commands[cmd]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
