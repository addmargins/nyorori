// Spec 5.3 decision table, spec 14 policy rows and the individual triggers,
// measured with the real cccc binary.

import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "../../src/types.js";
import { ifChain, runScenario, triggerIds, violationReasons } from "./helpers.js";

const F = "src/plan.js";
const K = (name: string, i = 0) => `${F}::${name}#function[${i}]`;
const only = (r: ReturnType<typeof runScenario>) => r.outcome.violations.map((v) => [v.reason, v.before, v.after, v.limit]);

describe("spec 5.3 decision table", () => {
  it("new 15 PASS / new 16 FAIL OVER_LIMIT_NEW", () => {
    expect(runScenario({ b: {}, c: { [F]: ifChain("f", 15) } }).outcome.violations).toEqual([]);
    const r = runScenario({ b: {}, c: { [F]: ifChain("f", 16) } });
    expect(only(r)).toEqual([["OVER_LIMIT_NEW", null, 16, 15]]);
    expect(r.outcome.violations[0]!.message).toBe("f: CogC 16, 한도 15 초과 (OVER_LIMIT_NEW)");
  });

  it("existing 10→14 PASS, 10→17 FAIL OVER_LIMIT", () => {
    const b = { [F]: ifChain("f", 10) };
    expect(runScenario({ b, c: { [F]: ifChain("f", 14) } }).outcome.violations).toEqual([]);
    expect(only(runScenario({ b, c: { [F]: ifChain("f", 17) } }))).toEqual([["OVER_LIMIT", 10, 17, 15]]);
  });

  it("legacy 22→22 PASS with legacy_debt and S5", () => {
    const b = ifChain("f", 22);
    const c = b.replace("y += 3;", "y += 3; // touched");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.observe.legacy_debt).toEqual([{ unit: K("f"), line: 1, cognitive: 22, cyclomatic: 23, before: 22 }]);
    expect(triggerIds(r)).toContain("S5");
  });

  it("legacy 22→23 FAIL LEGACY_WORSENED; 22→18 PASS + S5", () => {
    const b = { [F]: ifChain("f", 22) };
    expect(only(runScenario({ b, c: { [F]: ifChain("f", 23) } }))).toEqual([["LEGACY_WORSENED", 22, 23, 22]]);
    const better = runScenario({ b, c: { [F]: ifChain("f", 18) } });
    expect(better.outcome.violations).toEqual([]);
    expect(triggerIds(better)).toContain("S5");
  });

  it("unmatched legacy-sized unit: FAIL UNMATCHED_OVER_BUDGET with B candidates", () => {
    const b = ifChain("legacyA", 22) + ifChain("other", 2);
    const c = ifChain("other", 2) + ifChain("renamedA", 21);
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(only(r)).toEqual([["UNMATCHED_OVER_BUDGET", null, 21, 15]]);
    expect(r.outcome.violations[0]!.details!.b_candidates).toEqual([{ unit: K("legacyA"), line: 1, cognitive: 22 }]);
    expect(r.outcome.observe.unmatched_over_budget).toBe(1);
  });

  it("an untouched legacy unit in a changed file never fails and fires no S5", () => {
    const b = ifChain("small", 2) + ifChain("legacy", 30);
    const c = b.replace("y += 1;", "y += 100;");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers.filter((t) => t.id === "S5")).toEqual([]);
    expect(r.outcome.observe.legacy_debt.map((o) => o.unit)).toEqual([K("legacy")]);
  });
});

