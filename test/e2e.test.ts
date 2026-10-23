import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { Report } from '../src/run.ts'

const REPO = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO, 'src', 'cli.ts')

type Files = Record<string, string>

/** A git repository under .tmp (so `vitest` resolves to ours) with a base commit and a head commit. */
function project(name: string, base: Files, head: Files): string {
  const dir = path.join(REPO, '.tmp', `e2e-${name}`)
  rmSync(dir, { recursive: true, force: true })
  const write = (files: Files) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), content)
    }
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  write({ 'package.json': '{ "type": "module" }\n', ...base })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
  write(head)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'head')
  return dir
}

function nyorori(dir: string, ...args: string[]): { status: number | null; output: string; report?: Report; leftovers: string[] } {
  return nyororiNode([], dir, ...args)
}

/** The same, with options for Node itself. */
function nyororiNode(node: string[], dir: string, ...args: string[]): ReturnType<typeof nyorori> {
  // Keep the outer Vitest's worker settings away from the nested one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS' && key !== 'GITHUB_ACTIONS'))
  // A private TMPDIR shows whether the run removed its temporary directories.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nyorori-e2e-'))
  const result = spawnSync(process.execPath, [...node, CLI, 'run', '--base', 'HEAD~1', '--json', 'report.json', ...args], { cwd: dir, encoding: 'utf8', env: { ...env, TMPDIR: tmp } })
  const leftovers = readdirSync(tmp)
  rmSync(tmp, { recursive: true, force: true })
  const reportFile = path.join(dir, 'report.json')
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    report: existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : undefined,
    leftovers,
  }
}

function statuses(report: Report): string[] {
  return report.results.map((r) => `${path.relative(report.gitRoot, r.file)}:${r.line} ${r.operator} ${r.description}: ${r.status}`)
}

const AGE_TEST = `import { expect, test } from 'vitest'
import { isAdult, label, sum } from '../src/age'

test('isAdult', () => {
  expect(isAdult(30)).toBe(true)
  expect(isAdult(3)).toBe(false)
})

test('label', () => {
  expect(label(30)).toBe('adult')
  expect(label(3)).toBe('minor')
})

test('sum', () => {
  expect(sum(4)).toBe(6)
})
`

const AGE_BASE = `export function isAdult(age: number): boolean {
  return age > 17
}
`

const AGE_HEAD = `export function isAdult(age: number): boolean {
  return age >= 18
}

export function label(age: number): string {
  if (isAdult(age)) return 'adult'
  return 'minor'
}

export function sum(n: number): number {
  let total = 0
  for (let i = 0; i < n; i++) total += i
  return total
}
`

