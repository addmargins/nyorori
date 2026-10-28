import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTestReport, testId } from "../../src/gates/tests/report.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const opts = { knownFiles: ["src/price.test.ts", "src/broken.test.ts", "src/none.test.ts"] };

describe("vitest 4.1 JSON report", () => {
  it("normalizes a real report", () => {
    const r = parseTestReport(fx("vitest-4.1-report.json"), opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.format).toBe("jest-json");
    expect(r.report.numTotal).toBe(4);
    expect(r.report.numExecuted).toBe(3);
    expect(r.report.numFailed).toBe(1);
    expect(r.report.success).toBe(false);
    expect(r.report.tests.map((t) => t.status)).toEqual(["passed", "passed", "failed", "todo"]);
    expect(r.report.tests[0]!.id).toBe(testId("src/price.test.ts", ["price"], "zero quantity costs nothing"));
  });
  it("reports an import failure as a suite failure", () => {
    const r = parseTestReport(fx("vitest-4.1-suite-error.json"), opts);
    expect(r.ok && r.report.suiteFailures).toEqual([{ file: "src/broken.test.ts", message: "boom at import" }]);
    expect(r.ok && r.report.success).toBe(false);
  });
  it("counts zero executed tests for an empty passing run", () => {
    const r = parseTestReport(fx("vitest-4.1-no-tests.json"), opts);
    expect(r.ok && r.report.numExecuted).toBe(0);
  });
  it("flags snapshot rewriting", () => {
    const raw = JSON.parse(fx("vitest-4.1-report.json"));
    raw.snapshot.didUpdate = true;
    const r = parseTestReport(JSON.stringify(raw), opts);
    expect(r.ok && r.report.snapshotsUpdated).toBe(true);
  });
  it("is INCONCLUSIVE for missing, garbage, inconsistent or unmappable reports", () => {
    expect(parseTestReport(null)).toMatchObject({ ok: false, inconclusive: { reason: "REPORT_MISSING" } });
    expect(parseTestReport("{nope")).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    expect(parseTestReport('{"numTotalTests":1}')).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    const raw = JSON.parse(fx("vitest-4.1-report.json"));
    raw.numTotalTests = 9;
    expect(parseTestReport(JSON.stringify(raw), opts)).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    expect(parseTestReport(fx("vitest-4.1-report.json"), { knownFiles: ["other.ts"] })).toMatchObject({ ok: false });
    expect(parseTestReport("plain text")).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
  });
});

describe("JUnit XML report", () => {
  it("normalizes a real vitest JUnit report to the same IDs as JSON", () => {
    const x = parseTestReport(fx("vitest-4.1-junit.xml"), opts);
    const j = parseTestReport(fx("vitest-4.1-report.json"), opts);
    expect(x.ok && j.ok).toBe(true);
    if (!x.ok || !j.ok) return;
    expect(x.report.format).toBe("junit");
    expect(x.report.tests.map((t) => t.id)).toEqual(j.report.tests.map((t) => t.id));
    expect(x.report.numFailed).toBe(1);
    // JUnit cannot tell todo from skipped.
    expect(x.report.tests[3]!.status).toBe("skipped");
  });
  it("decodes entities and rejects count mismatches", () => {
    const xml = `<testsuites tests="1"><testsuite name="a"><testcase classname="a.test.ts" name="x &amp; y &#62; z"/></testsuite></testsuites>`;
    const r = parseTestReport(xml);
    expect(r.ok && r.report.tests[0]).toMatchObject({ ancestors: ["x & y"], title: "z" });
    expect(parseTestReport(xml.replace('tests="1"', 'tests="2"'))).toMatchObject({ ok: false });
    expect(parseTestReport("<html/>")).toMatchObject({ ok: false });
  });
});
