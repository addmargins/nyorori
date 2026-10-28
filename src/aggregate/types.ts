import type {
  GateId,
  GateMode,
  GateResult,
  GateState,
  Inconclusive,
  ReasonCode,
  TriggerHit,
  Violation,
} from "../types.js";

export const QUALITY_GATE_CHECK = "quality-gate";

/**
 * Trusted, service-computed checks that are not one of the seven sub-gates:
 * the AI-loop forbidden-change detector (spec 12.2).
 */
export type PseudoGate = "policy-integrity";

export interface GateVerdictRow {
  gate: GateId | PseudoGate;
  /** Mode from policy P (never from the artifact's own claim). */
  mode: GateMode;
  state: GateState | "MISSING";
  /** Whether this row decided the verdict (enforce mode and accepted). */
  counted: boolean;
  summary: string;
}

export interface QualityGateVerdict {
  schema_version: 1;
  check: typeof QUALITY_GATE_CHECK;
  state: GateState;
  mergeAllowed: boolean;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  gates: GateVerdictRow[];
  /** Enforce-mode gates with no accepted result. */
  missing: Array<GateId>;
  reasons: ReasonCode[];
  /** Aggregate-level measurement problems (missing gates, fingerprint/provenance mismatch). */
  inconclusive: Inconclusive[];
  /** Open (unwaived) violations from counted gates. */
  blocking: Violation[];
  /** Routing triggers from counted gates. */
  triggers: TriggerHit[];
  /** The G6 result computed by the aggregator. */
  review: GateResult;
  summary: string;
}
