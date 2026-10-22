/**
 * Mutations of one regular expression literal: one flag removed, a top-level
 * `^` or `$` removed, a character class negated, or a shorthand class swapped
 * for its complement (`\d` ↔ `\D`, `\w` ↔ `\W`, `\s` ↔ `\S`).
 *
 * Every mutated literal is checked with `new RegExp` here, in the CLI. oxc
 * parses a literal without checking its pattern, so an invalid one would only
 * fail when Vitest loads the instrumented file, and every test would fail.
 */

export interface RegexMutation {
  /** Offset of the changed part in the literal's text (`/` included), for the anchor. */
  at: number
  /** The whole mutated literal. */
  literal: string
  /** The changed part before and after; `to` is empty when it is removed. */
  from: string
  to: string
}

/** The parts of a pattern the mutations change, from one pass over it. */
interface Scan {
  /** Outermost character classes, as [start, end) in the pattern. */
  classes: Array<[start: number, end: number]>
  /** Where `\d`, `\D`, `\w`, `\W`, `\s` or `\S` starts. */
  shorthands: number[]
  /** `^` and `$` outside classes and groups. */
  anchors: number[]
  /** A `^` or `$` outside classes, at any depth: only those read the `m` flag. */
  lineAnchors: boolean
  /** A `.` outside classes: only that reads the `s` flag. */
  dot: boolean
}

const SHORTHAND = /[dDwWsS]/

export function regexMutations(pattern: string, flags: string): RegexMutation[] {
  // A pattern this Node cannot compile would be scanned on guesses.
  if (!compiles(pattern, flags)) return []
  const scan = scanPattern(pattern, flags.includes('v'))
  const mutations: RegexMutation[] = []
  const add = (at: number, mutated: string, mutatedFlags: string, from: string, to: string) => {
    // `//` would be a comment.
    const body = mutated === '' ? '(?:)' : mutated
    // A pattern that starts with `*` would open a comment; it is never valid anyway.
    if (body.startsWith('*') || !compiles(body, mutatedFlags)) return
    mutations.push({ at, literal: `/${body}/${mutatedFlags}`, from, to })
  }

  for (const index of scan.anchors) {
    add(1 + index, pattern.slice(0, index) + pattern.slice(index + 1), flags, pattern[index]!, '')
  }
  for (const [start, end] of scan.classes) {
    const negated = pattern[start + 1] === '^'
    const inner = pattern.slice(start + (negated ? 2 : 1), end - 1)
    const to = negated ? `[${inner}]` : `[^${inner}]`
    add(1 + start, pattern.slice(0, start) + to + pattern.slice(end), flags, pattern.slice(start, end), to)
  }
  for (const index of scan.shorthands) {
    const letter = pattern[index + 1]!
    const other = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
    add(1 + index, `${pattern.slice(0, index + 1)}${other}${pattern.slice(index + 2)}`, flags, `\\${letter}`, `\\${other}`)
  }
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    // Without `^`, `$` or `.`, these flags change nothing.
    if (flag === 'm' && !scan.lineAnchors) continue
    if (flag === 's' && !scan.dot) continue
    const rest = flags.slice(0, i) + flags.slice(i + 1)
    add(pattern.length + 2 + i, pattern, rest, `/…/${flags}`, `/…/${rest}`)
  }
  return mutations.sort((a, b) => a.at - b.at)
}

function compiles(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags)
    return true
  } catch {
    return false
  }
}

/**
 * One pass over a pattern that compiles. An escape is skipped as two
 * characters: what follows a multi-character escape (`\u{41}`, `\p{L}`,
 * `\k<name>`) holds no bracket, parenthesis, anchor or dot. Inside a class,
 * `[` opens a nested class only with the `v` flag.
 */
function scanPattern(pattern: string, unicodeSets: boolean): Scan {
  const scan: Scan = { classes: [], shorthands: [], anchors: [], lineAnchors: false, dot: false }
  let groups = 0
  // Nesting of classes; 0 is outside any.
  let depth = 0
  let classStart = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      if (SHORTHAND.test(pattern[i + 1] ?? '')) scan.shorthands.push(i)
      i++
    } else if (depth > 0) {
      if (c === '[' && unicodeSets) {
        depth++
      } else if (c === ']') {
        depth--
        if (depth === 0) scan.classes.push([classStart, i + 1])
      }
    } else if (c === '[') {
      depth = 1
      classStart = i
      // `[^]` holds no `]` to close it early, and `[]` closes right away, as in the engine.
      if (pattern[i + 1] === '^') i++
    } else if (c === '(') {
      groups++
    } else if (c === ')') {
      groups--
    } else if (c === '^' || c === '$') {
      scan.lineAnchors = true
      if (groups === 0) scan.anchors.push(i)
    } else if (c === '.') {
      scan.dot = true
    }
  }
  return scan
}
