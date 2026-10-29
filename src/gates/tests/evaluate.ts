// G4 `gate/tests` (spec 8.3): the test run passed, at least one test ran, and
// neither the tests nor their configuration got weaker between B and C.
//
// Test renames (ruling D3): a changed `describe`/`it` title changes the test
// ID. It counts as a rename only when, in the same file (following git
// renames), one removed and one added test pair up uniquely, the B test
// passed, and their callbacks print identically without comments. Anything
// else is TEST_REMOVED, approved by a gate owner (never a waiver).

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
import { matchesAny } from "../../util/glob.js";
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
/** B test path → C test path for git renames that stay inside the test set. */
function renameMap(files: ChangedFile[], input: TestsGateInput): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) {
    if (f.status === "R" && f.pathB && isTestPath(f.pathC, input.policy)) m.set(f.pathB, f.pathC);
  }
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

const NON_WAIVABLE = { waivable: false, approvalKind: "gate-owners" } as const;

/** Waiver-addressable unit key for a test: `path::ancestors › title` (the display name goes in details.name). */
function testUnit(file: string, name: string): string {
  return `${file}::${name}`;
}

function failedOnBase(reportB: NormalizedReport | null, renames: Map<string, string>) {
  const ids = new Set((reportB?.tests ?? []).filter((t) => t.status === "failed").map((t) => relocate(t.id, renames)));
  const files = new Set((reportB?.suiteFailures ?? []).map((f) => renames.get(f.file) ?? f.file));
  return { ids, files };
}

function pushFailures(c: Collector, list: Violation[]): void {
  c.violations.push(...list.slice(0, MAX_LISTED));
  if (list.length > MAX_LISTED) {
    const { unit: _unit, ...rest } = list[MAX_LISTED]!;
    c.violations.push({ ...rest, message: `${list.length - MAX_LISTED} more failing tests not listed` });
  }
}

