// Which gates have something in scope (spec 9.1). A gate with nothing in scope
// reports NOT_APPLICABLE with the reason, never PASS.

import type { Manifest } from "../types.js";

export type Scope = { applicable: true } | { applicable: false; reason: string };

/**
 * G1–G3 judge the candidate: a deletion-only change leaves nothing to judge.
 * Deleted B units are still measured (they feed stage-4 move matching and the
 * S11 vanish check), so a move out of a deleted file is still seen.
 */
export function candidateScope(manifest: Manifest): Scope {
  if (manifest.entries.some((e) => e.measure.C)) return { applicable: true };
  if (manifest.entries.some((e) => e.measure.B)) return { applicable: false, reason: "deletion only" };
  return { applicable: false, reason: "no measured code changed" };
}

/** G4 also guards deletions: removing a test file is a TEST_REMOVED. */
export function touchesMeasuredCode(manifest: Manifest): boolean {
  return manifest.entries.some((e) => e.measure.B || e.measure.C);
}

/** G5/G7 look at executed product code of the candidate. */
export function candidateProductCode(manifest: Manifest): boolean {
  return manifest.entries.some((e) => e.c && e.measure.C && !e.isTest);
}
