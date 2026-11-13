#!/usr/bin/env bash
# marcsh installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh | bash -s -- --modify-path
#
# Downloads the release tarball, checks its SHA-256 before unpacking, unpacks it to a staging folder in ~/.marcsh/app,
# runs `bun install --ignore-scripts` there, moves it to ~/.marcsh/app/<version> and only then switches
# ~/.marcsh/app/current to it. Links ~/.local/bin/marcsh. The live version folders are never half-installed, even if
# the installer is killed; the next run clears what a killed one left. No sudo. Run it with --help for the options.
#
# Environment:
#   MARCSH_VERSION            install this version (for example 0.1.0) instead of the latest release
#   MARCSH_INSTALL_BASE_URL   download base, default https://github.com/webbegg/marcsh/releases (mirrors, tests)
#
# Piping into bash: everything below, the settings and every function, sits in one brace group, and the only command
# outside it is the call on the last line. Bash reads a whole group before it runs any of it, so a download cut anywhere
# before that last line is a syntax error or defines nothing, and runs nothing. The group is not indented, so the usage
# heredoc stays readable. Every command that could read stdin gets </dev/null, so none of them can swallow the rest of
# the script.

{ # the whole script is this one group; do not add commands outside it

set -euo pipefail

BUN_INSTALL_URL="https://bun.sh/install"
DEFAULT_BASE_URL="https://github.com/webbegg/marcsh/releases"
VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
LOOPBACK_HTTP_PATTERN='^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)'
# `scheme://user:token@host/rest`: group 1 is `scheme://`, group 2 is `host/rest`.
USERINFO_PATTERN='^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@(.*)$'
# `<64 hex digits>  marcsh.tar.gz` (two spaces) or `<64 hex digits> *marcsh.tar.gz` (shasum's binary marker).
CHECKSUM_PATTERN='^([0-9a-fA-F]{64}) [ *]marcsh\.tar\.gz$'
PATH_MARKER="# marcsh installer"
# Every download: TLS 1.2 or newer, a few retries for flaky networks (a refused connection too), a limit on how long to
# wait for a connection, and a give-up when the transfer stays under 1 KB/s for 30 s (a stalled connection).
CURL_SAFE=(-fsSL --tlsv1.2 --retry 3 --retry-connrefused --connect-timeout 20 --speed-time 30 --speed-limit 1024)

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs marcsh to ~/.marcsh/app and links ~/.local/bin/marcsh. Run it again to update.

Options:
  --with-bun       install Bun first (its official installer) when no Bun 1.4+ is found
  --modify-path    add ~/.local/bin to PATH in ~/.zshrc when it is not there yet (one marked line, added once)
  --uninstall      remove ~/.marcsh/app and the ~/.local/bin/marcsh link; other ~/.marcsh data is kept
                   (cannot be combined with --with-bun or --modify-path)
  -h, --help       show this help

Environment:
  MARCSH_VERSION            install this version (for example 0.1.0) instead of the latest release
  MARCSH_INSTALL_BASE_URL   download base, default https://github.com/webbegg/marcsh/releases
                            (must be https://; plain http is allowed only for 127.0.0.1 and localhost)
EOF
}

setup_colors() {
  bold="" red="" green="" yellow="" reset=""
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    bold=$'\033[1m' red=$'\033[31m' green=$'\033[32m' yellow=$'\033[33m' reset=$'\033[0m'
  fi
}

info() { printf '%s\n' "${bold:-}==>${reset:-} $*"; }
ok() { printf '%s\n' "${green:-}✓${reset:-} $*"; }
warn() { printf '%s\n' "${yellow:-}warning:${reset:-} $*" >&2; }
die() {
  printf '%s\n' "${red:-}error:${reset:-} $*" >&2
  exit 1
}

# Runs on every exit (also Ctrl-C): puts an interrupted or failed install back the way it was and removes the temp dir.
cleanup() {
  if [ -n "${pending_stage:-}" ]; then rm -rf "$pending_stage" || true; fi
  # The new copy was moved into place but `current` was not switched to it yet: take it out again.
  if [ -n "${pending_dest:-}" ]; then rm -rf "$pending_dest" || true; fi
  # The working copy was set aside for a same-version reinstall: put it back.
  if [ -n "${pending_backup:-}" ] && [ -e "$pending_backup" ]; then
    mv "$pending_backup" "$pending_restore" || true
  fi
  if [ -n "${pending_link:-}" ]; then rm -f "$pending_link" || true; fi
  if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir" || true; fi
  # Only the run that created the lock removes it.
  if [ -n "${lock_dir:-}" ]; then rm -rf "$lock_dir" || true; fi
}

# Prints $1 without the user:password part of its authority, so a URL with credentials can be shown.
redact_url() {
  if [[ $1 =~ $USERINFO_PATTERN ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}***@${BASH_REMATCH[2]}"
  else
    printf '%s\n' "$1"
  fi
}

# 0 when $1 starts with a Bun version of at least 1.4.
bun_version_ok() {
  [[ $1 =~ ^([0-9]+)\.([0-9]+) ]] || return 1
  local major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]}))
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 4 ]; }
}