function reportRun(c: Collector, report: NormalizedReport, reportB: NormalizedReport | null, renames: Map<string, string>): void {
  if (report.numExecuted === 0) {
    c.inconclusive.push({
      reason: "NO_TESTS_EXECUTED",
      detail: `the test run executed 0 tests (${report.numTotal} listed); passWithNoTests is not accepted`,
      authorFixable: true,
    });
  }
  // A test that already fails on the base is not this PR's breakage (ruling D14): waivable.
  const base = failedOnBase(reportB, renames);
  const own: Violation[] = [];
  const inherited: Violation[] = [];
  for (const t of report.tests.filter((x) => x.status === "failed")) {
    const name = [...t.ancestors, t.title].join(" › ");
    if (base.ids.has(t.id)) {
      inherited.push({
        gate: GATE,
        reason: "TESTS_FAILED_ON_BASE",
        file: t.file,
        unit: testUnit(t.file, name),
        message: `test failed (also failing on the base): ${name}`,
        details: { test_id: t.id, name, base_broken: true, waivable: true },
      });
    } else {
      own.push({ gate: GATE, reason: "TESTS_FAILED", file: t.file, unit: testUnit(t.file, name), message: `test failed: ${name}`, details: { test_id: t.id, name, waivable: false } });
    }
  }
  for (const s of report.suiteFailures) {
    if (base.files.has(s.file)) {
      inherited.push({
        gate: GATE,
        reason: "TESTS_FAILED_ON_BASE",
        file: s.file,
        message: `test file failed to run (also on the base): ${s.message}`,
        details: { base_broken: true, waivable: true },
      });
    } else {
      own.push({ gate: GATE, reason: "TESTS_FAILED", file: s.file, message: `test file failed to run: ${s.message}`, details: { waivable: false } });
    }
  }
  pushFailures(c, own);
  pushFailures(c, inherited);
  if (own.length === 0 && inherited.length === 0 && !report.success) {
    c.violations.push({ gate: GATE, reason: "TESTS_FAILED", file: "", message: "the test run reported failure", details: { waivable: false } });
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

interface Rename {
  from: string;
  to: string;
}

/** Ruling D3: unique 1:1 pairs of removed and added tests whose callbacks print identically. */
function pairRenames(
  removed: Array<{ key: string }>,
  added: Map<string, StaticTestCase[]>,
  bIndex: Map<string, StaticTestCase>,
  reportB: NormalizedReport | null,
  renames: Map<string, string>,
): Rename[] {
  if (!reportB) return []; // "the B test passed" cannot be shown without the base run
  const passedInB = new Set(reportB.tests.filter((t) => t.status === "passed").map((t) => relocate(t.id, renames)));
  const groups = new Map<string, { from: string[]; to: string[] }>();
  const group = (file: string, body: string) => {
    const k = JSON.stringify([file, body]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { from: [], to: [] }));
    return g;
  };
  for (const r of removed) {
    const b = bIndex.get(r.key);
    if (b?.bodyText == null || !passedInB.has(r.key)) continue;
    group(describeKey(r.key).file, b.bodyText).from.push(r.key);
  }
  for (const [file, list] of added) {
    for (const t of list) if (t.bodyText !== null) group(file, t.bodyText).to.push(t.key);
  }
  const out: Rename[] = [];
  for (const g of groups.values()) if (g.from.length === 1 && g.to.length === 1) out.push({ from: g.from[0]!, to: g.to[0]! });
  return out;
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
        out.push({ file: c.file, unit: testUnit(c.file, name), kind: "assertions", evidence: `assertions ${b.assertionCount}→${c.assertionCount} in "${name}"` });
      }
      const strong = (t: StaticTestCase) => t.matchers.filter((m) => m.strength === "strong").length;
      if (strong(c) < strong(b) && c.assertionCount >= b.assertionCount) {
        const bw = b.matchers.filter((m) => m.strength !== "strong").map((m) => m.name);
        const cw = c.matchers.filter((m) => m.strength !== "strong").map((m) => (m.negated ? `not.${m.name}` : m.name));
        out.push({
          file: c.file,
          unit: testUnit(c.file, name),
          kind: "matcher",
          evidence: `strong matchers ${strong(b)}→${strong(c)} in "${name}" (weak/other now: ${cw.join(", ") || "-"}; before: ${bw.join(", ") || "-"})`,
        });
      }
      if (c.inlineSnapshots.join("\u0000") !== b.inlineSnapshots.join("\u0000") && b.inlineSnapshots.length > 0) {
        out.push({ file: c.file, unit: testUnit(c.file, name), kind: "snapshot", evidence: `inline snapshot changed in "${name}"` });
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
    for (const p of [f.pathB, f.pathC]) if (p && matchesAny(p, policy.tests.protected_paths)) set.add(p);
  }
  return [...set].sort();
}

/**
 * Per side, by the policy globs only. The manifest's entry-level `isTest` is
 * derived from one path of the same entry, so for a rename across the test
 * boundary it would mark both sides and hide the removal.
 */
function isTestPath(p: string | null, policy: Policy): p is string {
  return p !== null && matchesAny(p, policy.scope.test_globs);
}

/**
 * An entry is a test change when EITHER side is a test path. A file renamed
 * out of the test globs is scanned on the B side only: its tests left the
 * suite, which is a removal, not a missing source.
 */
function changedTestFiles(files: ChangedFile[], input: TestsGateInput) {
  const pathsB = new Set<string>();
  const pathsC = new Set<string>();
  const missing: string[] = [];
  for (const f of files) {
    if (!/\.(m|c)?(j|t)sx?$/.test(f.pathC ?? f.pathB ?? "")) continue;
    if (f.status !== "A" && f.status !== "C" && isTestPath(f.pathB, input.policy)) {
      if (input.testSourcesB.has(f.pathB)) pathsB.add(f.pathB);
      else missing.push(f.pathB);
    }
    if (f.status !== "D" && isTestPath(f.pathC, input.policy)) {
      if (input.testSourcesC.has(f.pathC)) pathsC.add(f.pathC);
      else missing.push(f.pathC);
    }
  }
  return { pathsB, pathsC, missing };
}

function pick(sources: Map<string, string>, paths: Set<string>): Map<string, string> {
  return new Map([...sources].filter(([p]) => paths.has(p)));
}

function isConfigPath(p: string | null, policy: Policy): p is string {
  return p !== null && (posix.basename(p) === "package.json" || matchesAny(p, policy.tests.protected_paths));
}

