#!/usr/bin/env bash
# Builds a `nyorori replay` dataset from the most recently merged pull requests
# of a GitHub repository (spec 6.1: "replay about 200 recent PRs").
#
# For each merged PR, `gh` reports mergeCommit. The pair is
#   candidate = mergeCommit            base = mergeCommit^1
# which means:
#   - squash merges: the candidate is the squash commit on the base branch and
#     the base is its parent (the base branch just before the merge);
#   - merge commits: the candidate is the merge commit itself and the base is
#     its first parent (the base branch before the merge), so the diff is what
#     the PR brought onto the base branch, as merge_group judges it (spec 6.2);
#   - rebase merges: GitHub reports the last rebased commit; its parent is the
#     previous rebased commit, so a multi-commit rebase-merged PR replays only
#     its last commit. Prefer squash or merge commits for the dataset.
# PRs whose merge commit is not in the local clone are skipped with a warning
# (run `git fetch` first). The output must be written OUTSIDE the repository.
#
# Usage: scripts/build-replay-pairs.sh -R owner/repo -C <clone dir> [-n 200] [-o pairs.json]
set -euo pipefail

REPO=""
CLONE="."
LIMIT=200
OUT="pairs.json"
while getopts "R:C:n:o:h" opt; do
  case "$opt" in
    R) REPO="$OPTARG" ;;
    C) CLONE="$OPTARG" ;;
    n) LIMIT="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    *) sed -n '2,20p' "$0"; exit 64 ;;
  esac
done
[ -n "$REPO" ] || { echo "build-replay-pairs: -R owner/repo is required" >&2; exit 64; }
[ "$LIMIT" -ge 1 ] && [ "$LIMIT" -le 1000 ] || { echo "build-replay-pairs: -n must be 1..1000" >&2; exit 64; }
command -v gh >/dev/null || { echo "build-replay-pairs: gh is required" >&2; exit 69; }

out_dir=$(cd "$(dirname "$OUT")" && pwd -P)
repo_dir=$(git -C "$CLONE" rev-parse --show-toplevel)
repo_real=$(cd "$repo_dir" && pwd -P)
case "$out_dir/" in
  "$repo_real"/*) echo "build-replay-pairs: $OUT is inside the repository; write the dataset outside it" >&2; exit 64 ;;
esac

# "number<TAB>sha" lines, newest first.
rows=$(gh pr list -R "$REPO" --state merged --limit "$LIMIT" --json number,mergeCommit \
  --jq '.[] | select(.mergeCommit != null) | "\(.number)\t\(.mergeCommit.oid)"')

pairs=""
skipped=0
while IFS=$'\t' read -r number sha; do
  [ -n "$number" ] || continue
  if ! git -C "$repo_dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "build-replay-pairs: PR #$number merge commit $sha not in $repo_dir; skipped (git fetch?)" >&2
    skipped=$((skipped + 1))
    continue
  fi
  if ! base=$(git -C "$repo_dir" rev-parse --verify --quiet "${sha}^1"); then
    echo "build-replay-pairs: PR #$number merge commit $sha has no parent; skipped" >&2
    skipped=$((skipped + 1))
    continue
  fi
  pairs+="PR-${number}"$'\t'"${base}"$'\t'"${sha}"$'\n'
done <<< "$rows"

printf '%s' "$pairs" | node -e '
  const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  const pairs = lines.map((l) => { const [id, base, candidate] = l.split("\t"); return { id, base, candidate }; });
  process.stdout.write(JSON.stringify({ schema_version: 1, repository: process.argv[1], pairs }, null, 2) + "\n");
' "$REPO" > "$OUT"
count=$(printf '%s' "$pairs" | grep -c . || true)
echo "build-replay-pairs: wrote $count pair(s) to $OUT ($skipped skipped)" >&2
[ "$count" -ge 1 ] || exit 1
