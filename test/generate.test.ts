import { describe, expect, test } from 'vitest'
import { generate } from '../src/mutate/generate.ts'

function all(code: string): Set<number> {
  return new Set(code.split('\n').map((_, i) => i + 1))
}

function mutants(code: string, changed = all(code), file = 'file.ts'): string[] {
  return generate(file, code, changed, 1).mutants.map((m) => `${m.line}:${m.column} ${m.operator} ${m.description}`)
}

describe('operators', () => {
  test('each operator produces the documented change', () => {
    const code = [
      'function f(a, b, o, i) {',
      '  if (a && !b) return -a',
      '  i++',
      '  const c = o?.x ?? true',
      '  while (a % b) a--',
      '  return a > 0 ? c : b',
      '}',
    ].join('\n')
    expect(mutants(code)).toEqual([
      '1:24 FunctionBody body → `return`',
      '2:7 Condition `a && !b` → `true`',
      '2:7 Condition `a && !b` → `false`',
      '2:9 Logical `&&` → `||`',
      '2:12 Negation `!b` → `b`',
      '2:23 UnaryMinus `-a` → `a`',
      '3:4 Update `++` → `--`',
      '4:18 Logical `o?.x ?? true` → `o?.x`',
      '4:14 OptionalChaining `?.` → `.`',
      '4:21 BooleanLiteral `true` → `false`',
      '5:10 Condition `a % b` → `false`',
      '5:12 Arithmetic `%` → `*`',
      '5:18 Update `--` → `++`',
      '6:10 Condition `a > 0` → `true`',
      '6:10 Condition `a > 0` → `false`',
      '6:12 ComparisonBoundary `>` → `>=`',
    ])
  })

  test('arrow expression bodies return undefined', () => {
    expect(mutants('const f = (x) => x.y')).toEqual(['1:18 FunctionBody `=> x.y` → `=> undefined`'])
  })
})

describe('scope', () => {
  test('only anchors on changed lines', () => {
    const code = ['function f(a) {', '  if (a > 1) return 1', '  return a === 2', '}'].join('\n')
    expect(mutants(code, new Set([3]))).toEqual(['3:12 Equality `===` → `!==`'])
  })

  test('skips module-level code, types and declarations', () => {
    const code = [
      'const limit = 1 + 2',
      'type T = { a: true }',
      'interface I { b: false }',
      'enum E { A = 1 + 1 }',
      'declare function g(x: boolean): void',
      'export function f(x: number = 1 > 0 ? 1 : 2): x is 1 { return (x as any) === 1 }',
    ].join('\n')
    // `1 > 0` is always true, so TCE drops `→ true` and `>` → `>=`: both minify to the original.
    expect(mutants(code)).toEqual([
      '6:31 Condition `1 > 0` → `false`',
      '6:54 FunctionBody body → `return`',
      '6:74 Equality `===` → `!==`',
    ])
  })
})

describe('equivalent-mutant filters', () => {
  test('skip known equivalents and noise', () => {
    const code = [
      'function f(x, s) {',
      '  console.log(x > 1, !x)',
      '  if (true) x = x * 1',
      '  if (s.length >= 0) x = !!x',
      '  return "n=" + x',
      '}',
    ].join('\n')
    expect(mutants(code)).toEqual([
      '1:18 FunctionBody body → `return`',
      '3:7 BooleanLiteral `true` → `false`',
      '4:7 Condition `s.length >= 0` → `false`',
      '4:16 ComparisonBoundary `>=` → `>`',
      '4:26 Negation `!!x` → `!x`',
    ])
  })
})

describe('suppressions', () => {
  test('parses operators and reason, and marks comments on changed lines as new', () => {
    const code = [
      'function f(a) {',
      '  // nyorori-ignore-next-line ComparisonBoundary, Equality -- boundary is unreachable',
      '  return a >= 1',
      '  /* nyorori-ignore-next-line Logical -- old */',
      '}',
    ].join('\n')
    const result = generate('f.ts', code, new Set([2, 3]), 1)
    expect(result.suppressions).toEqual([
      { file: 'f.ts', line: 2, targetLine: 3, operators: ['ComparisonBoundary', 'Equality'], reason: 'boundary is unreachable', isNew: true },
      { file: 'f.ts', line: 4, targetLine: 5, operators: ['Logical'], reason: 'old', isNew: false },
    ])
    expect(result.problems).toEqual([])
  })

  test('reports malformed comments and unknown operators', () => {
    const code = [
      '// nyorori-ignore-next-line ComparisonBoundary',
      '// nyorori-ignore-next-line Nope -- why',
      '// nyorori-ignore everything',
    ].join('\n')
    expect(generate('f.ts', code, all(code), 1).problems.map((p) => `${p.line} ${p.message}`)).toEqual([
      '1 Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
      '2 Unknown operator in suppression: Nope.',
      '3 Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
    ])
  })
})
