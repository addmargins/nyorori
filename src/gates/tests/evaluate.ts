// G4 `gate/tests` (spec 8.3): the test run passed, at least one test ran, and
// neither the tests nor their configuration got weaker between B and C.
//
// Test renames: a changed `describe`/`it` title changes the test ID, so it is
// indistinguishable from "deleted one test, added another". It is reported as
// TEST_REMOVED with the same file's new tests listed as rename candidates; a
// gate owner approves it (not a waiver). File renames found by git (R) are
// followed, so moving a test file does not count as removal.

import posix from "node:path/posix";
import type { Policy } from "../../policy/schema.js";
import type {
  ChangeStatus,
  Inconclusive,
  Manifest,
  TriggerHit,
  Violation,
} from "../../types.js";
import { analyzeConfigChange } from "./config.js";
import { deriveState, type GateEvaluation } from "./evaluation.js";
import { matchesAnyGlob } from "./glob.js";
import type { NormalizedReport, ReportParse } from "./report.js";
import {
  FOCUS_SKIP_MARKERS,
  scanTestSource,
  type MarkerKind,
  type StaticScan,
  type StaticTestCase,
} from "./static.js";

export interface ChangedFile {
  status: ChangeStatus;
  pathB: string | null;
  pathC: string | null;
}

export interface TestsGateInput {
  manifest: Manifest;
  /**
   * Every changed path including non-code (snapshots, configs, package.json).
   * Defaults to the manifest entries, which may omit non-code files.
   */
  changedFiles?: ChangedFile[];
  /** B run, when the untrusted job ran the suite on the base too. Absent → static comparison only. */
  reportB?: ReportParse | null;
  reportC: ReportParse | null | undefined;
  /** Test sources of B and C, keyed by repository path (all test files of each tree, or at least the changed ones). */
  testSourcesB: Map<string, string>;
  testSourcesC: Map<string, string>;
  /** Sources of changed protected/config files and package.json on each side. */
  configSourcesB?: Map<string, string>;
  configSourcesC?: Map<string, string>;
  policy: Policy;
  /** Extra protected paths the caller already knows changed. */
  protectedPathsChanged?: string[];
  /** The PR comes from a registered AI-loop bot account (spec 2.4, 12.2). */
  isAiLoop: boolean;
}

const GATE = "tests" as const;
const MAX_LISTED = 50;

function changedFilesOf(input: TestsGateInput): ChangedFile[] {
  if (input.changedFiles) return input.changedFiles;
  return input.manifest.entries.map((e) => ({ status: e.status, pathB: e.b?.path ?? null, pathC: e.c?.path ?? null }));
}

/** B path → C path for files git reports as renamed. */
function renameMap(files: ChangedFile[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) if (f.status === "R" && f.pathB && f.pathC) m.set(f.pathB, f.pathC);
  return m;
}

function relocate(key: string, renames: Map<string, string>): string {
  const parts = JSON.parse(key) as string[];
  const to = renames.get(parts[0]!);
  if (!to) return key;
  parts[0] = to;
  return JSON.stringify(parts);
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return m;
}

function describeKey(key: string): { file: string; name: string } {
  const [file, ...rest] = JSON.parse(key) as string[];
  return { file: file!, name: rest.join(" › ") };
}

function scanAll(sources: Map<string, string>): Map<string, StaticScan> {
  const out = new Map<string, StaticScan>();
  for (const [path, src] of [...sources].sort(([a], [b]) => a.localeCompare(b))) out.set(path, scanTestSource(path, src));
  return out;
}

interface Collector {
  violations: Violation[];
  triggers: TriggerHit[];
  inconclusive: Inconclusive[];
}

