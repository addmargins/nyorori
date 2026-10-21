import {
  parseSync,
  visitorKeys,
  type CallExpression,
  type Comment,
  type Expression,
  type ExpressionStatement,
  type MemberExpression,
  type Node,
  type Span,
} from 'oxc-parser'
import { ScopeTracker } from 'oxc-walker'
import { isOperator, type EquivalentMutant, type Mutant, type Operator, type Suppression, type SuppressionProblem } from '../types.ts'
import { dropEquivalent } from './equivalent.ts'
import type { TypeOracle } from './typecheck.ts'

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
  /**
   * The expression statement this site begins, if any. A `(` there would
   * continue a previous line that has no semicolon (`g(1)` then `(i++)` is a
   * call), so the rewrite wraps the whole statement in a block.
   */
  statement?: { start: number; end: number }
}

export interface PlannedMutant {
  mutant: Mutant
  /** Source text that replaces the whole site when this mutant is active. Unused for body sites. */
  replacement: string
}

export interface GenerateResult {
  sites: Site[]
  mutants: Mutant[]
  /** Mutants dropped because they minify to the original code; they get no id and no site. */
  equivalent: EquivalentMutant[]
  suppressions: Suppression[]
  problems: SuppressionProblem[]
}

export class ParseError extends Error {}

// Child keys that only hold TypeScript types or decorators; nothing in them runs as a mutable expression.
const TYPE_KEYS = new Set([
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeArguments',
  'implements',
  'decorators',
])

// The keys of each node type that hold child nodes, as oxc lists them, minus the type-only ones.
const CHILD_KEYS = new Map(Object.entries(visitorKeys).map(([type, keys]) => [type, keys.filter((key) => !TYPE_KEYS.has(key))]))

