# Spec-compliance audit (independent reviewer, commit 2d4d452)

Findings F1–F17 with reproductions under /tmp/audit-spec (not preserved). Summary:

| # | Sev | Area | Finding | Disposition |
|---|---|---|---|---|
| F1 | high | units/model, match | Unit key is a joined string; a string-literal method name `"g>f"` collides with nested `g>f`, so a new unit inherits a legacy allowance | fix (B) |
| F2 | med | S9 | min branch drop applied to both paths | superseded by ruling D20 (3 density / 2 line) |
| F3 | high | manifest/G1 | production code under a test glob (`src/__tests__/pricing.ts`) is observe-only with no S11 | fix: new non-`.test.`/`.spec.` file under test dirs → S11; G3 prod→test edge FAIL (D19) |
| F4 | med | match stage 4 | cross-file move with edited logic but equal scores inherits allowance, no S5 | fix (B): stage-4 match over T requires normalized-body equality else S5 |
| F5 | med | override | parser-lag allowlisted parse errors are authorFixable → override impossible | fix (A/E) |
| F6 | med | manifest | extensionless/.txt/.md files silently NOT_CODE though `require()` executes them | ruling D6 + S11 when a C import/require targets a non-code-extension file (C) |
| F7 | med | G2 | dynamic-code misses non-literal require, computed "constructor" keys, Reflect.get, globalThis computed eval, module.prototype._compile, process.binding | fix (C) |
| F8 | low | S4 | raw-line S4 | ruling D12 (statements > 30 path) |
| F9 | med | G3 | aliases from candidate tsconfig, baseUrl/extends ignored, unresolved internal specifiers silent | fix (C): aliases from B's tsconfig; unresolved internal-looking specifiers → INCONCLUSIVE-lite (S3 evidence + observe) |
| F10 | med | fingerprint | default policy has empty cccc_sha256 → pin disabled | fix (A): empty pin with any enforce gate → MEASURER_MISMATCH unless `measurer.allow_unpinned` (fixtures only) |
| F11 | low | S2 | top-level anonymous callbacks skipped | fix (B) |
| F12 | low-med | G4 | no approval path for TEST_REMOVED / config weakening | fix (E): `/gate-approve-tests` by gate_owners bound to head SHA |
| F13 | low | report | gate's own copyable approve command rejected (trailing comment) | fix (E) |
| F14 | low | aggregate | `waivedBy` in untrusted artifacts trusted | fix (E) |
| F15 | low | measure | B-side invalid UTF-8 → INCONCLUSIVE | fix (A): treat as baseline missing |
| F16 | low | manifest | case collision checked only among changed files | fix (A): check against full C tree listing |
| F17 | — | missing | per_quarter_budget, declaration_impl_check, enforced_rules unwired; decideRetry hands off only on S1/S9; moving baseline missing; "G5 missing" | G5 claim rejected (src/gates/coverage exists). Wiring: integrator. decideRetry: fix (E) any new routing trigger. Moving baseline: deferred to P1 (documented gap) |
| F18 | — | integration | comment headSha must be head at createdAt; pull_request provenance head_sha vs merge SHA | integrator / E |
