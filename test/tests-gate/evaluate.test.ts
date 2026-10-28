import { describe, expect, it } from "vitest";
import { evaluateTests, type TestsGateInput } from "../../src/gates/tests/evaluate.js";
import { parseTestReport } from "../../src/gates/tests/report.js";
import { entry, jestReport, manifest, policy } from "./helpers.js";

const FILE = "src/price.test.ts";
const B_SRC = `
import { describe, it, expect } from "vitest";
describe("price", () => {
  it("zero", () => { expect(price(0)).toBe(0); });
  it("vip", () => { expect(price(10, true)).toBe(90); expect(log).toHaveBeenCalledWith("vip"); });
  it("snapshot", () => { expect(render()).toMatchInlineSnapshot(\`"<b>1</b>"\`); });
});
`;
const ALL: Array<{ file: string; ancestors: string[]; title: string; status?: "passed" | "failed" | "skipped" | "todo" | "pending" }> = [
  { file: FILE, ancestors: ["price"], title: "zero" },
  { file: FILE, ancestors: ["price"], title: "vip" },
  { file: FILE, ancestors: ["price"], title: "snapshot" },
];
const known = { knownFiles: [FILE, "src/other.test.ts", "test/moved.test.ts"] };

function run(cSrc: string, over: Partial<TestsGateInput> = {}, cTests = ALL) {
  return evaluateTests({
    manifest: manifest([entry("M", FILE, FILE, { isTest: true })]),
    reportB: parseTestReport(jestReport(ALL), known),
    reportC: parseTestReport(jestReport(cTests), known),
    testSourcesB: new Map([[FILE, B_SRC]]),
    testSourcesC: new Map([[FILE, cSrc]]),
    policy: policy(),
    isAiLoop: false,
    ...over,
  });
}
const reasons = (r: ReturnType<typeof run>) => r.violations.map((v) => v.reason);

