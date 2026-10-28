// Human decisions applied to the drafts: measurement overrides (INCONCLUSIVE),
// waivers (FAIL), the AI-loop forbidden-change check, then finalization and
// the quality-gate aggregation (spec 4.2, 11, 12.2).

import { aggregateQualityGate, policyMode, type QualityGateVerdict, type SubmittedResult } from "../aggregate/index.js";
import { detectForbiddenChanges, type LoopChange, type PackageJsonPair } from "../ailoop/index.js";
import { applyOverrides } from "../override/index.js";
import type { Policy } from "../policy/schema.js";
import { finalizeGateResult } from "../report/result.js";
import type { PrIdentityContext } from "../review/independence.js";
import type { GateResult, Violation, WaiverApplied } from "../types.js";
import { applyWaivers, evaluateWaivers, waiverTriggers, WAIVABLE_GATES, type ValidWaiver } from "../waivers/index.js";
import { candidateBlobLookup, type RunContext } from "./context.js";
import type { GateDraft } from "./draft.js";
import { isAiLoopRun } from "./actions-gates.js";

const NO_IDENTITY: PrIdentityContext = { prAuthor: "", commits: [], agentInvokers: [] };

function identity(ctx: RunContext): PrIdentityContext {
  return ctx.opts.pr?.identity ?? NO_IDENTITY;
}

export function applyMeasurementOverrides(ctx: RunContext, drafts: GateDraft[]): void {
  const comments = ctx.opts.pr?.comments ?? [];
  const candidateBlob = candidateBlobLookup(ctx.treeC);
  for (const d of drafts) {
    if (d.inconclusive.length === 0) continue;
    const o = applyOverrides(d.gate, d.inconclusive, comments, {
      policy: ctx.policy,
      identity: identity(ctx),
      ...(ctx.opts.pr?.teams ? { teams: ctx.opts.pr.teams } : {}),
      candidateBlob,
    });
    d.inconclusive = o.inconclusive;
    d.unmeasured.push(...o.unmeasured);
    d.triggers.push(...o.triggers);
    if (o.applied.length || o.rejected.length) {
      d.observe = { ...d.observe, overrides_applied: o.applied, overrides_rejected: o.rejected };
    }
  }
}

export interface WaiverOutcome {
  applied: WaiverApplied[];
  valid: ValidWaiver[];
}

/** The quarterly budget caps the per-PR budget by what is left this quarter (spec 11.1). */
function budgetedPolicy(policy: Policy, quarterUsed: number): Policy {
  const left = Math.max(0, policy.waivers.per_quarter_budget - quarterUsed);
  return { ...policy, waivers: { ...policy.waivers, per_pr_budget: Math.min(policy.waivers.per_pr_budget, left) } };
}

export function applyWaiverDecisions(ctx: RunContext, drafts: GateDraft[]): WaiverOutcome {
  const comments = ctx.opts.pr?.comments ?? [];
  const { valid, rejected } = evaluateWaivers(comments, {
    policy: ctx.policy,
    identity: identity(ctx),
    ...(ctx.opts.pr?.teams ? { teams: ctx.opts.pr.teams } : {}),
    now: ctx.opts.now ?? new Date(),
    candidateBlob: candidateBlobLookup(ctx.treeC),
  });
  const waivable = drafts.filter((d) => WAIVABLE_GATES.has(d.gate));
  const all: Violation[] = waivable.flatMap((d) => d.violations);
  const policy = budgetedPolicy(ctx.policy, ctx.opts.pr?.quarterWaiversUsed ?? 0);
  const result = applyWaivers(all, valid, policy);
  let i = 0;
  for (const d of waivable) {
    d.violations = result.violations.slice(i, i + d.violations.length);
    i += d.violations.length;
  }
  for (const t of waiverTriggers(result.applied, valid)) {
    drafts.find((d) => d.gate === t.gate)?.triggers.push(t);
  }
  const first = drafts.find((d) => d.gate === "complexity");
  if (first && (rejected.length || result.unused.length)) {
    first.observe = { ...first.observe, waivers_rejected: rejected, waivers_unused: result.unused };
  }
  for (const d of waivable) {
    const ids = new Set(d.violations.flatMap((v) => (v.waivedBy ? [v.waivedBy] : [])));
    d.waivers = result.applied.filter((a) => ids.has(a.id));
  }
  return { applied: result.applied, valid };
}

