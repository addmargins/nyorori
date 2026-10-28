#!/usr/bin/env bash
set -euo pipefail
# Production installer: requires a recent gh supporting both attestation and verify-asset.
# This command must run in the trusted control plane, never candidate CI.
case "$(uname -sm)" in 'Linux x86_64') ;; *) echo 'Pinned installer supports Linux x86_64 only' >&2; exit 2 ;; esac
DEST="${1:?usage: install-cccc.sh ABSOLUTE_DEST_OUTSIDE_CANDIDATE}"
case "$DEST" in /*) ;; *) echo 'Destination must be absolute' >&2; exit 2 ;; esac
gh attestation verify --help >/dev/null
gh release verify-asset --help >/dev/null
TASK_TMP="$(mktemp -d)"
trap 'rm -rf "$TASK_TMP"' EXIT
ASSET='cccc-v1.8.5-x86_64-unknown-linux-musl'
cd "$TASK_TMP"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 -o "$ASSET.tar.gz" "https://github.com/moznion/cccc/releases/download/v1.8.5/$ASSET.tar.gz"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 -o "$ASSET.sha256" "https://github.com/moznion/cccc/releases/download/v1.8.5/$ASSET.sha256"
sha256sum --check "$ASSET.sha256"
gh attestation verify "$ASSET.tar.gz" --repo moznion/cccc --signer-workflow moznion/cccc/.github/workflows/release-build.yml
gh release verify-asset v1.8.5 "$ASSET.tar.gz" --repo moznion/cccc
# Extract a single known member rather than trusting archive paths.
tar -xOf "$ASSET.tar.gz" cccc > cccc
printf '%s  cccc\n' '6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819' | sha256sum --check
chmod 0755 cccc
./cccc --version | grep -x 'cccc 1.8.5'
mkdir -p "$DEST"
install -m 0755 cccc "$DEST/cccc"
