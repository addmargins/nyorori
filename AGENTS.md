# Agent rules for nyorori

Most rules here are enforced by the compiler, the linter, a test or CI. Read the table, run the commands, and trust the failures: each error message names what to use instead. A rule with no enforcer is a judgment call and counts as debt until something enforces it.

## Commands

```bash
npm run typecheck && npm run lint
NYORORI_CCCC=<cccc 1.8.5 binary> npm test        # 1000+ tests; see .claude/skills/verify-nyorori for obtaining cccc
npm run build && node dist/cli.js fixtures --cccc "$NYORORI_CCCC"   # 39 measurer fixtures, 0 drift
NYORORI_CCCC=<cccc> scripts/self-gate.sh origin/main               # the gate judges your change
```

To prove a behaviour change on the real user path (CLI on a throwaway repository, or the webhook service), follow `.claude/skills/verify-nyorori/SKILL.md`.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| A closed set (trigger ids, gate ids, modes and states, reason codes, unmeasured reasons, sides) is listed once, as an `as const` tuple in `src/types.ts`. Schemas, sets and lookups derive from the tuple. | `tsc` through `test/platform/closed-sets.test.ts`; lint rule on literal arrays in `z.enum` |
| Check a git object id with `isObjectId` from `src/util/ids.ts`. | lint (`no-restricted-syntax`) |
| Read the text of a thrown value with `errorMessage` from `src/util/errors.ts`. | lint (`no-restricted-syntax`) |
| A new function has cognitive complexity of at most 15 and at most 4 parameters. A change never makes an over-limit function more complex. | `scripts/self-gate.sh` in CI (`policy/self.policy.json`, read from the base side). Advisory until the scaffold PR lands, then blocking. |
| No dynamic code (`eval`, `Function`, computed `import()`) outside the allowlist in `policy/self.policy.json`. | `scripts/self-gate.sh` (G2) |
| No new import cycle between modules. | `scripts/self-gate.sh` (G3) |
| A refactor keeps every verdict identical. Replay this repository's history with `nyorori replay` before and after (see `docs/plans/agent-friendly-architecture.md`, section on the oracle). | none in CI (debt) |
| Gate output records (`Violation`, `TriggerHit`, `Inconclusive`) are built in one place, and every gate returns the same evaluation shape. | none yet (debt; planned, see the plan) |
| A ruling in `docs/debate/rulings.md` overrides `docs/SPEC.md`; when code follows a ruling, cite it. | none (debt) |
| Behaviour that tests assert is a structured field, not a rendered sentence. | none yet (debt) |
| Fix a reported bug only after reproducing it, and show the check red before the fix and green after. | judgment |
| Make the smallest change that meets the request. No unrelated renames, features or second PRs. | judgment |
| Before splitting work across several agents, land the shared contract (types, builders, registries) they will all use. | judgment |
| Report in Korean. Lead with the result, then the commands you ran and their output. Say what you did not verify. | judgment |

Debt rows: 4. Judgment rows: 4.
