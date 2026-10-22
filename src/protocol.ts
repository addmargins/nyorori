import type { FilePlan } from './types.ts'

/** Identifies a test file across processes. */
export interface SpecRef {
  project: string
  moduleId: string
  /** With `typecheck.enabled`, a test file may belong to the `typescript` pool instead of a runtime one. */
  pool: string
}

export type Request =
  /** `setupDir` is a temporary directory the CLI owns and removes after the run. */
  | { type: 'init'; root: string; candidates: string[]; exclude: string[]; setupDir: string }
  | { type: 'plan'; files: FilePlan[] }
  /**
   * `profile` > 0 serves the profiled instrumentation and gives each test file a
   * buffer for that many probe keys (the baseline); 0 serves the plain one.
   */
  | { type: 'run'; active: number; limit: number; collect: boolean; profile: number; specs: SpecRef[] }
  | { type: 'close' }

export interface ModuleResult {
  spec: SpecRef
  passed: boolean
  /** Hit counts per mutant id; only in collecting runs. */
  hits: Record<string, number>
  /** Probe records per probe key; only in profiling runs. */
  profile: Record<string, number[]>
  /** The active mutant hit its limit in this file. */
  exceeded: boolean
  duration: number
  /** First failure message, for diagnosing a failing baseline. */
  error?: string
}

export type Response =
  | { type: 'ready'; eligible: string[] }
  | { type: 'planned'; specs: SpecRef[] }
  | { type: 'result'; modules: ModuleResult[]; unhandledErrors: string[]; wall: number }
  | { type: 'closed' }
  | { type: 'error'; message: string }

/** Keys passed from the session to test workers with `provide`/`inject`. */
export const PROVIDE = {
  active: 'nyorori:active',
  limit: 'nyorori:limit',
  collect: 'nyorori:collect',
  probes: 'nyorori:probes',
} as const

declare module 'vitest' {
  export interface ProvidedContext {
    'nyorori:active': number
    'nyorori:limit': number
    'nyorori:collect': boolean
    'nyorori:probes': number
  }
}
