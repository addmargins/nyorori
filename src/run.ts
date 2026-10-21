import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changedLines, gitRoot, mergeBase } from './git.ts'
import { generate, ParseError } from './mutate/generate.ts'
import { instrument, InstrumentError } from './mutate/instrument.ts'
import type { ModuleResult, Request, Response, SpecRef } from './protocol.ts'
import type { EquivalentMutant, FilePlan, Mutant, MutantResult, MutantStatus, Suppression, SuppressionProblem } from './types.ts'

const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const DECLARATION = /\.d\.[cm]?ts$/

export interface RunOptions {
  root: string
  base: string
  exclude: string[]
  /** Extra milliseconds a mutant run may take beyond twice the baseline before its session is killed. */
  timeout: number
  maxMutants?: number
  dryRun: boolean
}

export interface Report {
  /** Paths in the report are relative to this directory (the git root). */
  gitRoot: string
  base: string
  files: string[]
  results: MutantResult[]
  /** Mutants dropped before running because they minify to the original code (TCE). They never fail the run. */
  equivalent: EquivalentMutant[]
  suppressions: Suppression[]
  problems: SuppressionProblem[]
  dryRun: boolean
}

/** The run cannot produce a verdict: bad input, failing baseline, or a tool failure. */
export class RunError extends Error {}

export async function run(options: RunOptions): Promise<Report> {
  const root = path.resolve(options.root)
  const repo = gitRoot(root)
  let base: string
  try {
    base = mergeBase(root, options.base)
  } catch {
    throw new RunError(`Cannot find a merge base between ${options.base} and HEAD. In GitHub Actions, check out with \`fetch-depth: 0\`.`)
  }
  const changed = changedLines(root, base)
  const relative = (file: string) => path.relative(repo, file)

  const candidates = [...changed.keys()]
    .filter((file) => SOURCE.test(file) && !DECLARATION.test(file) && !file.split(path.sep).includes('node_modules'))
    .filter((file) => existsSync(file))
    .sort()
  const report: Report = { gitRoot: repo, base, files: [], results: [], equivalent: [], suppressions: [], problems: [], dryRun: options.dryRun }
  if (candidates.length === 0) return report

  // Holds the session's Vitest setup file. The CLI owns it because it SIGKILLs sessions.
  const setupDir = mkdtempSync(path.join(os.tmpdir(), 'nyorori-'))
  const start = () => Session.start({ type: 'init', root, candidates, exclude: options.exclude, setupDir })
  let session: Session | undefined
  try {
    session = await start()
    const plans: FilePlan[] = []
    const mutants: Mutant[] = []
    for (const file of session.eligible) {
      const code = readFileSync(file, 'utf8')
      let generated: ReturnType<typeof generate>
      try {
        generated = generate(file, code, changed.get(file)!, mutants.length + 1)
      } catch (error) {
        if (error instanceof ParseError) throw new RunError(`Cannot parse ${relative(file)}: ${error.message}`)
        throw error
      }
      report.equivalent.push(...generated.equivalent)
      report.suppressions.push(...generated.suppressions)
      report.problems.push(...generated.problems)
      if (generated.mutants.length === 0) continue
      mutants.push(...generated.mutants)
      report.files.push(relative(file))
      let instrumented: ReturnType<typeof instrument>
      try {
        instrumented = instrument(file, code, generated.sites)
      } catch (error) {
        if (error instanceof InstrumentError) throw new RunError(`nyorori bug: ${error.message}`)
        throw error
      }
      plans.push({ file, original: code, instrumented: instrumented.code, map: instrumented.map })
    }
    if (options.maxMutants !== undefined && mutants.length > options.maxMutants) {
      throw new RunError(`${mutants.length} mutants exceed --max-mutants ${options.maxMutants}. Split the PR or raise the limit.`)
    }

    const suppressionOf = (mutant: Mutant) =>
      report.suppressions.find((s) => s.file === mutant.file && s.targetLine === mutant.line && s.operators.includes(mutant.operator))
    const used = new Set<Suppression>()
    const results: MutantResult[] = mutants.map((mutant) => {
      const suppression = suppressionOf(mutant)
      if (suppression) used.add(suppression)
      return { ...mutant, status: 'NoCoverage', suppression, tests: [] }
    })
    for (const suppression of report.suppressions) {
      if (suppression.isNew && !used.has(suppression)) {
        report.problems.push({
          file: suppression.file,
          line: suppression.line,
          message: `Suppression matches no mutant of ${suppression.operators.join(', ')} on line ${suppression.targetLine}. Remove it.`,
        })
      }
    }
    report.results = results
    if (options.dryRun || results.length === 0) return report

    const specs = await session.plan(plans)
    const coverage = new Map<number, { specs: SpecRef[]; hits: number }>()
    let baselineWall = 0
    if (specs.length > 0) {
      const baseline = await session.run({ type: 'run', active: 0, limit: 0, collect: true, specs })
      if (baseline === 'timeout') throw new RunError('Baseline run timed out')
      const failed = baseline.modules.filter((m) => !m.passed)
      if (failed.length > 0 || baseline.unhandledErrors.length > 0) {
        const details = failed.map((m) => `  ${relative(m.spec.moduleId)}: ${m.error}`).concat(baseline.unhandledErrors.map((e) => `  ${e}`))
        throw new RunError(`Tests fail without any mutant, so mutants cannot be judged:\n${details.join('\n')}`)
      }
      baselineWall = baseline.wall
      for (const module of baseline.modules) {
        for (const [id, hits] of Object.entries(module.hits)) {
          const entry = coverage.get(Number(id)) ?? { specs: [], hits: 0 }
          entry.specs.push(module.spec)
          entry.hits = Math.max(entry.hits, hits)
          coverage.set(Number(id), entry)
        }
      }
    }

    for (const result of results) {
      const covered = coverage.get(result.id)
      let status: MutantStatus = 'NoCoverage'
      if (covered) {
        result.tests = covered.specs.map((spec) => relative(spec.moduleId))
        const request: Request = { type: 'run', active: result.id, limit: covered.hits * 100 + 10_000, collect: false, specs: covered.specs }
        const outcome = await session.run(request, baselineWall * 2 + options.timeout)
        if (outcome === 'timeout') {
          status = 'Timeout'
          session.kill()
          session = await start()
          await session.plan(plans)
        } else {
          status = judge(outcome.modules, outcome.unhandledErrors)
        }
      }
      if (result.suppression) {
        if (status === 'Killed' || status === 'Timeout') {
          report.problems.push({
            file: result.suppression.file,
            line: result.suppression.line,
            message: `Unnecessary suppression: tests already detect mutant ${result.operator} ${result.description}. Remove it.`,
          })
        }
        status = 'Ignored'
      }
      result.status = status
    }
    return report
  } finally {
    session?.kill()
    rmSync(setupDir, { recursive: true, force: true })
  }
}

