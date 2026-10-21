import { execFileSync } from 'node:child_process'
import path from 'node:path'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function gitRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

export function mergeBase(cwd: string, base: string): string {
  return git(cwd, ['merge-base', base, 'HEAD']).trim()
}

/**
 * Lines added or modified since `base`, keyed by absolute file path.
 * Compares against the working tree, so uncommitted edits count as changes.
 */
export function changedLines(cwd: string, base: string): Map<string, Set<number>> {
  const root = gitRoot(cwd)
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', base, '--'])
  return parseDiff(diff, root)
}

export function parseDiff(diff: string, root: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>()
  let current: Set<number> | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      if (target === '/dev/null') {
        current = undefined
        continue
      }
      const file = path.resolve(root, target.replace(/^b\//, ''))
      current = new Set()
      result.set(file, current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let i = 0; i < count; i++) current.add(start + i)
    }
  }
  for (const [file, lines] of result) if (lines.size === 0) result.delete(file)
  return result
}
