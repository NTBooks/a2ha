// ha.js -- Home Assistant client.
//
// Ported from Fanad's server/services/homeassistant.js. Two differences:
//   - config comes from env (Pinata encrypts secrets for us) instead of an
//     AES-GCM-encrypted SQLite row, so the whole KEK subsystem is gone;
//   - callService() is a first-class citizen. Fanad's speed dial only ever
//     spoke to Assist; here a pad button normally fires a resolved service call
//     and Assist is the fallback.

const TIMEOUT = { service: 5000, status: 5000, converse: 15000 };

const cleanBaseUrl = (v) => String(v ?? '').trim().replace(/\/+$/, '');

export function config() {
  return {
    baseUrl: cleanBaseUrl(process.env.HA_BASE_URL),
    token: String(process.env.HA_TOKEN ?? '').trim(),
    agentId: String(process.env.HA_AGENT_ID ?? '').trim(),
  };
}

export const configured = (cfg = config()) => !!(cfg.baseUrl && cfg.token);

export const NOT_CONFIGURED =
  'Home Assistant is not connected yet - set HA_BASE_URL and HA_TOKEN on the agent.';

export async function haFetch(path, { method = 'GET', body, timeout = TIMEOUT.service } = {}) {
  const cfg = config();
  if (!configured(cfg)) throw new Error(NOT_CONFIGURED);
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 160);
    const err = new Error(`HA ${method} ${path} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export const states = () => haFetch('/api/states');
export const state = (entityId) => haFetch(`/api/states/${encodeURIComponent(entityId)}`);
export const serviceCatalog = () => haFetch('/api/services');
export const errorLog = () => haFetch('/api/error_log');

export const renderTemplate = (template) =>
  haFetch('/api/template', { method: 'POST', body: { template } });

export function callService(domain, service, { target, data } = {}) {
  const body = { ...(data || {}), ...(target || {}) };
  return haFetch(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: 'POST',
    body,
  });
}

export async function converse(text) {
  const cfg = config();
  const body = { text, language: 'en', ...(cfg.agentId ? { agent_id: cfg.agentId } : {}) };
  const r = await haFetch('/api/conversation/process', {
    method: 'POST',
    body,
    // Assist agents can be LLM-backed inside HA, so this one gets a long leash.
    timeout: TIMEOUT.converse,
  });
  return r?.response?.speech?.plain?.speech || '(no response)';
}

export async function ping() {
  const r = await haFetch('/api/', { timeout: TIMEOUT.status });
  return { ok: true, message: r?.message };
}

// --- firing a pad action -----------------------------------------------------
// This is the whole guest-facing execution surface. It accepts only the two
// shapes the admin API is able to store; anything else is refused rather than
// coerced, because the point of the pad is that a guest cannot reach anything
// the owner did not explicitly put there.

export async function runAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, text: 'That button is not set up.' };
  if (!configured()) return { ok: false, text: NOT_CONFIGURED };
  try {
    if (action.type === 'service') {
      if (!action.domain || !action.service) return { ok: false, text: 'That button is not set up.' };
      await callService(action.domain, action.service, { target: action.target, data: action.data });
      return { ok: true, speech: 'Done.' };
    }
    if (action.type === 'assist') {
      const text = String(action.text ?? '').trim();
      if (!text) return { ok: false, text: 'That button is not set up.' };
      return { ok: true, speech: await converse(sanitize(text)) };
    }
    return { ok: false, text: 'That button is not set up.' };
  } catch (err) {
    return { ok: false, text: `Couldn't reach the house: ${err.message}` };
  }
}

// Ported from Fanad's sanitizeForLlm. The string is owner-authored, not guest
// input, so this is belt-and-braces - it strips control characters, bidi
// overrides and bracket noise that could confuse an LLM-backed Assist agent.
// Built with RegExp() so the source file stays plain ASCII.
const CONTROLS = new RegExp('[\u0000-\u001f\u007f-\u009f]', 'g');
const INVISIBLE = new RegExp('[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', 'g');
const BRACKETS = /[<>{}[\]`|\~^]/g;

export function sanitize(s) {
  return String(s ?? '')
    .replace(CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .replace(BRACKETS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}
