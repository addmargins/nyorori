import { parseSync, type Comment } from 'oxc-parser'
import { isOperator, type Mutant, type Operator, type Suppression, type SuppressionProblem } from '../types.ts'

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

/**
 * A place in the source that the instrumenter rewrites. An expression site
 * wraps the expression in a switch over its mutants; a body site inserts an
 * early `return` right after a function body's `{`.
 */
export interface Site {
  start: number
  end: number
  kind: 'expression' | 'body'
  mutants: PlannedMutant[]
}

export interface PlannedMutant {
  mutant: Mutant
  /** Source text that replaces the whole site when this mutant is active. Unused for body sites. */
  replacement: string
}

export interface GenerateResult {
  sites: Site[]
  mutants: Mutant[]
  suppressions: Suppression[]
  problems: SuppressionProblem[]
}

export class ParseError extends Error {}

// Keys that only hold TypeScript types or decorators; nothing in them runs as a mutable expression.
const SKIP_KEYS = new Set([
  'type',
  'start',
  'end',
  'range',
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeArguments',
  'implements',
  'decorators',
])

const SKIP_NODES = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TSIndexSignature',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSEmptyBodyFunctionExpression',
])

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

const BINARY: Record<string, [Operator, string]> = {
  '<': ['ComparisonBoundary', '<='],
  '<=': ['ComparisonBoundary', '<'],
  '>': ['ComparisonBoundary', '>='],
  '>=': ['ComparisonBoundary', '>'],
  '===': ['Equality', '!=='],
  '!==': ['Equality', '==='],
  '==': ['Equality', '!='],
  '!=': ['Equality', '=='],
  '+': ['Arithmetic', '-'],
  '-': ['Arithmetic', '+'],
  '*': ['Arithmetic', '/'],
  '/': ['Arithmetic', '*'],
  '%': ['Arithmetic', '*'],
}

