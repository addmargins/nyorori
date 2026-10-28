// What a replay compares: a normalized summary of one run (aggregate state,
// per-gate state/mode/reasons, triggers, violations) and the delta between the
// current and the comparison run of the same (B, C). Totals carry the spec 13.3
// friction metrics for each side.

import type { RunGatesOutput } from "../pipeline/types.js";
import { EXIT_CODE, GATE_IDS, GATE_STATES, type GateId, type GateMode, type GateState, type ReasonCode, type TriggerId } from "../types.js";

/** Gates the service computes itself (G1–G3). INCONCLUSIVE here means the measurement broke, not that artifacts were missing. */
export const SERVICE_GATES: ReadonlySet<GateId> = new Set<GateId>(["complexity", "lint-structure", "deps"]);

export interface GateSummary {
  gate: GateId;
  state: GateState;
  mode: GateMode;
  reasons: ReasonCode[];
}

export interface TriggerRow {
  id: TriggerId;
  gate: GateId;
  file: string | null;
  unit: string | null;
  routing: boolean;
  evidence: string;
}

export interface ViolationRow {
  gate: GateId;
  reason: ReasonCode;
  file: string;
  unit: string | null;
  line: number | null;
  after: number | null;
  limit: number | null;
  waived_by: string | null;
  message: string;
}

export interface RunSummary {
  state: GateState;
  merge_allowed: boolean;
  /** Shadow verdict (every gate enforced); null when the pipeline does not report it. */
  would_block: boolean | null;
  exit_code: 0 | 1 | 2;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  measurer: { cccc_version: string | null; cccc_sha256: string | null };
  gates: GateSummary[];
  triggers: TriggerRow[];
  violations: ViolationRow[];
  waivers_applied: number;
  /** A routing trigger fired or G6 demanded a review (whether or not it was then given). */
  review_required: boolean;
  /** Service gates (G1–G3) that were INCONCLUSIVE: the measurement itself failed. */
  service_inconclusive: GateId[];
  /** Run artifacts, relative to the replay output directory. */
  out_dir: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function triggerKey(t: TriggerRow): string {
  return `${t.id}\0${t.file ?? ""}\0${t.unit ?? ""}`;
}

export function violationKey(v: ViolationRow): string {
  return `${v.gate}\0${v.reason}\0${v.unit ?? ""}\0${v.file}`;
}

export function summarizeRun(out: RunGatesOutput, outDir: string): RunSummary {
  const { verdict, results } = out;
  const gates: GateSummary[] = GATE_IDS.flatMap((id) => {
    const r = results.find((x) => x.gate === id);
    return r ? [{ gate: id, state: r.state, mode: r.mode, reasons: [...new Set(r.reasons)].sort(cmp) }] : [];
  });
  const triggers: TriggerRow[] = results
    .flatMap((r) => r.triggers.map((t) => ({ id: t.id, gate: r.gate, file: t.file ?? null, unit: t.unit ?? null, routing: t.routing, evidence: t.evidence })))
    .sort((a, b) => cmp(triggerKey(a), triggerKey(b)));
  const violations: ViolationRow[] = results
    .flatMap((r) =>
      r.violations.map((v) => ({
        gate: r.gate,
        reason: v.reason,
        file: v.file,
        unit: v.unit ?? null,
        line: v.line ?? null,
        after: typeof v.after === "number" ? v.after : null,
        limit: typeof v.limit === "number" ? v.limit : null,
        waived_by: v.waivedBy ?? null,
        message: v.message,
      })),
    )
    .sort((a, b) => cmp(violationKey(a), violationKey(b)));
  const fp = results.find((r) => r.gate === "complexity")?.measurement_fingerprint;
  const reviewReasons = new Set(verdict.review.reasons);
  return {
    state: verdict.state,
    merge_allowed: verdict.mergeAllowed,
    would_block: typeof verdict.would_block === "boolean" ? verdict.would_block : null,
    exit_code: EXIT_CODE[verdict.state],
    base_sha: verdict.base_sha,
    candidate_sha: verdict.candidate_sha,
    policy_revision: verdict.policy_revision,
    measurer: { cccc_version: fp?.cccc_version ?? null, cccc_sha256: fp?.cccc_sha256 ?? null },
    gates,
    triggers,
    violations,
    waivers_applied: out.appliedWaivers.length,
    review_required: verdict.triggers.length > 0 || reviewReasons.has("REVIEW_REQUIRED") || reviewReasons.has("REVIEW_CHANGES_REQUESTED"),
    service_inconclusive: gates.filter((g) => SERVICE_GATES.has(g.gate) && g.state === "INCONCLUSIVE").map((g) => g.gate),
    out_dir: outDir,
  };
}

export interface MultisetDiff<T> {
  added: T[];
  removed: T[];
}

/** Multiset difference: a signal fired twice on one side and once on the other counts as one change. */
export function multisetDiff<T>(before: readonly T[], after: readonly T[], key: (t: T) => string): MultisetDiff<T> {
  const group = (rows: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      const g = m.get(k);
      if (g) g.push(r);
      else m.set(k, [r]);
    }
    return m;
  };
  const b = group(before);
  const a = group(after);
  const added: T[] = [];
  const removed: T[] = [];
  for (const k of [...new Set([...b.keys(), ...a.keys()])].sort(cmp)) {
    const was = b.get(k) ?? [];
    const now = a.get(k) ?? [];
    removed.push(...was.slice(now.length));
    added.push(...now.slice(was.length));
  }
  return { added, removed };
}

