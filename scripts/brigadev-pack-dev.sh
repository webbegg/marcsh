#!/bin/sh
# Mirror packs/brigadev into a local git repository that marcsh can install from,
# so the pack can be tried without pushing it to GitHub.
#
# marcsh installs packs from GitHub only. MARCSH_PACK_URL_BASE replaces
# https://github.com in the clone URL (packages/cli/src/lib/packs.ts, parsePackSpec),
# so `owner/repo` is fetched from "$MARCSH_PACK_URL_BASE/owner/repo".
#
# Usage: scripts/brigadev-pack-dev.sh [base-dir]   (default: /tmp/marcsh-pack-dev)
# Then:  MARCSH_PACK_URL_BASE=file://<base-dir> marcsh
#        /agents install local/brigadev        (first time)
#        /agents update local/brigadev         (after running this script again)
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
src="$repo_root/packs/brigadev"
base=${1:-/tmp/marcsh-pack-dev}
dest="$base/local/brigadev"

[ -d "$src/agents" ] || { echo "No pack at $src" >&2; exit 1; }

mkdir -p "$dest"
[ -d "$dest/.git" ] || git -C "$dest" init -q -b main

# Replace the mirror's files with the pack's (keep only .git).
find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
(cd "$src" && tar cf - --exclude node_modules .) | (cd "$dest" && tar xf -)

git -C "$dest" add -A
if git -C "$dest" diff --cached --quiet; then
  echo "Mirror already up to date: $dest"
else
  git -C "$dest" -c user.name=brigadev-dev -c user.email=dev@localhost commit -q -m "mirror $(git -C "$repo_root" rev-parse --short HEAD)"
  echo "Mirrored packs/brigadev to $dest ($(git -C "$dest" rev-parse --short HEAD))"
fi

cat <<EOF

Start marcsh with:   MARCSH_PACK_URL_BASE=file://$base marcsh
Install:             /agents install local/brigadev
After a new mirror:  /agents update local/brigadev
EOF
