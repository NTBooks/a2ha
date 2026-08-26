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
  # Make Home Assistant look like localhost by forwarding a loopback port
  # through tailscaled's SOCKS5 server. This is done at the TCP layer on
  # purpose: routing via HTTP_PROXY would require a Node new enough to support
  # --use-env-proxy, and a real deployment turned out not to be ("node: bad
  # option: --use-env-proxy"), which broke every command. A TCP forwarder needs
  # nothing from Node, and works the same for fetch, WebSocket and curl.
  HA_URL="${HA_BASE_URL:-}"
  HA_SCHEME="${HA_URL%%://*}"
  HA_HOSTPORT="${HA_URL#*://}"
  HA_HOSTPORT="${HA_HOSTPORT%%/*}"
  HA_HOST="${HA_HOSTPORT%%:*}"
  HA_PORT="${HA_HOSTPORT##*:}"
  [ "$HA_PORT" = "$HA_HOST" ] && HA_PORT=8123

  if [ "$HA_SCHEME" = "https" ]; then
    # Forwarding would present the certificate against 127.0.0.1 and fail
    # validation. On a tailnet plain http is already encrypted by WireGuard.
    echo "[start] WARNING: HA_BASE_URL is https, which cannot be forwarded over"
    echo "[start] the tailnet without breaking certificate validation. Use"
    echo "[start] http://$HA_HOST:$HA_PORT instead - the tailnet encrypts it."
    rm -f "$WORKSPACE/.tailscale-env"
  elif [ -z "$HA_HOST" ]; then
    echo "[start] HA_BASE_URL is not set, so there is nothing to forward."
    rm -f "$WORKSPACE/.tailscale-env"
  else
    LOCAL_PORT="${HA_LOCAL_PORT:-18123}"
    echo "[start] forwarding 127.0.0.1:$LOCAL_PORT -> $HA_HOST:$HA_PORT over the tailnet"
    node "$WORKSPACE/bin/tsforward.mjs" "$LOCAL_PORT" "$HA_HOST" "$HA_PORT" "$((PROXY_PORT + 1))"       >/tmp/tsforward.log 2>&1 &
    sleep 1
    export HA_EFFECTIVE_URL="http://127.0.0.1:$LOCAL_PORT"

    # The agent's own shells do not inherit this, so leave it on disk for the
    # CLIs to pick up.
    cat > "$WORKSPACE/.tailscale-env" <<EOF
HA_EFFECTIVE_URL=$HA_EFFECTIVE_URL
EOF
  fi
else
  rm -f "$WORKSPACE/.tailscale-env"
fi

echo "[start] starting pad servers"
cd "$WORKSPACE/projects/speeddial"
exec node src/index.js
