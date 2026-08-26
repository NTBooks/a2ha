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
adminServer.listen(ADMIN_PORT, HOST, () => {
  console.log(`[a2ha] config app on ${HOST}:${ADMIN_PORT}`);
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