# Sets bun_bin to a Bun 1.4+ (PATH first, then ~/.bun/bin) or "" and bun_old to the version of an older one it saw.
locate_bun() {
  bun_bin="" bun_old=""
  local candidate version
  for candidate in "$(command -v bun || true)" "$HOME/.bun/bin/bun"; do
    if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then continue; fi
    version=$("$candidate" --version 2>/dev/null </dev/null) || continue
    if bun_version_ok "$version"; then
      bun_bin=$candidate
      return 0
    fi
    bun_old=$version
  done
  return 0
}

require_bun() {
  locate_bun
  if [ -z "$bun_bin" ] && [ "$with_bun" = 1 ]; then
    info "Installing Bun with its official installer ($BUN_INSTALL_URL)"
    curl "${CURL_SAFE[@]}" --proto '=https' --proto-redir '=https' "$BUN_INSTALL_URL" </dev/null | bash || die "Bun's installer failed. Install Bun yourself: curl -fsSL $BUN_INSTALL_URL | bash"
    locate_bun
  fi
  if [ -n "$bun_bin" ]; then return 0; fi
  if [ -n "$bun_old" ]; then
    printf '%s\n' "${red:-}error:${reset:-} marcsh needs Bun 1.4 or newer, but found Bun $bun_old." >&2
    printf '%s\n' "Upgrade it with:  bun upgrade" >&2
  else
    printf '%s\n' "${red:-}error:${reset:-} marcsh needs Bun 1.4 or newer, and Bun was not found." >&2
    printf '%s\n' "Install it with:  curl -fsSL $BUN_INSTALL_URL | bash" >&2
  fi
  printf '%s\n' "or run this installer again with --with-bun." >&2
  exit 1
}

require_macos() {
  local os arch
  os=$(uname -s </dev/null)
  arch=$(uname -m </dev/null)
  if [ "$os" != "Darwin" ]; then
    die "marcsh installs on macOS only (this is $os). See https://github.com/webbegg/marcsh to run it from source."
  fi
  case "$arch" in
    arm64 | x86_64) ;;
    *) die "Unsupported Mac architecture: $arch (marcsh supports arm64 and x86_64)." ;;
  esac
}

