// G5 `gate/coverage` (spec 8.4): unexecuted changed branch outcomes, counted
// in absolute terms with a ratio floor, plus changed exported functions that
// no test called. Observe-only in v1; the aggregator decides by policy mode.

import ts from "typescript";
import type { Policy } from "../../policy/schema.js";
import type { FileLineMap, Inconclusive, Manifest, ManifestEntry, Violation } from "../../types.js";
import { deriveState, type GateEvaluation } from "../tests/evaluation.js";
import { matchesAnyGlob } from "../tests/glob.js";
import { findIgnoreComments } from "../tests/static.js";
import { allLines, changedLinesFromHunks, lineCountOf, lineMapsByC, overlaps } from "./changed.js";
import { exportedFunctions } from "./exports.js";
import { parseCoverageMeta, parseIstanbul, type FileCoverage } from "./istanbul.js";

export interface CoverageGateInput {
  manifest: Manifest;
  lineMaps: readonly FileLineMap[];
  /** `coverage-final.json` text from the untrusted job. */
  coverage: string | null | undefined;
  /** `coverage-meta.json`: `{ provider, provider_version, vitest_version }`, written next to it. */
  meta: string | null | undefined;
  /** Optional second run of the same commit; a different outcome is NONDETERMINISM. */
  retryCoverage?: string | null;
  /** C sources of the changed code files. */
  sourcesC: Map<string, string>;
  policy: Policy;
  /** Absolute checkout root on the runner, if recorded in the metadata. */
  rootDir?: string;
}

export interface FileCoverageResult {
  path: string;
  changedLines: number;
  changedBranchOutcomes: number;
  unexecutedBranchOutcomes: Array<{ line: number; type: string; index: number }>;
  unexecutedLines: number[];
  addedIgnoreComments: Array<{ line: number; directive: string }>;
  unexecutedExports: Array<{ name: string; line: number }>;
  missingFromReport: boolean;
}

const GATE = "coverage" as const;

function isTarget(e: ManifestEntry, policy: Policy): e is ManifestEntry & { c: NonNullable<ManifestEntry["c"]> } {
  if (!e.c || e.status === "D" || e.isTest || e.excluded || e.unmeasured) return false;
  return !matchesAnyGlob(e.c.path, policy.scope.test_globs);
}

/** Type-only modules emit no JavaScript, so providers legitimately omit them. */
export function hasRuntimeCode(path: string, source: string): boolean {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  return sf.statements.some((s) => {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) return false;
    if (ts.isImportDeclaration(s) && s.importClause?.isTypeOnly) return false;
    if (ts.isExportDeclaration(s) && s.isTypeOnly) return false;
    if (ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
    return true;
  });
}

function analyzeFile(
  path: string,
  source: string,
  changed: Set<number>,
  fc: FileCoverage | undefined,
  allow: readonly string[],
): FileCoverageResult {
  const addedIgnoreComments = findIgnoreComments(source)
    .filter((c) => changed.has(c.line) && !allow.includes(c.directive))
    .map((c) => ({ line: c.line, directive: c.directive }));
  const result: FileCoverageResult = {
    path,
    changedLines: changed.size,
    changedBranchOutcomes: 0,
    unexecutedBranchOutcomes: [],
    unexecutedLines: [],
    addedIgnoreComments,
    unexecutedExports: [],
    missingFromReport: !fc,
  };
  if (!fc) return result;
  for (const b of fc.branches) {
    if (!overlaps(b.range, changed)) continue;
    result.changedBranchOutcomes++;
    if (b.count === 0) result.unexecutedBranchOutcomes.push({ line: b.range.start, type: b.type, index: b.index });
  }
  const unexecuted = new Set<number>();
  for (const s of fc.statements) {
    if (s.count !== 0 || !overlaps(s.range, changed)) continue;
    for (let l = s.range.start; l <= s.range.end; l++) if (changed.has(l)) unexecuted.add(l);
  }
  result.unexecutedLines = [...unexecuted].sort((a, b) => a - b);
  for (const ex of exportedFunctions(path, source)) {
    if (!overlaps({ start: ex.startLine, end: ex.endLine }, changed)) continue;
    const fn = fc.functions.find(
      (f) => (f.declLine >= ex.startLine && f.declLine <= ex.bodyLine) || (f.range.start >= ex.startLine && f.range.start <= ex.bodyLine),
    );
    if (fn && fn.count === 0) result.unexecutedExports.push({ name: ex.name, line: ex.startLine });
  }
  return result;
}

