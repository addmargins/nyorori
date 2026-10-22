import {
  parseSync,
  visitorKeys,
  type BinaryExpression,
  type CallExpression,
  type Comment,
  type Expression,
  type ExpressionStatement,
  type MemberExpression,
  type Node,
  type ParseResult,
  type Span,
} from 'oxc-parser'
import { ScopeTracker, type ScopeTrackerNode } from 'oxc-walker'
import { changesIn, lineStarts, type Changes } from '../diff.ts'
import { isOperator, type EquivalentMutant, type Mutant, type Operator, type Suppression, type SuppressionProblem } from '../types.ts'
import { dropEquivalent } from './equivalent.ts'
import { Strings, type Bindings } from './infer.ts'
import type { Probe, Rule } from './profile.ts'
import { regexMutations } from './regex.ts'
import type { FileQuestions, TypeOracle } from './typecheck.ts'

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
  /** What the baseline records for this mutant, and what the record must show for it to survive (see profile.ts). */
  profile?: { probe: Probe; rule: Rule }
}

export interface GenerateResult {
  sites: Site[]
  mutants: Mutant[]
  /** Mutants dropped because they minify to the original code; they get no id and no site. */
  equivalent: EquivalentMutant[]
  suppressions: Suppression[]
  /**
   * New suppressions whose target line the branch changed only in whitespace
   * or comments, like a block it re-indented: no mutant of that line is in
   * scope, so matching none says nothing about the suppression.
   */
  reformatted: Suppression[]
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

const NO_TYPES: TypeOracle = { plus: () => 'unknown', nonNullableType: () => undefined }

const SUPPRESS_PREFIX = 'nyorori-ignore'
const SUPPRESS_RE = /^nyorori-ignore-next-line\s+([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+--\s+(\S.*)$/

/**
 * Builds the mutants of the code that `changes` touch, plus the suppression
 * comments that apply to them. An expression site is in scope when its text
 * holds a change; a function body when the function's header does (see
 * plan). Mutants that minify to the original code are set aside in
 * `equivalent`. Ids start at `firstId`. Where the syntax cannot tell string
 * `+` from numeric `+`, `types` answers from the operand types (see typeQuestions).
 */
export function generate(file: string, code: string, changes: Changes, firstId: number, types = NO_TYPES): GenerateResult {
  const { parsed, lines, sites } = plan(file, code, changes, types)
  const sorted = [...sites.values()].sort((a, b) => a.start - b.start || b.end - a.end)
  // Before ids are assigned, so each remaining site keeps a contiguous id range.
  const { sites: ordered, equivalent } = dropEquivalent(file, code, sorted)
  const mutants: Mutant[] = []
  let id = firstId
  for (const site of ordered) {
    for (const planned of site.mutants) {
      planned.mutant.id = id++
      mutants.push(planned.mutant)
      // After TCE, so a probe whose first reader was dropped is keyed by the next one.
      if (planned.profile && planned.profile.probe.key === 0) planned.profile.probe.key = planned.mutant.id
    }
  }

  const { suppressions, problems } = readSuppressions(file, parsed.comments, lines, changes.lines)
  const reformatted = suppressions.filter(({ isNew, targetLine }) => isNew && changes.lines.has(targetLine) &&
    changesIn(changes.ranges, lines[targetLine - 1] ?? code.length, lines[targetLine] ?? code.length).length === 0)
  return { sites: ordered, mutants, equivalent, suppressions, reformatted, problems }
}

/**
 * What generate() will ask `types` about `file`: the changed `+` of mutated
 * code where the syntax cannot tell, and the values that the changed `?.` and
 * `??` mutants guard. The type checker answers them all in one pass
 * before generation, which stays synchronous. A file that does not parse has
 * no questions; generate() reports it.
 */
export function typeQuestions(file: string, code: string, changes: Changes): FileQuestions {
  const questions: FileQuestions = { file, plus: [], guarded: [] }
  const recorder: TypeOracle = {
    plus: (_, left, right) => {
      questions.plus.push({ left: { start: left.start, end: left.end }, right: { start: right.start, end: right.end } })
      return 'unknown'
    },
    nonNullableType: (_, value) => {
      questions.guarded.push({ start: value.start, end: value.end })
      return undefined
    },
  }
  try {
    plan(file, code, changes, recorder)
  } catch (error) {
    if (!(error instanceof ParseError)) throw error
  }
  return questions
}

/**
 * The sites and mutants of `file` before TCE and ids, the part of generate()
 * that asks `types`. A mutant is made only where its site holds a change:
 * `a < max` when `max` replaced another operand, but not `arr.length - 1`
 * when only an argument next to it changed (see `changed`). A body site, whose
 * mutant skips the whole body, would otherwise come with every edit inside a
 * function; it takes the function's header instead, from its start (or its
 * method name) to the `{`.
 */
function plan(file: string, code: string, changes: Changes, types: TypeOracle): { parsed: ParseResult; lines: number[]; sites: Map<string, Site> } {
  const parsed = parseSync(file, code)
  if (parsed.errors.length > 0) {
    throw new ParseError(parsed.errors[0]!.message)
  }
  const lines = lineStarts(code)
  const position = (offset: number) => toPosition(lines, offset)
  const sites = new Map<string, Site>()
  const statements = new Map<number, ExpressionStatement>()
  const valueProbes = new Map<string, Probe>()

  // The block bodies of functions, by start (filled by the first walk below).
  const blocks: Span[] = []

  /**
   * Whether `span` holds a change of its own. One in the block body of a
   * function nested in it does not count: those statements belong to that
   * function and its sites, or `xs.forEach((x) => { … })` would be removed for
   * every edit in the callback. An expression body is part of the expression.
   */
  function changed(span: Span): boolean {
    return changesIn(changes.ranges, span.start, span.end).some(({ start, end }) =>
      !inNestedBlock(span, Math.max(start, span.start), Math.min(end, span.end)))
  }

  function inNestedBlock(span: Span, start: number, end: number): boolean {
    let lo = 0
    let hi = blocks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (blocks[mid]!.start >= span.start) hi = mid
      else lo = mid + 1
    }
    for (let i = lo; i < blocks.length && blocks[i]!.start <= start; i++) {
      const block = blocks[i]!
      // A header holds no body, only the `{` of its own.
      if (block.end > span.end) continue
      // A deletion right before the `{` or after the `}` is outside.
      if (start === end ? block.start < start && start < block.end : end <= block.end) return true
    }
    return false
  }

  function add(
    site: { start: number; end: number },
    kind: Site['kind'],
    anchor: number,
    operator: Operator,
    replacement: string,
    description: string,
    scope: Span = site,
  ): PlannedMutant | undefined {
    if (!changed(scope)) return undefined
    const { line, column } = position(anchor)
    const key = `${site.start}:${site.end}:${kind}`
    let target = sites.get(key)
    if (!target) {
      target = { start: site.start, end: site.end, kind, mutants: [] }
      sites.set(key, target)
    }
    // Another operator can reach the same code: `if (check(true))` → `true` by Condition and by CallUnwrap.
    if (target.mutants.some((m) => m.replacement === replacement)) return undefined
    const planned: PlannedMutant = { mutant: { id: 0, file, line, column, operator, description }, replacement }
    target.mutants.push(planned)
    return planned
  }

  // Both Condition mutants of a test read the same record, so they share its probe.
  function valueProbe(node: Span): Probe {
    const place = `${node.start}:${node.end}`
    let probe = valueProbes.get(place)
    if (!probe) {
      probe = { kind: 'value', key: 0, start: node.start, end: node.end }
      valueProbes.set(place, probe)
    }
    return probe
  }

  const text = (node: Span) => code.slice(node.start, node.end)
  // Replaces [from, to) inside the site with `insert`, returning the whole site text.
  const edit = (site: Span, from: number, to: number, insert: string) =>
    code.slice(site.start, from) + insert + code.slice(to, site.end)

  /**
   * String `+` is not mutated (string mutations are deferred). The syntax
   * settles it where it is certain that an operand is a string (infer.ts);
   * the checker could not answer otherwise there, so only the rest is asked.
   */
  function isConcatenation(node: BinaryExpression): boolean {
    const { left, right } = node
    // Only a `+` that can become a mutant is worth the question.
    if (!changed(node)) return false
    if (strings.isString(left) || strings.isString(right)) return true
    return types.plus(file, left, right) === 'string'
  }

  // Asked only for a mutant that exists and that the profile can settle, so it is in changed code.
  function nonNullableType(value: Node): string | undefined {
    const type = types.nonNullableType(file, value)
    return type === undefined ? undefined : snippet(type)
  }

  function condition(test: Expression | null, values: string[]): void {
    if (!test) return
    const inner = unwrap(test)
    if (isBooleanLiteral(inner)) return
    // Only a test without side effects can be replaced by its observed value.
    const pure = isPure(test)
    for (const value of values) {
      if (value === 'true' && isAlwaysTrue(inner)) continue
      const planned = add(test, 'expression', test.start, 'Condition', value, `\`${snippet(text(test))}\` → \`${value}\``)
      if (planned && pure) planned.profile = { probe: valueProbe(test), rule: { kind: 'condition', value: value === 'true' } }
    }
  }

  // Chains whose value is used as a reference. Wrapping one in a conditional
  // turns it into a plain value: `(o?.f)()` would lose `this`, and
  // `delete (o?.x)` would not delete. Parents are visited first, so the set is
  // filled before the chain is reached.
  const references = new Set<Node>()
  // Callees of `new`: unwrapping a call there would construct its argument.
  const constructed = new Set<Node>()
  // Calls whose value an expression statement drops. CallStatement removes
  // them; CallUnwrap would only remove them too, with the first argument evaluated.
  const discarded = new Set<Node>()
  const isGlobalConsoleCall = (node: Node) => isConsoleCall(node) && !scopes.isDeclared('console')

  function mutate(node: Node, parent: Node | null): void {
    if (node.type === 'CallExpression') references.add(unwrapReference(node.callee))
    else if (node.type === 'TaggedTemplateExpression') references.add(unwrapReference(node.tag))
    else if (node.type === 'UnaryExpression' && node.operator === 'delete') references.add(unwrapReference(node.argument))
    else if (node.type === 'NewExpression') constructed.add(unwrapReference(node.callee))
    switch (node.type) {
      case 'BinaryExpression': {
        const entry = BINARY[node.operator]
        if (!entry) break
        const [operator, replacementOp] = entry
        const { left, right } = node
        // Same value either way; with `1n`, the same TypeError when `x` is not a bigint.
        if ((node.operator === '*' || node.operator === '/') && (isNumber(right, 1) || isNumber(right, 1n))) break
        const at = findToken(code, left.end, right.start, node.operator)
        if (at < 0) break
        if (node.operator === '+' && isConcatenation(node)) break
        const planned = add(node, 'expression', at, operator, edit(node, at, at + node.operator.length, replacementOp),
          `\`${node.operator}\` → \`${replacementOp}\``)
        // `===` → `!==` changes every result; nothing to learn from the values.
        if (planned && operator !== 'Equality') {
          planned.profile = {
            probe: { kind: 'binary', key: 0, start: node.start, end: node.end, at, operator: node.operator, mutated: replacementOp },
            rule: { kind: 'binary', operator: node.operator, mutated: replacementOp, left: snippet(text(left)), right: snippet(text(right)) },
          }
        }
        break
      }
      case 'LogicalExpression': {
        const { left, right } = node
        const at = findToken(code, left.end, right.start, node.operator)
        if (at < 0) break
        if (node.operator === '??') {
          const planned = add(node, 'expression', at, 'Logical', text(left), `\`${snippet(text(node))}\` → \`${snippet(text(left))}\``)
          if (planned) planned.profile = { probe: valueProbe(left), rule: { kind: 'nonNullish', subject: snippet(text(left)), type: nonNullableType(left) } }
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
        if ('regex' in node) {
          for (const { at, literal, from, to } of regexMutations(node.regex.pattern, node.regex.flags)) {
            add(node, 'expression', node.start + at, 'Regex', literal, to === '' ? `\`${from}\` removed` : `\`${snippet(from)}\` → \`${snippet(to)}\``)
          }
          break
        }
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
        if (references.has(node)) break
        for (const link of optionalLinks(node.expression)) {
          const from = link.type === 'MemberExpression' ? link.object : link.callee
          const at = findToken(code, from.end, link.end, '?.')
          if (at < 0) continue
          const dot = link.type === 'MemberExpression' && !link.computed ? '.' : ''
          const planned = add(node, 'expression', at, 'OptionalChaining', edit(node, at, at + 2, dot), `\`?.\` → \`${dot || '(none)'}\``)
          if (!planned) continue
          const subject = snippet(text(from))
          if (link.type === 'MemberExpression') {
            // Cutting the chain at the object of a `?.` is safe: if the part before stops early, the `?.` sees undefined and stops too.
            planned.profile = { probe: valueProbe(link.object), rule: { kind: 'nonNullish', subject, type: nonNullableType(from) } }
          } else {
            const probe = callProbe(code, link)
            if (probe) planned.profile = { probe, rule: { kind: 'called', subject, type: nonNullableType(from) } }
          }
        }
        break
      }
      case 'ExpressionStatement': {
        const call = statementCall(node.expression)
        if (!call) break
        discarded.add(call.site)
        // Without `super()` a derived constructor throws; a global console call only logs.
        if (call.node.callee.type === 'Super' || isGlobalConsoleCall(call.node)) break
        add(call.site, 'expression', calleeAnchor(call.node), 'CallStatement', 'undefined', `\`${snippet(text(call.node))}\` removed`)
        break
      }
      case 'CallExpression': {
        const [first] = node.arguments
        if (!first || first.type === 'SpreadElement') break
        // A call that ends an optional chain stands for the whole chain, which has the same span.
        const site = parent?.type === 'ChainExpression' ? parent : node
        // A call a statement drops is CallStatement's. One that is called, constructed, tagged
        // or deleted is left alone: `f(x)(y)` → `x(y)` only tests that `x` is not a function.
        if (discarded.has(site) || references.has(site) || constructed.has(site)) break
        // `super(x)` → `x` leaves `this` uninitialised; `require('x')` → `'x'` and a global console call say nothing.
        if (node.callee.type === 'Super' || isName(node.callee, 'require') || isGlobalConsoleCall(node)) break
        // The first argument of `f.call(that, x)`, `.apply` and `.bind` is the receiver, not a value the call passes on.
        if (isReceiverCall(node)) break
        // The result of a call that takes a callback is hardly ever that function, or acts the
        // same as it (`useCallback(fn, deps)`): the mutant would only check that the result is used.
        if (first.type === 'FunctionExpression' || first.type === 'ArrowFunctionExpression') break
        // Inside a chain, a `?.` before the call skips the links after it; parentheses around the call would cut them off.
        if (site === node && optionalLinks(node).length > 0) break
        add(site, 'expression', calleeAnchor(node), 'CallUnwrap', text(first), `\`${snippet(text(node))}\` → \`${snippet(text(first))}\``)
        break
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const { body } = node
        if (!body) break
        // A method's header starts with its name: `get size() {`, not `() {`.
        const method = (parent?.type === 'MethodDefinition' || (parent?.type === 'Property' && (parent.method || parent.kind !== 'init'))) &&
          parent.value === node
        const start = method ? parent.start : node.start
        if (body.type === 'BlockStatement') {
          const [first] = body.body
          const onlyReturn = body.body.length === 1 && first?.type === 'ReturnStatement' && first.argument === null
          if (body.body.length === 0 || onlyReturn) break
          const at = body.start + 1
          add({ start: at, end: at }, 'body', body.start, 'FunctionBody', '', 'body → `return`', { start, end: at })
        } else if (!isUndefined(body)) {
          // The mutant replaces the expression, so a change in it counts, as in any expression site, and so does the header.
          add(body, 'expression', body.start, 'FunctionBody', 'undefined', `\`=> ${snippet(text(body))}\` → \`=> undefined\``, { start, end: body.end })
        }
        break
      }
    }
  }

  const scopes = new Scopes()
  const strings = new Strings(scopes)
  // The tracker records a name when the walk reaches its declaration, so a first
  // pass collects them all and the second also sees names declared below their
  // use: hoisted `var` and functions, or a module-level logger defined further down.
  // It also finds the block bodies that `changed` leaves to the functions they belong to.
  walk(parsed.program, null, undefined, scopes, (node) => {
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
      node.body?.type === 'BlockStatement') blocks.push(node.body)
    return undefined
  })
  blocks.sort((a, b) => a.start - b.start)
  scopes.freeze()
  walk<Context>(parsed.program, null, 'module', scopes, (node, parent, context) => {
    if (node.type === 'ExpressionStatement') statements.set(node.start, node)
    if (context === 'console') return context
    const inner = context === 'function' || FUNCTIONS.has(node.type) ? 'function' : 'module'
    if (inner === 'function') mutate(node, parent)
    // A `console` declared in an enclosing scope (a parameter, an import, ...) is the code's own object.
    return isGlobalConsoleCall(node) ? 'console' : inner
  })

  for (const site of sites.values()) {
    const statement = site.kind === 'expression' ? statements.get(site.start) : undefined
    if (statement) site.statement = { start: statement.start, end: statement.end }
  }
  return { parsed, lines, sites }
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
 * its walk calls and the recorded scopes are protected, hence the subclass.
 */
class Scopes extends ScopeTracker implements Bindings {
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

  /** For infer.ts, which resolves a constant's initialiser from where it stands. */
  lookup(name: string, scope: string): ScopeTrackerNode | null {
    // A key extends its parent's: `0-1` is inside `0`, which is inside the root scope ''.
    for (let key = scope; ; key = key.slice(0, Math.max(0, key.lastIndexOf('-')))) {
      const declaration = this.scopes.get(key)?.get(name)
      if (declaration) return declaration
      if (key === '') return null
    }
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

/** Parentheses and type-only wrappers keep a member expression a reference. */
function unwrapReference(node: Node): Node {
  while (
    node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion'
  ) node = node.expression
  return node
}

function isBooleanLiteral(node: Node): boolean {
  return node.type === 'Literal' && typeof node.value === 'boolean'
}

function isNumber(node: Node, value: number | bigint): boolean {
  node = unwrap(node)
  return node.type === 'Literal' && node.value === value
}

function isUndefined(node: Node): boolean {
  node = unwrap(node)
  return (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'UnaryExpression' && node.operator === 'void')
}

/**
 * Whether evaluating `node` does nothing but produce its value, judged by syntax
 * and conservatively: names, literals, member access with a fixed key, and
 * operators over those. No calls, `new`, assignments, updates, `await`, `yield`,
 * tagged templates or `delete`. Getters, proxies and valueOf/toString can still
 * run code here; the profile assumes they do not change anything the tests see.
 */
function isPure(node: Node): boolean {
  switch (node.type) {
    case 'Identifier':
    case 'Literal':
    case 'ThisExpression':
      return true
    case 'ParenthesizedExpression':
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return isPure(node.expression)
    case 'MemberExpression':
      return isPure(node.object) && (!node.computed || node.property.type === 'Literal')
    case 'UnaryExpression':
      return node.operator !== 'delete' && isPure(node.argument)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isPure(node.left) && isPure(node.right)
    case 'ConditionalExpression':
      return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate)
    case 'TemplateLiteral':
      return node.expressions.every(isPure)
    default:
      return false
  }
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

function isName(node: Node, name: string): boolean {
  return node.type === 'Identifier' && node.name === name
}

const RECEIVER_METHODS = new Set(['call', 'apply', 'bind'])

function isReceiverCall(call: CallExpression): boolean {
  const callee = unwrapReference(call.callee)
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && RECEIVER_METHODS.has(callee.property.name)
}

/**
 * The call an expression statement makes (`f(x)`, `await f(x)`, `a?.f(x)`),
 * and what CallStatement replaces: the call, or the optional chain it ends.
 * Under `await` only the call goes, so the statement still waits.
 */
function statementCall(expression: Expression): { node: CallExpression; site: Node } | undefined {
  let node = unwrapReference(expression)
  if (node.type === 'AwaitExpression') node = unwrapReference(node.argument)
  if (node.type === 'ChainExpression' && node.expression.type === 'CallExpression') return { node: node.expression, site: node }
  return node.type === 'CallExpression' ? { node, site: node } : undefined
}

/** The callee's name, where a call shows on its line: `b` in `a\n  .b(x)`. */
function calleeAnchor(call: CallExpression): number {
  const callee = unwrapReference(call.callee)
  return callee.type === 'MemberExpression' ? callee.property.start : callee.start
}

/**
 * A probe that counts the calls an optional call makes, as a spread of an
 * empty array in front of its arguments: it runs only when the callee is not
 * nullish, adds no argument, and leaves the callee (and so `this`) alone.
 */
function callProbe(code: string, link: CallExpression): Probe | undefined {
  const [first] = link.arguments
  if (first) return { kind: 'call', key: 0, at: first.start, args: true }
  // No arguments: the call ends with `)`, even after type arguments.
  const close = link.end - 1
  return code.charAt(close) === ')' ? { kind: 'call', key: 0, at: close, args: false } : undefined
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