# Aborts unless the download base is https://. Plain http is only for a loopback address (tests, a local mirror).
# Sets curl_proto: the protocols curl may use for the release downloads; redirects may only go to https.
check_base_url() {
  local base=${MARCSH_INSTALL_BASE_URL:-$DEFAULT_BASE_URL}
  if [[ $base == https://* ]]; then
    curl_proto=(--proto '=https' --proto-redir '=https')
  elif [[ $base =~ $LOOPBACK_HTTP_PATTERN ]]; then
    curl_proto=(--proto '=http,https' --proto-redir '=https')
  else
    die "MARCSH_INSTALL_BASE_URL must start with https:// (plain http is allowed only for 127.0.0.1 and localhost), got: $(redact_url "$base")"
  fi
  if [ "${base%/}" != "$DEFAULT_BASE_URL" ]; then
    warn "MARCSH_INSTALL_BASE_URL is set: downloading from $(redact_url "$base") instead of $DEFAULT_BASE_URL"
  fi
}

# Prints the base URL of the release assets: the latest release, or the one MARCSH_VERSION names.
release_url() {
  local base=${MARCSH_INSTALL_BASE_URL:-$DEFAULT_BASE_URL}
  base=${base%/}
  if [ -n "${MARCSH_VERSION:-}" ]; then
    printf '%s\n' "$base/download/v$MARCSH_VERSION"
  else
    printf '%s\n' "$base/latest/download"
  fi
}

# Aborts unless every tarball entry is a plain file or directory inside marcsh/. $1: the tarball.
check_tarball_paths() {
  local tarball=$1 entry
  tar -tzf "$tarball" </dev/null >"$tmp_dir/entries" || die "The downloaded file is not a valid tarball."
  [ -s "$tmp_dir/entries" ] || die "The downloaded tarball is empty."
  while IFS= read -r entry; do
    entry=${entry#./}
    case "$entry" in
      "") continue ;;
      /* | .. | ../* | */.. | */../*) die "Unsafe path in the tarball: $entry. Nothing was changed." ;;
      marcsh | marcsh/*) ;;
      *) die "Unexpected path in the tarball (outside marcsh/): $entry. Nothing was changed." ;;
    esac
  done <"$tmp_dir/entries"
  # Links and special files could point out of marcsh/ once extracted; a release has none.
  tar -tvzf "$tarball" </dev/null >"$tmp_dir/entries-long" || die "The downloaded file is not a valid tarball."
  while IFS= read -r entry; do
    case "$entry" in
      -* | d* | "") ;;
      *) die "The tarball contains a link or special file, which a release never has. Nothing was changed." ;;
    esac
  done <"$tmp_dir/entries-long"
}

# $1: path to the package.json of packages/cli. Prints its top-level "version".
read_version() {
  sed -n '/^[[:space:]]*"version"[[:space:]]*:/{s/^[^:]*:[[:space:]]*"\([^"]*\)".*/\1/p;q;}' "$1" </dev/null
}

# $1: the downloaded .sha256 file. Prints the lower-case hash when the file is exactly one line,
# `<64 hex digits>  marcsh.tar.gz` or `<64 hex digits> *marcsh.tar.gz`, with or without a final newline; returns 1 for
# anything else: another file name, more lines (also blank ones), a CRLF line ending.
read_checksum() {
  local line="" extra=""
  {
    IFS= read -r line || true
    if IFS= read -r extra || [ -n "$extra" ]; then return 1; fi
  } <"$1"
  [[ $line =~ $CHECKSUM_PATTERN ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}" | tr 'A-F' 'a-f'
}

# Points the symlink $2 at $1 in one step: a temp link next to it, then rename over it. `-h` is BSD mv only, so this
# calls /bin/mv: a GNU mv earlier on PATH (Homebrew coreutils) does not know it.
link_atomic() {
  pending_link="$2.tmp.$$"
  rm -f "$pending_link"
  ln -s "$1" "$pending_link"
  /bin/mv -fh "$pending_link" "$2"
  pending_link=""
}

# 0 when ~/.local/bin is a PATH entry. A trailing slash (~/.local/bin/) is the same directory.
on_path() {
  local want="${HOME%/}/.local/bin" rest="$PATH:" entry
  while [ -n "$rest" ]; do
    entry=${rest%%:*}
    rest=${rest#*:}
    while [ "${entry%/}" != "$entry" ]; do entry=${entry%/}; done
    if [ "$entry" = "$want" ]; then return 0; fi
  done
  return 1
}

handle_path() {
  local rc="$HOME/.zshrc"
  if on_path; then return 0; fi
  if [ "$modify_path" = 1 ]; then
    if [ -f "$rc" ] && grep -qF "$PATH_MARKER" "$rc" </dev/null; then
      ok "~/.zshrc already has the marcsh PATH line"
    else
      # Start on a fresh line when the file does not end with one.
      if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc" </dev/null)" ]; then printf '\n' >>"$rc"; fi
      printf '%s\n' "export PATH=\"\$HOME/.local/bin:\$PATH\" $PATH_MARKER" >>"$rc"
      ok "Added ~/.local/bin to PATH in ~/.zshrc. Open a new terminal, or run: source ~/.zshrc"
    fi
  else
    warn "~/.local/bin is not on your PATH. Add this line to ~/.zshrc, then open a new terminal:"
    printf '\n    export PATH="$HOME/.local/bin:$PATH"\n\n' >&2
    printf '%s\n' "Or run the installer again with --modify-path to let it add the line." >&2
  fi
}

# Keeps the new version and the previous one, removes the other versions. $1: ~/.marcsh, $2: new version, $3: previous ("" if none).
prune_versions() {
  local app=$1/app new=$2 prev=$3 dir name
  # Re-running the version that is already current: the earlier run kept what it needed, so keep everything.
  if [ "$prev" = "$new" ]; then return 0; fi
  for dir in "$app"/*; do
    name=${dir##*/}
    case "$name" in .*) continue ;; esac # the lock, the staging folder and the set-aside copy are not versions
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi
    if [[ ! $name =~ $VERSION_PATTERN ]]; then continue; fi
    if [ "$name" = "$new" ] || [ "$name" = "$prev" ]; then continue; fi
    # `current` already points at the new version: failing to tidy up an old one is not worth failing the install.
    rm -rf "$dir" || warn "Could not remove the old version $dir. It is safe to delete."
  done
}

