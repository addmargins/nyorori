# Rulings on design disputes D1–D21 (round 1)

Inputs: builder reports, `disputes.md`, the strictness advocate and the adopter advocate
(both measured their claims with the real cccc v1.8.5 and the gate's own ESLint config on
the 7.2 fixtures, nyorori/src, zod/src, eslint/lib, dependency-cruiser/src and everyday samples).

Ruling principles, in order:

1. **No silent escape.** Code that leaves measurement must reach a human (S11) or fail. It must never be quietly classified as non-code or PASS (spec 1.2 item 5).
2. **What the author cannot fix must not block.** Turn it into routing (G6), not INCONCLUSIVE or a non-waivable FAIL, unless it is a bypass vector.
3. **Bypass vectors stay non-waivable.** Legitimate exceptions go through a policy (P) allowlist reviewed in the gate repository.
4. **Triggers must clear the precision floor (13.2).** A shape signal measured to flood normal code is recalibrated, not shipped.

| # | Ruling | Owner |
|---|---|---|
| D1 | A concrete weakening stays FAIL `TEST_CONFIG_WEAKENED` (not waivable). Any other protected-path change by a human routes as **S11 (protected config)**, cleared by an independent G6 approval at head SHA. The gate never assumes CODEOWNERS is configured. Add to `analyzeConfigChange` detection: `setupFiles`/`setupFilesAfterEach`, `retry`, `resolve.alias`/`moduleNameMapper` changes (S7 evidence). AI loop: FAIL. | D |
| D2 | A newly added `todo` is observe for humans and FAIL for the AI loop. A new `skipIf`/`runIf` is S7. A test that ran in B and is skipped or todo in C stays FAIL. | D |
| D3 | It is a rename only when, in the same file (following git renames), a removed and an added test pair 1:1 uniquely, the B test passed, and the comment-stripped, whitespace-normalized callback body is byte-identical (covers `describe` renames). Such a rename is observe. Anything else stays `TEST_REMOVED`. AI loop: FAIL. The "assertion multiset" rule is rejected: setup outside `expect` can be gutted. | D |
| D4 | JSON reports only. JUnit input is INCONCLUSIVE `SCHEMA` (detail "unsupported report format"). | D |
| D5 | Widen the default `non_code_extensions` (data, assets, fonts, media, archives, locale, schema files). Known foreign-language code goes in the new policy list `scope.foreign_code_extensions`: `.py .sh .bash .zsh .rb .go .rs .java .kt .kts .scala .php .pl .lua .swift .c .h .cc .cpp .hpp .cs .tf .hcl .ps1 .wasm`. Such a file is `unmeasured` with reason `FOREIGN_LANGUAGE`, recorded as observe. It routes as **S11** when the AI loop authored the PR, or when the same PR's measured JS/TS files lose net CogC (logic moved out of measurement). A truly unknown extension routes as **S11** instead of INCONCLUSIVE. | A (+B for S11) |
| D6 | Extensionless file: a first line `#!…\b(node|bun|deno)\b` is measured as `.js`; `tsx` or `ts-node` as `.ts` (the measured path gets a suffix). Any other `#!` is `FOREIGN_LANGUAGE` (D5). No shebang stays non-code. | A |
| D7 | The per-edge analysis is kept as evidence. **FAIL `DEP_NEW_CYCLE` only when the cyclic SCC partition changes** (a new cyclic SCC, a module joining one, or SCCs merging). A new edge inside an unchanged SCC is **S3**. A new cycle that closes only through a new dynamic `import()` edge is **S3**. Type-only edges are excluded. | C |
| D8 | Keep the builder's rule (`&&=` with a call is S9; `x \|\|= call()` / `x ??= call()` memo is clean). Also clean: a single awaited call (`this.c ??= await create()`). Add to S9: `\|\|=`/`??=` whose LHS is a local initialized from a boolean-ish expression, with a call on the RHS. | C |
| D9 + D14 (suppressions) | Scope of non-waivable `SUPPRESSION_ADDED`: bare `eslint-disable*` (no rule list), `eslint-disable*` naming a rule the gate runs (RULE_CATEGORY), `@ts-nocheck`, coverage and mutation ignore hints (`istanbul`/`v8`/`c8 ignore`, `Stryker disable`). `@ts-ignore` is a **waivable** FAIL `SUPPRESSION_ADDED`. `@ts-expect-error` and directives naming only rules the gate does not run are observe for humans. AI loop: all of them FAIL (12.2). | C (+E waivability) |
| D10 | `import()` with a template literal: if the leading quasi is `./dir/…` (at least one directory, no `..`), the directory is not excluded, generated or vendor, and the suffix is static, then a non-code suffix is observe and a code suffix is S11. Everything else non-literal is `DYNAMIC_CODE`. | C |
| D11 | In test files, `max-params`, `max-nested-callbacks`, S4, S9 and S10 are observe. DYNAMIC_CODE, bidi, and the non-waivable suppressions of D9 still block. | C |
| D12 | S4 fires when ESLint-counted lines exceed 60 **or** statements exceed 30 (`max-statements` is promoted from observe to an S4 path). Statement count does not depend on formatting. | C |
| D13 | Adopt the polarity fix. Additionally, an approval must give a one-line disposition for every fired routing trigger ID and an explicit pass/fail for every rubric item, with no defaults. A fail needs `file:line` evidence. | E |
| D14 (other reasons) | `DYNAMIC_CODE`, `BIDI_CONTROL`, review reasons: not waivable. Add policy list `lint.dynamic_code_allowlist` (globs, reviewed in the gate repo) for legitimate loaders. `TESTS_FAILED`: not waivable, except a test ID that also failed in `reportB`, which becomes waivable (`details.base_broken = true`). `TEST_NO_ASSERTION`: S7 for humans, FAIL for the AI loop. | E, D, C |
| D15 | Keep `blob=<sha>` binding. Carry-over: a waiver stays valid on a new blob when `diff(approvedBlob, currentBlob)` has no hunk inside the unit's range and the value is ≤ ceiling. | E |
| D16 | Triggers from observe-mode gates do not route, **except S11 and S6**, which always route (a measurement escape must reach a human even in shadow). New mode `degraded` for the 13.4 incident procedure: the gate's FAILs and routing triggers become required G6 review instead of blocking or disappearing. | E (+schema) |
| D17 | Absolute (B-independent) shape detection lives in **G2**, not G1. New S9 selectors: `switch (true)`; an assignment or update inside a `&&`/`\|\|`/`?:` operand outside statement or test position (exempt `x \|\| (x = …)`); recursion through a local alias of the enclosing function. Plus the D8 rule. These were measured at ≤ 0.25% of hand-written files. **AI loop:** on retry n, S1/S9/S10 are also computed against the previous attempt `C_{n−1}` for files that had a G1 violation (routing only; the B ratchet is unchanged). **S10 recalibration:** density also requires file V ≥ 8 (the current rule fired on 6 of 6 everyday samples). The `no-param-reassign` part counts only new helpers called directly in the same file (drops Immer reducers and Express/Koa `ctx`). | C, B, E |
| D18 | New trigger **S12 residue shift** (routing). Per C file: residue CogC ≥ 8 AND residue > Σ function CogC in that file AND (the file is new, or its residue rose by ≥ 5). PR-wide: Σ max(0, residue_C − residue_B) over changed files > 15. Measured: 0 of 1,562 dependency files, 1 of 176 repo files. | B |
| D19 | No G1 triggers on test files while tests are observe. Add a G3 rule: a new edge from a product file into a test-glob or excluded path is FAIL `DEP_FORBIDDEN_EDGE` (spec V8 `no-restricted-paths`, previously missing). | C |
| D20 | S9 minimum visible-branch drop: 3 on the density path, 2 on the line path (the line path already requires lines not to shrink, which is the V10 shape). | B |
| D21 | (a) If the pinned-Prettier normalization of B and C is identical and the sequences of (name, kind, CogC, CC) are equal, match by ordinal with no S5. (b) For a k-to-k ambiguous group of the same name, kind and parent chain in the same file: sort both by CogC descending and accept when each C ≤ max(T, paired B). Mark every unit S5 identity-changed; otherwise `UNMATCHED_OVER_BUDGET`. (c) In G2, for unmatched units, cap the new-violation surplus per rule at the file-level count increase (PR-level for moves). | B, C |

New contract items (owner: orchestrator):

- `TriggerId` gains `S12`.
- `UnmeasuredReason` gains `FOREIGN_LANGUAGE`.
- `GateMode` gains `degraded`.
- New policy fields: `scope.foreign_code_extensions`, `lint.dynamic_code_allowlist`.
