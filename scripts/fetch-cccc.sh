#!/usr/bin/env bash
# Fail-closed installer for the pinned measurer: cccc v1.8.5 (commit af2abb8f5),
# release asset cccc-v1.8.5-x86_64-unknown-linux-musl.tar.gz (spec 6.1).
#
# Runs in the trusted control plane only, never in candidate CI. Every step
# must agree or the script exits non-zero and installs nothing:
#   1. the archive's sha256 equals ARCHIVE_SHA256 below,
#   2. the release's own `.sha256` file says the same,
#   3. `gh attestation verify` accepts the archive's build provenance,
#   4. `gh release verify-asset` confirms the asset belongs to the release,
#   5. exactly one named member (`cccc`) is extracted, its sha256 equals
#      BINARY_SHA256 and it reports `cccc 1.8.5`.
# The line printed last ("<sha256>  <path>") is the value for `measurer.cccc_sha256`.
#
# Usage: scripts/fetch-cccc.sh [dest-dir]        (default .nyorori-work/cccc-v1.8.5)
# Env:   CCCC_FROM_SOURCE=1  build the tag from source instead. Development
#        only: the result is NOT the release binary and must never be pinned.
set -euo pipefail

VERSION="v1.8.5"
COMMIT="af2abb8f5"
REPO="moznion/cccc"
ASSET="cccc-${VERSION}-x86_64-unknown-linux-musl"
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

# Pinned hashes of the v1.8.5 release (recorded 2026-10-28 from the downloaded
# archive, cross-checked against the release's .sha256 file and the extracted
# member). To re-pin after an upgrade: download the new archive, run steps 2-4
# by hand, then update VERSION, COMMIT, both constants and the policy pin.
ARCHIVE_SHA256="7419ea8d8828c3d405694be400da1b21cdb854e9af1c10110d5d970bc1700094"
BINARY_SHA256="6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819"

DEST="${1:-${PWD}/.nyorori-work/cccc-${VERSION}}"
case "$DEST" in /*) ;; *) DEST="${PWD}/${DEST}" ;; esac
BIN="${DEST}/cccc"

die() { echo "fetch-cccc: $*" >&2; exit 1; }

check_sha() { # <expected> <file>
  printf '%s  %s\n' "$1" "$2" | sha256sum --check --strict --quiet >/dev/null 2>&1 \
    || die "sha256 mismatch for $2 (expected $1, got $(sha256sum "$2" | cut -d' ' -f1))"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_release() {
  case "$(uname -sm)" in "Linux x86_64") ;; *) die "the pinned asset is Linux x86_64 only; got $(uname -sm)" ;; esac
  command -v gh >/dev/null || die "gh is required for attestation and release verification"
  command -v curl >/dev/null || die "curl is required"
  gh attestation verify --help >/dev/null 2>&1 || die "gh attestation verify is not available; upgrade gh"
  gh release verify-asset --help >/dev/null 2>&1 || die "gh release verify-asset is not available; upgrade gh"

  local curl_opts=(--fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2)
  curl "${curl_opts[@]}" -o "$TMP/$ASSET.tar.gz" "$BASE_URL/$ASSET.tar.gz" || die "download of $ASSET.tar.gz failed"
  curl "${curl_opts[@]}" -o "$TMP/$ASSET.sha256" "$BASE_URL/$ASSET.sha256" || die "download of $ASSET.sha256 failed"

  # 1. the pin, 2. the release's own digest file (it names the archive, so check from its directory)
  check_sha "$ARCHIVE_SHA256" "$TMP/$ASSET.tar.gz"
  grep -qx "$ARCHIVE_SHA256  $ASSET.tar.gz" "$TMP/$ASSET.sha256" || die "the release .sha256 file does not match the pinned archive hash"
  (cd "$TMP" && sha256sum --check --strict --quiet "$ASSET.sha256" >/dev/null 2>&1) || die "the release .sha256 file does not match the archive"
  # 3. provenance, 4. release membership
  gh attestation verify "$TMP/$ASSET.tar.gz" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release-build.yml" || die "attestation verification failed"
  gh release verify-asset "$VERSION" "$TMP/$ASSET.tar.gz" --repo "$REPO" || die "release asset verification failed"

  # 5. one named member, streamed out: archive paths and modes are never trusted.
  tar -xOzf "$TMP/$ASSET.tar.gz" cccc > "$TMP/cccc" || die "the archive has no member named cccc"
  [ -s "$TMP/cccc" ] || die "the archive member cccc is empty"
  check_sha "$BINARY_SHA256" "$TMP/cccc"
  chmod 0755 "$TMP/cccc"
  mkdir -p "$DEST"
  install -m 0755 "$TMP/cccc" "$BIN"
}

build_source() {
  command -v cargo >/dev/null || die "cargo not found"
  local src="$DEST/src"
  if [ ! -d "$src/.git" ]; then
    git clone --depth 1 --branch "$VERSION" "https://github.com/$REPO" "$src"
  fi
  local head
  head="$(git -C "$src" rev-parse HEAD)"
  case "$head" in "$COMMIT"*) ;; *) die "tag $VERSION resolves to $head, expected $COMMIT" ;; esac
  (cd "$src" && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo build --release --locked -p cccc-cli)
  mkdir -p "$DEST"
  install -m 0755 "$src/target/release/cccc" "$BIN"
  cat >&2 <<'WARN'
################################################################################
# WARNING: NOT THE RELEASE BINARY.                                             #
# This cccc was built from source (CCCC_FROM_SOURCE=1). Its sha256 differs     #
# from the attested release asset. Do not pin this hash in a production        #
# policy; use it only for local experiments with measurer.allow_unpinned.      #
################################################################################
WARN
}

if [ "${CCCC_FROM_SOURCE:-0}" = "1" ]; then
  build_source
else
  fetch_release
fi

got_version="$("$BIN" --version)" || die "the installed binary does not run"
[ "$got_version" = "cccc 1.8.5" ] || die "unexpected version: $got_version"
sha="$(sha256sum "$BIN" | cut -d' ' -f1)"
if [ "${CCCC_FROM_SOURCE:-0}" != "1" ] && [ "$sha" != "$BINARY_SHA256" ]; then
  die "installed binary hash $sha differs from the pin $BINARY_SHA256"
fi
echo "$sha  $BIN"
