import { expect, test } from 'vitest'
import { exitCode, formatAnnotations, formatSummary, formatText } from '../src/report.ts'
import type { Report } from '../src/run.ts'

test('equivalent mutants are counted, but neither annotated nor failing', () => {
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.ts'],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 14, operator: 'ComparisonBoundary', description: '`>=` → `>`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [
      { file: '/repo/src/a.ts', line: 3, column: 7, operator: 'Condition', description: '`DEBUG` → `false`' },
      { file: '/repo/src/a.ts', line: 3, column: 17, operator: 'Update', description: '`++` → `--`' },
    ],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'typescript', files: 1, untyped: [] },
    dryRun: false,
  }
  expect(formatText(report)).toBe('nyorori: 1 mutant in 1 changed file: 1 Killed\n  2 mutants dropped as equivalent (TCE)')
  expect(formatSummary(report)).toContain('(1 Killed).\n\n2 mutants dropped as equivalent (TCE).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})

test('TypeScript files judged without types get one line of text, and nothing else', () => {
  const reason = 'TypeScript is unavailable: Unable to resolve @typescript/typescript-win32-x64'
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.ts'],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 15, operator: 'Arithmetic', description: '`+` → `-`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'none', reason, untyped: [{ file: '/repo/src/a.ts', reason }, { file: '/repo/src/b.ts', reason }] },
    dryRun: false,
  }
  expect(formatText(report)).toBe(`nyorori: 1 mutant in 1 changed file: 1 Killed
  2 TypeScript files without type information for \`+\` (${reason}); string concatenation there may be mutated`)
  expect(formatSummary(report)).toBe('## nyorori\n\nAll 1 mutants in the changed code are detected by tests (1 Killed).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
  // Turned off on purpose: nothing to explain.
  expect(formatText({ ...report, types: { backend: 'none', reason: 'disabled with --no-types', untyped: [] } })).toBe('nyorori: 1 mutant in 1 changed file: 1 Killed')
})

test('a predicted survivor shows why no test can notice it; skipped string `+` is counted', () => {
  const reason = 'no test makes `user` null or undefined here'
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.js'],
    results: [
      { id: 1, file: '/repo/src/a.js', line: 2, column: 14, operator: 'OptionalChaining', description: '`?.` → `.`', status: 'Survived', tests: ['test/a.test.js'], reason, predicted: true },
      { id: 2, file: '/repo/src/a.js', line: 5, column: 3, operator: 'Update', description: '`++` → `--`', status: 'Survived', tests: ['test/a.test.js'] },
    ],
    equivalent: [],
    skipped: [
      { id: 3, file: '/repo/src/a.js', line: 8, column: 17, operator: 'Arithmetic', description: '`+` → `-`', reason: 'string concatenation in every observed evaluation' },
      { id: 4, file: '/repo/src/a.js', line: 9, column: 17, operator: 'Arithmetic', description: '`+` → `-`', reason: 'string concatenation in every observed evaluation' },
    ],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'none', reason: 'disabled with --no-types', untyped: [] },
    dryRun: false,
  }
  expect(formatText(report)).toBe(`nyorori: 2 mutants in 1 changed file: 2 Survived
  Survived   src/a.js:2:14  OptionalChaining  \`?.\` → \`.\`  (${reason})
  Survived   src/a.js:5:3  Update  \`++\` → \`--\`  (every test still passes with this change)
  2 mutants skipped: string concatenation in every observed evaluation`)
  expect(formatAnnotations(report)[0]).toBe(
    '::error file=src/a.js,line=2,col=14,title=nyorori%3A mutant survived::No test fails when OptionalChaining changes this code (`?.` → `.`): no test makes `user` null or undefined here. Add a test that checks this behavior.',
  )
  expect(formatSummary(report)).toContain(`| Survived | \`src/a.js:2:14\` | OptionalChaining | \`?.\` → \`.\` | ${reason} |
| Survived | \`src/a.js:5:3\` | Update | \`++\` → \`--\` | every test still passes with this change |

2 mutants skipped: string concatenation in every observed evaluation.
`)
  expect(exitCode(report)).toBe(1)
  // Skipped mutants alone never fail the run.
  expect(exitCode({ ...report, results: [] })).toBe(0)
})

test('with --no-predict, a survivor the profile got wrong is reported, without failing the run', () => {
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.js'],
    results: [
      { id: 1, file: '/repo/src/a.js', line: 3, column: 9, operator: 'ComparisonBoundary', description: '`<` → `<=`', status: 'Killed', tests: ['test/a.test.js'], reason: 'no test has `x === lo`', mispredicted: 'Killed' },
    ],
    equivalent: [],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'none', reason: 'disabled with --no-types', untyped: [] },
    dryRun: false,
  }
  expect(formatText(report)).toBe(`nyorori: 1 mutant in 1 changed file: 1 Killed
  MISPREDICT src/a.js:3:9  ComparisonBoundary  \`<\` → \`<=\`  (predicted to survive: no test has \`x === lo\`; Killed when run)`)
  expect(formatSummary(report)).toContain('### Wrong predictions')
  expect(formatSummary(report)).toContain('- `src/a.js:3:9` ComparisonBoundary `<` → `<=`: Killed, predicted to survive (no test has `x === lo`)')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})

test('`?.` and `??` unnecessary by types are counted and listed in the summary, but neither annotated nor failing', () => {
  const reason = "`user` is `User` by its type, which can't be null or undefined, and no test passed null or undefined"
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.ts'],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 3, operator: 'FunctionBody', description: 'body → `return`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [],
    skipped: [],
    unnecessary: [{ id: 2, file: '/repo/src/a.ts', line: 3, column: 14, operator: 'OptionalChaining', description: '`?.` → `.`', reason, tests: ['test/a.test.ts'] }],
    suppressions: [],
    problems: [],
    types: { backend: 'typescript', files: 1, untyped: [] },
    dryRun: false,
  }
  expect(formatText(report)).toBe(`nyorori: 1 mutant in 1 changed file: 1 Killed
  1 mutant unnecessary by types: \`?.\` or \`??\` where the type can't be null or undefined and no test made it so`)
  expect(formatSummary(report)).toBe(`## nyorori

All 1 mutants in the changed code are detected by tests (1 Killed).

### Unnecessary by types

These \`?.\` and \`??\` guard values whose types say they can't be null or undefined, and no test passed null or undefined. \
They are probably redundant defensive code: consider removing the \`?.\` or \`??\`. \
If the value really can be null or undefined (data from outside, \`as\`, \`!\`), add a test that passes it. They do not fail the check.

| Location | Operator | Change | Why |
|---|---|---|---|
| \`src/a.ts:3:14\` | OptionalChaining | \`?.\` → \`.\` | ${reason} |
`)
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)

  // With --no-predict they run; one that did not survive is a wrong prediction, and still does not fail the run.
  const wrong: Report = { ...report, unnecessary: [{ ...report.unnecessary[0]!, mispredicted: 'Killed' }] }
  expect(formatText(wrong)).toContain(`  MISPREDICT src/a.ts:3:14  OptionalChaining  \`?.\` → \`.\`  (unnecessary by types: ${reason}; Killed when run)`)
  expect(formatSummary(wrong)).toContain(`- \`src/a.ts:3:14\` OptionalChaining \`?.\` → \`.\`: Killed, unnecessary by types (${reason})`)
  expect(formatAnnotations(wrong)).toEqual([])
  expect(exitCode(wrong)).toBe(0)
})
