/**
 * Runtime value profiling. The baseline run serves instrumentation with probes
 * in the original branch of each site; they record what kinds of values flowed
 * through it. A mutant whose change made no difference in any observed
 * evaluation survives the same tests for sure, as long as the tests are
 * deterministic, so it is reported without running it. Mutant runs get the
 * plain instrumentation, without probes.
 *
 * A profile only says what the tests did, not what the code can do: a value
 * that was never null in the tests is still a value the tests never checked.
 */

/** Kinds of values. A probe ORs together the classes it saw. */
export const CLASS = {
  undefined: 1 << 0,
  null: 1 << 1,
  false: 1 << 2,
  true: 1 << 3,
  zero: 1 << 4,
  NaN: 1 << 5,
  number: 1 << 6,
  emptyString: 1 << 7,
  string: 1 << 8,
  zeroBigint: 1 << 9,
  bigint: 1 << 10,
  symbol: 1 << 11,
  function: 1 << 12,
  object: 1 << 13,
} as const

export const NULLISH = CLASS.undefined | CLASS.null
export const FALSY = NULLISH | CLASS.false | CLASS.zero | CLASS.NaN | CLASS.emptyString | CLASS.zeroBigint
export const STRINGS = CLASS.emptyString | CLASS.string
/** Operators on these run user code (valueOf, toString, Symbol.toPrimitive). */
export const OBJECTS = CLASS.function | CLASS.object

/** What a binary probe records besides the operand classes. */
export const FLAG = {
  /** An evaluation had a string operand. */
  string: 1,
  /** An evaluation had no string operand. */
  noString: 2,
  /** The mutated operator gave another value, or an operator threw. */
  changed: 4,
  /** An operand was an object, so the mutated operator was not tried: it would run valueOf or toString a second time. */
  unknown: 8,
} as const

/**
 * Numbers each probe owns in the profile buffer: [classes, classes of the right
 * operand, flags, evaluations]. A value probe uses the first, a call probe only the count.
 */
export const SLOTS = 4

/**
 * Where the profiled instrumentation records values. Mutants that need the same
 * record share one probe. `key` is the id of the first mutant that reads it
 * (0 until ids are assigned), so keys are unique across files.
 */
export type Probe =
  /** `E` → `__nyorori_v(k, E)`: the classes of E's values. */
  | { kind: 'value'; key: number; start: number; end: number }
  /**
   * `L op R` → `__nyorori_bN(k, L, R)`, with the operator token at `at`: operand
   * classes, string operands, and whether `mutated` would have given another value.
   */
  | { kind: 'binary'; key: number; start: number; end: number; at: number; operator: string; mutated: string }
  /**
   * An optional call `f?.(...)` → `f?.(...__nyorori_e(k), ...)`, inserted at
   * `at` (before the first argument, or before `)` when `args` is false): how
   * often the call happened. Wrapping the callee instead would lose `this` in `o.m?.()`.
   */
  | { kind: 'call'; key: number; at: number; args: boolean }

/** What a mutant needs from its probe to be certain to survive. */
export type Rule =
  /** OptionalChaining on a member access, `a ?? b` → `a`: `subject` is never nullish. */
  | { kind: 'nonNullish'; subject: string }
  /** OptionalChaining on a call: the call happens in every evaluation of the site, so `subject` is never nullish. */
  | { kind: 'called'; subject: string }
  /** ComparisonBoundary, Arithmetic: `mutated` never gives another value than `operator`. */
  | { kind: 'binary'; operator: string; mutated: string; left: string; right: string }
  /** Condition → `value` on a test without side effects: the test always has that truthiness. */
  | { kind: 'condition'; value: boolean }

export type Prediction =
  /** The mutant behaves like the original in every observed evaluation. */
  | { verdict: 'survives'; reason: string }
  /** A `+` that only ever joined strings; it is not mutated, like a `+` with a string literal. */
  | { verdict: 'concatenation'; reason: string }

/** A probe's record, summed over test files. */
export type ProbeRecord = [classes: number, right: number, flags: number, count: number]

/** Merges the per-test-file records of the baseline run into `into`, keyed by probe key. */
export function mergeProfile(into: Map<number, ProbeRecord>, records: Record<string, number[]>): void {
  for (const [key, record] of Object.entries(records)) {
    const [classes = 0, right = 0, flags = 0, count = 0] = record
    const merged = into.get(Number(key))
    if (merged) {
      merged[0] |= classes
      merged[1] |= right
      merged[2] |= flags
      merged[3] += count
    } else {
      into.set(Number(key), [classes, right, flags, count])
    }
  }
}

const COMPARISONS = new Set(['<', '<=', '>', '>='])

/**
 * What the profile settles about one mutant, if anything. `evaluations` is how
 * often the baseline evaluated the mutant's site (its hits, over all test files).
 * A probe that never recorded anything settles nothing: NoCoverage covers code
 * the tests never run.
 */
export function predict(rule: Rule, record: ProbeRecord | undefined, evaluations: number): Prediction | undefined {
  if (!record || record[3] === 0) return undefined
  const [classes, right, flags, count] = record
  const survives = (reason: string): Prediction => ({ verdict: 'survives', reason })
  switch (rule.kind) {
    case 'nonNullish':
      // An evaluation that threw before the probe recorded nothing, but the mutant throws the same way.
      return (classes & NULLISH) === 0 ? survives(`no test makes \`${rule.subject}\` null or undefined here`) : undefined
    case 'called':
      // Fewer calls than evaluations: the callee was nullish, or the chain stopped or threw before it.
      return count === evaluations ? survives(`no test makes \`${rule.subject}\` null or undefined here`) : undefined
    case 'binary': {
      if (rule.operator === '+' && (flags & FLAG.string) !== 0 && (flags & FLAG.noString) === 0) {
        return { verdict: 'concatenation', reason: 'string concatenation in every observed evaluation' }
      }
      if ((flags & (FLAG.changed | FLAG.unknown)) !== 0) return undefined
      return survives(binaryReason(rule, classes, right))
    }
    case 'condition': {
      // An evaluation that threw recorded nothing, and a hard-coded value would not have thrown.
      if (count !== evaluations) return undefined
      const truthy = (classes & ~FALSY) !== 0
      const falsy = (classes & FALSY) !== 0
      if (rule.value ? falsy : truthy) return undefined
      const word = rule.value ? (classes === CLASS.true ? 'true' : 'truthy') : (classes === CLASS.false ? 'false' : 'falsy')
      return survives(`the condition was always ${word} in tests`)
    }
  }
}

function binaryReason(rule: Extract<Rule, { kind: 'binary' }>, left: number, right: number): string {
  if (COMPARISONS.has(rule.operator)) {
    // `undefined <= undefined` is false like `undefined < undefined`, though the operands are equal.
    if (((left | right) & CLASS.undefined) === 0) return `no test has \`${rule.left} === ${rule.right}\``
    return `\`${rule.operator}\` and \`${rule.mutated}\` gave the same result in every test`
  }
  if ((rule.operator === '+' || rule.operator === '-') && right === CLASS.zero) return `\`${rule.right}\` was always 0`
  if (rule.operator !== '+' && rule.operator !== '-' && left === CLASS.zero) return `\`${rule.left}\` was always 0`
  return `\`${rule.operator}\` and \`${rule.mutated}\` gave the same value in every test`
}
