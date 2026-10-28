# GitHub App deployment

The CLI and service are separate trust domains. The CLI produces local analysis; the service accepts only authenticated GitHub merge queue events and publishes `quality-gate` through its own App installation. No live App installation, ruleset, trusted workflow or organization policy is created by running tests in this repository.

## Required external configuration

1. Host the compiled service on a dedicated, least-privilege machine/container. Put a TLS reverse proxy in front of its `/webhook` route; bind the listener to loopback by default. Do not expose the operator routes publicly. Do not place its keys, webhook secret, operator token, policy, evidence signer key, or installed packages in a candidate repository or its Actions secrets.
2. Create an organization GitHub App with **Checks: write**, **Contents: read**, and the **Merge group** webhook subscription. Install it only on the pilot repositories. Set the webhook secret to at least 16 random bytes; the operator bearer token must contain at least 32 random bytes. Mount secret files read-only. Never commit their contents.
3. Maintain a dedicated **bare Git mirror** of each allowed repository outside the service code. An external trusted synchronizer must fetch the exact `merge_group.base_sha` and `merge_group.head_sha` before the gate runs, using scoped HTTPS Git authentication. The service neither checks out candidate trees nor runs install/test commands in them. Missing objects produce a failed/inconclusive check. The mirror's Git configuration and hooks are operator-owned; no candidate can modify them.
4. Place the repository policy outside the mirror. Pin an attestation-verified cccc release hash/version and trusted toolchain lockfile. Start P0 shadow and review the report before policy-owner-approved phase changes. This software does not substitute synthetic test data for real shadow calibration.
5. Produce G4/G5/G7 and approval evidence in an **external trusted attestor**. Configure the public Ed25519 verification key, issuer and freshness limit in the policy. The attestor writes signed evidence envelopes to the configured evidence directory as `<B>-<C>.json`, with exact repository/B/C/P/time bindings. See the evidence format in `src/types.ts` and the root product documentation. The service never accepts evidence, reviewer identities, filesystem paths or executable commands from webhook request fields.
6. The attestor must authenticate actual GitHub API sources: the fixed trusted workflow file/revision, workflow run/attempt/event/head SHA, run completion, artifact identity; current reviewer/team membership; participant and agent-initiator exclusions; exact candidate-bound review/waiver scope. A JSON field claiming workflow provenance is insufficient. The current service intentionally does **not** fetch or trust arbitrary Actions artifacts. Missing or invalid enforced evidence remains INCONCLUSIVE. PR code can still forge its own test output; the specification's threat-model limitation applies.
7. In the organization ruleset, make **`quality-gate` the sole aggregate required check and bind its expected source to this App**, not the generic GitHub Actions App. Enable merge queue. Use trusted required workflows supporting `merge_group` for the unprivileged test workers. Verify the plan supports organization-required workflows. Preserve existing build/typecheck/security and human review requirements. Do not use `pull_request_target` to execute candidate code.

