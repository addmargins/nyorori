import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
const ACTION = readFileSync(path.join(REPO, 'action.yml'), 'utf8')

// action.yml is simple enough to read with patterns: two-space input names, and one step that runs nyorori.
const inputs = new Map<string, string>()
for (const [, name, body] of /^inputs:\n([\s\S]*?)\n\S/m.exec(ACTION)![1]!.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n?)*)/gm)) {
  inputs.set(name!, /^ {4}default: (.*)$/m.exec(body!)![1]!.replace(/^'(.*)'$/, '$1'))
}
const step = ACTION.slice(ACTION.indexOf('- name: Run nyorori'))
/** Env var → input. */
const env = new Map([...step.matchAll(/^ {8}(NYORORI_\w+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)].map(([, name, input]) => [name!, input!]))
const script = /^ {6}run: \|\n((?: {8}.*\n?)*)/m.exec(step)![1]!.replace(/^ {8}/gm, '')

const bin = mkdtempSync(path.join(os.tmpdir(), 'nyorori-action-'))
afterAll(() => rmSync(bin, { recursive: true, force: true }))
// Stands in for the node that would run dist/cli.js, and prints the arguments it gets.
writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nshift\nprintf \'%s\\0\' "$@"\n')
chmodSync(path.join(bin, 'node'), 0o755)

/** The CLI arguments the step passes when the inputs have their defaults, except `changed`. */
function args(changed: Record<string, string> = {}): string[] {
  const vars: Record<string, string> = {}
  for (const [name, input] of env) {
    // The default base is the pull request's base commit.
    vars[name] = changed[input] ?? (input === 'base' ? 'abc123' : inputs.get(input)!)
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ACTION_PATH: '/action', ...vars },
  })
  expect(result.stderr).toBe('')
  return result.stdout.split('\0').slice(0, -1)
}

const DEFAULTS = ['run', '--base', 'abc123', '--timeout', '10000']

// An input other than the default for each input the step reads, and the arguments the CLI should get.
const CHANGED: Record<string, [value: string, args: string[]]> = {
  base: ['v1.2', ['run', '--base', 'v1.2', '--timeout', '10000']],
  exclude: ['scripts/**\n\n**/*.vue\n', [...DEFAULTS, '--exclude', 'scripts/**', '--exclude', '**/*.vue']],
  'max-mutants': ['300', [...DEFAULTS, '--max-mutants', '300']],
  timeout: ['500', ['run', '--base', 'abc123', '--timeout', '500']],
  types: ['false', [...DEFAULTS, '--no-types']],
  predict: ['false', [...DEFAULTS, '--no-predict']],
  'log-guards': ['true', [...DEFAULTS, '--log-guards']],
}

test('every input of action.yml reaches the CLI', () => {
  // The step runs in the working directory; every other input is passed in an env var. A new one needs a case above.
  expect(step).toContain('working-directory: ${{ inputs.working-directory }}')
  expect([...env.values()].sort()).toEqual([...inputs.keys()].filter((input) => input !== 'working-directory').sort())
  expect(Object.keys(CHANGED).sort()).toEqual([...env.values()].sort())

  expect(args()).toEqual(DEFAULTS)
  for (const [input, [value, expected]] of Object.entries(CHANGED)) expect(args({ [input]: value }), input).toEqual(expected)

  // And the CLI knows every option the step passes.
  const usage = spawnSync(process.execPath, [path.join(REPO, 'src', 'cli.ts'), '--help'], { encoding: 'utf8' }).stdout
  for (const [, expected] of Object.values(CHANGED)) {
    for (const option of expected.filter((arg) => arg.startsWith('--'))) expect(usage).toContain(`  ${option} `)
  }
})
