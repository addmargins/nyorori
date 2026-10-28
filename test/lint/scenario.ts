// End-to-end G2 scenario: real cccc measurement and unit matching (from the
// complexity helpers), real ESLint on both trees, then evaluateLint.

import { evaluateLint, type LintEvaluation } from "../../src/gates/lint/evaluate.js";
import { lintFiles } from "../../src/gates/lint/run.js";
import type { FileLintResult } from "../../src/gates/lint/types.js";
import { runScenario, type Scenario } from "../complexity/helpers.js";
import { writeTree } from "./helpers.js";

async function lintTree(files: Record<string, string>, paths: string[], policy: Parameters<typeof lintFiles>[2]) {
  if (paths.length === 0) return new Map<string, FileLintResult>();
  return lintFiles(writeTree(files), paths, policy);
}

export async function lintScenario(s: Scenario & { isAiLoop?: boolean }): Promise<LintEvaluation> {
  const r = runScenario(s);
  const bPaths = r.manifest.entries.flatMap((e) => (e.b && e.measure.B ? [e.b.path] : []));
  const cPaths = r.manifest.entries.flatMap((e) => (e.c && e.measure.C ? [e.c.path] : []));
  const [lintB, lintC] = await Promise.all([lintTree(s.b, bPaths, r.policy), lintTree(s.c, cPaths, r.policy)]);
  return evaluateLint({
    manifest: r.manifest,
    lintB,
    lintC,
    measurementsB: r.b,
    measurementsC: r.c,
    matches: r.match.matches,
    lineMaps: r.lineMaps,
    sourcesB: new Map(Object.entries(s.b)),
    sourcesC: new Map(Object.entries(s.c)),
    policy: r.policy,
    ...(s.isAiLoop ? { isAiLoop: true } : {}),
  });
}

export const reasons = (e: LintEvaluation) => e.violations.map((v) => v.reason);
export const triggerIds = (e: LintEvaluation) => e.triggers.map((t) => t.id);
