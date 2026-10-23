/**
 * Hosts one Vitest instance for the CLI. Runs as a separate, detached process
 * so the CLI can kill it (and every test worker with it) when a mutant hangs
 * a worker in a loop that never reaches a mutant site.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import picomatch from 'picomatch'
import type { Reporter, TestModule, TestProject, TestSpecification, Vitest } from 'vitest/node'
import { SLOTS } from './mutate/profile.ts'
import { PROVIDE, type ModuleResult, type Request, type Response, type SpecRef } from './protocol.ts'
import type { FilePlan, NotJudgedReason } from './types.ts'
import { checkVitestVersion, findVitest, ProjectError } from './vitest.ts'

/** Vitest's default `benchmark` globs. Vitest 4 resolves the option only in benchmark mode. */
const BENCHMARK = { include: ['**/*.{bench,benchmark}.?(c|m)[jt]s?(x)'], exclude: ['**/node_modules/**', '**/.git/**'] }

/** Vitest's and Vite's config files: vitest.config.ts, vite.config.mjs, vitest.unit.config.ts, ... */
const CONFIG = /^vite(?:st)?(?:\.[\w-]+)?\.config\./

/**
 * Test, type-test and benchmark files by Vitest's default names. One that no
 * project of the loaded config runs belongs to another config (a benchmarks
 * workspace, a type-test config) or is left out on purpose: still not source code.
 */
const TEST_NAME = /\.(?:(?:test|spec)(?:-d)?|bench|benchmark)\.[cm]?[jt]sx?$/

/** What nyorori reads of the other Vite plugins. */
interface VitePlugin {
  name: string
  transform?: ((...args: never[]) => unknown) | { order?: 'pre' | 'post' | null }
}

// The probe buffer goes back as the records of the probes that ran, keyed by probe key.
const SETUP = `import { inject, afterAll } from 'vitest'
const s = (globalThis.__nyorori ??= {})
s.active = inject(${JSON.stringify(PROVIDE.active)}) ?? 0
s.limit = inject(${JSON.stringify(PROVIDE.limit)}) ?? 0
s.hits = inject(${JSON.stringify(PROVIDE.collect)}) ? {} : null
const probes = inject(${JSON.stringify(PROVIDE.probes)}) ?? 0
s.prof = probes > 0 ? new Float64Array(probes * ${SLOTS}) : null
s.count = 0
s.exceeded = false
afterAll(({}, suite) => {
  if (s.hits !== null) suite.meta.nyororiHits = s.hits
  if (s.prof !== null) {
    const records = {}
    for (let i = 0; i < s.prof.length; i += ${SLOTS}) {
      if (s.prof[i + ${SLOTS - 1}] > 0) records[i / ${SLOTS}] = Array.from(s.prof.subarray(i, i + ${SLOTS}))
    }
    suite.meta.nyororiProfile = records
  }
  if (s.exceeded) suite.meta.nyororiExceeded = true
})
`

let vitest: Vitest | undefined
let setupDir: string | undefined
const plans = new Map<string, FilePlan>()
/** Whether the plugin serves the profiled instrumentation (the baseline) rather than the plain one. */
let profiling = false
/** The plugins whose transform runs before nyorori's (`order: 'pre'`, earlier in the list). */
let transformsBefore: string[] = []
/** A planned file that reached the transform already changed: the run cannot judge it, whatever the tests say. */
let changedBefore: string | undefined
/** Why nyorori cannot instrument what a project's tests run, and what to do instead, by project name. */
const unsupported = new Map<string, [problem: string, advice: string]>()

// runTestSpecifications() returns every module the instance has ever run, so
// a file that failed for an earlier mutant would count as failing for later
// ones too. The reporter receives only the modules of the run that just ended.
let lastRun: { modules: readonly TestModule[]; errors: readonly unknown[] } | undefined
const collector: Reporter = {
  onTestRunEnd(modules, errors) {
    lastRun = { modules, errors }
  },
}

function send(message: Response): void {
  process.send!(message)
}

