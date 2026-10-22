import vm from 'node:vm'
import { describe, expect, test } from 'vitest'
import { generate } from '../src/mutate/generate.ts'
import { instrument } from '../src/mutate/instrument.ts'
import { CLASS, mergeProfile, predict, SLOTS, type Prediction, type ProbeRecord, type Rule } from '../src/mutate/profile.ts'
import type { Operator } from '../src/types.ts'
import { addedLines } from './changes.ts'

const UNPROFILED = new Set<Operator>(['FunctionBody', 'CallUnwrap', 'CallStatement', 'Regex'])

/**
 * Profiles `code` (every line mutated) in a baseline that calls each of
 * `calls`, as the session's setup file would, and returns what the profile
 * says about each mutant it can settle: "<operator> <description>: <verdict> <reason>",
 * or ": run" when it settles nothing. Before returning, it runs every mutant
 * predicted to survive and checks the calls give exactly what the original gives.
 */
function predictions(code: string, calls: string): string[] {
  const driver = `\nfunction main() {
  const out = []
  for (const call of [${calls}]) {
    try { out.push(call()) } catch (e) { out.push('throws ' + e.constructor.name) }
  }
  return JSON.stringify(out)
}
// Keeps the code alive for TCE.
globalThis.main = main`
  const source = code + driver
  const changed = new Set(code.split('\n').map((_, i) => i + 1))
  const { sites, mutants } = generate('file.js', source, addedLines(source, changed), 1)
  const run = (instrumented: string, state: object) => vm.runInNewContext(`${instrumented}\nmain()`, { __nyorori: state }, { timeout: 500 })
  const state = (active: number) => ({ active, limit: 0, hits: {} as Record<string, number>, count: 0, exceeded: false, prof: new Float64Array((mutants.length + 1) * SLOTS) })

  const baseline = state(0)
  const original = run(instrument('file.js', source, sites, { profile: true }).code, baseline)
  // The same records the setup file sends back: one per probe that ran.
  const records: Record<string, number[]> = {}
  for (let i = 0; i < baseline.prof.length; i += SLOTS) if (baseline.prof[i + SLOTS - 1]! > 0) records[i / SLOTS] = [...baseline.prof.subarray(i, i + SLOTS)]
  const profile = new Map<number, ProbeRecord>()
  mergeProfile(profile, records)

  const plain = instrument('file.js', source, sites).code
  // The profile never settles FunctionBody, which every function here has, nor the call and regex operators.
  const planned = sites.flatMap((site) => site.mutants).filter(({ mutant }) => !UNPROFILED.has(mutant.operator))
  return planned.map(({ mutant, profile: probed }) => {
    const prediction: Prediction | undefined = probed && predict(probed.rule, profile.get(probed.probe.key), baseline.hits[mutant.id] ?? 0)
    if (prediction?.verdict === 'survives') expect(run(plain, state(mutant.id)), `${mutant.operator} ${mutant.description}`).toBe(original)
    return `${mutant.operator} ${mutant.description}: ${prediction ? `${prediction.verdict} ${prediction.reason}` : 'run'}`
  })
}

describe('OptionalChaining', () => {
  const code = 'function name(user) {\n  return user?.profile?.name\n}'

  test('survives when the object is never nullish', () => {
    expect(predictions(code, '() => name({ profile: { name: "Lee" } }), () => name({ profile: {} })')).toEqual([
      'OptionalChaining `?.` → `.`: survives no test makes `user?.profile` null or undefined here',
      'OptionalChaining `?.` → `.`: survives no test makes `user` null or undefined here',
    ])
  })

  test('runs once a test makes it null or undefined', () => {
    expect(predictions(code, '() => name({ profile: { name: "Lee" } }), () => name({})')).toEqual([
      'OptionalChaining `?.` → `.`: run',
      'OptionalChaining `?.` → `.`: survives no test makes `user` null or undefined here',
    ])
    // A null user stops the chain before `.profile?.`; that link counts as nullish too.
    expect(predictions(code, '() => name({ profile: { name: "Lee" } }), () => name(null)')).toEqual([
      'OptionalChaining `?.` → `.`: run',
      'OptionalChaining `?.` → `.`: run',
    ])
  })

  test('counts calls without touching the callee, so `this` stays', () => {
    const notify = 'function notify(handlers, msg) {\n  return handlers.onMessage?.(msg)\n}'
    const handler = '{ tag: "h", onMessage(m) { return this.tag + m } }'
    expect(predictions(notify, `() => notify(${handler}, 1), () => notify(${handler}, 2)`)).toEqual([
      'OptionalChaining `?.` → `(none)`: survives no test makes `handlers.onMessage` null or undefined here',
    ])
    expect(predictions(notify, `() => notify(${handler}, 1), () => notify({}, 2)`)).toEqual(['OptionalChaining `?.` → `(none)`: run'])
  })

  test('runs a call the chain does not reach in every evaluation, even when it throws first', () => {
    const deep = 'function deep(h) {\n  return h.a.on?.()\n}'
    expect(predictions(deep, '() => deep({ a: { on: () => 1 } }), () => deep({})')).toEqual(['OptionalChaining `?.` → `(none)`: run'])
  })

  test('settles nothing for code no test runs', () => {
    // Mentions name() without calling it, or TCE would drop its mutants as dead code.
    expect(predictions(code, '() => typeof name')).toEqual(['OptionalChaining `?.` → `.`: run', 'OptionalChaining `?.` → `.`: run'])
  })
})

