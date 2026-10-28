// Round 4: defects found by the two-branch comparative review and the
// differential test (docs/review/branch-comparison.md). Scope moves across
// the test/product boundary, anonymous units in k-to-k (D21b reversed),
// S11 on vanished units, residue S5 precision and measured `.d.ts` files.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateComplexity } from "../../src/gates/complexity/evaluate.js";
import { validateCcccRun } from "../../src/measure/cccc.js";
import { CCCC, ifChain, runScenario, triggerIds, violationReasons } from "./helpers.js";

const s11 = (r: ReturnType<typeof runScenario>) => r.outcome.triggers.filter((t) => t.id === "S11");
const s5 = (r: ReturnType<typeof runScenario>) => r.outcome.triggers.filter((t) => t.id === "S5");
const unitMatches = (r: ReturnType<typeof runScenario>) => r.match.matches.filter((m) => !m.cKey.endsWith("<module>"));

describe("scope moves never carry an allowance (review: false PASS)", () => {
  const price = ifChain("price", 30);

  it("test → product rename with identical bytes: the C unit is new, FAIL + S11", () => {
    const r = runScenario({
      b: { "test/x.test.ts": price },
      c: { "src/x.ts": price },
      renames: { "src/x.ts": "test/x.test.ts" },
    });
    expect(unitMatches(r)).toEqual([]);
    expect(r.match.scopeChanges).toEqual([{ bPath: "test/x.test.ts", cPath: "src/x.ts", from: "test", to: "product" }]);
    expect(violationReasons(r)).toEqual(["src/x.ts::price#function[0]:UNMATCHED_OVER_BUDGET"]);
    expect(r.outcome.violations[0]!.limit).toBe(15);
    expect(r.outcome.violations[0]!.details!.b_candidates).toEqual([{ unit: "test/x.test.ts::price#function[0]", line: 1, cognitive: 30 }]);
    expect(r.outcome.observe.legacy_debt).toEqual([]);
    expect(s11(r).map((t) => [t.file, t.evidence])).toEqual([["src/x.ts", "scope changed: test → product (test/x.test.ts → src/x.ts)"]]);
  });

  it("the evaluator drops a cross-scope match even when the matcher was not given the globs", () => {
    const r = runScenario({ b: { "test/x.test.ts": price }, c: { "src/x.ts": price }, renames: { "src/x.ts": "test/x.test.ts" } });
    // Simulate a caller that matched the pair (stage 1 identity) before the scope rule existed.
    const forged = evaluateComplexity({
      manifest: r.manifest,
      b: r.b,
      c: r.c,
      lineMaps: r.lineMaps,
      matches: [{ bKey: "test/x.test.ts::price#function[0]", cKey: "src/x.ts::price#function[0]", stage: 1, identityChanged: false }],
      policy: r.policy,
    });
    expect(forged.violations.map((v) => v.reason)).toEqual(["UNMATCHED_OVER_BUDGET"]);
    expect(forged.triggers.filter((t) => t.id === "S11")).toHaveLength(1);
  });

  it("a verbatim unit move from a deleted test file into a new product file (stage 4) is refused", () => {
    const r = runScenario({
      b: { "test/helpers.test.ts": price + ifChain("other", 1) },
      c: { "src/price.ts": price, "test/helpers.test.ts": ifChain("other", 1) },
    });
    expect(r.match.byC.has("src/price.ts::price#function[0]")).toBe(false);
    expect(violationReasons(r)).toEqual(["src/price.ts::price#function[0]:UNMATCHED_OVER_BUDGET"]);
    expect(s11(r).map((t) => [t.file, t.unit, t.evidence])).toEqual([
      ["src/price.ts", "src/price.ts::price#function[0]", "scope changed: test → product (test/helpers.test.ts::price#function[0] → src/price.ts::price#function[0])"],
    ]);
  });

  it("product → test rename routes S11 whatever the C file is named", () => {
    for (const cPath of ["test/price.test.ts", "test/price.ts", "src/__tests__/price.spec.ts"]) {
      const r = runScenario({ b: { "src/price.ts": price }, c: { [cPath]: price }, renames: { [cPath]: "src/price.ts" }, tests: [cPath] });
      expect(unitMatches(r)).toEqual([]);
      expect(r.outcome.violations).toEqual([]); // tests are observed, not enforced
      expect(r.outcome.observe.test_file_violations.map((v) => v.reason)).toEqual(["UNMATCHED_OVER_BUDGET"]);
      expect(s11(r).map((t) => [t.file, t.routing, t.evidence])).toEqual([[cPath, true, `scope changed: product → test (src/price.ts → ${cPath})`]]);
    }
  });

  it("product → test through a deleted/added pair joined by stage 4 routes S11 with the unit keys", () => {
    const r = runScenario({
      b: { "src/price.ts": price, "src/keep.ts": ifChain("keep", 1) },
      c: { "test/price.test.ts": price, "src/keep.ts": ifChain("keep", 1) },
      tests: ["test/price.test.ts"],
    });
    expect(unitMatches(r).map((m) => m.cKey)).toEqual(["src/keep.ts::keep#function[0]"]);
    expect(s11(r).map((t) => [t.file, t.unit])).toEqual([["test/price.test.ts", "test/price.test.ts::price#function[0]"]]);
    expect(s11(r)[0]!.evidence).toMatch(/^scope changed: product → test \(src\/price\.ts::price#function\[0\] → /);
  });

  it("a rename inside one scope still matches at stage 1 (no scope change)", () => {
    const r = runScenario({ b: { "src/old.ts": price }, c: { "src/new.ts": price }, renames: { "src/new.ts": "src/old.ts" } });
    expect(unitMatches(r).map((m) => m.stage)).toEqual([1]);
    expect(r.match.scopeChanges).toEqual([]);
    expect(r.outcome.violations).toEqual([]);
    expect(s11(r)).toEqual([]);
  });
});

describe("D21b reversed: k-to-k never pairs anonymous units (differential m16/m16b)", () => {
  const F = "src/a.js";
  const fn = (n: number, tag: string, cond = (i: number) => `x === ${i}`) =>
    `function(x, y) {${Array.from({ length: n }, (_, i) => `if (${cond(i)}) y += ${i};`).join(" ")} return y; /* ${tag} */}`;

  it("m16b: a new anonymous 18 next to a legacy 18 does not inherit its allowance", () => {
    const b = `export const h = [${fn(18, "p")}, ${fn(5, "q")}];\n`;
    const c = `export const h = [${fn(18, "q2", (i) => `y > ${i}`)}, ${fn(10, "p")}];\n`;
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(unitMatches(r)).toEqual([]);
    expect(violationReasons(r)).toEqual([`${F}::<anonymous>#function[0]:UNMATCHED_OVER_BUDGET`]);
    expect(r.outcome.violations[0]!.details!.b_candidates).toEqual([{ unit: `${F}::<anonymous>#function[0]`, line: 1, cognitive: 18 }]);
    expect(s5(r)).toEqual([]);
  });

  it("m16: two anonymous 18s swapped on one line are both unmatched", () => {
    const b = `export const h = [${fn(18, "p")}, ${fn(18, "q")}];\n`;
    const c = `export const h = [${fn(18, "q")}, ${fn(18, "p")}];\n`;
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(unitMatches(r)).toEqual([]);
    expect(violationReasons(r).sort()).toEqual([
      `${F}::<anonymous>#function[0]:UNMATCHED_OVER_BUDGET`,
      `${F}::<anonymous>#function[1]:UNMATCHED_OVER_BUDGET`,
    ]);
  });

  it("named k-to-k groups still pair (D21b for named units is unchanged)", () => {
    const cls = (name: string, n: number) =>
      `class ${name} { run(x) { let y = 0; ${Array.from({ length: n }, (_, i) => `if (x === ${i}) y++;`).join(" ")} return y; } }`;
    const r = runScenario({ b: { [F]: `${cls("A", 20)}\n${cls("B", 18)}\n` }, c: { [F]: `${cls("A2", 19)}\n${cls("B2", 17)}\n` } });
    expect(unitMatches(r).map((m) => [m.stage, m.identityChanged])).toEqual([[3, true], [3, true]]);
    expect(r.outcome.violations).toEqual([]);
  });
});

describe("S11 unit vanish (spec 6.4): another unit of the same name does not clear it", () => {
  const F = "src/a.js";
  const cls = (name: string, n: number, extra = "") =>
    `export class ${name} {\n${ifChain("run", n, "  ").replace(/function run\(x\)/, `run(x)${extra}`)}}\n`;

  it("m15b: B.run (CogC 5) vanishes while `run` stays bound through another class", () => {
    const b = cls("A", 20) + cls("B", 5);
    const c = cls("B", 20, " // rewritten");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    // The surviving `run` is the stage-2 counterpart of A.run; B.run has none.
    expect(unitMatches(r).map((m) => [m.bKey, m.stage])).toEqual([[`${F}::run#method[0]`, 2]]);
    expect(r.outcome.violations).toEqual([]);
    const vanish = s11(r);
    expect(vanish.map((t) => [t.file, t.unit])).toEqual([[F, `${F}::run#method[1]`]]);
    expect(vanish[0]!.evidence).toMatch(/^단위 소실: run \(B CogC 5, CC 6\)/);
  });

  it("a deleted unit whose name is gone from C, and a dropped overload signature, fire nothing", () => {
    const gone = runScenario({ b: { [F]: ifChain("a", 2) + ifChain("b", 2) }, c: { [F]: ifChain("a", 2) } });
    expect(s11(gone)).toEqual([]);
    const P = "src/a.ts";
    const impl = ifChain("f", 3).replace("function f(x)", "export function f(x: any): any");
    const two = "export function f(x: string): string;\nexport function f(x: number): number;\n" + impl;
    const one = "export function f(x: number): number;\n" + impl;
    const r = runScenario({ b: { [P]: two }, c: { [P]: one } });
    expect(r.outcome.violations).toEqual([]);
    expect(s11(r)).toEqual([]);
  });
});

describe("residue S5 covers every gap between units (review: residue precision)", () => {
  const F = "src/r.js";
  const ifs = Array.from({ length: 21 }, (_, i) => `if (cfg.k === ${i}) out.push(${i});`).join("\n");
  const b = ifChain("a", 2) + `const cfg = globalThis.cfg; const out = [];\n${ifs}\n` + ifChain("b", 2) + "console.log(out);\n";

  it("residue 21 → 21: editing a top-level statement between two functions fires S5", () => {
    const c = b.replace("out.push(3);", "out.push(30);");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(r.b.get(F)!.residue.cognitive).toBe(21);
    expect(r.c.get(F)!.residue.cognitive).toBe(21);
    expect(r.outcome.violations).toEqual([]);
    expect(s5(r).map((t) => t.unit)).toEqual([`${F}::<module>`]);
    expect(s5(r)[0]!.evidence).toMatch(/^부채 <module> residue \(B CogC 21 → C 21\) 범위 \d+-\d+ 수정$/);
  });

  it("the tail after the last function is residue too", () => {
    const r = runScenario({ b: { [F]: b }, c: { [F]: b.replace("console.log(out);", "console.error(out);") } });
    expect(s5(r).map((t) => t.unit)).toEqual([`${F}::<module>`]);
  });

  it("an edit inside a function next to the residue does not touch it", () => {
    const r = runScenario({ b: { [F]: b }, c: { [F]: b.replace("function b(x) {\n  let y = 0;", "function b(x) {\n  let y = 1;") } });
    expect(r.c.get(F)!.residue.cognitive).toBe(21);
    expect(s5(r)).toEqual([]);
    expect(triggerIds(r)).not.toContain("S5");
  });

  it("without B sources only the head range and score changes are known (old behaviour)", () => {
    const c = b.replace("out.push(3);", "out.push(30);");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c }, noSourcesForMatch: true });
    expect(s5(r)).toEqual([]);
    const head = runScenario({ b: { [F]: b }, c: { [F]: "// header\n" + c }, noSourcesForMatch: true });
    expect(s5(head)).toEqual([]);
    const changed = runScenario({ b: { [F]: b }, c: { [F]: c.replace("out.push(30);", "out.push(30); if (cfg.z) out.pop();") }, noSourcesForMatch: true });
    expect(s5(changed).map((t) => t.unit)).toEqual([`${F}::<module>`]);
  });
});

