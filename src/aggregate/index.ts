// quality-gate: the single required check (spec 4.1, 4.2). The aggregator
// trusts nothing it did not verify: modes come from policy P, untrusted
// artifacts need workflow provenance, every result must carry this run's
// B/C/P/M, and a gate that did not report is never a pass.

import type { Policy } from "../policy/schema.js";
import {
  ALWAYS_ROUTING_TRIGGERS,
  GATE_STATES,
  worstState,
  type GateId,
  type GateMode,
  type GateResult,
  type GateState,
  type Inconclusive,
  type MeasurementFingerprint,
  type ReasonCode,
  type TriggerHit,
  type Violation,
} from "../types.js";
import { deriveState } from "../report/result.js";
import {
  evaluateSimplificationReview,
  routingTriggers,
  type SimplificationReviewInput,
} from "../review/simplification.js";
import { isWaivable } from "../waivers/index.js";
import { TEST_APPROVABLE_REASONS, TEST_APPROVAL_METRIC } from "../waivers/test-approval.js";
import { QUALITY_GATE_CHECK, type GateVerdictRow, type QualityGateVerdict } from "./types.js";

export { QUALITY_GATE_CHECK } from "./types.js";
export type { QualityGateVerdict, GateVerdictRow } from "./types.js";

/** Gates computed by the gate service from git blobs, never by PR-executing jobs. */
export const SERVICE_GATES: ReadonlySet<GateId> = new Set(["complexity", "lint-structure", "deps"]);
/** Gates that execute PR code in Actions; their artifacts are untrusted input. */
export const ACTIONS_GATES: ReadonlySet<GateId> = new Set(["tests", "coverage", "mutation"]);

export function policyMode(policy: Policy, gate: GateId): GateMode {
  switch (gate) {
    case "complexity":
      return policy.complexity.mode;
    case "lint-structure":
      return policy.lint.mode;
    case "deps":
      return policy.deps.mode;
    case "tests":
      return policy.tests.mode;
    case "coverage":
      return policy.coverage.mode;
    case "simplification-review":
      return policy.review.mode;
    case "mutation":
      return policy.mutation.mode;
  }
}

/** Provenance read by the service from the GitHub API, never from the artifact itself. */
export interface ArtifactProvenance {
  repository: string;
  workflowPath: string;
  workflowSha: string;
  runId: number;
  runAttempt: number;
  /** The run's head_sha from the API: the PR head for pull_request, the group head for merge_group. */
  headSha: string;
  event: string;
  /**
   * pull_request only: the test-merge commit the run checked out (refs/pull/N/merge).
   * The API does not expose it, so it comes from the run's metadata.
   */
  testMergeSha?: string;
}

export interface TrustedWorkflows {
  /** Repository that hosts the required workflow (the gate repository). */
  workflows: Array<{ repository: string; path: string; shas: string[] }>;
}

export interface SubmittedResult {
  result: GateResult;
  source: "service" | "actions";
  provenance?: ArtifactProvenance;
}

export interface ExpectedRun {
  base: string;
  candidate: string;
  policyRevision: string;
  runnerCommit: string;
  cccc?: { version?: string; sha256?: string };
  /** Pinned tool versions (eslint, coverage provider...) keyed like `measurement_fingerprint.tools`. */
  tools?: Record<string, string>;
  /** PR head for pull_request evaluations; pull_request runs report this as their head_sha. */
  prHeadSha?: string;
}

export interface AggregateInput {
  policy: Policy;
  expected: ExpectedRun;
  results: readonly SubmittedResult[];
  trustedWorkflows: TrustedWorkflows;
  /** G6 inputs other than triggers; the aggregator collects triggers itself. */
  review: Omit<SimplificationReviewInput, "triggers" | "policy" | "mode" | "base" | "candidate" | "fingerprint">;
  /** Trusted, service-computed forbidden-change findings for AI-loop PRs (spec 12.2). */
  policyIntegrity?: readonly Violation[];
}

const ACCEPTED_EVENTS = new Set(["pull_request", "merge_group"]);
const PASSING: ReadonlySet<GateState> = new Set(["PASS", "NOT_APPLICABLE", "ACCEPTED_WITH_WAIVER"]);

