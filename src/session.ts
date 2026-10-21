/**
 * Hosts one Vitest instance for the CLI. Runs as a separate, detached process
 * so the CLI can kill it (and every test worker with it) when a mutant hangs
 * a worker in a loop that never reaches a mutant site.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import picomatch from 'picomatch'
import type { Reporter, TestModule, TestProject, TestSpecification, Vitest } from 'vitest/node'
import { PROVIDE, type ModuleResult, type Request, type Response, type SpecRef } from './protocol.ts'
import type { FilePlan } from './types.ts'

const SETUP = `import { inject, afterAll } from 'vitest'
const s = (globalThis.__nyorori ??= {})
s.active = inject(${JSON.stringify(PROVIDE.active)}) ?? 0
s.limit = inject(${JSON.stringify(PROVIDE.limit)}) ?? 0
s.hits = inject(${JSON.stringify(PROVIDE.collect)}) ? {} : null
s.count = 0
s.exceeded = false
afterAll(({}, suite) => {
  if (s.hits !== null) suite.meta.nyororiHits = s.hits
  if (s.exceeded) suite.meta.nyororiExceeded = true
})
`

let vitest: Vitest | undefined
const plans = new Map<string, FilePlan>()

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

/** Finds the project's own Vitest, so tests run with the version the project pins. */
function findVitest(root: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', 'vitest', 'package.json')
    if (existsSync(pkg)) return path.dirname(pkg)
    if (path.dirname(dir) === dir) throw new Error(`Cannot find vitest from ${root}. Install it in the project first.`)
  }
}

async function init(root: string, candidates: string[], exclude: string[]): Promise<string[]> {
  const vitestDir = findVitest(root)
  const pkg = JSON.parse(readFileSync(path.join(vitestDir, 'package.json'), 'utf8'))
  const entry = pkg.exports['./node'].default ?? pkg.exports['./node']
  const { createVitest } = (await import(pathToFileURL(path.join(vitestDir, entry)).href)) as typeof import('vitest/node')

  // The setup file imports 'vitest', so it must live where that resolves to the project's copy.
  const setupDir = path.join(path.dirname(vitestDir), '.nyorori')
  mkdirSync(setupDir, { recursive: true })
  const setupFile = path.join(setupDir, 'setup.mjs')
  writeFileSync(setupFile, SETUP)

  vitest = await createVitest(
    'test',
    {
      root,
      watch: false,
      reporters: [collector],
      // The on-disk transform cache is keyed by source, not by plan: a later
      // run would reuse code instrumented with another run's mutant ids.
      fsModuleCache: false,
      related: candidates,
      update: false,
      bail: 1,
      passWithNoTests: true,
      coverage: { enabled: false },
      provide: { [PROVIDE.active]: 0, [PROVIDE.limit]: 0, [PROVIDE.collect]: false },
    },
    {
      plugins: [
        {
          name: 'nyorori',
          enforce: 'pre',
          transform(code: string, id: string) {
            const plan = plans.get(id.split('?')[0]!)
            if (!plan) return undefined
            if (code !== plan.original) {
              throw new Error(`nyorori: ${plan.file} reached the transform already changed by another plugin; it cannot be mutated.`)
            }
            return { code: plan.instrumented, map: plan.map }
          },
        },
      ],
    },
  )
  for (const project of vitest.projects) project.config.setupFiles.push(setupFile)

  const config = vitest.config
  const coverageInclude = config.coverage.include?.length ? picomatch(config.coverage.include, { dot: true }) : () => true
  const coverageExclude = picomatch(config.coverage.exclude, { dot: true })
  const userExclude = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false
  return candidates.filter((file) => {
    const relative = path.relative(config.root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false
    if (vitest!.projects.some((project) => project.matchesTestGlob(file))) return false
    return coverageInclude(relative) && !coverageExclude(relative) && !userExclude(relative)
  })
}

function toRef(spec: TestSpecification): SpecRef {
  return { project: spec.project.name, moduleId: spec.moduleId }
}

function fromRef(ref: SpecRef): TestSpecification {
  const project = vitest!.projects.find((p: TestProject) => p.name === ref.project)
  if (!project) throw new Error(`Unknown Vitest project "${ref.project}"`)
  return project.createSpecification(ref.moduleId)
}

async function run(active: number, limit: number, collect: boolean, refs: SpecRef[]): Promise<Response> {
  for (const project of vitest!.projects) {
    project.provide(PROVIDE.active, active)
    project.provide(PROVIDE.limit, limit)
    project.provide(PROVIDE.collect, collect)
  }
  const started = performance.now()
  lastRun = undefined
  await vitest!.runTestSpecifications(refs.map(fromRef))
  if (!lastRun) throw new Error('Vitest finished a run without reporting it')
  const result: { modules: readonly TestModule[]; errors: readonly unknown[] } = lastRun
  const wall = performance.now() - started
  const modules: ModuleResult[] = result.modules.map((module) => {
    const meta = module.meta() as { nyororiHits?: Record<string, number>; nyororiExceeded?: boolean }
    const passed = module.ok()
    let error: string | undefined
    if (!passed) {
      const failure = module.errors()[0] ?? [...module.children.allTests('failed')][0]?.result().errors?.[0]
      error = failure?.message ?? 'failed'
    }
    return {
      spec: toRef(module.project.createSpecification(module.moduleId)),
      passed,
      hits: meta.nyororiHits ?? {},
      exceeded: meta.nyororiExceeded === true,
      duration: module.diagnostic().duration,
      error,
    }
  })
  return { type: 'result', modules, unhandledErrors: result.errors.map(String), wall }
}

process.on('message', async (request: Request) => {
  try {
    switch (request.type) {
      case 'init':
        send({ type: 'ready', eligible: await init(request.root, request.candidates, request.exclude) })
        break
      case 'plan': {
        for (const file of request.files) plans.set(file.file, file)
        const specs = await vitest!.getRelevantTestSpecifications()
        send({ type: 'planned', specs: specs.map(toRef) })
        break
      }
      case 'run':
        send(await run(request.active, request.limit, request.collect, request.specs))
        break
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  }
})

process.on('disconnect', () => process.exit(0))
