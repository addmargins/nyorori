import { expect, test } from 'vitest'
import { parseDiff } from '../src/git.ts'

test('parseDiff collects added and modified lines per file in the new version', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -2 +2 @@ export function a() {',
    '-  return 1',
    '+  return 2',
    '@@ -10,0 +11,3 @@',
    '+x',
    '+y',
    '+z',
    '@@ -20,2 +23,0 @@',
    '-gone',
    '-gone',
    'diff --git a/old.ts b/new.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new.ts',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1 +1,2 @@',
    '+added',
    'diff --git a/deleted.ts b/deleted.ts',
    '--- a/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/only-removed.ts b/only-removed.ts',
    '--- a/only-removed.ts',
    '+++ b/only-removed.ts',
    '@@ -3 +2,0 @@',
    '-bye',
  ].join('\n')
  const result = parseDiff(diff, '/repo')
  expect(Object.fromEntries([...result].map(([file, lines]) => [file, [...lines]]))).toEqual({
    '/repo/src/a.ts': [2, 11, 12, 13],
    '/repo/new.ts': [1, 2],
  })
})
