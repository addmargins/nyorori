import { describe, expect, test, vi } from 'vitest'
import { generate } from '../src/mutate/generate.ts'
import type { PlusKind, TypeOracle } from '../src/mutate/typecheck.ts'

/**
 * The lines whose `+` generate() mutates; every line counts as changed. Mutants
 * that TCE drops count too: once an import keeps the minified module from being
 * empty, the unused functions here minify away with all their mutants.
 */
function mutated(lines: string[], file = 'f.ts', types?: TypeOracle): string[] {
  const { mutants, equivalent } = generate(file, lines.join('\n'), new Set(lines.map((_, i) => i + 1)), 1, types)
  return [...mutants, ...equivalent]
    .filter((m) => m.description === '`+` → `-`')
    .map((m) => lines[m.line - 1]!.trim())
}

const oracle = (answer: PlusKind): TypeOracle => ({ plus: vi.fn(() => answer) })

describe('without types, the syntax leaves a `+` alone when an operand is certainly a string', () => {
  test.each([
    ['a string literal', ["function f(n) { return 'n=' + n }"]],
    ['a template literal', ['function f(a, n) { return `<${a}>` + n }']],
    // The outer `+` has no literal operand of its own.
    ['a `+` with a string operand', ["function f(a, n) { return 'a' + a + n }"]],
    ['typeof', ['function f(a, n) { return typeof a + n }']],
    ['the global String()', ['function f(a, n) { return String(a) + n }']],
    ['encodeURIComponent()', ['function f(a, n) { return encodeURIComponent(a) + n }']],
    ['String.fromCharCode()', ['function f(a, n) { return String.fromCharCode(a) + n }']],
    ['string methods on a string', ['function f(a, n) { return String(a).trim().slice(1) + n }']],
    ['a conditional with string branches', ["function f(c, n) { return (c ? 'a' : `b`) + n }"]],
    ['a logical expression of strings', ['function f(a: string, b: string, n: number) { return (a || b) + n }']],
    ['a type assertion of a string', ["function f(n: number) { return ('a' as any) + n }"]],
    ['join() on an array literal', ["function f(a, n) { return [a, n].join('-') + n }"]],
    ['join() on the copy of an Object.keys() array', ['function f(o, n) { return Object.keys(o).filter(Boolean).join() + n }']],
    ['join() on the parts of a string', ["function f(a, n) { return String(a).split(',').join(';') + n }"]],
    ['a const initialised with a string', ['function f(a, n) {', '  const s = `<${a}>`', '  return s + n', '}']],
    ['a const annotated with less than its initialiser says', ['function f(a, n) {', '  const s: unknown = String(a)', '  return s + n', '}']],
    ['a const of a module-level const', ["const PREFIX = 'id-'", 'function f(n) {', '  const s = PREFIX', '  return s + n', '}']],
    ['a const declared below its use', ['function f(n) {', '  return s + n', '}', "const s = 'a'"]],
    ['join() on a const array', ['function f(a, n) {', '  const parts = []', '  parts.push(a)', "  return parts.join('/') + n", '}']],
    ['a const in JavaScript', ['function f(a, n) {', '  const s = String(a)', '  return s + n', '}'], 'f.js'],
    ['a string parameter', ['function f(s: string, n: number) { return s + n }']],
    ['a string parameter with a default', ["function f(n: number, s: string = 'x') { return s + n }"]],
    ['a parameter of string literal types', ["function f(s: 'a' | 'b', n: number) { return s + n }"]],
    ['a parameter of a template literal type', ['function f(s: `id-${number}`, n: number) { return s + n }']],
    ['a branded string parameter', ['function f(s: string & { brand: 1 }, n: number) { return s + n }']],
    ['a parameter property', ['class A { v: string; constructor(private s: string, n: number) { this.v = s + n } }']],
    ['a string method on a string parameter', ['function f(s: string, n: number) { return s.toUpperCase() + n }']],
    ['join() on an array parameter', ['function f(xs: number[], n: number) { return xs.join() + n }']],
    ['a let annotated as a string, though reassigned', ['function f(g: () => string, n: number) {', "  let s: string = 'a'", '  s = g()', '  return s + n', '}']],
  ])('%s', (_, lines, file = 'f.ts') => {
    expect(mutated(lines, file)).toEqual([])
  })
})