const SUPPRESS_PREFIX = 'nyorori-ignore'
const SUPPRESS_RE = /^nyorori-ignore-next-line\s+([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+--\s+(\S.*)$/

/**
 * Builds the mutants whose anchor lies on one of `changed` lines, plus the
 * suppression comments that apply to them. Ids start at `firstId`.
 */
export function generate(file: string, code: string, changed: ReadonlySet<number>, firstId: number): GenerateResult {
  const parsed = parseSync(file, code)
  if (parsed.errors.length > 0) {
    throw new ParseError(parsed.errors[0]!.message)
  }
  const lines = lineStarts(code)
  const position = (offset: number) => toPosition(lines, offset)
  const sites = new Map<string, Site>()

  function add(
    site: { start: number; end: number },
    kind: Site['kind'],
    anchor: number,
    operator: Operator,
    replacement: string,
    description: string,
  ): void {
    const { line, column } = position(anchor)
    if (!changed.has(line)) return
    const key = `${site.start}:${site.end}:${kind}`
    let target = sites.get(key)
    if (!target) {
      target = { start: site.start, end: site.end, kind, mutants: [] }
      sites.set(key, target)
    }
    if (target.mutants.some((m) => m.replacement === replacement && m.mutant.operator === operator)) return
    target.mutants.push({ mutant: { id: 0, file, line, column, operator, description }, replacement })
  }

  const text = (node: Node) => code.slice(node.start, node.end)
  // Replaces [from, to) inside the site with `insert`, returning the whole site text.
  const edit = (site: Node, from: number, to: number, insert: string) =>
    code.slice(site.start, from) + insert + code.slice(to, site.end)

  function condition(test: Node | null, values: string[]): void {
    if (!test) return
    const inner = unwrap(test)
    if (isBooleanLiteral(inner)) return
    for (const value of values) {
      if (value === 'true' && isAlwaysTrue(inner)) continue
      add(test, 'expression', test.start, 'Condition', value, `\`${snippet(text(test))}\` → \`${value}\``)
    }
  }

  function mutate(node: Node, parent: Node | null): void {
    switch (node.type) {
      case 'BinaryExpression': {
        const entry = BINARY[node.operator as string]
        if (!entry) break
        const [operator, replacementOp] = entry
        const left = node.left as Node
        const right = node.right as Node
        if (node.operator === '+' && (isStringLike(left) || isStringLike(right))) break
        if ((node.operator === '*' || node.operator === '/') && isNumber(right, 1)) break
        const at = findToken(code, left.end, right.start, node.operator as string)
        if (at < 0) break
        add(node, 'expression', at, operator, edit(node, at, at + (node.operator as string).length, replacementOp),
          `\`${node.operator}\` → \`${replacementOp}\``)
        break
      }
      case 'LogicalExpression': {
        const left = node.left as Node
        const right = node.right as Node
        const at = findToken(code, left.end, right.start, node.operator as string)
        if (at < 0) break
        if (node.operator === '??') {
          add(node, 'expression', at, 'Logical', text(left), `\`${snippet(text(node))}\` → \`${snippet(text(left))}\``)
        } else {
          const other = node.operator === '&&' ? '||' : '&&'
          add(node, 'expression', at, 'Logical', edit(node, at, at + 2, other), `\`${node.operator}\` → \`${other}\``)
        }
        break
      }
      case 'UnaryExpression': {
        const argument = node.argument as Node
        if (node.operator === '-') {
          add(node, 'expression', node.start, 'UnaryMinus', text(argument), `\`${snippet(text(node))}\` → \`${snippet(text(argument))}\``)
        } else if (node.operator === '!') {
          // In `!!x`, dropping either `!` yields the same `!x`; keep only the outer one.
          if (parent?.type === 'UnaryExpression' && parent.operator === '!') break
          add(node, 'expression', node.start, 'Negation', text(argument), `\`${snippet(text(node))}\` → \`${snippet(text(argument))}\``)
        }
        break
      }
      case 'UpdateExpression': {
        const argument = node.argument as Node
        const at = node.prefix ? node.start : findToken(code, argument.end, node.end, node.operator as string)
        if (at < 0) break
        const other = node.operator === '++' ? '--' : '++'
        add(node, 'expression', at, 'Update', edit(node, at, at + 2, other), `\`${node.operator}\` → \`${other}\``)
        break
      }
      case 'Literal': {
        if (typeof node.value !== 'boolean') break
        const other = String(!node.value)
        add(node, 'expression', node.start, 'BooleanLiteral', other, `\`${node.value}\` → \`${other}\``)
        break
      }
      case 'IfStatement':
      case 'ConditionalExpression':
        condition(node.test as Node, ['true', 'false'])
        break
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        // `true` would only turn the loop into an infinite one.
        condition(node.test as Node | null, ['false'])
        break
      case 'ChainExpression': {
        for (const link of optionalLinks(node.expression as Node)) {
          const from = (link.type === 'MemberExpression' ? link.object : link.callee) as Node
          const at = findToken(code, from.end, link.end, '?.')
          if (at < 0) continue
          const dot = link.type === 'MemberExpression' && !link.computed ? '.' : ''
          add(node, 'expression', at, 'OptionalChaining', edit(node, at, at + 2, dot), `\`?.\` → \`${dot || '(none)'}\``)
        }
        break
      }
    }
    if (FUNCTIONS.has(node.type)) {
      const body = node.body as Node | null
      if (!body) return
      if (body.type === 'BlockStatement') {
        const statements = body.body as Node[]
        const onlyReturn = statements.length === 1 && statements[0]!.type === 'ReturnStatement' && statements[0]!.argument === null
        if (statements.length === 0 || onlyReturn) return
        const at = body.start + 1
        add({ start: at, end: at }, 'body', body.start, 'FunctionBody', '', 'body → `return`')
      } else if (!isUndefined(body)) {
        add(body, 'expression', body.start, 'FunctionBody', 'undefined', `\`=> ${snippet(text(body))}\` → \`=> undefined\``)
      }
    }
  }

  function visit(node: Node, parent: Node | null, inFunction: boolean, inConsole: boolean): void {
    if (SKIP_NODES.has(node.type) || node.declare === true) return
    // Module-level code runs once at import time; only code inside functions is mutated.
    if (!inConsole && (inFunction || FUNCTIONS.has(node.type))) mutate(node, parent)
    const childInFunction = inFunction || FUNCTIONS.has(node.type)
    const childInConsole = inConsole || isConsoleCall(node)
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, node, childInFunction, childInConsole)
      } else if (isNode(value)) {
        visit(value, node, childInFunction, childInConsole)
      }
    }
  }

  visit(parsed.program as unknown as Node, null, false, false)

  const ordered = [...sites.values()].sort((a, b) => a.start - b.start || b.end - a.end)
  const mutants: Mutant[] = []
  let id = firstId
  for (const site of ordered) {
    for (const planned of site.mutants) {
      planned.mutant.id = id++
      mutants.push(planned.mutant)
    }
  }

  const { suppressions, problems } = readSuppressions(file, parsed.comments, lines, changed)
  return { sites: ordered, mutants, suppressions, problems }
}

