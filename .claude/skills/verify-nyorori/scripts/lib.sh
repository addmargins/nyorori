#!/usr/bin/env bash
# Shared helpers for the verify-nyorori scripts. Source it; do not run it.
# Every script resolves the repository root from its own location, so the
# commands in SKILL.md work from any current directory.

VERIFY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO_ROOT="$(cd "$VERIFY_SKILL_DIR/../../.." && pwd -P)"
CLI="$REPO_ROOT/dist/cli.js"

# Pins copied from scripts/fetch-cccc.sh (cccc v1.8.5, release asset
# cccc-v1.8.5-x86_64-unknown-linux-musl.tar.gz). Keep them in step with that script.
CCCC_EXPECTED_VERSION="cccc 1.8.5"
CCCC_RELEASE_BINARY_SHA256="6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819"
CCCC_RELEASE_ARCHIVE_SHA256="7419ea8d8828c3d405694be400da1b21cdb854e9af1c10110d5d970bc1700094"

die() { echo "verify-nyorori: $*" >&2; exit 1; }
note() { echo "verify-nyorori: $*" >&2; }

# Where run directories live: NYORORI_VERIFY_ROOT, else <repo>/.nyorori-work/verify (gitignored).
evidence_root() { printf '%s\n' "${NYORORI_VERIFY_ROOT:-$REPO_ROOT/.nyorori-work/verify}"; }

# The measurer: NYORORI_CCCC, else the fetch script's default install path, else `cccc` on PATH.
resolve_cccc() {
  local c="${NYORORI_CCCC:-}"
  if [ -z "$c" ] && [ -x "$REPO_ROOT/.nyorori-work/cccc-v1.8.5/cccc" ]; then c="$REPO_ROOT/.nyorori-work/cccc-v1.8.5/cccc"; fi
  if [ -z "$c" ]; then c="$(command -v cccc 2>/dev/null || true)"; fi
  [ -n "$c" ] || return 1
  printf '%s\n' "$c"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# Loads <run-dir>/run.env into the current shell and checks the dir is a run of this skill.
load_run() {
  local dir="${1:-}"
  [ -n "$dir" ] || die "run directory argument is required (the path printed by scripts/new-run.sh)"
  [ -f "$dir/run.env" ] || die "$dir has no run.env; it is not a run directory made by scripts/new-run.sh"
  RUN_DIR="$(cd "$dir" && pwd -P)"
  # shellcheck disable=SC1091
  . "$RUN_DIR/run.env"
}

# Paths that scripts/cleanup.sh removes. Only ever scratch state, never evidence.
record_scratch() { printf '%s\n' "$2" >> "$1/scratch-paths.txt"; }

# Git for the throwaway repository: fixed identity, no signing, no user or system config.
tgit() { # <repo-dir> <git args...>
  local repo="$1"; shift
  HOME="$repo/../home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -C "$repo" -c user.name=verify -c user.email=verify@example.invalid -c commit.gpgsign=false "$@"
}

# Writes the exact, re-runnable command line for a capture directory.
write_command() { # <dir> <args...>  (args are what follows `node dist/cli.js`)
  local dir="$1"; shift
  { printf 'cd %q && node dist/cli.js' "$REPO_ROOT"; printf ' %q' "$@"; echo; } > "$dir/command.txt"
}
