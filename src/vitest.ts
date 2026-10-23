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

/** What differs between the Vitest versions nyorori supports, as far as nyorori uses them. */
export interface VitestFeatures {
  /** Vitest 4 starts a Vite server for every project in test.projects, even one that sets only test options. */
  major: number
  /** Vitest 5 moved `experimental.fsModuleCache` to the top level. */
  fsModuleCacheOption: 'top-level' | 'experimental'
}

/**
 * nyorori relies on the Node API of Vitest 4.1 and later; older versions fail
 * in ways that look like test results. 4.0 has no `update: 'none'`: given
 * `false`, it writes missing snapshots outside CI and passes.
 */
export function checkVitestVersion(version: string): VitestFeatures {
  const [major = NaN, minor = NaN] = (/^(\d+)\.(\d+)\./.exec(version)?.slice(1) ?? []).map(Number)
  if (!(major > 4 || (major === 4 && minor >= 1))) throw new ProjectError(`nyorori needs Vitest 4.1 or later; this project uses Vitest ${version}.`)
  return { major, fsModuleCacheOption: major >= 5 ? 'top-level' : 'experimental' }
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
