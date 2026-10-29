---
name: verify-nyorori
description: "Drive nyorori, the cccc-based merge quality gate for JS/TS repositories, the way a user does: its CLI (node dist/cli.js run, fixtures, replay) against a throwaway git repository, and its GitHub App webhook service (serve) offline, capturing verdict JSON, exit codes, summaries and service state as evidence. Use it after changing the gates, the pipeline, the CLI, reporting or the service, to prove a verdict, an exit code or an artifact with captured evidence instead of a unit test or a self-report."
---

# Verify nyorori

nyorori judges a `(base, candidate)` commit pair of a JS/TS repository with the `cccc` complexity measurer and a JSON policy, writes a verdict (`quality-gate.json`), a Korean summary (`gate-summary.md`) and per-gate results, and exits `0` PASS/N/A/waived, `1` FAIL, `2` INCONCLUSIVE, `64` usage error. The primary surface is the CLI, `node dist/cli.js` (`run`, `fixtures`, `replay`). The secondary surface is the GitHub App service, `node dist/cli.js serve`, which verifies webhook signatures, evaluates pull requests through the same pipeline and publishes check runs. There is no UI and nothing interactive: every drive is one short process, so no tmux or PTY is involved.

All paths below are relative to the repository root (the directory with `package.json`). Helper scripts live in `.claude/skills/verify-nyorori/scripts/`; each prints its usage in its header. Shell state does not survive between tool calls, so put `RUN=<run dir>` at the top of every call that uses it, never rely on an exported variable from an earlier call, and keep the printed run directory in your notes.

## Launch

