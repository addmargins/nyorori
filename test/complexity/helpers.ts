// Test harness for G1: measures in-memory B/C sources with the real cccc
// binary, derives -U0 hunks with `git diff --no-index`, and runs matching
// and the complexity evaluation the way the pipeline will.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPolicy, type Policy, type PolicyInput } from "../../src/policy/schema.js";
import type {
  CcccReport,
  FileLineMap,
  FileMeasurement,
  Hunk,
  Manifest,
  ManifestEntry,
  Side,
} from "../../src/types.js";
import { buildFileMeasurement } from "../../src/units/model.js";
import { matchUnits, type MatchResult } from "../../src/units/match.js";
import { evaluateComplexity, type ComplexityOutcome } from "../../src/gates/complexity/evaluate.js";

export const CCCC = process.env.NYORORI_CCCC ?? "/home/user/moznion/cccc/target/release/cccc";

export function lineCount(src: string): number {
  if (src.length === 0) return 0;
  const n = src.split("\n").length;
  return src.endsWith("\n") ? n - 1 : n;
}

export function runCccc(files: Record<string, string>): CcccReport {
  const dir = mkdtempSync(join(tmpdir(), "nyorori-g1-"));
  try {
    const paths = Object.keys(files);
    for (const p of paths) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), files[p]!);
    }
    const out = execFileSync(CCCC, ["--no-config", "--no-cache", "--lang", "es", "--", ...paths], {
      cwd: dir,
      encoding: "utf8",
    });
    return JSON.parse(out) as CcccReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function measure(side: Side, files: Record<string, string>): Map<string, FileMeasurement> {
  const out = new Map<string, FileMeasurement>();
  if (Object.keys(files).length === 0) return out;
  const report = runCccc(files);
  for (const f of report.files) {
    out.set(f.path, buildFileMeasurement(side, f.path, `blob-${side}-${f.path}`, f, lineCount(files[f.path]!)));
  }
  return out;
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const m of diff.matchAll(re)) {
    hunks.push({
      bStart: Number(m[1]),
      bCount: m[2] === undefined ? 1 : Number(m[2]),
      cStart: Number(m[3]),
      cCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

export function hunksBetween(before: string, after: string): Hunk[] {
  const dir = mkdtempSync(join(tmpdir(), "nyorori-diff-"));
  try {
    writeFileSync(join(dir, "b"), before);
    writeFileSync(join(dir, "c"), after);
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U0", "b", "c"], {
      cwd: dir,
      encoding: "utf8",
    });
    return parseHunks(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Scenario {
  b: Record<string, string>;
  c: Record<string, string>;
  /** C path → B path for renames. */
  renames?: Record<string, string>;
  /** C paths that are copies of a B path (status C): measured on C only. */
  copies?: Record<string, string>;
  tests?: string[];
  policy?: Partial<PolicyInput>;
  baselineMissing?: string[];
  normalizedLines?: Map<string, { B?: number; C?: number }>;
  extraEntries?: ManifestEntry[];
  sensitivePathsChanged?: string[];
}

export interface ScenarioResult {
  manifest: Manifest;
  b: Map<string, FileMeasurement>;
  c: Map<string, FileMeasurement>;
  lineMaps: FileLineMap[];
  match: MatchResult;
  outcome: ComplexityOutcome;
  policy: Policy;
}

function side(path: string, s: Side): ManifestEntry["b"] {
  return { path, blob: `blob-${s}-${path}`, mode: "100644", measuredPath: path };
}

export function buildManifest(s: Scenario): Manifest {
  const entries: ManifestEntry[] = [];
  const renamedFrom = new Map(Object.entries(s.renames ?? {}));
  const copiedFrom = new Map(Object.entries(s.copies ?? {}));
  const consumedB = new Set(renamedFrom.values());
  const isTest = (p: string) => s.tests?.includes(p) ?? false;
  for (const cPath of Object.keys(s.c)) {
    const bFrom = renamedFrom.get(cPath);
    if (bFrom !== undefined) {
      entries.push({ status: "R", similarity: 90, b: side(bFrom, "B"), c: side(cPath, "C"), measure: { B: true, C: true }, isTest: isTest(cPath) });
    } else if (copiedFrom.has(cPath)) {
      entries.push({ status: "C", similarity: 100, b: side(copiedFrom.get(cPath)!, "B"), c: side(cPath, "C"), measure: { B: false, C: true }, isTest: isTest(cPath) });
    } else if (cPath in s.b) {
      entries.push({ status: "M", b: side(cPath, "B"), c: side(cPath, "C"), measure: { B: true, C: true }, isTest: isTest(cPath) });
    } else {
      entries.push({ status: "A", b: null, c: side(cPath, "C"), measure: { B: false, C: true }, isTest: isTest(cPath) });
    }
  }
  for (const bPath of Object.keys(s.b)) {
    if (bPath in s.c || consumedB.has(bPath) || [...copiedFrom.values()].includes(bPath)) continue;
    entries.push({ status: "D", b: side(bPath, "B"), c: null, measure: { B: true, C: false }, isTest: isTest(bPath) });
  }
  entries.push(...(s.extraEntries ?? []));
  return {
    baseSha: "b".repeat(40),
    candidateSha: "c".repeat(40),
    entries,
    problems: [],
    sensitivePathsChanged: s.sensitivePathsChanged ?? [],
  };
}

export function runScenario(s: Scenario): ScenarioResult {
  const policy = defaultPolicy(s.policy ?? {});
  const manifest = buildManifest(s);
  const bFiles: Record<string, string> = {};
  const cFiles: Record<string, string> = {};
  for (const e of manifest.entries) {
    if (e.b && e.measure.B) bFiles[e.b.path] = s.b[e.b.path]!;
    if (e.c && e.measure.C) cFiles[e.c.path] = s.c[e.c.path]!;
  }
  const b = measure("B", bFiles);
  const c = measure("C", cFiles);
  const lineMaps: FileLineMap[] = [];
  for (const e of manifest.entries) {
    if ((e.status === "M" || e.status === "R") && e.b && e.c) {
      lineMaps.push({ pathB: e.b.path, pathC: e.c.path, hunks: hunksBetween(s.b[e.b.path]!, s.c[e.c.path]!) });
    }
  }
  const baselineMissing = new Set(s.baselineMissing ?? []);
  const match = matchUnits({ manifest, b, c, lineMaps, baselineMissing });
  const outcome = evaluateComplexity({
    manifest,
    b,
    c,
    lineMaps,
    matches: match.matches,
    policy,
    sourcesC: new Map(Object.entries(s.c)),
    baselineMissing,
    ...(s.normalizedLines ? { normalizedLines: s.normalizedLines } : {}),
  });
  return { manifest, b, c, lineMaps, match, outcome, policy };
}

export function triggerIds(r: ScenarioResult): string[] {
  return [...new Set(r.outcome.triggers.map((t) => t.id))].sort();
}

export function violationReasons(r: ScenarioResult): string[] {
  return r.outcome.violations.map((v) => `${v.unit}:${v.reason}`);
}

/** Generates a function with exactly `n` sequential top-level `if`s: CogC n, CC n+1. */
export function ifChain(name: string, n: number, indent = ""): string {
  const body = Array.from({ length: n }, (_, i) => `${indent}  if (x === ${i}) y += ${i};`).join("\n");
  return `${indent}function ${name}(x) {\n${indent}  let y = 0;\n${body}\n${indent}  return y;\n${indent}}\n`;
}
