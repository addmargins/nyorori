import { describe, expect, test } from 'vitest'
import { normalize } from '../src/mutate/equivalent.ts'
import { generate } from '../src/mutate/generate.ts'
import type { EquivalentMutant } from '../src/types.ts'
import { addedLines } from './changes.ts'

function all(code: string): Set<number> {
  return new Set(code.split('\n').map((_, i) => i + 1))
}

const label = (m: EquivalentMutant) => `${m.line} ${m.operator} ${m.description}`

function split(code: string, file = 'file.js'): { kept: string[]; equivalent: string[] } {
  const result = generate(file, code, addedLines(code, all(code)), 1)
  return { kept: result.mutants.map(label), equivalent: result.equivalent.map(label) }
}

describe('TCE drops mutants that minify to the original', () => {
  test('in a dead branch', () => {
    const code = ['export function f(i) {', '  if (false) { i++ }', '  return i', '}'].join('\n')
    expect(split(code)).toEqual({
      kept: ['1 FunctionBody body → `return`', '2 BooleanLiteral `false` → `true`'],
      equivalent: ['2 Update `++` → `--`'],
    })
  })

  test('behind a module-level constant flag', () => {
    const code = ['const DEBUG = false', '', 'export function f(i) {', '  if (DEBUG) { i++ }', '  return i', '}'].join('\n')
    expect(split(code)).toEqual({
      kept: ['3 FunctionBody body → `return`', '4 Condition `DEBUG` → `true`'],
      equivalent: ['4 Condition `DEBUG` → `false`', '4 Update `++` → `--`'],
    })
  })

  test('after a return', () => {
    // Without a semicolon, a `(` around the mutant would read as `return i(i--)`.
    const code = ['export function f(i) {', '  return i', '  i++', '}'].join('\n')
    expect(split(code)).toEqual({ kept: ['1 FunctionBody body → `return`'], equivalent: ['3 Update `++` → `--`'] })
  })

  test('for calls and regular expressions too', () => {
    // The minifier drops a pure call whose value goes unused, so removing it changes nothing.
    const code = ['export function f(x, s) {', '  Math.abs(x)', '  if (false) return /a/i.test(s)', '  return g(x)', '}'].join('\n')
    expect(split(code)).toEqual({
      kept: ['1 FunctionBody body → `return`', '3 BooleanLiteral `false` → `true`', '4 CallUnwrap `g(x)` → `x`'],
      equivalent: ['2 CallStatement `Math.abs(x)` removed', '3 CallUnwrap `/a/i.test(s)` → `s`', '3 Regex `/…/i` → `/…/`'],
    })
  })

  test('removes emptied sites and keeps ids contiguous per site', () => {
    const code = ['const DEBUG = false', 'export function f(i) {', '  if (DEBUG) { i++ }', '  return i > 0 ? i : -i', '}'].join('\n')
    const result = generate('file.js', code, addedLines(code, all(code)), 7)
    expect(result.equivalent.map(label)).toEqual(['3 Condition `DEBUG` → `false`', '3 Update `++` → `--`'])
    expect(result.equivalent[0]).not.toHaveProperty('id')
    expect(result.mutants.map((m) => m.id)).toEqual([7, 8, 9, 10, 11, 12])
    // The `DEBUG` site keeps one of its two mutants; the `i++` site loses its only one and disappears.
    expect(result.sites.map((site) => site.mutants.map((m) => m.mutant.id))).toEqual([[7], [8], [9, 10, 11], [12]])
  })
})

describe('TCE keeps', () => {
  const js = ['export function isAdult(age) {', '  let years = age', '  if (false) { years++ }', '  return years >= 18', '}'].join('\n')
  const ts = ['export function isAdult(age: number): boolean {', '  let years: number = age', '  if (false) { years++ }', '  return years >= 18', '}'].join('\n')

  // The TypeScript case guards against comparing two failed minifications: the minifier
  // returns empty code for type annotations, which would make every mutant look equivalent.
  test.each([['file.js', js], ['file.ts', ts]])('real mutants in %s', (file, code) => {
    expect(split(code, file)).toEqual({
      kept: ['1 FunctionBody body → `return`', '3 BooleanLiteral `false` → `true`', '4 ComparisonBoundary `>=` → `>`'],
      equivalent: ['3 Update `++` → `--`'],
    })
  })

  test('every mutant when the transform reports an error', () => {
    // oxc-parser accepts the redeclaration; oxc-transform rejects it and returns empty code.
    const code = ['export function f(i: number): number {', '  let j = 1', '  let j = 2', '  if (false) { i++ }', '  return i + j', '}'].join('\n')
    expect(normalize('file.ts', code)).toBeUndefined()
    expect(split(code, 'file.ts').equivalent).toEqual([])
    expect(split(code, 'file.ts').kept).toContain('4 Update `++` → `--`')
  })

  test('every mutant when the minifier reports an error', () => {
    const typed = 'export function f(i: number) { if (false) { i++ } return i }'
    expect(normalize('file.ts', typed)).toBe('export function f(i){return i}')
    // Fed to the minifier as JavaScript, both the original and the mutant fail with empty code.
    expect(normalize('file.js', typed)).toBeUndefined()
    expect(normalize('file.js', typed.replace('i++', 'i--'))).toBeUndefined()
  })

  test('every mutant when the original minifies to nothing', () => {
    // Nothing is exported, so the minifier drops the whole module.
    const code = ['function f(i) {', '  if (false) { i++ }', '  return i', '}'].join('\n')
    expect(normalize('file.js', code)).toBeUndefined()
    expect(split(code).equivalent).toEqual([])
  })
})
