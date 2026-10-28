// Normalizes test-run reports from the untrusted Actions job (spec 8.3).
// Supported: the Jest-compatible JSON that `vitest --reporter=json` (4.x) and
// `jest --json` both emit, and JUnit XML as written by vitest/jest-junit.
// Anything malformed is INCONCLUSIVE: a report we cannot read is never a PASS.

import { z } from "zod";
import type { Inconclusive } from "../../types.js";
import { createPathResolver, type PathResolveOptions } from "./paths.js";

export type TestStatus = "passed" | "failed" | "skipped" | "todo" | "pending";

export interface NormalizedTest {
  id: string;
  file: string;
  title: string;
  ancestors: string[];
  status: TestStatus;
}

export interface SuiteFailure {
  file: string;
  message: string;
}

export interface NormalizedReport {
  format: "jest-json" | "junit";
  tests: NormalizedTest[];
  numTotal: number;
  /** Tests that actually ran (passed + failed). */
  numExecuted: number;
  numFailed: number;
  /** Files that failed outside any test (import error, hook failure). */
  suiteFailures: SuiteFailure[];
  success: boolean;
  /** True when the run rewrote snapshots (`-u`): its assertions prove nothing. */
  snapshotsUpdated: boolean;
}

export type ReportParse =
  | { ok: true; report: NormalizedReport }
  | { ok: false; inconclusive: Inconclusive };

