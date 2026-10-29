# Service webhook intake (`serve`)

`nyorori serve` is the GitHub App backend: it answers `GET /healthz`, accepts webhook deliveries whose body is signed with the shared secret, drops replays, journals each accepted delivery, evaluates the pull request through the same pipeline as the CLI and publishes the `quality-gate` check run. Offline, everything up to the first GitHub API call can be driven; publication needs a real installation.

## Sub-features

- `serve-start` with the documented `NYORORI_*` environment the service logs `{"msg":"journal",...}` then `{"msg":"listening","port":N}` on stderr.
- `serve-health` `GET /healthz` is `200 {"ok":true,"policy_revision":"sha256:...","runner_commit":"..."}`.
- `serve-reject-unsigned` a delivery without a valid `X-Hub-Signature-256` is `401` and leaves no trace.
- `serve-accept` a signed `pull_request` delivery is `202`; `deliveries.log` records the delivery id and the body hash and `jobs/<owner>/<repo>/<delivery>.json` is written.
- `serve-duplicate` the same body under a new delivery id is `200 duplicate`.
- `serve-shape` a body whose shape does not match `X-GitHub-Event` is `400` (`webhook event/payload mismatch` in the log); a `GET` on any other path is `405`.
- `serve-stop` SIGTERM ends the process; the work dir keeps the journal for the next start, which replays queued jobs.
- `serve-publish` (not drivable offline) the accepted delivery resolves `refs/pull/N/merge`, mirrors the repository, evaluates, and publishes `quality-gate` (in_progress while waiting for test evidence, then completed).

## How to get to it (user POV)

- Run `NYORORI_APP_ID=<id> NYORORI_PRIVATE_KEY_PATH=<pem> NYORORI_WEBHOOK_SECRET=<secret> NYORORI_POLICY=<policy.json> NYORORI_CCCC=<bin> NYORORI_WORKDIR=<dir> node dist/cli.js serve --port <n>` on the gate host.
- GitHub delivers `pull_request`, `merge_group`, `issue_comment` and `workflow_run` webhooks to that port; operators probe `/healthz`.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh serve)` and `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK`.
- No `serve` instance of this run is running (`.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" status` says `not running` or fails because there is no `serve.env` yet).

- **Start.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" start`. It prints `serve ready: pid <pid> url http://127.0.0.1:<port> ...` followed by the two log lines; `$RUN/serve/serve.env` holds `SERVE_PID`, `SERVE_PORT`, `SERVE_SECRET`, `SERVE_WORKDIR`.
- **Health.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" get /healthz`. Output ends `-> 200 {"ok":true,"policy_revision":"sha256:<hex>","runner_commit":"verify-<run id>"}`; the `policy_revision` equals `policy "sha256:..."` in any `gate-summary.md` of a run that used `policy.json`.
- **Payload.** Run `P=$(.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" payload pull_request); cat "$P"`. One JSON line: `pull_request` #7 `opened` on `verify/fixture` with `head.sha` equal to `PASS` in `run.env`.
- **Unsigned and wrong secret.** Run `P="$RUN/serve/payload-pull_request.json"; .claude/skills/verify-nyorori/scripts/serve.sh "$RUN" post pull_request d-unsigned "$P" --unsigned; .claude/skills/verify-nyorori/scripts/serve.sh "$RUN" post pull_request d-wrong "$P" --secret not-the-secret`. Both lines end `-> 401 `; `$RUN/scratch/serve/work/deliveries.log` does not exist yet or does not mention `d-unsigned`/`d-wrong`.
- **Accepted.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" post pull_request d-1 "$RUN/serve/payload-pull_request.json"`. The line ends `-> 202 ` within a second. Then `sleep 2; .claude/skills/verify-nyorori/scripts/serve.sh "$RUN" snapshot; cat "$RUN/serve/state/deliveries.log"; cat "$RUN/serve/state/jobs/verify/fixture/d-1.json"; tail -3 "$RUN/serve/stderr.txt"`: `deliveries.log` has the lines `d-1` and `sha256:<64 hex>`; the job file has `"delivery":"d-1"`, `"event":"pull_request"`, `"status":"queued"`, `"replayable":true` and the payload; offline the log's last lines include `{"msg":"dispatch failed","event":"pull_request","delivery":"d-1","error":"TypeError: fetch failed"}`.
- **Duplicate.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" post pull_request d-2 "$RUN/serve/payload-pull_request.json"`. The line ends `-> 200 duplicate`; after `snapshot`, `deliveries.log` is unchanged and no `d-2.json` exists.
- **Shape mismatch and method.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" post workflow_run d-3 "$RUN/serve/payload-pull_request.json"; .claude/skills/verify-nyorori/scripts/serve.sh "$RUN" get /`. The first ends `-> 400 ` and the log gains `{"msg":"webhook event/payload mismatch","event":"workflow_run","delivery":"d-3"}`; the second ends `-> 405 `.
- **Stop.** Run `.claude/skills/verify-nyorori/scripts/serve.sh "$RUN" stop; .claude/skills/verify-nyorori/scripts/serve.sh "$RUN" status`. `stopped pid <pid> (SIGTERM)` then `not running (last pid 0)` with exit 1; `$RUN/serve/state/` holds the final journal copy.
- **Publication (precondition check).** The journey continues only with a reachable GitHub App installation: a real `NYORORI_APP_ID` and key, a repository with the App installed, and GitHub able to deliver to this port. Without them, report `serve-publish` as unreached with the `dispatch failed` log line as the reason. Do not substitute `npx vitest run test/e2e/service-flow.test.ts`: it exercises the publication logic through the real client and pipeline against an in-process fake GitHub and is a useful regression signal, but it is not the user path.
- **Proof.** `$RUN/serve/requests.log` (every request with its status), `$RUN/serve/stderr.txt` (the JSON log), `$RUN/serve/state/` (journal and deliveries), `serve.env`, `payload-pull_request.json`; then `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"`.

## Gotchas

- With an empty work dir the service exits 64 before listening (`ledger ... is inside the measured repository .../mirrors`): the startup guard compares the deepest existing ancestors of two paths that do not exist yet. `serve.sh start` pre-creates `<workdir>/mirrors`; `NYORORI_LEDGER` pointing outside the work dir is the other workaround. A fix in `src/cli.ts` makes both unnecessary.
- Ready means the `listening` log line, not an open port; `serve.sh start` waits for it (15 s) and fails loudly otherwise.
- The signature covers the raw body; any re-serialization (pretty-printing the payload) invalidates it. `serve.sh post` signs the file's bytes exactly.
- `X-GitHub-Event` is not signed, so the service checks the payload shape per event; the mismatch case is a security property, not a bug.
- A `queued` job after `dispatch failed` is expected offline; the next start with the same work dir logs `replaying job` and fails the same way. Clean work dirs (a fresh run) keep that out of your proof.
- `serve.sh` identifies its instance by the recorded pid and the unique port. If `serve.env` is lost, find the process with `pgrep -f "dist/cli.js serve --port <port>"` from the start log, never by killing every `node`.
- Everything the service does after `202` is asynchronous; wait for the log line or snapshot the state before asserting on it.
