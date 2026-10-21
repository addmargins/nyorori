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
}

/** A finding about the suppression comments themselves. */
export interface SuppressionProblem {
  file: string
  line: number
  message: string
}

/** What the CLI hands to the Vitest session for one source file. */
export interface FilePlan {
  file: string
  original: string
  instrumented: string
  map: string
}