function provenanceProblem(s: SubmittedResult, input: AggregateInput): string | null {
  const p = s.provenance;
  if (!p) return "artifact has no workflow provenance";
  const trusted = input.trustedWorkflows.workflows.find(
    (w) => w.repository === p.repository && w.path === p.workflowPath,
  );
  if (!trusted) return `workflow ${p.repository}/${p.workflowPath} is not the required gate workflow`;
  if (!trusted.shas.includes(p.workflowSha)) return `workflow SHA ${p.workflowSha} is not pinned in policy`;
  if (!ACCEPTED_EVENTS.has(p.event)) return `workflow event ${p.event} is not accepted`;
  const { candidate, prHeadSha } = input.expected;
  if (p.event === "merge_group") {
    return p.headSha === candidate ? null : `artifact was built for ${p.headSha}, not the candidate`;
  }
  // pull_request: the run's head is the PR head; the commit it actually tested is the test merge.
  if (prHeadSha !== undefined && p.headSha !== prHeadSha) return `run head ${p.headSha} is not the PR head ${prHeadSha}`;
  if (p.testMergeSha === undefined && p.headSha !== candidate) return "artifact does not say which test merge it ran on";
  if (p.testMergeSha !== undefined && p.testMergeSha !== candidate) {
    return `artifact tested merge ${p.testMergeSha}, not the candidate ${candidate} (base moved?)`;
  }
  return null;
}

/**
 * Waivers are applied by the service. A `waivedBy` from anywhere else is
 * dropped, and every `waivedBy` must name an applied waiver (or gate-owner test
 * approval) whose reason may be covered at all.
 */
function sanitizeWaivers(s: SubmittedResult): GateResult {
  const r = s.result;
  const trusted = s.source === "service";
  const applied = new Map((trusted ? r.waivers_applied : []).map((w) => [w.id, w]));
  const violations = r.violations.map((v) => {
    if (!v.waivedBy) return v;
    const w = applied.get(v.waivedBy);
    const ok = w !== undefined && (w.metric === TEST_APPROVAL_METRIC ? TEST_APPROVABLE_REASONS.has(v.reason) : isWaivable(v));
    if (ok) return v;
    const { waivedBy: _dropped, ...rest } = v;
    return { ...rest, details: { ...rest.details, dropped_waiver: v.waivedBy } };
  });
  const used = new Set(violations.flatMap((v) => (v.waivedBy ? [v.waivedBy] : [])));
  return { ...r, violations, waivers_applied: [...applied.values()].filter((w) => used.has(w.id)) };
}


/** A degraded gate never blocks; what it would have blocked goes to the simplification review instead. */
function degradedTriggers(gate: GateId, r: GateResult | undefined): TriggerHit[] {
  if (!r) return [{ id: "S6", gate, evidence: `degraded gate ${gate}: did not report`, routing: true }];
  const out: TriggerHit[] = r.triggers.filter((t) => t.routing || ALWAYS_ROUTING_TRIGGERS.has(t.id)).map((t) => ({ ...t, routing: true }));
  for (const v of r.violations.filter((x) => !x.waivedBy)) {
    out.push({
      id: "S6",
      gate,
      ...(v.file ? { file: v.file } : {}),
      ...(v.unit ? { unit: v.unit } : {}),
      evidence: `degraded gate ${gate}: ${v.reason} ${v.message}`,
      routing: true,
    });
  }
  for (const i of r.inconclusive) {
    out.push({ id: "S6", gate, ...(i.file ? { file: i.file } : {}), evidence: `degraded gate ${gate}: ${i.reason} ${i.detail}`, routing: true });
  }
  return out;
}

function fingerprintProblem(r: GateResult, s: SubmittedResult, e: ExpectedRun): string | null {
  if (r.base_sha !== e.base) return `base ${r.base_sha} ≠ ${e.base}`;
  if (r.candidate_sha !== e.candidate) return `candidate ${r.candidate_sha} ≠ ${e.candidate}`;
  if (r.policy_revision !== e.policyRevision) return `policy ${r.policy_revision} ≠ ${e.policyRevision}`;
  const fp: MeasurementFingerprint = r.measurement_fingerprint;
  if (fp.policy_revision !== e.policyRevision) return "fingerprint policy revision mismatch";
  // Actions runs execute the runner at the pinned workflow SHA; provenance covers them instead.
  if (s.source === "service" && fp.runner_commit !== e.runnerCommit) {
    return `runner ${fp.runner_commit} ≠ ${e.runnerCommit}`;
  }
  if (r.gate === "complexity" && e.cccc) {
    if (e.cccc.sha256 && fp.cccc_sha256 !== e.cccc.sha256) return "cccc binary sha256 mismatch";
    if (e.cccc.version && fp.cccc_version !== e.cccc.version) return "cccc version mismatch";
  }
  for (const [tool, version] of Object.entries(e.tools ?? {})) {
    const got = fp.tools?.[tool];
    if (got !== undefined && got !== version) return `${tool} ${got} ≠ ${version}`;
  }
  return null;
}