async function init(root: string, candidates: string[], exclude: string[], dir: string): Promise<Omit<Extract<Response, { type: 'ready' }>, 'type'>> {
  const vitestDir = findVitest(root)
  const pkg = JSON.parse(readFileSync(path.join(vitestDir, 'package.json'), 'utf8'))
  const features = checkVitestVersion(pkg.version)
  const entry = pkg.exports['./node'].default ?? pkg.exports['./node']
  const { createVitest } = (await import(pathToFileURL(path.join(vitestDir, entry)).href)) as typeof import('vitest/node')

  // Vitest resolves a bare 'vitest' import to the running Vitest (its
  // vitest:resolve-core plugin) wherever the importer lives, so the setup file
  // can stay in the CLI's temporary directory instead of the project's node_modules.
  setupDir = dir
  const setupFile = path.join(dir, 'setup.mjs')
  writeFileSync(setupFile, SETUP)

  const plugin = {
    name: 'nyorori',
    enforce: 'pre' as const,
    // jsdom and happy-dom tests load setup files through Vite's /@fs/ route,
    // which serves only allowed directories; the setup file lives outside the project.
    configResolved(config: { server: { fs: { allow: string[] } }; plugins: readonly VitePlugin[] }) {
      config.server.fs.allow.push(dir)
      // Vite runs the `order: 'pre'` transforms first, in plugin order, then the rest.
      transformsBefore = config.plugins
        .slice(0, config.plugins.indexOf(plugin))
        .filter((p) => typeof p.transform === 'object' && p.transform.order === 'pre')
        .map((p) => p.name)
    },
    // `order: 'pre'`, not only `enforce: 'pre'`: plugins such as Vitest's own
    // vitest:meta-env-replacer (`import.meta.env`) or vite-plugin-solid are
    // `enforce: 'pre'` too, and would otherwise rewrite the file first.
    transform: {
      order: 'pre' as const,
      handler(code: string, id: string) {
        const plan = plans.get(id.split('?')[0]!)
        if (!plan) return undefined
        if (code !== plan.original) {
          changedBefore ??= plan.file
          throw new Error(`nyorori: ${plan.file} reached the transform already changed by another plugin; it cannot be mutated.`)
        }
        return profiling ? plan.profiled : { code: plan.instrumented, map: plan.map }
      },
    },
  }
  // As the Vitest CLI does (prepareVitest): Vite would otherwise set NODE_ENV
  // to 'development', and tests or configs that check it would behave unlike `vitest run`.
  process.env.TEST = 'true'
  process.env.VITEST = 'true'
  process.env.NODE_ENV ??= 'test'
  vitest = await createVitest(
    'test',
    {
      root,
      watch: false,
      reporters: [collector],
      // The on-disk transform cache is keyed by source, not by plan: a later
      // run would reuse code instrumented with another run's mutant ids.
      ...(features.fsModuleCacheOption === 'top-level' ? { fsModuleCache: false } : ({ experimental: { fsModuleCache: false } } as object)),
      related: candidates,
      // As in CI: `false` means 'new' outside CI, which writes missing snapshots and passes.
      update: 'none',
      // Hits and profiles are attributed per test file by the setup file, which
      // Vitest runs only once per worker under `isolate: false` here, so later
      // files would record nothing and their code would look untested.
      isolate: true,
      // No bail: cancelling a run makes test files that never started report
      // their state from an earlier run, and can abort the next run, so a
      // killed mutant could pass as Survived and the other way round.
      passWithNoTests: true,
      coverage: { enabled: false },
      provide: { [PROVIDE.active]: 0, [PROVIDE.limit]: 0, [PROVIDE.collect]: false, [PROVIDE.probes]: 0 },
    },
    { plugins: [plugin] },
  )
  // Code that never passes through the plugin looks untested, so these setups
  // would fail the PR with false NoCoverage. Their tests must not judge
  // anything; planning stops if they run the changed code (see unsupported).
  for (const project of vitest.projects) {
    const name = project.name ? `Vitest project "${project.name}"` : 'The Vitest config'
    const notYet = 'This setup is not supported yet.'
    if (project.config.browser.enabled) {
      unsupported.set(project.name, [`${name} runs its tests in browser mode, which nyorori does not support yet.`, ''])
    } else if (!project.vite.config.plugins.includes(plugin)) {
      // Vitest gives such a project its own Vite server and does not pass it the root's plugins.
      // With its own vitest.config or vite.config in its own directory, that config works as a root.
      const configFile = project.vite.config.configFile
      const ownConfig = configFile && configFile !== vitest.vite.config.configFile
      const dir = path.relative(root, project.config.root)
      const alone = ownConfig && dir !== '' && /^vite(?:st)?\.config\./.test(path.basename(configFile))
      // Vitest 4 starts a server for every project in test.projects, even one that sets only test options.
      const inline4 = features.major === 4 && !ownConfig
      unsupported.set(project.name, [
        inline4
          ? `${name} gets its own Vite server, as every project in test.projects does in Vitest 4, so nyorori cannot instrument the code its tests run.`
          : `${name} has its own Vite config (Vite options such as plugins, resolve or alias, or its own config file), so nyorori cannot instrument the code its tests run.`,
        alone
          ? `Run nyorori on that project alone with --root ${dir} (the Action's working-directory), where its config file is.`
          : `${notYet} A project with its own directory and config file can be run alone with --root (the Action's working-directory).${inline4 ? ' Vitest 5 shares the root\'s server with projects that set only test options.' : ''}`,
      ])
    } else if (project.config.experimental?.viteModuleRunner === false) {
      unsupported.set(project.name, [`${name} sets experimental.viteModuleRunner: false, which skips the Vite transform nyorori instruments code with.`, notYet])
    } else {
      project.config.setupFiles.push(setupFile)
    }
  }

  const config = vitest.config
  const coverageInclude = config.coverage.include?.length ? picomatch(config.coverage.include, { dot: true }) : undefined
  const coverageExclude = picomatch(config.coverage.exclude, { dot: true })
  const userExclude = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false
  // matchesTestGlob() knows only `include`: type tests (`*.test-d.ts`) and
  // benchmarks are test files too, whether or not typecheck or benchmark is enabled.
  const otherTests = vitest.projects.flatMap((project) => {
    const { typecheck } = project.config
    const benchmark = { ...BENCHMARK, ...project.config.benchmark }
    const dir = project.config.dir || project.config.root
    return [typecheck, benchmark].map((globs) => ({ dir, matches: globMatcher(globs.include, globs.exclude) }))
  })
  const setupFiles = new Set(vitest.projects.flatMap((project) => [...project.config.setupFiles, ...project.config.globalSetup]))
  // Config files and setup files are in coverage.exclude too, but Vitest put them there, not the user.
  const reasonOf = (file: string): NotJudgedReason | undefined => {
    const relative = path.relative(config.root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return 'outside-root'
    if (setupFiles.has(file) || vitest!.projects.some((project) => project.matchesTestGlob(file))) return 'test'
    if (otherTests.some(({ dir, matches }) => matches(path.relative(dir, file)))) return 'test'
    if (TEST_NAME.test(path.basename(file))) return 'test'
    if (CONFIG.test(path.basename(file))) return 'config'
    if (userExclude(relative)) return 'excluded'
    if (coverageInclude && !coverageInclude(relative)) return 'coverage-include'
    if (coverageExclude(relative)) return 'coverage-exclude'
    return undefined
  }
  const eligible: string[] = []
  const notJudged: Array<{ file: string; reason: NotJudgedReason }> = []
  for (const file of candidates) {
    const reason = reasonOf(file)
    if (reason) notJudged.push({ file, reason })
    else eligible.push(file)
  }
  // A changed file among the triggers (package.json, the user's own) would make
  // Vitest pick the whole suite, including tests that only pass in the project's own CI setup.
  config.forceRerunTriggers = []
  return { eligible, notJudged }
}

/**
 * A file another plugin changed before nyorori's transform makes its tests
 * fail to load. That says nothing about the tests, so the run stops here.
 */
function checkTransforms(): void {
  if (changedBefore === undefined) return
  const file = path.relative(vitest!.config.root, changedBefore)
  const which = transformsBefore.length > 0
    ? `Vite plugins whose transform runs before nyorori's: ${transformsBefore.join(', ')}.`
    : "No plugin's transform runs before nyorori's, so a plugin's load hook probably changed it."
  throw new ProjectError(
    `${file} was changed by another Vite plugin before nyorori could instrument it, so its mutants cannot be judged. ${which} Leave the file out with --exclude to judge the rest.`,
  )
}

/**
 * Tests of a project nyorori cannot instrument would see the changed code
 * as never run. A project whose tests do not run it does not matter.
 */
function checkProjects(specs: readonly TestSpecification[]): void {
  const blocked = specs.filter((spec) => unsupported.has(spec.project.name))
  if (blocked.length === 0) return
  const name = blocked[0]!.project.name
  const tests = blocked.filter((spec) => spec.project.name === name).map((spec) => path.relative(vitest!.config.root, spec.moduleId))
  const shown = tests.length > 3 ? `${tests.slice(0, 3).join(', ')} and ${tests.length - 3} more` : tests.join(', ')
  const [problem, advice] = unsupported.get(name)!
  throw new ProjectError(`${problem} Its tests run the changed code: ${shown}.${advice ? ` ${advice}` : ''}`)
}

function toRef(spec: TestSpecification): SpecRef {
  return { project: spec.project.name, moduleId: spec.moduleId, pool: spec.pool }
}

function fromRef(ref: SpecRef): TestSpecification {
  const project = vitest!.projects.find((p: TestProject) => p.name === ref.project)
  if (!project) throw new Error(`Unknown Vitest project "${ref.project}"`)
  return project.createSpecification(ref.moduleId, undefined, ref.pool)
}

/**
 * Switches the plugin between the profiled and the plain instrumentation. Vite
 * keeps transformed code, so every planned file is invalidated and transformed
 * again on the next run. Vitest 5.0.5 starts new workers for every run, even
 * with `isolate: false`; `watcher.invalidates` would also make a reused worker
 * drop the module it evaluated.
 */
function serveProfiled(profiled: boolean): void {
  if (profiled === profiling) return
  profiling = profiled
  for (const file of plans.keys()) {
    vitest!.invalidateFile(file)
    vitest!.watcher.invalidates.add(file)
  }
}

async function run(active: number, limit: number, collect: boolean, profile: number, refs: SpecRef[]): Promise<Response> {
  serveProfiled(profile > 0)
  for (const project of vitest!.projects) {
    project.provide(PROVIDE.active, active)
    project.provide(PROVIDE.limit, limit)
    project.provide(PROVIDE.collect, collect)
    project.provide(PROVIDE.probes, profile)
  }
  const started = performance.now()
  lastRun = undefined
  await vitest!.runTestSpecifications(refs.map(fromRef))
  checkTransforms()
  if (!lastRun) throw new Error('Vitest finished a run without reporting it')
  const result: { modules: readonly TestModule[]; errors: readonly unknown[] } = lastRun
  const wall = performance.now() - started
  const modules: ModuleResult[] = result.modules.map((module) => {
    const meta = module.meta() as { nyororiHits?: Record<string, number>; nyororiProfile?: Record<string, number[]>; nyororiExceeded?: boolean }
    const passed = module.ok()
    let error: string | undefined
    if (!passed) {
      const failure = module.errors()[0] ?? [...module.children.allTests('failed')][0]?.result().errors?.[0]
      error = failure?.message ?? 'failed'
    }
    return {
      spec: { project: module.project.name, moduleId: module.moduleId, pool: poolOf(refs, module) },
      passed,
      hits: meta.nyororiHits ?? {},
      profile: meta.nyororiProfile ?? {},
      exceeded: meta.nyororiExceeded === true,
      duration: module.diagnostic().duration,
      error,
    }
  })
  return { type: 'result', modules, unhandledErrors: result.errors.map(describeError), wall }
}

process.on('message', async (request: Request) => {
  try {
    switch (request.type) {
      case 'init':
        send({ type: 'ready', ...(await init(request.root, request.candidates, request.exclude, request.setupDir)) })
        break
      case 'plan': {
        for (const file of request.files) plans.set(file.file, file)
        // Tests are picked from the files that got mutants.
        vitest!.config.related = request.files.map((file) => file.file)
        // Finding the related tests transforms their imports too.
        const specs = await vitest!.getRelevantTestSpecifications().finally(checkTransforms)
        checkProjects(specs)
        send({ type: 'planned', specs: specs.map(toRef) })
        break
      }
      case 'run':
        send(await run(request.active, request.limit, request.collect, request.profile, request.specs))
        break
      case 'close':
        await vitest?.close()
        send({ type: 'closed' })
        break
    }
  } catch (error) {
    const message = error instanceof ProjectError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)
    send({ type: 'error', message })
  }
})

process.on('disconnect', () => {
  // The CLI removes the setup directory after the run; this covers a CLI that died first.
  if (setupDir) rmSync(setupDir, { recursive: true, force: true })
  process.exit(0)
})

function poolOf(refs: SpecRef[], module: TestModule): string {
  const ref = refs.find((r) => r.project === module.project.name && r.moduleId === module.moduleId)
  if (!ref) throw new Error(`Vitest reported ${module.moduleId}, which this run did not ask for`)
  return ref.pool
}

/** Matches paths relative to a project's directory, as Vitest globs its test files. */
function globMatcher(include: readonly string[] = [], exclude: readonly string[] = []): (relative: string) => boolean {
  if (include.length === 0) return () => false
  const included = picomatch([...include], { dot: true })
  const excluded = exclude.length > 0 ? picomatch([...exclude], { dot: true }) : () => false
  return (relative) => included(relative) && !excluded(relative)
}

/** Vitest's serialized errors may have no prototype, so `String(error)` can throw. */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return 'unknown error'
  }
}