function reportRun(c: Collector, report: NormalizedReport): void {
  if (report.numExecuted === 0) {
    c.inconclusive.push({
      reason: "NO_TESTS_EXECUTED",
      detail: `the test run executed 0 tests (${report.numTotal} listed); passWithNoTests is not accepted`,
      authorFixable: true,
    });
  }
  const failed = report.tests.filter((t) => t.status === "failed");
  for (const t of failed.slice(0, MAX_LISTED)) {
    c.violations.push({
      gate: GATE,
      reason: "TESTS_FAILED",
      file: t.file,
      message: `test failed: ${[...t.ancestors, t.title].join(" › ")}`,
      details: { test_id: t.id },
    });
  }
  if (failed.length > MAX_LISTED) {
    c.violations.push({
      gate: GATE,
      reason: "TESTS_FAILED",
      file: failed[MAX_LISTED]!.file,
      message: `${failed.length - MAX_LISTED} more failing tests not listed`,
    });
  }
  for (const s of report.suiteFailures) {
    c.violations.push({ gate: GATE, reason: "TESTS_FAILED", file: s.file, message: `test file failed to run: ${s.message}` });
  }
  if (failed.length === 0 && report.suiteFailures.length === 0 && !report.success) {
    c.violations.push({ gate: GATE, reason: "TESTS_FAILED", file: "", message: "the test run reported failure" });
  }
  if (report.snapshotsUpdated) {
    c.violations.push({
      gate: GATE,
      reason: "TEST_CONFIG_WEAKENED",
      file: "",
      message: "the CI test run rewrote snapshots (-u); its snapshot assertions prove nothing",
      details: { waivable: false },
    });
  }
}

/** Removed test IDs, from the B/C reports when both exist, else from the static scan of literal titles. */
function removedTests(
  reportB: NormalizedReport | null,
  reportC: NormalizedReport | null,
  scansB: Map<string, StaticScan>,
  scansC: Map<string, StaticScan>,
  renames: Map<string, string>,
): Array<{ key: string; source: "report" | "static" }> {
  const out: Array<{ key: string; source: "report" | "static" }> = [];
  const seen = new Set<string>();
  if (reportB && reportC) {
    const cCount = countBy(reportC.tests, (t) => t.id);
    for (const [id, n] of countBy(reportB.tests, (t) => relocate(t.id, renames))) {
      if ((cCount.get(id) ?? 0) < n) {
        out.push({ key: id, source: "report" });
        seen.add(id);
      }
    }
  }
  const cKeys = countBy(
    [...scansC.values()].flatMap((s) => s.cases.filter((t) => t.kind === "test")),
    (t) => t.key,
  );
  for (const scan of scansB.values()) {
    const bTests = scan.cases.filter((t) => t.kind === "test" && t.literalTitle && !t.parameterized);
    for (const [key, n] of countBy(bTests, (t) => relocate(t.key, renames))) {
      if ((cKeys.get(key) ?? 0) < n && !seen.has(key)) out.push({ key, source: "static" });
    }
  }
  return out;
}

function addedTestsByFile(scansB: Map<string, StaticScan>, scansC: Map<string, StaticScan>, renames: Map<string, string>) {
  const bKeys = new Set([...scansB.values()].flatMap((s) => s.cases.map((t) => relocate(t.key, renames))));
  const added = new Map<string, StaticTestCase[]>();
  for (const scan of scansC.values()) {
    for (const t of scan.cases) {
      if (t.kind === "test" && !bKeys.has(t.key)) added.set(t.file, [...(added.get(t.file) ?? []), t]);
    }
  }
  return added;
}

function caseIndex(scans: Map<string, StaticScan>, renames: Map<string, string>): Map<string, StaticTestCase> {
  const m = new Map<string, StaticTestCase>();
  for (const s of scans.values()) for (const t of s.cases) m.set(relocate(t.key, renames), t);
  return m;
}