function select(candidates: SubmittedResult[]): { chosen?: SubmittedResult; problem?: string } {
  if (candidates.length <= 1) return { chosen: candidates[0] };
  if (candidates.every((c) => c.source === "actions")) {
    // Re-runs: the latest attempt of the latest run is authoritative.
    const sorted = [...candidates].sort(
      (a, b) =>
        (b.provenance!.runId - a.provenance!.runId) || (b.provenance!.runAttempt - a.provenance!.runAttempt),
    );
    return { chosen: sorted[0] };
  }
  const states = new Set(candidates.map((c) => c.result.state));
  if (states.size > 1) return { problem: "conflicting results for the same gate" };
  return { chosen: candidates[0] };
}

/** A result's claimed state can only be made stricter by its own contents. */
function effectiveState(r: GateResult): GateState {
  const recomputed = deriveState(r.violations, r.inconclusive, r.state !== "NOT_APPLICABLE");
  return worstState([r.state, recomputed]);
}

const GATE_ORDER: GateId[] = ["complexity", "lint-structure", "deps", "tests", "coverage", "mutation"];

export function aggregateQualityGate(input: AggregateInput): QualityGateVerdict {
  const { policy, expected } = input;
  const rows: GateVerdictRow[] = [];
  const aggInconclusive: Inconclusive[] = [];
  const counted: GateResult[] = [];
  const missing: GateId[] = [];

  const byGate = new Map<GateId, SubmittedResult[]>();
  for (const s of input.results) {
    const gate = s.result.gate;
    if (gate === "simplification-review") continue; // recomputed below from collected triggers
    const reject = (detail: string) =>
      aggInconclusive.push({ reason: "UNTRUSTED_ARTIFACT", file: undefined, detail: `${gate}: ${detail}`, authorFixable: false });
    if (SERVICE_GATES.has(gate) && s.source !== "service") {
      reject("this gate is only accepted from the gate service");
      continue;
    }
    if (ACTIONS_GATES.has(gate)) {
      // The service may evaluate these gates itself (static checks over git
      // blobs) using an artifact from the required workflow. A pass built on
      // test evidence must carry that workflow's provenance. Without an
      // artifact the service can only block (FAIL/INCONCLUSIVE) or find nothing
      // in scope (NOT_APPLICABLE, decided from the manifest), so it needs none.
      const state = effectiveState(s.result);
      const needsProvenance =
        s.source === "actions" || s.provenance !== undefined || (state !== "NOT_APPLICABLE" && PASSING.has(state));
      const p = needsProvenance ? provenanceProblem(s, input) : null;
      if (p) {
        reject(p);
        continue;
      }
    }
    const fp = fingerprintProblem(s.result, s, expected);
    if (fp) {
      aggInconclusive.push({ reason: "FINGERPRINT_MISMATCH", detail: `${gate}: ${fp}`, authorFixable: false });
      continue;
    }
    byGate.set(gate, [...(byGate.get(gate) ?? []), { ...s, result: sanitizeWaivers(s) }]);
  }

  // Triggers that reach G6 from gates that do not themselves count.
  const extraTriggers: TriggerHit[] = [];

  for (const gate of GATE_ORDER) {
    const mode = policyMode(policy, gate);
    const { chosen, problem } = select(byGate.get(gate) ?? []);
    if (problem) {
      aggInconclusive.push({ reason: "TOOL_ERROR", detail: `${gate}: ${problem}`, authorFixable: false });
    }
    if (!chosen) {
      if (mode === "degraded") extraTriggers.push(...degradedTriggers(gate, undefined));
      if (mode === "enforce") {
        missing.push(gate);
        if (!problem) {
          aggInconclusive.push({ reason: "REPORT_MISSING", detail: `${gate} did not report`, authorFixable: false });
        }
      }
      rows.push({ gate, mode, state: "MISSING", counted: false, summary: problem ?? "did not report" });
      continue;
    }
    const r = { ...chosen.result, mode, state: effectiveState(chosen.result) };
    const isCounted = mode === "enforce";
    if (isCounted) counted.push(r);
    else if (mode === "degraded") extraTriggers.push(...degradedTriggers(gate, r));
    else extraTriggers.push(...r.triggers.filter((t) => ALWAYS_ROUTING_TRIGGERS.has(t.id)));
    rows.push({ gate, mode, state: r.state, counted: isCounted, summary: r.summary });
  }

  // Observe-mode gates are excluded from aggregation except for S6/S11 (ruling D16).
  // S6/S11 route whatever the producing gate's mode, but a gate may still mark
  // one observe-only on purpose (ruling D5: an ordinary foreign-language file).
  const triggers: TriggerHit[] = routingTriggers([...counted.flatMap((r) => r.triggers), ...extraTriggers]);
  // A degraded G6 cannot route to itself, so it behaves like observe.
  const reviewMode = policyMode(policy, "simplification-review");
  const review = evaluateSimplificationReview({
    ...input.review,
    policy,
    mode: reviewMode,
    base: expected.base,
    candidate: expected.candidate,
    fingerprint: { runner_commit: expected.runnerCommit, policy_revision: expected.policyRevision },
    triggers,
  });
  if (reviewMode === "enforce") counted.push(review);
  rows.push({ gate: "simplification-review", mode: reviewMode, state: review.state, counted: reviewMode === "enforce", summary: review.summary });

  const integrity = [...(input.policyIntegrity ?? [])];
  if (integrity.length > 0 || input.policyIntegrity) {
    rows.push({
      gate: "policy-integrity",
      mode: "enforce",
      state: integrity.length ? "FAIL" : "PASS",
      counted: true,
      summary: integrity.length ? `FAIL: ${integrity[0]!.message}` : "PASS",
    });
  }

  const states: GateState[] = counted.map((r) => r.state);
  if (integrity.length) states.push("FAIL");
  if (aggInconclusive.length) states.push("INCONCLUSIVE");
  const state = states.length ? worstState(states) : "NOT_APPLICABLE";

  const blocking: Violation[] = [...integrity, ...counted.flatMap((r) => r.violations.filter((v) => !v.waivedBy))];
  const reasons: ReasonCode[] = [
    ...new Set<ReasonCode>([
      ...blocking.map((v) => v.reason),
      ...counted.flatMap((r) => r.inconclusive.map((i) => i.reason)),
      ...aggInconclusive.map((i) => i.reason),
    ]),
  ].sort((a, b) => reasonRank(a, blocking) - reasonRank(b, blocking));

  const mergeAllowed = state === "PASS" || state === "NOT_APPLICABLE" || state === "ACCEPTED_WITH_WAIVER";
  return {
    schema_version: 1,
    check: QUALITY_GATE_CHECK,
    state,
    mergeAllowed,
    base_sha: expected.base,
    candidate_sha: expected.candidate,
    policy_revision: expected.policyRevision,
    gates: rows,
    missing,
    reasons,
    inconclusive: [...aggInconclusive, ...counted.flatMap((r) => r.inconclusive)],
    blocking,
    triggers,
    review,
    summary: verdictHeadline(state, blocking, reasons, rows),
  };
}

/** FAIL reasons first: they are what the author can fix now (spec 4.2). */
function reasonRank(r: ReasonCode, blocking: Violation[]): number {
  return blocking.some((v) => v.reason === r) ? 0 : 1;
}

function verdictHeadline(state: GateState, blocking: Violation[], reasons: ReasonCode[], rows: GateVerdictRow[]): string {
  switch (state) {
    case "FAIL": {
      const failing = rows.filter((r) => r.counted && r.state === "FAIL").map((r) => r.gate);
      return `FAIL: ${blocking[0]?.message ?? reasons[0]} [${failing.join(", ")}]${blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ""}`;
    }
    case "INCONCLUSIVE":
      return `INCONCLUSIVE: ${reasons.join(", ")}`;
    case "ACCEPTED_WITH_WAIVER":
      return "PASS with waiver";
    case "PASS":
      return "PASS";
    case "NOT_APPLICABLE":
      return "N/A";
  }
}

export function stateRank(s: GateState): number {
  return GATE_STATES.indexOf(s);
}
