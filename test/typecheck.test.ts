import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseSync, type BinaryExpression } from 'oxc-parser'
import { describe, expect, test, vi } from 'vitest'
import { generate } from '../src/mutate/generate.ts'
import { loadTsrs, TsrsTypes, type Tsrs } from '../src/mutate/typecheck.ts'

const DIR = path.join(import.meta.dirname, '..', '.tmp', 'typecheck')

const FILES: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "noEmit": true }, "include": ["src"] }\n',
  'src/plus.ts': `// 한글 😀: outside ASCII and the BMP, UTF-8 and UTF-16 offsets differ
enum Level { Low, High }
enum Unit { Px = 'px' }
type Id = \`id-\${number}\`
type Email = string & { readonly brand: unique symbol }

export function f<S extends string>(name: string, suffix: string, n: number, big: bigint, level: Level, unit: Unit, id: Id, s: S, email: Email, loose: any, maybe: string | undefined, either: string | number) {
  return [
    name + suffix,
    n + 1,
    big + 1n,
    level + n,
    name.length + n,
    n.toFixed(1) + n,
    '😀'.length + n,
    unit + n,
    id + n,
    s + n,
    email + n,
    maybe + n,
    either + n,
    loose + n,
  ]
}
`,
  'src/mixed.ts': `export function f(name: string, suffix: string, a: number, b: number, loose: any) {
  const label = name + suffix
  const sum = a + b
  return [label, sum, loose + a]
}
`,
  'src/plain.js': 'export function f(a, b) {\n  return a + b\n}\n',
  // Outside the tsconfig's `include`, and no tsconfig.json further up includes it either.
  'scripts/loose.ts': 'export function f(name: string, suffix: string) {\n  return name + suffix\n}\n',
  'no-exec': '',
}

rmSync(DIR, { recursive: true, force: true })
for (const [name, content] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(DIR, name)), { recursive: true })
  writeFileSync(path.join(DIR, name), content)
}

const file = (name: string) => path.join(DIR, name)

/** The answer for every `+` in a fixture file, by its source text. */
function ask(types: TsrsTypes, name: string): Record<string, string> {
  const code = FILES[name]!
  const answers: Record<string, string> = {}
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) return node.forEach(visit)
    if ('type' in node && node.type === 'BinaryExpression' && 'operator' in node && node.operator === '+') {
      const { start, end, left, right } = node as BinaryExpression
      answers[code.slice(start, end)] = types.plus(file(name), left, right)
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(parseSync(name, code).program)
  return answers
}

/** Why the real tsrs cannot run on this machine, or undefined when it can. */
const unavailable = (() => {
  const types = new TsrsTypes(DIR)
  try {
    ask(types, 'src/mixed.ts')
    const usage = types.usage()
    return usage.backend === 'tsrs' ? undefined : usage.reason
  } finally {
    types.close()
  }
})()

function needsTsrs(skip: (condition: boolean, note?: string) => void): void {
  skip(unavailable !== undefined, `tsrs cannot run here: ${unavailable}`)
}

