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

  // Already running with the flag, from NODE_OPTIONS or an earlier re-exec.
  const active = process.execArgv.includes('--use-env-proxy')
    || (process.env.NODE_OPTIONS || '').includes('--use-env-proxy');
  if (active) return;

  const r = spawnSync(
    process.execPath,
    ['--use-env-proxy', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --use-env-proxy`.trim() } },
  );
  process.exit(r.status ?? 1);
}

export const proxyInUse = () => existsSync(MARKER);
