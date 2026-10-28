# Design decisions and acceptance boundaries

These decisions implement the supplied **cccc AI-generated code quality gate v0.9** design for JavaScript and TypeScript. They record the architecture, security and QA reviews that shaped the product. “Implemented” below describes software and repeatable local validation; it does not mean a GitHub App has been installed, an organization ruleset is active, or a policy owner has approved production enforcement.

## 1. Build the trusted evaluation kernel before a dashboard

**Decision:** the product is an executable CLI, reusable evaluation modules and a separate GitHub App receiver/worker service. JSON artifacts are the primary integration contract; Markdown is a human-readable projection. A dashboard is not required to make a correct merge decision.

Architecture proposed a single useful end-to-end workflow: immutable B/C/P/M in, explicit gate results and actionable evidence out. Security rejected a demo endpoint that accepted claimed reviewers, filesystem paths or executable commands from requests. QA required real Git repositories and a real pinned cccc binary in addition to synthetic protocol adversaries. The resulting service accepts authenticated, allowlisted merge queue events and launches the trusted runner with configured paths.

G1–G3 parse candidate bytes but never install dependencies or execute candidate JavaScript, configuration, plugins or tests. G4/G5/G7 execute outside the trusted gate service. Keep the App credentials away from those workers.

**Consequence:** this is a quality gate implementation, not a claim that arbitrary candidate parsing is an operating-system sandbox. Production deployment must provide the OS/container isolation described in [DEPLOYMENT.md](DEPLOYMENT.md).

## 2. Git blobs are the measurement input

**Decision:** resolve B and C to complete commit object IDs, inventory the trees, and read blob objects directly. Never use candidate checkout filters, `git archive`, `.gitignore`, cccc config discovery or candidate caches to choose source bytes.

Security identified `.gitattributes` encoding/filter rules and symlinks as ways a checkout could silently differ from the reviewed Git objects. QA therefore tests candidate config and attributes together with a worktree mutation that is absent from C. File modes, bounded UTF-8 content, LFS pointers, unsafe paths, unknown extensions and case collisions receive explicit treatment.

The cccc adapter copies the exact policy-hashed binary into a private temporary directory, verifies its version, clears the child environment, supplies explicit file arguments and validates the report against the manifest. Missing files, stderr, malformed schema, negative residue, candidate parse errors, timeout or nondeterminism cannot produce a successful complexity measurement. B parse errors remove debt privileges rather than legitimizing a broken baseline.

Identical bytes need no new measurement when their scope classification is unchanged. Moving the same bytes from tests or an excluded path into production source changes the policy obligation and must be remeasured.

## 3. Uncertain correspondence means a new unit

**Decision:** use cccc units and Git line/hunk information for a conservative one-to-one mapping: unchanged declaration anchors, unique same-hunk declarations, unique sibling names, then globally unique same-score whole-unit moves. A matched parent is required before its children can inherit identity. Exact moved child shapes retain their original ordering; ambiguous children remain new.

Architecture considered a second AST indexer for G1 but rejected the additional source-of-truth problem: its function boundaries could diverge from cccc's boundaries. Security required that a copy never share another unit's allowance and that homoglyph edits never gain a larger limit. QA added duplicate names, same-row anonymous functions, unmatched parents, nested callbacks, scope changes and copy/move fixtures.

For a changed production unit, `limit = max(policy threshold, matched baseline CogC)`; an unmatched unit receives only the threshold. Comparisons use strict `>` and never offset one violation with another unit's improvement. `UNMATCHED_OVER_BUDGET` includes bounded baseline candidate hints without selecting the most permissive score.

The module residue is a real unit, not a `+1` normalization. Test code complexity remains observed. Existing debt is labeled as an allowance rather than healthy code.

**Known precision boundary:** cccc has no end positions or class identity. G1 uses the next declaration at the same or shallower depth as a conservative range end. Changes to a file with module residue debt can therefore request review even when the changed function is unrelated to the module initialization. These are review precision costs, not permission to skip measurement.

## 4. P0 shadow and v1 enforcement describe different things

**Decision:** preserve the document's gate semantics while starting the example policy in P0 observation mode. Gate `state` always reports the actual analysis outcome; `mode` determines whether it contributes to the effective aggregate. `would_block` exposes observed failures and incomplete evidence. Shadow never rewrites an individual FAIL or INCONCLUSIVE to PASS.

The design's gate table describes the intended v1 enforcement policy, while its rollout chapter requires fixture validation, shadow data and policy-owner approval first. Architecture and security agreed that shipping a numeric threshold is not evidence that it has been calibrated for a real organization. QA tests both the raw observed failure and the effective shadow result.

