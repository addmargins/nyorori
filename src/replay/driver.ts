// Replays a dataset of (B, C) pairs through runGates under the current policy
// and measurer, optionally once more under a comparison policy and/or
// measurer, and reports every judgement that differs (spec 6.1 step 2 for an
// upgrade, 13.4 for recovery) plus the spec 13.3 friction metrics.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { writeFile } from "node:fs/promises";
import type { LoadedPolicy } from "../policy/load.js";
import { runGates } from "../pipeline/run.js";
import type { RunGatesOptions } from "../pipeline/types.js";
import { DatasetError, loadDataset, resolveOutsideRepo, type ResolvedPair } from "./dataset.js";
import { computeDelta, computeTotals, summarizeRun, type PairDelta, type RunSummary, type Totals } from "./delta.js";
import { loadPairInputs } from "./inputs.js";
import { pLimit } from "./limit.js";
import { writeRunOutputs } from "./outputs.js";
import { renderReplaySummary } from "./summary.js";
import { errorMessage } from "../util/errors.js";

export const DEFAULT_JOBS = 2;
export const REPLAY_RESULT_FILE = "replay-result.json";
export const REPLAY_SUMMARY_FILE = "replay-summary.md";

export type Side = "current" | "comparison";

export interface ReplayOptions {
  repoDir: string;
  datasetPath: string;
  /** Fresh or empty directory, outside the repository. */
  outDir: string;
  /** Scratch space for runGates (each run gets its own temp dir inside). */
  workDir: string;
  policy: LoadedPolicy;
  ccccBinary: string;
  /** Comparison side: `comparePolicy ?? policy` with `compareCccc ?? ccccBinary`. Omit both for a single-sided recovery check. */
  comparePolicy?: LoadedPolicy;
  compareCccc?: string;
  runnerCommit: string;
  /** Pairs measured at once (default 2). */
  jobs?: number;
  rng?: () => number;
  now?: Date;
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface SideInfo {
  policy_revision: string;
  cccc_binary: string;
}

export interface PairError {
  side: Side;
  message: string;
}

export interface PairReport {
  id: string;
  base: string;
  candidate: string;
  current: RunSummary | null;
  comparison: RunSummary | null;
  delta: PairDelta | null;
  errors: PairError[];
}

export interface ReplayReport {
  schema_version: 1;
  repository: string | null;
  dataset: { path: string; sha256: string; pairs: number };
  sides: { current: SideInfo; comparison: SideInfo | null };
  jobs: number;
  /** 0 no deltas · 1 deltas · 2 a run failed or a service gate (G1–G3) was INCONCLUSIVE under the current policy. */
  exit_code: 0 | 1 | 2;
  counts: {
    pairs: number;
    /** Pairs whose every requested side ran to a verdict. */
    completed: number;
    changed: number;
    errored: number;
    /** Pairs with a service-gate INCONCLUSIVE under the current policy. */
    service_inconclusive: number;
  };
  totals: { current: Totals; comparison: Totals | null };
  pairs: PairReport[];
}

async function prepareOutDir(outDir: string, repoReal: string): Promise<string> {
  const real = await resolveOutsideRepo(outDir, process.cwd(), repoReal, "out dir");
  const s = await stat(real).catch(() => null);
  if (s) {
    if (!s.isDirectory()) throw new DatasetError(`out dir ${outDir} is not a directory`);
    if ((await readdir(real)).length) throw new DatasetError(`out dir ${outDir} is not empty; replay needs a fresh directory`);
  } else {
    await mkdir(real, { recursive: true });
  }
  return real;
}

interface SideSpec extends SideInfo {
  policy: LoadedPolicy;
}

export async function replay(opts: ReplayOptions): Promise<ReplayReport> {
  const jobs = opts.jobs ?? DEFAULT_JOBS;
  if (!Number.isInteger(jobs) || jobs < 1) throw new DatasetError(`--jobs must be a positive integer (got ${String(opts.jobs)})`);
  const repoReal = await realpath(opts.repoDir);
  const loaded = await loadDataset(opts.datasetPath, repoReal, (p) => readFile(p, "utf8"));
  const outReal = await prepareOutDir(opts.outDir, repoReal);
  const datasetSha = createHash("sha256").update(await readFile(loaded.path)).digest("hex");

  const sides: Record<Side, SideSpec | null> = {
    current: { policy: opts.policy, policy_revision: opts.policy.revision, cccc_binary: opts.ccccBinary },
    comparison:
      opts.comparePolicy || opts.compareCccc
        ? {
            policy: opts.comparePolicy ?? opts.policy,
            policy_revision: (opts.comparePolicy ?? opts.policy).revision,
            cccc_binary: opts.compareCccc ?? opts.ccccBinary,
          }
        : null,
  };
  const log = opts.log ?? (() => {});
  const total = loaded.pairs.length;
  let done = 0;

  const runSide = async (pair: ResolvedPair, side: Side, spec: SideSpec): Promise<RunSummary> => {
    const dir = join(outReal, pair.id, side);
    const inputs = await loadPairInputs(pair);
    const runOpts: RunGatesOptions = {
      repoDir: repoReal,
      base: pair.base,
      candidate: pair.candidate,
      policy: spec.policy.policy,
      policyRevision: spec.policy.revision,
      ccccBinary: spec.cccc_binary,
      workDir: opts.workDir,
      runnerCommit: opts.runnerCommit,
      ...(inputs.pr ? { pr: inputs.pr } : {}),
      ...(inputs.artifacts ? { artifacts: inputs.artifacts } : {}),
      ...(inputs.previousAttempt ? { previousAttempt: inputs.previousAttempt } : {}),
      ...(opts.rng ? { rng: opts.rng } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    };
    const out = await runGates(runOpts);
    await writeRunOutputs(dir, out);
    return summarizeRun(out, relative(outReal, dir));
  };

  const runPair = async (pair: ResolvedPair): Promise<PairReport> => {
    const report: PairReport = { id: pair.id, base: pair.base, candidate: pair.candidate, current: null, comparison: null, delta: null, errors: [] };
    await mkdir(join(outReal, pair.id), { recursive: true });
    for (const side of ["current", "comparison"] as const) {
      const spec = sides[side];
      if (!spec) continue;
      try {
        report[side] = await runSide(pair, side, spec);
      } catch (e) {
        report.errors.push({ side, message: errorMessage(e) });
      }
    }
    if (report.current && report.comparison) report.delta = computeDelta(report.current, report.comparison);
    done++;
    const states = [report.current?.state ?? "ERROR", ...(sides.comparison ? [report.comparison?.state ?? "ERROR"] : [])].join(" → ");
    log(`[${done}/${total}] ${pair.id} ${states}${report.delta?.changed ? " (changed)" : ""}`);
    return report;
  };

  const limit = pLimit(jobs);
  const pairs = await Promise.all(loaded.pairs.map((p) => limit(() => runPair(p))));

  const currentRuns = pairs.flatMap((p) => (p.current ? [p.current] : []));
  const comparisonRuns = pairs.flatMap((p) => (p.comparison ? [p.comparison] : []));
  const errored = pairs.filter((p) => p.errors.length > 0).length;
  const changed = pairs.filter((p) => p.delta?.changed).length;
  const serviceInconclusive = pairs.filter((p) => (p.current?.service_inconclusive.length ?? 0) > 0).length;
  const exitCode: 0 | 1 | 2 = errored > 0 || serviceInconclusive > 0 ? 2 : changed > 0 ? 1 : 0;

  const report: ReplayReport = {
    schema_version: 1,
    repository: loaded.dataset.repository ?? null,
    dataset: { path: loaded.path, sha256: datasetSha, pairs: total },
    sides: {
      current: { policy_revision: sides.current!.policy_revision, cccc_binary: sides.current!.cccc_binary },
      comparison: sides.comparison ? { policy_revision: sides.comparison.policy_revision, cccc_binary: sides.comparison.cccc_binary } : null,
    },
    jobs,
    exit_code: exitCode,
    counts: { pairs: total, completed: total - errored, changed, errored, service_inconclusive: serviceInconclusive },
    totals: { current: computeTotals(currentRuns), comparison: sides.comparison ? computeTotals(comparisonRuns) : null },
    pairs,
  };
  await writeFile(join(outReal, REPLAY_RESULT_FILE), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(outReal, REPLAY_SUMMARY_FILE), renderReplaySummary(report) + "\n");
  return report;
}
