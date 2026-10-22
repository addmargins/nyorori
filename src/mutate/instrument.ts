import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import type { Site } from './generate.ts'
import { CLASS, FLAG, OBJECTS, SLOTS, STRINGS, type Probe } from './profile.ts'

const STATE = 'globalThis.__nyorori'

/**
 * Runtime check emitted once per instrumented file. Returns true when none of
 * the site's mutants is active, so the original code runs. In the baseline run
 * it counts hits; in a mutant run it throws once the active mutant is hit more
 * often than its limit, which stops infinite loops the mutant may cause.
 */
const HELPER = `
function __nyorori_h(lo, hi) {
  const s = ${STATE};
  if (s === undefined) return true;
  if (s.hits !== null) for (let i = lo; i <= hi; i++) s.hits[i] = (s.hits[i] ?? 0) + 1;
  if (s.active < lo || s.active > hi) return true;
  if (s.limit > 0 && ++s.count > s.limit) {
    s.exceeded = true;
    throw new Error("nyorori: mutant " + s.active + " exceeded its hit limit (likely an infinite loop)");
  }
  return false;
}
`

/**
 * Probes of the profiled instrumentation (see profile.ts). Each writes into the
 * test file's buffer `s.prof` at its slot offset `k` and gives back exactly what
 * the original code would have: they are function declarations, so they work
 * before the module body below them has run. No BigInt literal, which a low
 * build target would reject.
 */
const PROBE_HELPER = `
function __nyorori_c(v) {
  switch (typeof v) {
    case 'undefined': return ${CLASS.undefined};
    case 'object': return v === null ? ${CLASS.null} : ${CLASS.object};
    case 'boolean': return v ? ${CLASS.true} : ${CLASS.false};
    case 'number': return v === 0 ? ${CLASS.zero} : v !== v ? ${CLASS.NaN} : ${CLASS.number};
    case 'string': return v === '' ? ${CLASS.emptyString} : ${CLASS.string};
    case 'bigint': return v == 0 ? ${CLASS.zeroBigint} : ${CLASS.bigint};
    case 'symbol': return ${CLASS.symbol};
    case 'function': return ${CLASS.function};
  }
  return ${CLASS.object};
}
function __nyorori_v(k, v) {
  const s = ${STATE};
  const p = s === undefined ? null : s.prof;
  if (p != null) {
    p[k] |= __nyorori_c(v);
    p[k + 3]++;
  }
  return v;
}
function __nyorori_e(k) {
  const s = ${STATE};
  const p = s === undefined ? null : s.prof;
  if (p != null) p[k + 3]++;
  return [];
}
`

/**
 * A binary probe for one operator and its mutation. It applies `operator` once,
 * after both operands are evaluated, as the original does. It tries `mutated`
 * only on primitives, where no user code runs, and stops trying once it differed.
 * Flags are ORed in at the end: valueOf may run this same probe again in between.
 */
function binaryHelper(name: string, operator: string, mutated: string): string {
  return `
function ${name}(k, a, b) {
  const s = ${STATE};
  const p = s === undefined ? null : s.prof;
  if (p == null) return a ${operator} b;
  const ca = __nyorori_c(a), cb = __nyorori_c(b);
  p[k] |= ca;
  p[k + 1] |= cb;
  p[k + 3]++;
  let f = (ca | cb) & ${STRINGS} ? ${FLAG.string} : ${FLAG.noString};
  let r;
  try {
    r = a ${operator} b;
  } catch (e) {
    p[k + 2] |= f | ${FLAG.changed};
    throw e;
  }
  if ((p[k + 2] & ${FLAG.changed | FLAG.unknown}) === 0) {
    if ((ca | cb) & ${OBJECTS}) f |= ${FLAG.unknown};
    else try { if (!Object.is(a ${mutated} b, r)) f |= ${FLAG.changed}; } catch (e) { f |= ${FLAG.changed}; }
  }
  p[k + 2] |= f;
  return r;
}
`
}

export class InstrumentError extends Error {}

