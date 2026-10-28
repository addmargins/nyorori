// G1–G3: gates the service computes from git blobs without executing PR code.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evaluateComplexity } from "../gates/complexity/evaluate.js";
import { CODE_EXTENSIONS } from "../gates/deps/graph.js";
import { evaluateDeps } from "../gates/deps/evaluate.js";
import { evaluateLint } from "../gates/lint/evaluate.js";
import { lintFiles } from "../gates/lint/run.js";
import type { FileLintResult } from "../gates/lint/types.js";
import { readBlobs } from "../git/manifest.js";
import { materializeFullTree, materializeSide, treePath } from "../git/tree.js";
import { runCccc, validateRuns } from "../measure/cccc.js";
import { measureSides, unmeasuredRecords, type SideMeasurements } from "../measure/measure.js";
import { normalizedLineCounts } from "../measure/normalize.js";
import type { Inconclusive, Manifest, Side, Violation } from "../types.js";
import { matchUnits, type MatchResult } from "../units/match.js";
import type { RunContext } from "./context.js";
import { dedupeInconclusive, emptyDraft, type GateDraft } from "./draft.js";

export interface MeasuredState {
  meas: SideMeasurements;
  match: MatchResult;
}

function hasMeasuredCode(manifest: Manifest): boolean {
  return manifest.entries.some((e) => e.measure.B || e.measure.C);
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
  const match = matchUnits({ manifest, b: meas.b, c: meas.c, lineMaps, baselineMissing: meas.baselineMissing });
  return { meas, match };
}

/** G1. Measurement-level INCONCLUSIVE records belong to this gate. */
export async function complexityGate(ctx: RunContext, state: MeasuredState): Promise<GateDraft> {
  const { manifest, policy, lineMaps } = ctx;
  const { meas, match } = state;
  const pairs = manifest.entries
    .filter((e) => e.measure.B || e.measure.C)
    .map((e) => ({ b: e.measure.B ? (e.b?.path ?? null) : null, c: e.measure.C ? (e.c?.path ?? null) : null }));
  const normalizedLines = await normalizedLineCounts(meas.sourcesB, meas.sourcesC, pairs);
  const evaluation = evaluateComplexity({
    manifest,
    b: meas.b,
    c: meas.c,
    lineMaps,
    matches: match.matches,
    policy,
    normalizedLines,
    sourcesC: meas.sourcesC,
    baselineMissing: meas.baselineMissing,
  });
  const unmeasured = unmeasuredRecords(manifest);
  const draft = emptyDraft("complexity", meas.fingerprint, hasMeasuredCode(manifest) || unmeasured.length > 0 || manifest.problems.length > 0);
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

async function lintSide(ctx: RunContext, side: Side, root: string): Promise<Map<string, FileLintResult>> {
  const { opts, manifest, policy } = ctx;
  const files = await materializeSide(opts.repoDir, manifest, side, root);
  const byMeasured = await lintFiles(root, files.map((f) => f.measuredPath), policy);
  // evaluateLint is keyed by repository path; the tree holds measured paths (foo.js.jsx).
  const out = new Map<string, FileLintResult>();
  for (const f of files) {
    const r = byMeasured.get(f.measuredPath);
    if (r) out.set(f.path, { ...r, path: f.path });
  }
  return out;
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
  const draft = emptyDraft("lint-structure", ctx.fingerprint, hasMeasuredCode(manifest));
  if (!draft.applicable) return draft;
  const root = await mkdtemp(join(opts.workDir, "lint-"));
  try {
    const [lintB, lintC] = await Promise.all([lintSide(ctx, "B", join(root, "B")), lintSide(ctx, "C", join(root, "C"))]);
    const evaluation = evaluateLint({
      manifest,
      lintB,
      lintC,
      measurementsB: state.meas.b,
      measurementsC: state.meas.c,
      matches: state.match.matches,
      lineMaps,
      sourcesB: ctx.textsB,
      sourcesC: ctx.textsC,
      policy,
    });
    const { kept, observed } = splitEnforced(evaluation.violations, policy.lint.enforced_rules);
    draft.violations = kept;
    draft.triggers = evaluation.triggers;
    draft.inconclusive = evaluation.inconclusive;
    draft.observe = { ...evaluation.observe, unenforced_violations: observed };
    return draft;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isGraphFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** G3 needs the whole module graph of both trees, not only the changed files. */
export async function depsGate(ctx: RunContext): Promise<GateDraft> {
  const { opts, manifest, policy } = ctx;
  const draft = emptyDraft("deps", ctx.fingerprint, hasMeasuredCode(manifest));
  if (!draft.applicable) return draft;
  const root = await mkdtemp(join(opts.workDir, "deps-"));
  try {
    const keep = (p: string) => isGraphFile(p) || p === "tsconfig.json";
    const [treeB, treeC] = await Promise.all([
      materializeFullTree(opts.repoDir, manifest.baseSha, join(root, "B"), keep),
      materializeFullTree(opts.repoDir, manifest.candidateSha, join(root, "C"), keep),
    ]);
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
    });
    draft.violations = evaluation.violations;
    draft.triggers = evaluation.triggers;
    draft.inconclusive = evaluation.inconclusive;
    draft.observe = { ...evaluation.observe };
    return draft;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