interface Analysis {
  files: FileCoverageResult[];
  inconclusive: Inconclusive[];
  unmapped: string[];
}

function analyze(input: CoverageGateInput, coverageText: string | null | undefined): Analysis {
  const inconclusive: Inconclusive[] = [];
  const maps = lineMapsByC(input.lineMaps);
  const targets: Array<{ path: string; source: string; changed: Set<number> }> = [];
  for (const e of input.manifest.entries) {
    if (!isTarget(e, input.policy)) continue;
    const path = e.c.path;
    const source = input.sourcesC.get(path);
    if (source === undefined) {
      inconclusive.push({ reason: "REPORT_MISSING", file: path, detail: `C source not provided for ${path}`, authorFixable: false });
      continue;
    }
    let changed: Set<number>;
    if (e.status === "A" || e.status === "C") changed = allLines(lineCountOf(source));
    else {
      const m = maps.get(path);
      if (m) changed = changedLinesFromHunks(m.hunks);
      else if (e.status === "R" && e.similarity === 100) changed = new Set();
      else {
        inconclusive.push({ reason: "REPORT_MISSING", file: path, detail: `no line map for changed file ${path}`, authorFixable: false });
        continue;
      }
    }
    if (changed.size > 0 && hasRuntimeCode(path, source)) targets.push({ path, source, changed });
  }
  if (targets.length === 0) return { files: [], inconclusive, unmapped: [] };

  const parsed = parseIstanbul(coverageText, {
    rootDir: input.rootDir,
    knownFiles: input.manifest.entries.flatMap((e) => (e.c ? [e.c.path] : [])),
  });
  if (!parsed.ok) return { files: [], inconclusive: [...inconclusive, parsed.inconclusive], unmapped: [] };
  const allow = input.policy.coverage.ignore_comment_allowlist;
  const files = targets.map((t) => analyzeFile(t.path, t.source, t.changed, parsed.files.get(t.path), allow));
  for (const f of files) {
    if (f.missingFromReport && f.addedIgnoreComments.length === 0) {
      inconclusive.push({
        reason: "REPORT_MISSING",
        file: f.path,
        detail: `changed file ${f.path} is absent from the coverage report; coverage.include must list every changed file`,
        authorFixable: false,
      });
    }
  }
  return { files, inconclusive, unmapped: parsed.unmapped };
}

function fingerprintProblems(input: CoverageGateInput): Inconclusive[] {
  const meta = parseCoverageMeta(input.meta);
  if (!meta) return [{ reason: "REPORT_MISSING", detail: "coverage-meta.json is missing or invalid", authorFixable: false }];
  const out: Inconclusive[] = [];
  if (meta.provider !== input.policy.coverage.provider) {
    out.push({
      reason: "FINGERPRINT_MISMATCH",
      detail: `coverage provider ${meta.provider} differs from the pinned ${input.policy.coverage.provider}`,
      authorFixable: false,
    });
  }
  const pinned = input.policy.coverage.provider_version;
  if (pinned && meta.provider_version !== pinned) {
    out.push({
      reason: "FINGERPRINT_MISMATCH",
      detail: `coverage provider version ${meta.provider_version || "(none)"} differs from the pinned ${pinned}`,
      authorFixable: false,
    });
  }
  return out;
}

