# Producing trusted test evidence

`nyorori attest` is an operator-side evidence producer. It retrieves GitHub Actions artifacts through the fixed `https://api.github.com` API, verifies the exact baseline and candidate run attempts and workflow source, and signs one canonical Ed25519 envelope. It never executes candidate code. The analysis service verifies this signature and the complete repository/B/C/P/M context before using the reports.

This is separate from the untrusted test runner. Keep the signing key, API credential, attestor configuration and policies on the trusted service or control plane, outside Actions jobs that execute candidate code. Do not put a signing key in a repository Actions secret. The workflow's reports are still vulnerable to malicious code deliberately forging its own test output; defending against that is outside this product's stated threat model.

The attestor's network contract is covered by mocked API tests. A live GitHub artifact round trip has not been verified in the managed cloud instance: `api.github.com` is not currently in its network policy.

## Prepare the producer

Use Node 24, install the project's frozen lockfile with `npm ci`, and build with `npm run build`. Create an Ed25519 key on the trusted control plane:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out /srv/nyorori/evidence-private.pem
openssl pkey -in /srv/nyorori/evidence-private.pem -pubout -out /srv/nyorori/evidence-public.pem
```

Place the public PEM and issuer in the target's trusted policy:

```json
{
  "evidence": {
    "issuer": "engineering-evidence-v1",
    "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "max_age_seconds": 3600
  }
}
```

Use a repository-scoped GitHub App installation token or fine-grained token with Actions read and Contents read permission, supplied only as `NYORORI_ATTESTOR_TOKEN`. The token is never written to an artifact, signed envelope or log. The CLI supports GitHub.com; GitHub Enterprise Server is not currently supported. Authorize `api.github.com` and GitHub Actions' artifact storage destinations in the cloud network policy. `npm run attest -- ...` enables Node's environment proxy support so `HTTPS_PROXY` and session CA trust remain effective.

Create an external attestor configuration such as `/srv/nyorori/app-attestor.json`:

```json
{
  "schema_version": 1,
  "repository": "acme/app",
  "issuer": "engineering-evidence-v1",
  "workflow": {
    "id": 12345678,
    "path": ".github/workflows/quality-evidence.yml",
    "sha256": "<64 lowercase hex characters: exact caller workflow file bytes>",
    "reusable": {
      "path": "acme/quality-policy/.github/workflows/tests.yml",
      "sha": "<40 lowercase hex characters: reviewed reusable workflow commit>"
    }
  },
  "base_event": "push",
  "candidate_event": "merge_group",
  "artifact_name": "nyorori-evidence",
  "report_file": "report.json",
  "max_age_seconds": 3600
}
```

The displayed hashes are placeholders that the operator must replace after verifying the workflow source. The producer verifies the caller workflow bytes at each run's exact `head_sha`, not merely its path or workflow ID. A candidate workflow cannot pass by invoking the trusted reusable workflow and uploading a forged artifact from an extra job. Both B and C must already contain the approved caller workflow; install and review the workflow during P0 before enabling enforcement.

Run metadata must report the configured event, exact repository and head repository, exact B/C head SHA, workflow ID/path, run attempt, completed status, a success/failure conclusion, and the pinned reusable workflow SHA. Other conclusions are rejected. Source file downloads also use the fixed GitHub API; no repository-controlled URL is fetched.

## Test workflow artifact contract

The separately maintained, reviewed workflow must run baseline and candidate tests without gate-service secrets, then upload exactly one artifact with the configured name for each attempt. A fixed reusable workflow must own test invocation, report normalization and upload; candidate code must not supply executable reporter/configuration code to the trusted attestor. Use reviewed commit pins for workflow actions. Declare `merge_group` for final-candidate runs. Retain the previous attempt's artifact only if its creation time is earlier than the requested attempt's start; duplicate matching artifacts from the same attempt are rejected.

The ZIP must contain exactly one regular file named `report.json`. No directory prefixes, other files, symlinks, encrypted entries or ZIP64 entries are accepted. The downloaded ZIP is limited to 16 MB and decompressed JSON to 8 MB. Artifact metadata must include an unexpired artifact ID, exact workflow run/head, creation time within the requested attempt, byte size and a `sha256:` digest. Both size and digest are checked against the downloaded archive. Redirects to GitHub artifact storage are allowlisted and never receive the API Authorization header.

The report format is deliberately small:

```json
{
  "schema_version": 1,
  "head_sha": "<exact tested commit>",
  "tests": {
    "total": 1,
    "passed": 1,
    "failed": 0,
    "skipped": 0,
    "tests": [
      {
        "id": "src/billing.test.ts::pricing applies the published discount",
        "status": "passed",
        "assertions": 2
      }
    ]
  },
  "coverage": {
    "provider": "vitest-v8",
    "version": "<exact provider version pinned by policy>",
    "files": {
      "src/billing.ts": "<Istanbul file coverage object>"
    }
  },
  "mutation": {
    "killed": 5,
    "survived": 1,
    "timeout": 0,
    "no_coverage": 0
  }
}
```

`coverage` and `mutation` are optional. The `files` values above are illustrative placeholders; actual values must be Istanbul objects with `branchMap`, `b`, `statementMap`, `s`, `fnMap` and `f`. Coverage must explicitly include every changed source file, including files no test imports. Normalize file keys to repository-relative paths. G5 validates maps/counters and the pinned provider/version.

The workflow adapter must obtain test IDs, statuses and assertion counts from its actual runner/reporter. Do not fabricate one assertion for every passing test. The producer does not guess assertion counts from arbitrary Jest/Vitest JSON formats. Use stable IDs containing the source path and full suite/test title. Status is `passed`, `failed`, `skipped` or `todo`; todo counts toward `skipped`. Counts, unique IDs and statuses must agree. Zero executed tests can be signed as evidence but G4 returns `INCONCLUSIVE`, so signing does not turn an empty run into a pass.

A failed workflow is accepted only when its normalized test report contains failed tests; those failures remain failures in G4. A workflow failure without matching test failure evidence is incomplete evidence and is rejected. This preserves failures without treating a crashed or incomplete reporter as success.

The artifact cannot provide actor identities, reviews, waivers, protected-path approvals, policy revisions or measurement fingerprints. Unknown top-level report fields are rejected. Those values must come from the trusted control plane.

## Produce and consume an envelope

First run trusted local analysis for the exact B/C to obtain `gate-result.json`. It may report missing test evidence, which is expected for this first pass. The context includes the canonical policy SHA256 and the complete measurement fingerprint. Preserve that result outside the candidate checkout.

```sh
npm run attest -- \
  --repo /srv/mirrors/app.git \
  --config /srv/nyorori/app-attestor.json \
  --policy /srv/nyorori/app-policy.json \
  --context /srv/nyorori/runs/initial/gate-result.json \
  --key /srv/nyorori/evidence-private.pem \
  --base-run 111111 --base-attempt 1 \
  --candidate-run 222222 --candidate-attempt 1 \
  --out /srv/nyorori/evidence/next-envelope.json
