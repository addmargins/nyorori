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
  /** True when the shadow verdict (every gate enforced) would not allow the merge. */
  would_block: boolean;
  /** The verdict as if every observe/degraded gate were enforce (spec 13.1 "모든 가상 판정 기록"). */
  shadow: ShadowVerdict;
  summary: string;
}

export interface ShadowVerdict {
  state: GateState;
  mergeAllowed: boolean;
  reasons: ReasonCode[];
  /** Gate, reason and unit of every violation that would block. */
  blocking: Array<{ gate: GateId | PseudoGate; reason: ReasonCode; unit?: string; file?: string }>;
  /** Routing triggers that would require the simplification review. */
  triggers: Array<{ id: TriggerHit["id"]; gate: GateId; file?: string; unit?: string }>;
  /** Gates whose mode differs from enforce in the real policy, with their shadow state. */
  promoted: Array<{ gate: GateId; mode: GateMode; state: GateState | "MISSING" }>;
  summary: string;
}
