// pads.js -- the pad model.
//
// A pad is a named set of numbered buttons. Slot 0 is reserved (in Fanad it
// meant "show my pad"); the editor offers 1-9 and the guest page renders
// whatever exists in that range.
//
// The single most important function in this file is padSlotView(). It decides
// what a guest is allowed to learn from a pad, and the answer is: the number
// and the label. Not the entity, not the service, not whether the light is
// currently on. See the note on toggle state below.

import { read, update, norm, backup } from './store.js';

export const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const isToggle = (slot) => !!(slot && slot.off && typeof slot.off === 'object');

export const slotName = (slot) => {
  const label = String(slot?.label ?? '').trim();
  if (label) return label;
  // Fall back to something human rather than showing a guest an entity id.
  const a = slot?.on;
  if (a?.type === 'assist') return String(a.text ?? '').slice(0, 40) || `Button ${slot.slot}`;
  if (a?.type === 'service') return `${a.domain}.${a.service}`.slice(0, 40);
  return `Button ${slot?.slot ?? ''}`.trim();
};

// Everything a guest ever sees about a button.
export const padSlotView = (slot) => ({ slot: slot.slot, name: slotName(slot) });

// The entity a slot's state can be read from, if any. A slot that fires a
// spoken phrase has no entity and no knowable state -- that is a real gap, not
// something to paper over with a guess.
export function slotEntity(slot) {
  const a = slot?.on;
  if (a?.type !== 'service') return null;
  const id = a.target?.entity_id;
  if (typeof id === 'string') return id;
  if (Array.isArray(id) && typeof id[0] === 'string') return id[0];
  return null;
}

export function getPad(name) {
  const n = norm(name);
  return (read('pads').pads || []).find((p) => p.name === n) || null;
}

export function listPads() {
  return (read('pads').pads || []).map((p) => ({
    name: p.name,
    title: p.title || p.name,
    slots: (p.slots || []).length,
  }));
}

// The view the guest server renders from: sorted, deduped, and stripped.
export function guestView(padName) {
  const pad = getPad(padName);
  if (!pad) return null;
  const seen = new Set();
  const slots = (pad.slots || [])
    .filter((s) => Number.isInteger(s?.slot) && s.slot >= 0 && s.slot <= 9)
    .filter((s) => s.on && typeof s.on === 'object')
    .filter((s) => (seen.has(s.slot) ? false : (seen.add(s.slot), true)))
    .sort((a, b) => a.slot - b.slot)
    .map(padSlotView);
  return { title: pad.title || 'Remote control', slots };
}

export async function upsertPad(name, { title } = {}) {
  const n = norm(name);
  if (!n) return { ok: false, error: 'A pad needs a name (letters, numbers and dashes).' };
  await update('pads', (d) => {
    const pads = d.pads || [];
    const i = pads.findIndex((p) => p.name === n);
    if (i === -1) return { pads: [...pads, { name: n, title: title || n, slots: [] }] };
    const next = [...pads];
    next[i] = { ...next[i], ...(title != null ? { title } : {}) };
    return { pads: next };
  });
  return { ok: true, pad: getPad(n) };
}

export async function deletePad(name) {
  const n = norm(name);
  if (!getPad(n)) return { ok: false, error: `No pad called "${n}".` };
  // Buttons take real effort to wire up and there is no other copy of them.
  const saved = backup('pads', `delete pad ${n}`);
  let hit = false;
  await update('pads', (d) => {
    const pads = d.pads || [];
    hit = pads.some((p) => p.name === n);
    return { pads: pads.filter((p) => p.name !== n) };
  });
  // Shares outlive their pad otherwise, and a link to a deleted pad would sit
  // there resolving to nothing. Revoke them rather than leaving them dangling.
  if (hit) {
    await update('shares', (s) => ({
      shares: (s.shares || []).map((row) =>
        row.pad === n && !row.revokedAt ? { ...row, revokedAt: Date.now() } : row),
    }));
  }
  return hit ? { ok: true, backup: saved } : { ok: false, error: `No pad called "${n}".` };
}