function readSuppressions(
  file: string,
  comments: Comment[],
  lines: number[],
  changed: ReadonlySet<number>,
): { suppressions: Suppression[]; problems: SuppressionProblem[] } {
  const suppressions: Suppression[] = []
  const problems: SuppressionProblem[] = []
  for (const comment of comments) {
    const value = comment.value.replace(/^\*+/, '').trim()
    if (!value.startsWith(SUPPRESS_PREFIX)) continue
    const line = toPosition(lines, comment.start).line
    const match = SUPPRESS_RE.exec(value)
    if (!match) {
      problems.push({
        file,
        line,
        message: 'Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
      })
      continue
    }
    const names = match[1]!.split(',').map((name) => name.trim())
    const unknown = names.filter((name) => !isOperator(name))
    if (unknown.length > 0) {
      problems.push({ file, line, message: `Unknown operator in suppression: ${unknown.join(', ')}.` })
      continue
    }
    suppressions.push({
      file,
      line,
      targetLine: toPosition(lines, comment.end).line + 1,
      operators: names as Operator[],
      reason: match[2]!.trim(),
      isNew: changed.has(line),
    })
  }
  return { suppressions, problems }
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

function unwrap(node: Node): Node {
  while (node.type === 'ParenthesizedExpression') node = node.expression as Node
  return node
}

function isBooleanLiteral(node: Node): boolean {
  return node.type === 'Literal' && typeof node.value === 'boolean'
}

function isNumber(node: Node, value: number): boolean {
  node = unwrap(node)
  return node.type === 'Literal' && node.value === value
}

function isStringLike(node: Node): boolean {
  node = unwrap(node)
  return (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral'
}

function isUndefined(node: Node): boolean {
  node = unwrap(node)
  return (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'UnaryExpression' && node.operator === 'void')
}

/** `x.length >= 0`: turning it into `true` changes nothing. */
function isAlwaysTrue(node: Node): boolean {
  if (node.type !== 'BinaryExpression' || node.operator !== '>=') return false
  const left = unwrap(node.left as Node)
  return isNumber(node.right as Node, 0) && left.type === 'MemberExpression' && !left.computed &&
    (left.property as Node).type === 'Identifier' && (left.property as Node).name === 'length'
}

function isConsoleCall(node: Node): boolean {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee as Node
  if (callee.type !== 'MemberExpression') return false
  const object = callee.object as Node
  return object.type === 'Identifier' && object.name === 'console'
}

function optionalLinks(expression: Node): Node[] {
  const links: Node[] = []
  let node: Node | undefined = expression
  while (node) {
    if (node.type === 'MemberExpression') {
      if (node.optional) links.push(node)
      node = node.object as Node
    } else if (node.type === 'CallExpression') {
      if (node.optional) links.push(node)
      node = node.callee as Node
    } else if (node.type === 'TSNonNullExpression') {
      node = node.expression as Node
    } else {
      node = undefined
    }
  }
  return links
}

/** Index of `token` in code[from, to), skipping comments; -1 if absent. */
export function findToken(code: string, from: number, to: number, token: string): number {
  let i = from
  while (i < to) {
    if (code.startsWith('//', i)) {
      const next = code.indexOf('\n', i)
      i = next < 0 ? to : next + 1
    } else if (code.startsWith('/*', i)) {
      const next = code.indexOf('*/', i + 2)
      i = next < 0 ? to : next + 2
    } else if (code.startsWith(token, i)) {
      return i
    } else {
      i++
    }
  }
  return -1
}

export function lineStarts(code: string): number[] {
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

export function toPosition(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 }
}

function snippet(source: string): string {
  const flat = source.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat
}
