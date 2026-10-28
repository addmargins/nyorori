# Security review (round 3, independent reviewer)

Two adversarial red-team runs were stopped early by a safety check; their open questions were
converted into acceptance tests (`test/e2e/acceptance.test.ts`), and a scoped defensive review of
our own service code was run instead. Findings and owners:

| # | Sev | Finding | Owner |
|---|---|---|---|
| 0 | high | `.gitignore` `coverage/` also ignored `src/gates/coverage/` → clean checkout failed tsc | fixed (anchored `/coverage/`) |
| 1 | high | edited comments accepted as the original author's commands | E |
| 2 | high | artifact zip bomb aborts the service (no entry/size/ratio caps) | E |
| 3 | med-high | logic in inline `<script>` of .html/.svg/.htm silently NOT_CODE | A |
| 4 | med | non-relative imports of unmeasured files (package `imports`, self-reference, literal `x?raw`) escape S11 | C |
| 5 | med | concurrent evaluations: an older one can overwrite a newer verdict | E |
| 6 | low-med | editing a comment to retract a command does not re-evaluate | E |
| 7 | med | approver independence: unresolved co-author emails, 250-commit API cap treated as complete | E |
| 8 | med | approval bound to comment time, not the code seen → require `sha=<head>` | E |
| 9 | low | collisions folded with toLowerCase only (NFC/NFD, ı/I) | A |
| 10 | low | full-tree materialization race on failure; over-long paths make every PR INCONCLUSIVE | integrator, A |
| 11 | low | webhook replay under new delivery id / event name | E |
| DiD | — | commands inside HTML comments / indented code counted; quarter waiver budget unwired in service; merge_group multi-PR identity; artifact run conclusion/event; CommentHeadStore locking | E |

Verified correct: HMAC on raw bytes with timingSafeEqual; own-App check runs only; provenance allowlist;
token never in argv/env of git or cccc; cccc `--no-config --no-cache` with empty env; ESLint/Prettier/
dependency-cruiser load no candidate config (26 levers tested, 0 loaded); blob-based trees.
