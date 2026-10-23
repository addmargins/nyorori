import { describe, expect, test } from 'vitest'
import { changedRanges, changesIn, MAX_EDITS } from '../src/diff.ts'
import { addedLines, changes, show } from './changes.ts'

/** `after` as it differs from `before`: changed tokens in brackets, the place of a deletion as `|`. */
function diff(before: string, after: string): string {
  return show(after, changes(before, after))
}

describe('changedRanges', () => {
  test('marks every token of inserted lines, and nothing of a comment', () => {
    expect(diff('function f(a) {\n  return a\n}\n', 'function f(a) {\n  const b = a + 1\n  // why\n  return a\n}\n'))
      .toBe('function f(a) {\n  [const b = a + 1]\n  // why\n  return a\n}\n')
    expect(diff('f()\n', 'f()\n/* new\n   comment */\n')).toBe('f()\n/* new\n   comment */\n')
  })

  test('marks only the tokens replaced within a line', () => {
    const before = '    fromIndex = Math.min(fromIndex, arr.length - 1);\n'
    expect(diff(before, before.replace('(fromIndex', '(index'))).toBe('    fromIndex = Math.min([index], arr.length - 1);\n')
    expect(diff('if (a < limit) go()\n', 'if (a <= limit) go()\n')).toBe('if (a [<=] limit) go()\n')
  })

  test('finds no change in reformatted code', () => {
    // Reflowed, re-indented, requoted, with trailing commas: what Prettier does.
    expect(diff("export function f(a, b) { return g(a, 'x', b) }\n", 'export function f(a, b) {\n  return g(\n    a,\n    "x",\n    b,\n  )\n}\n'))
      .toBe('export function f(a, b) {\n  return g(\n    a,\n    "x",\n    b,\n  )\n}\n')
    expect(diff('const o = { a: 1,\n  b: [2, 3] }\n', 'const o = {\n  a: 1,\n  b: [2, 3,],\n}\n')).toBe('const o = {\n  a: 1,\n  b: [2, 3,],\n}\n')
    // Line endings alone.
    expect(changes('if (a) {\r\n  b(1)\r\n}\r\n', 'if (a) {\n  b(1)\n}\n')).toEqual({ lines: new Set([1, 2, 3]), ranges: [] })
  })

  test('finds no change in comments', () => {
    expect(diff('// old\nx = g(a, 1) // a\n', '// new words\nx = g(\n  a, // the value\n  /* one */ 1,\n) /* b */\n'))
      .toBe('// new words\nx = g(\n  a, // the value\n  /* one */ 1,\n) /* b */\n')
  })

  test('marks the place of a deletion between the tokens around it', () => {
    expect(diff('if (a && b && c) x()\n', 'if (a && c) x()\n')).toBe('if (a && |c) x()\n')
    // A whole line deleted inside a call.
    expect(diff('g(\n  a,\n  b,\n)\n', 'g(\n  a,\n)\n')).toBe('g(\n  a,\n|)\n')
    // A trailing comma means nothing; the second comma of `[a,,]` is a hole.
    expect(diff('x = [a,,]\n', 'x = [a,]\n')).toBe('x = [a,|]\n')
    // Replaced tokens already mark the place.
    expect(diff('x = f(a, b)\n', 'x = f(c)\n')).toBe('x = f([c])\n')
  })

  test('marks a renamed name like any other replaced token', () => {
    expect(diff('function f(fromIndex) {\n  return fromIndex + 1\n}\n', 'function f(index) {\n  return index + 1\n}\n'))
      .toBe('function f([index]) {\n  return [index] + 1\n}\n')
  })

  test('marks moved lines where they land', () => {
    // Moving a call reorders its effects; git sees a deletion and an insertion.
    expect(diff('function f() {\n  a()\n  b()\n  c()\n}\n', 'function f() {\n  b()\n  c()\n  a()\n}\n'))
      .toBe('function f() {\n|  b()\n  c()\n  [a()]\n}\n')
  })

  test('reads CRLF line endings and non-ASCII text', () => {
    expect(diff('if (a) {\r\n  b(1)\r\n}\r\n', 'if (a) {\r\n  b(2)\r\n}\r\n')).toBe('if (a) {\r\n  b([2])\r\n}\r\n')
    expect(diff('if (a) {\r\n  b(1)\r\n}\r\n', 'if (a) {\n  b(2)\n}\n')).toBe('if (a) {\n  b([2])\n}\n')
    // Offsets count UTF-16 code units, like oxc's spans: an emoji is two.
    expect(diff("const s = '😀 한국어' + 이름 + x\n", "const s = '😀 한국어' + 이름 + y\n")).toBe("const s = '😀 한국어' + 이름 + [y]\n")
    expect(diff('const 이름 = 1\n', 'const 이름 = 2\n')).toBe('const 이름 = [2]\n')
  })

  test('marks a line break where it changes what runs', () => {
    // `return\nx` returns undefined.
    expect(diff('function f(x) {\n  return x\n}\n', 'function f(x) {\n  return\n  x\n}\n')).toBe('function f(x) {\n  return\n  [x]\n}\n')
    // `a++\nb` increments `a`, `a\n++b` increments `b`.
    expect(diff('a++\nb\n', 'a\n++b\n')).toBe('a\n[++]b\n')
  })

  test('compares strings, template chunks and regex literals whole, whitespace included', () => {
    expect(diff('const s = `a ${x}  b`\n', 'const s = `a ${x} b`\n')).toBe('const s = `a ${x[} b`]\n')
    expect(diff('const s = `\n  one\n  two ${x}\n`\n', 'const s = `\n    one\n  two ${x}\n`\n')).toBe('const s = [`\n    one\n  two ${]x}\n`\n')
    expect(diff("f('a b')\n", "f('a  b')\n")).toBe("f(['a  b'])\n")
    // Escaped differently, the same string: not worth reading escapes for.
    expect(diff("f('it\\'s')\n", 'f("it\'s")\n')).toBe('f(["it\'s"])\n')
    expect(diff('x = /a/.test(s) / 2\n', 'x = /a/i.test(s) / 2\n')).toBe('x = [/a/i].test(s) / 2\n')
    expect(diff('x = a / 2 / b\n', 'x = a / 2 / c\n')).toBe('x = a / 2 / [c]\n')
    expect(diff('const c = <a>\n  <b>x</b>\n</a>\n', 'const c = <a>\n  <b>y</b>\n</a>\n')).toBe('const c = <a>\n  <b>[y]</b>\n</a>\n')
  })

  test(`takes the whole hunk as changed beyond ${MAX_EDITS} edits`, () => {
    const call = (name: string, count: number) => `f(${Array.from({ length: count }, (_, i) => `${name}${i}`).join(', ')})\n`
    expect(diff(call('a', 3), call('b', 3))).toBe('f([b0], [b1], [b2])\n')
    // 1200 replaced names: the commas between them are not worth the search.
    const after = call('b', 600)
    expect(changes(call('a', 600), after).ranges).toEqual([{ start: 2, end: after.length - 2 }])
  })

  test('leaves out what only TypeScript reads, in either version', () => {
    // Types, casts, a `this` parameter, `?` and `!`, class member modifiers, overloads and type declarations compile to nothing.
    const typed = 'function f(a: unknown, b?: number): Array<T[]> {\n  return (a as number) < (<number>b)!\n}\n'
    expect(diff('function f(a: any, b): T[][] {\n  return a < b\n}\n', typed)).toBe(typed)
    const members = 'class A implements I {\n  private readonly x?: number\n  public m(this: A, a: T): T\n  public m(this: A, a: any) { return a satisfies T }\n}\n'
    expect(diff('class A {\n  x: number\n  m(a) { return a }\n}\n', members)).toBe(members)
    const declared = 'function f(a) {\n  let x!: number\n  type T = 1\n  interface I { a: 1 }\n  return x\n}\n'
    expect(diff('function f(a) {\n  let x: number\n  return x\n}\n', declared)).toBe(declared)
  })

  test('keeps the TypeScript that compiles to code', () => {
    // A parameter property assigns a field; a field that becomes `declare` no longer defines one.
    expect(diff('class A {\n  constructor(x: number) {}\n  y: number\n}\n', 'class A {\n  constructor(private x: number) {}\n  declare y: number\n}\n'))
      .toBe('class A {\n  constructor([private] x: number) {}\n  declare y|: number\n}\n')
    // Parentheses around a cast that group, or that `new` or an optional chain needs.
    expect(diff('function f(a) {\n  return [a + b * c, new F().x, a?.b.c]\n}\n', 'function f(a) {\n  return [(a + b as number) * c, new (F() as any).x, (a?.b as B).c]\n}\n'))
      .toBe('function f(a) {\n  return [[(]a + b as number[)] * c, new [(]F() as any[)].x, [(]a?.b as B[)].c]\n}\n')
    expect(diff('enum E { A = 1 }\n', 'enum E { A = 2 }\n')).toBe('enum E { A = [2] }\n')
  })

  test('without the old version, takes every token of the hunks as new', () => {
    const code = 'x = a + b\ny = c\n'
    const hunks = [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }, { oldStart: 3, oldCount: 1, newStart: 2, newCount: 0 }]
    expect(show(code, { lines: new Set(), ranges: changedRanges(undefined, code, hunks) })).toBe('[x = a + b]\ny = c\n|')
    expect(show(code, addedLines(code, [2]))).toBe('x = a + b\n[y = c]\n')
  })
})

describe('changesIn', () => {
  const ranges = [{ start: 4, end: 4 }, { start: 10, end: 12 }]

  test('finds a changed token that overlaps the span', () => {
    expect(changesIn(ranges, 11, 20)).toEqual([{ start: 10, end: 12 }])
    expect(changesIn(ranges, 0, 11)).toEqual(ranges)
    expect(changesIn(ranges, 12, 20)).toEqual([])
  })

  test('finds a deletion only strictly inside the span', () => {
    expect(changesIn(ranges, 3, 5)).toEqual([{ start: 4, end: 4 }])
    // Right before or right after an expression, a deletion did not change it.
    expect(changesIn(ranges, 4, 8)).toEqual([])
    expect(changesIn(ranges, 0, 4)).toEqual([])
  })
})