describe('Logical `??`', () => {
  const code = 'function count(x) {\n  return x ?? 0\n}'

  test('survives when the left side is never nullish', () => {
    expect(predictions(code, '() => count(1), () => count(0)')).toEqual(['Logical `x ?? 0` → `x`: survives no test makes `x` null or undefined here'])
  })

  test('runs once a test makes it null or undefined', () => {
    expect(predictions(code, '() => count(1), () => count(undefined)')).toEqual(['Logical `x ?? 0` → `x`: run'])
  })
})

describe('a value whose type cannot be null, by what the tests did', () => {
  const unnecessary = (subject: string, type: string): Prediction =>
    ({ verdict: 'unnecessary', reason: `\`${subject}\` is \`${type}\` by its type, which can't be null or undefined, and no test passed null or undefined` })
  const survives: Prediction = { verdict: 'survives', reason: 'no test makes `user` null or undefined here' }

  // [its type, what the baseline recorded over 2 evaluations, the verdict]
  test.for<[string | undefined, ProbeRecord | undefined, Prediction | undefined]>([
    // Probably redundant defensive code: listed, not run, not failing.
    ['User', [CLASS.object, 0, 0, 2], unnecessary('user', 'User')],
    // The types are wrong in the tests (`null as any`): run like any other.
    ['User', [CLASS.object | CLASS.null, 0, 0, 2], undefined],
    // The type may be null, or says nothing (`any`, JavaScript, no types): today's predicted survivor.
    [undefined, [CLASS.object, 0, 0, 2], survives],
    [undefined, [CLASS.undefined | CLASS.object, 0, 0, 2], undefined],
    // No test runs it: NoCoverage, whatever the type.
    ['User', undefined, undefined],
  ])('`user?.name` with type %s and record %j', ([type, record, verdict]) => {
    expect(predict({ kind: 'nonNullish', subject: 'user', type }, record, 2)).toEqual(verdict)
  })

  test('an optional call counts calls', () => {
    const rule = (type?: string): Rule => ({ kind: 'called', subject: 'handlers.onMessage', type })
    expect(predict(rule('() => void'), [0, 0, 0, 2], 2)).toEqual(unnecessary('handlers.onMessage', '() => void'))
    // One evaluation did not call it: the callee was nullish there.
    expect(predict(rule('() => void'), [0, 0, 0, 1], 2)).toBeUndefined()
    expect(predict(rule(), [0, 0, 0, 2], 2)).toEqual({ verdict: 'survives', reason: 'no test makes `handlers.onMessage` null or undefined here' })
  })
})

describe('ComparisonBoundary', () => {
  const code = 'function below(x, lo) {\n  return x < lo\n}'

  test('survives when the operands are never equal', () => {
    expect(predictions(code, '() => below(1, 5), () => below(9, 5), () => below("a", "b")')).toEqual([
      'ComparisonBoundary `<` → `<=`: survives no test has `x === lo`',
    ])
  })

  test('runs once a test hits the boundary', () => {
    expect(predictions(code, '() => below(1, 5), () => below(5, 5)')).toEqual(['ComparisonBoundary `<` → `<=`: run'])
    // Equal by comparison though not by `===`.
    expect(predictions(code, '() => below(1, 5), () => below("5", 5)')).toEqual(['ComparisonBoundary `<` → `<=`: run'])
  })

  test('runs objects, whose valueOf it would have to call again', () => {
    expect(predictions(code, '() => below(new Date(1), new Date(2))')).toEqual(['ComparisonBoundary `<` → `<=`: run'])
  })

  test('does not claim `===` was never true for undefined operands', () => {
    expect(predictions(code, '() => below(undefined, undefined), () => below(1, 2)')).toEqual([
      'ComparisonBoundary `<` → `<=`: survives `<` and `<=` gave the same result in every test',
    ])
  })
})

