// G1–G3: gates the service computes from git blobs without executing PR code.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { evaluateComplexity } from "../gates/complexity/evaluate.js";
import { CODE_EXTENSIONS } from "../gates/deps/graph.js";
import { evaluateDeps } from "../gates/deps/evaluate.js";
import { evaluateLint } from "../gates/lint/evaluate.js";
import { lintFiles } from "../gates/lint/run.js";
import type { FileLintResult } from "../gates/lint/types.js";
import { readBlobs } from "../git/manifest.js";
import { materializeFullTree, materializeSideChecked, treePath } from "../git/tree.js";
import { runCccc, validateRuns } from "../measure/cccc.js";
import { measureSides, unmeasuredRecords, type SideMeasurements } from "../measure/measure.js";
import { normalizedCodeLines, normalizeSource } from "../measure/normalize.js";
import type { Inconclusive, Manifest, Side, TriggerHit, Violation } from "../types.js";
import { matchUnits, type MatchResult } from "../units/match.js";
import { isAiLoopRun } from "./actions-gates.js";
import type { RunContext } from "./context.js";
import { dedupeInconclusive, emptyDraft, type GateDraft } from "./draft.js";
import { candidateScope } from "./scope.js";
import { allSettledOrThrow } from "./settle.js";

export interface Normalization {
  /** Pinned-Prettier code-line counts, keyed by C path (B path for deletions). */
  lines: Map<string, { B?: number; C?: number }>;
  /** C paths whose normalized text equals B's: a pure reformat (ruling D21a). */
  identical: Set<string>;
}

export interface MeasuredState {
  meas: SideMeasurements;
  match: MatchResult;
  normalization: Normalization;
}


/**
 * One Prettier pass per side feeds both the S9 line counts and the
 * reformat-only detection. The parser follows the measured path, so
 * extensionless shebang files format as the language cccc measured.
 */
export async function normalizeSides(
  manifest: Manifest,
  meas: Pick<SideMeasurements, "sourcesB" | "sourcesC">,
): Promise<Normalization> {
  const lines = new Map<string, { B?: number; C?: number }>();
  const identical = new Set<string>();
  for (const e of manifest.entries) {
    const b = e.measure.B && e.b ? e.b : null;
    const c = e.measure.C && e.c ? e.c : null;
    if (!b && !c) continue;
    const textB = b ? meas.sourcesB.get(b.path) : undefined;
    const textC = c ? meas.sourcesC.get(c.path) : undefined;
    const normB = b && textB !== undefined ? await normalizeSource(textB, b.measuredPath) : null;
    const normC = c && textC !== undefined ? await normalizeSource(textC, c.measuredPath) : null;
    const rec: { B?: number; C?: number } = {};
    if (b && normB !== null) rec.B = normalizedCodeLines(normB, b.measuredPath);
    if (c && normC !== null) rec.C = normalizedCodeLines(normC, c.measuredPath);
    lines.set((c ?? b)!.path, rec);
    if (c && normB !== null && normC !== null && normB === normC) identical.add(c.path);
  }
  return { lines, identical };
}

export async function measure(ctx: RunContext): Promise<MeasuredState> {
  const { opts, policy, manifest, lineMaps } = ctx;
  const meas = await measureSides({
    repoDir: opts.repoDir,
    manifest,
    policy,
    binary: opts.ccccBinary,
    workDir: opts.workDir,
    runnerCommit: opts.runnerCommit,
    ...(opts.rng ? { rng: opts.rng } : {}),
  });
  meas.fingerprint.tools = ctx.tools;
  const normalization = await normalizeSides(manifest, meas);
  const match = matchUnits({
    manifest,
    b: meas.b,
    c: meas.c,
    lineMaps,
    baselineMissing: meas.baselineMissing,
    sourcesB: meas.sourcesB,
    sourcesC: meas.sourcesC,
    normalizedIdentical: normalization.identical,
    limit: policy.complexity.cognitive_limit,
  });
  return { meas, match, normalization };
}