function outcomeSignature(files: FileCoverageResult[]): string {
  return JSON.stringify(files.map((f) => [f.path, f.unexecutedBranchOutcomes, f.unexecutedLines, f.unexecutedExports, f.missingFromReport]));
}

export function evaluateCoverage(input: CoverageGateInput): GateEvaluation {
  const a = analyze(input, input.coverage);
  const inconclusive = [...a.inconclusive];
  const executable = a.files.filter(
    (f) => f.missingFromReport || f.changedBranchOutcomes > 0 || f.unexecutedLines.length > 0 || f.addedIgnoreComments.length > 0 || f.unexecutedExports.length > 0,
  );
  if (a.files.length > 0) inconclusive.push(...fingerprintProblems(input));
  if (input.retryCoverage !== undefined && a.files.length > 0) {
    const retry = analyze(input, input.retryCoverage);
    if (retry.inconclusive.length === 0 && outcomeSignature(retry.files) !== outcomeSignature(a.files)) {
      inconclusive.push({ reason: "NONDETERMINISM", detail: "coverage differs between the run and its retry", authorFixable: false });
    }
  }

  // Each added, non-allowlisted ignore hint stands in for one unexecuted outcome:
  // we cannot see what it hid, only that it hid something.
  const total = a.files.reduce((s, f) => s + f.changedBranchOutcomes + f.addedIgnoreComments.length, 0);
  const unexecuted = a.files.reduce((s, f) => s + f.unexecutedBranchOutcomes.length + f.addedIgnoreComments.length, 0);
  const { max_unexecuted_branches_abs: abs, max_unexecuted_branches_ratio: ratio } = input.policy.coverage;
  const allowed = Math.max(abs, ratio * total);
  const violations: Violation[] = [];
  if (unexecuted > allowed) {
    for (const f of a.files) {
      const n = f.unexecutedBranchOutcomes.length + f.addedIgnoreComments.length;
      if (n === 0) continue;
      violations.push({
        gate: GATE,
        reason: "COVERAGE_UNEXECUTED",
        file: f.path,
        line: f.unexecutedBranchOutcomes[0]?.line ?? f.addedIgnoreComments[0]?.line,
        metric: "unexecuted_changed_branch_outcomes",
        after: n,
        limit: allowed,
        message: `${n} changed branch outcome(s) never executed in ${f.path} (PR total ${unexecuted}, allowed ${allowed})`,
        details: { outcomes: f.unexecutedBranchOutcomes, ignore_comments: f.addedIgnoreComments },
      });
    }
  }
  for (const f of a.files) {
    for (const ex of f.unexecutedExports) {
      violations.push({
        gate: GATE,
        reason: "COVERAGE_UNEXECUTED",
        file: f.path,
        line: ex.line,
        unit: ex.name,
        metric: "exported_function_calls",
        after: 0,
        limit: 1,
        message: `changed exported function ${ex.name} was never called by a test`,
      });
    }
  }

  const notApplicable = executable.length === 0 && inconclusive.length === 0;
  const state = deriveState(violations, inconclusive, notApplicable);
  const observe: Record<string, unknown> = {
    changed_files: a.files.length,
    changed_branch_outcomes: total,
    unexecuted_changed_branch_outcomes: unexecuted,
    allowed_unexecuted: allowed,
    unexecuted_changed_lines: a.files.reduce((s, f) => s + f.unexecutedLines.length, 0),
    files_missing_from_report: a.files.filter((f) => f.missingFromReport).map((f) => f.path),
    unmapped_report_paths: a.unmapped.slice(0, 20),
    files: a.files,
  };
  const summary =
    state === "NOT_APPLICABLE"
      ? "coverage: N/A (no executable changed lines)"
      : `coverage: ${unexecuted}/${total} changed branch outcomes unexecuted (allowed ${allowed})`;
  return { state, violations, inconclusive, triggers: [], observe, summary };
}
