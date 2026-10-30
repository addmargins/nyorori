// One full gate run for (repo, B, C, P, M): measure, evaluate every sub-gate,
// apply overrides and waivers, then aggregate into the quality-gate verdict.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommit } from "../git/exec.js";
import { fileLineMaps } from "../git/linemap.js";
import { buildManifest } from "../git/manifest.js";
import { buildGateFeedback } from "../report/feedback.js";
import { verdictToCheckRun } from "../report/checkrun.js";
import { renderSummaryMarkdown, renderWaiverApprovalHints } from "../report/markdown.js";
import type { GateResult, MeasurementFingerprint } from "../types.js";
import { withVerdictInconclusive } from "../aggregate/index.js";
import { mergePreviousAttemptTriggers } from "../ailoop/index.js";
import { coverageGate, isAiLoopRun, mutationGate, testsGate } from "./actions-gates.js";
import { candidateTree, readChangedTexts, toolVersions, type RunContext } from "./context.js";
import { aggregate, applyMeasurementOverrides, applyWaiverDecisions, finalize, type WaiverOutcome } from "./decisions.js";
import { guard, type GateDraft } from "./draft.js";
import { allSettledOrThrow } from "./settle.js";
import { addMovingBaselineTriggers } from "./moving-baseline.js";
import { complexityGate, depsGate, lintGate, measure, type MeasuredState } from "./service-gates.js";
import { artifactsFromZip } from "./artifacts.js";
import { assertToolsOutsideRepo } from "./paths.js";
import type { AppliedWaiver, Authority, RunGatesOptions, RunGatesOutput } from "./types.js";
import { errorMessage } from "../util/errors.js";

async function buildContext(opts: RunGatesOptions, workDir: string): Promise<RunContext> {
  const policy = { ...opts.policy, revision: opts.policyRevision };
  const base = await resolveCommit(opts.repoDir, opts.base);
  const candidate = await resolveCommit(opts.repoDir, opts.candidate);
  const manifest = await buildManifest(opts.repoDir, base, candidate, policy);
  // Inside runGates' cleanup scope: settle every read before the work dir is removed.
  const [lineMaps, treeC, texts] = await allSettledOrThrow([
    fileLineMaps(opts.repoDir, manifest),
    candidateTree(opts.repoDir, candidate),
    readChangedTexts(opts.repoDir, manifest, policy.scope.max_file_bytes),
  ]);
  const tools = toolVersions();
  const fingerprint: MeasurementFingerprint = {
    runner_commit: opts.runnerCommit,
    policy_revision: policy.revision,
    tools,
  };
  return {
    opts: { ...opts, workDir },
    policy,
    manifest,
    lineMaps,
    treeC,
    textsB: texts.B,
    textsC: texts.C,
    fingerprint,
    tools,
  };
}