/** G1. Measurement-level INCONCLUSIVE records belong to this gate. */
export async function complexityGate(ctx: RunContext, state: MeasuredState): Promise<GateDraft> {
  const { manifest, policy, lineMaps } = ctx;
  const { meas, match, normalization } = state;
  const evaluation = evaluateComplexity({
    manifest,
    b: meas.b,
    c: meas.c,
    lineMaps,
    matches: match.matches,
    policy,
    normalizedLines: normalization.lines,
    normalizedIdentical: normalization.identical,
    sourcesC: meas.sourcesC,
    baselineMissing: meas.baselineMissing,
    isAiLoop: isAiLoopRun(ctx),
  });
  const unmeasured = unmeasuredRecords(manifest);
  // Unmeasured C files and manifest problems still need a verdict (S11, INCONCLUSIVE).
  const scope = candidateScope(manifest);
  const draft = emptyDraft(
    "complexity",
    meas.fingerprint,
    unmeasured.some((u) => u.side === "C") || manifest.problems.length > 0 ? { applicable: true } : scope,
  );
  draft.violations = evaluation.violations;
  draft.triggers = evaluation.triggers;
  draft.inconclusive = dedupeInconclusive([
    ...meas.inconclusive,
    ...evaluation.inconclusive,
    ...(await declarationImplementations(ctx)),
  ]);
  draft.unmeasured = unmeasured;
  draft.observe = { ...evaluation.observe, determinism_checked: meas.determinismChecked };
  return draft;
}

const AMBIENT_IMPL = /implementation cannot be declared in ambient contexts/i;

/**
 * `.d.ts` files are out of scope, but an implementation hidden in one would be
 * unmeasured code. cccc reports it as a parse error (spec 2.3).
 */