export function evaluateTests(input: TestsGateInput): GateEvaluation {
  const c: Collector = { violations: [], triggers: [], inconclusive: [] };
  const files = changedFilesOf(input);
  const renames = renameMap(files, input);

  let reportC: NormalizedReport | null = null;
  if (!input.reportC) {
    c.inconclusive.push({ reason: "REPORT_MISSING", detail: "candidate test report is missing", authorFixable: false });
  } else if (!input.reportC.ok) {
    c.inconclusive.push(input.reportC.inconclusive);
  } else {
    reportC = input.reportC.report;
  }
  const reportB = input.reportB?.ok ? input.reportB.report : null;
  if (reportC) reportRun(c, reportC, reportB, renames);

  // Only changed test files can differ; restricting the scan also keeps a
  // caller that passes every B test file from making unchanged files look new.
  const { pathsB, pathsC, missing } = changedTestFiles(files, input);
  for (const m of missing) {
    c.inconclusive.push({ reason: "REPORT_MISSING", file: m, detail: `test source not provided for changed file ${m}`, authorFixable: false });
  }
  const scansB = scanAll(pick(input.testSourcesB, pathsB));
  const scansC = scanAll(pick(input.testSourcesC, pathsC));

  // Removed tests: gate-owners approval, never a waiver. Proven renames are observe for people.
  const added = addedTestsByFile(scansB, scansC, renames);
  const bIndex = caseIndex(scansB, renames);
  const removed = removedTests(reportB, reportC, scansB, scansC, renames);
  const renamed = pairRenames(removed, added, bIndex, reportB, renames);
  const renamedFrom = new Map(renamed.map((r) => [r.from, r.to]));
  const renamedTo = new Set(renamed.map((r) => r.to));
  for (const r of removed) {
    const { file, name } = describeKey(r.key);
    const to = renamedFrom.get(r.key);
    if (to && !input.isAiLoop) continue;
    const candidates = (added.get(file) ?? []).map((t) => describeKey(t.key).name);
    c.violations.push({
      gate: GATE,
      reason: "TEST_REMOVED",
      file,
      unit: testUnit(file, name),
      message: to ? `AI fix loop renamed test ${name} → ${describeKey(to).name}` : `test removed: ${name}`,
      details: { test_id: r.key, name, source: r.source, ...NON_WAIVABLE, rename: Boolean(to), rename_candidates: candidates.slice(0, 10) },
    });
  }

  // Newly added markers (ruling D2): a new todo is observe for people and a new
  // skipIf/runIf is S7; todo/skip on an existing test and every other marker FAIL.
  const newTodos: string[] = [];
  for (const { c: t, marker } of newMarkers(scansB, scansC, renames)) {
    const name = describeKey(t.key).name;
    const unit = testUnit(t.file, name);
    const label = marker === "x" || marker === "f" ? `${marker}-prefixed` : `.${marker}`;
    const existed = bIndex.has(t.key);
    if (!input.isAiLoop && marker === "todo" && !existed) {
      newTodos.push(name);
      continue;
    }
    if (!input.isAiLoop && (marker === "skipIf" || marker === "runIf")) {
      c.triggers.push({ id: "S7", gate: GATE, file: t.file, unit, evidence: `new conditional skip ${label} on "${t.title}"`, routing: true });
      continue;
    }
    c.violations.push({
      gate: GATE,
      reason: "TEST_FOCUS_OR_SKIP",
      file: t.file,
      line: t.line,
      unit,
      message: `new ${label} on ${existed ? "existing " : ""}${t.kind} "${t.title}"`,
      details: { marker, name, waivable: false },
    });
  }
  for (const s of scansC.values()) {
    for (const t of s.cases) {
      const before = bIndex.get(t.key);
      if (t.runtimeSkips > (before?.runtimeSkips ?? 0)) {
        c.violations.push({
          gate: GATE,
          reason: "TEST_FOCUS_OR_SKIP",
          file: t.file,
          line: t.line,
          unit: testUnit(t.file, describeKey(t.key).name),
          message: `new runtime skip() inside "${t.title}"`,
          details: { marker: "runtime-skip", name: describeKey(t.key).name, waivable: false },
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
          unit: testUnit(t.file, [...t.ancestors, t.title].join(" › ")),
          message: `test ran on the base but was ${t.status} on the candidate`,
          details: { marker: "report", name: [...t.ancestors, t.title].join(" › "), waivable: false },
        });
      }
    }
  }

  // New tests without assertions: S7 for people, FAIL for the AI loop (ruling D14).
  for (const list of added.values()) {
    for (const t of list) {
      if (renamedTo.has(t.key) || t.markers.includes("todo") || t.assertionCount > 0 || t.hasAssertionDeclaration) continue;
      const name = describeKey(t.key).name;
      const unit = testUnit(t.file, name);
      if (input.isAiLoop) {
        c.violations.push({ gate: GATE, reason: "TEST_NO_ASSERTION", file: t.file, line: t.line, unit, message: `new test "${t.title}" makes no assertion`, details: { name } });
      } else {
        c.triggers.push({ id: "S7", gate: GATE, file: t.file, unit, evidence: `new test "${t.title}" makes no assertion`, routing: true });
      }
    }
  }

  // Configuration (ruling D1): a concrete weakening FAILs (gate-owners approval, never a
  // waiver); a setup/retry/alias change is S7 evidence; any other protected change is S11.
  // A move out of the protected set counts as deleting the protected file, and vice versa.
  const cfgB = input.configSourcesB ?? new Map<string, string>();
  const cfgC = input.configSourcesC ?? new Map<string, string>();
  const weakened = new Set<string>();
  for (const f of files) {
    const pb = f.status === "A" || f.status === "C" ? null : f.pathB;
    const pc = f.status === "D" ? null : f.pathC;
    const bCfg = isConfigPath(pb, input.policy);
    const cCfg = isConfigPath(pc, input.policy);
    if (!bCfg && !cCfg) continue;
    const p = cCfg ? pc! : pb!;
    const before = bCfg ? (cfgB.get(pb!) ?? null) : null;
    const after = cCfg ? (cfgC.get(pc!) ?? null) : null;
    if ((bCfg && before === null) || (cCfg && after === null)) {
      c.inconclusive.push({ reason: "REPORT_MISSING", file: p, detail: `config source not provided for ${p}`, authorFixable: false });
      continue;
    }
    for (const w of analyzeConfigChange(p, before, after)) {
      const review = w.kind === "review";
      if (review && !input.isAiLoop) {
        c.triggers.push({ id: "S7", gate: GATE, file: w.path, evidence: `${w.setting}: ${w.why}`, routing: true });
        continue;
      }
      if (!review) for (const q of [pb, pc]) if (q) weakened.add(q);
      c.violations.push({
        gate: GATE,
        reason: "TEST_CONFIG_WEAKENED",
        file: w.path,
        message: `${w.setting}: ${w.why}`,
        details: { setting: w.setting, before: w.before, after: w.after, ...NON_WAIVABLE, ...(review ? { weakening: "config-review" } : {}) },
      });
    }
  }

  // Protected paths: FAIL for the AI loop (12.2); for people S11, cleared by an independent
  // G6 approval at head SHA — the gate never assumes CODEOWNERS is configured.
  const protectedPaths = protectedChanges(files, input.policy, input.protectedPathsChanged ?? []);
  for (const p of protectedPaths) {
    if (input.isAiLoop) {
      c.violations.push({ gate: GATE, reason: "PROTECTED_PATH_MODIFIED", file: p, message: `AI fix loop modified protected path ${p}`, details: { waivable: false } });
    } else if (!weakened.has(p)) {
      c.triggers.push({ id: "S11", gate: GATE, file: p, evidence: `protected config changed: ${p}`, routing: true });
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
    // A broken B artifact silently disables the removal, rename and base-broken checks: keep it visible.
    ...(input.reportB && !input.reportB.ok
      ? { base_report_invalid: { reason: input.reportB.inconclusive.reason, detail: input.reportB.inconclusive.detail } }
      : {}),
    protected_paths_changed: protectedPaths,
    renamed_tests: renamed.map((r) => ({ from: describeKey(r.from).name, to: describeKey(r.to).name, file: describeKey(r.to).file })),
    new_todos: newTodos,
    test_files_with_syntax_errors: parseProblems,
  };
  const state = deriveState(c.violations, c.inconclusive);
  const summary =
    state === "PASS"
      ? `tests: ${reportC?.numExecuted ?? 0} executed, integrity checks passed`
      : `tests: ${c.violations.length} violation(s), ${c.inconclusive.length} inconclusive`;
  return { state, ...c, observe, summary };
}
