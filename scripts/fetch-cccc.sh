#!/usr/bin/env bash
# Obtain the pinned measurer: cccc v1.8.5 (commit af2abb8f5).
#
# Preferred path: download the release asset, verify its build provenance with
# `gh attestation verify`, and compare the sha256 with the policy pin.
# Fallback (no release access): build the tag from source with cargo. A source
# build has a different sha256 than the release asset, so the policy pin must
# be the hash of whichever binary the gate service actually runs.
#
# Usage: scripts/fetch-cccc.sh [dest-dir]     (prints "<sha256>  <path>")
# Env:   CCCC_EXPECTED_SHA256  fail unless the resulting binary has this hash
#        CCCC_FROM_SOURCE=1    skip the release download
set -euo pipefail

VERSION="v1.8.5"
COMMIT="af2abb8f5"
REPO="moznion/cccc"
ASSET="cccc-${VERSION}-x86_64-unknown-linux-musl.tar.gz"
DEST="${1:-${PWD}/.nyorori-work/cccc-${VERSION}}"
mkdir -p "$DEST"
BIN="$DEST/cccc"

fetch_release() {
  command -v gh >/dev/null || return 1
  local tmp
  tmp="$(mktemp -d)"
  gh release download "$VERSION" --repo "$REPO" --pattern "$ASSET" --dir "$tmp" || return 1
  gh attestation verify "$tmp/$ASSET" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release-build.yml" || { echo "attestation failed" >&2; exit 1; }
  tar -xzf "$tmp/$ASSET" -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name cccc | head -n1)" "$BIN"
  rm -rf "$tmp"
}

build_source() {
  command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }
  local src="$DEST/src"
  if [ ! -d "$src/.git" ]; then
    git clone --depth 1 --branch "$VERSION" "https://github.com/$REPO" "$src"
  fi
  local head
  head="$(git -C "$src" rev-parse HEAD)"
  case "$head" in
    "$COMMIT"*) ;;
    *) echo "tag $VERSION resolves to $head, expected $COMMIT" >&2; exit 1 ;;
  esac
  (cd "$src" && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo build --release --locked -p cccc-cli)
  install -m 0755 "$src/target/release/cccc" "$BIN"
}

if [ ! -x "$BIN" ]; then
  if [ "${CCCC_FROM_SOURCE:-0}" = "1" ] || ! fetch_release; then
    build_source
  fi
fi

got_version="$("$BIN" --version)"
[ "$got_version" = "cccc 1.8.5" ] || { echo "unexpected version: $got_version" >&2; exit 1; }
sha="$(sha256sum "$BIN" | cut -d' ' -f1)"
if [ -n "${CCCC_EXPECTED_SHA256:-}" ] && [ "$sha" != "$CCCC_EXPECTED_SHA256" ]; then
  echo "sha256 mismatch: got $sha, expected $CCCC_EXPECTED_SHA256" >&2
  exit 1
fi
echo "$sha  $BIN"