describe(".d.ts measured on C (policy.scope.declaration_impl_check)", () => {
  const decl = "export declare function f(a: number): number;\nexport interface X { a: number }\nexport type Y = X | null;\n";

  it("a clean declaration file is an ordinary measured file: PASS, no triggers (differential i24)", () => {
    const r = runScenario({ b: {}, c: { "src/types.d.ts": decl } });
    const f = r.c.get("src/types.d.ts")!;
    expect(f.units.map((u) => [u.name, u.signatureOnly])).toEqual([["f", true]]);
    expect(f.residue.cognitive).toBe(0);
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers).toEqual([]);
    expect(r.outcome.inconclusive).toEqual([]);
  });

  it("an implementation inside a .d.ts is an author-fixable PARSE_ERROR_CANDIDATE", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-dts-"));
    try {
      const path = "src/impl.d.ts";
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), decl + "export function g(a: number): number {\n  if (a) return 1;\n  return 2;\n}\n");
      const run = spawnSync(CCCC, ["--no-config", "--no-cache", "--lang", "es", "--", path], { cwd: dir });
      const v = validateCcccRun(
        { side: "C", rc: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, durationMs: 1, timedOut: false, expectedPaths: [path] },
        60_000,
      );
      const hit = v.inconclusive.find((i) => i.reason === "PARSE_ERROR_CANDIDATE")!;
      expect(hit).toBeDefined();
      expect(hit.authorFixable).toBe(true);
      expect(hit.file).toBe(path);
      expect(hit.detail).toMatch(/declaration file but contains an implementation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