All expected gates remain present. Missing enforced evidence is INCONCLUSIVE; an absent gate cannot become NOT_APPLICABLE. The effective aggregate prioritizes FAIL over INCONCLUSIVE, and either maps to a GitHub check failure. Neutral/skipped conclusions are not merge approvals.

## 5. Local analysis and App authority are separate

**Decision:** CLI and replay outputs have `authority: local`. Only the authenticated App service, with a verified repository/installation and exact merge-group B/C binding, may publish the aggregate check.

Security rejected any `verified: true` request field or reviewer name supplied by candidate-controlled JSON as an authority mechanism. Signing, binding and current authority checks must happen in a trusted control plane. The service's local tests and fixture GitHub transport verify the protocol; they do not prove live App permissions or ruleset enforcement.

Operational setup must bind the expected source of the required `quality-gate` check to the dedicated App, keep its keys outside candidate Actions, provide exact Git objects in an operator-owned bare mirror, and preserve existing build/typecheck/security/human-review requirements. See [DEPLOYMENT.md](DEPLOYMENT.md).

## 6. Static dependency graph instead of loading candidate resolver configuration

**Decision:** this implementation uses the pinned TypeScript/ESLint parser to construct a static module graph. It compares new strongly connected edges and forbidden imports without executing the candidate's dependency-cruiser, bundler, Babel or TypeScript configuration.

The supplied design proposed dependency-cruiser. A trusted static graph offers a smaller execution surface and reuses the installed parser. This is a deliberate implementation substitution, not an assertion of complete dependency-cruiser compatibility. Known local relative imports and the supported resolution forms are analyzed; unsupported aliases, workspace/package resolution or dynamic imports are reported explicitly as unresolved/unsupported evidence rather than silently assumed safe. In particular, candidate `paths`, `baseUrl`, `extends` and custom loaders need a separately reviewed trusted resolver profile.

The G3 fixtures cover new cycles, renamed existing cycles, forbidden/excluded-path imports, import fan-out and unsupported resolution. The graph does not claim to be a full JavaScript runtime loader or semantic call graph.

## 7. Signed external evidence; no autonomous LLM merge authority

**Decision:** accept G4/G5/G7, actors, reviews and waiver inputs only from an Ed25519 envelope whose issuer/key is in trusted P and whose repository, B/C, policy content/revision, measurement fingerprint and freshness match the evaluation.

Architecture initially considered simple trusted-operator JSON as an integration seam. Security objected that JSON identity claims do not establish live workflow or reviewer authority. The adopted seam makes the external attestor an explicit part of the trusted computing base. It must authenticate workflow/run/attempt/artifact provenance, current team membership, author/participant/agent-initiator exclusions and exact review scope before signing. The runner additionally validates those signed fields and the allowed identities.

The signature proves that the configured attestor asserted the evidence, not that a test run's assertions were correct. Candidate code can fabricate its own test output; the original design explicitly excludes defense against malicious test-output forgery. Missing evidence remains visible and cannot be replaced with synthetic passing tests.

The CI interface is a **normalized report contract**, not an automatic importer for arbitrary raw Jest/Vitest/JUnit/Stryker files. The external adapter must supply stable unique test IDs, executed/passed/failed/skipped counts and assertion counts for both B and C; repository-relative Istanbul maps/counters with the pinned provider/version; and the supported mutation summary. Raw runner output without this normalization and verified provenance is not accepted as completed CI evidence. See [EVIDENCE.md](EVIDENCE.md) for exact fields. The static test checks recognize standard Vitest/Jest `test`/`it`/`expect` forms; unresolved dynamic or unsupported forms fail closed. Coverage additionally reports every changed instrumented function that was not executed, which is deliberately more conservative than the draft's changed-export-only rule.

LLM suggestions are not a hard gate or an approval source. This implementation does not make an external LLM call. A production observational reviewer would need separately configured credentials, privacy review, prompt-injection fixtures and the human-agreement calibration from the design before influencing routing.

Waivers are narrowly candidate/blob/unit/metric/ceiling/expiry-bound. They do not turn an unmeasured file or a test-integrity violation into PASS. GitHub comment command ingestion, an organization approval UI, the organization's append-only waiver audit sink and automatic 90-day issue creation require an external operational integration; a validated local waiver is not proof those side effects happened. The runner enforces the configured per-PR waiver budget; organization-wide quarterly budgets and trend alerts need the external audit/metrics system.

## 8. Rolling comparison and replay are explicit calibration tools

**Decision:** current B/C remains the sole complexity debt baseline. S1/S9/S10 may additionally use a rolling comparison for routing. `--rolling-base FULL_SHA` allows an operator to supply the intended audited historical tree.

