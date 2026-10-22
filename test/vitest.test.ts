import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { checkVitestVersion, findVitest } from '../src/vitest.ts'

const trees: string[] = []
afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true })
})

/** A directory tree outside this repository, so nothing resolves to our own node_modules. */
function tree(files: Record<string, object>, links: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nyorori-find-')))
  trees.push(root)
  for (const [file, json] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), JSON.stringify(json))
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(root, link)), { recursive: true })
    symlinkSync(target, path.join(root, link))
  }
  return root
}

const vitest = (version: string) => ({ name: 'vitest', version, exports: { './package.json': './package.json' } })
const vitePlus = { name: 'vite-plus', version: '1.3.0', exports: { './package.json': './package.json' } }

describe('findVitest', () => {
  test('resolves vitest from the root the way Node does, through ancestor node_modules', () => {
    const root = tree({
      'package.json': { workspaces: ['packages/*'] },
      'node_modules/vitest/package.json': vitest('5.0.5'),
      'packages/app/package.json': { devDependencies: { vitest: '5.0.5' } },
    })
    expect(findVitest(path.join(root, 'packages/app'))).toBe(path.join(root, 'node_modules/vitest'))
  })

  test('uses the Vitest that vite-plus depends on, also where pnpm hides it from the root', () => {
    const root = tree({
      'package.json': { devDependencies: { 'vite-plus': '1.3.0' } },
      'node_modules/.pnpm/vite-plus@1.3.0/node_modules/vite-plus/package.json': vitePlus,
      'node_modules/.pnpm/vitest@5.0.5/node_modules/vitest/package.json': vitest('5.0.5'),
    }, {
      'node_modules/vite-plus': '.pnpm/vite-plus@1.3.0/node_modules/vite-plus',
      'node_modules/.pnpm/vite-plus@1.3.0/node_modules/vitest': '../../vitest@5.0.5/node_modules/vitest',
    })
    expect(findVitest(root)).toBe(path.join(root, 'node_modules/.pnpm/vitest@5.0.5/node_modules/vitest'))
  })

  test('prefers the Vitest of vite-plus over the project copy, as `vp test` does', () => {
    const root = tree({
      'package.json': { devDependencies: { 'vite-plus': '1.3.0', vitest: '5.0.0' } },
      'node_modules/vitest/package.json': vitest('5.0.0'),
      'node_modules/vite-plus/package.json': vitePlus,
      'node_modules/vite-plus/node_modules/vitest/package.json': vitest('5.0.5'),
    })
    expect(findVitest(root)).toBe(path.join(root, 'node_modules/vite-plus/node_modules/vitest'))
  })

  test('counts vite-plus declared by a workspace root above the project', () => {
    const root = tree({
      'package.json': { devDependencies: { 'vite-plus': '1.3.0' } },
      'packages/app/package.json': { name: 'app' },
      'node_modules/vite-plus/package.json': vitePlus,
      'node_modules/vite-plus/node_modules/vitest/package.json': vitest('5.0.5'),
    })
    expect(findVitest(path.join(root, 'packages/app'))).toBe(path.join(root, 'node_modules/vite-plus/node_modules/vitest'))
  })

  test('ignores a vite-plus the project does not declare, such as one hoisted from a sibling package', () => {
    const root = tree({
      'package.json': { workspaces: ['packages/*'] },
      'packages/app/package.json': { devDependencies: { vitest: '5.0.0' } },
      'packages/app/node_modules/vitest/package.json': vitest('5.0.0'),
      'node_modules/vite-plus/package.json': vitePlus,
      'node_modules/vitest/package.json': vitest('5.0.5'),
    })
    expect(findVitest(path.join(root, 'packages/app'))).toBe(path.join(root, 'packages/app/node_modules/vitest'))
  })

  test('falls back to the project copy when the declared vite-plus is not installed', () => {
    const root = tree({
      'package.json': { devDependencies: { 'vite-plus': '1.3.0' } },
      'node_modules/vitest/package.json': vitest('5.0.5'),
    })
    expect(findVitest(root)).toBe(path.join(root, 'node_modules/vitest'))
  })

  test('fails with a clear message when neither is installed', () => {
    const root = tree({ 'package.json': { devDependencies: { vitest: '5.0.5' } } })
    expect(() => findVitest(root)).toThrow(`Cannot find vitest from ${root}. Install vitest (or vite-plus) in the project first.`)
  })
})

describe('checkVitestVersion', () => {
  test('accepts Vitest 5 and later', () => {
    for (const version of ['5.0.0', '5.0.5', '5.1.0-beta.1', '6.0.0']) expect(() => checkVitestVersion(version)).not.toThrow()
  })

  test('rejects older or unreadable versions', () => {
    for (const version of ['4.1.11', '4.0.14', '3.2.7', 'next']) {
      expect(() => checkVitestVersion(version)).toThrow(`nyorori needs Vitest 5 or later; this project uses Vitest ${version}.`)
    }
  })
})
