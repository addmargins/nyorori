import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  // Keep the outer Vitest's worker settings away from the nested one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS' && key !== 'GITHUB_ACTIONS'))
  // A private TMPDIR shows whether the run removed its temporary directories.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nyorori-e2e-'))
  const result = spawnSync(process.execPath, [CLI, 'run', '--base', 'HEAD~1', '--json', 'report.json', ...args], { cwd: dir, encoding: 'utf8', env: { ...env, TMPDIR: tmp } })
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
      '7 Unnecessary suppression: tests already detect mutant Condition `isAdult(age)` → `true`. Remove it.',
      '7 Unnecessary suppression: tests already detect mutant Condition `isAdult(age)` → `false`. Remove it.',
    ])
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

  describe('verdicts do not leak between runs', () => {
    const base = {
      'src/a.ts': 'export function inc(x: number): number {\n  return x + 1\n}\n',
      'src/b.ts': 'export function isAdult(age: number): boolean {\n  return age > 17\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest'\nimport { inc } from '../src/a'\ntest('inc', () => { expect(inc(1)).toBe(2) })\n",
      'test/b.test.ts': "import { expect, test } from 'vitest'\nimport { isAdult } from '../src/b'\ntest('isAdult', () => { expect(isAdult(30)).toBe(true); expect(isAdult(3)).toBe(false) })\n",
    }
    const head = {
      'src/a.ts': 'export function inc(x: number): number {\n  return x + 1 \n}\n',
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
})
