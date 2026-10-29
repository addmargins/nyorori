// Spec 7.5 moving baseline: a manipulation split over several PRs looks small
// against each PR's own B. For every changed file, S1/S9/S10/S12 are also
// computed against an older state of that file on the base branch, so the
// slices add up. Observe-only until policy.triggers.moving_baseline.route.

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { evaluateComplexity } from "../gates/complexity/evaluate.js";
import { fileLineMaps } from "../git/linemap.js";
import { buildManifest } from "../git/manifest.js";
import { materializeSideChecked } from "../git/tree.js";
import { runCccc, validateRuns } from "../measure/cccc.js";
import type { FileMeasurement, Manifest, TriggerHit, TriggerId } from "../types.js";
import { matchUnits } from "../units/match.js";
import { buildFileMeasurement } from "../units/model.js";
import { isAiLoopRun } from "./actions-gates.js";
import type { RunContext } from "./context.js";
import type { GateDraft } from "./draft.js";
import { candidatesFor, chooseBaseline, cutoffCommit, historyIndex, readFirstParentHistory, type FirstParentHistory } from "./history.js";
import { normalizeSides, type MeasuredState } from "./service-gates.js";

const KEPT: ReadonlySet<TriggerId> = new Set<TriggerId>(["S1", "S9", "S10", "S12"]);

/** Changed C files that exist on B, keyed by their B path (history is looked up there). */
function trackedFiles(manifest: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of manifest.entries) {
    if ((e.status === "M" || e.status === "R") && e.b && e.c && e.measure.C) out.set(e.b.path, e.c.path);
  }
  return out;
}

