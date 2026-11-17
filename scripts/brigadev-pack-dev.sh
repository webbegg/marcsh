#!/bin/sh
# Mirror packs/brigadev into a local git repository that marcsh can install from,
# so the pack can be tried without pushing it to GitHub.
#
# marcsh installs packs from GitHub only. MARCSH_PACK_URL_BASE replaces
# https://github.com in the clone URL (packages/cli/src/lib/packs.ts, parsePackSpec),
# so `owner/repo` is fetched from "$MARCSH_PACK_URL_BASE/owner/repo".
#
# Usage: scripts/brigadev-pack-dev.sh [base-dir]   (default: /tmp/marcsh-pack-dev)
#   The mirror lives at <base-dir>/local/brigadev and is replaced on every run (only its
#   .git is kept). The script marks a mirror it created with .git/brigadev-pack-mirror and
#   refuses a non-empty destination without that marker, and a base-dir of / or $HOME.
# Then:  MARCSH_PACK_URL_BASE=file://<base-dir> marcsh
#        /agents install local/brigadev        (first time)
#        /agents update local/brigadev         (after running this script again)
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
src="$repo_root/packs/brigadev"
base=${1:-/tmp/marcsh-pack-dev}
dest="$base/local/brigadev"
marker="$dest/.git/brigadev-pack-mirror"

[ -d "$src/agents" ] || { echo "No pack at $src" >&2; exit 1; }

# Never wipe contents under / or the home directory.
base_real=$(cd "$base" 2>/dev/null && pwd -P || true)
home_real=$(cd "$HOME" 2>/dev/null && pwd -P || true)
refuse_base=0
only_slashes() { [ -z "$(printf '%s' "$1" | tr -d /)" ]; }
only_slashes "$base" && refuse_base=1
[ -n "$base_real" ] && only_slashes "$base_real" && refuse_base=1
[ -n "$home_real" ] && [ "$base_real" = "$home_real" ] && refuse_base=1
if [ "$refuse_base" = 1 ]; then
  echo "Refusing base-dir '$base': it is / or your home directory. Use a scratch directory." >&2
  exit 1
fi

# An existing, non-empty destination must be a mirror this script made: it is emptied below.
if [ -e "$dest" ] && [ ! -d "$dest" ]; then
  echo "Refusing: $dest exists and is not a directory." >&2
  exit 1
fi
if [ -d "$dest" ] && [ -n "$(ls -A "$dest")" ] && [ ! -f "$marker" ]; then
  # A mirror made before the marker existed: its commits are authored by brigadev-dev.
  if [ -d "$dest/.git" ] && [ "$(git -C "$dest" log -1 --format=%an 2>/dev/null || true)" = "brigadev-dev" ]; then
    : > "$marker"
  else
    echo "Refusing: $dest is not empty and was not created by this script (no .git/brigadev-pack-mirror marker)." >&2
    echo "Remove it yourself or choose another base-dir; nothing was changed." >&2
    exit 1
  fi
fi

mkdir -p "$dest"
[ -d "$dest/.git" ] || git -C "$dest" init -q -b main
: > "$marker"

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
