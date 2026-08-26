// proxy.mjs -- make the CLIs reach the tailnet.
//
// Two problems to solve, both invisible until they bite:
//
// 1. The agent runs `node ha.mjs` from its own shell, which does not inherit
//    the environment start.sh set up. So we read the marker file start.sh
//    leaves behind instead of relying on inheritance.
//
// 2. Node's fetch ignores HTTP_PROXY unless started with --use-env-proxy, and
//    that is a startup flag -- setting it from inside a running process is too
//    late. So if a proxy is configured and we are not already running with the
//    flag, re-exec ourselves once with it.
//
// When Tailscale is not in use there is no marker file, nothing is set, and
// nothing re-execs.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKER = join(dirname(fileURLToPath(import.meta.url)), '..', '.tailscale-env');

export function applyProxy() {
  if (!existsSync(MARKER)) return;

  let loaded = false;
  try {
    for (const line of readFileSync(MARKER, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
      loaded = true;
    }
  } catch { return; }

  if (!loaded || !process.env.HTTP_PROXY) return;

  // Already re-exec'd, or the flag was passed directly.
  if (process.execArgv.includes('--use-env-proxy')) return;

  // The flag must go in argv, NOT in NODE_OPTIONS. Some Node builds reject it
  // there outright ("--use-env-proxy is not allowed in NODE_OPTIONS", exit 9),
  // which would break every command instead of just the proxying. Scrub it from
  // an inherited NODE_OPTIONS for the same reason.
  const env = { ...process.env };
  if (env.NODE_OPTIONS?.includes('--use-env-proxy')) {
    env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--use-env-proxy/g, '').replace(/\s+/g, ' ').trim();
    if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  }

  const probe = spawnSync(process.execPath, ['--use-env-proxy', '-e', ''], { stdio: 'ignore', env });
  if (probe.status !== 0) {
    console.error('This Node build does not support --use-env-proxy, so it cannot reach');
    console.error('Home Assistant over the tailnet. Point HA_BASE_URL at a directly');
    console.error('reachable URL, or remove TS_AUTHKEY and restart the agent.');
    process.exit(3);
  }

  const r = spawnSync(
    process.execPath,
    ['--use-env-proxy', ...process.argv.slice(1)],
    { stdio: 'inherit', env },
  );
  process.exit(r.status ?? 1);
}

export const proxyInUse = () => existsSync(MARKER);
