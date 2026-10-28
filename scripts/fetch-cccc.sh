#!/usr/bin/env bash
# Fail-closed installer for the pinned measurer: cccc v1.8.5 (commit af2abb8f5),
# release asset cccc-v1.8.5-x86_64-unknown-linux-musl.tar.gz.
#
# Runs in the trusted control plane only, never in candidate CI. Every step
# must agree or the script exits non-zero and installs nothing:
#   1. the archive's sha256 equals the constant pinned below,
#   2. the release's own `.sha256` file says the same,
#   3. `gh attestation verify` accepts the archive's SLSA provenance,
#   4. `gh release verify-asset` confirms the asset belongs to the release,
#   5. exactly one named member (`cccc`) is extracted, its sha256 equals the
#      pinned binary hash, and it reports `cccc 1.8.5`.
# The binary hash printed last is the value for `measurer.cccc_sha256`.
#
# Usage: scripts/fetch-cccc.sh [dest-dir]        (prints "<sha256>  <path>")
# Env:   CCCC_FROM_SOURCE=1  build the tag from source instead (development
#        only: the result is NOT the release binary and must not be pinned).
set -euo pipefail

VERSION="v1.8.5"
COMMIT="af2abb8f5"
REPO="moznion/cccc"
ASSET="cccc-${VERSION}-x86_64-unknown-linux-musl"
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

# Pinned hashes, taken from the v1.8.5 release on 2026-10-28 (archive hash
# cross-checked against the release's .sha256 file). To re-pin after an
# upgrade: download the new archive, verify it with steps 2-4 by hand, then
# update VERSION, COMMIT, both constants and the policy (spec 6.1).
ARCHIVE_SHA256="7419ea8d8828c3d405694be400da1b21cdb854e9af1c10110d5d970bc1700094"
BINARY_SHA256="6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819"

DEST="${1:-${PWD}/.nyorori-work/cccc-${VERSION}}"
case "$DEST" in /*) ;; *) DEST="${PWD}/${DEST}" ;; esac
BIN="${DEST}/cccc"

die() { echo "fetch-cccc: $*" >&2; exit 1; }

check_sha() { # <expected> <file>
  printf '%s  %s\n' "$1" "$2" | sha256sum --check --strict --quiet || die "sha256 mismatch for $2 (expected $1)"
}

fetch_release() {
  case "$(uname -sm)" in "Linux x86_64") ;; *) die "the pinned asset is Linux x86_64 only; got $(uname -sm)" ;; esac
  command -v gh >/dev/null || die "gh is required for attestation and release verification"
  gh attestation verify --help >/dev/null 2>&1 || die "gh attestation verify is not available; upgrade gh"
  gh release verify-asset --help >/dev/null 2>&1 || die "gh release verify-asset is not available; upgrade gh"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  local curl_opts=(--fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2)
  curl "${curl_opts[@]}" -o "$tmp/$ASSET.tar.gz" "$BASE_URL/$ASSET.tar.gz"
  curl "${curl_opts[@]}" -o "$tmp/$ASSET.sha256" "$BASE_URL/$ASSET.sha256"

  check_sha "$ARCHIVE_SHA256" "$tmp/$ASSET.tar.gz"
  (cd "$tmp" && sha256sum --check --strict --quiet "$ASSET.sha256") || die "the release .sha256 file does not match the archive"
  gh attestation verify "$tmp/$ASSET.tar.gz" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release-build.yml" || die "attestation verification failed"
  gh release verify-asset "$VERSION" "$tmp/$ASSET.tar.gz" --repo "$REPO" || die "release asset verification failed"

  # One named member, streamed out: archive paths are never trusted.
  tar -xOzf "$tmp/$ASSET.tar.gz" cccc > "$tmp/cccc" || die "the archive has no member named cccc"
  check_sha "$BINARY_SHA256" "$tmp/cccc"
  chmod 0755 "$tmp/cccc"
  mkdir -p "$DEST"
  install -m 0755 "$tmp/cccc" "$BIN"
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
  cat >&2 <<'EOF'
################################################################################
# WARNING: NOT THE RELEASE BINARY.                                             #
# This cccc was built from source. Its sha256 differs from the attested        #
# release asset. Do not pin this hash in a production policy; use it only for  #
# local experiments with measurer.allow_unpinned: true.                        #
################################################################################
EOF
}

if [ "${CCCC_FROM_SOURCE:-0}" = "1" ]; then
  build_source
else
  fetch_release
fi

got_version="$("$BIN" --version)"
[ "$got_version" = "cccc 1.8.5" ] || die "unexpected version: $got_version"
sha="$(sha256sum "$BIN" | cut -d' ' -f1)"
if [ "${CCCC_FROM_SOURCE:-0}" != "1" ] && [ "$sha" != "$BINARY_SHA256" ]; then
  die "installed binary hash $sha differs from the pin $BINARY_SHA256"
fi
echo "$sha  $BIN"