/**
 * Inserts all mutants of a file into its source at once (mutant schemata):
 *   site            →  (__nyorori_h(lo, hi) ? (site) : active === lo ? (m1) : (m2))
 *   function body   →  { if (!__nyorori_h(id, id)) return; ...body }
 *   statement start →  { (__nyorori_h(...) ? ...) }   (see Site.statement)
 * Original text stays in place, so the source map is exact outside the inserted code.
 *
 * With `profile`, the original text also gets the probes of the baseline run
 * (see Probe). They only ever land in the original branch of a site: the
 * mutants' replacements are plain source text.
 */
export function instrument(file: string, code: string, sites: readonly Site[], options: { profile?: boolean } = {}): { code: string; map: string } {
  const s = new MagicString(code)
  // Each wrapper as [span, rank, start, apply]. Innermost first: at a shared start,
  // later prependRight calls land in front, and at a shared end, later appendLeft
  // calls land behind, so outer wrappers wrap inner ones. At an equal span a
  // binary probe goes inside a value probe, and both inside the site.
  const wraps: Array<[span: number, rank: number, start: number, apply: () => void]> = []
  for (const site of sites) {
    const ids = site.mutants.map((m) => m.mutant.id)
    const lo = Math.min(...ids)
    const hi = Math.max(...ids)
    wraps.push([site.end - site.start, 2, site.start, () => {
      if (site.kind === 'body') {
        s.appendLeft(site.start, ` if (!__nyorori_h(${lo}, ${hi})) return;`)
        return
      }
      const branches = site.mutants.map((m, i) =>
        i === site.mutants.length - 1 ? `(${m.replacement})` : `${STATE}.active === ${m.mutant.id} ? (${m.replacement}) : `,
      )
      s.prependRight(site.start, `(__nyorori_h(${lo}, ${hi}) ? (`)
      s.appendLeft(site.end, `) : ${branches.join('')})`)
    }])
  }
  // Mutants that read the same record share one probe object.
  const probes = new Set(options.profile ? sites.flatMap((site) => site.mutants.flatMap((m) => (m.profile ? [m.profile.probe] : []))) : [])
  const binaries = new Map<string, string>()
  for (const probe of probes) {
    const k = probe.key * SLOTS
    switch (probe.kind) {
      case 'value':
        wraps.push([probe.end - probe.start, 1, probe.start, () => {
          s.prependRight(probe.start, `__nyorori_v(${k}, `)
          s.appendLeft(probe.end, ')')
        }])
        break
      case 'binary': {
        const name = binaryName(binaries, probe)
        wraps.push([probe.end - probe.start, 0, probe.start, () => {
          s.prependRight(probe.start, `${name}(${k}, `)
          s.overwrite(probe.at, probe.at + probe.operator.length, ',', { contentOnly: true })
          s.appendLeft(probe.end, ')')
        }])
        break
      }
      case 'call':
        // Left of `at`, so it stays in front of whatever wraps the first argument.
        s.appendLeft(probe.at, probe.args ? `...__nyorori_e(${k}), ` : `...__nyorori_e(${k})`)
        break
    }
  }
  wraps.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2])
  for (const [, , , apply] of wraps) apply()
  // After all sites, so the braces land outside every wrapper at the same position.
  const statements = new Map(sites.flatMap((site) => (site.statement ? [[site.statement.start, site.statement] as const] : [])))
  for (const statement of statements.values()) {
    s.prependRight(statement.start, '{ ')
    s.appendLeft(statement.end, ' }')
  }
  s.append(HELPER)
  if (probes.size > 0) {
    s.append(PROBE_HELPER)
    for (const [key, name] of binaries) {
      const [operator, mutated] = key.split(' ') as [string, string]
      s.append(binaryHelper(name, operator, mutated))
    }
  }

  const output = s.toString()
  const check = parseSync(file, output)
  if (check.errors.length > 0) {
    throw new InstrumentError(`${file}: instrumented code does not parse: ${check.errors[0]!.message}`)
  }
  const map = s.generateMap({ hires: 'boundary', source: file, includeContent: true })
  return { code: output, map: map.toString() }
}

/** One helper per operator and mutation used in the file, so no helper has to dispatch on the operator. */
function binaryName(names: Map<string, string>, probe: Extract<Probe, { kind: 'binary' }>): string {
  const key = `${probe.operator} ${probe.mutated}`
  let name = names.get(key)
  if (name === undefined) {
    name = `__nyorori_b${names.size}`
    names.set(key, name)
  }
  return name
}