The automatic fallback uses up to five previous first-parent **commits**. It does not claim to implement the design's per-file fifth prior **merge** or exact 30-day historical selection. Repositories with direct commits, squash histories, low-frequency file changes or long gaps should supply an explicit rolling baseline. P0/P1 rolling signals remain observations. Selecting per-file historical baselines automatically is an operational precision improvement still requiring a policy and history convention.

`node dist/replay.js` reuses the actual runner for a bounded external dataset of complete B/C SHAs, sequentially, with optional policy comparison. It retains artifacts for every run and reports aggregate/gate states, trigger differences and violation differences. Policy/fingerprint metadata changes are recorded but are not themselves fabricated behavior changes. Missing observed evidence is counted; static analysis failure, an enforced INCONCLUSIVE or a failed invocation makes the replay partial.

The tool supports the design's approximately 200-PR upgrade review; the repository contains no organization PR dataset. Running fixture pairs does not establish 200 real PRs, reviewer precision/recall, a waiver budget trend or threshold approval. Historical signed evidence may have expired or bind a different policy; replay never rewrites signatures or invents fresh authority.

Replay dataset format:

```json
{
  "schema_version": 1,
  "repository": "example/application",
  "pairs": [
    {
      "id": "PR-123",
      "base": "0123456789abcdef0123456789abcdef01234567",
      "candidate": "89abcdef0123456789abcdef0123456789abcdef",
      "evidence": "evidence/current-123.json",
      "compare_evidence": "evidence/comparison-123.json",
      "rolling_base": "fedcba9876543210fedcba9876543210fedcba98"
    }
  ]
}
```

Only `id`, `base` and `candidate` are required for each pair. The dataset and optional evidence files must be outside the candidate repository; evidence paths are relative to the dataset. Evidence for the comparison policy is separate because signatures bind exact policy and measurement fingerprints.

```sh
node dist/replay.js --repo /srv/git/application.git \
  --pairs /srv/calibration/pairs.json \
  --policy /etc/nyorori/current.json \
  --compare-policy /etc/nyorori/proposed.json \
  --out /srv/calibration/replay-001
```

Exit 0 means replay completed without comparison differences; existing historical FAIL results remain data. Exit 1 means completed comparison differences need review. Exit 2 means an invocation failed, static evidence was incomplete, or an enforced aggregate was INCONCLUSIVE. These are replay outcomes, not GitHub merge approvals.

## Acceptance traceability

| Design concern                                 | Implemented behavior                                                                                | Evidence and practical boundary                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| G1 CogC budget, debt, no compensation          | Per-changed-unit rule, nested units and residue                                                     | `test/complexity.test.mjs`, CLI acceptance and real cccc suites; thresholds still require organization calibration |
| Mapping ambiguity and scope laundering         | Conservative 1:1 identity; copies and test-to-source moves get no borrowed debt                     | G1 and Git/measurer regression tests; approximate source ranges remain documented                                  |
| Measurement completeness                       | Pinned binary, manifest/schema/UTF-8/error/timeout/determinism checks                               | Protocol adversaries plus `test/real-measurer.test.mjs`; not merely fake score fixtures                            |
| G2 anti-gaming and S1–S11 routing              | Trusted static lint, normalized rows, independent review evidence                                   | Structural/G1/CLI tests; legitimate refactors can intentionally route to humans                                    |
| G3 structural dependency integrity             | New-cycle/forbidden-edge comparison and explicit unsupported resolution                             | `test/structure.test.mjs`; trusted resolver profiles remain deployment-specific                                    |
| G4/G5/G7                                       | Signed reports, executed-test/integrity checks, changed-branch observations, mutation observations  | `test/test-gates.test.mjs` and signed CLI fixtures; test workers and provenance attestor are external              |
| G6 and waivers                                 | Head-bound independent actors, rubric/expiry checks, narrowly scoped waiver validation              | `test/security.test.mjs`; live GitHub team verification and audit side effects belong to attestor/operations       |
| Merge authority and service failure behavior   | HMAC events, repository/installation bindings, isolated workers, bounded queue and durable receipts | Service suites including optional real worker; actual App/ruleset/OS sandbox require operator acceptance           |
| Repeated AI repair                             | Feedback contract and bounded repair decisions                                                      | `test/repair.test.mjs`; no autonomous model execution or unbounded source rewriting                                |
| Tool/policy upgrades and historical comparison | Sequential immutable-pair replay and decision/signal deltas                                         | `test/replay.test.mjs`; no real 200-PR dataset or reviewer calibration supplied                                    |

The original attachment references a companion fixture archive that was not present in this task. The repository's preserved fixtures and generated temporary Git scenarios are independently implemented acceptance cases; they are not represented as the missing original experiment archive.
