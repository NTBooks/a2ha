// Behavioural spec, ported in spirit from Fanad's test/speeddial.test.js.
//
// Everything here runs offline against a temp DATA_DIR with a stubbed fetch, so
// it needs no Home Assistant and no network. The cases are chosen to pin the
// invariants that make a share link safe to text to someone -- if one of these
// breaks, the link is no longer honest about what it can reach.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'a2ha-test-'));
process.env.DATA_DIR = dir;
process.env.HA_BASE_URL = 'http://ha.test';
process.env.HA_TOKEN = 'test-token';
delete process.env.PUBLIC_BASE_URL;
delete process.env.AGENT_ID;

const { write } = await import('../src/store.js');
const pads = await import('../src/pads.js');
const shares = await import('../src/shares.js');
const ha = await import('../src/ha.js');

process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// --- fetch stub --------------------------------------------------------------
let sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ response: { speech: { plain: { speech: 'ok' } } } }),
  };
};

beforeEach(async () => {
  sent = [];
  write('pads', { pads: [] });
  write('shares', { shares: [] });
  write('state', { toggles: {} });
});

async function seedPad() {
  await pads.upsertPad('guest', { title: 'Guest room' });
  await pads.setSlot('guest', 1, {
    label: 'Porch light',
    on: { type: 'service', service: 'light.turn_on', target: { entity_id: 'light.porch' } },
    off: { type: 'service', service: 'light.turn_off', target: { entity_id: 'light.porch' } },
  });
  await pads.setSlot('guest', 2, { label: 'Movie night', on: { type: 'assist', text: 'start movie night' } });
}

// -----------------------------------------------------------------------------

describe('share tokens', () => {
  test('the raw token is never persisted -- only its hash', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 7 });
    const { readFileSync } = await import('node:fs');
    const onDisk = readFileSync(join(dir, 'shares.json'), 'utf8');
    assert.ok(r.token.startsWith('a2h1_'));
    assert.equal(onDisk.includes(r.token), false, 'raw token leaked into shares.json');
    assert.ok(onDisk.includes('tokenHash'));
  });

  test('a token of the wrong species is refused before it costs a hash', () => {
    assert.equal(shares.resolve('fsd1_someoneelsestoken'), null);
    assert.equal(shares.resolve(''), null);
    assert.equal(shares.resolve(null), null);
  });

  test('an expired link stops resolving', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 1 });
    assert.ok(shares.resolve(r.token, Date.now()));
    assert.equal(shares.resolve(r.token, r.expiresAt + 1), null);
  });

  test('ttl 0 means never expires, and revoke is its off switch', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 0 });
    assert.equal(r.expiresAt, null);
    // Still live a decade out.
    assert.ok(shares.resolve(r.token, Date.now() + 3650 * 86400000));
    await shares.revoke(r.id, 'guest');
    assert.equal(shares.resolve(r.token), null);
  });

  test('revoking keeps the row, so the audit trail survives', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 7, label: 'dog sitter' });
    await shares.revoke(r.id, 'guest');
    const rows = shares.list('guest');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, false);
    assert.ok(rows[0].revokedAt);
    assert.equal(rows[0].label, 'dog sitter');
  });

  test('a revoke scoped to one pad cannot kill another pad link', async () => {
    await seedPad();
    await pads.upsertPad('kids', { title: 'Kids' });
    const mine = await shares.mint('guest', { ttl: 7 });
    const r = await shares.revoke(mine.id, 'kids');
    assert.equal(r.ok, false);
    assert.ok(shares.resolve(mine.token), 'link was revoked from the wrong pad');
  });

  test('the owner listing never exposes a token hash', async () => {
    await seedPad();
    await shares.mint('guest', { ttl: 7 });
    for (const row of shares.list('guest')) {
      assert.equal('tokenHash' in row, false);
    }
  });

  test('deleting a pad snapshots it first', async () => {
    await seedPad();
    const r = await pads.deletePad('guest');
    assert.ok(r.backup, 'no backup path returned');
    const { readFileSync } = await import('node:fs');
    const snap = JSON.parse(readFileSync(r.backup, 'utf8'));
    assert.equal(snap.body.pads[0].name, 'guest');
    assert.equal(snap.body.pads[0].slots.length, 2);
  });

  test('deleting a pad revokes its links rather than leaving them dangling', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 0 });
    await pads.deletePad('guest');
    assert.equal(shares.resolve(r.token), null);
  });

  test('an unparseable ttl falls back to the default, never to immortal', () => {
    assert.equal(shares.parseTtl('banana'), shares.DEFAULT_TTL_DAYS);
    assert.equal(shares.parseTtl(undefined), shares.DEFAULT_TTL_DAYS);
    assert.equal(shares.parseTtl(-5), shares.DEFAULT_TTL_DAYS);
    assert.equal(shares.parseTtl(0), 0);
    assert.equal(shares.parseTtl('never'), 0);
    assert.equal(shares.parseTtl('2w'), 14);
  });

  test('without a public base URL we hand back a path, not a guessed host', async () => {
    await seedPad();
    const r = await shares.mint('guest', { ttl: 7 });
    assert.equal(r.url, null);
    assert.ok(r.path.startsWith('/r/a2h1_'));
  });

  test('the link base is derived from AGENT_ID when present', async () => {
    await seedPad();
    process.env.AGENT_ID = 'abc123';
    try {
      const r = await shares.mint('guest', { ttl: 7 });
      assert.equal(r.url, `https://abc123.agents.pinata.cloud/pad${r.path}`);
    } finally {
      delete process.env.AGENT_ID;
    }
  });
});