/** G1 of (M → C) for one group of files; only the shape triggers are returned. */
async function triggersAgainst(
  ctx: RunContext,
  measured: MeasuredState,
  baseline: string,
  cPaths: ReadonlySet<string>,
  cache: Map<string, FileMeasurement>,
): Promise<TriggerHit[]> {
  const { opts, policy } = ctx;
  const full = await buildManifest(opts.repoDir, baseline, ctx.manifest.candidateSha, policy);
  const manifest: Manifest = { ...full, entries: full.entries.filter((e) => e.c && cPaths.has(e.c.path)) };
  const b = new Map<string, FileMeasurement>();
  const c = new Map<string, FileMeasurement>();
  const sourcesB = new Map<string, string>();
  for (const p of cPaths) {
    const m = measured.meas.c.get(p);
    if (m) c.set(p, m);
  }
  const baselineMissing = new Set<string>();
  const dir = await mkdtemp(join(opts.workDir, "moving-"));
  try {
    const { files } = await materializeSideChecked(opts.repoDir, manifest, "B", dir);
    const toMeasure = files.filter((f) => !cache.has(`${f.path}\u0000${f.blob}`));
    if (toMeasure.length > 0) {
      const runs = await runCccc({ binary: opts.ccccBinary, treeRoot: dir, files: toMeasure.map((f) => f.measuredPath), policy, side: "B" });
      const v = validateRuns(runs, policy);
      if (v.inconclusive.length > 0) throw new Error(`measurement of ${baseline.slice(0, 12)} incomplete: ${v.inconclusive[0]!.reason}`);
      const broken = new Set(v.baselineParseErrors);
      const byMeasured = new Map(v.files.map((f) => [f.path, f]));
      for (const f of toMeasure) {
        const r = byMeasured.get(f.measuredPath);
        if (r && !broken.has(f.measuredPath)) cache.set(`${f.path}\u0000${f.blob}`, buildFileMeasurement("B", f.path, f.blob, r, f.lineCount));
      }
    }
    for (const f of files) {
      sourcesB.set(f.path, f.text);
      const m = cache.get(`${f.path}\u0000${f.blob}`);
      const e = manifest.entries.find((x) => x.b?.path === f.path);
      if (m) b.set(f.path, m);
      else if (e?.c) baselineMissing.add(e.c.path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const lineMaps = await fileLineMaps(opts.repoDir, manifest);
  const normalization = await normalizeSides(manifest, { sourcesB, sourcesC: measured.meas.sourcesC });
  const match = matchUnits({
    manifest,
    b,
    c,
    lineMaps,
    baselineMissing,
    sourcesB,
    sourcesC: measured.meas.sourcesC,
    normalizedIdentical: normalization.identical,
    limit: policy.complexity.cognitive_limit,
    testGlobs: policy.scope.test_globs,
  });
  const evaluation = evaluateComplexity({
    manifest,
    b,
    c,
    lineMaps,
    matches: match.matches,
    policy,
    normalizedLines: normalization.lines,
    normalizedIdentical: normalization.identical,
    sourcesC: measured.meas.sourcesC,
    sourcesB,
    baselineMissing,
    isAiLoop: isAiLoopRun(ctx),
  });
  return evaluation.triggers.filter((t) => KEPT.has(t.id));
}

const triggerKey = (t: TriggerHit) => `${t.id}\u0000${t.file ?? ""}\u0000${t.unit ?? ""}`;

/**
 * Adds the moving-baseline hits to G1. Never blocks and never touches the PR's
 * own findings: a failure is recorded in observe as TOOL_ERROR.
 */
export async function addMovingBaselineTriggers(ctx: RunContext, measured: MeasuredState | undefined, g1: GateDraft): Promise<void> {
  const cfg = ctx.policy.triggers.moving_baseline;
  if (!cfg.enabled || !measured) return;
  const tracked = trackedFiles(ctx.manifest);
  if (tracked.size === 0) return;
  const note: Record<string, unknown> = { route: cfg.route, files: tracked.size, baselines: {} as Record<string, string> };
  // Observe-only runs are capped: a sweeping PR would otherwise measure hundreds of baselines for a signal nobody acts on yet.
  if (!cfg.route && tracked.size > cfg.max_files) {
    note.skipped = `${tracked.size} changed files exceed triggers.moving_baseline.max_files (${cfg.max_files}) while route=false`;
    g1.observe = { ...g1.observe, moving_baseline: note };
    return;
  }
  try {
    const groups = selectBaselines(await readFirstParentHistory(ctx.opts.repoDir, ctx.manifest.baseSha), tracked, cfg);
    for (const [m, cPaths] of groups) for (const p of cPaths) (note.baselines as Record<string, string>)[p] = m;
    const seen = new Set(g1.triggers.map(triggerKey));
    const cache = new Map<string, FileMeasurement>();
    let hits = 0;
    for (const [m, cPaths] of groups) {
      for (const t of await triggersAgainst(ctx, measured, m, cPaths, cache)) {
        if (seen.has(triggerKey(t))) continue;
        seen.add(triggerKey(t));
        g1.triggers.push({ ...t, evidence: `moving baseline ${m.slice(0, 12)}: ${t.evidence}`, routing: cfg.route });
        hits++;
      }
    }
    note.hits = hits;
  } catch (e) {
    note.error = { reason: "TOOL_ERROR", detail: e instanceof Error ? e.message : String(e) };
  }
  g1.observe = { ...g1.observe, moving_baseline: note };
}

/** Baseline commit → C paths judged against it. Pure: one history read serves every file. */
export function selectBaselines(
  history: FirstParentHistory,
  tracked: ReadonlyMap<string, string>,
  cfg: { lookback_merges: number; lookback_days: number },
): Map<string, Set<string>> {
  const index = historyIndex(history);
  const beforeCutoff = cutoffCommit(history, cfg.lookback_days);
  const groups = new Map<string, Set<string>>();
  for (const [bPath, cPath] of tracked) {
    const m = chooseBaseline(candidatesFor(history, bPath, cfg.lookback_merges, beforeCutoff), index);
    if (!m) continue;
    groups.set(m, (groups.get(m) ?? new Set()).add(cPath));
  }
  return groups;
}