describe('Arithmetic', () => {
  test('survives when the mutated operator never changes a value', () => {
    const total = 'function total(item) {\n  return item.price + item.fee\n}'
    expect(predictions(total, '() => total({ price: 3, fee: 0 }), () => total({ price: 5, fee: -0 })')).toEqual([
      'Arithmetic `+` → `-`: survives `item.fee` was always 0',
    ])
    const scale = 'function scale(x, y) {\n  return x * y\n}'
    expect(predictions(scale, '() => scale(0, 5), () => scale(0, -2)')).toEqual(['Arithmetic `*` → `/`: survives `x` was always 0'])
    const grow = 'function grow(x) {\n  return x + 1\n}'
    expect(predictions(grow, '() => grow(Infinity)')).toEqual(['Arithmetic `+` → `-`: survives `+` and `-` gave the same value in every test'])
  })

  test('runs once it changes a value, down to the sign of zero', () => {
    const total = 'function total(item) {\n  return item.price + item.fee\n}'
    expect(predictions(total, '() => total({ price: 3, fee: 0 }), () => total({ price: 3, fee: 1 })')).toEqual(['Arithmetic `+` → `-`: run'])
    // -0 + 0 is 0, -0 - 0 is -0.
    expect(predictions(total, '() => total({ price: -0, fee: 0 })')).toEqual(['Arithmetic `+` → `-`: run'])
  })

  test('runs an operator that throws, where the mutated one might not', () => {
    const divide = 'function divide(a, b) {\n  return a / b\n}'
    expect(predictions(divide, '() => String(divide(0n, 1n)), () => String(divide(0n, 0n))')).toEqual(['Arithmetic `/` → `*`: run'])
  })

  test('runs objects, whose valueOf it would have to call again', () => {
    const total = 'function total(a, b) {\n  return a - b\n}'
    expect(predictions(total, '() => total({ valueOf: () => 1 }, 0)')).toEqual(['Arithmetic `-` → `+`: run'])
  })

  describe('string `+`', () => {
    const label = 'function label(a, b) {\n  return a + b\n}'

    test('skips a `+` that had a string operand in every evaluation', () => {
      expect(predictions(label, '() => label("Mr. ", "Kim"), () => label("n=", 1), () => label(1, "")')).toEqual([
        'Arithmetic `+` → `-`: concatenation string concatenation in every observed evaluation',
      ])
    })

    test('runs a `+` that also added numbers', () => {
      expect(predictions(label, '() => label("a", "b"), () => label(1, 2)')).toEqual(['Arithmetic `+` → `-`: run'])
    })

    test('leaves a `+` no test runs to NoCoverage', () => {
      expect(predictions(label, '() => typeof label')).toEqual(['Arithmetic `+` → `-`: run'])
    })
  })
})

describe('Condition', () => {
  test('survives when a test without side effects always has the hard-coded value', () => {
    const flag = 'function mode(o) {\n  if (o.flag) return 1\n  return 2\n}'
    expect(predictions(flag, '() => mode({ flag: true }), () => mode({ flag: true })')).toEqual([
      'Condition `o.flag` → `true`: survives the condition was always true in tests',
      'Condition `o.flag` → `false`: run',
    ])
    expect(predictions(flag, '() => mode({ flag: "yes" }), () => mode({})')).toEqual(['Condition `o.flag` → `true`: run', 'Condition `o.flag` → `false`: run'])
    expect(predictions(flag, '() => mode({}), () => mode({ flag: 0 })')).toEqual([
      'Condition `o.flag` → `true`: run',
      'Condition `o.flag` → `false`: survives the condition was always falsy in tests',
    ])
  })

  test('survives `false` for a loop whose body never runs', () => {
    const loop = 'function drain(list) {\n  while (list.length) list.pop()\n  return list\n}'
    expect(predictions(loop, '() => drain([])')).toEqual(['Condition `list.length` → `false`: survives the condition was always falsy in tests'])
  })

  test('never predicts a test with a call, `new`, an assignment or another side effect', () => {
    for (const test of ['o.check()', 'new Boolean(o.flag)', '(o.n = 1)', 'o.n++', 'o[o.key]', 'delete o.x', 'tag`x`']) {
      const code = `function mode(o) {\n  if (${test}) return 1\n  return 2\n}`
      const calls = '() => mode({ flag: true, check: () => true, key: "flag", x: 1 }), () => mode({ flag: true, check: () => true, key: "flag", x: 1 })'
      expect(predictions(code.replace('function mode', 'const tag = () => true\nfunction mode'), calls).filter((p) => p.startsWith('Condition'))).toEqual([
        expect.stringMatching(/→ `true`: run$/),
        expect.stringMatching(/→ `false`: run$/),
      ])
    }
  })

  test('runs a test that threw in some evaluation, which a hard-coded value would not', () => {
    const deep = 'function mode(o) {\n  if (o.a.b) return 1\n  return 2\n}'
    expect(predictions(deep, '() => mode({ a: { b: 1 } }), () => mode({})')).toEqual(['Condition `o.a.b` → `true`: run', 'Condition `o.a.b` → `false`: run'])
  })
})
