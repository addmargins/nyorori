# Measurer fixtures check

`nyorori fixtures` replays the calculation-rule fixtures in `test/fixtures/cccc-rules` through a cccc binary and lists every scoring difference against `expected.json`, so an operator can tell whether a measurer upgrade changes any score before pinning it.

## Sub-features

- `fixtures-clean` the pinned binary against the tracked fixtures prints `39 fixtures, 0 drift(s)` and exits 0.
- `fixtures-drift` a fixture whose expectation differs from what the binary reports prints a `DRIFT <file>` block with `expected` and `actual` lines, a non-zero drift count, and exits 1.
- `fixtures-env` `--cccc` may be omitted when `NYORORI_CCCC` is set.

## How to get to it (user POV)

- Run `node dist/cli.js fixtures --cccc <bin>` (or `npm run fixtures -- --cccc <bin>`) in a terminal.
- Run `node dist/cli.js fixtures --cccc <bin> --dir <fixtures dir>` to check another fixture directory.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh fixtures)`; the measurer resolves (doctor runs this same check, so `DOCTOR OK` already implies `fixtures-clean`).

- **Clean.** Check the tracked fixtures. Run `.claude/skills/verify-nyorori/scripts/fixtures.sh "$RUN"`. It prints `fixtures exit=0: 39 fixtures, 0 drift(s)` and exits 0; `$RUN/fixtures/stdout.txt` is that single line and `stderr.txt` is empty.
- **Drift.** Check a tampered scratch copy (the `if.ts` cognitive expectation raised by one). Run `.claude/skills/verify-nyorori/scripts/fixtures.sh "$RUN" --tamper`. It prints `fixtures-tamper exit=1: 39 fixtures, 1 drift(s) / DRIFT if.ts` and exits 0 (the expectation of a drift was met); `$RUN/fixtures-tamper/stdout.txt` contains the block `DRIFT if.ts`, `expected {"functions":[["f","function",1,2,2,0]],"residue":[0,0]}`, `actual   {"functions":[["f","function",1,1,2,0]],"residue":[0,0]}`.
- **Environment variable.** Omit `--cccc`. Run `(. "$RUN/run.env"; cd "$REPO_ROOT" && NYORORI_CCCC="$CCCC" node dist/cli.js fixtures; echo "exit=$?") | tee "$RUN/fixtures-env.txt"`. Output `39 fixtures, 0 drift(s)` then `exit=0`.
- **Proof.** The three captures above; then `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"` (it removes the tampered copy under scratch and keeps the captures).

## Gotchas

- The fixture count is 39 as of this skill's creation; a new fixture changes the number but not the `0 drift(s)` expectation. `doctor.sh` accepts any count with zero drift.
- Never edit `test/fixtures/cccc-rules/expected.json` to produce a drift; `fixtures.sh --tamper` copies the directory into the run's scratch first.
- `UNPAIRED <file>` lines (a fixture file without an expectation or the reverse) also make the exit code 1 even with zero drifts.
- The check writes nothing into the repository; it copies the binary to a private temp directory for the run, which it removes.
