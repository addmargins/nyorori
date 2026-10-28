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
  fingerprint: MeasurementFingerprint;
  /** Provenance of the untrusted artifact this draft consumed, if any. */
  provenance?: ArtifactProvenance;
}

export function emptyDraft(gate: GateId, fingerprint: MeasurementFingerprint, applicable: boolean): GateDraft {
  return { gate, violations: [], inconclusive: [], triggers: [], observe: {}, unmeasured: [], waivers: [], applicable, fingerprint };
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
      detail: `${gate} could not run: ${e instanceof Error ? e.message : String(e)}`,
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