describe('without types, the syntax mutates a `+` whose operands may not be strings', () => {
  test.each([
    ['a parameter without an annotation', ['function f(s, n) {', '  return s + n', '}'], 'f.js'],
    ['an optional string parameter', ['function f(n: number, s?: string) {', '  return s + n', '}']],
    ['a parameter that may be undefined', ['function f(s: string | undefined, n: number) {', '  return s + n', '}']],
    ['an any parameter', ['function f(s: any, n: number) {', '  return s + n', '}']],
    ['a destructured parameter', ['function f({ s }: { s: string }, n: number) {', '  return s + n', '}']],
    ['a String parameter', ['function f(String, a, n) {', '  return String(a) + n', '}']],
    ['a String function declared below', ['function f(a, n) {', '  return String(a) + n', '}', 'function String(x) { return x }']],
    ['an imported String', ["import { String } from './string'", 'function f(a, n) {', '  return String(a) + n', '}']],
    ['a reassigned let', ['function f(g, n) {', "  let s = 'a'", '  s = g()', '  return s + n', '}']],
    // Only `const` keeps its initialiser's value for certain.
    ['a var', ['function f(n) {', "  var s = 'a'", '  return s + n', '}']],
    ['a const initialised with a call', ['function f(g, n) {', '  const s = g()', '  return s + n', '}']],
    ['a const shadowed by a parameter', ["const s = 'a'", 'function f(s, n) {', '  return s + n', '}']],
    ['a const inside another block', ['function f(s, n) {', "  { const s = 'a' }", '  return s + n', '}']],
    // `name` in the initialiser is the global, not the parameter of the same name.
    ['a const whose initialiser names something else where it stands', ['const s = name', 'function f(name: string, n: number) {', '  return s + n', '}']],
    ['toString() on an unknown receiver', ['function f(o, n) {', '  return o.toString() + n', '}']],
    ['toFixed() on an unknown receiver', ['function f(o, n) {', '  return o.toFixed(1) + n', '}']],
    ['join() on an unknown receiver', ['function f(o, n) {', '  return o.join() + n', '}']],
    ['at() on a string, which may give undefined', ['function f(s: string, n: number) {', '  return s.at(0) + n', '}']],
    ['JSON.stringify(), which may give undefined', ['function f(o, n) {', '  return JSON.stringify(o) + n', '}']],
    ['a type assertion to string', ['function f(x: string | number, n: number) {', '  return (x as string) + n', '}']],
    ['an optional chain on a value that may be undefined', ['function f(s: string | undefined, n: number) {', '  return s?.trim() + n', '}']],
    ['a logical expression with an unknown side', ['function f(s, n) {', "  return (s || 'x') + n", '}']],
    ['constants defined by each other', ['function f(n) {', '  const a = b', '  const b = a', '  return a + n', '}']],
  ])('%s', (_, lines, file = 'f.ts') => {
    expect(mutated(lines, file)).toEqual([lines.find((line) => line.includes(' + '))!.trim()])
  })
})

describe('with a type oracle', () => {
  const annotated = ['function f(s: string, n: number) {', '  return s + n', '}']

  test('its answer wins over the syntax', () => {
    expect(mutated(annotated, 'f.ts', oracle('numeric'))).toEqual(['return s + n'])
    expect(mutated(['function f(s, n) {', '  return s + n', '}'], 'f.ts', oracle('string'))).toEqual([])
  })

  test('the syntax decides where it does not know', () => {
    expect(mutated(annotated, 'f.ts', oracle('unknown'))).toEqual([])
  })

  test('is not asked about a string literal operand, or a `+` off the changed lines', () => {
    const types = oracle('numeric')
    const code = "function f(s, n) {\n  return 'a' + n\n  return s + n\n}"
    generate('f.ts', code, new Set([1, 2]), 1, types)
    expect(types.plus).not.toHaveBeenCalled()
  })
})