describe("spec 14 policy rows", () => {
  it("a nested callback over the limit fails on its own", () => {
    const body = Array.from({ length: 16 }, (_, i) => `    if (v === ${i}) n++;`).join("\n");
    const c = `export function outer(xs) {\n  return xs.map((v) => {\n    let n = 0;\n${body}\n    return n;\n  });\n}\n`;
    const r = runScenario({ b: {}, c: { [F]: c } });
    expect(violationReasons(r)).toEqual([`${F}::outer>${"<anonymous>"}#arrow[0]:OVER_LIMIT_NEW`]);
    expect(triggerIds(r)).toContain("S2"); // anonymous child CogC 16 ≥ 8
  });

  it("logic at module level, in static {} or a field initializer is judged as <module>", () => {
    const ifs = Array.from({ length: 16 }, (_, i) => `if (cfg.k === ${i}) out.push(${i});`).join("\n");
    for (const c of [
      `const cfg = globalThis.cfg; const out = [];\n${ifs}\n`,
      `const cfg = globalThis.cfg; const out = [];\nclass X { static {\n${ifs}\n} }\n`,
      `const cfg = globalThis.cfg;\nclass Y { v = ${Array.from({ length: 16 }, (_, i) => `cfg.k === ${i} ? ${i} :`).join(" ")} -1; }\n`,
    ]) {
      const r = runScenario({ b: {}, c: { [F]: c } });
      expect(violationReasons(r)).toEqual([`${F}::<module>:OVER_LIMIT_NEW`]);
    }
  });

  it("CC ≥ 20 with CogC ≤ 15 passes and is observed", () => {
    const cases = Array.from({ length: 22 }, (_, i) => `    case ${i}: return ${i};`).join("\n");
    const c = `export function dispatch(x) {\n  switch (x) {\n${cases}\n    default: return -1;\n  }\n}\n`;
    const r = runScenario({ b: {}, c: { [F]: c } });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.observe.cc_ge_20).toEqual([{ unit: K("dispatch"), line: 1, cognitive: 1, cyclomatic: 23 }]);
  });

  it("test files are measured but only observed", () => {
    const T = "src/plan.test.js";
    const r = runScenario({ b: {}, c: { [T]: ifChain("helper", 20) }, tests: [T] });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.observe.test_file_violations.map((v) => v.reason)).toEqual(["OVER_LIMIT_NEW"]);
    const enforced = runScenario({ b: {}, c: { [T]: ifChain("helper", 20) }, tests: [T], policy: { complexity: { enforce_on_tests: true } } });
    expect(enforced.outcome.violations).toHaveLength(1);
  });

  it("observe-only test files fire no triggers (a new spec file is all tiny callbacks)", () => {
    const T = "src/plan.test.js";
    const spec = `describe("plan", () => {\n${Array.from({ length: 6 }, (_, i) => `  it("case ${i}", () => { expect(${i}).toBe(${i}); });`).join("\n")}\n});\n`;
    const heavy = `describe("plan", () => {\n${Array.from({ length: 9 }, (_, i) => `  it("case ${i}", () => { if (globalThis.k === ${i}) throw 1; });`).join("\n")}\n});\n`;
    expect(triggerIds(runScenario({ b: {}, c: { [T]: spec }, tests: [T] }))).toEqual([]);
    expect(triggerIds(runScenario({ b: {}, c: { [T]: heavy }, tests: [T] }))).toEqual([]);
    expect(triggerIds(runScenario({ b: {}, c: { [T]: heavy } }))).toEqual(["S10"]);
  });

  it("the limit comes from the policy", () => {
    const r = runScenario({ b: {}, c: { [F]: ifChain("f", 13) }, policy: { complexity: { cognitive_limit: 12, near_limit_low: 10 } } });
    expect(only(r)).toEqual([["OVER_LIMIT_NEW", null, 13, 12]]);
  });
});

