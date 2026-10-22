import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSync, type BinaryExpression } from 'oxc-parser'
import { describe, expect, test, vi } from 'vitest'
import { generate, typeQuestions } from '../src/mutate/generate.ts'
import { askTypes, loadTypeScript, type FileQuestions, type Limits, type TypeScript } from '../src/mutate/typecheck.ts'

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
  // Destructured, so only the checker knows that `name + suffix` joins strings.
  'src/mixed.ts': `export function f({ name, suffix }: { name: string; suffix: string }, a: number, b: number, loose: any) {
  const label = name + suffix
  const sum = a + b
  return [label, sum, loose + a]
}
`,
  // The tsconfig.json does not allow JavaScript, so this lands in an inferred project.
  'src/plain.js': "export function f(a, b) {\n  let s = ''\n  return [a + b, s + a]\n}\n",
  // Outside the tsconfig's `include`, and no tsconfig.json further up includes it either.
  'scripts/loose.ts': 'export function f(name: string, suffix: string) {\n  return name + suffix\n}\n',
  // JavaScript checked as strictly as TypeScript: every type below is enforced.
  'checked/jsconfig.json': '{ "compilerOptions": { "checkJs": true, "strict": true, "module": "nodenext", "noEmit": true } }\n',
  'checked/label.js': `/**
 * @param {{ first: string, last: string }} name
 * @param {number} a
 * @param {number} b
 */
export function f(name, a, b) {
  return [name.first + name.last, a + b]
}
`,
  // Checked, but an untyped parameter is \`any\` without complaint, so \`set(1)\` breaks the string TypeScript infers for \`label\`.
  'loose/jsconfig.json': '{ "compilerOptions": { "checkJs": true, "noImplicitAny": false, "module": "nodenext", "noEmit": true } }\n',
  'loose/label.js': "let label = ''\nexport function set(n) {\n  label = n\n}\nexport function get(n) {\n  return label + n\n}\n",
  'no-exec': '',
  // Stand-ins for the TypeScript binary: one that exits at once, and one that reads its input and never answers.
  'exits.sh': '#!/bin/sh\nexit 3\n',
  'hangs.sh': `#!/bin/sh\nexec "${process.execPath}" "${path.join(DIR, 'hangs.mjs')}"\n`,
  'hangs.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./hangs.pid', import.meta.url), String(process.pid))\nprocess.on('SIGTERM', () => {})\nprocess.stdin.resume()\n",
}

rmSync(DIR, { recursive: true, force: true })
for (const [name, content] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(DIR, name)), { recursive: true })
  writeFileSync(path.join(DIR, name), content)
}
chmodSync(path.join(DIR, 'exits.sh'), 0o755)
chmodSync(path.join(DIR, 'hangs.sh'), 0o755)

const file = (name: string) => path.join(DIR, name)
const lines = (code: string) => new Set(code.split('\n').map((_, i) => i + 1))

/** Every `+` in a fixture file, whether or not the syntax could tell. */
function everyPlus(name: string): FileQuestions {
  const plus: FileQuestions['plus'] = []
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) return node.forEach(visit)
    if ('type' in node && node.type === 'BinaryExpression' && 'operator' in node && node.operator === '+') {
      const { left, right } = node as BinaryExpression
      plus.push({ left: { start: left.start, end: left.end }, right: { start: right.start, end: right.end } })
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(parseSync(name, FILES[name]!).program)
  return { file: file(name), plus }
}

/** The answer for every `+` in the fixture files, by file and source text. */
async function ask(names: string[], options?: Parameters<typeof askTypes>[2]) {
  const types = await askTypes(DIR, names.map(everyPlus), options)
  const answers = Object.fromEntries(names.map((name) => [name, Object.fromEntries(everyPlus(name).plus.map(({ left, right }) =>
    [FILES[name]!.slice(left.start, right.end), types.plus(file(name), left, right)]))]))
  return { answers, usage: types.usage }
}

/** Why the real TypeScript cannot run on this machine, or undefined when it can. */
const unavailable = await (async () => {
  const { usage } = await ask(['src/mixed.ts'])
  return usage.backend === 'typescript' ? undefined : usage.reason
})()

function needsTypeScript(skip: (condition: boolean, note?: string) => void): void {
  skip(unavailable !== undefined, `TypeScript cannot run here: ${unavailable}`)
}

/** The real API, with its process replaced by `server`. */
function serving(server: string): () => Promise<TypeScript> {
  return async () => {
    const ts = await loadTypeScript()
    class API extends ts.api.API {
      constructor(options: { cwd?: string }) {
        super({ ...options, tsserverPath: server })
      }
    }
    return { ...ts, api: { ...ts.api, API } as typeof ts.api }
  }
}

const QUICK: Limits = { start: 200, open: 200, ask: 200, close: 200 }
const never = () => new Promise<never>(() => {})

