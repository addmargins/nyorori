import { describe, expect, test } from 'vitest'
import { generate, typeQuestions } from '../src/mutate/generate.ts'
import { addedLines, changes } from './changes.ts'

function all(code: string): Set<number> {
  return new Set(code.split('\n').map((_, i) => i + 1))
}

function mutants(code: string, changed = all(code), file = 'file.ts'): string[] {
  return generate(file, code, addedLines(code, changed), 1).mutants.map((m) => `${m.line}:${m.column} ${m.operator} ${m.description}`)
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

  test('CallUnwrap replaces a function call with the argument it passes on', () => {
    const code = [
      "import * as ns from './ns'",
      'export function f(a, x, key, o) {',
      '  const i = toInteger(x) + this.getValue(key, 1)',
      '  const n = Math.min(x, 1) + Number.parseInt(key, 10) + ns.parse(x)',
      '  const t = JSON.stringify(o) ?? normalize(x)?.n',
      '  if (check(true)) return [a(x, 1), i, n, t, Object.assign(o, { a }), make()(x)]',
      '}',
      'export class A extends B { m(x) { return super.m(x) + this.#parse(x) } #parse(x) { return x } }',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([
      '3:13 CallUnwrap `toInteger(x)` → `x`',
      // A method of the code's own class, like a plain function.
      '3:33 CallUnwrap `this.getValue(key, 1)` → `key`',
      // Static calls on a built-in or an imported namespace.
      '4:18 CallUnwrap `Math.min(x, 1)` → `x`',
      '4:37 CallUnwrap `Number.parseInt(key, 10)` → `key`',
      '4:60 CallUnwrap `ns.parse(x)` → `x`',
      '5:18 CallUnwrap `JSON.stringify(o)` → `o`',
      // Before the `?.`, cutting the chain there changes nothing.
      '5:34 CallUnwrap `normalize(x)` → `x`',
      '6:28 CallUnwrap `a(x, 1)` → `x`',
      '6:53 CallUnwrap `Object.assign(o, { a })` → `o`',
      // A function that a call returns is still a function.
      '6:71 CallUnwrap `make()(x)` → `x`',
      '8:48 CallUnwrap `super.m(x)` → `x`',
      '8:60 CallUnwrap `this.#parse(x)` → `x`',
    ])
    // `check(true)` → `true` is the Condition mutant already.
    expect(mutants(code, undefined, 'file.js').filter((m) => m.startsWith('6:7 '))).toEqual(['6:7 Condition `check(true)` → `true`', '6:7 Condition `check(true)` → `false`'])
  })

  test('CallUnwrap replaces a transform of a string or an array with its receiver', () => {
    const code = [
      'export function f(s, xs, o, re) {',
      "  const a = [s.trim(), s.toLowerCase(), s.replace(re, '-'), s.slice(1).padStart(4)]",
      '  const b = [xs.map(String), xs.filter((x) => x.ok), xs.toSorted(), [s].concat(...xs), this.items.flat()]',
      '  const c = [o?.map(f), o?.list.filter(Boolean), o.name?.trim(), o.list.slice?.(1)]',
      '  const t = o',
      '    .trim()',
      '  return [a, b, c, t]',
      '}',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([
      // The transform was not applied; calls without arguments too.
      '2:16 CallUnwrap `s.trim()` → `s`',
      '2:26 CallUnwrap `s.toLowerCase()` → `s`',
      "2:43 CallUnwrap `s.replace(re, '-')` → `s`",
      '2:72 CallUnwrap `s.slice(1).padStart(4)` → `s.slice(1)`',
      '2:63 CallUnwrap `s.slice(1)` → `s`',
      // With a callback or a spread too: only first arguments must be plain values.
      '3:17 CallUnwrap `xs.map(String)` → `xs`',
      '3:33 CallUnwrap `xs.filter((x) => x.ok)` → `xs`',
      '3:57 CallUnwrap `xs.toSorted()` → `xs`',
      '3:73 CallUnwrap `[s].concat(...xs)` → `[s]`',
      '3:99 CallUnwrap `this.items.flat()` → `this.items`',
      // The call ends the chain, so it stands for the whole chain, and the receiver is a chain of its own.
      '4:17 CallUnwrap `o?.map(f)` → `o`',
      '4:33 CallUnwrap `o?.list.filter(Boolean)` → `o?.list`',
      '4:58 CallUnwrap `o.name?.trim()` → `o.name`',
      '4:73 CallUnwrap `o.list.slice?.(1)` → `o.list`',
      // Anchored at the name, so a call added on its own line counts.
      '6:6 CallUnwrap `o.trim()` → `o`',
    ])
    expect(only('CallUnwrap', code, new Set([6]))).toEqual(['6:6 CallUnwrap `o.trim()` → `o`'])
  })

  test('CallUnwrap leaves out a copy that is only read and dropped', () => {
    const code = [
      'export function f(s, xs, o, g) {',
      '  const a = [xs.slice(), xs.slice(0), xs.concat(), s.slice()]',
      '  const b = [xs.slice().map(g), (xs.slice(0)).join(), xs.concat().indexOf(s), (o?.xs.slice()).filter(g)]',
      '  const c = [xs.slice().sort(), xs.slice().forEach(g), xs.slice(1).map(g)]',
      '  return [a, b, c]',
      '}',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([
      // Kept, returned or passed on, a copy is not the input: the caller may change it.
      '2:17 CallUnwrap `xs.slice()` → `xs`',
      '2:29 CallUnwrap `xs.slice(0)` → `xs`',
      '2:42 CallUnwrap `xs.concat()` → `xs`',
      '2:54 CallUnwrap `s.slice()` → `s`',
      // Read once and dropped, it reads the same as its receiver; the transforms on it keep theirs.
      '3:25 CallUnwrap `xs.slice().map(g)` → `xs.slice()`',
      '3:95 CallUnwrap `(o?.xs.slice()).filter(g)` → `(o?.xs.slice())`',
      // Sorted in place, or looped over by code that may change the original.
      '4:25 CallUnwrap `xs.slice().sort()` → `xs.slice()`',
      '4:17 CallUnwrap `xs.slice()` → `xs`',
      '4:36 CallUnwrap `xs.slice()` → `xs`',
      '4:68 CallUnwrap `xs.slice(1).map(g)` → `xs.slice(1)`',
      '4:59 CallUnwrap `xs.slice(1)` → `xs`',
    ])
  })

  test('CallUnwrap leaves predicates, lookups and other methods alone: either value would only have the wrong type', () => {
    const code = [
      "import path from 'node:path'",
      "import { posix } from 'node:path'",
      "const url = require('node:url')",
      'class Text { static trim(s) { return s } }',
      'export function f(set, xs, s, map, re, o) {',
      "  const a = [set.has(s), xs.includes(s), s.indexOf('('), map.get(s), xs.join(''), re.test(s), o.custom(s), s.split(','), xs[0](s)]",
      // Modules, classes and globals other than the built-in namespaces, whatever their methods are called.
      '  const b = [path.normalize(s), posix.normalize(s), url.format(s), Text.trim(s), Buffer.concat(xs), $.map(xs, String)]',
      '  return [a, b, Object.keys(o)]',
      '}',
      'export function g(Math, x) {',
      '  return Math.min(x, 1)',
      '}',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual(['8:24 CallUnwrap `Object.keys(o)` → `o`'])
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
      '  const r = [g(), g(...xs), Math.max(...xs), require("x"), import("x"), console.log(g(x))]',
      // Callbacks for the first argument, and receivers.
      '  const c = [useMemo(() => x, [x]), this.on(function (v) { return v }), o.f.call(o, x), o.f.apply(o, xs), o.f.bind(o), xs.map.call(o, g)]',
      // Called, constructed, tagged, deleted.
      '  const s = [g(x)(), new (g(x))(), g(x)`t`, delete g(x), xs.map(g)()]',
      // After a `?.` inside a chain: parentheses would cut the rest of the chain off.
      '  const t = [g?.(x).b, o?.list.map(g).length, o.a?.(x)?.trim().c]',
      // Values dropped: CallStatement removes these.
      '  g(x)',
      '  await g(x)',
      '  o?.a(x)',
      '  xs.sort()',
      '  return [r, c, s, t]',
      '}',
      'export const z = g(1)',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([])
  })

  test('CallUnwrap leaves a conversion that the code around it makes anyway', () => {
    const code = [
      'export async function f(x, y) {',
      // Used only for its truthiness: a test, the operand of `!`, and `&&` or `||` inside those.
      '  if (Boolean(x) || (y && !Boolean(y))) return',
      '  while ((Boolean(x))) x--',
      '  for (; Boolean(y);) y--',
      '  do x++; while (!(Boolean(x) && Boolean(y)))',
      '  const a = Boolean(x) ? y : x',
      // A template converts with ToString, as `String` does.
      '  const s = `${String(x)}-${(String(y))}`',
      // `await`, and an async function returning a value, resolve it as `Promise.resolve` does.
      '  const v = await Promise.resolve(x)',
      '  return (Promise.resolve([a, s, v]))',
      '}',
      'export const g = async (x) => Promise.resolve(x)',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([])
    // Not made at all. TCE dropped the `Boolean` ones before: the minifier reads `if (Boolean(x))` as `if (x)`.
    expect(generate('file.js', code, addedLines(code, all(code)), 1).equivalent).toEqual([])
  })

  test('CallUnwrap keeps a conversion whose value is used otherwise, or of a shadowed global', () => {
    const code = [
      'export async function f(x, y, tag) {',
      // Returned, kept by `??` (`x ?? y` is `y` when `x` is null), or stored by `&&`.
      '  if (Boolean(x) ?? y) return Boolean(x)',
      '  const b = Boolean(y) && x',
      // A tag gets the values themselves; `+` tries `valueOf` before `toString`.
      "  const s = [tag`${String(x)}`, '' + String(y)]",
      // Not awaited, or with a second argument that `await x` would not evaluate.
      '  const p = [Promise.resolve(x), await Promise.resolve(x, y)]',
      '  return [b, s, p]',
      '}',
      // Not async: the caller gets the promise itself.
      'export function g(x) {',
      '  return Promise.resolve(x)',
      '}',
    ].join('\n')
    expect(only('CallUnwrap', code)).toEqual([
      '2:7 CallUnwrap `Boolean(x)` → `x`',
      '2:31 CallUnwrap `Boolean(x)` → `x`',
      '3:13 CallUnwrap `Boolean(y)` → `y`',
      '4:20 CallUnwrap `String(x)` → `x`',
      '4:38 CallUnwrap `String(y)` → `y`',
      '5:22 CallUnwrap `Promise.resolve(x)` → `x`',
      '5:48 CallUnwrap `Promise.resolve(x, y)` → `x`',
      '9:18 CallUnwrap `Promise.resolve(x)` → `x`',
    ])
    // A name the code declares is its own function, whatever it does.
    const shadowed = [
      "import * as Promise from './promise'",
      'export async function f(x, Boolean, String) {',
      '  if (Boolean(x)) return `${String(x)}`',
      '  return Promise.resolve(x)',
      '}',
    ].join('\n')
    expect(only('CallUnwrap', shadowed)).toEqual([
      '3:7 CallUnwrap `Boolean(x)` → `x`',
      '3:29 CallUnwrap `String(x)` → `x`',
      '4:18 CallUnwrap `Promise.resolve(x)` → `x`',
    ])
  })

  test('call descriptions show the call around its callee, hiding a long receiver behind `…`', () => {
    const code = [
      'export function f(array, values, code, items, unescapedValues, match, options) {',
      '  const a = differenceToolkit(Array.from(array), values).map(normalizeZero)',
      "  const b = [toInteger(fromIndex), code?.replace(/_/g, '-'), items.map((item) => transform(item, options))]",
      '  unescapedValues.push([match.index, match[0].length, options.escapeValue])',
      '  return options.interpolation.escapeValue ?? options.escapeValue',
      '}',
    ].join('\n')
    expect(mutants(code, undefined, 'file.js').filter((m) => / Call| Logical `.* \?\? /.test(m))).toEqual([
      '2:58 CallUnwrap `….map(normalizeZero)` → `…`',
      '2:13 CallUnwrap `differenceToolkit(Array.from(array), v…)` → `Array.from(array)`',
      '2:37 CallUnwrap `Array.from(array)` → `array`',
      '3:14 CallUnwrap `toInteger(fromIndex)` → `fromIndex`',
      "3:42 CallUnwrap `code?.replace(/_/g, '-')` → `code`",
      // A short receiver stays, and the arguments are cut instead.
      '3:68 CallUnwrap `items.map((item) => transform(item, op…)` → `items`',
      '3:82 CallUnwrap `transform(item, options)` → `item`',
      '4:19 CallStatement `unescapedValues.push([match.index, mat…)` removed',
      // `??` likewise keeps the operator in view.
      '5:44 Logical `… ?? options.escapeValue` → `…`',
    ])
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
    const { sites } = generate('file.js', 'export function f(s) {\n  return /^/.test(s)\n}', addedLines('export function f(s) {\n  return /^/.test(s)\n}', [2]), 1)
    expect(sites.flatMap((site) => site.mutants.filter((m) => m.mutant.operator === 'Regex').map((m) => `${m.mutant.description}: ${m.replacement}`))).toEqual(['`^` removed: /(?:)/'])
  })

  test('leaves module-level code alone, like every operator', () => {
    expect(mutants('const RE = /^a/i\nexport function f(s) {\n  return RE.test(s)\n}', undefined, 'file.js').filter((m) => m.includes(' Regex '))).toEqual([])
  })
})

describe('Revert', () => {
  const changed = (before: string, after: string) =>
    generate('file.js', after, changes(before, after, 'file.js'), 1).mutants.map((m) => `${m.line}:${m.column} ${m.operator} ${m.description}`)

  test('puts back a number, bigint or regex literal that took the place of another', () => {
    const before = [
      'export function f(a, s, o) {',
      '  const limit = a.max || 1000',
      '  const big = 1n << 64n',
      '  const parts = s.split(/,/)',
      '  const on = o.on ?? false',
      '  const key = { 1: a, [2]: s }',
      '  return [limit, big, parts, on, key, 0x10]',
      '}',
    ].join('\n')
    const after = before.replace('1000', '500').replace('64n', '32n').replace('/,/', '/[,;]/g').replace('?? false', '?? true')
      .replace('1: a', '3: a').replace('[2]', '[4]').replace('0x10', '16')
    expect(changed(before, after)).toEqual([
      // `||` → `&&` is killed whatever the number is; only this says whether a test checks it.
      '2:23 Logical `||` → `&&`',
      '2:26 Revert `500` → `1000`, as before this PR',
      '3:21 Revert `32n` → `64n`, as before this PR',
      '4:26 Regex `[,;]` → `[^,;]`',
      '4:31 Regex `/…/g` → `/…/`',
      '4:25 Revert `/[,;]/g` → `/,/`, as before this PR',
      // The same as BooleanLiteral, which keeps it; a property name is not a value; `16` minifies like `0x10`.
      '5:19 Logical `o.on ?? true` → `o.on`',
      '5:22 BooleanLiteral `true` → `false`',
      '6:24 Revert `4` → `2`, as before this PR',
    ])
  })

  test('puts back a string or a template chunk, but not the text of an error or a log call', () => {
    const before = [
      'export function f(a, s) {',
      "  if (!a) throw new TypeError('Expected a function')",
      "  if (s === 'x') throw new Error(`bad ${s}: ` + (a ? 'one' : 'two'))",
      "  if (!s) return Promise.reject(createError('missing'))",
      "  logger.warn('deprecated')",
      "  return [s.split(','), `k=${a}`, s.padStart(2, '0')]",
      '}',
    ].join('\n')
    const after = before.replace('Expected a function', 'Expected a callback').replace('bad ${', 'invalid ${').replace("'one'", "'1'")
      .replace("'missing'", "'absent'").replace("'deprecated'", "'obsolete'").replace("split(',')", "split(';')").replace('`k=${', '`key=${')
      .replace("'0'", "' '")
    expect(changed(before, after).filter((m) => m.includes(' Revert '))).toEqual([
      "6:19 Revert `';'` → `','`, as before this PR",
      '6:25 Revert `key=` → `k=`, as before this PR',
      "6:51 Revert `' '` → `'0'`, as before this PR",
    ])
  })
})

describe('scope', () => {
  test('only mutates sites on changed lines', () => {
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

describe('scope of a change', () => {
  // What a branch that turns `before` into `after` gets mutated.
  const changed = (before: string, after: string) =>
    generate('file.ts', after, changes(before, after), 1).mutants.map((m) => `${m.line}:${m.column} ${m.operator} ${m.description}`)

  test('leaves alone an expression next to a replaced argument', () => {
    // es-toolkit PR 2047: `arr.length - 1` → `arr.length + 1` was an equivalent mutant of untouched code.
    const before = [
      'export function lastIndex(arr: number[], fromIndex: number): number {',
      '  if (fromIndex < 0) {',
      '    fromIndex = Math.max(arr.length + fromIndex, 0)',
      '  } else {',
      '    fromIndex = Math.min(fromIndex, arr.length - 1)',
      '  }',
      '  return fromIndex',
      '}',
    ].join('\n')
    const after = before
      .replace(' {\n  if', ' {\n  const index = toInteger(fromIndex)\n  if')
      .replace('arr.length + fromIndex', 'arr.length + index')
      .replace('Math.min(fromIndex', 'Math.min(index')
    expect(changed(before, after)).toEqual([
      '2:17 CallUnwrap `toInteger(fromIndex)` → `fromIndex`',
      '4:22 CallUnwrap `Math.max(arr.length + index, 0)` → `arr.length + index`',
      '4:37 Arithmetic `+` → `-`',
      // The call holds `index`; `arr.length - 1` does not.
      '6:22 CallUnwrap `Math.min(index, arr.length - 1)` → `index`',
    ])
  })

  test('mutates the expressions around a changed operand, wherever their anchors are', () => {
    const before = 'export function f(a: number, limit: number, max: number) {\n  if (a < limit) return 1\n  return (\n    a > 0 &&\n    a < limit\n  )\n}\n'
    expect(changed(before, before.replaceAll('a < limit', 'a < max'))).toEqual([
      '2:7 Condition `a < max` → `true`',
      '2:7 Condition `a < max` → `false`',
      '2:9 ComparisonBoundary `<` → `<=`',
      // Anchored on line 4, which did not change.
      '4:11 Logical `&&` → `||`',
      '5:7 ComparisonBoundary `<` → `<=`',
    ])
    // Deleting an operand changes the expressions around the place.
    expect(changed('export function f(a, b, c) {\n  if (a && b && c) return 1\n}\n', 'export function f(a, b, c) {\n  if (a && c) return 1\n}\n')).toEqual([
      '2:7 Condition `a && c` → `true`',
      '2:7 Condition `a && c` → `false`',
      '2:9 Logical `&&` → `||`',
    ])
  })

  test('mutates an expression that lost its first or last operand, like one that lost a middle one', () => {
    const before = 'export function chunk(arr: number[], size: number) {\n  if (size <= 0 || !Number.isInteger(size)) {\n    throw new Error()\n  }\n  return arr.filter((x) => x > 0 && x < size)\n}\n'
    expect(changed(before, before.replace(' || !Number.isInteger(size)', '').replace(' && x < size', ''))).toEqual([
      '2:7 Condition `size <= 0` → `true`',
      '2:7 Condition `size <= 0` → `false`',
      '2:12 ComparisonBoundary `<=` → `<`',
      // The arrow function's body is what lost it.
      '5:14 CallUnwrap `arr.filter((x) => x > 0)` → `arr`',
      '5:28 FunctionBody `=> x > 0` → `=> undefined`',
      '5:30 ComparisonBoundary `>` → `>=`',
    ])
    expect(changed(before, before.replace('size <= 0 || ', ''))).toEqual([
      '2:7 Condition `!Number.isInteger(size)` → `true`',
      '2:7 Condition `!Number.isInteger(size)` → `false`',
      '2:7 Negation `!Number.isInteger(size)` → `Number.isInteger(size)`',
    ])
    // A statement deleted next to an expression took nothing from it.
    expect(changed('export function f(a: number) {\n  g(a)\n  return a > 0\n}\n', 'export function f(a: number) {\n  return a > 0\n}\n')).toEqual([])
  })

  test('mutates nothing in a reformatted function', () => {
    const before = 'export function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; return x > hi ? hi : x }\n'
    const after = 'export function clamp(x: number, lo: number, hi: number): number {\n  if (x < lo) {\n    return lo;\n  }\n  return x > hi\n    ? hi\n    : x;\n}\n'
    expect(changed(before, after)).toEqual([])
  })

  test('mutates nothing for an edit of types alone', () => {
    // es-toolkit case: `any` → `unknown`, casts that need parentheses, another return type.
    const before = 'export function compare(a: any, b: any): number {\n  if (a < b) {\n    return -1\n  }\n  return 0\n}\n'
    const after = 'export function compare(a: unknown, b: unknown): -1 | 0 {\n  if ((a as number) < (b as number)) {\n    return -1\n  }\n  return 0\n}\n'
    expect(changed(before, after)).toEqual([])
    expect(changed(before, after.replace(') < (', ') <= ('))).toEqual([
      '2:7 Condition `(a as number) <= (b as number)` → `true`',
      '2:7 Condition `(a as number) <= (b as number)` → `false`',
      '2:21 ComparisonBoundary `<=` → `<`',
    ])
  })

  test('mutates all of a new function, its body included', () => {
    const before = 'export function one(): number {\n  return 1\n}\n'
    const added = 'export function isEven(n: number): boolean {\n  return n % 2 === 0\n}\n'
    const mutated = changed(before, `${before}\n${added}`)
    expect(mutated).toEqual([
      '5:44 FunctionBody body → `return`',
      '6:16 Equality `===` → `!==`',
      '6:12 Arithmetic `%` → `*`',
    ])
    // The same as when every line of it counts as changed, four lines down.
    expect(mutants(added).map((m) => m.replace(/^\d+/, (line) => String(Number(line) + 4)))).toEqual(mutated)
  })

  test('mutates a function body when the header changed, a method name included', () => {
    const before = 'export class A {\n  get size() {\n    return this.n + 1\n  }\n  f(a) {\n    return a > 1\n  }\n}\n'
    expect(changed(before, before.replace('size', 'length').replace('f(a)', 'f(a, b)').replace('a > 1', 'a > 2'))).toEqual([
      '2:16 FunctionBody body → `return`',
      '5:11 FunctionBody body → `return`',
      '6:14 ComparisonBoundary `>` → `>=`',
      '6:16 Revert `2` → `1`, as before this PR',
    ])
    // Only the body changed: the body site stays out.
    expect(changed(before, before.replace('a > 1', 'a > 2'))).toEqual(['6:14 ComparisonBoundary `>` → `>=`', '6:16 Revert `2` → `1`, as before this PR'])
  })

  test('leaves the call around a callback whose block body changed to the callback', () => {
    const before = 'export function f(xs) {\n  xs.forEach((x) => {\n    a(x)\n  })\n  xs.forEach((x) => a(x))\n  return xs.some((x) => x.done)\n}\n'
    const after = before.replaceAll('a(x)', 'b(x)').replace('x.done', 'x.ok')
    expect(changed(before, after)).toEqual([
      '3:5 CallStatement `b(x)` removed',
      // An expression body is part of the expression around it.
      '5:6 CallStatement `xs.forEach((x) => b(x))` removed',
      '5:21 FunctionBody `=> b(x)` → `=> undefined`',
      '5:21 CallUnwrap `b(x)` → `x`',
      '6:25 FunctionBody `=> x.ok` → `=> undefined`',
    ])
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

describe('log filter', () => {
  // Line 2 always holds the call.
  const onCall = (call: string) => mutants(['export class C { #logger; async f(a) {', `  ${call}`, '} }'].join('\n')).filter((m) => m.startsWith('2:'))

  test.each([
    'logger.warn(a > 1)',
    'this.logger.log(a > 1)',
    'ctx.log.error(a > 1)',
    'this._logger.debug(a > 1)',
    'this.#logger.info(a > 1)',
    'baseLogger.info(a > 1)',
    'return logger.warn(a > 1)',
    'await log.info(a > 1)',
    // Metrics and tracing calls only where their value is dropped.
    'metrics.increment(a > 1)',
    'await this.statsd.timing(a > 1)',
    'requestTracer.recordException(a > 1)',
  ])('skips `%s` and its arguments', (call) => {
    expect(onCall(call)).toEqual([])
  })

  test.each([
    // The `?.` keeps a missing logger from throwing.
    ['this.logger?.warn(a > 1)', ['2:14 OptionalChaining `?.` → `.`']],
    // A logger's other methods do things, and so may a level on something else.
    ['logger.create(a > 1)', ['2:10 CallStatement `logger.create(a > 1)` removed', '2:19 ComparisonBoundary `>` → `>=`']],
    ['this.error(a > 1)', ['2:8 CallStatement `this.error(a > 1)` removed', '2:16 ComparisonBoundary `>` → `>=`']],
    ['auditLog.info(a > 1)', ['2:12 CallStatement `auditLog.info(a > 1)` removed', '2:19 ComparisonBoundary `>` → `>=`']],
    // A `log` that is not a logger.
    ['this.entries.log.push(a > 1)', ['2:20 CallStatement `this.entries.log.push(a > 1)` removed', '2:27 ComparisonBoundary `>` → `>=`']],
    // A recording whose value is used, and a `span` that may be a DOM element.
    ['return metrics.increment(a > 1)', ['2:30 ComparisonBoundary `>` → `>=`']],
    ['span.setAttribute(a > 1)', ['2:8 CallStatement `span.setAttribute(a > 1)` removed', '2:23 ComparisonBoundary `>` → `>=`']],
    // A timer's callback is what the code does.
    ['setTimeout(() => g(a > 1))', [
      '2:3 CallStatement `setTimeout(() => g(a > 1))` removed',
      '2:20 FunctionBody `=> g(a > 1)` → `=> undefined`',
      '2:20 CallUnwrap `g(a > 1)` → `a > 1`',
      '2:24 ComparisonBoundary `>` → `>=`',
    ]],
  ])('mutates `%s`', (call, expected) => {
    expect(onCall(call)).toEqual(expected)
  })

  // Lines 2 to 6 only log.
  const guards = [
    'export class C { #logger; async f(a, b) {',
    '  if (a > 1) this.logger.warn(a)',
    '  if (a > 2) { logger.warn(a); } else if (b) { console.log(b) } else {}',
    "  if (a > 3) { if (b > 1) log.info(b); metrics.increment('x'); ; }",
    '  a > 4 && logger.warn(a)',
    '  b ? logger.warn(a) : await log.info(b)',
    // A branch that does something else, a `?.` that keeps a missing logger from throwing.
    '  if (a > 5) { logger.warn(a); return }',
    '  if (a > 6) this.logger?.warn(a)',
    '  if (a > 7) logger.warn(a); else g(a)',
    '} }',
  ].join('\n')
  const notGuards = [
    '7:7 Condition `a > 5` → `true`',
    '7:7 Condition `a > 5` → `false`',
    '7:9 ComparisonBoundary `>` → `>=`',
    '8:7 Condition `a > 6` → `true`',
    '8:7 Condition `a > 6` → `false`',
    '8:9 ComparisonBoundary `>` → `>=`',
    '8:25 OptionalChaining `?.` → `.`',
    '9:7 Condition `a > 7` → `true`',
    '9:7 Condition `a > 7` → `false`',
    '9:9 ComparisonBoundary `>` → `>=`',
    '9:35 CallStatement `g(a)` removed',
  ]

  test('skips all of an `if` that only logs, its test included, and the same guard as an expression', () => {
    expect(mutants(guards).filter((m) => !m.startsWith('1:'))).toEqual(notGuards)
  })

  test('with logGuards, mutates the `if` that only logs and the same guard as an expression, but still not the log calls', () => {
    const { mutants } = generate('file.ts', guards, addedLines(guards, all(guards)), 1, undefined, { logGuards: true })
    expect(mutants.map((m) => `${m.line}:${m.column} ${m.operator} ${m.description}`).filter((m) => !m.startsWith('1:'))).toEqual([
      '2:7 Condition `a > 1` → `true`',
      '2:7 Condition `a > 1` → `false`',
      '2:9 ComparisonBoundary `>` → `>=`',
      '3:7 Condition `a > 2` → `true`',
      '3:7 Condition `a > 2` → `false`',
      '3:9 ComparisonBoundary `>` → `>=`',
      '3:43 Condition `b` → `true`',
      '3:43 Condition `b` → `false`',
      '4:7 Condition `a > 3` → `true`',
      '4:7 Condition `a > 3` → `false`',
      '4:9 ComparisonBoundary `>` → `>=`',
      '4:20 Condition `b > 1` → `true`',
      '4:20 Condition `b > 1` → `false`',
      '4:22 ComparisonBoundary `>` → `>=`',
      '5:9 Logical `&&` → `||`',
      '5:5 ComparisonBoundary `>` → `>=`',
      '6:3 Condition `b` → `true`',
      '6:3 Condition `b` → `false`',
      ...notGuards,
    ])
  })

  test('asks the type checker about a `+` in a log guard only when the guard is mutated', () => {
    const code = 'export function f(a: number, b: number) {\n  if (a + b > 1) logger.warn(a)\n}\n'
    const changes = addedLines(code, [2])
    expect(typeQuestions('f.ts', code, changes).plus).toEqual([])
    expect(typeQuestions('f.ts', code, changes, { logGuards: true }).plus).toHaveLength(1)
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
    const result = generate('f.ts', code, addedLines(code, [2, 3]), 1)
    expect(result.suppressions).toEqual([
      { file: 'f.ts', line: 2, targetLine: 3, operators: ['ComparisonBoundary', 'Equality'], reason: 'boundary is unreachable', isNew: true },
      { file: 'f.ts', line: 4, targetLine: 5, operators: ['Logical'], reason: 'old', isNew: false },
    ])
    expect(result.problems).toEqual([])
  })

  test('sets apart new suppressions of lines the branch only reformatted', () => {
    const before = 'export function f(a) {\n  // nyorori-ignore-next-line ComparisonBoundary -- callers check\n  return a > 1\n}\n'
    // Re-indented, the comment is on a changed line, so it is new; but no mutant of the line it targets is in scope.
    const indented = before.replaceAll('\n  ', '\n    ')
    const result = generate('f.ts', indented, changes(before, indented), 1)
    expect(result.mutants).toEqual([])
    expect(result.suppressions).toMatchObject([{ line: 2, targetLine: 3, isNew: true }])
    expect(result.reformatted).toEqual(result.suppressions)
    // When the code it targets changed, a suppression that matches nothing there is stale.
    const edited = indented.replace('a > 1', 'a + 1')
    expect(generate('f.ts', edited, changes(before, edited), 1).reformatted).toEqual([])
  })

  test('accepts the call and regex operators', () => {
    const code = [
      'function f(s) {',
      '  // nyorori-ignore-next-line CallUnwrap, CallStatement, Regex -- logging only',
      '  log(trim(s), /a/i)',
      '}',
    ].join('\n')
    const result = generate('f.js', code, addedLines(code, all(code)), 1)
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
    expect(generate('f.ts', code, addedLines(code, all(code)), 1).problems.map((p) => `${p.line} ${p.message}`)).toEqual([
      '1 Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
      '2 Unknown operator in suppression: Nope.',
      '3 Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
    ])
  })
})