# Prints the process id the lock $1 names, or nothing when it names none.
lock_owner() {
  local pid=""
  if [ -f "$1/pid" ]; then IFS= read -r pid <"$1/pid" || true; fi
  if [[ $pid =~ ^[1-9][0-9]*$ ]]; then printf '%s\n' "$pid"; fi
  return 0
}

# Takes the lock $1/.install.lock, with $1 (the app folder) existing. mkdir is atomic: of two installers started
# together, one gets the lock and the other stops here. The lock holds its owner's process id; a lock whose owner is gone
# (a crash, a closed terminal, a SIGKILL) is taken over.
acquire_lock() {
  local lock=$1/.install.lock stale=$1/.install.lock.stale.$$ owner="" taken
  if ! mkdir "$lock" 2>/dev/null; then
    [ -e "$lock" ] || die "Could not create $lock."
    owner=$(lock_owner "$lock")
    if [ -z "$owner" ]; then
      sleep 1 # an installer that has only just made the lock has not written its process id yet
      owner=$(lock_owner "$lock")
    fi
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      die "Another install is running (process $owner): $lock exists. Wait for it to finish, then run the installer again."
    fi
    # Rename it away first (atomic), so two installers taking over a stale lock cannot both succeed.
    mv "$lock" "$stale" 2>/dev/null || die "Another install may be running: could not take over $lock."
    taken=$(lock_owner "$stale")
    if [ "$taken" != "$owner" ]; then
      mv "$stale" "$lock" 2>/dev/null || true # it was a new lock after all: put it back
      die "Another install may be running: $lock changed while it was being taken over. Run the installer again."
    fi
    rm -rf "$stale" || true
    if [ -n "$owner" ]; then
      info "Removed a stale install lock (process $owner, which held it, is gone)."
    else
      info "Removed a stale install lock that named no installer."
    fi
    mkdir "$lock" 2>/dev/null || die "Another install may be running: could not create $lock."
  fi
  lock_dir=$lock
  printf '%s\n' "$$" >"$lock/pid"
}