async function declarationImplementations(ctx: RunContext): Promise<Inconclusive[]> {
  const { opts, policy, manifest } = ctx;
  if (!policy.scope.declaration_impl_check) return [];
  const decl = manifest.entries.flatMap((e) =>
    e.excluded === "DECLARATION_FILE" && e.c && (e.c.mode === "100644" || e.c.mode === "100755") ? [e.c] : [],
  );
  if (decl.length === 0) return [];
  const root = await mkdtemp(join(opts.workDir, "decl-"));
  try {
    const blobs = await readBlobs(opts.repoDir, decl.map((d) => d.blob));
    for (const d of decl) {
      const target = treePath(root, d.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blobs.get(d.blob)!);
    }
    const runs = await runCccc({ binary: opts.ccccBinary, treeRoot: root, files: decl.map((d) => d.path), policy, side: "C" });
    const validated = validateRuns(runs, policy);
    // Ordinary parse errors in declaration files are not this check's business.
    const out = validated.inconclusive.filter((i) => i.reason !== "PARSE_ERROR_CANDIDATE");
    for (const f of validated.files) {
      const hit = (f.parse_errors ?? []).find((e) => AMBIENT_IMPL.test(e));
      if (hit) {
        out.push({
          reason: "PARSE_ERROR_CANDIDATE",
          file: f.path,
          detail: `${f.path} is a declaration file but contains an implementation (${hit}); move the code to a .ts file`,
          authorFixable: true,
        });
      }
    }
    return out;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function lintSide(
  ctx: RunContext,
  side: Side,
  root: string,
): Promise<{ results: Map<string, FileLintResult>; problems: Inconclusive[] }> {
  const { opts, manifest, policy } = ctx;
  const { files, problems } = await materializeSideChecked(opts.repoDir, manifest, side, root);
  const byMeasured = await lintFiles(root, files.map((f) => f.measuredPath), policy);
  // evaluateLint is keyed by repository path; the tree holds measured paths
  // (foo.js.jsx, bin/cli.shebang.js).
  const results = new Map<string, FileLintResult>();
  for (const f of files) {
    const r = byMeasured.get(f.measuredPath);
    if (r) results.set(f.path, { ...r, path: f.path });
  }
  return { results, problems };
}

/** P1 enforces only some block rules (spec 13.1); the rest are recorded, not blocking. */
function splitEnforced(violations: Violation[], enforced: readonly string[]): { kept: Violation[]; observed: Violation[] } {
  if (enforced.length === 0) return { kept: violations, observed: [] };
  const allow = new Set(enforced);
  const kept: Violation[] = [];
  const observed: Violation[] = [];
  for (const v of violations) (v.metric !== undefined && allow.has(v.metric) ? kept : observed).push(v);
  return { kept, observed };
}

/** G2. Uses its own blob trees so it does not depend on cccc having run. */
export async function lintGate(ctx: RunContext, state: MeasuredState): Promise<GateDraft> {
  const { opts, manifest, policy, lineMaps } = ctx;
  const draft = emptyDraft("lint-structure", ctx.fingerprint, candidateScope(manifest));
  if (!draft.applicable) return draft;
  const root = await mkdtemp(join(opts.workDir, "lint-"));
  try {
    const [b, c] = await allSettledOrThrow([lintSide(ctx, "B", join(root, "B")), lintSide(ctx, "C", join(root, "C"))]);
    const evaluation = evaluateLint({
      manifest,
      lintB: b.results,
      lintC: c.results,
      measurementsB: state.meas.b,
      measurementsC: state.meas.c,
      matches: state.match.matches,
      lineMaps,
      sourcesB: ctx.textsB,
      sourcesC: ctx.textsC,
      policy,
      isAiLoop: isAiLoopRun(ctx),
    });
    const { kept, observed } = splitEnforced(evaluation.violations, policy.lint.enforced_rules);
    draft.violations = kept;
    draft.triggers = evaluation.triggers;
    // A C file that could not be written was not linted; B-side problems only lose a baseline.
    draft.inconclusive = [...evaluation.inconclusive, ...c.problems];
    draft.observe = { ...evaluation.observe, unenforced_violations: observed, base_materialize_problems: b.problems };
    return draft;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isGraphFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Resolution data G3 reads (never executes): every tsconfig (`extends` chains and
 * nested aliases) and every package.json outside node_modules (`imports`, `exports`,
 * self-reference by name).
 */
function isResolutionConfig(path: string): boolean {
  const name = basename(path);
  if (/^tsconfig.*\.json$/.test(name)) return true;
  return name === "package.json" && !path.split("/").includes("node_modules");
}

/** G3 needs the whole module graph of both trees, not only the changed files. */
export async function depsGate(ctx: RunContext): Promise<GateDraft> {
  const { opts, manifest, policy } = ctx;
  const draft = emptyDraft("deps", ctx.fingerprint, candidateScope(manifest));
  if (!draft.applicable) return draft;
  const root = await mkdtemp(join(opts.workDir, "deps-"));
  try {
    const keep = (p: string) => isGraphFile(p) || isResolutionConfig(p);
    const skipped: Array<{ side: Side; path: string; reason: string }> = [];
    const tree = (side: Side, sha: string) =>
      materializeFullTree(opts.repoDir, sha, join(root, side), keep, {
        maxFileBytes: policy.scope.max_file_bytes,
        onSkip: (path, reason) => skipped.push({ side, path, reason }),
      });
    const [treeB, treeC] = await allSettledOrThrow([tree("B", manifest.baseSha), tree("C", manifest.candidateSha)]);
    const renames = new Map<string, string>();
    for (const e of manifest.entries) if (e.status === "R" && e.b && e.c) renames.set(e.c.path, e.b.path);
    const evaluation = await evaluateDeps({
      treeB: join(root, "B"),
      treeC: join(root, "C"),
      filesB: treeB.map((f) => f.path).filter(isGraphFile),
      filesC: treeC.map((f) => f.path).filter(isGraphFile),
      policy,
      changedPaths: manifest.entries.flatMap((e) => (e.c && (e.status === "M" || e.status === "R") ? [e.c.path] : [])),
      renames,
      allFilesC: [...ctx.treeC.keys()],
    });
    draft.violations = evaluation.violations;
    const changedC = new Set(manifest.entries.flatMap((e) => (e.c ? [e.c.path] : [])));
    draft.triggers = [...evaluation.triggers, ...skippedTriggers(skipped, changedC)];
    draft.inconclusive = evaluation.inconclusive;
    draft.observe = { ...evaluation.observe, graph_skipped_files: skipped };
    return draft;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Files the graph could not include are never dropped silently: all are listed
 * in observe, and a skipped file this PR changed goes to a human. Unchanged
 * skips were skipped identically on B, so they hide nothing new.
 */
function skippedTriggers(skipped: ReadonlyArray<{ side: Side; path: string; reason: string }>, changedC: ReadonlySet<string>): TriggerHit[] {
  return skipped
    .filter((s) => s.side === "C" && changedC.has(s.path))
    .map((s) => ({
      id: "S11" as const,
      gate: "deps" as const,
      file: s.path,
      evidence: `${s.path} left out of the module graph (${s.reason}); its imports and cycles are unchecked`,
      routing: true,
    }));
}