```

The producer refuses to overwrite an existing output file. The key must be a regular external file with permissions `0600` or stricter and must match the policy's Ed25519 public key. Output binds repository, full B/C, policy revision, canonical policy SHA256, complete fingerprint digest, issuer and time, plus the API-verified run/artifact provenance.

Analyze again using a fresh external output directory and `--evidence /srv/nyorori/evidence/next-envelope.json`. Use the same B/C/P/M; changing any of them requires new evidence. Configure the App service's evidence directory as described in its deployment guide, then request an authenticated retry for the same merge-group event. The App adapter publishes the final check only after its own context validation. Local signing or analysis alone never publishes a merge approval.

## Approval authority

By default this producer signs test/coverage/mutation evidence only. It does not claim to know all authors, coauthors and AI initiators in a merge queue. Its default actor context excludes the entire configured approval roster and carries `provenance.approval_authority: "none"`; it cannot authorize G6, a waiver or a protected-path change.

An operator may supply `--authority /srv/nyorori/authority/exact-candidate.json` from a separately authenticated control plane. This is a protected local input with the same trust level as the signing key and policy, never a PR artifact or request-body path. The producer validates its exact B/C/P/M bindings, bounded timestamp, actor/approval schema and current policy independence. **It does not authenticate human identity or enumerate GitHub team membership merely because a file exists.** The upstream control plane is responsible for verifying current authorization, all queue PR authors/commit authors/committers/coauthors and AI initiators, and exact-candidate approval provenance before writing the file.

```json
{
  "schema_version": 1,
  "repository": "acme/app",
  "base_sha": "<B>",
  "candidate_sha": "<C>",
  "policy_revision": "<trusted policy revision>",
  "policy_sha256": "<canonical policy hash>",
  "measurement_fingerprint": "<canonical fingerprint hash>",
  "issued_at": "<UTC ISO timestamp>",
  "expires_at": "<UTC ISO timestamp within 24 hours>",
  "actors": {
    "author": "verified-pr-author",
    "participants": ["verified-commit-contributor"],
    "agent_initiators": ["verified-agent-invoker"]
  },
  "reviews": [],
  "waivers": [],
  "protected_change_approvals": []
}
```

Optional approval arrays use the types in `src/types.ts`. A review needs the exact C, a nonexpired independent policy reviewer and all five rubric answers with concrete evidence. A waiver needs its exact unit/blob, metric, ceiling, reason, validity period and independent policy approver. Protected-change approvals need the exact C, exact paths and an independent gate owner. The gate verifier checks these rules again.

Automatic GitHub review/team/merge-queue actor ingestion is not implemented. Without an authenticated upstream authority producer, leave `--authority` unset and have G6/protected changes remain blocked. Do not populate it from untrusted artifact fields or treat the local filename as proof of identity.