describe("G4 tests gate", () => {
  it("passes an unchanged, green suite", () => {
    const r = run(B_SRC);
    expect(r.state).toBe("PASS");
    expect(r.violations).toEqual([]);
    expect(r.triggers).toEqual([]);
  });

  it("FAILs when tests fail, even if the refactor lowered complexity", () => {
    const r = run(B_SRC, {}, [ALL[0]!, { ...ALL[1]!, status: "failed" }, ALL[2]!]);
    expect(r.state).toBe("FAIL");
    expect(reasons(r)).toEqual(["TESTS_FAILED"]);
  });

  it("is INCONCLUSIVE when nothing ran or the report is missing", () => {
    const none = run(B_SRC, {}, []);
    expect(none.inconclusive.map((i) => i.reason)).toContain("NO_TESTS_EXECUTED");
    const skipped = run(B_SRC, { reportB: null }, ALL.map((t) => ({ ...t, status: "skipped" as const })));
    expect(skipped.state).toBe("INCONCLUSIVE");
    const missing = run(B_SRC, { reportC: null });
    expect(missing).toMatchObject({ state: "INCONCLUSIVE", inconclusive: [{ reason: "REPORT_MISSING" }] });
  });

  it("FAILs a deleted test (report and static evidence), not waivable", () => {
    const cSrc = B_SRC.replace(/  it\("vip"[^\n]*\n/, "");
    const r = run(cSrc, {}, [ALL[0]!, ALL[2]!]);
    expect(reasons(r)).toEqual(["TEST_REMOVED"]);
    expect(r.violations[0]).toMatchObject({ unit: "price › vip", details: { waivable: false, approvalKind: "gate-owners", source: "report" } });
    // Without a base report the static scan still sees it.
    const s = run(cSrc, { reportB: null }, [ALL[0]!, ALL[2]!]);
    expect(s.violations).toMatchObject([{ reason: "TEST_REMOVED", details: { source: "static" } }]);
  });

  it("D3: a proven rename (same body, B passed, unique pair) is observe; a changed body stays TEST_REMOVED", () => {
    const renamedReport = [ALL[0]!, { ...ALL[1]!, title: "vip customers" }, ALL[2]!];
    const same = run(B_SRC.replace('it("vip", () => { expect', 'it("vip customers", () => {\n    // reworded\n    expect'), {}, renamedReport);
    expect(same.violations).toEqual([]);
    expect(same.observe.renamed_tests).toEqual([{ from: "price › vip", to: "price › vip customers", file: FILE }]);
    const gutted = run(B_SRC.replace('it("vip", () => { expect(price(10, true)).toBe(90);', 'it("vip customers", () => { price(10, true); expect(1).toBe(90);'), {}, renamedReport);
    expect(gutted.violations).toMatchObject([{ reason: "TEST_REMOVED", details: { rename: false, rename_candidates: ["price › vip customers"] } }]);
    // B failing, or no base run: the rename cannot be proven.
    const failedInB = run(B_SRC.replace('it("vip"', 'it("vip customers"'), { reportB: parseTestReport(jestReport([ALL[0]!, { ...ALL[1]!, status: "failed" }, ALL[2]!]), known) }, renamedReport);
    expect(reasons(failedInB)).toEqual(["TEST_REMOVED"]);
    expect(reasons(run(B_SRC.replace('it("vip"', 'it("vip customers"'), { reportB: null }, renamedReport))).toEqual(["TEST_REMOVED"]);
    // AI loop renames FAIL.
    const ai = run(B_SRC.replace('it("vip"', 'it("vip customers"'), { isAiLoop: true }, renamedReport);
    expect(ai.violations).toMatchObject([{ reason: "TEST_REMOVED", details: { rename: true } }]);
  });

  it("D3: a describe rename pairs every child; duplicate bodies do not pair", () => {
    const cSrc = B_SRC.replace('describe("price"', 'describe("pricing"');
    const r = run(cSrc, {}, ALL.map((t) => ({ ...t, ancestors: ["pricing"] })));
    expect(r.violations).toEqual([]);
    expect((r.observe.renamed_tests as unknown[]).length).toBe(3);
    const dupB = `describe("d", () => {\n  it("a", () => { expect(1).toBe(1); });\n  it("b", () => { expect(1).toBe(1); });\n});\n`;
    const dupC = dupB.replace('it("a"', 'it("a2"').replace('it("b"', 'it("b2"');
    const tests = (t: string[]) => t.map((title) => ({ file: FILE, ancestors: ["d"], title }));
    const d = run(dupC, { testSourcesB: new Map([[FILE, dupB]]), reportB: parseTestReport(jestReport(tests(["a", "b"])), known) }, tests(["a2", "b2"]));
    expect(reasons(d)).toEqual(["TEST_REMOVED", "TEST_REMOVED"]);
  });

  it("follows git file renames instead of reporting removals", () => {
    const moved = "test/moved.test.ts";
    const r = evaluateTests({
      manifest: manifest([entry("R", FILE, moved, { isTest: true, similarity: 100 })]),
      reportB: parseTestReport(jestReport(ALL), known),
      reportC: parseTestReport(jestReport(ALL.map((t) => ({ ...t, file: moved }))), known),
      testSourcesB: new Map([[FILE, B_SRC]]),
      testSourcesC: new Map([[moved, B_SRC]]),
      policy: policy(),
      isAiLoop: false,
    });
    expect(r.state).toBe("PASS");
  });

  it("FAILs newly added .only/.skip/xit/fails but not pre-existing ones", () => {
    const r = run(B_SRC.replace('it("zero"', 'it.only("zero"').replace('it("vip"', "xit(\"vip\""));
    expect(r.violations.map((v) => [v.reason, v.details?.marker])).toEqual([
      ["TEST_FOCUS_OR_SKIP", "only"],
      ["TEST_FOCUS_OR_SKIP", "x"],
    ]);
    const pre = B_SRC.replace('it("zero"', 'it.skip("zero"');
    const r2 = evaluateTests({ ...baseInput(pre, pre) });
    expect(r2.violations).toEqual([]);
  });

  it("FAILs a test that ran on B but is skipped on C at runtime", () => {
    const r = run(B_SRC, {}, [{ ...ALL[0]!, status: "skipped" }, ALL[1]!, ALL[2]!]);
    expect(r.violations).toMatchObject([{ reason: "TEST_FOCUS_OR_SKIP", details: { marker: "report" } }]);
  });

  it("D2/D14: a new assertion-free test is S7 and a new todo is observe for people; both FAIL for the AI loop", () => {
    const src = B_SRC.replace(/\n\}\);\n$/, '\n  it("new", () => { price(1); });\n  it.todo("planned");\n});\n');
    const tests = [...ALL, { file: FILE, ancestors: ["price"], title: "new" }, { file: FILE, ancestors: ["price"], title: "planned", status: "todo" as const }];
    const r = run(src, {}, tests);
    expect(r.violations).toEqual([]);
    expect(r.triggers.map((t) => [t.id, t.unit])).toEqual([["S7", "price › new"]]);
    expect(r.observe.new_todos).toEqual(["price › planned"]);
    const ai = run(src, { isAiLoop: true }, tests);
    expect(ai.violations.map((v) => [v.reason, v.unit])).toEqual([
      ["TEST_FOCUS_OR_SKIP", "price › planned"],
      ["TEST_NO_ASSERTION", "price › new"],
    ]);
  });

  it("D2: todo on an existing test FAILs; a new skipIf/runIf is S7", () => {
    const todo = run(B_SRC.replace(/it\("zero", \(\) => \{[^\n]*\}\);/, 'it.todo("zero");'), { reportB: null });
    expect(todo.violations).toMatchObject([{ reason: "TEST_FOCUS_OR_SKIP", details: { marker: "todo" } }]);
    const cond = run(B_SRC.replace('it("zero"', 'it.skipIf(process.env.CI)("zero"').replace('it("vip"', 'it.runIf(isLinux)("vip"'));
    expect(cond.violations).toEqual([]);
    expect(cond.triggers.map((t) => [t.id, t.unit])).toEqual([["S7", "price › zero"], ["S7", "price › vip"]]);
    expect(reasons(run(B_SRC.replace('it("zero"', 'it.skipIf(x)("zero"'), { isAiLoop: true }))).toEqual(["TEST_FOCUS_OR_SKIP"]);
  });

  it("D14: recognizes supertest .expect and throwing Testing Library queries as assertions", () => {
    const src = B_SRC.replace(/\n\}\);\n$/, '\n  it("api", async () => { await request(app).get("/").expect(200); });\n  it("ui", async () => { render(<P/>); screen.getByRole("button"); await findAllByText("x"); });\n  it("query only", () => { screen.queryByText("x"); });\n});\n');
    const r = run(src, { testSourcesC: new Map([[FILE.replace(".ts", ".tsx"), src]]), manifest: manifest([entry("M", FILE, FILE.replace(".ts", ".tsx"), { isTest: true })]), changedFiles: [{ status: "R", pathB: FILE, pathC: FILE.replace(".ts", ".tsx") }] }, [
      ...ALL,
      ...["api", "ui", "query only"].map((title) => ({ file: FILE, ancestors: ["price"], title })),
    ]);
    expect(r.triggers.filter((t) => t.evidence.includes("no assertion")).map((t) => t.unit)).toEqual(["price › query only"]);
  });

  it("D14: a failure that also fails on the base is a separate, waivable violation", () => {
    const failing = (title: string) => ({ ...ALL.find((t) => t.title === title)!, status: "failed" as const });
    const r = run(B_SRC, { reportB: parseTestReport(jestReport([failing("zero"), ALL[1]!, ALL[2]!]), known) }, [failing("zero"), failing("vip"), ALL[2]!]);
    expect(r.violations.map((v) => [v.reason, v.unit, v.details?.waivable, v.details?.base_broken])).toEqual([
      ["TESTS_FAILED", "price › vip", false, undefined],
      ["TESTS_FAILED_ON_BASE", "price › zero", true, true],
    ]);
  });

  it("routes matcher weakening, assertion loss and snapshot updates to S7 for people", () => {
    const cSrc = B_SRC.replace('expect(price(10, true)).toBe(90);', "expect(price(10, true)).toBeDefined();")
      .replace('expect(price(0)).toBe(0);', "")
      .replace('"<b>1</b>"', '"<b>2</b>"');
    const r = run(cSrc);
    expect(r.state).toBe("PASS");
    expect(r.triggers.map((t) => [t.id, t.unit, t.routing])).toEqual([
      ["S7", "price › zero", true],
      ["S7", "price › vip", true],
      ["S7", "price › snapshot", true],
    ]);
    expect(r.triggers[1]!.evidence).toContain("strong matchers 2→1");
  });

  it("routes .snap file updates to S7 but not newly added snapshot files", () => {
    const r = evaluateTests({
      ...baseInput(B_SRC, B_SRC),
      changedFiles: [
        { status: "M", pathB: FILE, pathC: FILE },
        { status: "M", pathB: "src/__snapshots__/price.test.ts.snap", pathC: "src/__snapshots__/price.test.ts.snap" },
        { status: "A", pathB: null, pathC: "src/__snapshots__/new.test.ts.snap" },
      ],
    });
    expect(r.triggers).toMatchObject([{ id: "S7", file: "src/__snapshots__/price.test.ts.snap" }]);
  });

  it("makes weakening a FAIL for the AI fix loop, and protected paths too", () => {
    const cSrc = B_SRC.replace('expect(price(10, true)).toBe(90);', "expect(price(10, true)).toBeTruthy();");
    const r = run(cSrc, {
      isAiLoop: true,
      changedFiles: [
        { status: "M", pathB: FILE, pathC: FILE },
        { status: "M", pathB: "vitest.config.ts", pathC: "vitest.config.ts" },
      ],
      configSourcesB: new Map([["vitest.config.ts", "export default { test: {} }"]]),
      configSourcesC: new Map([["vitest.config.ts", "export default { test: { testTimeout: 1 } }"]]),
    });
    expect(r.triggers).toEqual([]);
    expect(reasons(r).sort()).toEqual(["PROTECTED_PATH_MODIFIED", "TEST_CONFIG_WEAKENED"]);
    const human = run(cSrc, {
      changedFiles: [{ status: "M", pathB: "vitest.config.ts", pathC: "vitest.config.ts" }],
      configSourcesB: new Map([["vitest.config.ts", "export default { test: {} }"]]),
      configSourcesC: new Map([["vitest.config.ts", "export default { test: { testTimeout: 1 } }"]]),
    });
    expect(human.violations).toEqual([]);
    expect(human.observe.protected_paths_changed).toEqual(["vitest.config.ts"]);
    // D1: the gate never assumes CODEOWNERS; a person's protected change routes as S11.
    expect(human.triggers).toEqual([{ id: "S11", gate: "tests", file: "vitest.config.ts", evidence: "protected config changed: vitest.config.ts", routing: true }]);
  });

  it("FAILs weakened coverage configuration for everyone", () => {
    const r = run(B_SRC, {
      changedFiles: [{ status: "M", pathB: "vitest.config.ts", pathC: "vitest.config.ts" }],
      configSourcesB: new Map([["vitest.config.ts", "export default { test: { coverage: { thresholds: { branches: 90 } } } }"]]),
      configSourcesC: new Map([["vitest.config.ts", "export default { test: { coverage: { thresholds: { branches: 50 } } } }"]]),
    });
    expect(r.violations).toMatchObject([
      { reason: "TEST_CONFIG_WEAKENED", file: "vitest.config.ts", details: { setting: "test.coverage.thresholds.branches", approvalKind: "gate-owners", waivable: false } },
    ]);
    expect(r.triggers).toEqual([]); // the FAIL already covers the file; no extra S11
  });

  it("D1: setup files, retry and module aliases are S7 evidence plus S11", () => {
    const r = run(B_SRC, {
      changedFiles: [{ status: "M", pathB: "vitest.config.ts", pathC: "vitest.config.ts" }],
      configSourcesB: new Map([["vitest.config.ts", 'export default { resolve: { alias: { "@": "./src" } }, test: { setupFiles: ["./setup.ts"] } }']]),
      configSourcesC: new Map([["vitest.config.ts", 'export default { resolve: { alias: { "@": "./fake" } }, test: { setupFiles: ["./setup.ts", "./mock-all.ts"], retry: 3 } }']]),
    });
    expect(r.violations).toEqual([]);
    expect(r.triggers.map((t) => `${t.id} ${t.evidence}`)).toEqual([
      "S7 resolve.alias.@: alias changed",
      "S7 test.retry: retry changed",
      "S7 test.setupFiles: setupFiles changed",
      "S11 protected config changed: vitest.config.ts",
    ]);
  });

  it("bug #6: moving a protected config out of the protected set counts as deleting it", () => {
    const cfg = "export default { test: { coverage: { thresholds: { lines: 90, branches: 85 } } } };\n";
    const move = (status: "D" | "R", pathC: string | null) =>
      run(B_SRC, {
        changedFiles: [{ status, pathB: "vitest.config.ts", pathC }],
        configSourcesB: new Map([["vitest.config.ts", cfg]]),
        configSourcesC: pathC ? new Map([[pathC, cfg]]) : new Map(),
      });
    expect(reasons(move("D", null))).toEqual(["TEST_CONFIG_WEAKENED", "TEST_CONFIG_WEAKENED"]);
    expect(reasons(move("R", "tools/vitest.base.ts"))).toEqual(["TEST_CONFIG_WEAKENED", "TEST_CONFIG_WEAKENED"]);
    // A rename between two protected names is compared normally.
    expect(move("R", "vitest.config.mts").violations).toEqual([]);
  });

  it("is INCONCLUSIVE rather than PASS when a changed test or config source was not provided", () => {
    const r = run(B_SRC, { testSourcesC: new Map() });
    expect(r.inconclusive.map((i) => i.reason)).toEqual(["REPORT_MISSING"]);
    const c = run(B_SRC, { changedFiles: [{ status: "M", pathB: "package.json", pathC: "package.json" }] });
    expect(c.state).toBe("INCONCLUSIVE");
  });

  it("FAILs a run that rewrote snapshots", () => {
    const r = run(B_SRC, { reportC: parseTestReport(jestReport(ALL, { snapshot: { didUpdate: true } }), known) });
    expect(reasons(r)).toEqual(["TEST_CONFIG_WEAKENED"]);
  });

  it("ignores unchanged test files even when all B sources are passed", () => {
    const other = "src/other.test.ts";
    const r = evaluateTests({
      ...baseInput(B_SRC, B_SRC),
      testSourcesB: new Map([[FILE, B_SRC], [other, 'it("x", () => { expect(1).toBe(1); });']]),
    });
    expect(r.violations).toEqual([]);
  });
});

function baseInput(bSrc: string, cSrc: string): TestsGateInput {
  return {
    manifest: manifest([entry("M", FILE, FILE, { isTest: true })]),
    reportB: null,
    reportC: parseTestReport(jestReport(ALL), known),
    testSourcesB: new Map([[FILE, bSrc]]),
    testSourcesC: new Map([[FILE, cSrc]]),
    policy: policy(),
    isAiLoop: false,
  };
}