# With the lock held: clears what an installer that died left in $1 (the app folder). A `.stage.*` folder is a half-built
# copy: removed. A `.replaced.*` folder is a working copy set aside for a same-version reinstall: put back when its
# version folder is missing or was never finished (no node_modules), removed otherwise.
recover_leftovers() {
  local app=$1 leftover version target
  for leftover in "$app"/.stage.* "$app"/.replaced.*; do
    if [ ! -e "$leftover" ] && [ ! -L "$leftover" ]; then continue; fi
    case "$leftover" in
      "$app"/.replaced.*)
        version=$(read_version "$leftover/packages/cli/package.json" 2>/dev/null || true)
        target=$app/$version
        if [[ $version =~ $VERSION_PATTERN ]] && [ ! -d "$target/node_modules" ]; then
          rm -rf "$target"
          if mv "$leftover" "$target"; then
            warn "Restored marcsh $version from an install that was interrupted."
            continue
          fi
        fi
        ;;
    esac
    rm -rf "$leftover" || warn "Could not remove $leftover. It is safe to delete."
  done
}

install_marcsh() {
  local home_dir="$HOME/.marcsh" app="$HOME/.marcsh/app" url shown expected actual version dest stage prev="" target
  local extract kept="" bin_link="$HOME/.local/bin/marcsh" linked=1 link_target hint home_mode replaced

  # Whatever the user's umask is, nothing this creates is writable by group or others.
  umask 022

  if [ -n "${MARCSH_VERSION:-}" ] && [[ ! $MARCSH_VERSION =~ $VERSION_PATTERN ]]; then
    die "MARCSH_VERSION must look like 0.1.0 (or 0.2.0-beta.1), got: $MARCSH_VERSION"
  fi
  check_base_url
  require_macos
  require_bun
  if [ -e "$app/current" ] && [ ! -L "$app/current" ]; then
    die "$app/current exists and is not a link, so the installer will not touch it. Move it away (for example: mv '$app/current' '$app/current.old'), then run the installer again. Nothing was changed."
  fi

  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/marcsh-install.XXXXXX") || die "Could not create a temp directory."
  url=$(release_url)
  shown=$(redact_url "$url") # credentials in the base URL are never printed

  info "Downloading $shown/marcsh.tar.gz"
  curl "${CURL_SAFE[@]}" "${curl_proto[@]}" -o "$tmp_dir/marcsh.tar.gz" "$url/marcsh.tar.gz" </dev/null ||
    die "Download failed: $shown/marcsh.tar.gz${MARCSH_VERSION:+ (is there a release v$MARCSH_VERSION?)}"
  curl "${CURL_SAFE[@]}" "${curl_proto[@]}" -o "$tmp_dir/marcsh.tar.gz.sha256" "$url/marcsh.tar.gz.sha256" </dev/null ||
    die "Download failed: $shown/marcsh.tar.gz.sha256"

  if ! expected=$(read_checksum "$tmp_dir/marcsh.tar.gz.sha256"); then
    hint=""
    if [ -n "$(tr -cd '\r' <"$tmp_dir/marcsh.tar.gz.sha256")" ]; then hint=" (Windows line endings are not accepted)"; fi
    die "The checksum file is not a SHA-256 checksum for marcsh.tar.gz: expected one line, <64 hex digits>  marcsh.tar.gz$hint. Nothing was changed."
  fi
  actual=$(shasum -a 256 "$tmp_dir/marcsh.tar.gz" </dev/null | awk '{ print $1 }')
  if [ "$actual" != "$expected" ]; then
    die "Checksum mismatch for marcsh.tar.gz (expected $expected, got $actual). Nothing was changed. A release published at the same moment can cause this: run the installer again."
  fi
  ok "Checksum verified"

  check_tarball_paths "$tmp_dir/marcsh.tar.gz"
  extract="$tmp_dir/extract"
  mkdir "$extract"
  tar -xzf "$tmp_dir/marcsh.tar.gz" -C "$extract" </dev/null || die "Could not unpack the tarball. Nothing was changed."
  [ -f "$extract/marcsh/packages/cli/package.json" ] || die "The tarball has no marcsh/packages/cli/package.json. Nothing was changed."
  [ -f "$extract/marcsh/packages/cli/bin/marcsh" ] || die "The tarball has no marcsh/packages/cli/bin/marcsh. Nothing was changed."
  version=$(read_version "$extract/marcsh/packages/cli/package.json")
  if [[ ! $version =~ $VERSION_PATTERN ]]; then die "Could not read a valid version from the tarball's package.json (got: ${version:-nothing})."; fi
  if [ -n "${MARCSH_VERSION:-}" ] && [ "$version" != "$MARCSH_VERSION" ]; then
    die "MARCSH_VERSION is $MARCSH_VERSION, but the release holds marcsh $version. Nothing was changed."
  fi
  chmod +x "$extract/marcsh/packages/cli/bin/marcsh"

  # Only now does the install touch the user's home.
  if [ ! -d "$home_dir" ]; then mkdir -m 700 "$home_dir"; fi
  home_mode=$(/usr/bin/stat -f '%Lp' "$home_dir" 2>/dev/null </dev/null || true)
  if [[ $home_mode =~ ^[0-7]+$ ]] && [ $((8#$home_mode & 8#022)) -ne 0 ]; then
    warn "~/.marcsh is writable by group or others (mode $home_mode), so other users could change what marcsh runs. Fix it with:  chmod go-w ~/.marcsh"
  fi
  mkdir -p "$app"
  acquire_lock "$app"
  # A killed installer may have left a half-built copy or a set-aside working copy; deal with them before looking at versions.
  recover_leftovers "$app"
  if [ -L "$app/current" ]; then
    prev=$(readlink "$app/current" || true)
    prev=${prev##*/}
    # Only a previous version that is still on disk can be rolled back to.
    if [[ ! $prev =~ $VERSION_PATTERN ]] || [ ! -d "$app/$prev" ]; then prev=""; fi
  fi

  dest="$app/$version"
  stage="$app/.stage.$$"
  info "Installing marcsh $version to ~/.marcsh/app/$version"
  # The new copy is built in a staging folder on the same filesystem and only moved to its version folder once bun install
  # has finished, so a version folder that `current` can point at is never half-installed, even if this process is killed.
  # Each variable the cleanup uses is set before the move it undoes, so a signal between two lines still restores.
  pending_stage=$stage
  mv "$extract/marcsh" "$stage"

  info "Installing dependencies with Bun"
  # --ignore-scripts: dependency lifecycle scripts do not run on this machine; marcsh runs its TypeScript directly.
  if ! (cd "$stage" && "$bun_bin" install --frozen-lockfile --production --ignore-scripts </dev/null); then
    die "bun install failed. The previous version stays active and nothing else was changed."
  fi
  chmod -R go-w "$stage"

  # The same version again: set the old copy aside so a failed install can put it back (cleanup does that).
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    pending_restore=$dest
    pending_backup="$app/.replaced.$$"
    rm -rf "$pending_backup"
    mv "$dest" "$pending_backup"
  fi
  pending_dest=$dest
  mv "$stage" "$dest"
  pending_stage=""

  link_atomic "$version" "$app/current"
  # `current` now points at the new version: from here the cleanup must never remove it or put the old copy back.
  replaced=$pending_backup
  pending_dest="" pending_backup="" pending_restore=""
  if [ -n "$replaced" ]; then
    rm -rf "$replaced" || warn "Could not remove the replaced copy $replaced. It is safe to delete."
  fi
  prune_versions "$home_dir" "$version" "$prev"
  if [ "$prev" != "$version" ]; then kept=$prev; fi

  mkdir -p "$HOME/.local/bin"
  target="$app/current/packages/cli/bin/marcsh"
  if [ -L "$bin_link" ]; then
    link_target=$(readlink "$bin_link" || true)
    case "$link_target" in
      "$app"/*) ;;
      *)
        linked=0
        warn "$bin_link is a link to $link_target, not to a marcsh install, so it was left alone. To point it at this install, run:  ln -sf '$target' '$bin_link'"
        ;;
    esac
  elif [ -e "$bin_link" ]; then
    linked=0
    warn "$bin_link exists and is not a link, so it was left alone. Remove it and run the installer again."
  fi
  if [ "$linked" = 1 ]; then link_atomic "$target" "$bin_link"; fi

  ok "Installed marcsh $version${kept:+ (previous version $kept kept for rollback)}"
  handle_path
  if ! command -v bun >/dev/null 2>&1; then
    warn "marcsh starts with the 'bun' on your PATH, and it is not there ($bun_bin). Add Bun's directory to PATH."
  fi
  if [ "$linked" = 1 ]; then
    printf '%s\n' "Run it with:  marcsh"
  else
    printf '%s\n' "marcsh is not linked in ~/.local/bin. Run it with:  $target"
  fi
}

uninstall_marcsh() {
  local app="$HOME/.marcsh/app" link="$HOME/.local/bin/marcsh" target removed=0
  if [ -e "$app" ] || [ -L "$app" ]; then
    # Not while an install runs. The lock folder goes away with the app folder.
    if [ -d "$app" ] && [ ! -L "$app" ]; then acquire_lock "$app"; fi
    rm -rf "$app"
    removed=1
  fi
  if [ -L "$link" ]; then
    target=$(readlink "$link" || true)
    case "$target" in
      "$app"/*)
        rm -f "$link"
        removed=1
        ;;
    esac
  fi
  if [ "$removed" = 1 ]; then
    ok "Removed ~/.marcsh/app and ~/.local/bin/marcsh. Your other ~/.marcsh data (sessions, settings, packs) is untouched."
  else
    info "marcsh is not installed here; nothing to remove."
  fi
  if [ -f "$HOME/.zshrc" ] && grep -qF "$PATH_MARKER" "$HOME/.zshrc" </dev/null; then
    info "~/.zshrc still has the PATH line marked '$PATH_MARKER'; delete it if you no longer want it."
  fi
}

main() {
  with_bun=0 modify_path=0 uninstall=0 show_help=0
  tmp_dir="" pending_stage="" pending_dest="" pending_backup="" pending_restore="" pending_link="" lock_dir=""
  bun_bin="" bun_old="" curl_proto=()
  setup_colors

  local arg
  for arg in "$@"; do
    case "$arg" in
      --with-bun) with_bun=1 ;;
      --modify-path) modify_path=1 ;;
      --uninstall) uninstall=1 ;;
      -h | --help) show_help=1 ;;
      *)
        printf '%s\n' "${red:-}error:${reset:-} unknown option: $arg" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
  if [ "$show_help" = 1 ]; then
    usage
    exit 0
  fi
  if [ "$uninstall" = 1 ] && { [ "$with_bun" = 1 ] || [ "$modify_path" = 1 ]; }; then
    printf '%s\n' "${red:-}error:${reset:-} --uninstall cannot be combined with --with-bun or --modify-path." >&2
    usage >&2
    exit 2
  fi

  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then die "HOME is not set to an existing directory."; fi
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP # the terminal was closed in the middle of `curl | bash`

  if [ "$uninstall" = 1 ]; then
    uninstall_marcsh
  else
    install_marcsh
  fi
}

} # end of the group

{ main "$@"; }
