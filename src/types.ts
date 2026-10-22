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
  /** Why no test can notice the mutant, when the baseline profile shows it, e.g. "no test makes `user` null or undefined here". */
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
 * Whether operand types told string concatenation apart from arithmetic.
 * `files` counts the TypeScript files whose `+` on changed lines were answered
 * from types; `reason` says why no file was.
 */
export type TypesUsage =
  | { backend: 'tsrs'; files: number; untyped: UntypedFile[] }
  | { backend: 'none'; reason: string; untyped: UntypedFile[] }

/** What the CLI hands to the Vitest session for one source file. */
export interface FilePlan {
  file: string
  original: string
  instrumented: string
  map: string
  /** The same with value probes, for the baseline run only (see mutate/profile.ts). */
  profiled: { code: string; map: string }
}
