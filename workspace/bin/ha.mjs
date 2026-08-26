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

import { haBaseUrl, proxyInUse } from './proxy.mjs';

// Resolves to the tailnet forwarder's loopback address when Tailscale is up,
// otherwise to HA_BASE_URL as configured. See proxy.mjs.
const BASE = haBaseUrl();
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

// Millisecond precision, because backups are selected by sorting these names
// and second-resolution stamps collide during a burst of writes.
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);

// Two writes inside the same second would otherwise land on the same filename,
// and the second would silently destroy the first backup. Suffix until free.
function backupPath(base) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Every name carries a padded counter, including the first. Mixing suffixed
  // and unsuffixed names breaks the ordering these are selected by: '.' sorts
  // after '-', so an unsuffixed file always looked newer than its own successor.
  let n = 0;
  let file;
  do {
    file = join(BACKUP_DIR, base + '-' + String(++n).padStart(3, '0') + '.json');
  } while (existsSync(file));
  return file;
}

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

  const file = backupPath(`${kind}.${id}.${stamp()}`);
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
    await probe('automation config API', async () => {
      // Undocumented but used by the HA UI editor. Note there is NO collection
      // endpoint -- only /api/config/automation/config/<id> -- so probe a real
      // id taken from the state machine. If this fails, automation writing is
      // unavailable and HA.md's playbook needs the websocket route instead.
      const states = await rest('/api/states');
      const withId = states.filter((e) => e.entity_id.startsWith('automation.') && e.attributes?.id);
      if (!withId.length) return 'no UI-editable automations to probe';
      await rest(`/api/config/automation/config/${encodeURIComponent(withId[0].attributes.id)}`);
      return `readable (${withId.length} editable automations)`;
    });
    await probe('websocket auth + area registry', async () => {
      const areas = await ws({ type: 'config/area_registry/list' });
      return `${areas.length} areas`;
    });

    // Worth reporting either way: knowing HA is reached over the tailnet
    // rather than a public URL is the difference between two very different
    // security postures, and it is not obvious from anything else here.
    if (filesEnabled()) {
      await probe('file editor', async () => {
        await filesFetch('/api/listdir?path=%2Fconfig');
        return `reachable at ${FILES_URL}`;
      });
    } else {
      checks.push(['file editor', 'off', 'YAML editing disabled - see "ha file"']);
    }

    checks.push(['network path', 'ok', proxyInUse()
      ? `tailnet (${process.env.HA_BASE_URL} via ${BASE})`
      : `direct to ${BASE}`]);

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
      console.log(`${all.length} entities. Pass a filter to list them, e.g. "ha states light".`);
      console.log('Dashboards, areas, helpers and labels are NOT entities - see "ha help".');
      console.log('');
      for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
        console.log(`${pad(d, 24)} ${n}`);
      }
      return;
    }

    const hits = all.filter((s) =>
      s.entity_id.toLowerCase().includes(filter) ||
      String(s.attributes?.friendly_name ?? '').toLowerCase().includes(filter));

    if (flags.json) return out(hits);
    if (!hits.length) {
      console.log(`No entities matching "${filter}".`);
      console.log('Note: this searched the state machine only. Dashboards, areas, helpers,');
      console.log('labels and devices are not entities and will never match here - "ha help".');
      return;
    }

    const w = Math.min(46, Math.max(...hits.map((h) => h.entity_id.length)));
    for (const h of hits.slice(0, Number(flags.limit || 60))) {
      console.log(`${pad(h.entity_id, w)}  ${pad(h.state, 12)}  ${h.attributes?.friendly_name ?? ''}`);
    }
    if (hits.length > Number(flags.limit || 60)) {
      console.log(`... and ${hits.length - Number(flags.limit || 60)} more. Narrow the filter or pass --limit.`);
    }
  },

  // The cheap path. Home Assistant's own Assist parses "turn on the office
  // lamp" locally and acts on it, for free. One round trip, no entity lookup,
  // no reasoning -- and it either worked or it did not.
  //
  // This is the trick Fanad was built around: let the house try first, and only
  // spend a model on what the house could not understand.
  async assist() {
    const text = args.join(' ').trim();
    if (!text) die('usage: ha assist "turn on the office lamp"');
    const agentId = String(process.env.HA_AGENT_ID ?? '').trim();
    const body = { text, language: 'en', ...(agentId ? { agent_id: agentId } : {}) };
    const r = await rest('/api/conversation/process', { method: 'POST', body, timeout: 20000 });

    const speech = r?.response?.speech?.plain?.speech;
    const type = r?.response?.response_type;
    const targets = r?.response?.data?.success?.length ?? 0;

    if (type === 'error' || (type === 'action_done' && targets === 0)) {
      // Assist understood nothing, or matched nothing. Say so clearly so the
      // caller knows to do the work properly rather than reporting success.
      console.error(speech || 'Assist could not handle that.');
      console.error('(assist-miss - resolve it yourself, and answer with the LLM> prefix)');
      process.exitCode = 2;
      return;
    }
    // The prefix is the point: it tells the owner, at a glance, that this
    // answer cost nothing. Relay the line as-is.
    console.log('HA> ' + (speech || 'Done.'));
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
        if (s.kind === 'dashboard') {
          // Dashboard snapshots carry meta/config, not the existed/body pair.
          const views = s.config?.views?.length;
          note = `${s.reason}${s.meta?.title ? ` :: ${s.meta.title}` : ''}` +
            (views == null ? ' (no layout yet)' : ` (${views} view${views === 1 ? '' : 's'})`);
        } else {
          note = `${s.reason}${s.existed ? '' : ' (did not exist)'}${s.body?.alias ? ` :: ${s.body.alias}` : ''}`;
        }
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

  // Lovelace lives only on the WebSocket API -- there is no REST equivalent.
  // Verified against a real install: dashboards/list returns storage-mode
  // dashboards, and lovelace/config takes the url_path (null for the default).
  async dashboards() {
    const list = await ws({ type: 'lovelace/dashboards/list' });
    if (flags.json) return out(list);
    if (!list.length) return console.log('No custom dashboards - just the default Overview.');
    const w = Math.max(...list.map((d) => String(d.url_path ?? 'lovelace').length));
    for (const d of list) {
      const bits = [d.mode, d.show_in_sidebar ? 'in sidebar' : 'hidden'];
      if (d.require_admin) bits.push('admin only');
      console.log(`${pad(d.url_path ?? 'lovelace', w)}  ${pad(d.title ?? '', 22)} ${bits.join(', ')}`);
    }
    console.log('');
    console.log('ha dashboard <url_path>   to see its views and cards');
  },

  async dashboard() {
    // The default dashboard is addressed as null, not by name.
    const path = args[0] && args[0] !== 'lovelace' ? args[0] : null;
    let cfg;
    try {
      cfg = await ws({ type: 'lovelace/config', url_path: path });
    } catch (err) {
      // HA answers an unknown url_path with "Unknown config specified".
      if (/no config found/i.test(err.message)) {
        // The dashboard exists, it just has no layout yet.
        console.log('That dashboard has no views yet.');
        console.log("Add some with: ha dashboard-save " + (args[0] || '') + " --body '<json>'");
        return;
      }
      if (/unknown config|not found/i.test(err.message)) {
        throw new Error(`No dashboard at "${args[0]}". Run: ha dashboards`);
      }
      throw err;
    }
    if (flags.json) return out(cfg);

    // An auto-generated dashboard has a strategy instead of views. Saying so is
    // more useful than printing an empty list.
    if (cfg.strategy && !cfg.views) {
      console.log(`Auto-generated by the "${cfg.strategy.type ?? 'default'}" strategy - Home Assistant`);
      console.log('builds its cards from your areas and entities, so there is no stored layout.');
      return;
    }
    // A "sections" view holds sections that hold cards, and stacks nest cards
    // inside cards. Counting the top level reports 1 for a full screen of
    // controls, which reads as an empty dashboard.
    const countCards = (cards = []) => cards.reduce(
      (n, c) => n + 1 + countCards(c.cards) + countCards(c.card ? [c.card] : []), 0);
    const viewCards = (v) =>
      countCards(v.cards) + (v.sections ?? []).reduce((n, sec) => n + countCards(sec.cards), 0);

    const views = cfg.views ?? [];
    console.log(`${views.length} view${views.length === 1 ? '' : 's'}`);
    for (const v of views) {
      const cards = viewCards(v);
      const kind = v.type === 'sections' ? ` [${(v.sections ?? []).length} sections]` : '';
      console.log(`  ${pad(v.title ?? '(untitled)', 26)} path=${pad(v.path ?? '-', 18)} ${cards} card${cards === 1 ? '' : 's'}${kind}`);
    }
  },

  async whoami() {
    const me = await ws({ type: 'auth/current_user' });
    console.log(`${me.name} (${me.id})`);
    console.log(`admin: ${me.is_admin ? 'yes' : 'no'}   owner: ${me.is_owner ? 'yes' : 'no'}`);
  },

  // The default dashboard is per-user frontend state, and the WebSocket API
  // applies it to whoever the connection authenticated as -- which is always
  // this agent's own token-holder. There is no way to set it for someone else,
  // so say whose it is every time rather than letting the owner assume it is
  // theirs.
  async homescreen() {
    const me = await ws({ type: 'auth/current_user' });
    const current = await ws({ type: 'frontend/get_user_data', key: 'core' });
    const panel = current?.value?.defaultPanel ?? null;

    if (!args[0] && !flags.clear) {
      console.log(`${me.name}'s home screen: ${panel ?? 'the Home Assistant default (Overview)'}`);
      console.log('');
      console.log(`This is ${me.name}'s own setting. Home Assistant stores it per user, and`);
      console.log('this agent can only read or change the account its token belongs to.');
      console.log("Any other user's home screen has to be set by that user, in their own");
      console.log('Home Assistant profile.');
      return;
    }

    if (flags.clear) {
      await ws({ type: 'frontend/set_user_data', key: 'core', value: null });
      console.log(`${me.name}'s home screen reset to the Home Assistant default.`);
      return;
    }

    // Refuse a dashboard that does not exist rather than storing a dead value.
    const list = await ws({ type: 'lovelace/dashboards/list' });
    const want = args[0];
    if (want !== 'lovelace' && !list.some((d) => d.url_path === want)) {
      throw new Error(`No dashboard with url_path "${want}". Run: ha dashboards`);
    }

    const value = { ...(current?.value ?? {}), defaultPanel: want };
    await ws({ type: 'frontend/set_user_data', key: 'core', value });
    console.log(`${me.name}'s home screen set to "${want}".`);
    console.log(`Only affects ${me.name} - other users keep their own.`);
  },

  // --- creating and editing dashboards -------------------------------------
  // All of this is the WebSocket API; Lovelace has no REST surface. Verified
  // against a live install: create / config.save / update / delete all work
  // for a storage-mode dashboard.

  async ['dashboard-create']() {
    const urlPath = args[0];
    if (!urlPath) die('usage: ha dashboard-create <url-path> --title "Kitchen" [--icon mdi:x] [--sidebar] [--admin]');
    // HA requires a hyphen in url_path and rejects anything else outright.
    if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(urlPath)) {
      die('url_path must be lowercase words joined by hyphens, e.g. "kitchen-panel" (got "' + urlPath + '")');
    }
    const made = await ws({
      type: 'lovelace/dashboards/create',
      url_path: urlPath,
      title: flags.title || urlPath,
      ...(flags.icon ? { icon: String(flags.icon) } : {}),
      show_in_sidebar: !!flags.sidebar,
      require_admin: !!flags.admin,
    });
    console.log('Created "' + made.title + '" at ' + made.url_path + ' (id ' + made.id + ').');
    console.log('It has no views yet - add some with: ha dashboard-save ' + made.url_path + " --body '<json>'");
  },

  async ['dashboard-update']() {
    const urlPath = args[0];
    if (!urlPath) die('usage: ha dashboard-update <url-path> [--title X] [--icon mdi:x] [--sidebar|--no-sidebar] [--admin|--no-admin]');
    const d = await findDashboard(urlPath);
    const patch = {};
    if (flags.title) patch.title = String(flags.title);
    if (flags.icon) patch.icon = String(flags.icon);
    if (flags.sidebar) patch.show_in_sidebar = true;
    if (flags['no-sidebar']) patch.show_in_sidebar = false;
    if (flags.admin) patch.require_admin = true;
    if (flags['no-admin']) patch.require_admin = false;
    if (!Object.keys(patch).length) die('Nothing to change. Pass --title, --icon, --sidebar/--no-sidebar or --admin/--no-admin.');
    const upd = await ws({ type: 'lovelace/dashboards/update', dashboard_id: d.id, ...patch });
    console.log('Updated ' + upd.url_path + ': ' + Object.keys(patch).join(', ') + '.');
  },

  async ['dashboard-save']() {
    const urlPath = args[0];
    if (!urlPath) die("usage: ha dashboard-save <url-path> --body '<json>'   (or pipe JSON on stdin)");
    await findDashboard(urlPath);
    const config = flags.body ? JSON.parse(flags.body) : JSON.parse(await readStdin());
    if (!config || typeof config !== 'object' || !Array.isArray(config.views)) {
      die('A dashboard config needs a "views" array, e.g. {"views":[{"title":"Home","cards":[]}]}');
    }
    // Catch invented card types before they reach the screen. Home Assistant
    // stores whatever you give it and only complains when it renders, so a bad
    // type looks like a clean save and shows up as "Configuration error" on the
    // dashboard -- somewhere the agent never looks.
    const proposed = collectCardTypes(config);
    const unknown = [...proposed.keys()].filter(
      (t) => !BUILTIN_CARDS.has(t) && !t.startsWith('custom:'));
    if (unknown.length) {
      const inUse = await cardTypesInUse();
      const reallyUnknown = unknown.filter((t) => !inUse.has(t));
      if (reallyUnknown.length && !flags.force) {
        die(`These card types are not Home Assistant cards and are not used anywhere ` +
            `in this house:\n  ${reallyUnknown.join('\n  ')}\n\n` +
            `There is no card named after an entity domain - an input_number goes in a ` +
            `tile with a numeric-input feature, or an entities card.\n` +
            `Run "ha cards" to see what this install actually renders. ` +
            `Pass --force if you are certain.`);
      }
    }

    const saved = flags['no-backup'] ? null : await snapshotDashboard(urlPath, 'overwrite');
    await ws({ type: 'lovelace/config/save', url_path: urlPath, config });
    console.log('Saved ' + config.views.length + ' view' + (config.views.length === 1 ? '' : 's') + ' to ' + urlPath + '.');
    if (saved) console.log('Previous layout backed up to ' + saved.file);
  },

  async ['dashboard-delete']() {
    const urlPath = args[0];
    if (!urlPath) die('usage: ha dashboard-delete <url-path>');
    const d = await findDashboard(urlPath);
    const saved = flags['no-backup'] ? null : await snapshotDashboard(urlPath, 'delete');
    await ws({ type: 'lovelace/dashboards/delete', dashboard_id: d.id });
    console.log('Deleted ' + urlPath + '.');
    if (saved) console.log('Backed up to ' + saved.file + ' - restore with: ha dashboard-restore ' + urlPath);
  },

  async ['dashboard-restore']() {
    const urlPath = args[0];
    if (!urlPath) die('usage: ha dashboard-restore <url-path> [--file <path>]');
    const file = flags.file || (() => {
      const hit = listBackups('dashboard.' + urlPath + '.')[0];
      if (!hit) die('No backup for ' + urlPath + '. See: ha backups');
      return join(BACKUP_DIR, hit);
    })();
    const snap = JSON.parse(readFileSync(file, 'utf8'));

    const list = await ws({ type: 'lovelace/dashboards/list' });
    if (!list.some((d) => d.url_path === urlPath)) {
      if (!snap.meta) die(urlPath + ' is gone and the backup has no metadata to rebuild it.');
      await ws({
        type: 'lovelace/dashboards/create',
        url_path: urlPath,
        title: snap.meta.title,
        ...(snap.meta.icon ? { icon: snap.meta.icon } : {}),
        show_in_sidebar: !!snap.meta.show_in_sidebar,
        require_admin: !!snap.meta.require_admin,
      });
      console.log('Recreated ' + urlPath + '.');
    }
    if (snap.config) {
      await ws({ type: 'lovelace/config/save', url_path: urlPath, config: snap.config });
      console.log('Restored its layout from ' + snap.savedAt + '.');
    } else {
      console.log('That backup held no layout, so only the dashboard itself was restored.');
    }
  },

  // ha file ls|read|write|rm|restore
  async file() {
    requireFiles();
    const verb = args[0] || 'ls';

    if (verb === 'ls') {
      const path = safeConfigPath(args[1] || '/config');
      const text = await filesFetch(`/api/listdir?path=${encodeURIComponent(path)}`);
      let listing;
      try { listing = JSON.parse(text); } catch { return out(text); }
      for (const d of listing.dirs ?? []) console.log(`${pad('dir', 6)} ${d.name ?? d}`);
      for (const f of listing.files ?? []) console.log(`${pad('file', 6)} ${f.name ?? f}`);
      return;
    }

    if (verb === 'read') {
      const path = safeConfigPath(args[1]);
      try {
        return out(await readConfigFile(path));
      } catch (err) {
        if (err.missing) die(`${path} does not exist.`);
        throw err;
      }
    }

    if (verb === 'write') {
      const path = safeConfigPath(args[1]);
      const text = flags.body != null && flags.body !== true
        ? String(flags.body)
        : await readStdin();
      if (!text) die('Nothing to write. Pass --body or pipe the new contents on stdin.');

      const saved = flags['no-backup'] ? null : await snapshotFile(path, 'overwrite');
      await filesFetch('/api/save', { method: 'POST', form: { filename: path, text } });
      console.log(`Wrote ${text.length} bytes to ${path}.`);
      if (saved) {
        console.log(saved.existed
          ? `Previous contents backed up to ${saved.file}`
          : `${path} is new; recorded a tombstone at ${saved.file}`);
      }

      // Validate, and put it back if it broke. An unusable configuration.yaml
      // means Home Assistant will not restart, and the owner may not find out
      // until the next reboot -- far too late to connect it to this edit.
      if (flags['no-check']) {
        console.log('Skipped the config check (--no-check). Run "ha file check" before restarting.');
        return;
      }
      const { valid, errors } = await checkConfig();
      if (valid) { console.log('Config still checks out.'); return; }

      console.error('');
      console.error('Home Assistant says the configuration is now INVALID:');
      console.error(errors ? String(errors).slice(0, 1200) : '(no detail given)');
      if (saved && saved.existed) {
        await filesFetch('/api/save', { method: 'POST', form: { filename: path, text: saved.before } });
        console.error('');
        console.error(`Rolled ${path} back to how it was. Nothing was left broken.`);
      } else if (saved) {
        console.error('');
        console.error(`${path} did not exist before. Remove it with: ha file rm ${path}`);
      }
      process.exitCode = 1;
      return;
    }

    if (verb === 'rm') {
      const path = safeConfigPath(args[1]);
      const saved = flags['no-backup'] ? null : await snapshotFile(path, 'delete');
      await filesFetch('/api/delete', { method: 'POST', form: { path } });
      console.log(`Deleted ${path}.`);
      if (saved?.existed) console.log(`Backed up to ${saved.file} - restore with: ha file restore ${path}`);
      return;
    }

    if (verb === 'restore') {
      const path = safeConfigPath(args[1]);
      const key = 'file.' + path.replace(/\//g, '_').replace(/^_/, '') + '.';
      const chosen = flags.file || (() => {
        const hit = listBackups(key)[0];
        if (!hit) die(`No backup for ${path}. See: ha backups`);
        return join(BACKUP_DIR, hit);
      })();
      const snap = JSON.parse(readFileSync(chosen, 'utf8'));
      if (!snap.existed) {
        await filesFetch('/api/delete', { method: 'POST', form: { path } });
        console.log(`${path} did not exist at that point, so it has been removed again.`);
        return;
      }
      await filesFetch('/api/save', { method: 'POST', form: { filename: path, text: snap.body } });
      console.log(`Restored ${path} from ${snap.savedAt}.`);
      return;
    }

    if (verb === 'check') {
      const { valid, errors } = await checkConfig();
      if (valid) return console.log('Configuration is valid.');
      console.error('Configuration is INVALID:');
      console.error(errors ? String(errors).slice(0, 1600) : '(no detail given)');
      process.exitCode = 1;
      return;
    }

    die('usage: ha file <ls|read|write|rm|restore|check> [path]');
  },

  // ha helper list|create|delete
  //
  // Helpers live on the WebSocket API, one namespace per domain, and delete
  // takes <domain>_id -- the object id, NOT the entity_id. Getting that wrong
  // is why an agent could create helpers but never remove them, and a run that
  // half-worked left debris behind with no way to tidy it.
  async helper() {
    const verb = args[0] || 'list';
    const HELPER_DOMAINS = ['input_number', 'input_boolean', 'input_text', 'input_select',
      'input_datetime', 'input_button', 'timer', 'counter'];

    const listDomain = async (d) => {
      try { return (await ws({ type: `${d}/list` })).map((h) => ({ ...h, domain: d })); }
      catch { return []; }  // domain not loaded on this install
    };

    if (verb === 'list') {
      const only = args[1];
      const domains = only ? [only] : HELPER_DOMAINS;
      let any = false;
      for (const d of domains) {
        const rows = await listDomain(d);
        for (const h of rows) {
          any = true;
          console.log(`${pad(`${d}.${h.id}`, 44)} ${h.name ?? ''}`);
        }
      }
      if (!any) console.log('No storage-mode helpers. (Helpers defined in YAML are not listed here.)');
      console.log('');
      console.log('Only helpers created through the UI or this tool appear here; YAML ones');
      console.log('cannot be deleted through the API.');
      return;
    }

    if (verb === 'create') {
      const domain = args[1];
      if (!HELPER_DOMAINS.includes(domain)) {
        die(`usage: ha helper create <${HELPER_DOMAINS.join('|')}> --name "..." [options]`);
      }
      const name = flags.name && flags.name !== true ? String(flags.name) : null;
      if (!name) die('A helper needs --name.');

      // Home Assistant does not reject a duplicate name -- it quietly appends
      // _2 and hands back a second entity. That is how debris accumulates, so
      // refuse instead and point at what already exists.
      const existing = (await listDomain(domain)).find((h) => h.name === name);
      if (existing && !flags.force) {
        die(`${domain}.${existing.id} already has the name "${name}".\n` +
            `Home Assistant would silently create a duplicate. Reuse that one, pick another\n` +
            `name, or pass --force if you genuinely want two.`);
      }

      const payload = { name };
      for (const k of ['min', 'max', 'step', 'initial']) {
        if (flags[k] !== undefined) payload[k] = Number(flags[k]);
      }
      for (const k of ['icon', 'mode', 'unit_of_measurement', 'duration']) {
        if (flags[k] !== undefined && flags[k] !== true) payload[k] = String(flags[k]);
      }
      if (flags.options && flags.options !== true) payload.options = String(flags.options).split(',');

      const made = await ws({ type: `${domain}/create`, ...payload });
      console.log(`Created ${domain}.${made.id}${made.name ? ` ("${made.name}")` : ''}.`);
      return;
    }

    if (verb === 'delete') {
      const ref = args[1];
      if (!ref) die('usage: ha helper delete <entity_id>');
      const domain = ref.includes('.') ? ref.split('.')[0] : args[2];
      const id = ref.includes('.') ? ref.split('.').slice(1).join('.') : ref;
      if (!HELPER_DOMAINS.includes(domain)) {
        die(`"${ref}" is not a helper. Helper domains: ${HELPER_DOMAINS.join(', ')}`);
      }

      const rows = await listDomain(domain);
      const hit = rows.find((h) => h.id === id);
      if (!hit) {
        die(`No storage-mode ${domain} with id "${id}".\n` +
            `It may be defined in YAML, which cannot be deleted through the API. Run: ha helper list ${domain}`);
      }

      // Same rule as everywhere else: write down what was there first.
      if (!flags['no-backup']) {
        const file = backupPath(`helper.${domain}.${id}.${stamp()}`);
        writeFileSync(file, JSON.stringify({
          kind: 'helper', domain, id, reason: 'delete',
          savedAt: new Date().toISOString(), body: hit,
        }, null, 2) + '\n', 'utf8');
        console.log(`Backed up to ${file}`);
      }

      // The key is <domain>_id, not entity_id. This is the bit that is easy to
      // get wrong and looks like "deleting helpers is impossible".
      await ws({ type: `${domain}/delete`, [`${domain}_id`]: id });
      console.log(`Deleted ${domain}.${id}.`);
      return;
    }

    die('usage: ha helper <list|create|delete> ...');
  },

  // What card types exist here. There is no API for "list valid cards", so the
  // best available answer is what this install already renders successfully.
  async cards() {
    const counts = await cardTypesInUse();
    if (!counts.size) return console.log('No dashboards with stored layouts yet.');
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const w = Math.max(...rows.map(([t]) => t.length));
    for (const [type, n] of rows) {
      const flag = type.startsWith('custom:') ? 'custom'
        : BUILTIN_CARDS.has(type) ? ''
        : 'NOT A KNOWN CARD TYPE';
      console.log(`${String(n).padStart(3)}  ${pad(type, w)}  ${flag}`);
    }
    console.log('');
    console.log('These are the types already rendering in this house. Prefer them.');
    console.log('Anything flagged is either a custom card or a mistake someone saved.');
  },

  async resources() {
    const list = await ws({ type: 'lovelace/resources' });
    if (flags.json) return out(list);
    if (!list.length) return console.log('No custom Lovelace resources.');
    for (const r of list) console.log(`${pad(r.type, 8)} ${r.url}`);
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

// Dashboards are addressed by url_path on the wire but by dashboard_id for
// update/delete, so look the pair up rather than guessing the transformation.
async function findDashboard(urlPath) {
  const list = await ws({ type: 'lovelace/dashboards/list' });
  const hit = list.find((d) => d.url_path === urlPath);
  if (!hit) throw new Error('No dashboard with url_path "' + urlPath + '". Run: ha dashboards');
  return hit;
}

// Same contract as snapshot() for automations: never destroy a layout without
// writing down what was there first. Stores metadata as well as config, so a
// deleted dashboard can be rebuilt and not just refilled.
async function snapshotDashboard(urlPath, reason) {
  const list = await ws({ type: 'lovelace/dashboards/list' });
  const meta = list.find((d) => d.url_path === urlPath) || null;
  let config = null;
  try {
    config = await ws({ type: 'lovelace/config', url_path: urlPath });
  } catch (err) {
    // An auto-generated dashboard genuinely has no stored config; that is not a
    // failure to read, so do not refuse the operation over it.
    if (!/no config found|unknown config|not found/i.test(err.message)) {
      throw new Error('Refusing to ' + reason + ' ' + urlPath +
        ': could not read its current layout to back it up (' + err.message + ').');
    }
  }
  const file = backupPath('dashboard.' + urlPath + '.' + stamp());
  writeFileSync(file, JSON.stringify({
    kind: 'dashboard', urlPath, reason, savedAt: new Date().toISOString(), meta, config,
  }, null, 2) + '\n', 'utf8');
  return { file };
}

// --- YAML / raw file access --------------------------------------------------
// Home Assistant has no file API of its own. The File editor add-on does, so
// this is opt-in: set HA_FILES_URL and it lights up, leave it unset and every
// file command explains how to turn it on.
//
// Studio Code Server is the nicer editor for a human but speaks the VS Code
// server protocol, not a REST API, so it is no use to us here.

const FILES_URL = String(process.env.HA_FILES_URL ?? '').trim().replace(/\/+$/, '');
const FILES_USER = String(process.env.HA_FILES_USER ?? '').trim();
const FILES_PASS = String(process.env.HA_FILES_PASSWORD ?? '').trim();

const FILES_OFF = [
  'File editing is not enabled on this agent.',
  '',
  'To turn it on:',
  '  1. In Home Assistant, install the "File editor" add-on if you have not already.',
  '  2. Open its Configuration tab. Under Network, give port 3218 a host port',
  '     (3218 is fine). Under Options set a username and password.',
  '  3. Start the add-on.',
  '  4. Add these secrets to this agent and restart it:',
  '       HA_FILES_URL       http://<same host as HA_BASE_URL>:3218',
  '       HA_FILES_USER      the username you set',
  '       HA_FILES_PASSWORD  the password you set',
  '',
  'Only do this if Home Assistant is reachable privately - over your tailnet or',
  'your LAN. The add-on port has no Home Assistant login in front of it.',
].join('\n');

function filesEnabled() { return !!FILES_URL; }

function requireFiles() {
  if (!filesEnabled()) { console.error(FILES_OFF); process.exit(3); }
}

function filesAuthHeader() {
  if (!FILES_USER && !FILES_PASS) return {};
  const raw = Buffer.from(`${FILES_USER}:${FILES_PASS}`).toString('base64');
  return { Authorization: `Basic ${raw}` };
}

async function filesFetch(path, { method = 'GET', form } = {}) {
  const headers = { ...filesAuthHeader() };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${FILES_URL}${path}`, {
    method, headers, body, signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => '');
  if (res.status === 401) {
    throw new Error('The File editor rejected the credentials. Check HA_FILES_USER and HA_FILES_PASSWORD.');
  }
  if (!res.ok) throw new Error(`File editor ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

// Refuse anything outside the config directory. The add-on may or may not
// enforce a base path itself, and this agent has no business editing the rest
// of the filesystem regardless.
function safeConfigPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Which file?');
  const full = raw.startsWith('/') ? raw : `/config/${raw}`;
  const normalised = full.replace(/\/+/g, '/');
  if (!normalised.startsWith('/config/') && normalised !== '/config') {
    throw new Error(`Refusing to touch "${normalised}" - file access is limited to /config.`);
  }
  if (normalised.includes('/../')) throw new Error('Path traversal is not allowed.');
  return normalised;
}

async function readConfigFile(path) {
  const text = await filesFetch(`/api/file?filename=${encodeURIComponent(path)}`);
  // The add-on answers a missing file with this literal body and a 200.
  if (text === 'File not found') { const e = new Error('File not found'); e.missing = true; throw e; }
  return text;
}

async function snapshotFile(path, reason) {
  let before = null;
  let existed = true;
  try {
    before = await readConfigFile(path);
  } catch (err) {
    if (err.missing) existed = false;
    else throw new Error(`Refusing to ${reason} ${path}: could not read it to back it up (${err.message}).`);
  }
  const file = backupPath('file.' + path.replace(/\//g, '_').replace(/^_/, '') + '.' + stamp());
  writeFileSync(file, JSON.stringify({
    kind: 'file', path, reason, savedAt: new Date().toISOString(), existed, body: before,
  }, null, 2) + '\n', 'utf8');
  return { file, existed, before };
}

// HA's own validator, not the add-on's. A bad configuration.yaml stops Home
// Assistant from starting, so this is the difference between an edit and an
// outage.
async function checkConfig() {
  const r = await rest('/api/config/core/check_config', { method: 'POST', timeout: 60000 });
  return { valid: r?.result === 'valid', errors: r?.errors || null };
}

// Lovelace card types that Home Assistant ships. There is no API that lists
// these -- cards are a frontend concern -- so this is a written-down list, and
// it is deliberately treated as advisory rather than authoritative.
const BUILTIN_CARDS = new Set([
  'alarm-panel', 'area', 'button', 'calendar', 'clock', 'conditional', 'entities',
  'entity', 'entity-filter', 'gauge', 'glance', 'grid', 'heading', 'history-graph',
  'horizontal-stack', 'humidifier', 'iframe', 'light', 'logbook', 'map', 'markdown',
  'media-control', 'picture', 'picture-elements', 'picture-entity', 'picture-glance',
  'plant-status', 'sensor', 'shopping-list', 'statistic', 'statistics-graph',
  'thermostat', 'tile', 'todo-list', 'vertical-stack', 'weather-forecast',
  'energy-date-selection', 'energy-usage-graph', 'energy-distribution',
]);

// Walk every card on a config, including sections and nested stacks.
function collectCardTypes(cfg, into = new Map()) {
  const walk = (cards = []) => {
    for (const c of cards) {
      if (!c || typeof c !== 'object') continue;
      if (c.type) into.set(c.type, (into.get(c.type) || 0) + 1);
      walk(c.cards);
      if (c.card) walk([c.card]);
    }
  };
  for (const v of cfg?.views ?? []) {
    walk(v.cards);
    for (const s of v.sections ?? []) walk(s.cards);
  }
  return into;
}

// What this particular install actually uses. Custom cards from HACS only show
// up here, which is why it beats any hardcoded list on its own.
async function cardTypesInUse() {
  const list = await ws({ type: 'lovelace/dashboards/list' });
  const counts = new Map();
  for (const d of [...list, { url_path: null }]) {
    try {
      const cfg = await ws({ type: 'lovelace/config', url_path: d.url_path });
      collectCardTypes(cfg, counts);
    } catch { /* strategy dashboards and empty ones have no stored config */ }
  }
  return counts;
}

async function configObject(kind) {
  const verb = args[0] || 'list';
  const id = args[1];

  if (verb === 'list') {
    // There is no collection endpoint for these -- only .../config/<id> -- so
    // the state machine is the listing. attributes.id is the handle get/put/
    // delete want; entities without one are YAML-defined and not UI-editable.
    const states = await rest('/api/states');
    const rows = states.filter((x) => x.entity_id.startsWith(`${kind}.`));
    if (!rows.length) return console.log(`No ${kind}s.`);
    for (const r of rows) {
      const id = r.attributes?.id;
      console.log(`${pad(id ?? '(yaml)', 16)} ${pad(r.state, 8)} ${r.attributes?.friendly_name ?? r.entity_id}`);
    }
    const yaml = rows.filter((r) => !r.attributes?.id).length;
    if (yaml) console.log(`
${yaml} defined in YAML - editable only in configuration.yaml, not through this API.`);
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
  ha assist "<what to do>"        let Home Assistant parse it - TRY THIS FIRST
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

  ha dashboards                   every Lovelace dashboard
  ha dashboard [url_path]         one dashboard's views and cards
  ha resources                    custom Lovelace resources
  ha whoami                       which Home Assistant user this token is
  ha homescreen [url_path]        default dashboard for this token's user
                                  (--clear resets to the HA default)

  ha dashboard-create <url-path> --title X [--icon mdi:x] [--sidebar] [--admin]
  ha dashboard-update <url-path> [--title X] [--sidebar|--no-sidebar] ...
  ha dashboard-save   <url-path> --body '<json>'
  ha dashboard-delete <url-path>
  ha dashboard-restore <url-path> [--file <path>]
  ha cards                        card types this install actually renders

  ha file ls [path]               list /config
  ha file read <path>             read a file
  ha file write <path> --body T   write it, then validate and roll back if broken
  ha file rm <path>               delete it
  ha file restore <path>          put a backup back
  ha file check                   ask HA whether the configuration is valid

  ha helper list [domain]         helpers this agent can manage
  ha helper create <domain> --name "..." [--min --max --step --icon --options]
  ha helper delete <entity_id>    remove one (backs it up first)

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
  // exitCode rather than exit(): a hard exit from inside a websocket callback
  // aborts before the socket finishes closing, which trips libuv on Windows.
  process.exitCode = 1;
});