describe('nyorori run', () => {
  test('judges every mutant of the changed lines', () => {
    const dir = project('judge', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, {
      'src/age.ts': `${AGE_HEAD}
export function untested(n: number): number {
  return n * 2
}
`,
    })
    const { status, report, output, leftovers } = nyorori(dir)
    expect(status, output).toBe(1)
    // The session closes Vitest, so its temporary directories go too.
    expect(leftovers).toEqual([])
    expect(statuses(report!)).toEqual([
      'src/age.ts:2 ComparisonBoundary `>=` → `>`: Survived',
      'src/age.ts:5 FunctionBody body → `return`: Killed',
      'src/age.ts:6 Condition `isAdult(age)` → `true`: Killed',
      'src/age.ts:6 Condition `isAdult(age)` → `false`: Killed',
      // label(3) would be 'adult'.
      'src/age.ts:6 CallUnwrap `isAdult(age)` → `age`: Killed',
      'src/age.ts:10 FunctionBody body → `return`: Killed',
      'src/age.ts:12 Condition `i < n` → `false`: Killed',
      'src/age.ts:12 ComparisonBoundary `<` → `<=`: Killed',
      // i-- never reaches n; the hit limit stops the loop.
      'src/age.ts:12 Update `++` → `--`: Timeout',
      'src/age.ts:16 FunctionBody body → `return`: NoCoverage',
      'src/age.ts:17 Arithmetic `*` → `/`: NoCoverage',
    ])
    expect(report!.results[0]!.tests).toEqual(['test/age.test.ts'])
    expect(output).toContain('Survived   src/age.ts:2:14  ComparisonBoundary  `>=` → `>`')
    // --json says why each failing mutant fails: the profile's reason, or the words of the text output.
    expect(report!.results.filter((r) => r.reason).map((r) => `${r.line} ${r.status}: ${r.reason}`)).toEqual([
      '2 Survived: no test has `age === 18`',
      '16 NoCoverage: no test runs this code',
      '17 NoCoverage: no test runs this code',
    ])
  })

  test('mutates the code that changed, not what a changed line or a reformatted function only kept', () => {
    const base = `export function lastIndex(arr: number[], fromIndex: number): number {
  if (fromIndex < 0) {
    fromIndex = Math.max(arr.length + fromIndex, 0)
  } else {
    fromIndex = Math.min(fromIndex, arr.length - 1)
  }
  return fromIndex
}

export function clamp(x: number, lo: number, hi: number): number {
  // nyorori-ignore-next-line ComparisonBoundary -- equal bounds give the same value
  return x < lo ? lo : x > hi ? hi : x
}
`
    // The pattern of es-toolkit PR 2047, a re-indented function with its suppression, and a new function.
    const head = `export function lastIndex(arr: number[], fromIndex: number): number {
  const index = Math.trunc(fromIndex)
  if (fromIndex < 0) {
    fromIndex = Math.max(arr.length + index, 0)
  } else {
    // nyorori-ignore-next-line Arithmetic -- the last index
    fromIndex = Math.min(index, arr.length - 1)
  }
  return fromIndex
}

export function clamp(x: number, lo: number, hi: number): number {
    // nyorori-ignore-next-line ComparisonBoundary -- equal bounds give the same value
    return x < lo
      ? lo
      : x > hi ? hi : x
}

export function isEven(n: number): boolean {
  return n % 2 === 0
}
`
    const dir = project('tokens', { 'src/find.ts': base }, { 'src/find.ts': head })
    const { status, report, output } = nyorori(dir, '--dry-run')
    expect(status, output).toBe(0)
    expect(report!.results.map((r) => `${r.line}:${r.column} ${r.operator} ${r.description}`)).toEqual([
      '2:22 CallUnwrap `Math.trunc(fromIndex)` → `fromIndex`',
      '4:22 CallUnwrap `Math.max(arr.length + index, 0)` → `arr.length + index`',
      '4:37 Arithmetic `+` → `-`',
      '7:22 CallUnwrap `Math.min(index, arr.length - 1)` → `index`',
      '19:44 FunctionBody body → `return`',
      '20:16 Equality `===` → `!==`',
      '20:12 Arithmetic `%` → `*`',
    ])
    // `arr.length - 1` is no longer in scope, so its new suppression should go; the re-indented one stays.
    expect(report!.problems.map((p) => `${p.line} ${p.message}`)).toEqual(['6 Suppression matches no mutant of Arithmetic on line 7. Remove it.'])
    expect(report!.suppressions.map((s) => `${s.line} ${s.isNew}`)).toEqual(['6 true', '13 true'])
  })

  test('mutates the wrapper calls, call statements and regex flags that fixes add', () => {
    // The kinds of fixes that got no mutant at all when upstream PRs were replayed.
    const base = `export function first(values) {
  return values[0]
}

export function zeroed(values) {
  return values
}

export function rounded(values) {
  return values.map(Math.round)
}

export function unmatched(expected, actual) {
  const rest = new Set(expected)
  for (const key of actual) {
    if (!rest.has(key)) return null
  }
  return [...rest]
}

export function stripTags(html) {
  return html.replace(/<[^>]*>/, '')
}

export function hasTodo(text) {
  return /todo/.test(text)
}
`
    const head = base
      .replace('  return values[0]', '  return normalizeZero(values[0])')
      // A transform added to the end of a call, as in es-toolkit PR 2049.
      .replace('  return values\n', '  return values.map(normalizeZero)\n')
      .replace('  return values.map(Math.round)', '  return values.map(Math.round).map(normalizeZero)')
      .replace('    if (!rest.has(key)) return null\n', '    if (!rest.has(key)) return null\n    rest.delete(key)\n')
      .replace('/<[^>]*>/,', '/<[^>]*>/g,')
      .replace('/todo/.test', '/todo/i.test')
    const dir = project('calls-regex', {
      'src/zero.js': 'export function normalizeZero(x) {\n  return Object.is(x, -0) ? 0 : x\n}\n',
      'src/fix.js': base,
    }, {
      'src/fix.js': `import { normalizeZero } from './zero.js'\n\n${head}`,
      'test/fix.test.js': `import { expect, test } from 'vitest'
import { first, hasTodo, rounded, stripTags, unmatched, zeroed } from '../src/fix.js'

test('first', () => { expect(Object.is(first([-0]), 0)).toBe(true) })
test('zeroed', () => { expect(zeroed([-0, 1])).toEqual([0, 1]) })
// No -0, so no test checks what normalizeZero is for here.
test('rounded', () => { expect(rounded([1.4, 2.6])).toEqual([1, 3]) })
test('unmatched', () => { expect(unmatched(['a', 'b'], ['a'])).toEqual(['b']) })
test('stripTags', () => { expect(stripTags('<b>bold</b>')).toBe('bold') })
// Lowercase only: no test checks what the \`i\` flag is for.
test('hasTodo', () => { expect(hasTodo('todo: x')).toBe(true); expect(hasTodo('done')).toBe(false) })
`,
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(1)
    expect(statuses(report!)).toEqual([
      'src/fix.js:4 CallUnwrap `normalizeZero(values[0])` → `values[0]`: Killed',
      // The transform not applied: only a test with -0 notices.
      'src/fix.js:8 CallUnwrap `values.map(normalizeZero)` → `values`: Killed',
      'src/fix.js:12 CallUnwrap `….map(normalizeZero)` → `…`: Survived',
      'src/fix.js:19 CallStatement `rest.delete(key)` removed: Killed',
      "src/fix.js:25 CallUnwrap `html.replace(/<[^>]*>/g, '')` → `html`: Killed",
      'src/fix.js:25 Regex `[^>]` → `[>]`: Killed',
      'src/fix.js:25 Regex `/…/g` → `/…/`: Killed',
      // `/todo/i.test(text)` gets no CallUnwrap: `text` would only be killed for not being a boolean.
      'src/fix.js:29 Regex `/…/i` → `/…/`: Survived',
    ])
    expect(report!.results.at(-1)).toMatchObject({ reason: 'every test still passes with this change' })
    expect(report!.results.at(-1)).not.toHaveProperty('predicted')
    expect(output).toContain('Survived   src/fix.js:12:33  CallUnwrap  `….map(normalizeZero)` → `…`  (every test still passes with this change)')
    expect(output).toContain('Survived   src/fix.js:29:16  Regex  `/…/i` → `/…/`  (every test still passes with this change)')
  })

  test('reverts a changed literal, which survives where no test checks the new value', () => {
    const limits = "export function maxItems(options) {\n  return options.max || 1000\n}\n\nexport function slug(s) {\n  return s.replace(/[^a-z]+/g, '-')\n}\n"
    const dir = project('revert', {
      'src/limits.js': limits,
      // Checks that there is a default, not which one; and checks digits in a slug.
      'test/limits.test.js': "import { expect, test } from 'vitest'\nimport { maxItems, slug } from '../src/limits.js'\ntest('maxItems', () => { expect(maxItems({ max: 3 })).toBe(3); expect(maxItems({})).toBeGreaterThan(0) })\ntest('slug', () => { expect(slug('a1 b')).toBe('a1-b') })\n",
    }, { 'src/limits.js': limits.replace('1000', '500').replace('[^a-z]', '[^a-z0-9]') })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(1)
    expect(statuses(report!).filter((s) => s.includes(' Revert '))).toEqual([
      'src/limits.js:2 Revert `500` → `1000` (before this PR): Survived',
      'src/limits.js:6 Revert `/[^a-z0-9]+/g` → `/[^a-z]+/g` (before this PR): Killed',
    ])
    expect(output).toContain('Survived   src/limits.js:2:25  Revert  `500` → `1000` (before this PR)  (every test still passes with this change)')
  })

  test('a reasoned suppression turns a survivor into a reported, passing Ignored', () => {
    const dir = project('suppress', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, {
      'src/age.ts': AGE_HEAD.replace('  return age >= 18', '  // nyorori-ignore-next-line ComparisonBoundary -- callers validate age first\n  return age >= 18'),
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(0)
    expect(report!.results[0]).toMatchObject({ operator: 'ComparisonBoundary', status: 'Ignored' })
    expect(report!.suppressions).toMatchObject([{ line: 2, targetLine: 3, isNew: true, reason: 'callers validate age first' }])
    expect(output).toContain('NEW IGNORE src/age.ts:2  ComparisonBoundary -- callers validate age first')
  })

  test('suppressing a mutant the tests already kill is a finding', () => {
    const dir = project('unnecessary', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, {
      'src/age.ts': AGE_HEAD
        .replace('  return age >= 18', '  // nyorori-ignore-next-line ComparisonBoundary -- fine\n  return age >= 18')
        .replace("  if (isAdult(age)) return 'adult'", "  // nyorori-ignore-next-line Condition -- not needed\n  if (isAdult(age)) return 'adult'")
        .replace('  let total = 0', '  // nyorori-ignore-next-line Logical -- nothing to suppress\n  let total = 0'),
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(1)
    expect(report!.problems.map((p) => `${p.line} ${p.message}`)).toEqual([
      '13 Suppression matches no mutant of Logical on line 14. Remove it.',
      '7 Unnecessary suppression: tests already detect every mutant it matches (Condition `isAdult(age)` → `true`, Condition `isAdult(age)` → `false`). Remove it.',
    ])
    // They keep their verdicts; only the survivor on line 3 is ignored.
    expect(statuses(report!).filter((s) => s.includes(' Condition ') || s.includes(' ComparisonBoundary '))).toEqual([
      'src/age.ts:3 ComparisonBoundary `>=` → `>`: Ignored',
      'src/age.ts:8 Condition `isAdult(age)` → `true`: Killed',
      'src/age.ts:8 Condition `isAdult(age)` → `false`: Killed',
      'src/age.ts:15 Condition `i < n` → `false`: Killed',
      'src/age.ts:15 ComparisonBoundary `<` → `<=`: Killed',
    ])
  })

  test('a suppression ignores the survivors it matches, and the mutants that tests kill stay Killed', () => {
    // es-toolkit `chunk`: without the fast path the loop returns [] too, so `→ false` is equivalent; `→ true` is killed.
    const chunk = 'export function chunk<T>(xs: T[], size: number): T[][] {\n  const out: T[][] = []\n  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))\n  return out\n}\n'
    const dir = project('suppress-fast-path', {
      'src/chunk.ts': chunk,
      'test/chunk.test.ts': "import { expect, test } from 'vitest'\nimport { chunk } from '../src/chunk'\ntest('chunk', () => { expect(chunk([], 2)).toEqual([]); expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]) })\n",
    }, {
      'src/chunk.ts': chunk.replace('  const out', '  // nyorori-ignore-next-line Condition -- the loop returns [] for an empty array too\n  if (xs.length === 0) return []\n  const out'),
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(0)
    expect(statuses(report!)).toEqual([
      'src/chunk.ts:3 Condition `xs.length === 0` → `true`: Killed',
      'src/chunk.ts:3 Condition `xs.length === 0` → `false`: Ignored',
      'src/chunk.ts:3 Equality `===` → `!==`: Killed',
    ])
    expect(report!.problems).toEqual([])
  })

  test('a suppression does not apply to code that no test runs', () => {
    const dir = project('suppress-untested', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST.replace(/\ntest\('label'[^]*$/, '\n') }, {
      'src/age.ts': `${AGE_BASE}
export function double(n: number): number {
  // nyorori-ignore-next-line Arithmetic -- doubling cannot be observed
  return n * 2
}
`,
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(1)
    expect(statuses(report!)).toEqual(['src/age.ts:5 FunctionBody body → `return`: NoCoverage', 'src/age.ts:7 Arithmetic `*` → `/`: NoCoverage'])
    expect(output).toContain('NoCoverage src/age.ts:7:12  Arithmetic  `*` → `/`  (no test runs this code, and a suppression does not apply to untested code)')
    // It still matches a mutant, so it is not reported as stale.
    expect(report!.problems).toEqual([])
  })

  test('kills and restarts the Vitest session when a mutant hangs code it cannot instrument', () => {
    const dir = project('hang', {
      // Unchanged, so not instrumented: a bad stride makes this loop forever without touching a mutant site.
      'src/walk.ts': `import { stride } from './stride'
export function walk(n: number): number {
  const step = stride()
  let i = 0
  while (i !== n) i += step
  return i
}
`,
      'src/stride.ts': 'export function stride(): number {\n  return 1\n}\n',
      'test/walk.test.ts': `import { expect, test } from 'vitest'
import { walk } from '../src/walk'
import { double } from '../src/stride'
test('walk', () => { expect(walk(4)).toBe(4) })
test('double', () => { expect(double(3)).toBe(6) })
`,
    }, {
      'src/stride.ts': 'export function stride(): number {\n  return 2 - 1\n}\n\nexport function double(x: number): number {\n  return x * 2\n}\n',
    })
    const { status, report, output, leftovers } = nyorori(dir, '--timeout', '1500')
    expect(status, output).toBe(0)
    // Line 1 is unchanged, so stride() gets no FunctionBody mutant.
    expect(statuses(report!)).toEqual([
      'src/stride.ts:2 Arithmetic `-` → `+`: Timeout',
      'src/stride.ts:5 FunctionBody body → `return`: Killed',
      'src/stride.ts:6 Arithmetic `*` → `/`: Killed',
    ])
    // Killed sessions cannot clean up after themselves; the CLI removes their setup directory.
    // Vitest's own temporary directory of a killed session stays behind.
    expect(leftovers.filter((name) => name.startsWith('nyorori-'))).toEqual([])
  })

  test('drops mutants that minify to the original code, reports them and passes', () => {
    const dir = project('equivalent', {
      'src/age.ts': AGE_BASE,
      'test/age.test.ts': "import { expect, test } from 'vitest'\nimport { isAdult } from '../src/age'\ntest('isAdult', () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false) })\n",
    }, {
      'src/age.ts': 'const LENIENT = false\n\nexport function isAdult(age: number): boolean {\n  if (LENIENT) age++\n  return age > 17\n}\n',
    })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(0)
    expect(statuses(report!)).toEqual(['src/age.ts:4 Condition `LENIENT` → `true`: Killed'])
    expect(report!.equivalent.map((m) => `${path.relative(report!.gitRoot, m.file)}:${m.line} ${m.operator} ${m.description}`)).toEqual([
      'src/age.ts:4 Condition `LENIENT` → `false`',
      'src/age.ts:4 Update `++` → `--`',
    ])
    expect(output).toContain('2 mutants dropped as equivalent (TCE)')
  })

  describe('types', () => {
    const TSCONFIG = '{ "compilerOptions": { "strict": true, "module": "nodenext", "noEmit": true }, "include": ["src"] }\n'
    // Destructured, so only the types tell that `first + last` joins strings.
    const NAME = `export function fullName({ first, last }: { first: string; last: string }): string {
  return first + last
}

export function total(a: number, b: number): number {
  return a + b
}
`
    const NAME_TEST = `import { expect, test } from 'vitest'
import { fullName, total } from '../src/name'
test('fullName', () => { expect(fullName({ first: 'Ada ', last: 'Lovelace' })).toBe('Ada Lovelace') })
test('total', () => { expect(total(2, 3)).toBe(5) })
`
    const arithmetic = (report: Report) => report.results.filter((r) => r.operator === 'Arithmetic').map((r) => r.line)

    test('does not mutate a `+` that joins string variables, by their types', ({ skip }) => {
      const dir = project('types', { 'tsconfig.json': TSCONFIG, 'src/name.ts': 'export {}\n' }, { 'src/name.ts': NAME, 'test/name.test.ts': NAME_TEST })
      const { status, report, output } = nyorori(dir)
      const { types } = report!
      if (types.backend === 'none') skip(types.reason.startsWith('TypeScript is unavailable'), `TypeScript cannot run here: ${types.reason}`)
      expect(status, output).toBe(0)
      expect(types).toEqual({ backend: 'typescript', files: 1, untyped: [] })
      expect(statuses(report!)).toEqual([
        'src/name.ts:1 FunctionBody body → `return`: Killed',
        'src/name.ts:5 FunctionBody body → `return`: Killed',
        'src/name.ts:6 Arithmetic `+` → `-`: Killed',
      ])
      expect(output).not.toContain('without type information')

      const syntactic = nyorori(dir, '--no-types', '--dry-run').report!
      expect(syntactic.types).toEqual({ backend: 'none', reason: 'disabled with --no-types', untyped: [] })
      expect(arithmetic(syntactic)).toEqual([2, 6])
    })

    test('does the same in JavaScript that TypeScript checks as strictly as TypeScript', ({ skip }) => {
      const jsconfig = '{ "compilerOptions": { "checkJs": true, "strict": true, "module": "nodenext", "noEmit": true }, "include": ["src"] }\n'
      const dir = project('types-js', { 'jsconfig.json': jsconfig, 'src/name.js': 'export {}\n' }, {
        'src/name.js': `/** @param {{ first: string, last: string }} name */
export function fullName(name) {
  return name.first + name.last
}

/**
 * @param {number} a
 * @param {number} b
 */
export function total(a, b) {
  return a + b
}
`,
      })
      const { status, report, output } = nyorori(dir, '--dry-run')
      const { types } = report!
      if (types.backend === 'none') skip(types.reason.startsWith('TypeScript is unavailable'), `TypeScript cannot run here: ${types.reason}`)
      expect(status, output).toBe(0)
      expect(types).toEqual({ backend: 'typescript', files: 1, untyped: [] })
      expect(arithmetic(report!)).toEqual([11])
    })

    test('lists a `?.` whose type and tests never have null as unnecessary, without failing', ({ skip }) => {
      const dir = project('unnecessary-types', { 'tsconfig.json': TSCONFIG, 'src/user.ts': 'export {}\n' }, {
        'src/user.ts': `export interface User { name: string; manager?: User }

export function greet(user: User): string {
  return 'Hi ' + user?.name
}

export function managerName(user: User): string {
  return user?.manager?.name ?? 'none'
}

export function shout(user: User): string {
  // nyorori-ignore-next-line OptionalChaining -- callers always pass a user
  return user?.name.toUpperCase()
}
`,
        'src/title.ts': 'export function title(user: { name: string } | undefined): string | undefined {\n  return user?.name\n}\n',
        'test/user.test.ts': `import { appendFileSync } from 'node:fs'
import { afterAll, expect, test } from 'vitest'
import { title } from '../src/title'
import { greet, managerName, shout } from '../src/user'

test('greet', () => { expect(greet({ name: 'Ada' })).toBe('Hi Ada') })
test('shout', () => { expect(shout({ name: 'Ada' })).toBe('ADA') })
test('managerName', () => {
  expect(managerName({ name: 'Ada', manager: { name: 'Bob' } })).toBe('Bob')
  expect(managerName({ name: 'Ada' })).toBe('none')
  // Not what the type says: here the types are wrong.
  expect(managerName(null as any)).toBe('none')
})
test('title', () => { expect(title({ name: 'Ada' })).toBe('Ada') })

// For nyorori's own test: the mutant each run activated.
afterAll(() => { appendFileSync(new URL('../runs.log', import.meta.url), (globalThis as any).__nyorori.active + '\\n') })
`,
      })
      const ran = () => {
        const log = path.join(dir, 'runs.log')
        const active = readFileSync(log, 'utf8').trim().split('\n').map(Number)
        rmSync(log)
        return active.slice(1)
      }
      const listed = (report: Report) => report.unnecessary.map((m) => `${path.relative(report.gitRoot, m.file)}:${m.line}:${m.column} ${m.operator}: ${m.reason}`)
      const greet = "src/user.ts:4:22 OptionalChaining: `user` is `User` by its type, which can't be null or undefined, and no test passed null or undefined"

      const { status, report, output } = nyorori(dir)
      const { types } = report!
      if (types.backend === 'none') skip(types.reason.startsWith('TypeScript is unavailable'), `TypeScript cannot run here: ${types.reason}`)
      expect(status, output).toBe(1)
      expect(listed(report!)).toEqual([greet])
      expect(report!.unnecessary[0]!.tests).toEqual(['test/user.test.ts'])
      expect(statuses(report!)).toEqual([
        'src/title.ts:1 FunctionBody body → `return`: Killed',
        // Its type may be undefined: the tests just never check that.
        'src/title.ts:2 OptionalChaining `?.` → `.`: Survived',
        'src/user.ts:3 FunctionBody body → `return`: Killed',
        'src/user.ts:7 FunctionBody body → `return`: Killed',
        "src/user.ts:8 Logical `user?.manager?.name ?? 'none'` → `user?.manager?.name`: Killed",
        'src/user.ts:8 OptionalChaining `?.` → `.`: Killed',
        // `user` is a User by its type, but a test passes null: it runs.
        'src/user.ts:8 OptionalChaining `?.` → `.`: Killed',
        'src/user.ts:11 FunctionBody body → `return`: Killed',
        // A suppression still decides: not listed, not run, and not a suppression that matches nothing.
        'src/user.ts:13 OptionalChaining `?.` → `.`: Ignored',
        // The suppression names OptionalChaining only.
        'src/user.ts:13 CallUnwrap `user?.name.toUpperCase()` → `user?.name`: Killed',
      ])
      expect(report!.results[1]).toMatchObject({ predicted: true, reason: 'no test makes `user` null or undefined here' })
      expect(report!.results.find((r) => r.status === 'Ignored')).toMatchObject({ predicted: true })
      expect(report!.problems).toEqual([])
      expect(output).toContain("1 mutant unnecessary by types: `?.` or `??` where the type can't be null or undefined and no test made it so")
      // Neither the unnecessary mutant nor the predicted survivor ran.
      expect(ran()).not.toContain(report!.unnecessary[0]!.id)

      const alone = nyorori(dir, '--exclude', 'src/title.ts')
      expect(alone.status, alone.output).toBe(0)
      expect(listed(alone.report!)).toEqual([greet])
      ran()

      // Run anyway with --no-predict, and it survives: no wrong prediction.
      const checked = nyorori(dir, '--exclude', 'src/title.ts', '--no-predict')
      expect(checked.status, checked.output).toBe(0)
      expect(checked.report!.unnecessary).toMatchObject([{ id: alone.report!.unnecessary[0]!.id }])
      expect(checked.report!.unnecessary[0]!.mispredicted).toBeUndefined()
      expect(ran()).toContain(checked.report!.unnecessary[0]!.id)
      expect(checked.output).not.toContain('MISPREDICT')

      // Without types it is a predicted survivor again, and fails the run.
      const untyped = nyorori(dir, '--exclude', 'src/title.ts', '--no-types')
      expect(untyped.status, untyped.output).toBe(1)
      expect(untyped.report!.unnecessary).toEqual([])
      expect(untyped.report!.results.find((r) => r.line === 4)).toMatchObject({ status: 'Survived', predicted: true, reason: 'no test makes `user` null or undefined here' })
    })

    test('falls back to the syntax, and still finishes, when TypeScript never answers', ({ skip }) => {
      skip(!('registerHooks' in module), 'needs module.registerHooks (Node 22.15)')
      // Outside the project, so they are not changed files themselves.
      const fakes = path.join(REPO, '.tmp', 'e2e-types-fake')
      rmSync(fakes, { recursive: true, force: true })
      mkdirSync(fakes, { recursive: true })
      writeFileSync(path.join(fakes, 'typescript.mjs'), `// Starts, then never says which project a file is in.
const never = () => new Promise(() => {})
const snapshot = { update: async () => snapshot, getDefaultProjectForFile: never }
export class API {
  createSnapshot = async () => snapshot
  close = never
}
export const TypeFlags = {}
`)
      writeFileSync(path.join(fakes, 'hook.mjs'), `import { registerHooks } from 'node:module'
const fake = new URL('./typescript.mjs', import.meta.url).href
registerHooks({ resolve: (specifier, context, next) => (specifier === 'typescript/async' ? { url: fake, shortCircuit: true } : next(specifier, context)) })
`)
      const dir = project('types-hang', { 'tsconfig.json': TSCONFIG, 'src/name.ts': 'export {}\n' }, { 'src/name.ts': NAME, 'test/name.test.ts': NAME_TEST })
      const started = performance.now()
      const { status, report, output } = nyororiNode(['--import', pathToFileURL(path.join(fakes, 'hook.mjs')).href], dir, '--dry-run')
      // Five seconds of them are the time limit for one request.
      expect(performance.now() - started).toBeLessThan(20_000)
      expect(status, output).toBe(0)
      const reason = 'TypeScript did not answer within 5 s (opening src/name.ts)'
      expect(report!.types).toEqual({ backend: 'none', reason, untyped: [{ file: path.join(report!.gitRoot, 'src', 'name.ts'), reason }] })
      expect(arithmetic(report!)).toEqual([2, 6])
      expect(output).toContain(`1 TypeScript file without type information for \`+\` (${reason}); string concatenation there may be mutated`)
    })
  })

  test('stops with exit code 2 when the tests already fail without mutants', () => {
    const dir = project('baseline', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, {
      'src/age.ts': AGE_HEAD.replace('return total', 'return total + 1'),
    })
    const { status, output } = nyorori(dir)
    expect(status).toBe(2)
    expect(output).toContain('Tests fail without any mutant, so mutants cannot be judged')
    expect(output).toContain('test/age.test.ts')
  })

  test('leaves out test files, config files and --exclude matches', () => {
    const dir = project('scope', { 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, {
      'test/age.test.ts': AGE_TEST.replace("test('isAdult'", "test('isAdult works'"),
      'vitest.config.ts': "export default { test: { include: ['test/**/*.test.ts'] } }\n",
      'scripts/release.ts': 'export function release(v: number) {\n  return v + 1\n}\n',
      'src/types.d.ts': 'export declare function f(x: boolean): void\n',
    })
    const { status, report, output } = nyorori(dir, '--exclude', 'scripts/**')
    expect(status, output).toBe(0)
    expect(report!.results).toEqual([])
    expect(output).toContain('nyorori: no mutants in the changed code.')
  })

  test('runs Vitest projects that share the root Vite server', () => {
    const dir = project('projects', {
      'vitest.config.ts': `export default {
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'] } },
      { test: { name: 'spec', include: ['test/**/*.spec.ts'] } },
    ],
  },
}
`,
      'src/age.ts': AGE_BASE,
      'test/age.test.ts': AGE_TEST.replace("test('sum', () => {\n  expect(sum(4)).toBe(6)\n})\n", ''),
      'test/sum.spec.ts': "import { expect, test } from 'vitest'\nimport { sum } from '../src/age'\ntest('sum', () => { expect(sum(4)).toBe(6) })\n",
    }, { 'src/age.ts': AGE_HEAD })
    const { status, report, output } = nyorori(dir)
    expect(status, output).toBe(1)
    expect(statuses(report!)).toEqual([
      'src/age.ts:2 ComparisonBoundary `>=` → `>`: Survived',
      'src/age.ts:5 FunctionBody body → `return`: Killed',
      'src/age.ts:6 Condition `isAdult(age)` → `true`: Killed',
      'src/age.ts:6 Condition `isAdult(age)` → `false`: Killed',
      'src/age.ts:6 CallUnwrap `isAdult(age)` → `age`: Killed',
      'src/age.ts:10 FunctionBody body → `return`: Killed',
      'src/age.ts:12 Condition `i < n` → `false`: Killed',
      'src/age.ts:12 ComparisonBoundary `<` → `<=`: Killed',
      'src/age.ts:12 Update `++` → `--`: Timeout',
    ])
    expect(report!.results[0]!.tests).toEqual(['test/age.test.ts'])
    expect(report!.results.at(-1)!.tests).toEqual(['test/sum.spec.ts'])
  })

  describe('stops with exit code 2 where it cannot instrument code, instead of calling it untested', () => {
    const run = (name: string, config: string) =>
      nyorori(project(name, { 'vitest.config.ts': config, 'src/age.ts': AGE_BASE, 'test/age.test.ts': AGE_TEST }, { 'src/age.ts': AGE_HEAD }))

    test('a Vitest project with its own Vite config', () => {
      const { status, output, leftovers } = run('own-vite', `export default {
  test: {
    projects: [
      { test: { name: 'unit' } },
      { resolve: { alias: { '#src': './src' } }, test: { name: 'aliased' } },
    ],
  },
}
`)
      expect(status, output).toBe(2)
      expect(output).toContain('nyorori: Vitest project "aliased" has its own Vite config')
      expect(output).toContain('This setup is not supported yet.')
      expect(output).not.toContain('    at ')
      expect(leftovers).toEqual([])
    })

    test('experimental.viteModuleRunner: false', () => {
      const { status, output } = run('native-runner', 'export default { test: { experimental: { viteModuleRunner: false } } }\n')
      expect(status, output).toBe(2)
      expect(output).toContain('nyorori: The Vitest config sets experimental.viteModuleRunner: false')
      expect(output).toContain('This setup is not supported yet.')
    })
  })

  describe('baseline profile', () => {
    const SHOP = `export function label(prefix, name) {
  return prefix + name
}

export function add(a, b) {
  return a + b
}

export function unused(a, b) {
  return a + b
}

export function lineTotal(item) {
  return item.price * item.qty + item.fee
}

export function displayName(user) {
  return user?.profile?.name ?? 'anonymous'
}

export function clamp(x, lo, hi) {
  if (x < lo) return lo
  return Math.min(x, hi)
}

export function total(list) {
  if (Array.isArray(list)) return list.length
  return 0
}

export function notify(handlers, msg) {
  handlers.onMessage?.(msg)
  return handlers.log
}

export function mode(options) {
  if (options.verbose) return 'verbose'
  return 'quiet'
}
`
    const SHOP_TEST = `import { appendFileSync } from 'node:fs'
import { afterAll, expect, test } from 'vitest'
import * as shop from '../src/shop.js'

test('label', () => { expect(shop.label('Mr. ', 'Kim')).toBe('Mr. Kim') })
test('add', () => { expect(shop.add(1, 2)).toBe(3); expect(shop.add('a', 'b')).toBe('ab') })
test('lineTotal', () => { expect(shop.lineTotal({ price: 3, qty: 2, fee: 0 })).toBe(6) })
test('displayName', () => {
  expect(shop.displayName({ profile: { name: 'Lee' } })).toBe('Lee')
  expect(shop.displayName({})).toBe('anonymous')
})
test('clamp', () => { expect(shop.clamp(-5, 0, 10)).toBe(0); expect(shop.clamp(5, 0, 10)).toBe(5) })
test('total', () => { expect(shop.total([1, 2])).toBe(2) })
test('notify', () => {
  expect(shop.notify({ log: [], onMessage(m) { this.log.push(m) } }, 'hi')).toEqual(['hi'])
})
test('mode', () => { expect(shop.mode({})).toBe('quiet') })

// For nyorori's own test: the mutant each run activated, and whether the module had probes.
afterAll(() => {
  const profiled = Object.values(shop).some((f) => /__nyorori_[vbe]/.test(String(f)))
  appendFileSync(new URL('../runs.log', import.meta.url), JSON.stringify({ active: globalThis.__nyorori.active, profiled }) + '\\n')
})
`
    // Same functions with other bodies, so only the body lines count as changed.
    const SHOP_BASE = SHOP.replace(/^  .*$/gm, '  // todo')
    const runs = (dir: string): Array<{ active: number; profiled: boolean }> => {
      const log = path.join(dir, 'runs.log')
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      rmSync(log)
      return lines
    }
    const expected = [
      'src/shop.js:6 Arithmetic `+` → `-`: Killed',
      'src/shop.js:10 Arithmetic `+` → `-`: NoCoverage',
      'src/shop.js:14 Arithmetic `+` → `-`: Survived',
      'src/shop.js:14 Arithmetic `*` → `/`: Killed',
      "src/shop.js:18 Logical `user?.profile?.name ?? 'anonymous'` → `user?.profile?.name`: Killed",
      'src/shop.js:18 OptionalChaining `?.` → `.`: Killed',
      'src/shop.js:18 OptionalChaining `?.` → `.`: Survived',
      'src/shop.js:22 Condition `x < lo` → `true`: Killed',
      'src/shop.js:22 Condition `x < lo` → `false`: Killed',
      'src/shop.js:22 ComparisonBoundary `<` → `<=`: Survived',
      // Calls and statements are never predicted: a call can have side effects, whatever it returns.
      'src/shop.js:23 CallUnwrap `Math.min(x, hi)` → `x`: Survived',
      // A test with a call is never predicted; this one runs, and survives.
      'src/shop.js:27 Condition `Array.isArray(list)` → `true`: Survived',
      'src/shop.js:27 Condition `Array.isArray(list)` → `false`: Killed',
      'src/shop.js:27 CallUnwrap `Array.isArray(list)` → `list`: Survived',
      'src/shop.js:32 CallStatement `handlers.onMessage?.(msg)` removed: Killed',
      'src/shop.js:32 OptionalChaining `?.` → `(none)`: Survived',
      'src/shop.js:37 Condition `options.verbose` → `true`: Killed',
      'src/shop.js:37 Condition `options.verbose` → `false`: Survived',
    ]
    // The profile's reasons; the other survivors get the words of the text output.
    const reasons = [
      'src/shop.js:14:32 `item.fee` was always 0',
      'src/shop.js:18:14 no test makes `user` null or undefined here',
      'src/shop.js:22:9 no test has `x === lo`',
      'src/shop.js:32:21 no test makes `handlers.onMessage` null or undefined here',
      'src/shop.js:37:7 the condition was always falsy in tests',
    ]
    const GENERIC = new Set(['every test still passes with this change', 'no test runs this code'])
    const reasonsOf = (report: Report) =>
      report.results.filter((r) => r.reason && !GENERIC.has(r.reason)).map((r) => `${path.relative(report.gitRoot, r.file)}:${r.line}:${r.column} ${r.reason}`)

    test('reports survivors from the profile without running them, and skips string `+`', () => {
      const dir = project('profile', { 'src/shop.js': SHOP_BASE }, { 'src/shop.js': SHOP, 'test/shop.test.js': SHOP_TEST })
      const { status, report, output } = nyorori(dir)
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(expected)
      expect(reasonsOf(report!)).toEqual(reasons)
      // Every mutant with a reason from the profile was judged from the profile alone, and every failing one has a reason.
      expect(report!.results.filter((r) => r.predicted).map((r) => r.id)).toEqual(report!.results.filter((r) => r.reason && !GENERIC.has(r.reason)).map((r) => r.id))
      expect(report!.results.filter((r) => (r.status === 'Survived' || r.status === 'NoCoverage') && !r.reason)).toEqual([])
      expect(report!.skipped.map((m) => `${path.relative(report!.gitRoot, m.file)}:${m.line} ${m.operator} ${m.description}: ${m.reason}`)).toEqual([
        'src/shop.js:2 Arithmetic `+` → `-`: string concatenation in every observed evaluation',
      ])
      expect(output).toContain('Survived   src/shop.js:14:32  Arithmetic  `+` → `-`  (`item.fee` was always 0)')
      expect(output).toContain('Survived   src/shop.js:27:7  Condition  `Array.isArray(list)` → `true`  (every test still passes with this change)')
      expect(output).toContain('1 mutant skipped: string concatenation in every observed evaluation')

      // The baseline (no active mutant) got the profiled code, every mutant run the plain code.
      // Neither the predicted survivors nor the uncovered mutant ran.
      const log = runs(dir)
      expect(log[0]).toEqual({ active: 0, profiled: true })
      expect(log.slice(1).filter((run) => run.profiled)).toEqual([])
      const ran = log.slice(1).map((run) => run.active)
      const judged = report!.results.filter((r) => !r.predicted && r.status !== 'NoCoverage').map((r) => r.id)
      expect(ran.sort((a, b) => a - b)).toEqual(judged)
    })

    test('with --no-predict runs the predicted survivors, which survive', () => {
      const dir = project('no-predict', { 'src/shop.js': SHOP_BASE }, { 'src/shop.js': SHOP, 'test/shop.test.js': SHOP_TEST })
      const { status, report, output } = nyorori(dir, '--no-predict')
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(expected)
      expect(reasonsOf(report!)).toEqual(reasons)
      expect(report!.results.filter((r) => r.predicted || r.mispredicted)).toEqual([])
      expect(output).not.toContain('MISPREDICT')
      const log = runs(dir)
      expect(log.slice(1).filter((run) => run.profiled)).toEqual([])
      // Everything but NoCoverage and the skipped string `+` ran.
      expect(log.slice(1)).toHaveLength(report!.results.filter((r) => r.status !== 'NoCoverage').length)
    })

    test('a suppression of a predicted survivor holds without a run; one of a skipped string `+` matches nothing', () => {
      const dir = project('profile-suppress', {
        'src/shop.js': 'export function label(prefix, name) {\n}\n\nexport function total(item) {\n}\n',
        'test/shop.test.js': "import { expect, test } from 'vitest'\nimport { label, total } from '../src/shop.js'\ntest('shop', () => { expect(label('a', 'b')).toBe('ab'); expect(total({ price: 3, fee: 0 })).toBe(3) })\n",
      }, {
        'src/shop.js': `export function label(prefix, name) {
  // nyorori-ignore-next-line Arithmetic -- joins two names
  return prefix + name
}

export function total(item) {
  // nyorori-ignore-next-line Arithmetic -- there are no fees yet
  return item.price + item.fee
}
`,
      })
      const { status, report, output } = nyorori(dir)
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(['src/shop.js:8 Arithmetic `+` → `-`: Ignored'])
      expect(report!.results[0]).toMatchObject({ predicted: true, reason: '`item.fee` was always 0' })
      expect(report!.skipped.map((m) => m.line)).toEqual([3])
      expect(report!.problems.map((p) => `${p.line} ${p.message}`)).toEqual(['2 Suppression matches no mutant of Arithmetic on line 3. Remove it.'])
    })
  })

  describe('verdicts do not leak between runs', () => {
    const base = {
      'src/a.ts': 'export function inc(x: number): number {\n  return 1 + x\n}\n',
      'src/b.ts': 'export function isAdult(age: number): boolean {\n  return age > 17\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest'\nimport { inc } from '../src/a'\ntest('inc', () => { expect(inc(1)).toBe(2) })\n",
      'test/b.test.ts': "import { expect, test } from 'vitest'\nimport { isAdult } from '../src/b'\ntest('isAdult', () => { expect(isAdult(30)).toBe(true); expect(isAdult(3)).toBe(false) })\n",
    }
    const head = {
      'src/a.ts': 'export function inc(x: number): number {\n  return x + 1\n}\n',
      'src/b.ts': 'export function isAdult(age: number): boolean {\n  return age >= 18\n}\n',
    }
    const expected = [
      'src/a.ts:2 Arithmetic `+` → `-`: Killed',
      'src/b.ts:2 ComparisonBoundary `>=` → `>`: Survived',
    ]

    test('a test file that failed for an earlier mutant does not kill a later one', () => {
      const { report, output } = nyorori(project('earlier-failure', base, head))
      expect(statuses(report!), output).toEqual(expected)
    })

    test('a second run with different mutant ids does not reuse cached instrumentation', () => {
      const dir = project('warm-cache', base, head)
      // b.ts gets mutant id 1 here and id 2 below, with the same source.
      expect(statuses(nyorori(dir, '--exclude', 'src/a.ts').report!)).toEqual([expected[1]])
      const { report, output } = nyorori(dir)
      expect(statuses(report!), output).toEqual(expected)
    })
  })

  test('gives the same verdicts on every run when a mutant fails one of several test files in parallel', () => {
    // A fast file kills most mutants while slow files are still running; a run
    // that stops early left stale or pending states that turned kills into survivors.
    const slow = "import { it, expect } from 'vitest'\nimport { f } from '../src/lib.js'\nfor (let i = 0; i < 20; i++) {\n  it('slow ' + i, async () => {\n    await new Promise((r) => setTimeout(r, 25))\n    expect(f(5, 2)).toBe(3)\n    expect(f(4, 4)).toBe(20)\n  })\n}\n"
    const dir = project('parallel', {
      'src/lib.js': 'export function f(a, b) {\n  return a\n}\n',
      'test/a.test.js': "import { it, expect } from 'vitest'\nimport { f } from '../src/lib.js'\nit('a', () => {\n  expect(f(5, 2)).toBe(3)\n  expect(f(2, 5)).toBe(3)\n  expect(f(0, 0)).toBe(100)\n  expect(f(4, 4)).toBe(20)\n  expect(f(-1, -1)).toBe(-5)\n})\n",
      'test/b.test.js': slow,
      'test/c.test.js': slow,
      'test/d.test.js': slow,
    }, {
      'src/lib.js': 'export function f(a, b) {\n  if (a > b) return a - b\n  if (a < b) return b - a\n  if (a === 0 && b === 0) return 100\n  return a * 2 + b * 3\n}\n',
    })
    // No test has exactly one zero, so `&&` → `||` is the only real survivor.
    for (let i = 0; i < 2; i++) {
      const { status, report, output } = nyorori(dir, '--no-predict')
      expect(status, output).toBe(1)
      expect(report!.results.filter((r) => r.status !== 'Killed').map((r) => `${r.line} ${r.operator} ${r.description}: ${r.status}`)).toEqual([
        '4 Logical `&&` → `||`: Survived',
      ])
    }
  })

  describe('project setups seen in real repositories', () => {
    const lib = 'export function big(x: number): boolean {\n  return x > 1\n}\n'
    const changed = 'export function big(x: number): boolean {\n  return x >= 2\n}\n'
    const spec = (name: string) => `import { expect, it } from 'vitest'\nimport { big } from '../src/${name}'\nit('${name}', () => {\n  expect(big(5)).toBe(true)\n  expect(big(0)).toBe(false)\n})\n`

    test('a DOM environment can load the setup file from outside the project', () => {
      const dir = project('happy-dom', {
        'vitest.config.ts': "export default { test: { environment: 'happy-dom' } }\n",
        'src/a.ts': lib,
        'test/a.test.ts': spec('a'),
      }, { 'src/a.ts': changed })
      const { status, report, output } = nyorori(dir)
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(['src/a.ts:2 ComparisonBoundary `>=` → `>`: Survived'])
    })

    test('every test file records its hits under isolate: false', () => {
      const dir = project('no-isolate', {
        'vitest.config.ts': 'export default { test: { isolate: false, maxWorkers: 1 } }\n',
        'src/a.ts': lib, 'src/b.ts': lib, 'src/c.ts': lib,
        'test/a.test.ts': spec('a'), 'test/b.test.ts': spec('b'), 'test/c.test.ts': spec('c'),
      }, { 'src/a.ts': changed, 'src/b.ts': changed, 'src/c.ts': changed })
      const { status, report, output } = nyorori(dir)
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(['a', 'b', 'c'].map((f) => `src/${f}.ts:2 ComparisonBoundary \`>=\` → \`>\`: Survived`))
    })

    test('a changed Vitest config does not pull in the whole suite', () => {
      // Stands for tests that only pass in the project's own CI, like a dist check.
      const dir = project('config-change', {
        'vitest.config.ts': 'export default { test: {} }\n',
        'src/a.ts': lib,
        'test/a.test.ts': spec('a'),
        'test/dist.test.ts': "import { it } from 'vitest'\nit('needs a build', () => { throw new Error('no dist') })\n",
      }, {
        'vitest.config.ts': 'export default { test: { testTimeout: 10_000 } }\n',
        'src/a.ts': changed,
      })
      const { status, report, output } = nyorori(dir)
      expect(status, output).toBe(1)
      expect(statuses(report!)).toEqual(['src/a.ts:2 ComparisonBoundary `>=` → `>`: Survived'])
    })
  })
})
