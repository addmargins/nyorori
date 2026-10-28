// Spec 5.4 unit correspondence on real cccc output: allowances are inherited
// only through a fixed line, a 1:1 hunk edit, a unique name, or a verbatim
// cross-file move; everything else is new.

import { describe, expect, it } from "vitest";
import { checkName, skeleton } from "../../src/units/names.js";
import { mapLine } from "../../src/git/linemap.js";
import { ifChain, runScenario, violationReasons, type ScenarioResult } from "./helpers.js";

const stageOf = (r: ScenarioResult, cKey: string) => r.match.byC.get(cKey)?.stage;
const F = "src/a.js";

describe("names", () => {
  it("normalizes full-width forms with NFKC and flags look-alikes", () => {
    expect(checkName("ａｐｐｌｙ").normalized).toBe("apply");
    expect(checkName("ａｐｐｌｙ").suspicious).toBe(false);
    const cyr = checkName("аpply"); // Cyrillic а
    expect(cyr.suspicious).toBe(true);
    expect(cyr.warning).toMatch(/mixed scripts/);
    expect(skeleton("аpply")).toBe("apply");
    expect(checkName("приём").suspicious).toBe(true); // all-Cyrillic but contains look-alikes
    expect(checkName("run​").suspicious).toBe(true);
    expect(checkName("価格").suspicious).toBe(false);
  });
});

describe("line map", () => {
  it("maps unchanged lines across insertions and deletions", () => {
    const hunks = { hunks: [
      { bStart: 2, bCount: 0, cStart: 3, cCount: 2 }, // insert 2 lines after B line 2
      { bStart: 5, bCount: 1, cStart: 7, cCount: 1 }, // modify B line 5
      { bStart: 8, bCount: 2, cStart: 9, cCount: 0 }, // delete B lines 8-9
    ] };
    expect(mapLine(hunks, 1)).toBe(1);
    expect(mapLine(hunks, 2)).toBe(2);
    expect(mapLine(hunks, 3)).toBe(5);
    expect(mapLine(hunks, 5)).toBeUndefined();
    expect(mapLine(hunks, 6)).toBe(8);
    expect(mapLine(hunks, 9)).toBeUndefined();
    expect(mapLine(hunks, 10)).toBe(10);
  });
});

