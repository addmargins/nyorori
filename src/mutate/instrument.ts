import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import type { Site } from './generate.ts'

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

export class InstrumentError extends Error {}

/**
 * Inserts all mutants of a file into its source at once (mutant schemata):
 *   site            →  (__nyorori_h(lo, hi) ? (site) : active === lo ? (m1) : (m2))
 *   function body   →  { if (!__nyorori_h(id, id)) return; ...body }
 *   statement start →  { (__nyorori_h(...) ? ...) }   (see Site.statement)
 * Original text stays in place, so the source map is exact outside the inserted code.
 */
export function instrument(file: string, code: string, sites: readonly Site[]): { code: string; map: string } {
  const s = new MagicString(code)
  // Innermost first: at a shared start, later prependRight calls land in front,
  // and at a shared end, later appendLeft calls land behind, so outer sites wrap inner ones.
  const ordered = [...sites].sort((a, b) => a.end - a.start - (b.end - b.start) || b.start - a.start)
  for (const site of ordered) {
    const ids = site.mutants.map((m) => m.mutant.id)
    const lo = Math.min(...ids)
    const hi = Math.max(...ids)
    if (site.kind === 'body') {
      s.appendLeft(site.start, ` if (!__nyorori_h(${lo}, ${hi})) return;`)
      continue
    }
    const branches = site.mutants.map((m, i) =>
      i === site.mutants.length - 1 ? `(${m.replacement})` : `${STATE}.active === ${m.mutant.id} ? (${m.replacement}) : `,
    )
    s.prependRight(site.start, `(__nyorori_h(${lo}, ${hi}) ? (`)
    s.appendLeft(site.end, `) : ${branches.join('')})`)
  }
  // After all sites, so the braces land outside every wrapper at the same position.
  const statements = new Map(sites.flatMap((site) => (site.statement ? [[site.statement.start, site.statement] as const] : [])))
  for (const statement of statements.values()) {
    s.prependRight(statement.start, '{ ')
    s.appendLeft(statement.end, ' }')
  }
  s.append(HELPER)

  const output = s.toString()
  const check = parseSync(file, output)
  if (check.errors.length > 0) {
    throw new InstrumentError(`${file}: instrumented code does not parse: ${check.errors[0]!.message}`)
  }
  const map = s.generateMap({ hires: 'boundary', source: file, includeContent: true })
  return { code: output, map: map.toString() }
}
