// One full gate run for (repo, B, C, P, M): measure, evaluate every sub-gate,
// apply overrides and waivers, then aggregate into the quality-gate verdict.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommit } from "../git/exec.js";
import { fileLineMaps } from "../git/linemap.js";
import { buildManifest } from "../git/manifest.js";
import { buildGateFeedback } from "../report/feedback.js";
import { verdictToCheckRun } from "../report/checkrun.js";
import { renderSummaryMarkdown } from "../report/markdown.js";
import type { MeasurementFingerprint } from "../types.js";
import { coverageGate, mutationGate, testsGate } from "./actions-gates.js";
import { candidateTree, readChangedTexts, toolVersions, type RunContext } from "./context.js";
import { aggregate, applyMeasurementOverrides, applyWaiverDecisions, finalize } from "./decisions.js";
import { guard, type GateDraft } from "./draft.js";
import { complexityGate, depsGate, lintGate, measure, type MeasuredState } from "./service-gates.js";
import type { RunGatesOptions, RunGatesOutput } from "./types.js";

async function buildContext(opts: RunGatesOptions, workDir: string): Promise<RunContext> {
  const policy = { ...opts.policy, revision: opts.policyRevision };
  const base = await resolveCommit(opts.repoDir, opts.base);
  const candidate = await resolveCommit(opts.repoDir, opts.candidate);
  const manifest = await buildManifest(opts.repoDir, base, candidate, policy);
  const [lineMaps, treeC, texts] = await Promise.all([
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

export async function runGates(opts: RunGatesOptions): Promise<RunGatesOutput> {
  await mkdir(opts.workDir, { recursive: true });
  const workDir = await mkdtemp(join(opts.workDir, "run-"));
  try {
    const ctx = await buildContext(opts, workDir);

    let measured: MeasuredState | undefined;
    const g1 = await guard("complexity", ctx.fingerprint, async () => {
      measured = await measure(ctx);
      return complexityGate(ctx, measured);
    });
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
    const waivers = applyWaiverDecisions(ctx, drafts);
    const results = drafts.map((d) => finalize(ctx, d));
    const verdict = aggregate(ctx, drafts, results, waivers);
    const all = [...results, verdict.review];
    return {
      verdict,
      results: all,
      manifest: ctx.manifest,
      ccccRuns: measured?.meas.runs ?? [],
      summaryMarkdown: renderSummaryMarkdown(all, verdict),
      checkRun: verdictToCheckRun(verdict, all),
      feedback: buildGateFeedback(all, {
        attempt: opts.attempt ?? 1,
        preserve: ["Every test that passes on the base must still pass on the candidate."],
      }),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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
  };
}
