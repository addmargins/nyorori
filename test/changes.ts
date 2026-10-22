import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changedRanges, type Changes } from '../src/diff.ts'
import { parseDiff } from '../src/git.ts'

/** Changes in which every token of `lines` is new, as in a file the diff adds. */
export function addedLines(code: string, lines: Iterable<number>): Changes {
  const set = new Set(lines)
  const hunks = [...set].sort((a, b) => a - b).map((line) => ({ oldStart: 0, oldCount: 0, newStart: line, newCount: 1 }))
  return { lines: set, ranges: changedRanges(undefined, code, hunks) }
}

/** What nyorori sees changed from `before` to `after`, with git finding the changed lines as it does for a branch. */
export function changes(before: string, after: string): Changes {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nyorori-diff-'))
  try {
    writeFileSync(path.join(dir, 'before'), before)
    writeFileSync(path.join(dir, 'after'), after)
    const { stdout } = spawnSync('git', ['diff', '--no-index', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'before', 'after'], { cwd: dir, encoding: 'utf8' })
    const diff = parseDiff(stdout, dir).get(path.join(dir, 'after'))
    if (!diff) return { lines: new Set(), ranges: [] }
    return { lines: diff.lines, ranges: changedRanges(before, after, diff.hunks) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `after` with each changed range in brackets and each place of a deletion as `|`. */
export function show(after: string, { ranges }: Changes): string {
  let result = ''
  let at = 0
  for (const { start, end } of ranges) {
    result += after.slice(at, start) + (start === end ? '|' : `[${after.slice(start, end)}]`)
    at = end
  }
  return result + after.slice(at)
}