export async function runGates(input: RunGatesOptions): Promise<RunGatesOutput> {
  if (!input.allowRepoPaths) await assertToolsOutsideRepo(input.repoDir, [{ label: "cccc binary", path: input.ccccBinary }, { label: "work dir", path: input.workDir }]);
  const authority: Authority = input.authority ?? "local";
  let zipProblem: string | undefined;
  let opts = input;
  if (input.artifactZip) {
    try {
      opts = { ...input, artifacts: { ...input.artifacts, ...(await artifactsFromZip(input.artifactZip)) } };
    } catch (e) {
      zipProblem = `required-workflow artifact was rejected: ${errorMessage(e)}`;
    }
  }
  await mkdir(opts.workDir, { recursive: true });
  const workDir = await mkdtemp(join(opts.workDir, "run-"));
  try {
    const ctx = await buildContext(opts, workDir);

    let measured: MeasuredState | undefined;
    const g1 = await guard("complexity", ctx.fingerprint, async () => {
      measured = await measure(ctx);
      return complexityGate(ctx, measured);
    });
    await addPreviousAttemptTriggers(ctx, workDir, g1);
    await addMovingBaselineTriggers(ctx, measured, g1);
    // Lint maps hits to units; without measurements it falls back to file-level comparison.
    const state: MeasuredState = measured ?? emptyMeasured(ctx);
    const drafts: GateDraft[] = [
      g1,
      await guard("lint-structure", ctx.fingerprint, () => lintGate(ctx, state)),
      await guard("deps", ctx.fingerprint, () => depsGate(ctx)),
      await guard("tests", ctx.fingerprint, () => testsGate(ctx)),
      await guard("coverage", ctx.fingerprint, () => coverageGate(ctx)),
      await guard("mutation", ctx.fingerprint, () => mutationGate(ctx)),
    ];

    applyMeasurementOverrides(ctx, drafts);
    const waivers = await applyWaiverDecisions(ctx, drafts, measured);
    const results = drafts.map((d) => finalize(ctx, d));
    const aggregated = aggregate(ctx, drafts, results, waivers);
    const verdict = {
      ...(zipProblem ? withVerdictInconclusive(aggregated, { reason: "UNTRUSTED_ARTIFACT", detail: zipProblem, authorFixable: false }) : aggregated),
      authority,
    };
    const all = [...results, verdict.review];
    const hints = renderWaiverApprovalHints(waivers.pending.flatMap((p) => (p.blob ? [{ id: p.id, unit: p.unit, blob: p.blob }] : [])));
    return {
      authority,
      verdict,
      results: all,
      manifest: ctx.manifest,
      ccccRuns: measured?.meas.runs ?? [],
      summaryMarkdown: [authorityLine(authority), renderSummaryMarkdown(all, verdict), hints].filter(Boolean).join("\n"),
      checkRun: verdictToCheckRun(verdict, all),
      appliedWaivers: appliedWaivers(waivers, results),
      pendingWaivers: waivers.pending,
      candidateWorkflowPaths: [...ctx.treeC.keys()].filter((p) => p.startsWith(".github/workflows/")).sort(),
      feedback: buildGateFeedback(all, {
        attempt: opts.attempt ?? 1,
        preserve: ["Every test that passes on the base must still pass on the candidate."],
      }),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Spec 10.1: only the gate service's own check carries merge authority. */
export function authorityLine(a: Authority): string {
  return a === "github-app"
    ? "_authority: github-app — 게이트 서비스의 공식 판정_"
    : "_authority: local — 로컬 실행 결과는 병합 승인이 아니다. 공식 판정은 게이트 서비스의 `quality-gate` 체크다._";
}

/** G1 alone for another (B, C) pair of the same repository and policy. */
async function complexityFor(opts: RunGatesOptions, workDir: string, base: string, candidate: string): Promise<GateDraft> {
  const ctx = await buildContext({ ...opts, base, candidate }, workDir);
  return complexityGate(ctx, await measure(ctx));
}

/**
 * Ruling D17: an AI loop could launder a redistribution across attempts, each
 * attempt looking fine against B. For files that violated G1 in C_{n-1}, the
 * shape triggers of C_n against C_{n-1} also route (the B ratchet is unchanged).
 */
async function addPreviousAttemptTriggers(ctx: RunContext, workDir: string, g1: GateDraft): Promise<void> {
  const prev = ctx.opts.previousAttempt;
  if (!prev || !isAiLoopRun(ctx)) return;
  try {
    const prevVsB = await complexityFor(ctx.opts, workDir, ctx.opts.base, prev);
    const violating = new Set(prevVsB.violations.map((v) => v.file));
    if (violating.size === 0) return;
    const vsPrev = await complexityFor(ctx.opts, workDir, prev, ctx.opts.candidate);
    g1.triggers = mergePreviousAttemptTriggers(g1.triggers, vsPrev.triggers, violating);
  } catch (e) {
    g1.inconclusive.push({
      reason: "TOOL_ERROR",
      detail: `previous-attempt comparison against ${prev} failed: ${errorMessage(e)}`,
      authorFixable: false,
    });
  }
}

function appliedWaivers(w: WaiverOutcome, results: readonly GateResult[]): AppliedWaiver[] {
  return w.applied.flatMap((a) => {
    const waiver = w.valid.find((v) => v.id === a.id);
    if (!waiver) return [];
    const values = results.flatMap((r) => r.violations.filter((v) => v.waivedBy === a.id && typeof v.after === "number").map((v) => v.after as number));
    return [{ waiver, value: values.length ? Math.max(...values) : null }];
  });
}

function emptyMeasured(ctx: RunContext): MeasuredState {
  return {
    meas: {
      b: new Map(),
      c: new Map(),
      baselineMissing: new Set(),
      sourcesB: new Map(),
      sourcesC: new Map(),
      inconclusive: [],
      fingerprint: ctx.fingerprint,
      runs: [],
      determinismChecked: false,
    },
    match: { matches: [], byC: new Map(), byB: new Map(), nameWarnings: [] },
    normalization: { lines: new Map(), identical: new Set() },
  };
}
