// index.js -- boot both listeners.
//
// Two ports, because Pinata's gateway strips the route prefix before forwarding.
// Two routes onto one port would arrive here indistinguishable from each other,
// and "is this the public pad or the protected admin app?" is not a question we
// ever want to answer by guessing.
//
//   4321  /pad    public   guest pads
//   4322  /admin  protected  config app + API (also the agent's own loopback API)

import { createServer } from 'node:http';
import { handler as guest } from './guest.js';
import { handler as admin } from './admin.js';
import { DATA_DIR } from './store.js';
import { configured, config } from './ha.js';

const GUEST_PORT = Number(process.env.GUEST_PORT || 4321);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 4322);
const HOST = process.env.HOST || '0.0.0.0';

// The admin API can read every pad, mint share links and fire devices. On
// Pinata the gateway stands in front of it and demands a token, so binding
// broadly there is fine and necessary. Off Pinata there is no gateway, and a
// broadly-bound admin port is an unauthenticated remote control for someone
// else's house.
//
// So: default to loopback when nothing is protecting it. An operator who really
// wants it exposed has to say so, and set a token.
const ON_PINATA = !!String(process.env.AGENT_ID ?? '').trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN ?? '').trim();
const ADMIN_HOST_ENV = String(process.env.ADMIN_HOST ?? '').trim();

let ADMIN_HOST;
if (ADMIN_HOST_ENV) ADMIN_HOST = ADMIN_HOST_ENV;
else if (ON_PINATA || ADMIN_TOKEN) ADMIN_HOST = HOST;
else ADMIN_HOST = '127.0.0.1';

function guard(fn, label) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[${label}] ${req.method} ${req.url} ->`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Something went wrong.' }));
      }
    }
  };
}

const guestServer = createServer(guard(guest, 'guest'));
const adminServer = createServer(guard(admin, 'admin'));

guestServer.listen(GUEST_PORT, HOST, () => {
  console.log(`[a2ha] guest pads on ${HOST}:${GUEST_PORT}`);
});
adminServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log(`[a2ha] config app on ${ADMIN_HOST}:${ADMIN_PORT}`);
  if (ADMIN_HOST === '127.0.0.1' && !ON_PINATA) {
    console.log('[a2ha] admin is loopback-only (nothing is authenticating it).');
    console.log('[a2ha] To reach it from elsewhere: set ADMIN_TOKEN, or put a proxy');
    console.log('[a2ha] in front and set ADMIN_HOST explicitly.');
  }
  if (ADMIN_HOST !== '127.0.0.1' && !ON_PINATA && !ADMIN_TOKEN) {
    console.warn('');
    console.warn('[a2ha] *** WARNING: the admin API is bound to a non-loopback address');
    console.warn('[a2ha] *** with no ADMIN_TOKEN and no gateway in front of it.');
    console.warn('[a2ha] *** Anyone who can reach it can mint guest links and fire');
    console.warn('[a2ha] *** your devices. Set ADMIN_TOKEN, or bind it to 127.0.0.1.');
    console.warn('');
  }
});

console.log(`[a2ha] data dir ${DATA_DIR}`);
if (configured()) {
  console.log(`[a2ha] home assistant ${config().baseUrl}`);
} else {
  // Not fatal. The pads still render; the buttons are just disabled until the
  // secrets land, which beats crash-looping a fresh agent.
  console.warn('[a2ha] HA_BASE_URL / HA_TOKEN not set - buttons will be disabled until they are.');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    guestServer.close();
    adminServer.close();
    process.exit(0);
  });
}
