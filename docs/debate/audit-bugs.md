# Correctness review (independent bug hunter, commit 2d4d452)

Repros were under /tmp/audit-bugs (session-local). Dispositions:

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | high | unit key string collision (`"outer>big"` literal name) — same as audit F1 | B |
| 2 | high | ESLint counts U+2028/U+2029/lone CR as line breaks, git/cccc count LF only → G2 line attribution shift hides a new eval | C |
| 3 | high | webhook server crashes on client ECONNRESET (unhandled rejection) before signature check | E |
| 4 | high | extensionless JS (`require("./pricing")`) silently NOT_CODE — same as audit F6 / ruling D6 | A |
| 5 | med | jsx_in_js suffix / invalid-UTF-8 path collision crashes measureSides with EEXIST instead of INCONCLUSIVE | A |
| 6 | med | renaming vitest.config.ts out of protected paths hides weakening | D |
| 7 | med | JUnit parser quadratic regex on untrusted input (moot after D4 JSON-only, still remove + size cap) | D |
| 8 | low | S2 misses growth via deletion-only hunk (cRangeTouched ignores cCount 0) | B |
| 9 | low | matching O(n²) within large sibling groups (10k units 11 s) | B |
| 10 | low | materializeSide reads all blobs in one cat-file call under 512 MB maxBuffer | A |
| 11 | low | UNITS_VANISHED duplicated; declaration_impl_check unwired; file-less override impossible; concurrent check-run last-writer-wins (externalId unchecked) | integrator / E |