const hasPgrep = (() => {
  try {
    execFileSync('pgrep', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** The TypeScript processes this test worker started. */
function tscChildren(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-x', 'tsc'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    // pgrep exits with 1 when nothing matches.
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('with TypeScript', () => {
  test('tells string concatenation from arithmetic by the operand types', async ({ skip }) => {
    needsTypeScript(skip)
    const { answers, usage } = await ask(['src/plus.ts'])
    expect(answers['src/plus.ts']).toEqual({
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
    expect(usage).toEqual({ backend: 'typescript', files: 1, untyped: [] })
  })

  test('falls back for a TypeScript file outside every tsconfig.json', async ({ skip }) => {
    needsTypeScript(skip)
    const { answers, usage } = await ask(['scripts/loose.ts', 'src/mixed.ts'])
    expect(answers).toEqual({
      'scripts/loose.ts': { 'name + suffix': 'unknown' },
      'src/mixed.ts': { 'name + suffix': 'string', 'a + b': 'numeric', 'loose + a': 'unknown' },
    })
    expect(usage).toEqual({ backend: 'typescript', files: 1, untyped: [{ file: file('scripts/loose.ts'), reason: 'not in any tsconfig.json project' }] })
  })

  test('answers for JavaScript only where its project checks it as strictly as TypeScript', async ({ skip }) => {
    needsTypeScript(skip)
    const { answers, usage } = await ask(['checked/label.js', 'loose/label.js', 'src/plain.js'])
    expect(answers).toEqual({
      'checked/label.js': { 'name.first + name.last': 'string', 'a + b': 'numeric' },
      // TypeScript would say string for `label + n` and `s + a`; both are numbers after `set(1)` or `f(1, 2)`.
      'loose/label.js': { 'label + n': 'unknown' },
      'src/plain.js': { 'a + b': 'unknown', 's + a': 'unknown' },
    })
    // JavaScript without types is the usual case, not something to report.
    expect(usage).toEqual({ backend: 'typescript', files: 1, untyped: [] })
  })

  test('generate() leaves string `+` alone and mutates numeric and untyped `+`', async ({ skip }) => {
    needsTypeScript(skip)
    const arithmetic = (result: ReturnType<typeof generate>) =>
      result.mutants.filter((m) => m.operator === 'Arithmetic').map((m) => `${m.line} ${m.description}`)
    for (const [name, typed, untyped] of [
      ['src/mixed.ts', ['3 `+` → `-`', '4 `+` → `-`'], ['2 `+` → `-`', '3 `+` → `-`', '4 `+` → `-`']],
      ['checked/label.js', ['7 `+` → `-`'], ['7 `+` → `-`', '7 `+` → `-`']],
    ] as const) {
      const code = FILES[name]!
      const types = await askTypes(DIR, [typeQuestions(file(name), code, lines(code))])
      expect(arithmetic(generate(file(name), code, lines(code), 1, types)), name).toEqual(typed)
      expect(arithmetic(generate(file(name), code, lines(code), 1)), name).toEqual(untyped)
    }
  })

  test('the TypeScript process is gone once the answers are in', async ({ skip }) => {
    needsTypeScript(skip)
    skip(!hasPgrep, 'needs pgrep to list child processes')
    // A killed process lingers as a zombie until the event loop reaps it.
    await vi.waitFor(() => expect(tscChildren()).toEqual([]))
    const pending = ask(['src/mixed.ts'])
    await vi.waitFor(() => expect(tscChildren()).toHaveLength(1))
    expect((await pending).usage.backend).toBe('typescript')
    await vi.waitFor(() => expect(tscChildren()).toEqual([]))
  })
})

describe('without TypeScript', () => {
  test('a loader that fails leaves every `+` to the syntax, with the reason', async () => {
    const { answers, usage } = await ask(['src/mixed.ts'], {
      load: async () => {
        throw new Error("Cannot find package 'typescript' imported from /x/typecheck.ts\nDid you mean …")
      },
    })
    expect(answers['src/mixed.ts']).toEqual({ 'name + suffix': 'unknown', 'a + b': 'unknown', 'loose + a': 'unknown' })
    const reason = "TypeScript is unavailable: Cannot find package 'typescript' imported from /x/typecheck.ts"
    expect(usage).toEqual({ backend: 'none', reason, untyped: [{ file: file('src/mixed.ts'), reason }] })
  })

  test('starts TypeScript only for a `+` the syntax cannot tell, in a file with a config file above it', async () => {
    const load = vi.fn<() => Promise<TypeScript>>(async () => {
      throw new Error('not expected')
    })
    // Only the signature changed; the `+` are on lines 2 to 4.
    const signature = typeQuestions(file('src/mixed.ts'), FILES['src/mixed.ts']!, new Set([1]))
    // Annotated as strings, so the syntax tells.
    const annotated = typeQuestions(file('scripts/loose.ts'), FILES['scripts/loose.ts']!, new Set([2]))
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nyorori-typecheck-'))
    try {
      const plus = [{ left: { start: 30, end: 31 }, right: { start: 34, end: 35 } }]
      const types = await askTypes(DIR, [signature, annotated, { file: path.join(outside, 'a.js'), plus }], { load })
      expect([signature.plus, annotated.plus]).toEqual([[], []])
      expect(load).not.toHaveBeenCalled()
      expect(types.usage).toMatchObject({ backend: 'none', reason: expect.stringMatching(/^TypeScript does not check this JavaScript/), untyped: [] })
      // Nothing above a TypeScript file can include it in a project.
      const loose = await askTypes(DIR, [{ file: path.join(outside, 'a.ts'), plus }], { load })
      expect(loose.usage).toEqual({ backend: 'none', reason: 'not in any tsconfig.json project', untyped: [{ file: path.join(outside, 'a.ts'), reason: 'not in any tsconfig.json project' }] })
      expect(load).not.toHaveBeenCalled()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test.for([
    ['is missing', '/nonexistent/tsc', 'TypeScript is unavailable: Failed to start tsgo process: spawn /nonexistent/tsc ENOENT'],
    ['cannot be executed', file('no-exec'), `TypeScript is unavailable: Failed to start tsgo process: spawn ${file('no-exec')} EACCES`],
    // Whichever the client notices first: the exit, or a request it cannot write.
    ['exits at once', file('exits.sh'), expect.stringMatching(/^TypeScript is unavailable: (its process exited \(3\)|Cannot call write)/)],
  ] as const)('a TypeScript binary that %s falls back with the reason', async ([, server, reason], { skip }) => {
    skip(process.platform === 'win32', 'needs POSIX file modes and shell scripts')
    const { answers, usage } = await ask(['src/mixed.ts', 'src/plus.ts'], { load: serving(server) })
    expect(answers['src/mixed.ts']!['name + suffix']).toBe('unknown')
    expect(usage).toEqual({
      backend: 'none',
      reason,
      untyped: [{ file: file('src/mixed.ts'), reason }, { file: file('src/plus.ts'), reason }],
    })
  })

  test('a TypeScript process that exits does not take the CLI down', ({ skip }) => {
    skip(process.platform === 'win32', 'needs a shell script')
    // A request to the exited process also leaves an unhandled rejection behind in the client.
    // Vitest listens for those itself, so only a process of its own shows what Node would do.
    const script = `
      import { askTypes, loadTypeScript } from ${JSON.stringify(path.join(import.meta.dirname, '..', 'src', 'mutate', 'typecheck.ts'))}
      const load = async () => {
        const ts = await loadTypeScript()
        class API extends ts.api.API {
          constructor(options) { super({ ...options, tsserverPath: ${JSON.stringify(file('exits.sh'))} }) }
        }
        return { ...ts, api: { ...ts.api, API } }
      }
      const types = await askTypes(${JSON.stringify(DIR)}, [${JSON.stringify(everyPlus('src/mixed.ts'))}], { load })
      setTimeout(() => console.log(types.usage.reason), 200)
    `
    for (let run = 0; run < 3; run++) {
      const { status, stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
      expect({ status, stdout, stderr: stderr.split('\n')[0] }).toEqual({ status: 0, stdout: expect.stringMatching(/^TypeScript is unavailable: /), stderr: '' })
    }
  })

  test('a TypeScript process that never answers is killed after the time limit', async ({ skip }) => {
    skip(process.platform === 'win32', 'needs a shell script')
    rmSync(file('hangs.pid'), { force: true })
    const started = performance.now()
    const { usage } = await ask(['src/mixed.ts'], { load: serving(file('hangs.sh')), limits: { ...QUICK, start: 2_000 } })
    expect(performance.now() - started).toBeLessThan(5_000)
    const reason = 'TypeScript did not answer within 2 s (starting)'
    expect(usage).toEqual({ backend: 'none', reason, untyped: [{ file: file('src/mixed.ts'), reason }] })
    expect(existsSync(file('hangs.pid'))).toBe(true)
    const pid = Number(readFileSync(file('hangs.pid'), 'utf8'))
    // It ignores SIGTERM and the end of its input; only SIGKILL stops it.
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
  })

  test.for([
    ['starting', { createSnapshot: never }, 'starting'],
    ['opening a file', { createSnapshot: async () => ({ update: async () => ({ getDefaultProjectForFile: never }) }) }, 'opening src/mixed.ts'],
  ] as const)('an API that never answers when %s falls back on time, and is not asked again', async ([, methods, step]) => {
    const created = vi.fn()
    const fake = {
      api: {
        API: class {
          constructor() {
            created()
            Object.assign(this, { close: never, ...methods })
          }
        },
      },
      ast: {},
    } as unknown as TypeScript
    const started = performance.now()
    const { usage } = await ask(['src/mixed.ts', 'src/plus.ts'], { load: async () => fake, limits: QUICK })
    expect(performance.now() - started).toBeLessThan(2_000)
    const reason = `TypeScript did not answer within 0.2 s (${step})`
    expect(usage).toEqual({ backend: 'none', reason, untyped: [{ file: file('src/mixed.ts'), reason }, { file: file('src/plus.ts'), reason }] })
    expect(created).toHaveBeenCalledOnce()
  })
})
