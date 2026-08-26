#!/usr/bin/env bash
# update-agent.sh -- push this repo's current code into a running agent.
#
# You do not need to delete and recreate an agent to pick up changes. Its
# workspace is a git repo served by Pinata; push to it and scripts.build re-runs
# automatically.
#
#   ./scripts/update-agent.sh "<agent git url with token>"
#
# Get that URL from the agent's Files tab -> "Copy with Token". It has the
# gateway token embedded, so treat it like a password and expect it to change
# if you ever rotate the token.
#
# What this does NOT update: manifest.json is read when the agent is created,
# so changes to routes, secrets or lifecycle scripts still need a redeploy.
# Code and prompt files take effect on push. See the note at the end.

set -euo pipefail

AGENT_URL="${1:-}"
if [ -z "$AGENT_URL" ]; then
  echo "usage: $0 \"<agent git url from Files tab -> Copy with Token>\"" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$(git -C "$REPO_ROOT" remote get-url origin)"
BRANCH="${BRANCH:-main}"

# Everything the agent runs, minus workspace/data -- that holds the owner's
# pads, share tokens and backups, and must survive an update untouched.
PATHS=(
  SOUL.md
  README.md
  LICENSE
  workspace/AGENTS.md
  workspace/HA.md
  workspace/PADS.md
  workspace/setup.sh
  workspace/start.sh
  workspace/bin
  workspace/projects
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[update] cloning the agent workspace"
git clone --quiet "$AGENT_URL" "$TMP/agent"
cd "$TMP/agent"

echo "[update] fetching $UPSTREAM ($BRANCH)"
git remote add upstream "$UPSTREAM"
git fetch --quiet upstream "$BRANCH"

# Deliberately not a merge. The agent's workspace history and this repo's
# history are unrelated, so merging conflicts on every file. Checking out
# specific paths takes the content and leaves the histories alone.
echo "[update] taking code and prompts from upstream"
for p in "${PATHS[@]}"; do
  if git cat-file -e "upstream/$BRANCH:$p" 2>/dev/null; then
    git checkout "upstream/$BRANCH" -- "$p"
  else
    echo "[update]   skipping $p (not in upstream)"
  fi
done

if git diff --cached --quiet && git diff --quiet; then
  echo "[update] nothing changed - the agent is already up to date."
  exit 0
fi

git add -A
echo "[update] changes:"
git diff --cached --stat | sed 's/^/           /'

SHA="$(git -C "$REPO_ROOT" rev-parse --short "$BRANCH")"
git -c user.email=update@a2ha -c user.name=a2ha-update \
    commit --quiet -m "Update from $UPSTREAM @ $SHA"

echo "[update] pushing"
git push --quiet origin HEAD:main || git push --quiet origin HEAD:master

cat <<'EOF'

[update] done. The build script re-runs automatically - watch the Lifecycle
[update] Scripts row on the agent.

[update] Then RESTART THE GATEWAY from the Danger tab. scripts.start only runs
[update] on boot, so the servers keep running the old code until you do.

[update] If you changed manifest.json - routes, secrets, or the build/start
[update] commands - that is read at agent creation and a push will not apply
[update] it. Those still need a fresh agent.
EOF
