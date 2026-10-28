# Design disputes raised by the builders (round 1)

Each item: the spec's position vs the builder's position. Spec = docs/SPEC.md.

- D1 (G4, builder D) Protected-path changes by humans. Brief asked FAIL PROTECTED_PATH_MODIFIED for any protected path change. Builder D: spec 2.4 says the 12.2 list is mechanical FAIL only for the AI loop; humans go through CODEOWNERS. Implemented: humans get TEST_CONFIG_WEAKENED only when a concrete weakening is detected; other protected changes are observe.
- D2 (G4, D) A newly added `it.todo` is FAIL per spec 8.3. D proposes moving todo to S7/observe since it claims no coverage.
- D3 (G4, D) Renamed test titles count as TEST_REMOVED (needs gate-owners approval). D proposes: same file + unchanged assertion multiset + new test passed → treat as rename → S7.
- D4 (G4, D) JUnit cannot distinguish todo/skipped nor split ancestors reliably. D proposes JSON-only in policy.
- D5 (manifest, builder A) Any extension not registered in policy → INCONCLUSIVE (spec 6.2). So a PR touching `.py`/`.sh` is INCONCLUSIVE until listed. A proposes a broader default non-code/tooling list, or making UNREGISTERED_EXTENSION observe-only.
- D6 (manifest, A) Extensionless files ("") are in the default non_code list → a shebang node script `bin/cli` is silently NOT_CODE. A proposes shebang detection or dropping "".
- D7 (G3, builder C) "New cycle" defined per edge: C has a new cycle iff an edge absent in B lies inside a cyclic SCC of C. Type-only edges and lazy `import()` edges excluded from cycle detection ("new runtime cycle").
- D8 (G2/S9, C) Spec 7.4 lists "부수효과가 있는 논리 할당" as S9. C keeps `x ||= call()` / `??= call()` (memo idiom) clean; flags nested writes and calls under `&&=`.
- D9 (G2, C) `@ts-expect-error` counts as an added suppression (spec lists @ts-ignore/@ts-nocheck). Allowlistable.
- D10 (G2, C) Non-literal `import()` is blocked per spec 7.4; C argues a template literal with a static relative prefix (`import(\`./locales/${l}.js\`)`) should be S11 trigger, not block.
- D11 (G2, C) All G2 rules except max-nested-callbacks apply to test files (incl. max-params blocking).
- D12 (G2/S4, C) S4 uses ESLint max-lines-per-function (skip blank/comments), not Prettier-normalized lines, so compressing a function onto fewer lines evades S4.
- D13 (G6, builder E) Rubric polarity: spec 7.6 says REQUIRED = "1~4번 중 하나 이상 '아니오'", but for Q1/Q3/Q4 "예" is the bad answer. E rephrased every item as pass/fail; fail needs file:line evidence.
- D14 (waivers, E) Extra non-waivable reasons beyond spec 11.1: DYNAMIC_CODE, BIDI_CONTROL, SUPPRESSION_ADDED, TESTS_FAILED, TEST_NO_ASSERTION, review reasons.
- D15 (waivers, E) Approval command must carry `blob=<sha>` so the approver is bound to the code they saw.
- D16 (aggregate, E) Triggers from observe-mode gates do not route to G6 (e.g. in P1 G1 is observe, so S1/S9 from G1 do not require review; S7 from G4 enforce does).
- D17 (G1 triggers, builder B) Measured: S1 and S9 never fire on NEW code (they compare against B). An AI that writes the f/f′/i/e′ shapes from scratch gets no G1 trigger; only G2 selectors (S9) and DYNAMIC_CODE catch them. Spec 7.5 implies S1/S9 cover the AI loop. Should there be an absolute (B-independent) shape trigger for new code?
- D18 (G1, B) e′: splitting field-initializer logic across two files keeps each residue under 15 → G1 PASS. Is S3 (single-importer modules ≥ 2) enough?
- D19 (G1, B) Test files fire no G1 triggers while tests are observe-only (a new spec file would always fire S10).
- D20 (S9, B) B requires a ≥3 visible-branch drop on BOTH S9 paths (spec has the min drop only on the density path), to avoid firing when one `if` is removed from a tiny file.
- D21 (matching, B) Stage 4 resolves same-hunk ambiguity only when scores are unchanged; if two same-name legacy methods both improve (20→19, 18→17) both FAIL UNMATCHED_OVER_BUDGET. A whole-file reformat drops allowances of non-unique names and fires S5 identity-changed on all unique legacy units. Accept as "확실하지 않으면 신규" or mitigate?
