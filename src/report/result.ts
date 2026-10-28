// Assembles a sub-gate's GateResult and derives its state (spec 9.1).

import type {
  GateId,
  GateMode,
  GateResult,
  GateState,
  Inconclusive,
  MeasurementFingerprint,
  ReasonCode,
  TriggerHit,
  UnmeasuredRecord,
  Violation,
  WaiverApplied,
} from "../types.js";

export interface GateResultInput {
  gate: GateId;
  mode: GateMode;
  base: string;
  candidate: string;
  policyRevision: string;
  fingerprint: MeasurementFingerprint;
  violations?: Violation[];
  inconclusive?: Inconclusive[];
  triggers?: TriggerHit[];
  waivers?: WaiverApplied[];
  unmeasured?: UnmeasuredRecord[];
  observe?: Record<string, unknown>;
  /** False when no in-scope file changed; yields NOT_APPLICABLE if nothing else was found. */
  applicable: boolean;
}

export function deriveState(
  violations: readonly Violation[],
  inconclusive: readonly Inconclusive[],
  applicable: boolean,
): GateState {
  const open = violations.filter((v) => !v.waivedBy);
  if (open.length > 0) return "FAIL";
  if (inconclusive.length > 0) return "INCONCLUSIVE";
  if (violations.length > 0) return "ACCEPTED_WITH_WAIVER";
  return applicable ? "PASS" : "NOT_APPLICABLE";
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function headline(state: GateState, violations: Violation[], inconclusive: Inconclusive[]): string {
  const open = violations.filter((v) => !v.waivedBy);
  const waived = violations.filter((v) => v.waivedBy);
  switch (state) {
    case "FAIL": {
      const first = open[0]!;
      const more = open.length > 1 ? ` (+${open.length - 1} more)` : "";
      const tail = inconclusive.length > 0 ? `; also INCONCLUSIVE: ${inconclusive[0]!.reason}` : "";
      return `FAIL: ${first.message}${more}${tail}`;
    }
    case "INCONCLUSIVE":
      return `INCONCLUSIVE: ${dedupe(inconclusive.map((i) => i.reason)).join(", ")}`;
    case "ACCEPTED_WITH_WAIVER":
      return `PASS with waiver: ${dedupe(waived.map((v) => v.waivedBy!)).join(", ")}`;
    case "PASS":
      return "PASS";
    case "NOT_APPLICABLE":
      return "N/A: no in-scope changes";
  }
}

export function finalizeGateResult(input: GateResultInput): GateResult {
  const violations = input.violations ?? [];
  const inconclusive = input.inconclusive ?? [];
  const state = deriveState(violations, inconclusive, input.applicable);
  const reasons: ReasonCode[] = dedupe([
    ...violations.filter((v) => !v.waivedBy).map((v) => v.reason),
    ...inconclusive.map((i) => i.reason),
  ]);
  return {
    schema_version: 1,
    gate: input.gate,
    state,
    mode: input.mode,
    base_sha: input.base,
    candidate_sha: input.candidate,
    policy_revision: input.policyRevision,
    measurement_fingerprint: input.fingerprint,
    reasons,
    violations,
    inconclusive,
    triggers: input.triggers ?? [],
    waivers_applied: input.waivers ?? [],
    unmeasured: input.unmeasured ?? [],
    observe: input.observe ?? {},
    summary: headline(state, violations, inconclusive),
  };
}