describe("triggers", () => {
  it("S8: new units in [12, 15] are observed, not routed", () => {
    const r = runScenario({ b: {}, c: { [F]: ifChain("f", 13) } });
    const s8 = r.outcome.triggers.filter((t) => t.id === "S8");
    expect(s8.map((t) => [t.unit, t.routing])).toEqual([[K("f"), false]]);
    expect(r.outcome.observe.s8_near_limit).toHaveLength(1);
  });

  it("S2: own CogC within the limit but inclusive CogC above 25", () => {
    const child = (n: number, name: string) => ifChain(name, n, "  ");
    const c = `export function host(x) {\n${child(14, "p")}${child(13, "q")}  return p(x) + q(x);\n}\n`;
    const r = runScenario({ b: {}, c: { [F]: c } });
    const s2 = r.outcome.triggers.filter((t) => t.id === "S2");
    expect(s2.map((t) => t.unit)).toEqual([K("host")]);
    expect(s2[0]!.evidence).toBe("src/plan.js::host: 자기 CogC 0, 포함 CogC 27 > 25");
  });

  it("S1: redistribution of a sub-limit unit into helpers (no S5: B ≤ 15)", () => {
    const b = ifChain("calc", 14);
    const helpers = Array.from({ length: 7 }, (_, i) => `function h${i}(x) {\n  let y = 0;\n  if (x === ${2 * i}) y += ${2 * i};\n  if (x === ${2 * i + 1}) y += ${2 * i + 1};\n  return y;\n}\n`).join("");
    const c = helpers + `function calc(x) {\n  return ${Array.from({ length: 7 }, (_, i) => `h${i}(x)`).join(" + ")};\n}\n`;
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(triggerIds(r)).toEqual(["S1"]);
    expect(r.outcome.triggers.find((t) => t.id === "S1")!.evidence).toBe("V 14→14, 단위 1→8, 최대 CogC 14→2");
  });

  it("S1 PR-wide: moving branches into new files is caught across the file set", () => {
    const b = ifChain("calc", 14);
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) {
      files[`src/h${i}.js`] = `export function h${i}(x) {\n  let y = 0;\n  if (x === ${2 * i}) y += ${2 * i};\n  if (x === ${2 * i + 1}) y += ${2 * i + 1};\n  return y;\n}\n`;
    }
    files[F] = `export function calc(x) {\n  return h0(x);\n}\n`;
    const r = runScenario({ b: { [F]: b }, c: files });
    const s1 = r.outcome.triggers.filter((t) => t.id === "S1");
    expect(s1).toHaveLength(1);
    expect(s1[0]!.file).toBeUndefined();
    expect(s1[0]!.evidence).toBe("PR 전체: V 14→14, 단위 1→8, 최대 CogC 14→2");
  });

  it("S9: branches vanish while the file keeps its size", () => {
    const b = ifChain("f", 10);
    const c = b.replace(/if \(x === (\d+)\) y \+= \d+;/g, "y += +(x === $1) * $1;");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    const s9 = r.outcome.triggers.find((t) => t.id === "S9")!;
    expect(s9.evidence).toBe("V 10→0 (−100%), 행 14→14 (−0%, 비정규화 행 수), 분기 밀도 0.71→0.00");
    const normalized = runScenario({ b: { [F]: b }, c: { [F]: c }, normalizedLines: new Map([[F, { B: 14, C: 14 }]]) });
    expect(normalized.outcome.triggers.find((t) => t.id === "S9")!.evidence).not.toMatch(/비정규화/);
  });

  it("S9 (D20): a drop of 1 never fires; 2 fires on the line path only when lines are kept", () => {
    expect(triggerIds(runScenario({ b: { [F]: ifChain("f", 3) }, c: { [F]: ifChain("f", 2) } }))).not.toContain("S9");
    // Audit F2 repro: V 3 → 1 with the line count unchanged.
    const b = `export function f(o) {\n  let t = 0;\n  if (o.a) t += 1;\n  if (o.b) t += 2;\n  if (o.c) t += 3;\n  return t;\n}\n`;
    const c = `export function f(o) {\n  let t = 0;\n  if (o.a) t += 1;\n  t += Math.min(1, o.b) * 2;\n  t += Math.min(1, o.c) * 3;\n  return t;\n}\n`;
    expect(triggerIds(runScenario({ b: { [F]: b }, c: { [F]: c } }))).toContain("S9");
    // The same drop of 2 while the file shrinks is an ordinary deletion.
    const shrunk = runScenario({ b: { [F]: ifChain("f", 4) }, c: { [F]: ifChain("f", 2) }, normalizedLines: new Map([[F, { B: 20, C: 6 }]]) });
    expect(triggerIds(shrunk)).not.toContain("S9");
  });

  it("S10: many new tiny units relative to total CogC, in a file with V ≥ 8 (D17)", () => {
    const c = Array.from({ length: 8 }, (_, i) => `export function step${i}(ctx) {\n  if (ctx.k === ${i}) ctx.v += ${i};\n}\n`).join("");
    const r = runScenario({ b: {}, c: { [F]: c } });
    expect(r.outcome.triggers.find((t) => t.id === "S10")!.evidence).toBe("단위 8 / (ΣCogC 8 + 1) = 0.89 ≥ 0.6, 새 단위 8, V 8");
    const glue = Array.from({ length: 6 }, (_, i) => `export function step${i}(ctx) {\n  ctx.v += ${i};\n}\n`).join("");
    expect(triggerIds(runScenario({ b: {}, c: { [F]: glue } }))).not.toContain("S10");
  });

  it("S11: unmeasured entries, new files in excluded paths, sensitive paths", () => {
    const extra: ManifestEntry[] = [
      { status: "A", b: null, c: { path: "src/App.vue", blob: "x", mode: "100644", measuredPath: "src/App.vue" }, measure: { B: false, C: false }, unmeasured: "UNSUPPORTED_FORMAT" },
      { status: "A", b: null, c: { path: "vendor/x.js", blob: "y", mode: "100644", measuredPath: "vendor/x.js" }, measure: { B: false, C: false }, excluded: "POLICY_EXCLUDE", newInExcludedPath: true },
    ];
    const r = runScenario({ b: {}, c: { [F]: ifChain("f", 1) }, extraEntries: extra, sensitivePathsChanged: [".gitattributes"] });
    expect(r.outcome.triggers.filter((t) => t.id === "S11").map((t) => t.evidence)).toEqual([
      "미측정: UNSUPPORTED_FORMAT (A)",
      "제외 경로의 신규 파일",
      "민감 경로 변경: .gitattributes",
    ]);
  });

  it("S11 unit vanish; UNITS_VANISHED is left to measure.ts (bug #11)", () => {
    const fns = Array.from({ length: 5 }, (_, i) => ifChain(`f${i}`, 2)).join("");
    const strings = Array.from({ length: 5 }, (_, i) =>
      `export const f${i} = new Function("x", ${JSON.stringify(ifChain("g", 2).split("\n").slice(1, -2).join("\n"))});`,
    ).join("\n");
    const pad = "\n".repeat(Math.max(0, fns.split("\n").length - strings.split("\n").length));
    const r = runScenario({ b: { [F]: fns }, c: { [F]: strings + pad } });
    expect(r.outcome.triggers.filter((t) => t.id === "S11")).toHaveLength(5);
    expect(r.outcome.inconclusive).toEqual([]);
  });
});
