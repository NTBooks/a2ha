#!/usr/bin/env bash
# setup.sh -- build-time install of the Tailscale static binaries.
#
# Runs from scripts.build. We install unconditionally rather than checking for
# TS_AUTHKEY, because build-time environment is not guaranteed to carry the
# agent's secrets, and an install that only happens when a secret is already
# present would mean "add Tailscale later" silently does nothing.
#
# The binaries are static Go builds with no dependencies, so this is a download
# and an untar. Nothing is started here -- see start.sh.

set -euo pipefail

TS_VERSION="${TS_VERSION:-1.86.2}"
PREFIX="${TS_PREFIX:-/home/hermes/data/workspace/.tailscale}"

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  armv7l)  ARCH=arm ;;
  *)       echo "[setup] unknown arch $(uname -m); skipping Tailscale install"; exit 0 ;;
esac

if [ -x "$PREFIX/tailscaled" ] && [ -x "$PREFIX/tailscale" ]; then
  echo "[setup] Tailscale already installed at $PREFIX"
  exit 0
fi

TARBALL="tailscale_${TS_VERSION}_${ARCH}.tgz"
URL="https://pkgs.tailscale.com/stable/${TARBALL}"

echo "[setup] fetching ${URL}"
mkdir -p "$PREFIX"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A failed Tailscale install must not fail the whole build -- the agent is
# perfectly usable over a public HA URL, and a hard failure here would take the
# guest pads down too.
if ! curl -fsSL --retry 3 --max-time 180 "$URL" -o "$TMP/$TARBALL"; then
  echo "[setup] WARNING: could not download Tailscale. The agent will still run;"
  echo "[setup] it just cannot reach a tailnet. Set HA_BASE_URL to a reachable URL."
  exit 0
fi

tar -xzf "$TMP/$TARBALL" -C "$TMP"
install -m 0755 "$TMP/tailscale_${TS_VERSION}_${ARCH}/tailscaled" "$PREFIX/tailscaled"
install -m 0755 "$TMP/tailscale_${TS_VERSION}_${ARCH}/tailscale"  "$PREFIX/tailscale"

echo "[setup] Tailscale ${TS_VERSION} installed to $PREFIX"
