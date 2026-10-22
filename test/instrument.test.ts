import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { applyMutant } from '../src/mutate/equivalent.ts'
import { generate } from '../src/mutate/generate.ts'
import { instrument } from '../src/mutate/instrument.ts'
import { SLOTS } from '../src/mutate/profile.ts'
import { OPERATORS, type Operator } from '../src/types.ts'
import { addedLines } from './changes.ts'

const SOURCE = `function compare(a, b) { return a >= b && a !== 3 }
function arith(x) { return -x * 2 + x % 3 - (x / 4) }
function flags(x) { if (!x) return false; return x ? true : !!x }
function loop(n) { let t = 0; for (let i = 0; i < n; i++) t += i; while (t > 100) t = t - 50; return t }
function chain(o) { return o?.a?.b ?? o?.f?.() ?? 'none' }
const arrow = (x) => x > 0 ? (y) => y < x : null
function nested(a, b) { return (a > 1 ? b === 2 : a <= b) || !(a < 0 && b > 0) }
function main() { const out = []; for (const call of [() => compare(3, 3), () => compare(4, 3), () => compare(2, 3), () => arith(5), () => arith(-7), () => flags(0), () => flags(2), () => loop(0), () => loop(20), () => chain(null), () => chain({ a: { b: 1 } }), () => chain({ f: () => 'f' }), () => chain({ a: {} }), () => arrow(2)?.(1), () => arrow(-1), () => nested(2, 2), () => nested(1, 1), () => nested(-1, 1), () => nested(0, -1)]) { try { out.push(call()) } catch (e) { out.push('throws ' + e.constructor.name) } } return JSON.stringify(out) }`

// `main` (last line) only drives the functions; it is not mutated.
const changed = new Set(SOURCE.split('\n').slice(0, -1).map((_, i) => i + 1))

function evaluate(code: string, state: object): string {
  try {
    return vm.runInNewContext(`${code}\nmain()`, { __nyorori: state }, { timeout: 500 })
  } catch (error) {
    // Mutants such as `i++` → `i--` loop forever; both versions must then time out.
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout'
    throw error
  }
}

