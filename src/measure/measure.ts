// Measures both sides of a change with one pinned binary in one run (spec 6),
// and turns cccc's file reports into FileMeasurements keyed by repository path.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { problemIsAuthorFixable } from "../git/manifest.js";
import { materializeSideChecked, type MaterializedFile } from "../git/tree.js";
import type { Policy } from "../policy/schema.js";
import type {
  CcccFile,
  FileMeasurement,
  Inconclusive,
  Manifest,
  MeasurementFingerprint,
  UnmeasuredRecord,
} from "../types.js";
import { buildFileMeasurement, countableUnits } from "../units/model.js";
import { runCccc, validateRuns, type CcccRun } from "./cccc.js";
import { buildFingerprint, checkMeasurer, pinMeasurer } from "./fingerprint.js";

export interface MeasureSidesOptions {
  repoDir: string;
  manifest: Manifest;
  policy: Policy;
  binary: string;
  /** Scratch directory; B and C trees are written below it and removed afterwards unless keepTrees. */
  workDir: string;
  runnerCommit?: string;
  /** Injectable for the determinism sample; defaults to Math.random. */
  rng?: () => number;
  /** The official merge_group evaluation samples the -j1 re-run at determinism_sample_rate_official. */
  official?: boolean;
  keepTrees?: boolean;
}

export interface SideMeasurements {
  /** Keyed by B repository path. */
  b: Map<string, FileMeasurement>;
  /** Keyed by C repository path. */
  c: Map<string, FileMeasurement>;
  /** C paths whose B side exists but could not be parsed: all their units are new. */
  baselineMissing: Set<string>;
  sourcesB: Map<string, string>;
  sourcesC: Map<string, string>;
  inconclusive: Inconclusive[];
  fingerprint: MeasurementFingerprint;
  /** Raw cccc runs, for the gate artifacts (spec 9.2). */
  runs: CcccRun[];
  /** Whether the determinism re-run was sampled for this execution. */
  determinismChecked: boolean;
  treeRoots?: { B: string; C: string };
}

/** Manifest problems as INCONCLUSIVE records. */
export function manifestInconclusive(manifest: Manifest): Inconclusive[] {
  return manifest.problems.map((p) => ({
    reason: p.reason,
    file: p.path,
    detail: p.detail,
    authorFixable: problemIsAuthorFixable(p.reason),
  }));
}

export function unmeasuredRecords(manifest: Manifest): UnmeasuredRecord[] {
  const out: UnmeasuredRecord[] = [];
  for (const e of manifest.entries) {
    if (!e.unmeasured) continue;
    const s = e.c ?? e.b!;
    out.push({ path: s.path, side: e.c ? "C" : "B", reason: e.unmeasured });
  }
  return out;
}

/**
 * Entries whose bytes are identical on both sides (pure renames, mode changes)
 * are measured once on C: same binary + same bytes + same parser routing gives
 * the same report, so B reuses it.
 */
function reuseFromC(manifest: Manifest): Set<string> {
  const reuse = new Set<string>();
  for (const e of manifest.entries) {
    if (!e.b || !e.c || !e.measure.B || !e.measure.C) continue;
    const ext = (p: string) => p.slice(p.lastIndexOf("."));
    if (e.b.blob === e.c.blob && ext(e.b.measuredPath) === ext(e.c.measuredPath)) reuse.add(e.b.path);
  }
  return reuse;
}

function stdoutOf(runs: CcccRun[]): Buffer {
  return Buffer.concat(runs.map((r) => r.stdout));
}

