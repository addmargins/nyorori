import { describe, expect, it } from "vitest";
import { validateCcccRun, type CcccRun } from "../../src/measure/cccc.js";

const fileJson = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  cognitive: 1,
  cyclomatic: 2,
  functions: [{ name: "f", kind: "function", line: 1, cognitive: 1, cyclomatic: 2 }],
  ...extra,
});
const report = (files: unknown[], fileCount = files.length) =>
  Buffer.from(JSON.stringify({ files, summary: { file_count: fileCount, function_count: 1 } }));

function run(over: Partial<Omit<CcccRun, "args">> = {}): Omit<CcccRun, "args"> {
  return {
    side: "C",
    rc: 0,
    signal: null,
    stdout: report([fileJson("a.ts")]),
    stderr: Buffer.alloc(0),
    durationMs: 5,
    timedOut: false,
    expectedPaths: ["a.ts"],
    ...over,
  };
}
const reasons = (r: Omit<CcccRun, "args">) => validateCcccRun(r, 120_000).inconclusive.map((i) => i.reason);

describe("validateCcccRun — the nine checks of spec 6.3", () => {
  it("accepts a clean run", () => {
    const v = validateCcccRun(run(), 120_000);
    expect(v.inconclusive).toEqual([]);
    expect(v.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
  it("MEASURER_EXIT on any non-zero exit (the runner never passes --max-*)", () => {
    expect(reasons(run({ rc: 1 }))).toContain("MEASURER_EXIT");
    expect(reasons(run({ rc: null, signal: "SIGSEGV" }))).toContain("MEASURER_EXIT");
  });
  it("EMPTY_OUTPUT when the manifest is non-empty but stdout is empty", () => {
    expect(reasons(run({ stdout: Buffer.alloc(0), stderr: Buffer.from("cccc: no matching files found\n") }))).toEqual([
      "MEASURER_STDERR",
      "EMPTY_OUTPUT",
    ]);
  });
  it("no files expected and no output is not a problem", () => {
    expect(reasons(run({ expectedPaths: [], stdout: Buffer.alloc(0) }))).toEqual([]);
  });
  it("SCHEMA on non-JSON or a changed shape", () => {
    expect(reasons(run({ stdout: Buffer.from("garbage") }))).toEqual(["SCHEMA"]);
    expect(reasons(run({ stdout: Buffer.from(JSON.stringify({ files: [{ path: "a.ts" }], summary: { file_count: 1 } })) }))).toEqual(["SCHEMA"]);
    expect(reasons(run({ stdout: Buffer.from(JSON.stringify({ files: [] })) }))).toEqual(["SCHEMA"]);
    expect(reasons(run({ stdout: report([fileJson("a.ts", { cognitive: -1 })]) }))).toEqual(["SCHEMA"]);
  });
  it("MANIFEST_MISMATCH for a missing, an extra or a duplicated file, or a wrong file_count", () => {
    expect(reasons(run({ expectedPaths: ["a.ts", "b.ts"], stdout: report([fileJson("a.ts")], 1) }))).toEqual([
      "MANIFEST_MISMATCH",
      "MANIFEST_MISMATCH",
    ]);
    expect(reasons(run({ stdout: report([fileJson("a.ts"), fileJson("z.ts")]) }))).toContain("MANIFEST_MISMATCH");
    expect(reasons(run({ stdout: report([fileJson("a.ts"), fileJson("a.ts")], 1) }))).toContain("MANIFEST_MISMATCH");
    expect(reasons(run({ stdout: report([fileJson("a.ts")], 2) }))).toEqual(["MANIFEST_MISMATCH"]);
  });
  it("accepts the ./ prefix cccc echoes for ./-prefixed arguments", () => {
    expect(reasons(run({ stdout: report([fileJson("./a.ts")]) }))).toEqual([]);
  });
  it("MEASURER_STDERR for any stderr output", () => {
    const r = validateCcccRun(run({ stderr: Buffer.from("warning: something\n") }), 120_000);
    expect(r.inconclusive.map((i) => [i.reason, i.authorFixable])).toEqual([["MEASURER_STDERR", false]]);
  });
  it("PARSE_ERROR_CANDIDATE for C-side parse errors, author-fixable", () => {
    const v = validateCcccRun(run({ stdout: report([fileJson("a.ts", { parse_errors: ["Expected `)`"] })]) }), 120_000);
    expect(v.inconclusive.map((i) => [i.reason, i.file, i.authorFixable])).toEqual([["PARSE_ERROR_CANDIDATE", "a.ts", true]]);
  });
  it("B-side parse errors only remove the baseline", () => {
    const v = validateCcccRun(run({ side: "B", stdout: report([fileJson("a.ts", { parse_errors: ["x"] })]) }), 120_000);
    expect(v.inconclusive).toEqual([]);
    expect(v.baselineParseErrors).toEqual(["a.ts"]);
  });
  it("INVARIANT_VIOLATION when functions sum above the file total", () => {
    expect(reasons(run({ stdout: report([fileJson("a.ts", { cognitive: 0 })]) }))).toEqual(["INVARIANT_VIOLATION"]);
    const nested = fileJson("a.ts", {
      cognitive: 1,
      cyclomatic: 3,
      functions: [{ name: "f", kind: "function", line: 1, cognitive: 1, cyclomatic: 2, children: [{ name: "<anonymous>", kind: "arrow", line: 1, cognitive: 1, cyclomatic: 1 }] }],
    });
    expect(reasons(run({ stdout: report([nested]) }))).toEqual(["INVARIANT_VIOLATION"]);
  });
  it("TIMEOUT when killed or over budget", () => {
    expect(reasons(run({ timedOut: true, rc: null, signal: "SIGKILL" }))).toEqual(["TIMEOUT"]);
    expect(validateCcccRun(run({ durationMs: 200 }), 100).inconclusive.map((i) => i.reason)).toEqual(["TIMEOUT"]);
  });
});
