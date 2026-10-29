import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCoverage, type CoverageGateInput } from "../../src/gates/coverage/evaluate.js";
import { exportedFunctions } from "../../src/gates/coverage/exports.js";
import { MAX_COVERAGE_REPORT_BYTES, parseIstanbul } from "../../src/gates/coverage/istanbul.js";
import { entry, manifest, policy } from "../tests-gate/helpers.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const SRC = fx("price.ts.txt");
const COV = fx("coverage-final.json");
const META = JSON.stringify({ provider: "v8", provider_version: "4.1.12", vitest_version: "4.1.12" });
const P = "src/price.ts";

function input(over: Partial<CoverageGateInput> = {}): CoverageGateInput {
  return {
    manifest: manifest([entry("A", null, P)]),
    lineMaps: [],
    coverage: COV,
    meta: META,
    sourcesC: new Map([[P, SRC]]),
    policy: policy(),
    ...over,
  };
}
const modified = (cStart: number, cCount: number): Partial<CoverageGateInput> => ({
  manifest: manifest([entry("M", P, P)]),
  lineMaps: [{ pathB: P, pathC: P, hunks: [{ bStart: cStart, bCount: cCount, cStart, cCount }] }],
});

describe("Istanbul reader", () => {
  it("reads v8-remapped output including implicit else locations", () => {
    const r = parseIstanbul(COV, { knownFiles: [P] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.files.get(P)!;
    expect(f.branches).toHaveLength(6);
    expect(f.branches[1]).toMatchObject({ type: "if", index: 1, range: { start: 2, end: 2 }, count: 2 });
    expect(f.functions.map((x) => [x.name, x.declLine, x.count])).toEqual([["price", 1, 2], ["unused", 7, 0]]);
  });
  it("rejects missing maps and counter mismatches", () => {
    expect(parseIstanbul("")).toMatchObject({ ok: false, inconclusive: { reason: "REPORT_MISSING" } });
    expect(parseIstanbul("{" + " ".repeat(MAX_COVERAGE_REPORT_BYTES) + "}")).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    const raw = JSON.parse(COV);
    const k = Object.keys(raw)[0]!;
    delete raw[k].branchMap;
    expect(parseIstanbul(JSON.stringify(raw))).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    const raw2 = JSON.parse(COV);
    raw2[k].b["0"] = [0];
    expect(parseIstanbul(JSON.stringify(raw2), { knownFiles: [P] })).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
  });
});

describe("exported functions", () => {
  it("finds declarations, const arrows, export lists, default and public class members", () => {
    const src = `export function a() {}\nconst b = () => 1;\nfunction c() {}\nexport { b, c as d };\nexport const e = (async () => {}) as X;\nexport default function () {}\nexport class K { m() {} private p() {} #q() {} constructor() {} }\nfunction hidden() {}`;
    expect(exportedFunctions("x.ts", src).map((f) => f.name)).toEqual(["a", "e", "default", "K.m", "K.constructor", "b", "c"]);
  });
});

describe("G5 coverage gate", () => {
  it("FAILs an added file with unexecuted branch outcomes and an uncalled export", () => {
    const r = evaluateCoverage(input());
    expect(r.state).toBe("FAIL");
    expect(r.observe).toMatchObject({ changed_branch_outcomes: 6, unexecuted_changed_branch_outcomes: 3, allowed_unexecuted: 2 });
    expect(r.violations.map((v) => [v.metric, v.unit ?? null, v.after])).toEqual([
      ["unexecuted_changed_branch_outcomes", null, 3],
      ["exported_function_calls", "unused", 0],
    ]);
  });

  it("PASSes a change whose branches all ran", () => {
    expect(evaluateCoverage(input(modified(4, 1)))).toMatchObject({ state: "PASS", violations: [] });
  });

  it("tolerates up to the absolute floor of unexecuted outcomes", () => {
    const r = evaluateCoverage(input(modified(2, 1)));
    expect(r.state).toBe("PASS");
    expect(r.observe.unexecuted_changed_branch_outcomes).toBe(1);
    expect(r.observe.unexecuted_changed_lines).toBe(1);
  });

  it("uses the ratio when it is larger than the floor", () => {
    const r = evaluateCoverage(input({ policy: policy({ coverage: { max_unexecuted_branches_abs: 0, max_unexecuted_branches_ratio: 0.5 } }) }));
    expect(r.observe.allowed_unexecuted).toBe(3);
    expect(r.violations.map((v) => v.metric)).toEqual(["exported_function_calls"]);
  });

  it("counts an added coverage-ignore hint as an unexecuted outcome", () => {
    const src = SRC.replace("  return vip ?", "  /* v8 ignore next */\n  return vip ?");
    const r = evaluateCoverage(input({ ...modified(4, 1), sourcesC: new Map([[P, src]]), policy: policy({ coverage: { max_unexecuted_branches_abs: 0 } }) }));
    expect(r.state).toBe("FAIL");
    expect(r.violations[0]!.details).toMatchObject({ ignore_comments: [{ line: 4, directive: "v8 ignore next" }] });
    const allowed = evaluateCoverage(
      input({ ...modified(4, 1), sourcesC: new Map([[P, src]]), policy: policy({ coverage: { max_unexecuted_branches_abs: 0, ignore_comment_allowlist: ["v8 ignore next"] } }) }),
    );
    expect(allowed.state).toBe("PASS");
  });

  it("is INCONCLUSIVE when a changed file is missing from the report", () => {
    const r = evaluateCoverage(input({ manifest: manifest([entry("A", null, "src/other.ts")]), sourcesC: new Map([["src/other.ts", "export const x = 1;\n"]]) }));
    expect(r).toMatchObject({ state: "INCONCLUSIVE", inconclusive: [{ reason: "REPORT_MISSING", file: "src/other.ts" }] });
  });

  it("does not expect type-only files in the report", () => {
    const r = evaluateCoverage(input({ manifest: manifest([entry("A", null, "src/t.ts")]), sourcesC: new Map([["src/t.ts", "export interface A { x: number }\nexport type B = A;\n"]]) }));
    expect(r.state).toBe("NOT_APPLICABLE");
  });

  it("is NOT_APPLICABLE without changed code, even without a report", () => {
    const r = evaluateCoverage(input({ manifest: manifest([entry("M", "README.md", "README.md", { excluded: "NOT_CODE" })]), coverage: null, meta: null }));
    expect(r.state).toBe("NOT_APPLICABLE");
    const tests = evaluateCoverage(input({ manifest: manifest([entry("M", "src/a.test.ts", "src/a.test.ts", { isTest: true })]), coverage: null }));
    expect(tests.state).toBe("NOT_APPLICABLE");
  });

  it("is INCONCLUSIVE on provider mismatch, missing metadata or retry disagreement", () => {
    const wrong = evaluateCoverage(input({ ...modified(4, 1), meta: JSON.stringify({ provider: "istanbul" }) }));
    expect(wrong.inconclusive.map((i) => i.reason)).toEqual(["FINGERPRINT_MISMATCH"]);
    const pinned = evaluateCoverage(input({ ...modified(4, 1), policy: policy({ coverage: { provider_version: "4.1.11" } }) }));
    expect(pinned.inconclusive.map((i) => i.reason)).toEqual(["FINGERPRINT_MISMATCH"]);
    expect(evaluateCoverage(input({ ...modified(4, 1), meta: null })).state).toBe("INCONCLUSIVE");
    const raw = JSON.parse(COV);
    raw[Object.keys(raw)[0]!].b["1"] = [0, 2];
    const retry = evaluateCoverage(input({ ...modified(4, 1), retryCoverage: JSON.stringify(raw) }));
    expect(retry.inconclusive.map((i) => i.reason)).toEqual(["NONDETERMINISM"]);
  });

  it("round 4: an unpinned provider version is INCONCLUSIVE once G5 blocks, allowed while observing", () => {
    const enforce = evaluateCoverage(input({ ...modified(4, 1), policy: policy({ coverage: { mode: "enforce" } }) }));
    expect(enforce.inconclusive.map((i) => [i.reason, i.detail])).toEqual([
      ["FINGERPRINT_MISMATCH", expect.stringContaining("coverage.provider_version is not pinned while coverage.mode is enforce")],
    ]);
    expect(evaluateCoverage(input({ ...modified(4, 1), policy: policy({ coverage: { mode: "degraded" } }) })).state).toBe("INCONCLUSIVE");
    expect(evaluateCoverage(input({ ...modified(4, 1), policy: policy({ coverage: { mode: "enforce", provider_version: "4.1.12" } }) })).state).toBe("PASS");
    expect(evaluateCoverage(input(modified(4, 1))).state).toBe("PASS"); // default policy: observe, no pin
  });

  it("round 4: records changed named functions with 0 executions for calibration, without failing on them", () => {
    const src = SRC.replace("export function unused", "function unused");
    const r = evaluateCoverage(input({ sourcesC: new Map([[P, src]]), policy: policy({ coverage: { max_unexecuted_branches_abs: 10 } }) }));
    expect(r.state).toBe("PASS");
    expect(r.observe.unexecuted_changed_named_functions).toEqual([{ file: P, name: "unused", line: 7 }]);
    expect(r.observe.provider).toMatchObject({ provider: "v8", provider_version: "4.1.12", runner: "" });
    // Anonymous entries are not named.
    const raw = JSON.parse(COV);
    raw[Object.keys(raw)[0]!].fnMap["1"].name = "(anonymous_1)";
    const anon = evaluateCoverage(input({ coverage: JSON.stringify(raw), sourcesC: new Map([[P, src]]), policy: policy({ coverage: { max_unexecuted_branches_abs: 10 } }) }));
    expect(anon.observe.unexecuted_changed_named_functions).toEqual([]);
  });

  it("is INCONCLUSIVE when a modified file has no line map", () => {
    const r = evaluateCoverage(input({ manifest: manifest([entry("M", P, P)]) }));
    expect(r.inconclusive.map((i) => i.reason)).toEqual(["REPORT_MISSING"]);
  });

  it("reports both a FAIL and an inconclusive file, FAIL first", () => {
    const r = evaluateCoverage(
      input({
        manifest: manifest([entry("A", null, P), entry("A", null, "src/other.ts")]),
        sourcesC: new Map([[P, SRC], ["src/other.ts", "export const x = 1;\n"]]),
      }),
    );
    expect(r.state).toBe("FAIL");
    expect(r.inconclusive).toHaveLength(1);
  });
});