function newMarkers(scansB: Map<string, StaticScan>, scansC: Map<string, StaticScan>, renames: Map<string, string>) {
  const bCount = countBy(
    [...scansB.values()].flatMap((s) => s.cases.flatMap((t) => t.markers.map((m) => `${relocate(t.key, renames)}\u0000${m}`))),
    (x) => x,
  );
  const out: Array<{ c: StaticTestCase; marker: MarkerKind }> = [];
  const used = new Map<string, number>();
  for (const s of scansC.values()) {
    for (const t of s.cases) {
      for (const m of t.markers) {
        if (!FOCUS_SKIP_MARKERS.has(m)) continue;
        const k = `${t.key}\u0000${m}`;
        const u = (used.get(k) ?? 0) + 1;
        used.set(k, u);
        if (u > (bCount.get(k) ?? 0)) out.push({ c: t, marker: m });
      }
    }
  }
  return out;
}

const SNAPSHOT_FILE = /(\.snap$|\/__snapshots__\/)/;

function weakeningSignals(
  scansB: Map<string, StaticScan>,
  scansC: Map<string, StaticScan>,
  renames: Map<string, string>,
  files: ChangedFile[],
): Array<{ file: string; unit?: string; kind: "assertions" | "matcher" | "snapshot"; evidence: string }> {
  const out: Array<{ file: string; unit?: string; kind: "assertions" | "matcher" | "snapshot"; evidence: string }> = [];
  const bIndex = caseIndex(scansB, renames);
  for (const s of scansC.values()) {
    for (const c of s.cases) {
      if (c.kind !== "test") continue;
      const b = bIndex.get(c.key);
      if (!b) continue;
      const name = describeKey(c.key).name;
      if (c.assertionCount < b.assertionCount) {
        out.push({ file: c.file, unit: name, kind: "assertions", evidence: `assertions ${b.assertionCount}→${c.assertionCount} in "${name}"` });
      }
      const strong = (t: StaticTestCase) => t.matchers.filter((m) => m.strength === "strong").length;
      if (strong(c) < strong(b) && c.assertionCount >= b.assertionCount) {
        const bw = b.matchers.filter((m) => m.strength !== "strong").map((m) => m.name);
        const cw = c.matchers.filter((m) => m.strength !== "strong").map((m) => (m.negated ? `not.${m.name}` : m.name));
        out.push({
          file: c.file,
          unit: name,
          kind: "matcher",
          evidence: `strong matchers ${strong(b)}→${strong(c)} in "${name}" (weak/other now: ${cw.join(", ") || "-"}; before: ${bw.join(", ") || "-"})`,
        });
      }
      if (c.inlineSnapshots.join("\u0000") !== b.inlineSnapshots.join("\u0000") && b.inlineSnapshots.length > 0) {
        out.push({ file: c.file, unit: name, kind: "snapshot", evidence: `inline snapshot changed in "${name}"` });
      }
    }
  }
  for (const f of files) {
    const p = f.pathC ?? f.pathB ?? "";
    if (!SNAPSHOT_FILE.test(p) || f.status === "A") continue;
    out.push({ file: p, kind: "snapshot", evidence: `snapshot file ${f.status === "D" ? "deleted" : "updated"}: ${p}` });
  }
  return out;
}

function protectedChanges(files: ChangedFile[], policy: Policy, extra: string[]): string[] {
  const set = new Set(extra);
  for (const f of files) {
    for (const p of [f.pathB, f.pathC]) if (p && matchesAnyGlob(p, policy.tests.protected_paths)) set.add(p);
  }
  return [...set].sort();
}

function isTestPath(p: string, sources: Map<string, string>, policy: Policy): boolean {
  return sources.has(p) || matchesAnyGlob(p, policy.scope.test_globs);
}

function changedTestFiles(files: ChangedFile[], input: TestsGateInput) {
  const pathsB = new Set<string>();
  const pathsC = new Set<string>();
  const missing: string[] = [];
  for (const f of files) {
    const test =
      (f.pathB !== null && isTestPath(f.pathB, input.testSourcesB, input.policy)) ||
      (f.pathC !== null && isTestPath(f.pathC, input.testSourcesC, input.policy));
    if (!test || !/\.(m|c)?(j|t)sx?$/.test(f.pathC ?? f.pathB ?? "")) continue;
    if (f.pathB && f.status !== "A" && f.status !== "C") {
      if (input.testSourcesB.has(f.pathB)) pathsB.add(f.pathB);
      else missing.push(f.pathB);
    }
    if (f.pathC && f.status !== "D") {
      if (input.testSourcesC.has(f.pathC)) pathsC.add(f.pathC);
      else missing.push(f.pathC);
    }
  }
  return { pathsB, pathsC, missing };
}