const SKIP_NODES = new Set<Node['type']>([
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

const FUNCTIONS = new Set<Node['type']>(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * Where a node sits. Module-level code runs once at import time, and the
 * arguments of a global `console` call are only logged; neither is mutated.
 */
type Context = 'module' | 'function' | 'console'

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

const NO_TYPES: TypeOracle = { plus: () => 'unknown' }

const SUPPRESS_PREFIX = 'nyorori-ignore'
const SUPPRESS_RE = /^nyorori-ignore-next-line\s+([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+--\s+(\S.*)$/

/**
 * Builds the mutants whose anchor lies on one of `changed` lines, plus the
 * suppression comments that apply to them. Mutants that minify to the
 * original code are set aside in `equivalent`. Ids start at `firstId`.
 * `types` tells string `+` from numeric `+` where the syntax cannot.
 */
export function generate(file: string, code: string, changed: ReadonlySet<number>, firstId: number, types = NO_TYPES): GenerateResult {
  const parsed = parseSync(file, code)
  if (parsed.errors.length > 0) {
    throw new ParseError(parsed.errors[0]!.message)
  }
  const lines = lineStarts(code)
  const position = (offset: number) => toPosition(lines, offset)
  const sites = new Map<string, Site>()
  const statements = new Map<number, ExpressionStatement>()

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

  const text = (node: Span) => code.slice(node.start, node.end)
  // Replaces [from, to) inside the site with `insert`, returning the whole site text.
  const edit = (site: Span, from: number, to: number, insert: string) =>
    code.slice(site.start, from) + insert + code.slice(to, site.end)

  /**
   * String `+` is not mutated (string mutations are deferred). A string or
   * template literal operand settles it; otherwise the operand types do, where known.
   */
  function isConcatenation(left: Node, right: Node, at: number): boolean {
    if (isStringLike(left) || isStringLike(right)) return true
    // Only a `+` that can become a mutant is worth starting the type checker for.
    if (!changed.has(position(at).line)) return false
    return types.plus(file, left, right) === 'string'
  }

  function condition(test: Expression | null, values: string[]): void {
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
        const entry = BINARY[node.operator]
        if (!entry) break
        const [operator, replacementOp] = entry
        const { left, right } = node
        if ((node.operator === '*' || node.operator === '/') && isNumber(right, 1)) break
        const at = findToken(code, left.end, right.start, node.operator)
        if (at < 0) break
        if (node.operator === '+' && isConcatenation(left, right, at)) break
        add(node, 'expression', at, operator, edit(node, at, at + node.operator.length, replacementOp),
          `\`${node.operator}\` → \`${replacementOp}\``)
        break
      }
      case 'LogicalExpression': {
        const { left, right } = node
        const at = findToken(code, left.end, right.start, node.operator)
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
        const { argument } = node
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
        const at = node.prefix ? node.start : findToken(code, node.argument.end, node.end, node.operator)
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
        condition(node.test, ['true', 'false'])
        break
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        // `true` would only turn the loop into an infinite one.
        condition(node.test, ['false'])
        break
      case 'ChainExpression': {
        for (const link of optionalLinks(node.expression)) {
          const from = link.type === 'MemberExpression' ? link.object : link.callee
          const at = findToken(code, from.end, link.end, '?.')
          if (at < 0) continue
          const dot = link.type === 'MemberExpression' && !link.computed ? '.' : ''
          add(node, 'expression', at, 'OptionalChaining', edit(node, at, at + 2, dot), `\`?.\` → \`${dot || '(none)'}\``)
        }
        break
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const { body } = node
        if (!body) break
        if (body.type === 'BlockStatement') {
          const [first] = body.body
          const onlyReturn = body.body.length === 1 && first?.type === 'ReturnStatement' && first.argument === null
          if (body.body.length === 0 || onlyReturn) break
          const at = body.start + 1
          add({ start: at, end: at }, 'body', body.start, 'FunctionBody', '', 'body → `return`')
        } else if (!isUndefined(body)) {
          add(body, 'expression', body.start, 'FunctionBody', 'undefined', `\`=> ${snippet(text(body))}\` → \`=> undefined\``)
        }
        break
      }
    }
  }

  const scopes = new Scopes()
  // The tracker records a name when the walk reaches its declaration, so a first
  // pass collects them all and the second also sees names declared below their
  // use: hoisted `var` and functions, or a module-level logger defined further down.
  walk(parsed.program, null, undefined, scopes, () => undefined)
  scopes.freeze()
  walk<Context>(parsed.program, null, 'module', scopes, (node, parent, context) => {
    if (node.type === 'ExpressionStatement') statements.set(node.start, node)
    if (context === 'console') return context
    const inner = context === 'function' || FUNCTIONS.has(node.type) ? 'function' : 'module'
    if (inner === 'function') mutate(node, parent)
    // A `console` declared in an enclosing scope (a parameter, an import, ...) is the code's own object.
    return isConsoleCall(node) && !scopes.isDeclared('console') ? 'console' : inner
  })

  for (const site of sites.values()) {
    const statement = site.kind === 'expression' ? statements.get(site.start) : undefined
    if (statement) site.statement = { start: statement.start, end: statement.end }
  }
  const sorted = [...sites.values()].sort((a, b) => a.start - b.start || b.end - a.end)
  // Before ids are assigned, so each remaining site keeps a contiguous id range.
  const { sites: ordered, equivalent } = dropEquivalent(file, code, sorted)
  const mutants: Mutant[] = []
  let id = firstId
  for (const site of ordered) {
    for (const planned of site.mutants) {
      planned.mutant.id = id++
      mutants.push(planned.mutant)
    }
  }

  const { suppressions, problems } = readSuppressions(file, parsed.comments, lines, changed)
  return { sites: ordered, mutants, equivalent, suppressions, problems }
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

/**
 * oxc-walker's ScopeTracker, kept in step by `walk` below rather than by
 * oxc-walker's own walk. That one enters every key and every node, so the
 * tracker would also count ambient declarations, which bind nothing at runtime:
 * after `declare const console: …`, `console` is still the global. The hooks
 * its walk calls are protected, hence the subclass.
 */
class Scopes extends ScopeTracker {
  constructor() {
    // Exited scopes stay recorded, so the second walk can look names up in them.
    super({ preserveExitedScopes: true })
  }

  enter(node: Node): void {
    this.processNodeEnter(node)
  }

  leave(node: Node): void {
    this.processNodeLeave(node)
  }
}

/**
 * Visits the code that exists at runtime, parents before children, and keeps
 * `scopes` in step. Type-only children and ambient (`declare`) declarations are
 * not entered. SKIP_NODES reach `scopes` but not `enter`: an import, enum or
 * namespace can still declare a name. `enter` returns the state its children get.
 */
function walk<T>(node: Node, parent: Node | null, state: T, scopes: Scopes, enter: (node: Node, parent: Node | null, state: T) => T): void {
  if ('declare' in node && node.declare) return
  scopes.enter(node)
  if (!SKIP_NODES.has(node.type)) {
    const inner = enter(node, parent, state)
    for (const key of CHILD_KEYS.get(node.type) ?? []) {
      // The key comes from oxc's table, so TypeScript cannot know which property it names.
      const value: unknown = Reflect.get(node, key)
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child, node, inner, scopes, enter)
      } else if (isNode(value)) {
        walk(value, node, inner, scopes, enter)
      }
    }
  }
  scopes.leave(node)
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}

function unwrap(node: Node): Node {
  while (node.type === 'ParenthesizedExpression') node = node.expression
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
  const left = unwrap(node.left)
  return isNumber(node.right, 0) && left.type === 'MemberExpression' && !left.computed &&
    left.property.type === 'Identifier' && left.property.name === 'length'
}

/** `console.x(...)`, whichever `console` it names; the caller checks the scope. */
function isConsoleCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' && node.callee.object.name === 'console'
}

function optionalLinks(expression: Node): Array<MemberExpression | CallExpression> {
  const links: Array<MemberExpression | CallExpression> = []
  let node: Node | undefined = expression
  while (node) {
    if (node.type === 'MemberExpression') {
      if (node.optional) links.push(node)
      node = node.object
    } else if (node.type === 'CallExpression') {
      if (node.optional) links.push(node)
      node = node.callee
    } else if (node.type === 'TSNonNullExpression') {
      node = node.expression
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
