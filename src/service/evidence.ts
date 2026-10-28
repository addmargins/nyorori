// Binds an Actions artifact to the run attempt that the API says produced it
// (spec 6.2, 10.1). Nothing inside the artifact is trusted for this; the run
// and artifact records come from the API.

import type { ArtifactRef, WorkflowRun } from "./github.js";

export interface BoundArtifact {
  artifact?: ArtifactRef;
  /** Why no artifact of the expected name could be bound (none → simply absent). */
  problem?: string;
}

/**
 * The artifact named for the candidate must have been created after the run's
 * latest attempt started (a re-run cannot resurface an older attempt's upload)
 * and must belong to a run of the commit we looked up. Missing API fields fail
 * closed: an artifact that cannot be bound is not evidence.
 */
export function bindArtifact(run: WorkflowRun, artifacts: readonly ArtifactRef[], lookupSha: string, candidate: string): BoundArtifact {
  const name = `nyorori-gate-${candidate}`;
  const named = artifacts.filter((a) => a.name === name && !a.expired);
  if (named.length === 0) return {};
  const problems: string[] = [];
  const startedAt = run.runStartedAt ? Date.parse(run.runStartedAt) : NaN;
  for (const a of named) {
    if (Number.isNaN(startedAt)) {
      problems.push(`run ${run.id} has no run_started_at`);
      continue;
    }
    const created = a.createdAt ? Date.parse(a.createdAt) : NaN;
    if (Number.isNaN(created)) {
      problems.push(`artifact ${a.id} has no created_at`);
      continue;
    }
    if (created < startedAt) {
      problems.push(`artifact ${a.id} predates attempt ${run.runAttempt} of run ${run.id}`);
      continue;
    }
    if (!a.workflowRunHeadSha) {
      problems.push(`artifact ${a.id} names no workflow_run.head_sha`);
      continue;
    }
    if (a.workflowRunHeadSha !== lookupSha) {
      problems.push(`artifact ${a.id} belongs to a run of ${a.workflowRunHeadSha}, not ${lookupSha}`);
      continue;
    }
    return { artifact: a };
  }
  return { problem: problems.join("; ") };
}
