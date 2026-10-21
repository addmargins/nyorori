import type { FilePlan } from './types.ts'

/** Identifies a test file across processes. */
export interface SpecRef {
  project: string
  moduleId: string
}

export type Request =
  | { type: 'init'; root: string; candidates: string[]; exclude: string[] }
  | { type: 'plan'; files: FilePlan[] }
  | { type: 'run'; active: number; limit: number; collect: boolean; specs: SpecRef[] }

export interface ModuleResult {
  spec: SpecRef
  passed: boolean
  /** Hit counts per mutant id; only in collecting runs. */
  hits: Record<string, number>
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
  | { type: 'error'; message: string }

/** Keys passed from the session to test workers with `provide`/`inject`. */
export const PROVIDE = {
  active: 'nyorori:active',
  limit: 'nyorori:limit',
  collect: 'nyorori:collect',
} as const

declare module 'vitest' {
  export interface ProvidedContext {
    'nyorori:active': number
    'nyorori:limit': number
    'nyorori:collect': boolean
  }
}
