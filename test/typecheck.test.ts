import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSync, type BinaryExpression, type Node } from 'oxc-parser'
import { describe, expect, test, vi } from 'vitest'
import { generate, typeQuestions } from '../src/mutate/generate.ts'
import { askTypes, loadTypeScript, type FileQuestions, type Limits, type TypeScript } from '../src/mutate/typecheck.ts'

const DIR = path.join(import.meta.dirname, '..', '.tmp', 'typecheck')

// The values that `?.` and `??` guard, the same under each tsconfig.json below.
const GUARDS = `export interface User { name: string; nickname?: string; greet(): string; onSave?: () => void }
interface Indexed { known: User; [key: string]: User }

export function f<T>(
  user: User, maybe: User | undefined, users: User[], pair: [User, User], byId: Record<string, User>, indexed: Indexed,
  loose: any, opaque: unknown, generic: T, frozen: Readonly<T>, nonNull: T & {}, i: number, id: string, options: { tags?: string[] },
) {
  const merged = { tags: ['new'], ...options }
  return [
    user?.name,
    maybe?.name,
    users[i]?.name,
    pair[0]?.name,
    byId[id]?.name,
    byId.admin?.name,
    indexed.known?.name,
    indexed.other?.name,
    loose?.name,
    opaque ?? 'none',
    generic ?? 'none',
    frozen ?? 'none',
    nonNull ?? 'none',
    user.nickname ?? user.name,
    user.greet?.(),
    user.onSave?.(),
    (user)?.name,
    (maybe as User)?.name,
    maybe!?.name,
    (loose as User).name ?? 'none',
    maybe!.name ?? 'none',
    merged.tags?.length,
  ]
}
`
const CONFIG = (options: string) => `{ "compilerOptions": { ${options}"target": "es2022", "module": "nodenext", "noEmit": true } }\n`

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
  'src/guards.ts': GUARDS,
  'src/both.ts': "export function f(user: { name: string }, a: number, b: number) {\n  return [user?.name + '!', a + b, user.name ?? '']\n}\n",
  'unchecked/tsconfig.json': CONFIG('"strict": true, "noUncheckedIndexedAccess": true, '),
  'unchecked/guards.ts': GUARDS,
  'nulls-off/tsconfig.json': CONFIG('"strict": true, "strictNullChecks": false, '),
  'nulls-off/guards.ts': GUARDS,
  // TypeScript 7 turns strict on by default, but this config does not say so.
  'default/tsconfig.json': CONFIG(''),
  'default/guards.ts': GUARDS,
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
  'checked/guard.js': '/** @param {{ name: string }} user */\nexport function f(user) {\n  return user?.name\n}\n',
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

/** Every `+` and every value a `?.` or `??` guards in a fixture file, whether or not the syntax could tell. */
function everyQuestion(name: string): FileQuestions {
  const plus: FileQuestions['plus'] = []
  const guarded: FileQuestions['guarded'] = []
  const span = (node: Node) => ({ start: node.start, end: node.end })
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) return node.forEach(visit)
    if ('type' in node && node.type === 'BinaryExpression' && 'operator' in node && node.operator === '+') {
      const { left, right } = node as BinaryExpression
      plus.push({ left: span(left), right: span(right) })
    }
    if ('type' in node && 'optional' in node && node.optional === true) {
      if (node.type === 'MemberExpression' && 'object' in node) guarded.push(span(node.object as Node))
      if (node.type === 'CallExpression' && 'callee' in node) guarded.push(span(node.callee as Node))
    }
    if ('type' in node && node.type === 'LogicalExpression' && 'operator' in node && node.operator === '??' && 'left' in node) {
      guarded.push(span(node.left as Node))
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(parseSync(name, FILES[name]!).program)
  return { file: file(name), plus, guarded }
}

/**
 * The answer for every `+` in the fixture files, by file and source text, and
 * for every guarded value: its type when that cannot be null or undefined, else null.
 */