// Validates an action into exactly one of the two shapes runAction() accepts.
// Anything else is rejected here, at write time, so the guest fire path never
// has to reason about a malformed button.
export function normalizeAction(a) {
  if (a == null) return null;
  if (typeof a === 'string') {
    const text = a.trim();
    return text ? { type: 'assist', text } : null;
  }
  if (typeof a !== 'object') return null;

  if (a.type === 'assist' || (!a.type && a.text)) {
    const text = String(a.text ?? '').trim();
    return text ? { type: 'assist', text } : null;
  }

  // Accept both {domain, service} and the friendlier "light.turn_on".
  let domain = a.domain;
  let service = a.service;
  if (!domain && typeof a.service === 'string' && a.service.includes('.')) {
    [domain, service] = a.service.split('.', 2);
  }
  if (!domain || !service) return null;
  if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) return null;

  const out = { type: 'service', domain, service };
  if (a.target && typeof a.target === 'object') out.target = a.target;
  if (a.data && typeof a.data === 'object') out.data = a.data;
  return out;
}

export async function setSlot(padName, slotNo, { label, on, off } = {}) {
  const n = norm(padName);
  if (!getPad(n)) return { ok: false, error: `No pad called "${n}" - create it first.` };
  const slot = Number(slotNo);
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
    return { ok: false, error: 'Slot must be a digit from 0 to 9 (the editor uses 1-9).' };
  }

  const onAction = normalizeAction(on);
  if (!onAction) {
    return {
      ok: false,
      error: 'A button needs an action: either {"type":"service","service":"light.turn_on","target":{"entity_id":"light.porch"}} or {"type":"assist","text":"turn on the porch light"}.',
    };
  }
  const offAction = off == null ? null : normalizeAction(off);
  if (off != null && !offAction) return { ok: false, error: 'The off action is not a valid action.' };

  const row = {
    slot,
    label: String(label ?? '').slice(0, 60),
    on: onAction,
    ...(offAction ? { off: offAction } : {}),
  };

  await update('pads', (d) => ({
    pads: (d.pads || []).map((p) => {
      if (p.name !== n) return p;
      const slots = (p.slots || []).filter((s) => s.slot !== slot);
      return { ...p, slots: [...slots, row].sort((a, b) => a.slot - b.slot) };
    }),
  }));
  return { ok: true, slot: row };
}

export async function clearSlot(padName, slotNo) {
  const n = norm(padName);
  const slot = Number(slotNo);
  let hit = false;
  await update('pads', (d) => ({
    pads: (d.pads || []).map((p) => {
      if (p.name !== n) return p;
      hit = (p.slots || []).some((s) => s.slot === slot);
      return { ...p, slots: (p.slots || []).filter((s) => s.slot !== slot) };
    }),
  }));
  return hit ? { ok: true } : { ok: false, error: 'That slot was already empty.' };
}

// --- toggle state ------------------------------------------------------------
// This is a record of what we last SENT, not what the house is actually doing.
// We never read HA back, so it must not be shown to anyone: a stale "on" badge
// is worse than no badge. It exists purely to decide which of the two actions
// the next tap should fire.

export const toggleKey = (padName, slot) => `${norm(padName)}:${slot}`;

export function isOn(padName, slot) {
  return !!(read('state').toggles || {})[toggleKey(padName, slot)];
}

// True/false from Home Assistant itself, or null when unknowable. Preferred
// over isOn() at fire time: what we last sent drifts the moment anyone uses a
// wall switch, and a toggle that has drifted sends the wrong half of the pair.
export function liveIsOn(haState) {
  if (haState == null) return null;
  if (['on', 'open', 'playing', 'home', 'unlocked', 'heat', 'cool', 'auto'].includes(haState)) return true;
  if (['off', 'closed', 'idle', 'paused', 'not_home', 'locked', 'standby'].includes(haState)) return false;
  return null;  // unavailable, unknown, or a state we should not interpret
}

export function setOn(padName, slot, value) {
  return update('state', (s) => ({
    toggles: { ...(s.toggles || {}), [toggleKey(padName, slot)]: !!value },
  }));
}
