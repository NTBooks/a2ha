#!/usr/bin/env bash
# start.sh -- bring up Tailscale (if configured), then the pad servers.
#
# Runs from scripts.start, detached. Output lands in /tmp/user-start.log.
#
# Tailscale runs in USERSPACE NETWORKING mode. A sandboxed container has no
# /dev/net/tun and no CAP_NET_ADMIN, so a normal tailscaled cannot work here.
# Userspace mode needs neither: tailscaled keeps the network stack in-process
# and exposes an outbound HTTP proxy, which Node's fetch can be pointed at.
#
# That proxy also resolves names on the tailnet side, so MagicDNS names like
# http://homeassistant.tailfoo.ts.net:8123 work without any DNS config here.
#
# The node is registered EPHEMERAL: its state lives in /tmp and is thrown away
# on restart, and Tailscale reaps the dead node by itself. That is deliberate --
# a persistent state file would have to live in the workspace, which is a git
# repo that gets snapshotted, and node keys do not belong in git.

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS_PREFIX="${TS_PREFIX:-$WORKSPACE/.tailscale}"
PROXY_PORT="${TS_PROXY_PORT:-1055}"

start_tailscale() {
  if [ -z "${TS_AUTHKEY:-}" ]; then
    echo "[start] TS_AUTHKEY not set - skipping Tailscale, using HA_BASE_URL directly."
    return 1
  fi
  if [ ! -x "$TS_PREFIX/tailscaled" ]; then
    echo "[start] TS_AUTHKEY is set but Tailscale is not installed at $TS_PREFIX."
    echo "[start] Re-run the build (push to the repo or redeploy) to install it."
    return 1
  fi

  echo "[start] starting tailscaled (userspace networking, http proxy :$PROXY_PORT)"
  "$TS_PREFIX/tailscaled" \
    --tun=userspace-networking \
    --outbound-http-proxy-listen="localhost:$PROXY_PORT" \
    --socks5-server="localhost:$((PROXY_PORT + 1))" \
    --state="${TS_STATE_DIR:-/tmp/tailscale}/tailscaled.state" \
    --socket="/tmp/tailscaled.sock" \
    >/tmp/tailscaled.log 2>&1 &

  # tailscaled needs a moment before the socket accepts commands.
  for _ in $(seq 1 20); do
    [ -S /tmp/tailscaled.sock ] && break
    sleep 0.5
  done

  echo "[start] joining tailnet as ${TS_HOSTNAME:-a2ha}"
  if ! "$TS_PREFIX/tailscale" --socket=/tmp/tailscaled.sock up \
      --authkey="$TS_AUTHKEY" \
      --hostname="${TS_HOSTNAME:-a2ha}" \
      --accept-routes \
      --timeout=60s; then
    echo "[start] ERROR: tailscale up failed. See /tmp/tailscaled.log"
    echo "[start] Common causes: the auth key expired, was single-use and is"
    echo "[start] already spent, or is not marked reusable+ephemeral."
    return 1
  fi

  "$TS_PREFIX/tailscale" --socket=/tmp/tailscaled.sock status --peers=false || true
  return 0
}

mkdir -p "${TS_STATE_DIR:-/tmp/tailscale}"

if start_tailscale; then
  # Route outbound HTTP through the tailnet. NO_PROXY keeps loopback direct so
  # the CLIs can still reach the config server on 127.0.0.1.
  export HTTP_PROXY="http://localhost:$PROXY_PORT"
  export HTTPS_PROXY="http://localhost:$PROXY_PORT"
  export NO_PROXY="localhost,127.0.0.1,::1"
  export TS_PROXY_URL="$HTTP_PROXY"
  # Node's fetch ignores HTTP_PROXY unless asked. The flag must be passed as a
  # real argument: some Node builds refuse it inside NODE_OPTIONS ("--use-env-proxy
  # is not allowed in NODE_OPTIONS", exit 9), which would take the pad servers
  # down along with the proxying.
  if node --use-env-proxy -e '' 2>/dev/null; then
    NODE_PROXY_FLAG="--use-env-proxy"
    echo "[start] outbound HTTP routed through the tailnet"
  else
    NODE_PROXY_FLAG=""
    echo "[start] WARNING: this Node does not support --use-env-proxy, so it"
    echo "[start] cannot reach Home Assistant over the tailnet. Point HA_BASE_URL"
    echo "[start] at a directly reachable URL, or unset TS_AUTHKEY."
  fi

  # Leave a marker so `ha` and `pads` pick the proxy up in the agent's own
  # shells, which do not inherit this script's environment.
  cat > "$WORKSPACE/.tailscale-env" <<EOF
HTTP_PROXY=$HTTP_PROXY
HTTPS_PROXY=$HTTPS_PROXY
NO_PROXY=$NO_PROXY
EOF
else
  NODE_PROXY_FLAG=""
  rm -f "$WORKSPACE/.tailscale-env"
fi

echo "[start] starting pad servers"
cd "$WORKSPACE/projects/speeddial"
# shellcheck disable=SC2086 -- deliberately unquoted so an empty flag vanishes.
exec node $NODE_PROXY_FLAG src/index.js
