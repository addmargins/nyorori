// Uniform output of the evaluators in this directory. The aggregator wraps it
// into a GateResult (mode, SHAs, fingerprint) — that is not this layer's job.

import type { GateState, Inconclusive, TriggerHit, Violation } from "../../types.js";

export interface GateEvaluation {
  state: GateState;
  violations: Violation[];
  inconclusive: Inconclusive[];
  triggers: TriggerHit[];
  observe: Record<string, unknown>;
  summary: string;
}

/** FAIL beats INCONCLUSIVE: both are reported, the author can act on the FAIL now (spec 9.1). */
export function deriveState(
  violations: readonly Violation[],
  inconclusive: readonly Inconclusive[],
  notApplicable = false,
): GateState {
  if (violations.some((v) => !v.waivedBy)) return "FAIL";
  if (inconclusive.length > 0) return "INCONCLUSIVE";
  if (violations.length > 0) return "ACCEPTED_WITH_WAIVER";
  if (notApplicable) return "NOT_APPLICABLE";
  return "PASS";
}