describe("matchUnits", () => {
  it("stage 1: a line shift keeps the legacy allowance and fires no S5", () => {
    const b = ifChain("small", 2) + ifChain("legacy", 20);
    const c = "// header\n// more\n" + b;
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(stageOf(r, `${F}::legacy#function[0]`)).toBe(1);
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers.filter((t) => t.id === "S5")).toEqual([]);
  });

  it("stage 2: in-place rename / signature change keeps the allowance but is identity-changed (S5)", () => {
    const b = ifChain("legacy", 20);
    const c = b.replace("function legacy(x)", "function renamed(x, opts)");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    const m = r.match.byC.get(`${F}::renamed#function[0]`)!;
    expect([m.stage, m.identityChanged]).toEqual([2, true]);
    expect(r.outcome.violations).toEqual([]);
    const s5 = r.outcome.triggers.find((t) => t.id === "S5")!;
    expect(s5.evidence).toMatch(/identity-changed/);
  });

  it("stage 3: reordering functions matches unique names", () => {
    const b = ifChain("first", 3) + ifChain("legacy", 18);
    const c = ifChain("legacy", 18) + ifChain("first", 3);
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(stageOf(r, `${F}::legacy#function[0]`)).toBeOneOf([1, 3]);
    expect(stageOf(r, `${F}::first#function[0]`)).toBeOneOf([1, 3]);
    expect(r.match.matches.some((m) => m.stage === 3)).toBe(true);
    expect(r.outcome.violations).toEqual([]);
  });

  it("stage 4: a verbatim move to a new file keeps the allowance", () => {
    const keep = ifChain("keep", 2);
    const legacy = ifChain("legacy", 20);
    const r = runScenario({
      b: { [F]: keep + legacy },
      c: { [F]: keep, "src/legacy.js": legacy },
    });
    const m = r.match.byC.get("src/legacy.js::legacy#function[0]")!;
    expect(m.stage).toBe(4);
    expect(r.outcome.violations).toEqual([]);
  });

  it("stage 4 refuses a move whose score changed", () => {
    const keep = ifChain("keep", 2);
    const r = runScenario({
      b: { [F]: keep + ifChain("legacy", 20) },
      c: { [F]: keep, "src/legacy.js": ifChain("legacy", 19) },
    });
    expect(r.match.byC.has("src/legacy.js::legacy#function[0]")).toBe(false);
    expect(violationReasons(r)).toEqual(["src/legacy.js::legacy#function[0]:UNMATCHED_OVER_BUDGET"]);
  });

  it("duplicating legacy debt: the copy gets the new-unit limit", () => {
    const legacy = ifChain("legacy", 20);
    const r = runScenario({
      b: { [F]: legacy },
      c: { [F]: legacy, "src/copy.js": legacy },
    });
    expect(stageOf(r, `${F}::legacy#function[0]`)).toBe(1);
    expect(violationReasons(r)).toEqual(["src/copy.js::legacy#function[0]:OVER_LIMIT_NEW"]);
  });

  it("a copied file (status C) never inherits", () => {
    const legacy = ifChain("legacy", 20);
    const r = runScenario({ b: { [F]: legacy }, c: { [F]: legacy, "src/b.js": legacy }, copies: { "src/b.js": F } });
    expect(violationReasons(r)).toEqual(["src/b.js::legacy#function[0]:OVER_LIMIT_NEW"]);
  });

  it("D21b: a k-to-k group of same-name methods in one hunk pairs by CogC and is identity-changed", () => {
    // One class per line, so editing both lines yields one hunk holding two `run` methods.
    const cls = (name: string, n: number) =>
      `class ${name} { run(x) { let y = 0; ${Array.from({ length: n }, (_, i) => `if (x === ${i}) y++;`).join(" ")} return y; } }`;
    const b = `${cls("A", 20)}\n${cls("B", 18)}\n`;
    const improved = runScenario({ b: { [F]: b }, c: { [F]: `${cls("A2", 19)}\n${cls("B2", 17)}\n` } });
    expect(improved.match.matches.filter((m) => !m.cKey.endsWith("<module>")).map((m) => [m.stage, m.identityChanged])).toEqual([
      [3, true],
      [3, true],
    ]);
    expect(improved.outcome.violations).toEqual([]);
    expect(improved.outcome.triggers.filter((t) => t.id === "S5")).toHaveLength(2);

    // One C unit above every paired allowance: nothing is guessed.
    const worse = runScenario({ b: { [F]: b }, c: { [F]: `${cls("A2", 21)}\n${cls("B2", 17)}\n` } });
    expect(worse.match.matches.filter((m) => !m.cKey.endsWith("<module>"))).toEqual([]);
    expect(violationReasons(worse).sort()).toEqual([
      `${F}::run#method[0]:UNMATCHED_OVER_BUDGET`,
      `${F}::run#method[1]:UNMATCHED_OVER_BUDGET`,
    ]);
    expect(worse.outcome.violations[0]!.details!.b_candidates as unknown[]).toHaveLength(2);
  });

  it("same-name methods in separate hunks are matched 1:1 per hunk (stage 2)", () => {
    const cls = (name: string, n: number) =>
      `class ${name} {\n${ifChain("run", n, "  ").replace(/function run/, "run")}}\n`;
    const b = cls("A", 20) + "\n// spacer\n" + cls("B", 18);
    const c = b.replace("class A {\n  run(x)", "class A {\n  run(x, y0)").replace("class B {\n  run(x)", "class B {\n  run(x, y1)");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(r.match.matches.filter((m) => m.stage === 2)).toHaveLength(2);
    expect(r.outcome.violations).toEqual([]);
  });

  it("same-line anonymous functions: line ordinal when untouched, never k-to-k when the line is edited (D21b reversed)", () => {
    const body = ifChain("x", 17).split("\n").slice(2, -3).join("\n");
    const b = `export const pair = [(x) => x, (x) => {\n  let y = 0;\n${body}\n  return y;\n}];\n`;
    const r = runScenario({ b: { [F]: b }, c: { [F]: "// moved down\n" + b } });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers.filter((t) => t.id === "S5")).toEqual([]);
    // Spec 5.4 step 3 excludes anonymous units from name-based matching: once the
    // declaration line is edited, the legacy callback is ambiguous and the 17 is
    // unmatched (differential test m16b: a new 18 inherited a legacy 18 via k-to-k).
    const edited = runScenario({ b: { [F]: b }, c: { [F]: b.replace("(x) => x,", "(x) => x + 0,") } });
    expect(edited.match.matches.filter((m) => !m.cKey.endsWith("<module>"))).toEqual([]);
    expect(violationReasons(edited)).toEqual([`${F}::<anonymous>#arrow[1]:UNMATCHED_OVER_BUDGET`]);
    expect(edited.outcome.violations[0]!.details!.b_candidates).toEqual([{ unit: `${F}::<anonymous>#arrow[1]`, line: 1, cognitive: 17 }]);
    const grown = runScenario({ b: { [F]: b }, c: { [F]: b.replace("(x) => x,", "(x) => x + 0,").replace("y += 0;", "y += 0; if (x) y++;") } });
    expect(violationReasons(grown)).toEqual([`${F}::<anonymous>#arrow[1]:UNMATCHED_OVER_BUDGET`]);
  });

  it("overload signatures shift without stealing the implementation's allowance", () => {
    const impl = ifChain("f", 20).replace("function f(x)", "export function f(x: any): any");
    const b = "export function f(x: string): string;\nexport function f(x: number): number;\n" + impl;
    const c = "export function f(x: boolean): boolean;\n" + b;
    const P = "src/a.ts";
    const r = runScenario({ b: { [P]: b }, c: { [P]: c } });
    expect(r.outcome.violations).toEqual([]);
    expect(stageOf(r, `${P}::f#function[3]`)).toBe(1);
  });

  it("a rename onto a Cyrillic look-alike is treated as new, with a warning", () => {
    const b = ifChain("apply", 20);
    const c = b.replace("function apply", "function аpply");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(r.match.matches.filter((m) => !m.cKey.endsWith("<module>"))).toEqual([]);
    expect(r.outcome.violations.map((v) => v.reason)).toEqual(["UNMATCHED_OVER_BUDGET"]);
    expect(r.outcome.observe.name_warnings[0]!.warning).toMatch(/mixed scripts/);
  });

  it("a look-alike name never matches by unique name or verbatim move", () => {
    const legacy = ifChain("apply", 20);
    const r = runScenario({
      b: { [F]: ifChain("keep", 1) + legacy },
      c: { [F]: ifChain("keep", 1), "src/x.js": legacy.replace("apply", "аpply") },
    });
    expect(violationReasons(r)).toEqual(["src/x.js::аpply#function[0]:OVER_LIMIT_NEW"]);
  });

  it("body replaced, declaration untouched: matched at stage 1 but S5 fires on the range", () => {
    const b = ifChain("process", 20);
    const lines = b.split("\n");
    const c = [lines[0], "  let y = 1;", ...Array.from({ length: 19 }, (_, i) => `  if (x > ${i}) y *= 2;`), "  return y;", "}", ""].join("\n");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    expect(stageOf(r, `${F}::process#function[0]`)).toBe(1);
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers.some((t) => t.id === "S5" && t.unit === `${F}::process#function[0]`)).toBe(true);
  });

  it("B parse error: every C unit is new and no B unit is offered as an origin", () => {
    const b = ifChain("legacy", 20);
    const c = b.replace("y += 0;", "y += 0; // edited");
    const r = runScenario({ b: { [F]: b }, c: { [F]: c }, baselineMissing: [F] });
    expect(r.match.matches).toEqual([]);
    expect(violationReasons(r)).toEqual([`${F}::legacy#function[0]:OVER_LIMIT_NEW`]);
  });

  it("children are only matched under matched parents", () => {
    const inner = (n: number) => ifChain("inner", n, "  ");
    const b = `function outer(x) {\n${inner(18)}  return inner(x);\n}\n`;
    const c = `function outer2(x) {\n  const k = 1;\n${inner(18)}  return inner(x) + k;\n}\n` + "\n".repeat(0);
    const r = runScenario({ b: { [F]: b }, c: { [F]: c } });
    // outer → outer2 is a stage-2 rename; inner keeps its line → stage 1 under the matched parent.
    expect(stageOf(r, `${F}::outer2#function[0]`)).toBe(2);
    expect(stageOf(r, `${F}::outer2>inner#function[0]`)).toBe(1);
    expect(r.outcome.violations).toEqual([]);
  });
});
