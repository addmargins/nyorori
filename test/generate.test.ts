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

describe('calls', () => {
  const only = (operator: string, code: string, changed?: Set<number>) =>
    mutants(code, changed, 'file.js').filter((m) => m.includes(` ${operator} `))

  test('CallUnwrap replaces a call with its first argument, function and method calls alike', () => {
    const code = [
      'export function f(a, x, key, o, s) {',
      '  const i = toInteger(x) + o.get(key, 1)',
      '  const n = o?.size(x) ?? normalize(x)?.n',
      '  const t = o',
      '    .trim(s)',
      '  if (check(true)) return [a(x, 1), i, n, t]',
      '}',
      'export class A extends B { m(x) { return super.m(x) } }',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([
      '2:13 CallUnwrap `toInteger(x)` → `x`',
      '2:30 CallUnwrap `o.get(key, 1)` → `key`',
      // The call ends the chain, so it stands for the whole chain.
      '3:16 CallUnwrap `o?.size(x)` → `x`',
      // Before the `?.`, cutting the chain there changes nothing.
      '3:27 CallUnwrap `normalize(x)` → `x`',
      // Anchored at the name, so a call added on its own line counts.
      '5:6 CallUnwrap `o .trim(s)` → `s`',
      '6:28 CallUnwrap `a(x, 1)` → `x`',
      '8:48 CallUnwrap `super.m(x)` → `x`',
    ])
    // `check(true)` → `true` is the Condition mutant already.
    expect(mutants(code, undefined, 'file.js').filter((m) => m.startsWith('6:7'))).toEqual(['6:7 Condition `check(true)` → `true`', '6:7 Condition `check(true)` → `false`'])
    expect(only('CallUnwrap', code, new Set([5]))).toEqual(['5:6 CallUnwrap `o .trim(s)` → `s`'])
  })

  test('CallUnwrap leaves calls whose unwrapping says nothing or breaks the code', () => {
    const code = [
      'export class A extends B {',
      '  constructor(x) {',
      '    const y = super(x)',
      '  }',
      '}',
      'export async function f(x, xs, o) {',
      // No argument to unwrap to, or not a plain one; and what console logs.
      '  const r = [g(), g(...xs), require("x"), import("x"), console.log(g(x))]',
      // Callbacks, and receivers.
      '  const c = [xs.map((v) => v + 1), xs.find(function (v) { return v }), o.f.call(o, x), o.f.apply(o, xs), o.f.bind(o)]',
      // Called, constructed, tagged, deleted.
      '  const s = [g(x)(), new (g(x))(), g(x)`t`, delete g(x)]',
      // After a `?.` inside a chain: parentheses would cut the rest of the chain off.
      '  const t = [o?.a(x).b, o.a?.(x)?.b(x).c]',
      // Values dropped: CallStatement removes these.
      '  g(x)',
      '  await g(x)',
      '  o?.a(x)',
      '  return [r, c, s, t]',
      '}',
      'export const z = g(1)',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([])
  })

  test('CallStatement removes a call whose value the statement drops', () => {
    const code = [
      'export class A extends B {',
      '  constructor(x) {',
      '    super(x)',
      '    super.init(x)',
      '  }',
      '}',
      'export async function f(unmatched, key, o) {',
      '  unmatched.delete(key)',
      '  await o.save(key)',
      '  o.on?.(key);',
      '  (o.off(key))',
      '  console.log(key)',
      '  o.x = g(key)',
      '  key++',
      '  o.ok && o.done()',
      '  void o.done()',
      '}',
      'init()',
    ].join('\n')
    expect(only('CallStatement', code)).toEqual([
      // `super(x)` has to stay, or the constructor throws on `this`.
      '4:11 CallStatement `super.init(x)` removed',
      '8:13 CallStatement `unmatched.delete(key)` removed',
      '9:11 CallStatement `o.save(key)` removed',
      '10:5 CallStatement `o.on?.(key)` removed',
      '11:6 CallStatement `o.off(key)` removed',
    ])
    // Its value is dropped, so the call is not unwrapped too.
    expect(only('CallUnwrap', code)).toEqual(['13:9 CallUnwrap `g(key)` → `key`'])
  })
})

describe('Regex', () => {
  const regex = (literal: string) => mutants(`export function f(s) {\n  return ${literal}.test(s)\n}`, undefined, 'file.js')
    .filter((m) => m.includes(' Regex '))
    .map((m) => m.slice(m.indexOf('Regex ') + 6))

  test('removes each flag, each top-level anchor, and negates each class and shorthand', () => {
    expect(regex('/^a[bc]\\d[^\\s-]$/gim')).toEqual([
      '`^` removed',
      '`[bc]` → `[^bc]`',
      '`\\d` → `\\D`',
      '`[^\\s-]` → `[\\s-]`',
      '`\\s` → `\\S`',
      '`$` removed',
      '`/…/gim` → `/…/im`',
      '`/…/gim` → `/…/gm`',
      '`/…/gim` → `/…/gi`',
    ])
    expect(mutants('export function f(s) {\n  return /^a\\W/u.test(s)\n}', undefined, 'file.js').filter((m) => m.includes(' Regex '))).toEqual([
      '2:11 Regex `^` removed',
      '2:13 Regex `\\W` → `\\w`',
      '2:16 Regex `/…/u` → `/…/`',
    ])
  })

  test('reads escapes, groups and classes the way the engine does', () => {
    // Escaped: no class, no anchor. In a group: not top-level. Inside a class: a literal `[`, `^` or `$`.
    expect(regex('/\\[a\\]\\^(^b|c$)\\\\$/')).toEqual(['`$` removed'])
    expect(regex('/[[^$]x/')).toEqual(['`[[^$]` → `[^[^$]`'])
    expect(regex('/a[]b[^]/')).toEqual(['`[]` → `[^]`', '`[^]` → `[]`'])
    // With `v`, classes nest; only the outer one is negated.
    expect(regex('/[\\w&&[^a]]/v')).toEqual(['`[\\w&&[^a]]` → `[^\\w&&[^a]]`', '`\\w` → `\\W`', '`/…/v` → `/…/`'])
  })

  test('drops what changes nothing, and what would not compile', () => {
    // `m` reads only `^` and `$`, `s` only `.`.
    expect(regex('/a,b/ms')).toEqual([])
    expect(regex('/^a.b/ms')).toEqual(['`^` removed', '`/…/ms` → `/…/s`', '`/…/ms` → `/…/m`'])
    // Without `v` the class has a range out of order; with a string in it, it cannot be negated.
    expect(regex('/[\\p{L}--[a-z]]/v')).toEqual(['`[\\p{L}--[a-z]]` → `[^\\p{L}--[a-z]]`'])
    expect(regex('/[\\q{ab}c]/v')).toEqual(['`/…/v` → `/…/`'])
    // Out of order: oxc parses it, but no engine compiles it, so nothing is mutated.
    expect(regex('/[bc]{2,1}/')).toEqual([])
    // An emptied pattern is `(?:)`, not the comment `//`.
    const { sites } = generate('file.js', 'export function f(s) {\n  return /^/.test(s)\n}', new Set([2]), 1)
    expect(sites.flatMap((site) => site.mutants.filter((m) => m.mutant.operator === 'Regex').map((m) => `${m.mutant.description}: ${m.replacement}`))).toEqual(['`^` removed: /(?:)/'])
  })

  test('leaves module-level code alone, like every operator', () => {
    expect(mutants('const RE = /^a/i\nexport function f(s) {\n  return RE.test(s)\n}', undefined, 'file.js').filter((m) => m.includes(' Regex '))).toEqual([])
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

  test('skips type arguments, decorators, abstract members and overload signatures', () => {
    // Each `true`/`false` and `!x` here is a type or a decorator; only the method body runs, and its call.
    const code = [
      'export abstract class A<T extends true = true> implements I<false> {',
      '  @dec(!x) declare p: true',
      '  abstract m(x: true): false',
      '  o(a: true): void',
      '  o(a: any): boolean { return f<true>(a satisfies false) as true }',
      '}',
    ].join('\n')
    expect(mutants(code)).toEqual(['5:22 FunctionBody body → `return`', '5:31 CallUnwrap `f<true>(a satisfies false)` → `a satisfies false`'])
  })
})

describe('console filter', () => {
  // Line 2 always holds the call; the other lines decide what `console` refers to.
  const call = '  console.log(a > 1)'
  const onCall = (lines: string[]) => mutants(lines.join('\n')).filter((m) => m.startsWith('2:'))

  test.each([
    ['the global console', ['export function f(a) {', call, '}']],
    ['a console declared only in another function', ['function g(console) {} export function f(a) {', call, '}']],
    ['an ambient console declaration', ['declare const console: { log(x: boolean): void }; export function f(a) {', call, '}']],
    ['a type-only import', ["import type console from './logger'; export function f(a) {", call, '}']],
  ])('skips arguments of %s', (_, lines) => {
    expect(onCall(lines)).toEqual([])
  })

  test.each([
    ['a parameter', ['export function f(console, a) {', call, '}']],
    ['a local const', ['export function f(a) { const console = make()', call, '}']],
    ['a var declared after the call', ['export function f(a) {', call, '  var console = make()', '}']],
    ['a function declared after the call', ['export function f(a) {', call, '  function console() {}', '}']],
    ['a module-level const declared below', ['export function f(a) {', call, '}', 'const console = make()']],
    ['an import', ["import console from './logger'; export function f(a) {", call, '}']],
  ])('mutates the call and its arguments when console is %s', (_, lines) => {
    expect(onCall(lines)).toEqual(['2:11 CallStatement `console.log(a > 1)` removed', '2:17 ComparisonBoundary `>` → `>=`'])
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

describe('arithmetic identities', () => {
  test('`x * 1n` and `x / 1n` are left alone like `x * 1`: the same bigint, or the same TypeError', () => {
    const code = ['function f(x) {', '  return [x * 1n, x / 0x1n, x * 2n, x / 1]', '}'].join('\n')
    expect(mutants(code).filter((m) => m.includes('Arithmetic'))).toEqual(['2:31 Arithmetic `*` → `/`'])
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

  test('accepts the call and regex operators', () => {
    const code = [
      'function f(s) {',
      '  // nyorori-ignore-next-line CallUnwrap, CallStatement, Regex -- logging only',
      '  log(trim(s), /a/i)',
      '}',
    ].join('\n')
    const result = generate('f.js', code, all(code), 1)
    expect(result.problems).toEqual([])
    expect(result.suppressions.map((s) => s.operators)).toEqual([['CallUnwrap', 'CallStatement', 'Regex']])
    expect(result.mutants.filter((m) => m.line === 3).map((m) => m.operator)).toEqual(['CallStatement', 'CallUnwrap', 'Regex'])
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
