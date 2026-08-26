// admin.js -- the owner surface, on the gateway-protected route.
//
// Everything that writes to workspace/data goes through here, including the
// agent itself (bin/pads.mjs calls this over loopback). One writer, no races,
// and one place where a button's action gets validated before it can ever be
// reachable by a guest.
//
// This port is declared "protected" in manifest.json, so Pinata's gateway
// requires the agent token before a request from the outside world arrives.
// Inside the container it is plain loopback, which is what makes the agent's
// CLI trivial.

import { json, send, readJson, notFound } from './http.js';
import * as pads from './pads.js';
import * as shares from './shares.js';
import * as ha from './ha.js';
import { UI } from './ui.js';

const ok = (res, obj = {}) => json(res, 200, { ok: true, ...obj });
const bad = (res, error, status = 400) => json(res, status, { ok: false, error });

async function routeApi(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method;
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH'
    ? await readJson(req).catch(() => null)
    : {};
  if (body === null) return bad(res, 'Body must be JSON.');

  // --- status -------------------------------------------------------------
  if (path === '/status' && method === 'GET') {
    const cfg = ha.config();
    let house = { connected: false };
    if (ha.configured(cfg)) {
      try {
        await ha.ping();
        house = { connected: true };
      } catch (err) {
        house = { connected: false, error: err.message };
      }
    }
    return ok(res, {
      house,
      haConfigured: ha.configured(cfg),
      baseUrl: cfg.baseUrl || null,
      publicBase: shares.publicBase() || null,
      pads: pads.listPads(),
    });
  }

  // --- pads ---------------------------------------------------------------
  if (path === '/pads' && method === 'GET') return ok(res, { pads: pads.listPads() });

  if (path === '/pads' && method === 'POST') {
    const r = await pads.upsertPad(body.name, { title: body.title });
    return r.ok ? ok(res, { pad: r.pad }) : bad(res, r.error);
  }

  let m;
  if ((m = /^\/pads\/([^/]+)$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const pad = pads.getPad(name);
      return pad ? ok(res, { pad, shares: shares.list(name) }) : bad(res, `No pad called "${name}".`, 404);
    }
    if (method === 'DELETE') {
      const r = await pads.deletePad(name);
      return r.ok ? ok(res) : bad(res, r.error, 404);
    }
  }

  if ((m = /^\/pads\/([^/]+)\/slots\/(\d)$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    const slot = Number(m[2]);
    if (method === 'PUT') {
      const r = await pads.setSlot(name, slot, { label: body.label, on: body.on, off: body.off });
      return r.ok ? ok(res, { slot: r.slot }) : bad(res, r.error);
    }
    if (method === 'DELETE') {
      const r = await pads.clearSlot(name, slot);
      return r.ok ? ok(res) : bad(res, r.error);
    }
  }

  // Fire a button as the owner, to check it before handing out a link.
  if ((m = /^\/pads\/([^/]+)\/test\/(\d)$/.exec(path)) && method === 'POST') {
    const name = decodeURIComponent(m[1]);
    const slot = Number(m[2]);
    const pad = pads.getPad(name);
    const row = (pad?.slots || []).find((s) => s.slot === slot);
    if (!row) return bad(res, 'That slot is empty.');
    const which = body.which === 'off' ? 'off' : 'on';
    const action = which === 'off' ? row.off : row.on;
    if (!action) return bad(res, 'That slot has no off action.');
    const r = await ha.runAction(action);
    return r.ok ? ok(res, { speech: r.speech }) : bad(res, r.text, 502);
  }

  // --- shares -------------------------------------------------------------
  if (path === '/shares' && method === 'GET') {
    return ok(res, { shares: shares.list(url.searchParams.get('pad')) });
  }

  if (path === '/shares' && method === 'POST') {
    const r = await shares.mint(body.pad, { ttl: body.ttl, label: body.label });
    return r.ok ? ok(res, r) : bad(res, r.error);
  }

  if ((m = /^\/shares\/([^/]+)$/.exec(path)) && method === 'DELETE') {
    const r = await shares.revoke(decodeURIComponent(m[1]), url.searchParams.get('pad'));
    return r.ok ? ok(res) : bad(res, r.error, 404);
  }

  // --- home assistant reads (for the entity picker) -----------------------
  if (path === '/ha/entities' && method === 'GET') {
    if (!ha.configured()) return bad(res, ha.NOT_CONFIGURED, 503);
    try {
      const all = await ha.states();
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const list = (all || [])
        .map((s) => ({
          entity_id: s.entity_id,
          name: s.attributes?.friendly_name || s.entity_id,
          domain: s.entity_id.split('.')[0],
          state: s.state,
        }))
        .filter((e) => !q || e.entity_id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      return ok(res, { entities: list.slice(0, 500), total: list.length });
    } catch (err) {
      return bad(res, err.message, 502);
    }
  }

  return notFound(res);
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api')) {
    try {
      return await routeApi(req, res, url);
    } catch (err) {
      return bad(res, err.message, 500);
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return send(res, 200, 'text/html; charset=utf-8', UI);
  }

  return notFound(res);
}
