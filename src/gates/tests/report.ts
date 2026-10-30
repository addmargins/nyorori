// Normalizes test-run reports from the untrusted Actions job (spec 8.3).
// Supported: the Jest-compatible JSON that `vitest --reporter=json` (4.x) and
// `jest --json` both emit. JUnit is refused (ruling D4): it cannot tell todo
// from skipped and its flattened names cannot be split back into ancestors.
// Anything malformed is INCONCLUSIVE: a report we cannot read is never a PASS.

import { z } from "zod";
import type { Inconclusive } from "../../types.js";
import { createPathResolver, type PathResolveOptions } from "./paths.js";
import { errorMessage } from "../../util/errors.js";

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
  format: "jest-json";
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

/** Test statuses of the Jest/Vitest JSON reporter. */
const JEST_STATUSES = ["passed", "failed", "skipped", "pending", "todo", "disabled", "focused"] as const;
const jestStatus = z.enum(JEST_STATUSES);

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

/** The report comes from the untrusted job; bound the work it can make us do. */
export const MAX_TEST_REPORT_BYTES = 64 * 1024 * 1024;

function tooLarge(text: string, cap: number): boolean {
  return text.length > cap || Buffer.byteLength(text, "utf8") > cap;
}

export function parseJestJson(text: string, opts: PathResolveOptions = {}): ReportParse {
  if (tooLarge(text, MAX_TEST_REPORT_BYTES)) return fail("SCHEMA", `test report exceeds ${MAX_TEST_REPORT_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail("SCHEMA", `test report is not JSON: ${errorMessage(e)}`);
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

export function parseTestReport(text: string | null | undefined, opts: PathResolveOptions = {}): ReportParse {
  if (text === null || text === undefined || text.trim() === "") {
    return fail("REPORT_MISSING", "test report artifact is missing or empty");
  }
  if (tooLarge(text, MAX_TEST_REPORT_BYTES)) return fail("SCHEMA", `test report exceeds ${MAX_TEST_REPORT_BYTES} bytes`);
  if (text.trimStart().startsWith("{")) return parseJestJson(text, opts);
  return fail("SCHEMA", "unsupported report format: only the Jest-compatible JSON report is accepted");
}