describe('what a guest can learn', () => {
  test('the guest view carries only a number and a label', async () => {
    await seedPad();
    const view = pads.guestView('guest');
    assert.deepEqual(view.slots, [
      { slot: 1, name: 'Porch light' },
      { slot: 2, name: 'Movie night' },
    ]);
    // Nothing about the action, and nothing about on/off state.
    const serialised = JSON.stringify(view);
    for (const secret of ['light.porch', 'turn_on', 'turn_off', 'start movie night']) {
      assert.equal(serialised.includes(secret), false, `guest view leaked ${secret}`);
    }
  });

  test('toggle state is tracked but never exposed to the guest', async () => {
    await seedPad();
    await pads.setOn('guest', 1, true);
    assert.equal(pads.isOn('guest', 1), true);
    assert.equal(JSON.stringify(pads.guestView('guest')).includes('true'), false);
  });

  test('an unlabelled button falls back to something human, not an entity id', async () => {
    await pads.upsertPad('guest');
    await pads.setSlot('guest', 3, {
      on: { type: 'service', service: 'scene.turn_on', target: { entity_id: 'scene.movie_night' } },
    });
    const name = pads.guestView('guest').slots[0].name;
    assert.equal(name.includes('scene.movie_night'), false);
  });
});

describe('slot validation', () => {
  test('a button must carry one of the two known action shapes', async () => {
    await pads.upsertPad('guest');
    const r = await pads.setSlot('guest', 1, { on: { type: 'evil', cmd: 'rm -rf /' } });
    assert.equal(r.ok, false);
    assert.equal(pads.getPad('guest').slots.length, 0);
  });

  test('"light.turn_on" is accepted as shorthand and stored split', async () => {
    await pads.upsertPad('guest');
    await pads.setSlot('guest', 1, { on: { type: 'service', service: 'light.turn_on', target: { entity_id: 'light.a' } } });
    const slot = pads.getPad('guest').slots[0];
    assert.equal(slot.on.domain, 'light');
    assert.equal(slot.on.service, 'turn_on');
  });

  test('a domain or service with shell-ish characters is rejected', async () => {
    await pads.upsertPad('guest');
    for (const bad of ['light/../admin.turn_on', 'light.turn on', 'LIGHT.TURN_ON']) {
      const r = await pads.setSlot('guest', 1, { on: { type: 'service', service: bad, target: {} } });
      assert.equal(r.ok, false, `accepted ${bad}`);
    }
  });

  test('slots outside 0-9 are refused', async () => {
    await pads.upsertPad('guest');
    for (const n of [-1, 10, 1.5, 'x']) {
      const r = await pads.setSlot('guest', n, { on: { type: 'assist', text: 'hi' } });
      assert.equal(r.ok, false, `accepted slot ${n}`);
    }
  });

  test('a slot cannot be added to a pad that does not exist', async () => {
    const r = await pads.setSlot('ghost', 1, { on: { type: 'assist', text: 'hi' } });
    assert.equal(r.ok, false);
  });

  test('saving the same slot twice replaces rather than duplicates', async () => {
    await pads.upsertPad('guest');
    await pads.setSlot('guest', 1, { label: 'First', on: { type: 'assist', text: 'a' } });
    await pads.setSlot('guest', 1, { label: 'Second', on: { type: 'assist', text: 'b' } });
    const rows = pads.getPad('guest').slots.filter((s) => s.slot === 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Second');
  });
});

describe('live state', () => {
  test('a service slot reports the entity\'s real state, an assist slot reports nothing', async () => {
    await seedPad();
    const pad = pads.getPad('guest');
    const withEntity = pad.slots.find((x) => x.slot === 1);
    const withoutEntity = pad.slots.find((x) => x.slot === 2);
    assert.equal(pads.slotEntity(withEntity), 'light.porch');
    assert.equal(pads.slotEntity(withoutEntity), null);
  });

  test('states we should not interpret become null rather than a guess', () => {
    assert.equal(pads.liveIsOn('on'), true);
    assert.equal(pads.liveIsOn('off'), false);
    // The point of reading back is honesty; an entity that cannot answer must
    // not be rendered as "off", which is what a boolean cast would do.
    assert.equal(pads.liveIsOn('unavailable'), null);
    assert.equal(pads.liveIsOn('unknown'), null);
    assert.equal(pads.liveIsOn(null), null);
  });

  test('reading state does not touch the house beyond the entities on the pad', async () => {
    await seedPad();
    const pad = pads.getPad('guest');
    const entities = pad.slots.map(pads.slotEntity).filter(Boolean);
    await ha.statesOf(entities);
    // One request per distinct entity, and nothing resembling a full dump.
    assert.equal(sent.length, entities.length);
    for (const req of sent) {
      assert.ok(req.url.includes('/api/states/'), `unexpected call: ${req.url}`);
      assert.equal(req.url.endsWith('/api/states'), false, 'read the whole state machine');
    }
  });

  test('a dead entity does not take the rest of the pad down with it', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('light.broken')) throw new Error('boom');
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'on' }) };
    };
    try {
      const r = await ha.statesOf(['light.porch', 'light.broken']);
      assert.equal(r['light.porch'], 'on');
      assert.equal(r['light.broken'], null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the guest view still carries no state at all', async () => {
    await seedPad();
    await pads.setOn('guest', 1, true);
    const serialised = JSON.stringify(pads.guestView('guest'));
    // State reaches the browser through a separate request, never the HTML, so
    // a link preview or a crawler learns nothing about the house.
    assert.equal(serialised.includes('true'), false);
    assert.equal(serialised.includes('"on"'), false);
    assert.deepEqual(pads.guestView('guest').slots, [
      { slot: 1, name: 'Porch light' },
      { slot: 2, name: 'Movie night' },
    ]);
  });
});

