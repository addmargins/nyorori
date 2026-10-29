# Replay a dataset

`nyorori replay` judges every `(base, candidate)` pair of a `pairs.json` dataset under the current policy and measurer (and once more under a comparison policy or binary when given), writes each pair's run artifacts plus `replay-result.json` and `replay-summary.md`, and exits 0 when nothing changed, 1 on deltas, 2 on run errors.

## Sub-features

- `replay-run` two pairs replay to `pass=PASS`, `fail=FAIL` with exit 0 and no deltas (single-sided check).
- `replay-files` `<out>/replay-result.json`, `<out>/replay-summary.md`, and `<out>/<id>/current/` with the same fifteen files as `run --out`.
- `replay-progress` stderr shows one `replay [i/n] <id> <STATE>` line per pair; stdout ends with the one-line summary naming `replay-summary.md`.

## How to get to it (user POV)

- Run `node dist/cli.js replay --repo <dir> --pairs <pairs.json> --policy <file.json> --out <dir> [--compare-policy <file>] [--compare-cccc <bin>] [--jobs <n>]` in a terminal; `scripts/build-replay-pairs.sh` builds a dataset from a GitHub repository's merged PRs.
- Run `node dist/cli.js replay --help` for the full flag list.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh replay)` and `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK`.
- The dataset is written by the helper from `BASE`, `PASS`, `FAIL` in `run.env` (full 40-hex shas; refs are rejected by the dataset schema).

- **Replay.** Run `.claude/skills/verify-nyorori/scripts/replay.sh "$RUN"`. It prints `replay exit=0 pairs=pass=PASS,fail=FAIL :: replay: exit 0 — 0 changed, 0 errored, 0 service-INCONCLUSIVE of 2 pairs; see .../replay-summary.md` and exits 0.
- **Files.** Run `ls "$RUN/replay/out" "$RUN/replay/out/fail/current"`. The first listing is `fail pass replay-result.json replay-summary.md`; the second is the fifteen `run --out` files. `$RUN/replay/out/fail/current/quality-gate.json` has `"state": "FAIL"`.
- **Report.** Run `head -1 "$RUN/replay/out/replay-summary.md"; cat "$RUN/replay/stderr.txt"`. The summary starts `# replay: NO DELTAS — 2 pairs, 0 changed, 0 errored, 0 service-INCONCLUSIVE`; stderr is `replay [1/2] pass PASS` and `replay [2/2] fail FAIL`. `replay-result.json` has `exit_code: 0`, `counts: {"pairs":2,"completed":2,"changed":0,"errored":0,"service_inconclusive":0}` and `pairs[].current.state`.
- **Proof.** `$RUN/replay/{pairs.json,command.txt,stdout.txt,stderr.txt,exit-code,result.txt,out/}`; then `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"`.

## Gotchas

- `pairs.json`, every path it names and `--out` must be outside `--repo`; the helper keeps them in the run directory.
- Pair ids become directory names (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`), shas must be full lowercase 40-hex, base and candidate must differ, at most 1000 pairs.
- Without `--compare-policy`/`--compare-cccc` there is nothing to diff, so "no deltas" is a recovery check, not an upgrade check; to verify delta reporting, re-run `command.txt` with `--compare-policy "$RUN/policy-enforce.json"` and expect exit 1 with the `tests` gate listed under `판정 차이 (deltas)`.
- Replays are local (`authority: local`); they touch no checks, waivers or ledgers.
