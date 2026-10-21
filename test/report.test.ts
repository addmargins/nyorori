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
    suppressions: [],
    problems: [],
    types: { backend: 'tsrs', files: 1, untyped: [] },
    dryRun: false,
  }
  expect(formatText(report)).toBe('nyorori: 1 mutant in 1 changed file: 1 Killed\n  2 mutants dropped as equivalent (TCE)')
  expect(formatSummary(report)).toContain('(1 Killed).\n\n2 mutants dropped as equivalent (TCE).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})

test('TypeScript files judged without types get one line of text, and nothing else', () => {
  const reason = 'tsrs is unavailable: Cannot find the optional dependency @tsrs/win32-x64'
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    files: ['src/a.ts'],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 15, operator: 'Arithmetic', description: '`+` → `-`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [],
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
