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
    dryRun: false,
  }
  expect(formatText(report)).toBe('nyorori: 1 mutant in 1 changed file: 1 Killed\n  2 mutants dropped as equivalent (TCE)')
  expect(formatSummary(report)).toContain('(1 Killed).\n\n2 mutants dropped as equivalent (TCE).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})
