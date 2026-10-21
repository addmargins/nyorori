import { minifySync } from 'oxc-minify'
import { transformSync } from 'oxc-transform'
import type { EquivalentMutant } from '../types.ts'
import type { PlannedMutant, Site } from './generate.ts'

// The minifier only reads plain JavaScript, so types and JSX are stripped first.
const NEEDS_TRANSFORM = /\.(?:[cm]?ts|[jt]sx)$/
const COMMONJS = /\.c[jt]s$/

/**
 * Trivial Compiler Equivalence (TCE): drops every mutant whose file minifies
 * to exactly the original's minified code, e.g. a change in a dead branch.
 * Returns the sites that still have mutants and the mutants it dropped.
 */
export function dropEquivalent(file: string, code: string, sites: Site[]): { sites: Site[]; equivalent: EquivalentMutant[] } {
  const equivalent: EquivalentMutant[] = []
  if (sites.length === 0) return { sites, equivalent }
  const original = normalize(file, code)
  if (original === undefined) return { sites, equivalent }
  const kept: Site[] = []
  for (const site of sites) {
    const mutants = site.mutants.filter((planned) => {
      if (normalize(file, applyMutant(code, site, planned)) !== original) return true
      const { id: _, ...mutant } = planned.mutant
      equivalent.push(mutant)
      return false
    })
    if (mutants.length > 0) kept.push({ ...site, mutants })
  }
  return { sites: kept, equivalent }
}

/**
 * Minified JavaScript for a source file, or undefined when oxc reports an
 * error or produces nothing. On input it cannot parse (TypeScript included),
 * the minifier returns empty code plus errors instead of throwing, so two
 * failures would otherwise compare equal and drop a real mutant.
 */
export function normalize(file: string, code: string): string | undefined {
  try {
    let js = code
    if (NEEDS_TRANSFORM.test(file)) {
      const transformed = transformSync(file, code)
      if (transformed.errors.length > 0 || transformed.code.trim() === '') return undefined
      js = transformed.code
    }
    const commonjs = COMMONJS.test(file)
    const minified = minifySync(commonjs ? 'file.cjs' : 'file.js', js, { module: !commonjs, mangle: false, compress: { target: 'esnext' } })
    if (minified.errors.length > 0 || minified.code.trim() === '') return undefined
    return minified.code
  } catch {
    return undefined
  }
}

/**
 * The whole file with one mutant applied. The replacement is parenthesized, as
 * in the instrumented code, so that operator precedence cannot regroup it
 * (`a && b && c` with the inner `&&` → `||`). At the start of a line a `(`
 * would continue a previous line that has no semicolon, so it is left bare there.
 */
function applyMutant(code: string, site: Site, planned: PlannedMutant): string {
  if (site.kind === 'body') return `${code.slice(0, site.start)} return;${code.slice(site.start)}`
  const lineStart = code.lastIndexOf('\n', site.start - 1) + 1
  const replacement = code.slice(lineStart, site.start).trim() === '' ? planned.replacement : `(${planned.replacement})`
  return code.slice(0, site.start) + replacement + code.slice(site.end)
}
