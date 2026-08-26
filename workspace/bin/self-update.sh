#!/usr/bin/env bash
# self-update.sh -- pull the latest code into this running agent, from inside it.
#
# Run it in the agent's Console tab:
#
#   bash /home/hermes/data/workspace/bin/self-update.sh
#
# Updating a template only affects agents created afterwards, and there is no
# "pull latest" button, so the alternative is deleting the agent -- which throws
# away its pads, share tokens and backups for the sake of a code change.
#
# The workspace is a git repo, so this fetches the upstream repo and takes the
# code and prompt files from it. workspace/data is deliberately left alone.
#
# manifest.json is NOT updated: routes, secrets and lifecycle commands are read
# when the agent is created, so those genuinely do need a new agent.

set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/NTBooks/a2ha.git}"
BRANCH="${UPSTREAM_BRANCH:-main}"

# The workspace repo root is wherever .git lives above this script.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$DIR"
while [ "$ROOT" != "/" ] && [ ! -d "$ROOT/.git" ]; do ROOT="$(dirname "$ROOT")"; done
if [ ! -d "$ROOT/.git" ]; then
  echo "Could not find the workspace git repo above $DIR." >&2
  echo "This agent's workspace may not be git-backed; update by redeploying." >&2
  exit 1
fi
cd "$ROOT"
echo "[self-update] workspace repo: $ROOT"

# Path of this script relative to the repo, so we can report a self-change.
REL_SELF="${BASH_SOURCE[0]#$ROOT/}"

PATHS=()  # filled in after fetch

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

echo "[self-update] fetching $UPSTREAM_URL ($BRANCH)"
git fetch --quiet --depth 1 upstream "$BRANCH"

# Derived from upstream rather than hardcoded: a hand-maintained list silently
# stops copying files that get added later. Everything under workspace/ except
# data/, plus the top-level docs.
mapfile -t PATHS < <(
  git ls-tree -r --name-only "upstream/$BRANCH"     | grep -E '^(workspace/|SOUL\.md$|README\.md$|LICENSE$)'     | grep -v '^workspace/data/'
)
if [ ${#PATHS[@]} -eq 0 ]; then
  echo "Found nothing to copy from upstream/$BRANCH." >&2
  exit 1
fi

for p in "${PATHS[@]}"; do
  if git cat-file -e "upstream/$BRANCH:$p" 2>/dev/null; then
    git checkout "upstream/$BRANCH" -- "$p"
  else
    echo "[self-update]   skipping $p (not upstream)"
  fi
done

if git diff --quiet && git diff --cached --quiet; then
  echo "[self-update] already up to date."
  exit 0
fi

git add -A
echo "[self-update] changed:"
git diff --cached --stat | sed 's/^/               /'

SELF_CHANGED=no
git diff --cached --name-only | grep -qx "$REL_SELF" && SELF_CHANGED=yes

git -c user.email=self-update@a2ha -c user.name=a2ha \
    commit --quiet -m "Self-update from $UPSTREAM_URL@$BRANCH"

# Reinstall in case dependencies changed. There are none today, which is why
# this is quick, but a future version might add some.
if [ -f workspace/projects/speeddial/package.json ]; then
  echo "[self-update] installing"
  (cd workspace/projects/speeddial && npm ci --omit=dev --silent) || \
    echo "[self-update] npm ci failed - check the output above"
fi

echo
echo "[self-update] Done. Now RESTART THE GATEWAY from the Danger tab -- the pad"
echo "[self-update] servers only pick up new code when they boot."
[ "$SELF_CHANGED" = yes ] && echo "[self-update] (this script updated itself; the new one runs next time)"
echo "[self-update] If manifest.json changed upstream - routes, secrets, or the"
echo "[self-update] build/start commands - that still needs a fresh agent."
