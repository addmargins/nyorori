import { describe, expect, test } from 'vitest'
import { exitCode, formatAnnotations, formatSummary, formatText } from '../src/report.ts'
import type { Report } from '../src/run.ts'

test('equivalent mutants are counted, but neither annotated nor failing', () => {
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    judged: ['src/a.ts'],
    files: ['src/a.ts'],
    notJudged: [],
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
    logGuards: false,
  }
  expect(formatText(report)).toBe('nyorori: 1 mutant in 1 changed file: 1 Killed\n  2 mutants dropped as equivalent (TCE)')
  expect(formatSummary(report)).toContain('(1 Killed).\n\n2 mutants dropped as equivalent (TCE).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})

test('a dry run lists its mutants as NotRun, and neither counts nor annotates them as findings', () => {
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    judged: ['src/a.ts'],
    files: ['src/a.ts'],
    notJudged: [],
    results: [
      { id: 1, file: '/repo/src/a.ts', line: 2, column: 14, operator: 'ComparisonBoundary', description: '`>=` → `>`', status: 'NotRun', tests: [] },
      { id: 2, file: '/repo/src/a.ts', line: 3, column: 10, operator: 'Condition', description: '`ok` → `true`', status: 'NotRun', tests: [] },
    ],
    equivalent: [],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'typescript', files: 1, untyped: [] },
    dryRun: true,
    logGuards: false,
  }
  expect(formatText(report)).toBe(`nyorori: 2 mutants in 1 changed file (dry run)
  src/a.ts:2:14  ComparisonBoundary  \`>=\` → \`>\`
  src/a.ts:3:10  Condition  \`ok\` → \`true\``)
  expect(formatSummary(report)).toBe('## nyorori\n\n2 mutants in 1 changed file, none run (dry run).\n')
  expect(formatAnnotations(report)).toEqual([])
  expect(exitCode(report)).toBe(0)
})

