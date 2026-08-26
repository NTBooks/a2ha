// proxy.mjs -- point the CLIs at the tailnet.
//
// When Tailscale is up, start.sh runs a TCP forwarder (bin/tsforward.mjs) that
// makes Home Assistant reachable at a loopback address, and records that
// address in a marker file. All this module does is read the marker, because
// the agent runs the CLIs from its own shell, which does not inherit start.sh's
// environment.
//
// This used to negotiate Node's HTTP_PROXY support instead, which was a
// mistake: that support is recent, a real deployment turned out to run a Node
// without it ("node: bad option: --use-env-proxy"), and the failure took every
// command down rather than degrading. Forwarding at the TCP layer asks nothing
// of Node at all -- no flags, no version floor, and it works the same for
// fetch, WebSocket and curl.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MARKER = join(dirname(fileURLToPath(import.meta.url)), '..', '.tailscale-env');

export function applyProxy() {
  if (!existsSync(MARKER)) return;
  try {
    for (const line of readFileSync(MARKER, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* no marker, no tailnet, nothing to do */ }
}

// The address to actually talk to. HA_EFFECTIVE_URL is the loopback end of the
// tailnet forwarder; HA_BASE_URL is whatever the owner configured.
export function haBaseUrl() {
  applyProxy();
  const url = process.env.HA_EFFECTIVE_URL || process.env.HA_BASE_URL || '';
  return String(url).trim().replace(/\/+$/, '');
}

export const proxyInUse = () => {
  applyProxy();
  return !!process.env.HA_EFFECTIVE_URL;
};
