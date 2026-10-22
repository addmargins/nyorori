#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { exitCode, formatAnnotations, formatSummary, formatText } from './report.ts'
import { run, RunError } from './run.ts'

const USAGE = `Usage: nyorori run [options]

Mutates only the code this branch changed and runs the Vitest tests that
execute it. Fails when a mutant survives or the changed code is not tested.

Options:
  --base <ref>        Base to diff against (default: origin/$GITHUB_BASE_REF)
  --root <dir>        Vitest project root (default: current directory)
  --exclude <glob>    Skip source files matching the glob, relative to the root (repeatable)
  --timeout <ms>      Extra time a mutant run may take beyond twice the baseline (default: 10000)
  --max-mutants <n>   Stop with an error instead of running more than n mutants
  --json <file>       Write the full report as JSON
  --dry-run           List the mutants without running tests
  --no-types          Tell string \`+\` from numeric \`+\` by syntax only, without starting tsrs
  --no-predict        Run the mutants the baseline profile shows to survive, and report wrong predictions
  -h, --help          Show this help

Exit codes: 0 all mutants detected, 1 findings, 2 the run could not judge the change.`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      root: { type: 'string', default: process.cwd() },
      exclude: { type: 'string', multiple: true, default: [] },
      timeout: { type: 'string', default: '10000' },
      'max-mutants': { type: 'string' },
      json: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      types: { type: 'boolean', default: true },
      predict: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  })
  if (values.help || positionals[0] !== 'run') {
    console.log(USAGE)
    return values.help ? 0 : 2
  }
  const base = values.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined)
  if (!base) {
    console.error('nyorori: --base is required outside a pull_request workflow.')
    return 2
  }

  const report = await run({
    root: values.root,
    base,
    exclude: values.exclude,
    timeout: Number(values.timeout),
    maxMutants: values['max-mutants'] === undefined ? undefined : Number(values['max-mutants']),
    dryRun: values['dry-run'],
    types: values.types,
    predict: values.predict,
  })

  console.log(formatText(report))
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const line of formatAnnotations(report)) console.log(line)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(report))
  }
  if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`)
  return exitCode(report)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof RunError ? `nyorori: ${error.message}` : error)
    process.exit(2)
  },
)