describe('firing', () => {
  test('a service button sends exactly the stored call', async () => {
    await seedPad();
    const slot = pads.getPad('guest').slots.find((s) => s.slot === 1);
    await ha.runAction(slot.on);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://ha.test/api/services/light/turn_on');
    assert.deepEqual(sent[0].body, { entity_id: 'light.porch' });
  });

  test('an assist button sends the owner phrase, sanitised', async () => {
    await pads.upsertPad('guest');
    await pads.setSlot('guest', 1, { on: { type: 'assist', text: 'turn on  <the> porch' } });
    await ha.runAction(pads.getPad('guest').slots[0].on);
    assert.equal(sent[0].url, 'http://ha.test/api/conversation/process');
    assert.equal(sent[0].body.text, 'turn on the porch');
  });

  test('an unknown action shape reaches Home Assistant not at all', async () => {
    const r = await ha.runAction({ type: 'shell', cmd: 'whoami' });
    assert.equal(r.ok, false);
    assert.equal(sent.length, 0);
  });

  test('sanitize strips control characters and bidi overrides', () => {
    const nasty = `turn  on‮ the​ porch`;
    assert.equal(ha.sanitize(nasty), 'turn on the porch');
  });

  test('sanitize caps length so a pasted essay cannot reach Assist', () => {
    assert.equal(ha.sanitize('x'.repeat(5000)).length, 600);
  });
});
