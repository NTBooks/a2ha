// store.js — the only thing in this process that writes to workspace/data.
//
// Both the admin API and the agent (via bin/pads.mjs, which talks to the admin
// API over loopback) funnel their writes through here, so there is exactly one
// writer and no file-level races. Reads are cheap and always re-read from disk,
// because the agent may have edited a file by hand and we would rather be
// correct than fast.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> speeddial/ -> projects/ -> workspace/ -> workspace/data
export const DATA_DIR = process.env.DATA_DIR || join(here, '..', '..', '..', 'data');

const FILES = {
  pads: join(DATA_DIR, 'pads.json'),
  shares: join(DATA_DIR, 'shares.json'),
  state: join(DATA_DIR, 'state.json'),
};

const EMPTY = { pads: { pads: [] }, shares: { shares: [] }, state: { toggles: {} } };

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function read(which) {
  const path = FILES[which];
  if (!path) throw new Error(`unknown store: ${which}`);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(EMPTY[which]);
  } catch {
    // Missing or corrupt reads as empty. A pad file that fails to parse should
    // not take the guest server down — the pad just renders with no buttons.
    return structuredClone(EMPTY[which]);
  }
}

// Write to a sibling temp file then rename. rename(2) is atomic on the same
// filesystem, so a reader never sees a half-written pads.json.
export function write(which, value) {
  const path = FILES[which];
  if (!path) throw new Error(`unknown store: ${which}`);
  ensureDir();
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return value;
}

// Read-modify-write under a promise chain. Every mutation in the process queues
// here, so two concurrent admin requests can't clobber each other.
let chain = Promise.resolve();
export function update(which, fn) {
  const run = chain.then(() => {
    const next = fn(read(which));
    return write(which, next);
  });
  // Keep the chain alive even if one mutation throws.
  chain = run.catch(() => {});
  return run;
}

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// Snapshot a store before something destructive touches it. Deleting a pad
// throws away buttons someone spent time wiring up, and there is no other copy.
export const BACKUP_DIR = join(DATA_DIR, 'backups');

export function backup(which, reason) {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(BACKUP_DIR, `${which}.${at}.json`);
  writeFileSync(file, `${JSON.stringify({
    store: which, reason, savedAt: new Date().toISOString(), body: read(which),
  }, null, 2)}\n`, 'utf8');
  return file;
}