function judge(modules: ModuleResult[], unhandledErrors: string[]): MutantStatus {
  if (modules.some((m) => m.exceeded)) return 'Timeout'
  if (unhandledErrors.length > 0 || modules.some((m) => !m.passed)) return 'Killed'
  return 'Survived'
}

/** CLI side of the Vitest session process (see session.ts). */
class Session {
  eligible: string[] = []
  private readonly child: ChildProcess
  private waiting: ((response: Response) => void) | undefined

  private constructor(child: ChildProcess) {
    this.child = child
    child.on('message', (response: Response) => {
      const resolve = this.waiting
      this.waiting = undefined
      resolve?.(response)
    })
    child.on('exit', (code, signal) => {
      const resolve = this.waiting
      this.waiting = undefined
      resolve?.({ type: 'error', message: `Vitest session exited unexpectedly (${signal ?? code})` })
    })
  }

  static async start(init: Extract<Request, { type: 'init' }>): Promise<Session> {
    const entry = new URL(import.meta.url.endsWith('.ts') ? './session.ts' : './session.js', import.meta.url)
    // Detached so the session leads its own process group and kill() also stops its test workers.
    const child = fork(entry, [], { cwd: init.root, detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const session = new Session(child)
    const response = await session.send(init)
    if (response === 'timeout' || response.type !== 'ready') {
      session.kill()
      throw unexpected(response)
    }
    session.eligible = response.eligible
    return session
  }

  async plan(files: FilePlan[]): Promise<SpecRef[]> {
    const response = await this.send({ type: 'plan', files })
    if (response === 'timeout' || response.type !== 'planned') throw unexpected(response)
    return response.specs
  }

  async run(request: Request, timeout?: number): Promise<Extract<Response, { type: 'result' }> | 'timeout'> {
    const response = await this.send(request, timeout)
    if (response === 'timeout') return response
    if (response.type !== 'result') throw unexpected(response)
    return response
  }

  kill(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    try {
      process.kill(-this.child.pid!, 'SIGKILL')
    } catch {
      this.child.kill('SIGKILL')
    }
  }

  private send(request: Request, timeout?: number): Promise<Response | 'timeout'> {
    return new Promise((resolve) => {
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        this.waiting = undefined
        resolve('timeout')
      }, timeout)
      this.waiting = (response) => {
        clearTimeout(timer)
        resolve(response)
      }
      this.child.send(request)
    })
  }
}

function unexpected(response: Response | 'timeout'): RunError {
  if (response === 'timeout') return new RunError('Vitest session timed out')
  return new RunError(response.type === 'error' ? response.message : `Unexpected response from Vitest session: ${response.type}`)
}
