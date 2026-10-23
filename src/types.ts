export const OPERATORS = [
  'ComparisonBoundary',
  'Equality',
  'Logical',
  'Arithmetic',
  'UnaryMinus',
  'Update',
  'BooleanLiteral',
  'Negation',
  'Condition',
  'FunctionBody',
  'OptionalChaining',
  'CallUnwrap',
  'CallStatement',
  'Regex',
] as const

export type Operator = (typeof OPERATORS)[number]

export function isOperator(name: string): name is Operator {
  return (OPERATORS as readonly string[]).includes(name)
}

export interface Mutant {
  id: number
  /** Absolute path. */
  file: string
  /** 1-based line of the anchor (the token the mutant changes). */
  line: number
  /** 1-based column of the anchor. */
  column: number
  operator: Operator
  /** Short human-readable form of the change, e.g. "`>=` → `>`". */
  description: string
}

/** A mutant dropped before instrumentation because it minifies to the original code (TCE). It never runs, so it has no id. */
export type EquivalentMutant = Omit<Mutant, 'id'>

export type MutantStatus = 'Killed' | 'Timeout' | 'Survived' | 'NoCoverage' | 'Ignored'

export interface Suppression {
  file: string
  /** 1-based line of the comment. */
  line: number
  /** 1-based line the comment applies to. */
  targetLine: number
  operators: Operator[]
  reason: string
  /** The comment itself is on a line this PR changed. */
  isNew: boolean
}

export interface MutantResult extends Mutant {
  status: MutantStatus
  suppression?: Suppression
  /** Test files that executed the mutant in the baseline run, relative to the root. */
  tests: string[]
  /**
   * Why no test notices the mutant. The baseline profile's reason when it
   * shows one, e.g. "no test makes `user` null or undefined here"; otherwise,
   * on every Survived and NoCoverage result, "every test still passes with
   * this change" or "no test runs this code". A dry run judges nothing and gives none.
   */
  reason?: string
  /** The status comes from the profile alone: the mutant was not run. */
  predicted?: boolean
  /** Run with --no-predict, the mutant was this instead of Survived, as the profile said it would be. */
  mispredicted?: MutantStatus
}

/** A mutant that was instrumented but not judged, because the baseline run showed it is out of scope. */
export interface SkippedMutant extends Mutant {
  reason: string
}

/**
 * A `?.` or `??` mutant not run because the value it guards cannot be null or
 * undefined by its type, and no test made it so: probably redundant defensive
 * code. It never fails the run.
 */
export interface UnnecessaryMutant extends Mutant {
  /** E.g. "`user` is `User` by its type, which can't be null or undefined, and no test passed null or undefined". */
  reason: string
  /** Test files that executed the mutant in the baseline run, relative to the root. */
  tests: string[]
  /** Run with --no-predict, the mutant was this instead of Survived. */
  mispredicted?: MutantStatus
}

/** A finding about the suppression comments themselves. */
export interface SuppressionProblem {
  file: string
  line: number
  message: string
}

/** A TypeScript file with a `+` on a changed line that was judged by syntax alone. */
export interface UntypedFile {
  /** Absolute path. */
  file: string
  reason: string
}

/**
 * Whether types were used: to tell string concatenation apart from arithmetic,
 * and which `?.` and `??` guard values that cannot be null. `files` counts the
 * files whose questions on changed lines were answered from types; `reason`
 * says why no file was. `untyped` lists only files with a `+`: without types,
 * a `?.` or `??` is judged as it always was.
 */
export type TypesUsage =
  | { backend: 'typescript'; files: number; untyped: UntypedFile[] }
  | { backend: 'none'; reason: string; untyped: UntypedFile[] }

/**
 * Why nyorori did not judge a changed file. Only `unsupported` stops the run
 * (exit 2): those files hold code nyorori would be expected to check. The
 * Vitest root and coverage reasons are warnings, as they can hide a wrong
 * config; the rest is what nyorori never mutates.
 */
export type NotJudgedReason =
  /** A component format nyorori cannot mutate (.vue, .svelte, ...) that --exclude does not match. */
  | 'unsupported'
  | 'outside-root'
  | 'coverage-include'
  | 'coverage-exclude'
  | 'excluded'
  /** A test file, type test, benchmark or setup file of a Vitest project. */
  | 'test'
  /** A Vitest or Vite config file. */
  | 'config'
  | 'declaration'
  | 'node_modules'
  | 'deleted'

/** A changed JavaScript, TypeScript or component file that got no mutants without being looked at. */
export interface NotJudgedFile {
  /** Relative to the git root. */
  file: string
  reason: NotJudgedReason
}

/** What the CLI hands to the Vitest session for one source file. */
export interface FilePlan {
  file: string
  original: string
  instrumented: string
  map: string
  /** The same with value probes, for the baseline run only (see mutate/profile.ts). */
  profiled: { code: string; map: string }
}
