import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** The project's Vitest setup keeps nyorori from running. The message alone tells the user why. */
export class ProjectError extends Error {}

/**
 * Finds the directory of the Vitest package the project runs its tests with.
 * A project on Vite+ gets the Vitest that vite-plus depends on, as `vp test`
 * does: under pnpm it is often the only copy the project can reach.
 */
export function findVitest(root: string): string {
  const fromRoot = createRequire(path.join(root, 'package.json'))
  if (dependsOnVitePlus(root)) {
    const vitePlus = resolvePackage(fromRoot, 'vite-plus')
    const vitest = vitePlus && resolvePackage(createRequire(path.join(vitePlus, 'package.json')), 'vitest')
    if (vitest) return vitest
  }
  const vitest = resolvePackage(fromRoot, 'vitest')
  if (vitest) return vitest
  throw new ProjectError(`Cannot find vitest from ${root}. Install vitest (or vite-plus) in the project first.`)
}

/** nyorori relies on Vitest 5's Node API; older versions fail in ways that look like test results. */
export function checkVitestVersion(version: string): void {
  const major = Number(/^(\d+)\./.exec(version)?.[1])
  if (!(major >= 5)) throw new ProjectError(`nyorori needs Vitest 5 or later; this project uses Vitest ${version}.`)
}

function resolvePackage(require: NodeJS.Require, name: string): string | undefined {
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * Only a declared dependency counts: npm hoists one package's vite-plus to where
 * every package of the workspace can resolve it. Looks above the root too, since
 * a workspace often declares vite-plus once, at its root.
 */
function dependsOnVitePlus(root: string): boolean {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkg = readPackageJson(path.join(dir, 'package.json'))
    if (DEPENDENCY_FIELDS.some((field) => pkg?.[field]?.['vite-plus'] !== undefined)) return true
    if (path.dirname(dir) === dir) return false
  }
}

function readPackageJson(file: string): Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