test('TypeScript files judged without types get one line of text, and nothing else', () => {
  const reason = 'TypeScript is unavailable: Unable to resolve @typescript/typescript-win32-x64'
  const report: Report = {
    gitRoot: '/repo',
    base: 'abc',
    judged: ['src/a.ts'],
    files: ['src/a.ts'],
    notJudged: [],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 15, operator: 'Arithmetic', description: '`+` → `-`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'none', reason, untyped: [{ file: '/repo/src/a.ts', reason }, { file: '/repo/src/b.ts', reason }] },
    dryRun: false,
    logGuards: false,
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
    judged: ['src/a.js'],
    files: ['src/a.js'],
    notJudged: [],
    results: [
      { id: 1, file: '/repo/src/a.js', line: 2, column: 14, operator: 'OptionalChaining', description: '`?.` → `.`', status: 'Survived', tests: ['test/a.test.js'], reason, predicted: true },
      // run() gives a survivor the profile has nothing on the words of the text output.
      { id: 2, file: '/repo/src/a.js', line: 5, column: 3, operator: 'Update', description: '`++` → `--`', status: 'Survived', tests: ['test/a.test.js'], reason: 'every test still passes with this change' },
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
    logGuards: false,
  }
  expect(formatText(report)).toBe(`nyorori: 2 mutants in 1 changed file: 2 Survived
  Survived   src/a.js:2:14  OptionalChaining  \`?.\` → \`.\`  (${reason})
  Survived   src/a.js:5:3  Update  \`++\` → \`--\`  (every test still passes with this change)
  2 mutants skipped: string concatenation in every observed evaluation`)
  expect(formatAnnotations(report)).toEqual([
    '::error file=src/a.js,line=2,col=14,title=nyorori%3A mutant survived::No test fails when OptionalChaining changes this code (`?.` → `.`): no test makes `user` null or undefined here. Add a test that checks this behavior.',
    '::error file=src/a.js,line=5,col=3,title=nyorori%3A mutant survived::No test fails when Update changes this code (`++` → `--`). Add or strengthen a test that checks this behavior.',
  ])
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
    judged: ['src/a.js'],
    files: ['src/a.js'],
    notJudged: [],
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
    logGuards: false,
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
    judged: ['src/a.ts'],
    files: ['src/a.ts'],
    notJudged: [],
    results: [{ id: 1, file: '/repo/src/a.ts', line: 2, column: 3, operator: 'FunctionBody', description: 'body → `return`', status: 'Killed', tests: ['test/a.test.ts'] }],
    equivalent: [],
    skipped: [],
    unnecessary: [{ id: 2, file: '/repo/src/a.ts', line: 3, column: 14, operator: 'OptionalChaining', description: '`?.` → `.`', reason, tests: ['test/a.test.ts'] }],
    suppressions: [],
    problems: [],
    types: { backend: 'typescript', files: 1, untyped: [] },
    dryRun: false,
    logGuards: false,
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

describe('changed files that were not judged', () => {
  const base: Report = {
    gitRoot: '/repo',
    base: 'abc',
    judged: [],
    files: [],
    notJudged: [],
    results: [],
    equivalent: [],
    skipped: [],
    unnecessary: [],
    suppressions: [],
    problems: [],
    types: { backend: 'none', reason: 'disabled with --no-types', untyped: [] },
    dryRun: false,
    logGuards: false,
  }

  test('a component file stops the run with exit code 2 and says how to leave it out', () => {
    const report: Report = {
      ...base,
      notJudged: [
        { file: 'src/App.vue', reason: 'unsupported' },
        { file: 'src/Card.svelte', reason: 'unsupported' },
        { file: 'src/App.test.ts', reason: 'test' },
        { file: 'src/old.ts', reason: 'deleted' },
      ],
    }
    expect(formatText(report)).toBe(`nyorori: 2 changed files of a type nyorori cannot mutate, so nothing was judged.
  NOT JUDGED src/App.vue  (a file type nyorori cannot mutate)
  NOT JUDGED src/Card.svelte  (a file type nyorori cannot mutate)
  nyorori mutates only JavaScript and TypeScript. Leave these files out with --exclude '**/*.vue' --exclude '**/*.svelte' (the Action's \`exclude\` input) to judge the rest.
  Not judged: 1 test file, 1 deleted file`)
    expect(exitCode(report)).toBe(2)
    expect(formatAnnotations(report)).toEqual([
      '::error file=src/App.vue,title=nyorori%3A file type not supported::nyorori cannot mutate .vue files, so this change was not judged. Leave such files out with the exclude input (for example **/*.vue) to judge the rest.',
      '::error file=src/Card.svelte,title=nyorori%3A file type not supported::nyorori cannot mutate .svelte files, so this change was not judged. Leave such files out with the exclude input (for example **/*.svelte) to judge the rest.',
    ])
    expect(formatSummary(report)).toBe(`## nyorori

2 changed files of a type nyorori cannot mutate, so nothing was judged.

nyorori mutates only JavaScript and TypeScript. Leave these files out with the \`exclude\` input (\`**/*.vue\`, \`**/*.svelte\`) to judge the rest.

### Not judged

| File | Why |
|---|---|
| \`src/App.vue\` | **a file type nyorori cannot mutate** |
| \`src/Card.svelte\` | **a file type nyorori cannot mutate** |

Not judged: 1 test file, 1 deleted file.
`)
    // A dry run judges nothing anyway: it lists them and passes.
    expect(exitCode({ ...report, dryRun: true })).toBe(0)
    expect(formatText({ ...report, dryRun: true })).toContain('nyorori: no changed source files were judged.\n  NOT JUDGED src/App.vue')
  })

  test('files outside the root or the coverage config are warnings that do not fail the run', () => {
    const outside = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ file: `packages/web/src/${name}.ts`, reason: 'outside-root' as const }))
    const report: Report = {
      ...base,
      judged: ['packages/core/src/a.ts'],
      notJudged: [...outside, { file: 'packages/core/src/gen.ts', reason: 'coverage-exclude' }, { file: 'packages/core/scripts/x.ts', reason: 'excluded' }],
    }
    expect(formatText(report)).toBe(`nyorori: no mutants in the changed code of 1 judged file.
  WARNING    6 changed source files outside the Vitest root were not judged: packages/web/src/a.ts, packages/web/src/b.ts, packages/web/src/c.ts, packages/web/src/d.ts, packages/web/src/e.ts and 1 more
  WARNING    1 changed source file in coverage.exclude of the Vitest config was not judged: packages/core/src/gen.ts
  Not judged: 1 file matching --exclude`)
    expect(exitCode(report)).toBe(0)
    expect(formatAnnotations(report)).toEqual([
      '::warning title=nyorori%3A changed files not judged::6 changed source files outside the Vitest root were not judged: packages/web/src/a.ts, packages/web/src/b.ts, packages/web/src/c.ts, packages/web/src/d.ts, packages/web/src/e.ts and 1 more',
      '::warning title=nyorori%3A changed files not judged::1 changed source file in coverage.exclude of the Vitest config was not judged: packages/core/src/gen.ts',
    ])
    expect(formatSummary(report)).toContain(`### Not judged

> [!WARNING]
> 6 changed source files outside the Vitest root were not judged: packages/web/src/a.ts, packages/web/src/b.ts, packages/web/src/c.ts, packages/web/src/d.ts, packages/web/src/e.ts and 1 more

> [!WARNING]
> 1 changed source file in coverage.exclude of the Vitest config was not judged: packages/core/src/gen.ts

| File | Why |
|---|---|
| \`packages/web/src/a.ts\` | outside the Vitest root |
`)
  })

  test('says plainly when coverage.include matches none of the changed source files', () => {
    const report: Report = { ...base, notJudged: [{ file: 'src/a.ts', reason: 'coverage-include' }, { file: 'src/b.ts', reason: 'coverage-include' }] }
    expect(formatText(report)).toBe(`nyorori: no changed source files were judged.
  WARNING    coverage.include in the Vitest config matches none of the changed source files, so none was judged: src/a.ts, src/b.ts`)
    expect(exitCode(report)).toBe(0)
    // When it matches another one, it is only that these are not in it.
    expect(formatText({ ...report, judged: ['src/c.ts'] })).toContain('WARNING    2 changed source files not in coverage.include of the Vitest config were not judged: src/a.ts, src/b.ts')
  })

  test('tells a change without source files from one whose source files were all left out', () => {
    expect(formatText(base)).toBe('nyorori: no changed source files to judge.')
    expect(formatSummary(base)).toBe('## nyorori\n\nNo changed source files to judge.\n')
    expect(formatText({ ...base, notJudged: [{ file: 'test/a.test.ts', reason: 'test' }, { file: 'vitest.config.ts', reason: 'config' }] }))
      .toBe('nyorori: no changed source files were judged.\n  Not judged: 1 test file, 1 config file')
  })
})