An example operator configuration (all paths are outside candidate mirrors):

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "data_dir": "/srv/nyorori/state",
  "app_id": 12345,
  "private_key_file": "/run/secrets/nyorori-app.pem",
  "webhook_secret_file": "/run/secrets/nyorori-webhook",
  "operator_token_file": "/run/secrets/nyorori-operator",
  "workers": 2,
  "max_queue": 32,
  "max_receipts": 1000,
  "retention_days": 30,
  "max_attempt_history": 3,
  "repositories": [
    {
      "name": "example/application",
      "installation_id": 45678,
      "repo": "/srv/git/application.git",
      "policy": "/etc/nyorori/application.json",
      "evidence_dir": "/srv/nyorori/evidence/application"
    }
  ]
}
```

After building, run:

```sh
NYORORI_SERVICE_CONFIG=/etc/nyorori/service.json npm run service
```

The listener delegates each analysis to a separate Node process with a clean environment, a 768 MiB V8 heap limit, a 180-second wall timeout, and a 16 MiB result protocol limit. Timeouts kill the entire worker process group, including cccc children. Candidate parser work cannot synchronously block the App webhook event loop. App/GitHub/proxy/cloud environment credentials and `NODE_OPTIONS` are not inherited.

This subprocess boundary is **not an OS sandbox**: processes running as the same operating-system user can ordinarily read the same files, and the V8 heap limit does not bound all native memory. Before production, place analysis behind an OS/container sandbox with a distinct unprivileged identity, cgroup CPU/memory/PID limits, no outbound network, and only read-only trusted code/packages, mirror, policy and binary plus a private output mount. Keep App secret files and the receiver state inaccessible to that identity. This repository supplies the process resource boundary; deployment must supply the operating-system confinement.

The listener checks raw request HMAC before parsing JSON, limits bodies to 1 MiB, and accepts only `merge_group` / `checks_requested` for explicitly mapped repository+installation pairs. Base and candidate must be full 40-character SHAs. Candidate configs, plugins and code are never executed. Installation tokens are repository-scoped, short-lived and kept in process memory. API requests keep TLS verification enabled, have a fixed GitHub origin, reject redirects and use timeouts. Errors omit credentials and raw remote responses.

## Operations and failure handling

- `GET /healthz` reports listener liveness only; it does not prove App connectivity, mirror freshness, evidence validity or gate readiness.
- `GET /jobs/<delivery-uuid>` requires `Authorization: Bearer <operator token>` and returns bounded job metadata.
- `POST /jobs/<delivery-uuid>/retry` requires the same token and accepts no paths or evidence. After fixing mirror/evidence/runtime prerequisites, retry reevaluates the same signed-event B/C with the current trusted policy; it creates a fresh required check attempt. An active job cannot be retried.
- Queue admission is bounded; overload returns HTTP 503 so delivery can be retried. Signed delivery receipts and job metadata are persisted in the private state directory, so process restart restores queued/in-flight work. Duplicate delivery IDs with different payload bytes are rejected. A duplicate completed delivery is acknowledged rather than executed again; use the authenticated retry route when new evidence arrives.
- Configure a supervisor to restart the service, monitor failed jobs and stuck/pending checks, and alert on state disk exhaustion. Keep the state directory private and on reliable storage; only one service process may own a given state directory. Use a load-balancer sticky single writer or an external durable queue before horizontal scaling.
- Receipt retention is bounded by `max_receipts` (default 1000, at least `max_queue`) and `retention_days` (default 30). Startup streams and validates bounded receipt files rather than loading an unbounded directory into memory. Terminal receipts and their artifacts are pruned oldest first on startup, completion and admission. Active jobs are never pruned; admission returns 503 if active receipts occupy capacity. Per-job output retains only `max_attempt_history` attempts (default 3). A delivery replay after its terminal receipt has been pruned is evaluated again against the same signed B/C; idempotency is limited to the retention window. Set storage quotas and alert thresholds as well: a bounded count does not bound the size of every analysis artifact. No unbounded in-process parallelism is used.
- A failed API write may leave a required check pending; pending blocks merging. Evaluation failures are published as `failure` with INCONCLUSIVE, never `neutral` or `skipped`. Repair the cause and retry. Never turn an outage into synthetic PASS.
- Keep App keys, token files, policies and evidence on read-only mounts. Rotate them by restarting the process. Treat the attestor as part of the trusted computing base and audit its signing events. Reject stale or self-approved evidence at the signing boundary and runner validation.

## Validation boundary

Automated service tests exercise signed webhooks, repository/installation binding, duplicate deliveries, queue/worker execution, protected status/retry access, wrong result bindings, failure publication, bounded receipt/artifact retention, isolated-worker timeout/failure handling, and JWT/check request construction using local fakes. With `NYORORI_REAL_CCCC` set, the integration suite also runs the real isolated worker on an actual bare Git mirror and pinned cccc binary, checks that missing G4 evidence fails, and verifies that signed fixture evidence permits an authenticated retry. That fixture is not a real Actions workflow attestation. They do not establish that a real App was installed, real GitHub permissions were granted, a ruleset is enforced, evidence provenance is authentic, or production thresholds were calibrated. Those are explicit deployment acceptance checks for the operator.