export interface GateDelta {
  gate: GateId;
  before: GateSummary;
  after: GateSummary;
}

export interface PairDelta {
  changed: boolean;
  state: { before: GateState; after: GateState } | null;
  merge_allowed: { before: boolean; after: boolean } | null;
  would_block: { before: boolean | null; after: boolean | null } | null;
  gates: GateDelta[];
  triggers: MultisetDiff<TriggerRow>;
  violations: MultisetDiff<ViolationRow>;
}

export function computeDelta(current: RunSummary, comparison: RunSummary): PairDelta {
  if (current.base_sha !== comparison.base_sha || current.candidate_sha !== comparison.candidate_sha) {
    throw new Error(`delta requires the same (B, C): ${current.base_sha}..${current.candidate_sha} vs ${comparison.base_sha}..${comparison.candidate_sha}`);
  }
  const gates: GateDelta[] = [];
  for (const before of current.gates) {
    const after = comparison.gates.find((g) => g.gate === before.gate);
    if (!after) continue;
    if (before.state !== after.state || before.mode !== after.mode || before.reasons.join(",") !== after.reasons.join(",")) {
      gates.push({ gate: before.gate, before, after });
    }
  }
  const triggers = multisetDiff(current.triggers, comparison.triggers, triggerKey);
  const violations = multisetDiff(current.violations, comparison.violations, violationKey);
  const state = current.state !== comparison.state ? { before: current.state, after: comparison.state } : null;
  const mergeAllowed = current.merge_allowed !== comparison.merge_allowed ? { before: current.merge_allowed, after: comparison.merge_allowed } : null;
  const wouldBlock = current.would_block !== comparison.would_block ? { before: current.would_block, after: comparison.would_block } : null;
  return {
    changed: state !== null || mergeAllowed !== null || wouldBlock !== null || gates.length > 0 || triggers.added.length + triggers.removed.length + violations.added.length + violations.removed.length > 0,
    state,
    merge_allowed: mergeAllowed,
    would_block: wouldBlock,
    gates,
    triggers,
    violations,
  };
}

/** Spec 13.3 friction metrics over the replayed pairs of one side. */
export interface Totals {
  runs: number;
  states: Record<GateState, number>;
  gate_states: Record<GateId, Record<GateState, number>>;
  /** Every fired trigger by id (routing and observe-only alike). */
  triggers_by_id: Record<string, number>;
  routing_triggers_by_id: Record<string, number>;
  fail_count: number;
  /** FAIL per PR (target ≤ 10%). */
  fail_rate: number | null;
  inconclusive_count: number;
  /** INCONCLUSIVE per PR (target < 1%). */
  inconclusive_rate: number | null;
  /** Pairs accepted only through waivers, and waivers applied in total (target ≤ 3%). */
  waived_pair_count: number;
  waiver_count: number;
  waived_pair_rate: number | null;
  review_required_count: number;
  /** Pairs that needed a G6 simplification review. */
  review_required_rate: number | null;
  service_inconclusive_count: number;
}

function stateCounts(): Record<GateState, number> {
  return Object.fromEntries(GATE_STATES.map((s) => [s, 0])) as Record<GateState, number>;
}

const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);

export function computeTotals(runs: readonly RunSummary[]): Totals {
  const t: Totals = {
    runs: runs.length,
    states: stateCounts(),
    gate_states: Object.fromEntries(GATE_IDS.map((g) => [g, stateCounts()])) as Totals["gate_states"],
    triggers_by_id: {},
    routing_triggers_by_id: {},
    fail_count: 0,
    fail_rate: null,
    inconclusive_count: 0,
    inconclusive_rate: null,
    waived_pair_count: 0,
    waiver_count: 0,
    waived_pair_rate: null,
    review_required_count: 0,
    review_required_rate: null,
    service_inconclusive_count: 0,
  };
  for (const r of runs) {
    t.states[r.state]++;
    for (const g of r.gates) t.gate_states[g.gate][g.state]++;
    for (const tr of r.triggers) {
      t.triggers_by_id[tr.id] = (t.triggers_by_id[tr.id] ?? 0) + 1;
      if (tr.routing) t.routing_triggers_by_id[tr.id] = (t.routing_triggers_by_id[tr.id] ?? 0) + 1;
    }
    if (r.state === "FAIL") t.fail_count++;
    if (r.state === "INCONCLUSIVE") t.inconclusive_count++;
    if (r.state === "ACCEPTED_WITH_WAIVER") t.waived_pair_count++;
    t.waiver_count += r.waivers_applied;
    if (r.review_required) t.review_required_count++;
    if (r.service_inconclusive.length) t.service_inconclusive_count++;
  }
  t.fail_rate = rate(t.fail_count, t.runs);
  t.inconclusive_rate = rate(t.inconclusive_count, t.runs);
  t.waived_pair_rate = rate(t.waived_pair_count, t.runs);
  t.review_required_rate = rate(t.review_required_count, t.runs);
  return t;
}