const hasPgrep = (() => {
  try {
    execFileSync('pgrep', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** The tsrs processes this test worker started. */
function tsrsChildren(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-x', 'tsrs'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    // pgrep exits with 1 when nothing matches.
    return []
  }
}

describe('with tsrs', () => {
  test('tells string concatenation from arithmetic by the operand types', ({ skip, onTestFinished }) => {
    needsTsrs(skip)
    const types = new TsrsTypes(DIR)
    onTestFinished(() => types.close())
    expect(ask(types, 'src/plus.ts')).toEqual({
      'name + suffix': 'string',
      'n + 1': 'numeric',
      'big + 1n': 'numeric',
      'level + n': 'numeric',
      // Asking for the type at an operand's first token would see `name` (a string) here
      // and `n` (a number) in the next line.
      'name.length + n': 'numeric',
      'n.toFixed(1) + n': 'string',
      "'😀'.length + n": 'numeric',
      'unit + n': 'string',
      'id + n': 'string',
      's + n': 'string',
      'email + n': 'string',
      // These two do not type-check, yet the left side may be a string.
      'maybe + n': 'string',
      'either + n': 'string',
      // `any` says nothing, so the syntax decides.
      'loose + n': 'unknown',
    })
    expect(types.usage()).toEqual({ backend: 'tsrs', files: 1, untyped: [] })
  })

  test('falls back for a file outside every tsconfig.json', ({ skip, onTestFinished }) => {
    needsTsrs(skip)
    const types = new TsrsTypes(DIR)
    onTestFinished(() => types.close())
    expect(ask(types, 'scripts/loose.ts')).toEqual({ 'name + suffix': 'unknown' })
    expect(ask(types, 'src/mixed.ts')).toEqual({ 'name + suffix': 'string', 'a + b': 'numeric', 'loose + a': 'unknown' })
    expect(types.usage()).toEqual({
      backend: 'tsrs',
      files: 1,
      untyped: [{ file: file('scripts/loose.ts'), reason: 'not in any tsconfig.json project' }],
    })
  })

  test('generate() leaves string `+` alone and mutates numeric and untyped `+`', ({ skip, onTestFinished }) => {
    needsTsrs(skip)
    const types = new TsrsTypes(DIR)
    onTestFinished(() => types.close())
    const code = FILES['src/mixed.ts']!
    const all = new Set([1, 2, 3, 4, 5])
    const arithmetic = (result: ReturnType<typeof generate>) =>
      result.mutants.filter((m) => m.operator === 'Arithmetic').map((m) => `${m.line} ${m.description}`)
    expect(arithmetic(generate(file('src/mixed.ts'), code, all, 1, types))).toEqual(['3 `+` → `-`', '4 `+` → `-`'])
    expect(arithmetic(generate(file('src/mixed.ts'), code, all, 1))).toEqual(['2 `+` → `-`', '3 `+` → `-`', '4 `+` → `-`'])
  })

  test('close() stops the tsrs process, and nothing starts it again', async ({ skip }) => {
    needsTsrs(skip)
    skip(!hasPgrep, 'needs pgrep to list child processes')
    // Earlier tests closed theirs; a killed process lingers as a zombie until the event loop reaps it.
    await vi.waitFor(() => expect(tsrsChildren()).toEqual([]))
    const types = new TsrsTypes(DIR)
    ask(types, 'src/mixed.ts')
    expect(tsrsChildren()).toHaveLength(1)
    types.close()
    await vi.waitFor(() => expect(tsrsChildren()).toEqual([]))
    expect(ask(types, 'src/plus.ts')['name + suffix']).toBe('unknown')
    expect(tsrsChildren()).toEqual([])
  })
})

describe('without tsrs', () => {
  test('a loader that fails leaves every `+` to the syntax, with the reason', () => {
    const types = new TsrsTypes(DIR, () => {
      throw new Error("Cannot find module 'tsrs/unstable/sync'\nRequire stack:\n- …")
    })
    expect(ask(types, 'src/mixed.ts')).toEqual({ 'name + suffix': 'unknown', 'a + b': 'unknown', 'loose + a': 'unknown' })
    const reason = "tsrs is unavailable: Cannot find module 'tsrs/unstable/sync'"
    expect(types.usage()).toEqual({ backend: 'none', reason, untyped: [{ file: file('src/mixed.ts'), reason }] })
    types.close()
  })

  test('loads tsrs only for a TypeScript file with a `+` on a changed line', () => {
    const load = vi.fn<() => Tsrs>(() => {
      throw new Error('not expected')
    })
    const types = new TsrsTypes(DIR, load)
    // Only the signature changed; the `+` are on lines 2 to 4.
    generate(file('src/mixed.ts'), FILES['src/mixed.ts']!, new Set([1]), 1, types)
    generate(file('src/plain.js'), FILES['src/plain.js']!, new Set([1, 2, 3]), 1, types)
    expect(load).not.toHaveBeenCalled()
    expect(types.usage()).toEqual({ backend: 'none', reason: 'no `+` on a changed line of a TypeScript file', untyped: [] })
    types.close()
  })

  test.for([
    ['is missing', '/nonexistent/tsrs', 'tsrs is unavailable: TSRS_BINARY is set to /nonexistent/tsrs, which does not exist'],
    // Spawning fails on a later tick; without a listener, that 'error' event would crash the process.
    // The request written to the never-started process is what fails here.
    ['cannot be executed', file('no-exec'), expect.stringMatching(/^tsrs is unavailable: EPIPE/)],
  ] as const)('a tsrs binary that %s falls back with the reason', async ([, binary, reason], { skip }) => {
    let installed = true
    try {
      loadTsrs()
    } catch {
      installed = false
    }
    // Only the JavaScript half of tsrs takes part here.
    skip(!installed || process.platform === 'win32', 'needs the tsrs package and POSIX file modes')
    vi.stubEnv('TSRS_BINARY', binary)
    try {
      const types = new TsrsTypes(DIR)
      expect(ask(types, 'src/mixed.ts')['name + suffix']).toBe('unknown')
      expect(types.usage()).toMatchObject({ backend: 'none', reason })
      types.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