async function ask(names: string[], options?: Parameters<typeof askTypes>[2]) {
  const types = await askTypes(DIR, names.map(everyQuestion), options)
  const answers = Object.fromEntries(names.map((name) => [name, Object.fromEntries(everyQuestion(name).plus.map(({ left, right }) =>
    [FILES[name]!.slice(left.start, right.end), types.plus(file(name), left, right)]))]))
  const guarded = Object.fromEntries(names.map((name) => [name, Object.fromEntries(everyQuestion(name).guarded.map((value) =>
    [FILES[name]!.slice(value.start, value.end), types.nonNullableType(file(name), value) ?? null]))]))
  return { answers, guarded, usage: types.usage }
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

  test('tells which values a `?.` or `??` guards cannot be null or undefined', async ({ skip }) => {
    needsTypeScript(skip)
    const { guarded, usage } = await ask(['src/guards.ts'])
    expect(guarded['src/guards.ts']).toStrictEqual({
      user: 'User',
      maybe: null,
      // Without noUncheckedIndexedAccess an index access has the element type, past the end or for a missing key too.
      'users[i]': null,
      'pair[0]': null,
      'byId[id]': null,
      // Found through an index signature: no symbol of its own (`Record<string, T>`), or the signature's.
      'byId.admin': null,
      'indexed.known': 'User',
      'indexed.other': null,
      loose: null,
      opaque: null,
      generic: null,
      // A mapped type over a type parameter is null when the parameter is: `Readonly<null>` is null.
      frozen: null,
      nonNull: 'T & {}',
      'user.nickname': null,
      'user.greet': '() => string',
      'user.onSave': null,
      '(user)': 'User',
      // The assertion says what these are, not the checker, also further down the chain.
      '(maybe as User)': null,
      'maybe!': null,
      '(loose as User).name': null,
      // Were `maybe` undefined, `.name` would throw before `??`, mutated or not.
      'maybe!.name': 'string',
      // `string[]` by its type, but undefined after `f(..., { tags: undefined })`.
      'merged.tags': null,
    })
    expect(usage).toEqual({ backend: 'typescript', files: 1, untyped: [] })
  })

  test('with noUncheckedIndexedAccess, an index access has `| undefined` where it may miss, and is trusted', async ({ skip }) => {
    needsTypeScript(skip)
    const strict = (await ask(['src/guards.ts'])).guarded['src/guards.ts']
    const { guarded } = await ask(['unchecked/guards.ts'])
    expect(guarded['unchecked/guards.ts']).toStrictEqual({ ...strict, 'pair[0]': 'User' })
  })

  test('rules out nothing unless the config turns strictNullChecks on, though TypeScript 7 defaults to it', async ({ skip }) => {
    needsTypeScript(skip)
    const names = ['nulls-off/guards.ts', 'default/guards.ts']
    const { guarded, usage } = await ask(names)
    for (const name of names) {
      expect(Object.keys(guarded[name]!), name).toHaveLength(22)
      expect(Object.values(guarded[name]!).filter((type) => type !== null), name).toEqual([])
    }
    expect(usage).toEqual({ backend: 'typescript', files: 2, untyped: [] })
  })

  test('asks about the `+` and the guarded values of a file in one batch of types', async ({ skip }) => {
    needsTypeScript(skip)
    const { api } = await loadTypeScript()
    const types = vi.spyOn(api.Checker.prototype, 'getTypeAtLocation')
    const symbols = vi.spyOn(api.Checker.prototype, 'getSymbolAtLocation')
    try {
      const { answers, guarded } = await ask(['src/both.ts'])
      expect(answers['src/both.ts']).toEqual({ "user?.name + '!'": 'string', 'a + b': 'numeric' })
      expect(guarded['src/both.ts']).toStrictEqual({ user: '{ name: string; }', 'user.name': 'string' })
      // Sent together, so the client puts them in one request to the process.
      expect([types.mock.calls.length, symbols.mock.calls.length]).toEqual([1, 1])
    } finally {
      types.mockRestore()
      symbols.mockRestore()
    }
  })

  test('generate() hands the profile the type of a guarded value that cannot be null', async ({ skip }) => {
    needsTypeScript(skip)
    const name = 'src/guards.ts'
    const code = FILES[name]!
    // Only the line of `user?.name` changed.
    const changed = new Set([code.split('\n').indexOf('    user?.name,') + 1])
    const questions = typeQuestions(file(name), code, changed)
    expect(questions.guarded.map(({ start, end }) => code.slice(start, end))).toEqual(['user'])
    const types = await askTypes(DIR, [questions])
    const rules = generate(file(name), code, changed, 1, types).sites.flatMap((site) => site.mutants.map((m) => m.profile?.rule))
    expect(rules).toEqual([{ kind: 'nonNullish', subject: 'user', type: 'User' }])
    expect(generate(file(name), code, changed, 1).sites[0]!.mutants[0]!.profile?.rule).toEqual({ kind: 'nonNullish', subject: 'user', type: undefined })
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
      const types = await askTypes(DIR, [signature, annotated, { file: path.join(outside, 'a.js'), plus, guarded: [] }], { load })
      expect([signature.plus, annotated.plus]).toEqual([[], []])
      expect(load).not.toHaveBeenCalled()
      expect(types.usage).toMatchObject({ backend: 'none', reason: expect.stringMatching(/^TypeScript does not check this JavaScript/), untyped: [] })
      // Nothing above a TypeScript file can include it in a project.
      const loose = await askTypes(DIR, [{ file: path.join(outside, 'a.ts'), plus, guarded: [] }], { load })
      expect(loose.usage).toEqual({ backend: 'none', reason: 'not in any tsconfig.json project', untyped: [{ file: path.join(outside, 'a.ts'), reason: 'not in any tsconfig.json project' }] })
      // Without a `+`, its `?.` keep today's verdicts without types: nothing to list.
      const guardOnly = await askTypes(DIR, [{ file: path.join(outside, 'b.ts'), plus: [], guarded: [{ start: 0, end: 1 }] }], { load })
      expect(guardOnly.usage).toEqual({ backend: 'none', reason: 'not in any tsconfig.json project', untyped: [] })
      // Only TypeScript is asked about nulls: what TypeScript says of JavaScript does not hold for them.
      const javascript = await askTypes(DIR, [everyQuestion('checked/guard.js')], { load })
      expect(javascript.usage).toEqual({ backend: 'none', reason: 'no `+`, `?.` or `??` on a changed line needed types', untyped: [] })
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
      const types = await askTypes(${JSON.stringify(DIR)}, [${JSON.stringify(everyQuestion('src/mixed.ts'))}], { load })
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
