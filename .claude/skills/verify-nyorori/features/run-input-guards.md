# Input guards and exit codes

`nyorori run` refuses inputs that a candidate commit could tamper with (policy, measurer, outputs or work directory inside the judged repository) with exit 64, reports usage errors with exit 64, and turns anything that stops the gate from running (a directory that is not a repository, a missing measurer, a measurer whose hash differs from the policy pin) into INCONCLUSIVE with exit 2, never into a pass.

## Sub-features

- `guard-out-inside` `--out` inside `--repo` is refused with exit 64 and the message `is inside the measured repository`; nothing is written there.
- `guard-policy-inside` a policy file inside `--repo` is refused the same way; `--allow-repo-paths` lifts the guard for fixture repositories and the verdict still carries `authority: local`.
- `guard-usage` a missing required flag is exit 64 with `--candidate is required` and the usage text.
- `guard-not-a-repo` a directory without git history is INCONCLUSIVE with exit 2 (the gate could not run), not a usage error.
- `guard-missing-measurer` a `--cccc` path that does not exist is INCONCLUSIVE with exit 2 and `TOOL_ERROR`.
- `guard-pin-mismatch` a policy whose `measurer.cccc_sha256` differs from the binary is INCONCLUSIVE with exit 2 and `FINGERPRINT_MISMATCH`.

## How to get to it (user POV)

- Run `node dist/cli.js run ...` with a wrong, missing or in-repository argument in a terminal and read the exit code and stderr.
- Run `node dist/cli.js run ... --allow-repo-paths` when the repository being judged is itself a fixture repository that carries its own policy.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh guards)` and `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK`.
- The guard cases use `gate.sh --raw`, which appends only `--cccc` and `--workdir` when absent, so `--repo`, `--policy` and `--out` are exactly what the bullet gives.

- **Output inside the repository.** Point `--out` into the judged repository. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-out --expect USAGE --code 64 --raw -- --repo "$RUN/scratch/repo" --base main --candidate pass --policy "$RUN/policy.json" --out "$RUN/scratch/repo/gate-out"`. Exit 64; `$RUN/guard-out/stderr.txt` starts with `nyorori: --out "` and contains `is inside the measured repository`; `ls "$RUN/scratch/repo/gate-out"` fails with "No such file or directory".
- **Policy inside the repository.** Copy the policy into the judged repository's working tree and point at it. Run `cp "$RUN/policy.json" "$RUN/scratch/repo/policy.json" && .claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-policy --expect USAGE --code 64 --raw -- --repo "$RUN/scratch/repo" --base main --candidate pass --policy "$RUN/scratch/repo/policy.json"`. Exit 64 with `policy "` ... `is inside the measured repository` on stderr.
- **Lifting the guard.** Repeat with `--allow-repo-paths`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-policy-allowed --expect PASS --code 0 --raw -- --repo "$RUN/scratch/repo" --base main --candidate pass --policy "$RUN/scratch/repo/policy.json" --allow-repo-paths --out "$RUN/guard-policy-allowed/out"`. Exit 0, `state=PASS authority=local`. Then `rm "$RUN/scratch/repo/policy.json"`.
- **Usage error.** Leave out `--candidate`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-usage --expect USAGE --code 64 --raw -- --repo "$RUN/scratch/repo" --base main --policy "$RUN/policy.json"`. Exit 64; stderr line 1 is `nyorori: --candidate is required` followed by the `usage:` block.
- **Not a repository.** Judge an empty directory. Run `mkdir -p "$RUN/scratch/notrepo" && .claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-notrepo --expect INCONCLUSIVE --code 2 --raw -- --repo "$RUN/scratch/notrepo" --base HEAD --candidate HEAD --policy "$RUN/policy.json"`. Exit 2; stdout has `## quality-gate: INCONCLUSIVE`; stderr is empty.
- **Missing measurer.** Name a binary that does not exist. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-nocccc --expect INCONCLUSIVE --code 2 --raw -- --repo "$RUN/scratch/repo" --base main --candidate pass --policy "$RUN/policy.json" --cccc "$RUN/scratch/no-such-cccc" --out "$RUN/guard-nocccc/out"`. Exit 2; the result line has `reasons=["FINGERPRINT_MISMATCH","REPORT_MISSING"]` (the aggregate cannot match a fingerprint for a binary that never ran); `$RUN/guard-nocccc/out/gate-result.complexity.json` has `state: "INCONCLUSIVE"` and `inconclusive[0].reason: "TOOL_ERROR"` with a detail starting `complexity could not run: ENOENT`; the summary shows both bullets, `- **FINGERPRINT_MISMATCH** complexity: cccc binary sha256 mismatch` and `- **TOOL_ERROR** complexity could not run: ENOENT`.
- **Pin mismatch.** Use the policy with a wrong hash. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" guard-badpin --expect INCONCLUSIVE --code 2 -- --base main --candidate pass --policy "$RUN/policy-badpin.json"`. The result line has `reasons=["FINGERPRINT_MISMATCH","REPORT_MISSING"]` and `quality-gate.json` `inconclusive[]` contains `detail: "complexity: cccc binary sha256 mismatch"`.
- **Proof.** Quote the `result.txt` lines of `guard-out`, `guard-usage`, `guard-notrepo`, `guard-nocccc`, `guard-badpin` and the stderr excerpts. Run `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"`.

## Gotchas

- The guard compares real paths, so a symlink from outside into the repository is still "inside"; conversely the default work directory (`$TMPDIR/nyorori`) is checked too, which is why the helpers always pass `--workdir`.
- A bare command name for `--cccc` (no slash) is looked up on `PATH` and skips the inside-repository check.
- Exit 64 for a missing repository directory, exit 2 for an existing directory with no git history: the first is a usage error, the second a gate that could not run. Do not swap the expectations.
- With `--raw` and no `--out`, `gate.sh` reads the state from the stdout summary; that is enough for the exit-code cases but gives no `quality-gate.json`. Pass `--out "$RUN/<label>/out"` yourself when you need the JSON.
- The policy copied into the throwaway repository is untracked; it does not change what git-based measurement sees, but remove it afterwards so later recipes start from the baseline.