export async function measureSides(opts: MeasureSidesOptions): Promise<SideMeasurements> {
  const { repoDir, manifest, policy } = opts;
  await mkdir(opts.workDir, { recursive: true });
  const root = await mkdtemp(join(opts.workDir, "trees-"));
  const roots = { B: join(root, "B"), C: join(root, "C") };
  const id = await pinMeasurer(opts.binary, root);
  const binary = id.path;
  const fingerprint = buildFingerprint(id, policy, opts.runnerCommit ?? "unknown");
  const inconclusive: Inconclusive[] = [...checkMeasurer(id, policy), ...manifestInconclusive(manifest)];
  const reuse = reuseFromC(manifest);
  const result: SideMeasurements = {
    b: new Map(),
    c: new Map(),
    baselineMissing: new Set(),
    sourcesB: new Map(),
    sourcesC: new Map(),
    inconclusive,
    fingerprint,
    runs: [],
    determinismChecked: false,
    ...(opts.keepTrees ? { treeRoots: roots } : {}),
  };
  // A mismatched measurer produces numbers nobody may compare: stop here.
  if (inconclusive.some((i) => i.reason === "MEASURER_MISMATCH")) {
    await rm(root, { recursive: true, force: true });
    return result;
  }

  try {
    const sideB = await materializeSideChecked(repoDir, manifest, "B", roots.B);
    const sideC = await materializeSideChecked(repoDir, manifest, "C", roots.C);
    // A B side that cannot be written only loses its baseline; a C side cannot be judged.
    inconclusive.push(...sideC.problems);
    const matB = sideB.files;
    const matC = sideC.files;
    for (const p of sideB.problems) {
      const e = manifest.entries.find((x) => x.b?.path === p.file);
      if (e?.c) result.baselineMissing.add(e.c.path);
    }
    for (const f of matB) result.sourcesB.set(f.path, f.text);
    for (const f of matC) result.sourcesC.set(f.path, f.text);

    const toMeasureB = matB.filter((f) => !reuse.has(f.path));
    const runsB = await runCccc({ binary, treeRoot: roots.B, files: toMeasureB.map((f) => f.measuredPath), policy, side: "B" });
    const runsC = await runCccc({ binary, treeRoot: roots.C, files: matC.map((f) => f.measuredPath), policy, side: "C" });
    result.runs.push(...runsB, ...runsC);
    const vB = validateRuns(runsB, policy);
    const vC = validateRuns(runsC, policy);
    inconclusive.push(...vB.inconclusive, ...vC.inconclusive);

    const cFiles = indexByMeasuredPath(vC.files);
    const bFiles = indexByMeasuredPath(vB.files);
    const cByRepoPath = new Map<string, CcccFile>();
    for (const f of matC) {
      const report = cFiles.get(f.measuredPath);
      if (!report) continue;
      cByRepoPath.set(f.path, report);
      result.c.set(f.path, buildFileMeasurement("C", f.path, f.blob, report, f.lineCount));
    }

    const pairOfB = new Map<string, string>();
    for (const e of manifest.entries) if (e.b && e.c) pairOfB.set(e.b.path, e.c.path);
    const brokenB = new Set(vB.baselineParseErrors);
    for (const f of matB) {
      if (brokenB.has(f.measuredPath)) {
        const cPath = pairOfB.get(f.path);
        if (cPath !== undefined) result.baselineMissing.add(cPath);
        continue;
      }
      const report = reuse.has(f.path) ? cByRepoPath.get(pairOfB.get(f.path)!) : bFiles.get(f.measuredPath);
      if (!report) continue;
      result.b.set(f.path, buildFileMeasurement("B", f.path, f.blob, report, f.lineCount));
    }

    inconclusive.push(...unitsVanished(manifest, result, matB, matC, policy));

    const rng = opts.rng ?? Math.random;
    const rate = opts.official ? policy.measurer.determinism_sample_rate_official : policy.measurer.determinism_sample_rate;
    if (matC.length > 0 && rng() < rate) {
      result.determinismChecked = true;
      // Every C chunk is measured again, single-threaded, and compared byte for byte.
      const again = await runCccc({ binary, treeRoot: roots.C, files: matC.map((f) => f.measuredPath), policy, side: "C", jobs: 1 });
      if (!stdoutOf(again).equals(stdoutOf(runsC))) {
        inconclusive.push({
          reason: "NONDETERMINISM",
          detail: "re-running the candidate side with -j1 produced different bytes",
          authorFixable: false,
        });
      }
    }
    return result;
  } finally {
    if (!opts.keepTrees) await rm(root, { recursive: true, force: true });
  }
}

function indexByMeasuredPath(files: CcccFile[]): Map<string, CcccFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** Spec 6.4: a file that had units on B and none on C without shrinking is suspicious. */
function unitsVanished(
  manifest: Manifest,
  m: SideMeasurements,
  matB: MaterializedFile[],
  matC: MaterializedFile[],
  policy: Policy,
): Inconclusive[] {
  const out: Inconclusive[] = [];
  const linesB = new Map(matB.map((f) => [f.path, f.lineCount]));
  const linesC = new Map(matC.map((f) => [f.path, f.lineCount]));
  for (const e of manifest.entries) {
    if (!e.b || !e.c) continue;
    const mb = m.b.get(e.b.path);
    const mc = m.c.get(e.c.path);
    if (!mb || !mc) continue;
    const before = countableUnits(mb).length;
    const after = countableUnits(mc).length;
    const lb = linesB.get(e.b.path) ?? 0;
    const lc = linesC.get(e.c.path) ?? 0;
    if (before >= policy.complexity.vanish_min_units && after === 0 && lc * 2 > lb) {
      out.push({
        reason: "UNITS_VANISHED",
        file: e.c.path,
        detail: `${e.c.path}: ${before} units on B, 0 on C while the file kept ${lc}/${lb} lines`,
        authorFixable: false,
      });
    }
  }
  return out;
}