function pick(sources: Map<string, string>, paths: Set<string>): Map<string, string> {
  return new Map([...sources].filter(([p]) => paths.has(p)));
}

function isConfigPath(p: string, policy: Policy): boolean {
  return posix.basename(p) === "package.json" || matchesAnyGlob(p, policy.tests.protected_paths);
}

export function evaluateTests(input: TestsGateInput): GateEvaluation {
  const c: Collector = { violations: [], triggers: [], inconclusive: [] };
  const files = changedFilesOf(input);
  const renames = renameMap(files);

  let reportC: NormalizedReport | null = null;
  if (!input.reportC) {
    c.inconclusive.push({ reason: "REPORT_MISSING", detail: "candidate test report is missing", authorFixable: false });
  } else if (!input.reportC.ok) {
    c.inconclusive.push(input.reportC.inconclusive);
  } else {
    reportC = input.reportC.report;
    reportRun(c, reportC);
  }
  const reportB = input.reportB?.ok ? input.reportB.report : null;

  // Only changed test files can differ; restricting the scan also keeps a
  // caller that passes every B test file from making unchanged files look new.
  const { pathsB, pathsC, missing } = changedTestFiles(files, input);
  for (const m of missing) {
    c.inconclusive.push({ reason: "REPORT_MISSING", file: m, detail: `test source not provided for changed file ${m}`, authorFixable: false });
  }
  const scansB = scanAll(pick(input.testSourcesB, pathsB));
  const scansC = scanAll(pick(input.testSourcesC, pathsC));

  // Removed tests: gate-owners approval, never a waiver.
  const added = addedTestsByFile(scansB, scansC, renames);
  for (const r of removedTests(reportB, reportC, scansB, scansC, renames)) {
    const { file, name } = describeKey(r.key);
    const candidates = (added.get(renames.get(file) ?? file) ?? []).map((t) => describeKey(t.key).name);
    c.violations.push({
      gate: GATE,
      reason: "TEST_REMOVED",
      file,
      unit: name,
      message: `test removed: ${name}`,
      details: { test_id: r.key, source: r.source, waivable: false, approval: "gate-owners", rename_candidates: candidates.slice(0, 10) },
    });
  }

  // Newly added focus/skip markers, statically and at runtime.
  for (const { c: t, marker } of newMarkers(scansB, scansC, renames)) {
    c.violations.push({
      gate: GATE,
      reason: "TEST_FOCUS_OR_SKIP",
      file: t.file,
      line: t.line,
      unit: describeKey(t.key).name,
      message: `new ${marker === "x" || marker === "f" ? `${marker}-prefixed` : `.${marker}`} on ${t.kind} "${t.title}"`,
      details: { marker, waivable: false },
    });
  }
  const bIndex = caseIndex(scansB, renames);
  for (const s of scansC.values()) {
    for (const t of s.cases) {
      const before = bIndex.get(t.key);
      if (t.runtimeSkips > (before?.runtimeSkips ?? 0)) {
        c.violations.push({
          gate: GATE,
          reason: "TEST_FOCUS_OR_SKIP",
          file: t.file,
          line: t.line,
          unit: describeKey(t.key).name,
          message: `new runtime skip() inside "${t.title}"`,
          details: { marker: "runtime-skip", waivable: false },
        });
      }
    }
  }
  if (reportB && reportC) {
    const ranInB = new Set(reportB.tests.filter((t) => t.status === "passed" || t.status === "failed").map((t) => relocate(t.id, renames)));
    for (const t of reportC.tests) {
      if ((t.status === "skipped" || t.status === "pending" || t.status === "todo") && ranInB.has(t.id)) {
        c.violations.push({
          gate: GATE,
          reason: "TEST_FOCUS_OR_SKIP",
          file: t.file,
          unit: [...t.ancestors, t.title].join(" › "),
          message: `test ran on the base but was ${t.status} on the candidate`,
          details: { marker: "report", waivable: false },
        });
      }
    }
  }

  // New tests without assertions.
  for (const list of added.values()) {
    for (const t of list) {
      if (t.markers.includes("todo") || t.assertionCount > 0 || t.hasAssertionDeclaration) continue;
      c.violations.push({
        gate: GATE,
        reason: "TEST_NO_ASSERTION",
        file: t.file,
        line: t.line,
        unit: describeKey(t.key).name,
        message: `new test "${t.title}" makes no assertion`,
      });
    }
  }

  // Configuration weakening (independent approval, not a waiver).
  const cfgB = input.configSourcesB ?? new Map<string, string>();
  const cfgC = input.configSourcesC ?? new Map<string, string>();
  for (const f of files) {
    const p = f.pathC ?? f.pathB;
    if (!p || !isConfigPath(p, input.policy)) continue;
    const before = f.pathB ? (cfgB.get(f.pathB) ?? null) : null;
    const after = f.pathC ? (cfgC.get(f.pathC) ?? null) : null;
    if ((f.pathB && before === null) || (f.pathC && after === null)) {
      c.inconclusive.push({ reason: "REPORT_MISSING", file: p, detail: `config source not provided for ${p}`, authorFixable: false });
      continue;
    }
    for (const w of analyzeConfigChange(p, before, after)) {
      c.violations.push({
        gate: GATE,
        reason: "TEST_CONFIG_WEAKENED",
        file: w.path,
        message: `${w.setting}: ${w.why}`,
        details: { setting: w.setting, before: w.before, after: w.after, waivable: false, approval: "policy-change" },
      });
    }
  }

  // Protected paths: a mechanical FAIL only for the AI loop; for people it is CODEOWNERS (spec 2.4).
  const protectedPaths = protectedChanges(files, input.policy, input.protectedPathsChanged ?? []);
  if (input.isAiLoop) {
    for (const p of protectedPaths) {
      c.violations.push({
        gate: GATE,
        reason: "PROTECTED_PATH_MODIFIED",
        file: p,
        message: `AI fix loop modified protected path ${p}`,
        details: { waivable: false },
      });
    }
  }

  // Weakened assertions: S7 review for people, FAIL for the AI loop.
  for (const w of weakeningSignals(scansB, scansC, renames, files)) {
    if (input.isAiLoop) {
      c.violations.push({
        gate: GATE,
        reason: "TEST_CONFIG_WEAKENED",
        file: w.file,
        unit: w.unit,
        message: `AI fix loop weakened tests: ${w.evidence}`,
        details: { weakening: w.kind, waivable: false },
      });
    } else {
      c.triggers.push({ id: "S7", gate: GATE, file: w.file, unit: w.unit, evidence: w.evidence, routing: true });
    }
  }

  const parseProblems = [...scansC.values()].filter((s) => s.syntaxErrors > 0).map((s) => s.file);
  const observe: Record<string, unknown> = {
    report_format: reportC?.format ?? null,
    tests_total: reportC?.numTotal ?? null,
    tests_executed: reportC?.numExecuted ?? null,
    tests_failed: reportC?.numFailed ?? null,
    base_report: input.reportB === undefined || input.reportB === null ? "absent" : input.reportB.ok ? "present" : "invalid",
    protected_paths_changed: protectedPaths,
    test_files_with_syntax_errors: parseProblems,
  };
  const state = deriveState(c.violations, c.inconclusive);
  const summary =
    state === "PASS"
      ? `tests: ${reportC?.numExecuted ?? 0} executed, integrity checks passed`
      : `tests: ${c.violations.length} violation(s), ${c.inconclusive.length} inconclusive`;
  return { state, ...c, observe, summary };
}
