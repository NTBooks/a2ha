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
  # Forward each service we need onto a loopback port. Home Assistant is one;
  # the File editor add-on, if enabled, is another on a different port -- and a
  # tunnel for one does nothing for the other, which is easy to forget until
  # file editing fails with a confusing network error.
  #
  # Prints "scheme://host:port" split into parts, or nothing if unusable.
  parse_url() {
    local url="$1" scheme rest hostport host port
    [ -z "$url" ] && return 1
    scheme="${url%%://*}"
    rest="${url#*://}"
    hostport="${rest%%/*}"
    host="${hostport%%:*}"
    port="${hostport##*:}"
    [ "$port" = "$host" ] && port=""
    [ -z "$host" ] && return 1
    printf '%s %s %s' "$scheme" "$host" "${port:-80}"
  }

  forward() {
    local label="$1" url="$2" local_port="$3"
    local parsed scheme host port
    parsed="$(parse_url "$url")" || { echo "[start] $label: no URL to forward"; return 1; }
    read -r scheme host port <<< "$parsed"
    if [ "$scheme" = "https" ]; then
      # Forwarding would present the certificate against 127.0.0.1 and fail
      # validation. On a tailnet plain http is already encrypted by WireGuard.
      echo "[start] $label: https cannot be forwarded over the tailnet."
      echo "[start] $label: use http://$host:$port - the tailnet encrypts it."
      return 1
    fi
    echo "[start] forwarding 127.0.0.1:$local_port -> $host:$port ($label)"
    node "$WORKSPACE/bin/tsforward.mjs" "$local_port" "$host" "$port" "$((PROXY_PORT + 1))" \
      >>"/tmp/tsforward.log" 2>&1 &
    return 0
  }

  : > /tmp/tsforward.log
  MARKER=""

  if forward "home assistant" "${HA_BASE_URL:-}" "${HA_LOCAL_PORT:-18123}"; then
    export HA_EFFECTIVE_URL="http://127.0.0.1:${HA_LOCAL_PORT:-18123}"
    MARKER="$MARKER
HA_EFFECTIVE_URL=$HA_EFFECTIVE_URL"
  fi

  if [ -n "${HA_FILES_URL:-}" ]; then
    if forward "file editor" "$HA_FILES_URL" "${HA_FILES_LOCAL_PORT:-18218}"; then
      export HA_FILES_EFFECTIVE_URL="http://127.0.0.1:${HA_FILES_LOCAL_PORT:-18218}"
      MARKER="$MARKER
HA_FILES_EFFECTIVE_URL=$HA_FILES_EFFECTIVE_URL"
    fi
  fi

  sleep 1

  if [ -n "$MARKER" ]; then
    # The agent's own shells do not inherit this, so leave it on disk.
    printf '%s\n' "$MARKER" | sed '/^$/d' > "$WORKSPACE/.tailscale-env"
  else
    rm -f "$WORKSPACE/.tailscale-env"
  fi
else
  rm -f "$WORKSPACE/.tailscale-env"
fi

echo "[start] starting pad servers"
cd "$WORKSPACE/projects/speeddial"
exec node src/index.js
