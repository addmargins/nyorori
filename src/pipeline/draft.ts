// A sub-gate result before overrides, waivers and finalization. Every gate
// step produces one; a crash produces an INCONCLUSIVE(TOOL_ERROR) draft so a
// gate that could not run is never silently absent.

import type { ArtifactProvenance } from "../aggregate/index.js";
import type {
  GateId,
  Inconclusive,
  MeasurementFingerprint,
  TriggerHit,
  UnmeasuredRecord,
  Violation,
  WaiverApplied,
} from "../types.js";
import type { Scope } from "./scope.js";
import { errorMessage } from "../util/errors.js";

export interface GateDraft {
  gate: GateId;
  violations: Violation[];
  inconclusive: Inconclusive[];
  triggers: TriggerHit[];
  observe: Record<string, unknown>;
  unmeasured: UnmeasuredRecord[];
  waivers: WaiverApplied[];
  /** False when no in-scope file changed (NOT_APPLICABLE when nothing else was found). */
  applicable: boolean;
  /** Why the gate had nothing in scope; shown in the N/A summary. */
  notApplicableReason?: string;
  fingerprint: MeasurementFingerprint;
  /** Provenance of the untrusted artifact this draft consumed, if any. */
  provenance?: ArtifactProvenance;
}

export function emptyDraft(gate: GateId, fingerprint: MeasurementFingerprint, scope: boolean | Scope): GateDraft {
  const s: Scope = typeof scope === "boolean" ? (scope ? { applicable: true } : { applicable: false, reason: "no in-scope changes" }) : scope;
  return {
    gate,
    violations: [],
    inconclusive: [],
    triggers: [],
    observe: {},
    unmeasured: [],
    waivers: [],
    applicable: s.applicable,
    ...(s.applicable ? {} : { notApplicableReason: s.reason }),
    fingerprint,
  };
}

/** Runs one gate step; any thrown error becomes INCONCLUSIVE(TOOL_ERROR) for that gate. */
export async function guard(
  gate: GateId,
  fingerprint: MeasurementFingerprint,
  step: () => Promise<GateDraft>,
): Promise<GateDraft> {
  try {
    return await step();
  } catch (e) {
    const d = emptyDraft(gate, fingerprint, true);
    d.inconclusive.push({
      reason: "TOOL_ERROR",
      detail: `${gate} could not run: ${errorMessage(e)}`,
      authorFixable: false,
    });
    return d;
  }
}

/** Removes duplicate INCONCLUSIVE records (same reason and file, or same detail) produced by two layers. */
export function dedupeInconclusive(items: readonly Inconclusive[]): Inconclusive[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.reason}\u0000${i.file ?? i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
