import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Span } from 'oxc-parser'
import type * as Ast from 'tsrs/unstable/ast'
import type * as Api from 'tsrs/unstable/sync'
import type { TypesUsage, UntypedFile } from '../types.ts'

/** What a `+` does: join strings, add numbers or bigints, or unknown without types. */
export type PlusKind = 'string' | 'numeric' | 'unknown'

/** Tells string concatenation apart from arithmetic where the syntax cannot. */
export interface TypeOracle {
  /** `left` and `right` are the operands of one `+` in `file`, as oxc-parser spans (UTF-16 offsets). */
  plus(file: string, left: Span, right: Span): PlusKind
}

/** The two tsrs entry points this module uses. Tests inject a loader that fails. */
export interface Tsrs {
  api: typeof Api
  ast: typeof Ast
}

const TYPESCRIPT = /\.[cm]?tsx?$/

const NOT_ASKED = 'no `+` on a changed line of a TypeScript file'
const NO_PROJECT = 'not in any tsconfig.json project'

/** Loads tsrs on first use: it is an optional dependency, and the modules alone take about 100 ms. */
export function loadTsrs(): Tsrs {
  const require = createRequire(import.meta.url)
  return { api: require('tsrs/unstable/sync'), ast: require('tsrs/unstable/ast') }
}

interface Typed {
  checker: Api.Checker
  source: Ast.SourceFile
}

/**
 * Types from tsrs, a Rust port of the TypeScript 7 compiler, through its
 * unstable synchronous API. The tsrs process starts on the first question
 * about a TypeScript file and stops at close(). Each file is opened the way an
 * editor opens it, so tsrs finds its project from the nearest tsconfig.json,
 * following references; a project loads once and serves every file in it.
 * Any failure turns the answers into 'unknown', never into an exception.
 */
export class TsrsTypes implements TypeOracle {
  private readonly root: string
  private readonly load: () => Tsrs
  private tsrs: Tsrs | undefined
  private api: Api.API | undefined
  private snapshot: Api.Snapshot | undefined
  /** Why tsrs cannot answer; once set, every file falls back to syntax. */
  private failure: string | undefined
  private closed = false
  /** Per file: what answers its questions, or why nothing does. */
  private readonly files = new Map<string, Typed | string>()

  constructor(root: string, load: () => Tsrs = loadTsrs) {
    this.root = root
    this.load = load
  }

  plus(file: string, left: Span, right: Span): PlusKind {
    if (this.closed || !TYPESCRIPT.test(file)) return 'unknown'
    const typed = this.open(file)
    if (typeof typed === 'string' || !this.tsrs) return 'unknown'
    try {
      const { ast, api } = this.tsrs
      // The left operand ends where the `+` token's leading trivia starts.
      const binary = ast.getTokenAtPosition(typed.source, left.end).parent
      // Offsets disagree when tsrs reads the text differently, e.g. without a byte order mark.
      if (!ast.isBinaryExpression(binary) || binary.operatorToken.kind !== ast.SyntaxKind.PlusToken ||
        binary.left.end !== left.end || binary.right.end !== right.end) return 'unknown'
      const [whole, l, r] = typed.checker.getTypeAtLocation([binary, binary.left, binary.right])
      return classify(api.TypeFlags, whole!, l!, r!)
    } catch (error) {
      this.fail(`tsrs failed: ${message(error)}`)
      this.files.set(file, this.failure!)
      return 'unknown'
    }
  }

  usage(): TypesUsage {
    const untyped: UntypedFile[] = []
    for (const [file, entry] of this.files) if (typeof entry === 'string') untyped.push({ file, reason: entry })
    const files = this.files.size - untyped.length
    if (files > 0) return { backend: 'tsrs', files, untyped }
    return { backend: 'none', reason: this.failure ?? untyped[0]?.reason ?? NOT_ASKED, untyped }
  }

  /** Stops the tsrs process. Later questions get 'unknown'. */
  close(): void {
    this.closed = true
    this.stop()
  }

  private open(file: string): Typed | string {
    let entry = this.files.get(file)
    if (entry === undefined) {
      entry = this.project(file)
      this.files.set(file, entry)
    }
    return entry
  }

  private project(file: string): Typed | string {
    const snapshot = this.start()
    if (typeof snapshot === 'string') return snapshot
    try {
      this.snapshot = snapshot.update({ openFiles: [file] })
      const project = this.snapshot.getDefaultProjectForFile(file)
      // A file outside every tsconfig.json lands in an inferred project with default options.
      const source = project?.configFileName ? project.program.getSourceFile(file) : undefined
      if (!project || !source) return NO_PROJECT
      return { checker: project.checker, source }
    } catch (error) {
      this.fail(`tsrs failed: ${message(error)}`)
      return this.failure!
    }
  }

  private start(): Api.Snapshot | string {
    if (this.snapshot) return this.snapshot
    if (this.failure) return this.failure
    try {
      this.tsrs = this.load()
      this.api = new this.tsrs.api.API({ cwd: this.root })
      ignoreSpawnErrors(this.api)
      // The first request is what reaches the process, so a binary that cannot run fails here.
      this.snapshot = this.api.createSnapshot()
      return this.snapshot
    } catch (error) {
      this.fail(`tsrs is unavailable: ${message(error)}`)
      return this.failure!
    }
  }

  /** The API is unstable; after one failure nothing it says is trusted, and its process goes. */
  private fail(reason: string): void {
    this.failure ??= reason
    this.stop()
  }

  private stop(): void {
    try {
      // Also kills the process when releasing the snapshots fails.
      this.api?.close()
    } catch {
      // Already gone.
    }
    this.api = undefined
    this.snapshot = undefined
  }
}

/**
 * The type of the whole `+` is how the checker resolved it: `string` when
 * either side is string-like (a template literal type, a string enum, a type
 * parameter constrained to string), `number` or `bigint` when both sides are.
 */
function classify(flags: typeof Api.TypeFlags, whole: Api.Type, left: Api.Type, right: Api.Type): PlusKind {
  if (whole.flags & flags.StringLike) return 'string'
  if (whole.flags & (flags.NumberLike | flags.BigIntLike)) return 'numeric'
  // A `+` that does not type-check, like `string | undefined` plus a number, is `any`;
  // a string among an operand's possible types still makes it a concatenation.
  const mayBeString = (type: Api.Type) =>
    (type.flags & flags.StringLike) !== 0 || (type.isUnionType() && type.getTypes().some((t) => (t.flags & flags.StringLike) !== 0))
  return mayBeString(left) || mayBeString(right) ? 'string' : 'unknown'
}

/**
 * A binary that cannot be spawned (no execute permission, a noexec mount)
 * makes the child process emit 'error' on a later tick, which would crash the
 * CLI with no listener. The request that fails reports it instead. The child
 * is internal to tsrs's client; with another layout this does nothing.
 */
function ignoreSpawnErrors(api: object): void {
  let value: unknown = api
  for (const key of ['client', 'channel', 'child']) value = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
  if (value instanceof EventEmitter) value.on('error', () => {})
}

function message(error: unknown): string {
  // tsrs explains a missing binary over several lines; the first one names the problem.
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/\.$/, '')
}