1. **Build once, rebuild after every `src/` change.** `npm ci` (first time only), then `npm run build`. It compiles `src/` to `dist/` and makes `dist/cli.js` executable. The isolated worker (`dist/pipeline/worker.js`) and the CLI both run from `dist/`, so a stale build judges stale code; `doctor` warns when `src/` is newer than `dist/cli.js`.
2. **Have the measurer, cccc 1.8.5.** Every policy pins `cccc_version: "cccc 1.8.5"`; another version makes every run `MEASURER_MISMATCH`. The scripts look for it in this order: `$NYORORI_CCCC`, then `.nyorori-work/cccc-v1.8.5/cccc` (gitignored, the fetch script's default destination), then `cccc` on `PATH`. Ways to obtain it:
   - `scripts/fetch-cccc.sh .nyorori-work/cccc-v1.8.5` downloads the release asset and verifies sha256, the release `.sha256` file, `gh attestation verify` and `gh release verify-asset`. It needs network, `gh`, and reachable Sigstore/TUF endpoints; behind a proxy that blocks those it dies at "attestation verification failed" and installs nothing. Do not try to make it pass by skipping steps.
   - Manual, same pins: download `https://github.com/moznion/cccc/releases/download/v1.8.5/cccc-v1.8.5-x86_64-unknown-linux-musl.tar.gz` into an empty directory, check `sha256sum` prints `7419ea8d8828c3d405694be400da1b21cdb854e9af1c10110d5d970bc1700094`, extract only the member `cccc` (`tar -xOzf <archive> cccc > cccc`), check its sha256 is `6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819`, `chmod 0755 cccc`, then `export NYORORI_CCCC=<its path>` or move it to `.nyorori-work/cccc-v1.8.5/cccc`.
   - A source build (`CCCC_FROM_SOURCE=1 scripts/fetch-cccc.sh <dir>`, needs cargo) also works for verification: the run policies pin the sha256 of whatever binary you use. Its hash must never be pinned in a real policy.
3. **Create a run.** `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh <label>)` prints the run directory and creates, under it: the policies (`policy.json` with tests and coverage in observe mode, `policy-enforce.json` with the default modes, `policy-evidence.json` with a trusted workflow, `policy-badpin.json` with a wrong measurer hash; all pin the measurer's real sha256), `run.env` (every path and commit sha the other scripts use), `repo.log` (the throwaway repository's history), and `scratch/` holding the throwaway repository at `scratch/repo` with branches `main` (base: `applyDiscount` with Cognitive Complexity 4 and one test), `pass` (CogC 15), `fail` (CogC 16), `parse` (adds an unparsable file), `tdel` (`pass` with the test deleted), plus `scratch/work` for the gate's work directory. Runs live under `.nyorori-work/verify/<timestamp>-<pid>-<label>/` (gitignored); set `NYORORI_VERIFY_ROOT` to put them elsewhere. Each run has its own repository, work directory, service port and work dir, so runs can proceed side by side, including runs by other agents.
4. **Service, only for the `serve-webhook` feature.** `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" start` generates an RSA App key, picks a free `127.0.0.1` port, starts `node dist/cli.js serve --port <port>` with `env -i` and the `NYORORI_*` variables the README documents, and waits for the ready signal: the stderr log `$RUN/serve/stderr.txt` contains `{"msg":"journal",...}` followed by `{"msg":"listening","port":<port>}`. A process that answers before that line is not ready. Teardown is `serve.sh "$RUN" stop` (or `cleanup.sh`). Never drive a `serve` instance this run did not start: `serve.sh` only talks to the pid and port recorded in `$RUN/serve/serve.env`.

## Doctor

`.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` (the argument is optional; with it the report is also saved as `$RUN/doctor.txt`). Read-only. It checks node >= 22, git, that `dist/cli.js` runs and is newer than `src/`, that the measurer resolves, is executable, reports `cccc 1.8.5` and whether its sha256 is the release pin, and it runs the real measurer over the 39 calculation-rule fixtures (`node dist/cli.js fixtures --cccc <bin>`), expecting `39 fixtures, 0 drift(s)`. The last line is `DOCTOR OK` (exit 0) or `DOCTOR FAIL` (exit 1). Run it first, and again whenever a verdict looks wrong before suspecting the gate.

## Drive

Pick the feature file in `features/` and follow its recipe; the commands below are the harness it uses.

- **One gate run** (the main user path): `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" <label> [--expect <STATE>] [--code <n>] -- --base <rev> --candidate <rev> [--policy <file>] [--artifacts <dir>] [--in-process]`. Revisions are resolved in the throwaway repository, so `main`, `pass`, `fail`, `parse`, `tdel` or the full shas in `run.env` all work. The script appends `--repo`, `--cccc`, `--workdir` and `--out $RUN/<label>/out` (and `--policy $RUN/policy.json` when you give none), runs `node dist/cli.js run ...` from the repository root, captures everything, prints one result line and exits 1 when `--expect`/`--code` do not match what happened. `--raw` appends only `--cccc` and `--workdir`; use it when the test is about `--repo`, `--policy` or `--out` themselves (usage errors, the path guard).
- **Measurer fixtures:** `.claude/skills/verify-nyorori/scripts/fixtures.sh "$RUN" [--tamper]`.
- **Replay:** `.claude/skills/verify-nyorori/scripts/replay.sh "$RUN"` (pairs `main->pass`, `main->fail`).
- **Workflow evidence for the tests gate:** `ART=$(.claude/skills/verify-nyorori/scripts/make-artifacts.sh "$RUN" pass [--no-provenance])`, then `gate.sh ... --policy "$RUN/policy-evidence.json" --artifacts "$ART"`.
- **Service:** `serve.sh "$RUN" start | payload pull_request | get /healthz | post <event> <delivery-id> <payload.json> [--unsigned|--secret <s>] | snapshot | status | stop`.
- **Anything else:** run `node dist/cli.js ...` yourself from the repository root with `--repo "$RUN/scratch/repo" --cccc <CCCC from run.env> --workdir "$RUN/scratch/work" --out "$RUN/<label>/out"`, and keep the command, stdout, stderr and exit code next to `out/`. Policy, measurer, `--out`, `--artifacts` and the work directory must all be outside `--repo`, or the CLI refuses with exit 64.

Stable handles to assert on (the summary prose is Korean; do not match on it):
- `quality-gate.json`: `state`, `mergeAllowed`, `authority` (`"local"` for every CLI run), `reasons` (codes such as `OVER_LIMIT`, `PARSE_ERROR_CANDIDATE`, `REPORT_MISSING`, `TEST_REMOVED`, `UNTRUSTED_ARTIFACT`, `FINGERPRINT_MISMATCH`), `gates[]` with `gate`, `mode`, `state`, `base_sha`, `candidate_sha`, `policy_revision`.
- `gate-summary.md`: line 1 starts with `_authority: local`, line 2 is `## quality-gate: <STATE> — ...`, per-gate headings `### gate/<id>: <STATE>`, violation bullets `- **<REASON>** ...`.
- `gate-result.<gate>.json`: `state`, `mode`, `violations[]` (`reason`, `unit`, `before`, `after`, `limit`), `inconclusive[]` (`reason`, `detail`, `authorFixable`).
- Exit codes `0/1/2/64`; `serve` HTTP statuses `200/202/400/401/405` and its JSON log lines on stderr (`msg` field).

## Evidence

Everything a drive produces stays in the run directory, which is the proof location:

```
$RUN/
  run.env  policy*.json  repo.log  doctor.txt          # what was judged, with which policy and measurer
  <label>/command.txt stdout.txt stderr.txt exit-code result.txt
  <label>/out/quality-gate.json gate-summary.md gate-feedback.json manifest.json gate-result.<gate>.json raw.B.json raw.C.json ...
  fixtures*/ replay/ artifacts-*/                      # the other commands, same capture shape
  serve/serve.env stdout.txt stderr.txt requests.log state/{deliveries.log,jobs/...} payload-*.json
  scratch/                                             # NOT evidence: removed by cleanup
```

Proof standards for anything you report as verified:
- Exercise the real user path: the built CLI on a real git repository, `serve` over real HTTP with a signed body. Do not call `runGates()` from a script or import the pipeline; that is a test, not a verification.
- Capture the action and the resulting state: the exact command (`command.txt`), the exit code, and the written state (`quality-gate.json`, the summary, the gate result for the gate under test), not only a printed line.
- Verify side effects where the feature has them: the fifteen files `--out` writes, the `deliveries.log` and `jobs/<owner>/<repo>/<delivery>.json` the service journals, the absence of `--out` inside the judged repository after a refusal.
- Mocks only at a production boundary: the service's GitHub API calls are such a boundary (`GitHubApi` takes a fetch implementation and an API base in code), but `serve` exposes no switch for it, so offline the service is proven up to the point where it calls GitHub and that limit is reported, not papered over.
- A run that cannot be driven (missing precondition, blocked network) is reported as unreached with the command and the reason. It is never reported as verified through a different path, and a journey is never weakened to make it pass.

The strongest proof is the helper's own `--expect`/`--code` check plus the result line; keep the run directory and quote its path in your report so a reviewer can re-run `command.txt`.

## Cleanup

`.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"` stops the run's `serve` instance if it is still alive (by the recorded pid, after snapshotting its state), removes `$RUN/scratch` (throwaway repository, work directories, service work dir and key) and nothing else, then lists the evidence that survived and exits 1 if `run.env`, `policy.json` or `repo.log` went missing. Run it after every attempt, including failed ones, so no `serve` process or work directory is stranded. Delete a whole run directory only when its evidence has been reported or is no longer needed. The gate also leaves `nyorori-worker-home-*` and `nyorori-cccc-home-*` directories in the system temp dir for the duration of a run; they are the pipeline's own and are removed by it.

## Helpers

| Script | Invocation | Purpose |
| --- | --- | --- |
| `scripts/doctor.sh` | `doctor.sh [run-dir]` | Read-only health check; `DOCTOR OK` or `DOCTOR FAIL`. |
| `scripts/new-run.sh` | `RUN=$(new-run.sh [label])` | Run directory, policies, throwaway repository; prints the run dir. |
| `scripts/gate.sh` | `gate.sh <run-dir> <label> [--expect S] [--code n] [--raw] -- <run args>` | One `nyorori run` with full capture and expectation check. |
| `scripts/fixtures.sh` | `fixtures.sh <run-dir> [--tamper]` | `nyorori fixtures` pristine or against a tampered scratch copy. |
| `scripts/replay.sh` | `replay.sh <run-dir> [label]` | `nyorori replay` of the pass and fail pairs. |
| `scripts/make-artifacts.sh` | `ART=$(make-artifacts.sh <run-dir> <ref> [--no-provenance])` | Required-workflow artifact dir for `--artifacts`. |
| `scripts/serve.sh` | `serve.sh <run-dir> start\|status\|payload\|get\|post\|snapshot\|stop` | Own, drive and stop one `serve` instance. |
| `scripts/cleanup.sh` | `cleanup.sh <run-dir>` | Tear down scratch and the service; keep the evidence. |

All scripts are bash, use only `node`, `git`, `sha256sum`, `pgrep` and coreutils, and take the run directory as their first argument.

## Feature map

`features/README.md` is the index; one file per user-facing feature, each with `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-nyorori` and `Gotchas`. Drive the feature your change touches; when the map lists several entry points, driving one of them is a partial proof and your report says which were not driven. Keep the map honest: `/pstack:maintain-verification-skill`.

## Known traps

- **`serve` refuses to start on an empty work dir** (checkout as of this skill's creation): `cmdServe` checks the ledger path against `<NYORORI_WORKDIR>/mirrors` with `assertToolsOutsideRepo`, which compares the deepest *existing* ancestors; when neither `mirrors/` nor `waivers.jsonl` exists yet both resolve to the work dir and the default ledger is rejected as "inside the measured repository" (exit 64, before the listener opens). `serve.sh start` pre-creates `<workdir>/mirrors`; setting `NYORORI_LEDGER` outside the work dir also works. A fix in `src/cli.ts` removes the need for the workaround; keep the pre-created directory until then.
- The default policy pins no measurer hash, so with enforcing gates it is `MEASURER_MISMATCH` unless `measurer.cccc_sha256` is set or `measurer.allow_unpinned` is true. `new-run.sh` pins the sha256 of the binary in use; copy that pattern for your own policies.
- `policy/default.policy.json` keeps `tests.mode: enforce`, so a code change judged without Actions artifacts is `INCONCLUSIVE (REPORT_MISSING)`, exit 2. That is correct behavior, not a broken gate. Use `policy.json` (observe) to see G1-G3 alone, or `policy-evidence.json` plus `make-artifacts.sh` to drive G4 to PASS.
- Without `--workdir`, `run` uses the shared `$TMPDIR/nyorori`; concurrent runs then share scratch. The helpers always pass the run's own work directory.
- A syntax error in a file that also removes functions ends FAIL (simplification review required), not INCONCLUSIVE. The `parse` branch adds a new unparsable file so the path to `INCONCLUSIVE / PARSE_ERROR_CANDIDATE`, exit 2, is clean.
- Offline, a signed `pull_request` delivery is accepted (202) and then fails at the first GitHub call; the log line is `{"msg":"dispatch failed",...,"error":"TypeError: fetch failed"}` and the job file stays `"status":"queued"`. On the next start with the same work dir the service replays it (`{"msg":"replaying job",...}`). This is the expected offline shape, not a verification of publication.
- Other agents may be editing `src/` while you verify; if `doctor` warns that `src` is newer than `dist/cli.js`, rebuild before trusting any verdict, and say in your report which commit of `src/` the build came from (`git rev-parse HEAD` plus `git status --short`).
- `node dist/cli.js run` prints the summary on stdout and nothing on stderr for a normal verdict; stderr carries only usage errors and crashes. An empty `stderr.txt` is normal.

## Reporting

For each feature you drove: the run directory, the helper command line, the exit code, the verdict state (and the reason codes), and the evidence files you read. For each entry point in the feature file you did not drive: the command you would have run and the unmet precondition. Quote `result.txt` lines verbatim rather than paraphrasing them.
