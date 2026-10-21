import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { applyMutant } from '../src/mutate/equivalent.ts'
import { generate } from '../src/mutate/generate.ts'
import { instrument } from '../src/mutate/instrument.ts'

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
  const { sites, mutants } = generate('file.js', SOURCE, changed, 1)
  const instrumented = instrument('file.js', SOURCE, sites).code
  const state = (active: number) => ({ active, limit: 0, hits: null, count: 0, exceeded: false })

  test('covers every operator', () => {
    expect(new Set(mutants.map((m) => m.operator)).size).toBe(11)
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
  const { sites, mutants } = generate('file.js', source, new Set([5, 7, 8, 9]), 1)
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
})