/** Spec 12.2: forbidden changes are a mechanical FAIL for registered AI-loop bots only. */
export function policyIntegrity(ctx: RunContext): Violation[] | undefined {
  if (!isAiLoopRun(ctx)) return undefined;
  const byC = new Map(ctx.lineMaps.map((m) => [m.pathC, m]));
  const changes: LoopChange[] = ctx.manifest.entries.map((e) => {
    const map = e.c ? byC.get(e.c.path) : undefined;
    const text = e.c ? ctx.textsC.get(e.c.path) : undefined;
    const lines = text?.split("\n") ?? [];
    const addedLines = map
      ? map.hunks.flatMap((h) =>
          Array.from({ length: h.cCount }, (_, k) => h.cStart + k).map((line) => ({ line, text: lines[line - 1] ?? "" })),
        )
      : [];
    return { status: e.status, pathB: e.b?.path ?? null, pathC: e.c?.path ?? null, addedLines };
  });
  const packageJsons: PackageJsonPair[] = ctx.manifest.entries
    .filter((e) => [e.b?.path, e.c?.path].some((p) => p?.split("/").pop() === "package.json"))
    .map((e) => ({
      path: (e.c ?? e.b)!.path,
      before: e.b ? (ctx.textsB.get(e.b.path) ?? null) : null,
      after: e.c ? (ctx.textsC.get(e.c.path) ?? null) : null,
    }));
  return detectForbiddenChanges(changes, ctx.policy, packageJsons);
}

export function finalize(ctx: RunContext, d: GateDraft): GateResult {
  return finalizeGateResult({
    gate: d.gate,
    mode: policyMode(ctx.policy, d.gate),
    base: ctx.manifest.baseSha,
    candidate: ctx.manifest.candidateSha,
    policyRevision: ctx.policy.revision,
    fingerprint: d.fingerprint,
    violations: d.violations,
    inconclusive: d.inconclusive,
    triggers: d.triggers,
    waivers: d.waivers,
    unmeasured: d.unmeasured,
    observe: d.observe,
    applicable: d.applicable,
  });
}

export function aggregate(
  ctx: RunContext,
  drafts: GateDraft[],
  results: GateResult[],
  waivers: WaiverOutcome,
): QualityGateVerdict {
  const { policy, opts } = ctx;
  const submitted: SubmittedResult[] = results.map((result, i) => ({
    result,
    source: "service",
    ...(drafts[i]!.provenance ? { provenance: drafts[i]!.provenance } : {}),
  }));
  const integrity = policyIntegrity(ctx);
  return aggregateQualityGate({
    policy,
    expected: {
      base: ctx.manifest.baseSha,
      candidate: ctx.manifest.candidateSha,
      policyRevision: policy.revision,
      runnerCommit: opts.runnerCommit,
      cccc: {
        version: policy.measurer.cccc_version,
        ...(policy.measurer.cccc_sha256 ? { sha256: policy.measurer.cccc_sha256 } : {}),
      },
      tools: ctx.tools,
    },
    results: submitted,
    trustedWorkflows: { workflows: policy.provenance.trusted_workflows },
    review: {
      headSha: opts.pr?.headSha ?? ctx.manifest.candidateSha,
      comments: opts.pr?.comments ?? [],
      identity: identity(ctx),
      ...(opts.pr?.teams ? { teams: opts.pr.teams } : {}),
      ...(opts.pr?.carryOver ? { carryOver: opts.pr.carryOver } : {}),
      waiverApprovers: waivers.applied.map((a) => ({ unit: a.unit, approver: a.approver })),
      ...(opts.pr?.llm ? { llm: opts.pr.llm } : {}),
    },
    ...(integrity ? { policyIntegrity: integrity } : {}),
  });
}