export function normalizeTitle(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Stable test identity: (repo-relative file, ancestor titles, title). */
export function testId(file: string, ancestors: readonly string[], title: string): string {
  return JSON.stringify([file, ...ancestors.map(normalizeTitle), normalizeTitle(title)]);
}

const jestStatus = z.enum(["passed", "failed", "skipped", "pending", "todo", "disabled", "focused"]);

const jestJsonSchema = z.object({
  numTotalTests: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(),
  success: z.boolean(),
  snapshot: z
    .object({
      updated: z.number().optional(),
      filesUpdated: z.number().optional(),
      didUpdate: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  testResults: z.array(
    z
      .object({
        name: z.string().min(1),
        status: z.string().optional(),
        message: z.string().optional(),
        assertionResults: z.array(
          z
            .object({
              ancestorTitles: z.array(z.string()),
              title: z.string(),
              status: jestStatus,
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
});

function mapStatus(s: z.infer<typeof jestStatus>): TestStatus {
  switch (s) {
    case "disabled":
      return "skipped";
    case "focused":
      return "passed";
    default:
      return s;
  }
}

function fail(reason: Inconclusive["reason"], detail: string): ReportParse {
  return { ok: false, inconclusive: { reason, detail, authorFixable: false } };
}

function finish(
  format: NormalizedReport["format"],
  tests: NormalizedTest[],
  suiteFailures: SuiteFailure[],
  declaredSuccess: boolean,
  snapshotsUpdated: boolean,
): NormalizedReport {
  const numFailed = tests.filter((t) => t.status === "failed").length;
  const numExecuted = tests.filter((t) => t.status === "passed" || t.status === "failed").length;
  return {
    format,
    tests,
    numTotal: tests.length,
    numExecuted,
    numFailed,
    suiteFailures,
    success: declaredSuccess && numFailed === 0 && suiteFailures.length === 0,
    snapshotsUpdated,
  };
}

export function parseJestJson(text: string, opts: PathResolveOptions = {}): ReportParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail("SCHEMA", `test report is not JSON: ${(e as Error).message}`);
  }
  const parsed = jestJsonSchema.safeParse(raw);
  if (!parsed.success) return fail("SCHEMA", `test report schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const resolve = createPathResolver(opts);
  const tests: NormalizedTest[] = [];
  const suiteFailures: SuiteFailure[] = [];
  for (const file of parsed.data.testResults) {
    const r = resolve(file.name);
    if (!r.ok) return fail("SCHEMA", `cannot map test file ${r.raw}: ${r.detail}`);
    for (const a of file.assertionResults) {
      tests.push({
        id: testId(r.path, a.ancestorTitles, a.title),
        file: r.path,
        title: normalizeTitle(a.title),
        ancestors: a.ancestorTitles.map(normalizeTitle),
        status: mapStatus(a.status),
      });
    }
    const hasFailedTest = file.assertionResults.some((a) => a.status === "failed");
    if (file.status === "failed" && !hasFailedTest) {
      suiteFailures.push({ file: r.path, message: (file.message ?? "").slice(0, 500) || "suite failed" });
    }
  }
  if (tests.length !== parsed.data.numTotalTests) {
    return fail("SCHEMA", `report lists ${tests.length} tests but numTotalTests is ${parsed.data.numTotalTests}`);
  }
  const snap = parsed.data.snapshot;
  const updated = Boolean(snap?.didUpdate) || (snap?.updated ?? 0) > 0 || (snap?.filesUpdated ?? 0) > 0;
  return { ok: true, report: finish("jest-json", tests, suiteFailures, parsed.data.success, updated) };
}

// --- JUnit XML --------------------------------------------------------------
// A deliberately small reader: the elements we need never nest arbitrarily,
// and pulling in an XML dependency for the trust boundary is not worth it.

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "amp") return "&";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    const code = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return out;
}

/** vitest writes `name="outer > inner > title"`; jest-junit's default separator is a space, which we cannot split. */
export const JUNIT_ANCESTOR_SEPARATOR = " > ";

export function parseJUnitXml(text: string, opts: PathResolveOptions = {}): ReportParse {
  const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (!/<testsuites?\b/.test(body)) return fail("SCHEMA", "not a JUnit report: no <testsuite(s)>");
  const resolve = createPathResolver(opts);
  const tests: NormalizedTest[] = [];
  const suiteFailures: SuiteFailure[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of body.matchAll(caseRe)) {
    const a = attrs(m[1]!);
    const inner = m[3] ?? "";
    const fileAttr = a.file ?? a.classname;
    if (!fileAttr || a.name === undefined) return fail("SCHEMA", "testcase without file/classname or name");
    const r = resolve(fileAttr);
    if (!r.ok) return fail("SCHEMA", `cannot map test file ${r.raw}: ${r.detail}`);
    const parts = a.name.split(JUNIT_ANCESTOR_SEPARATOR);
    const title = parts.pop()!;
    let status: TestStatus = "passed";
    if (/<(failure|error)\b/.test(inner)) status = "failed";
    else if (/<skipped\b/.test(inner)) status = "skipped";
    tests.push({
      id: testId(r.path, parts, title),
      file: r.path,
      title: normalizeTitle(title),
      ancestors: parts.map(normalizeTitle),
      status,
    });
  }
  // Errors attached to a suite rather than a case (import failures).
  for (const m of body.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const a = attrs(m[1]!);
    const inner = m[2]!.replace(caseRe, "");
    if (/<(failure|error)\b/.test(inner)) {
      const r = resolve(a.file ?? a.name ?? "");
      suiteFailures.push({ file: r.ok ? r.path : (a.name ?? "?"), message: "suite-level error" });
    }
  }
  const declared = /<testsuites?\b[^>]*\btests="(\d+)"/.exec(body);
  if (declared && Number(declared[1]) !== tests.length) {
    return fail("SCHEMA", `report lists ${tests.length} testcases but declares tests="${declared[1]}"`);
  }
  return { ok: true, report: finish("junit", tests, suiteFailures, true, false) };
}

export function parseTestReport(text: string | null | undefined, opts: PathResolveOptions = {}): ReportParse {
  if (text === null || text === undefined || text.trim() === "") {
    return fail("REPORT_MISSING", "test report artifact is missing or empty");
  }
  const t = text.trimStart();
  if (t.startsWith("{")) return parseJestJson(text, opts);
  if (t.startsWith("<")) return parseJUnitXml(text, opts);
  return fail("SCHEMA", "unrecognized test report format");
}