describe('instrument', () => {
  const { sites, mutants } = generate('file.js', SOURCE, addedLines(SOURCE, changed), 1)
  const instrumented = instrument('file.js', SOURCE, sites).code
  const state = (active: number) => ({ active, limit: 0, hits: null, count: 0, exceeded: false })

  test('covers every operator but the call and regex ones, which have their own source below', () => {
    const below = new Set<Operator>(['CallUnwrap', 'CallStatement', 'Regex'])
    expect(new Set(mutants.map((m) => m.operator))).toEqual(new Set(OPERATORS.filter((operator) => !below.has(operator))))
  })

  test('with no active mutant, behaves like the original', () => {
    expect(evaluate(instrumented, state(0))).toBe(evaluate(SOURCE, state(0)))
  })

  test.each(sites.flatMap((site) => site.mutants.map((planned) => ({ site, planned, label: `${planned.mutant.id} ${planned.mutant.operator} ${planned.mutant.description}` }))))(
    'mutant $label behaves like the source with only that change',
    ({ site, planned }) => {
      const expected = evaluate(applyMutant(SOURCE, site, planned), state(0))
      expect(evaluate(instrumented, state(planned.mutant.id))).toBe(expected)
    },
  )

  test('counts hits per mutant in the baseline run', () => {
    const hits: Record<string, number> = {}
    evaluate(instrumented, { ...state(0), hits })
    const loopBound = mutants.find((m) => m.operator === 'Update')!
    expect(hits[loopBound.id]).toBe(20)
    // loop(20) gives 190, and `t = t - 50` runs twice to bring it to 90.
    const whileBody = mutants.find((m) => m.operator === 'Arithmetic' && m.description === '`-` → `+`' && m.line === 4)!
    expect(hits[whileBody.id]).toBe(2)
  })

  test('throws once the active mutant passes its hit limit', () => {
    const update = mutants.find((m) => m.operator === 'Update')!
    const s = { ...state(update.id), limit: 1000 }
    // i-- never reaches n, so the loop would run forever.
    expect(vm.runInNewContext(`${instrumented}\ntry { loop(20) } catch (e) { e.message }`, { __nyorori: s })).toMatch(/exceeded its hit limit/)
    expect(s.exceeded).toBe(true)
  })

  test('keeps a source map that points into the original', () => {
    const { map } = instrument('file.js', SOURCE, sites)
    expect(JSON.parse(map)).toMatchObject({ version: 3, sources: ['file.js'], sourcesContent: [SOURCE] })
  })

  describe('with profiling probes', () => {
    const profiled = instrument('file.js', SOURCE, sites, { profile: true })
    const prof = () => new Float64Array((mutants.length + 1) * SLOTS)

    test('has probes, which the plain instrumentation does not', () => {
      expect(profiled.code).toMatch(/__nyorori_v\(\d+, /)
      expect(profiled.code).toMatch(/__nyorori_b\d\(\d+, /)
      expect(profiled.code).toMatch(/\?\.\(\.\.\.__nyorori_e\(\d+\)\)/)
      expect(instrumented).not.toMatch(/__nyorori_[vbe]/)
    })

    test('with no active mutant, behaves like the original while recording', () => {
      const p = prof()
      expect(evaluate(profiled.code, { ...state(0), prof: p })).toBe(evaluate(SOURCE, state(0)))
      expect(p.some((x) => x > 0)).toBe(true)
    })

    test('counts the same hits as the plain instrumentation', () => {
      const plainHits: Record<string, number> = {}
      const profiledHits: Record<string, number> = {}
      evaluate(instrumented, { ...state(0), hits: plainHits })
      evaluate(profiled.code, { ...state(0), hits: profiledHits, prof: prof() })
      expect(profiledHits).toEqual(plainHits)
    })

    test.each(sites.flatMap((site) => site.mutants.map((planned) => ({ site, planned, label: `${planned.mutant.id} ${planned.mutant.operator} ${planned.mutant.description}` }))))(
      'mutant $label still behaves like the source with only that change',
      ({ site, planned }) => {
        const expected = evaluate(applyMutant(SOURCE, site, planned), state(0))
        expect(evaluate(profiled.code, { ...state(planned.mutant.id), prof: prof() })).toBe(expected)
      },
    )

    test('keeps a source map that points into the original', () => {
      expect(JSON.parse(profiled.map)).toMatchObject({ version: 3, sources: ['file.js'], sourcesContent: [SOURCE] })
    })
  })
})

describe('profiling probes keep evaluation order, `this` and side effects', () => {
  // Every operand logs when it is evaluated; getters and valueOf log when they run.
  const source = `function probe(o, t, v) {
  const r = []
  r.push(t('a', 1) + t('b', 2) * t('c', 3) - t('d', 4) % t('e', 3))
  r.push(t('l', v) < t('r', 3), v + 1, v * 2 >= t('k', 4), 'n' + t('s', 1), t('u', undefined) <= t('u2', undefined))
  r.push(o.m?.(t('arg', 1), t('arg', 2)), o.m?.(), t('o', o)?.m?.(), o?.m(), o.inner.f?.(), o?.inner.f(), o.inner?.f())
  r.push(o[t('key', 'inner')]?.f?.(), o.missing?.(t('never', 1)), o.missing?.x.y.z, t('x', null) ?? t('y', 'fallback'), t('z', 0) ?? t('w', 1))
  r.push(new Derived(t('base', 7)).call())
  if (o.n > 1) r.push('big')
  while (o.n < 3) o.n++
  r.push(o.n === 3 ? t('then', 1) : t('else', 2), o?.[t('idx', 'n')])
  try { r.push(o.none.deeper?.()) } catch (e) { r.push(e.constructor.name) }
  try { r.push(1n + t('mix', 1)) } catch (e) { r.push(e.constructor.name) }
  return r
}
class Base { constructor(x) { this.x = x } m() { return this instanceof Base && this.x } }
class Derived extends Base { call() { return [super.m?.(), super.m()] } }
function main() {
  const log = []
  const t = (name, value) => (log.push(name), value)
  const o = {
    n: 0,
    get m() { log.push('get m'); return function (...args) { log.push('m this=' + (this === o) + ' args=' + args.length); return args.length } },
    inner: { f() { return this === o.inner } },
  }
  const v = { valueOf() { log.push('valueOf'); return 2 } }
  const r = probe(o, t, v)
  return JSON.stringify({ r, log })
}
// Keeps probe() alive for TCE, which would otherwise drop its mutants as dead code.
globalThis.main = main`
  // Mutate all of probe() and the classes; main() only drives them.
  const lines = source.split('\n')
  const changed = new Set(lines.map((_, i) => i + 1).filter((line) => line < lines.indexOf('function main() {') + 1))
  const { sites, mutants } = generate('file.js', source, addedLines(source, changed), 1)
  const plain = instrument('file.js', source, sites).code
  const profiled = instrument('file.js', source, sites, { profile: true }).code
  const state = (active: number) => ({ active, limit: 0, hits: {}, count: 0, exceeded: false, prof: new Float64Array((mutants.length + 1) * SLOTS) })

  test('probes every kind of site here', () => {
    const kinds = new Set(sites.flatMap((site) => site.mutants.flatMap((m) => (m.profile ? [m.profile.probe.kind] : []))))
    expect([...kinds].sort()).toEqual(['binary', 'call', 'value'])
  })

  test('the original, the plain and the profiled code log the same', () => {
    const original = evaluate(source, state(0))
    // The log shows operands evaluated once and in order, getters and valueOf run once, and `this` kept.
    expect(JSON.parse(original).log).toEqual([
      'a', 'b', 'c', 'd', 'e', 'l', 'r', 'valueOf', 'valueOf', 'valueOf', 'k', 's', 'u', 'u2',
      'get m', 'arg', 'arg', 'm this=true args=2', 'get m', 'm this=true args=0', 'o', 'get m', 'm this=true args=0', 'get m', 'm this=true args=0',
      'key', 'x', 'y', 'z', 'base', 'then', 'idx', 'mix',
    ])
    expect(evaluate(plain, state(0))).toBe(original)
    expect(evaluate(profiled, state(0))).toBe(original)
  })

  // Some mutants make probe() throw; then both must throw the same.
  const outcome = (code: string, s: object) => {
    try {
      return evaluate(code, s)
    } catch (error) {
      return `throws ${String(error)}`
    }
  }

  test.each(mutants.map((m) => ({ id: m.id, label: `${m.id} ${m.operator} ${m.description}` })))('mutant $label behaves the same in the plain and the profiled code', ({ id }) => {
    expect(outcome(profiled, state(id))).toBe(outcome(plain, state(id)))
  })
})

describe('instrument without semicolons', () => {
  // Each mutated statement follows a line whose last token could be called or indexed.
  const source = [
    'function g(x) { return x }',
    'function f(n) {',
    '  let i = n',
    '  const out = g(1)',
    '  i++',
    '  const list = [1, 2]',
    '  !n ? i-- : i++',
    '  if (n) i--',
    '  else n > 0 && i++',
    '  return [i, out, list.length]',
    '}',
    'function main() { return JSON.stringify([f(0), f(1), f(-1)]) }',
  ].join('\n')
  const { sites, mutants } = generate('file.js', source, addedLines(source, [5, 7, 8, 9]), 1)
  const instrumented = instrument('file.js', source, sites).code
  const state = (active: number) => ({ active, limit: 0, hits: null, count: 0, exceeded: false })

  test('wraps statements that start with a site in a block', () => {
    expect(sites.some((site) => site.statement)).toBe(true)
    expect(instrumented).toContain('const out = g(1)\n  { (__nyorori_h(')
    expect(evaluate(instrumented, state(0))).toBe(evaluate(source, state(0)))
  })

  test.each(mutants.map((m) => ({ id: m.id, label: `${m.id} ${m.operator} ${m.description}` })))('mutant $label behaves like the source with only that change', ({ id }) => {
    const site = sites.find((s) => s.mutants.some((p) => p.mutant.id === id))!
    const planned = site.mutants.find((p) => p.mutant.id === id)!
    expect(evaluate(instrumented, state(id))).toBe(evaluate(applyMutant(source, site, planned), state(0)))
  })

  test('with probes too', () => {
    const profiled = instrument('file.js', source, sites, { profile: true }).code
    expect(profiled).toContain('const out = g(1)\n  { (__nyorori_h(')
    const prof = () => new Float64Array((mutants.length + 1) * SLOTS)
    expect(evaluate(profiled, { ...state(0), prof: prof() })).toBe(evaluate(source, state(0)))
    for (const { id } of mutants) expect(evaluate(profiled, { ...state(id), prof: prof() })).toBe(evaluate(instrumented, state(id)))
  })
})

describe('optional chains used as references', () => {
  // Wrapping these in a conditional would make them plain values.
  const source = [
    'function f(o, d, i) {',
    '  const called = (o?.inner.f)()',
    '  const tagged = (o?.inner.tag)`x`',
    '  delete d?.x',
    '  const keyed = (o?.list[i + 1])()',
    '  return [called, tagged, keyed, "x" in d, o?.inner.v]',
    '}',
    'function main() { const o = { inner: { v: 7, f() { return this.v }, tag() { return this.v } }, list: [0, function () { return this === o.list }] }; try { return JSON.stringify(f(o, { x: 1 }, 0)) } catch (e) { return "throws " + e.constructor.name } }',
  ].join('\n')
  const { sites, mutants } = generate('file.js', source, addedLines(source, [2, 3, 4, 5, 6]), 1)
  const instrumented = instrument('file.js', source, sites).code
  const state = (active: number) => ({ active, limit: 0, hits: null, count: 0, exceeded: false })

  test('keeps `this` and `delete` working, and still mutates the chain used as a value', () => {
    expect(evaluate(source, state(0))).toBe('[7,7,true,false,7]')
    expect(evaluate(instrumented, state(0))).toBe(evaluate(source, state(0)))
    expect(mutants.filter((m) => m.operator === 'OptionalChaining').map((m) => m.line)).toEqual([6])
    expect(mutants.some((m) => m.line === 5 && m.operator === 'Arithmetic')).toBe(true)
  })

  test.each(mutants.map((m) => ({ id: m.id, label: `${m.id} ${m.operator} ${m.description}` })))('mutant $label behaves like the source with only that change', ({ id }) => {
    const site = sites.find((s) => s.mutants.some((p) => p.mutant.id === id))!
    const planned = site.mutants.find((p) => p.mutant.id === id)!
    expect(evaluate(instrumented, state(id))).toBe(evaluate(applyMutant(source, site, planned), state(0)))
  })
})

describe('calls and regular expressions', () => {
  // No semicolons: every statement-level call and the regex statement follow a line a `(` would continue.
  const source = `function normalizeZero(x) { return Object.is(x, -0) ? 0 : x }
function toInteger(x) { return Math.trunc(Number(x)) }
function toArray(x) { return [x, x] }
function calls(o, x, key) {
  const out = []
  const log = []
  out.push(normalizeZero(x) + 1)
  out.push(o.get(key, 'd'), o.f?.(x), toInteger(x)?.toFixed(1))
  if (o.has(key)) out.push('has')
  log.push('a')
  o.seen.delete(key)
  o.cb?.(log, x)
  toArray(x).forEach((y) => log.push(y))
  return [out, log, [...o.seen]]
}
function regex(s, n) {
  const out = []
  if (n) { out.push(n) }
  /^a[bc]\\d+$/gim.test(s) && out.push('match')
  out.push(s.replace(/a.b/s, '-'), s.split(/,\\s*/).length, n / /ab/.source.length)
  out.push([...s.matchAll(/[^,]/g)].length, /(x|^y)$/m.test(s), /\\W[\\d.]/.test(s), /[\\p{L}--[a-z]]/v.test(s))
  return out
}
function main() {
  const o = () => ({ get: (k, d) => k + d, f: (x) => x * 2, has: (k) => k === 'k', seen: new Set(['k', 'j']), cb: (log, x) => log.push('cb' + x) })
  const out = []
  for (const call of [() => calls(o(), 0, 'k'), () => calls(o(), -0, 'k'), () => calls(o(), -2.5, 'j'), () => calls({ ...o(), f: null, cb: undefined }, 3, 'k'), () => regex('ab12', 0), () => regex('a.b, Ab3\\nX', 2), () => regex('y', 1), () => regex('É x.', 3), () => regex('a\\nb,,AB12x\\ny', 0), () => regex('a\\nb\\nab1', 1)]) {
    try { out.push(call()) } catch (e) { out.push('throws ' + e.constructor.name) }
  }
  return JSON.stringify(out)
}`
  const lines = source.split('\n')
  const changed = new Set(lines.map((_, i) => i + 1).filter((line) => line < lines.indexOf('function main() {') + 1))
  const { sites, mutants } = generate('file.js', source, addedLines(source, changed), 1)
  const plain = instrument('file.js', source, sites).code
  const profiled = instrument('file.js', source, sites, { profile: true }).code
  const state = (active: number) => ({ active, limit: 0, hits: null, count: 0, exceeded: false, prof: new Float64Array((mutants.length + 1) * SLOTS) })
  const cases = sites.flatMap((site) => site.mutants.map((planned) => ({ site, planned, label: `${planned.mutant.id} ${planned.mutant.line}:${planned.mutant.column} ${planned.mutant.operator} ${planned.mutant.description}` })))

  test('has every new operator, on statement starts too', () => {
    const operators = new Set(mutants.map((m) => m.operator))
    for (const operator of ['CallUnwrap', 'CallStatement', 'Regex'] as const) expect(operators).toContain(operator)
    expect(sites.filter((site) => site.statement && site.mutants.some((m) => m.mutant.operator !== 'FunctionBody')).length).toBeGreaterThan(3)
    // A regex literal opens the statement after a block.
    expect(plain.split('\n').find((line) => line.includes('/^a[bc]\\d+$/gim.test(s)'))).toMatch(/^  \{ \(__nyorori_h\(/)
  })

  test('with no active mutant, behaves like the original', () => {
    const original = evaluate(source, state(0))
    expect(original).not.toContain('throws')
    expect(evaluate(plain, state(0))).toBe(original)
    expect(evaluate(profiled, state(0))).toBe(original)
  })

  test.each(cases)('mutant $label behaves like the source with only that change', ({ site, planned }) => {
    const expected = evaluate(applyMutant(source, site, planned), state(0))
    expect(evaluate(plain, state(planned.mutant.id))).toBe(expected)
    expect(evaluate(profiled, state(planned.mutant.id))).toBe(expected)
  })

  describe('under await', () => {
    const asyncSource = `async function save(store, x) {
  await store.put(x)
  await store.flush?.(x)
  store.done(x)
  return store.items
}
async function main() {
  const store = () => ({ items: [], put(x) { return Promise.resolve().then(() => this.items.push(x)) }, flush(x) { this.items.push('flush' + x) }, done(x) { this.items.push('done' + x) } })
  const out = []
  for (const call of [() => save(store(), 1), () => save({ ...store(), flush: undefined }, 2)]) {
    try { out.push(await call()) } catch (e) { out.push('throws ' + e.constructor.name) }
  }
  return JSON.stringify(out)
}`
    const result = generate('file.js', asyncSource, addedLines(asyncSource, [2, 3, 4]), 1)
    const code = instrument('file.js', asyncSource, result.sites).code
    const profiledCode = instrument('file.js', asyncSource, result.sites, { profile: true }).code
    const run = (text: string, active: number): Promise<string> => vm.runInNewContext(`${text}\nmain()`, { __nyorori: state(active) })

    test('removes only the call, so the statement still awaits', () => {
      expect(result.mutants.filter((m) => m.operator === 'CallStatement').map((m) => `${m.line}:${m.column} ${m.description}`)).toEqual([
        '2:15 `store.put(x)` removed',
        '3:15 `store.flush?.(x)` removed',
        '4:9 `store.done(x)` removed',
      ])
      expect(code).toContain('await (__nyorori_h(')
    })

    test.each(result.sites.flatMap((site) => site.mutants.map((planned) => ({ site, planned, label: `${planned.mutant.id} ${planned.mutant.operator} ${planned.mutant.description}` }))))(
      'mutant $label behaves like the source with only that change',
      async ({ site, planned }) => {
        const expected = await run(applyMutant(asyncSource, site, planned), 0)
        expect(await run(code, planned.mutant.id)).toBe(expected)
        expect(await run(profiledCode, planned.mutant.id)).toBe(expected)
      },
    )
  })
})
