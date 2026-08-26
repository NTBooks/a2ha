// shares.js -- guest link minting and resolution.
//
// Ported from Fanad's speeddial.js:366-398. The design is unchanged and the
// reasons are worth restating, because each one is load-bearing:
//
//   * The raw token exists only in the URL. We store sha256(token), so a leaked
//     shares.json cannot be turned back into working links.
//   * expiresAt === null means "never expires". Revocation is the security
//     story for those, which is why revoke is a soft flag and the row stays.
//   * The 'a2h1_' prefix makes tokens greppable and lets resolve() reject
//     anything of the wrong species before it spends a hash.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { read, update, norm } from './store.js';

export const SHARE_PREFIX = 'a2h1_';
export const TTL_PRESETS = [1, 7, 30];
export const DEFAULT_TTL_DAYS = 7;

const sha256 = (t) => createHash('sha256').update(String(t)).digest('hex');

export function parseTtl(input) {
  // 0, '0', 'never' -> never expires. Anything unrecognised falls back to the
  // default rather than silently minting an immortal link.
  if (input === 0 || input === '0' || /^never$/i.test(String(input ?? ''))) return 0;
  const m = /^(\d+)\s*([dwm])?$/i.exec(String(input ?? '').trim());
  if (m) {
    const n = Number(m[1]);
    const mult = { d: 1, w: 7, m: 30 }[(m[2] || 'd').toLowerCase()];
    if (n > 0 && n * mult <= 3650) return n * mult;
  }
  return DEFAULT_TTL_DAYS;
}

// Where guest links point. Hermes hands every agent an AGENT_ID, and the /pad
// route is declared in manifest.json, so the normal case needs no configuration
// at all. PUBLIC_BASE_URL is an override for custom domains.
export function publicBase() {
  const explicit = String(process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const agentId = String(process.env.AGENT_ID ?? '').trim();
  if (agentId) return `https://${agentId}.agents.pinata.cloud/pad`;
  return '';
}

export async function mint(padName, { ttl = DEFAULT_TTL_DAYS, label = '' } = {}) {
  const pad = norm(padName);
  if (!pad) return { ok: false, error: 'Which pad?' };
  const pads = read('pads').pads || [];
  if (!pads.some((p) => p.name === pad)) {
    return { ok: false, error: `No pad called "${pad}" yet - create it first.` };
  }

  const days = parseTtl(ttl);
  const now = Date.now();
  const token = SHARE_PREFIX + randomBytes(32).toString('base64url');
  const record = {
    id: randomBytes(8).toString('hex'),
    tokenHash: sha256(token),
    pad,
    label: String(label ?? '').slice(0, 120),
    createdAt: now,
    expiresAt: days === 0 ? null : now + days * 86400000,
    revokedAt: null,
  };

  await update('shares', (s) => ({ shares: [...(s.shares || []), record] }));

  const base = publicBase();
  const path = `/r/${token}`;
  return {
    ok: true,
    id: record.id,
    token,
    path,
    // Without PUBLIC_BASE_URL we hand back the path and let the caller say so,
    // rather than inventing a hostname the guest can't reach.
    url: base ? `${base}${path}` : null,
    expiresAt: record.expiresAt,
    ttlDays: days,
  };
}

// Resolve is called on every guest render AND every fire -- never cached, never
// trusted from the page. Expiry and revocation are therefore enforced live, so
// revoking a link kills it on the guest's very next tap.
export function resolve(token, now = Date.now()) {
  const t = String(token ?? '');
  if (!t.startsWith(SHARE_PREFIX)) return null;
  const want = sha256(t);
  const wantBuf = Buffer.from(want, 'hex');
  for (const s of read('shares').shares || []) {
    if (typeof s?.tokenHash !== 'string' || s.tokenHash.length !== want.length) continue;
    let match = false;
    try {
      match = timingSafeEqual(Buffer.from(s.tokenHash, 'hex'), wantBuf);
    } catch { match = false; }
    if (!match) continue;
    if (s.revokedAt) return null;
    if (s.expiresAt != null && s.expiresAt <= now) return null;
    return s;
  }
  return null;
}

export async function revoke(id, padName = null) {
  const pad = padName ? norm(padName) : null;
  let hit = false;
  await update('shares', (s) => ({
    shares: (s.shares || []).map((row) => {
      // Scope the revoke to the pad when we know it, so a stray id can't take
      // down another pad's link.
      if (row.id !== id || row.revokedAt) return row;
      if (pad && row.pad !== pad) return row;
      hit = true;
      return { ...row, revokedAt: Date.now() };
    }),
  }));
  return hit ? { ok: true } : { ok: false, error: 'No active link with that id.' };
}

// What the owner is allowed to see. Deliberately never includes tokenHash --
// there is no reason for it to leave this module.
export function list(padName = null, now = Date.now()) {
  const pad = padName ? norm(padName) : null;
  return (read('shares').shares || [])
    .filter((s) => (pad ? s.pad === pad : true))
    .map((s) => ({
      id: s.id,
      pad: s.pad,
      label: s.label || '',
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      active: !s.revokedAt && (s.expiresAt == null || s.expiresAt > now),
    }));
}
