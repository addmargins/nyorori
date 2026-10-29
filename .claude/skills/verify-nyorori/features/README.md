# nyorori verification map

This directory is the maintained source for verifying the user-facing behavior of nyorori. Read this index before driving the app, then use the matching feature file as the recipe. The harness is described in `../SKILL.md`; the scripts are in `../scripts/`.

## Baseline preconditions

- `npm run build` has produced `dist/cli.js` from the `src/` you mean to verify.
- The measurer resolves (`$NYORORI_CCCC`, `.nyorori-work/cccc-v1.8.5/cccc`, or `cccc` on `PATH`) and reports `cccc 1.8.5`.
- A run exists: `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh <label>)`. It owns a throwaway repository with branches `main`, `pass`, `fail`, `parse`, `tdel`, the policies `policy.json` (tests and coverage observe), `policy-enforce.json`, `policy-evidence.json`, `policy-badpin.json`, and its own work directory.
- `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK` and reported `39 fixtures, 0 drift(s)`.
- Never drive a `serve` instance this run did not start, and never point `run` at a repository other agents are working in.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. A fresh run is cheap (under five seconds); prefer it to reusing a run whose scratch was cleaned.
- Each shell call is a fresh shell: begin it with `RUN=<the run directory>`. Commands are literal; keep flags, labels and quoted values unchanged. Labels become directory names under the run.
- Drive gate runs through `scripts/gate.sh`, fixtures through `scripts/fixtures.sh`, replay through `scripts/replay.sh`, the service through `scripts/serve.sh`. Pass `--expect` and `--code` so the helper's exit status is itself the check.
- Revisions name commits of the throwaway repository (`main`, `pass`, `fail`, `parse`, `tdel`); the full shas are in `$RUN/run.env` (`BASE`, `PASS`, `FAIL`, `PARSE`, `TDEL`).
- Assert on stable handles: exit codes, `quality-gate.json` fields (`state`, `mergeAllowed`, `authority`, `reasons`, `gates[]`), `### gate/<id>: <STATE>` headings and `- **<REASON>**` bullets in `gate-summary.md`, HTTP statuses and `"msg"` values in the service log. Never match on Korean prose.
- Mutations happen only inside the run's scratch. Run `scripts/cleanup.sh "$RUN"` afterwards; it removes scratch and keeps every capture.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final line: `command.txt`, `exit-code`, `stdout.txt`, `stderr.txt` and the `out/` files for a gate run; `requests.log`, `stderr.txt` and `state/` for the service.
- A verdict proof names the state, the reason codes and the gate under test's `gate-result.<gate>.json`. A CLI refusal proof includes the stderr message and the absence of the refused output.
- Side effects count: the files `--out` wrote, the service's `deliveries.log` and `jobs/<owner>/<repo>/<delivery>.json`, the process being gone after `stop`.
- Record the feature ID and the entry point used with every artifact (the label you gave the helper is that record).
- Report an unreachable path with the attempted command and the unmet precondition (for example "no GitHub App installation reachable from this machine").
- Do not report a skipped entry point as verified through a different path, and do not weaken a journey (looser policy, observe mode, `--allow-repo-paths`) to make it pass unless the feature file says that is the journey.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-nyorori` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Judge a change with `run`](./run-verdict.md) covers PASS, FAIL and INCONCLUSIVE verdicts, exit codes 0/1/2, the `--out` artifacts, the local-authority stamp and `--in-process`.
- [Input guards and exit codes](./run-input-guards.md) covers the path guard (exit 64), usage errors, a directory that is not a repository, a missing measurer and a measurer whose hash differs from the policy pin.
- [Tests gate evidence (G4)](./tests-evidence.md) covers an enforcing policy without artifacts, a deleted test, and `--artifacts` with and without workflow provenance.
- [Measurer fixtures check](./measurer-fixtures.md) covers `nyorori fixtures` against the tracked fixtures and against a tampered copy.
- [Replay a dataset](./replay.md) covers `nyorori replay` over a pairs file and its report files.
- [Service webhook intake (`serve`)](./serve-webhook.md) covers startup, `/healthz`, signature verification, accepted and duplicate deliveries, event/payload mismatch, the journal, shutdown, and the GitHub-dependent publication path that cannot be driven offline.

Not yet mapped (drive by hand, then add a file): `--pr` and `--comments` inputs (waivers, `/simplification-review`, `/gate-override` comment commands), the moving-baseline triggers, the AI fix loop (`gate-feedback.json` across attempts), `NYORORI_WORKER_COMMAND` container isolation, `NYORORI_SIGNER=command`.
