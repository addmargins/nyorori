// Round-2 regressions: audit-spec F1/F3/F4/F11, audit-bugs #1/#8/#9 and
// rulings D5/D18/D21a, ported from the reviewers' reproductions.

import { describe, expect, it } from "vitest";
import type { CcccFile, FileMeasurement, Manifest, ManifestEntry } from "../../src/types.js";
import { buildFileMeasurement, countableUnits, escapeKeyPart, unitKey } from "../../src/units/model.js";
import { matchUnits } from "../../src/units/match.js";
import { ifChain, runScenario, triggerIds, violationReasons } from "./helpers.js";

const method = (name: string, n: number) =>
  `  ${name}(x) {\n    let y = 0;\n${Array.from({ length: n }, (_, i) => `    if (x === ${i}) y += ${i};`).join("\n")}\n    return y;\n  }\n`;

describe("F1 / bug #1: unit keys cannot collide through string-literal names", () => {
  it("escapes key separators but keeps identifiers and <anonymous> readable", () => {
    expect(escapeKeyPart("applyDiscount")).toBe("applyDiscount");
    expect(escapeKeyPart("<anonymous>")).toBe("<anonymous>");
    expect(escapeKeyPart("g>f")).toBe("g%3Ef");
    expect(escapeKeyPart("a::b#c[0]%")).toBe("a%3A%3Ab%23c%5B0%5D%25");
    expect(unitKey("src/a.ts", ["g", "f"], "method", 0)).not.toBe(unitKey("src/a.ts", ["g>f"], "method", 0));
  });

  it('a new method named "g>f" does not inherit g>f\'s legacy allowance (audit-spec repro)', () => {
    const legacy = `export function g(x) {\n  return {\n${method("f", 20)}  };\n}\n`;
    const r = runScenario({ b: { "src/a.ts": legacy }, c: { "src/a.ts": legacy + `export class K {\n${method('"g>f"', 20)}}\n` } });
    expect(violationReasons(r)).toEqual(["src/a.ts::g%3Ef#method[0]:OVER_LIMIT_NEW"]);
  });

  it('a new arrow named "outer>big" does not inherit outer>big (audit-bugs repro)', () => {
    const body = `(a: number, b: number, c: number) => {
    if (a) { if (b) { if (c) { for (;;) { if (a && b || c) { while (a) { if (b) { return 1 } } } } } } }
    if (a) { if (b) { if (c) { for (;;) { if (a && b || c) { return 3 } } } } }
    return 2;
  }`;
    const B = `const outer = () => {\n  const big = ${body};\n  return big;\n};\n`;
    const C = B + `const o = {\n  "outer>big": ${body},\n};\n`;
    const r = runScenario({ b: { "a.ts": B }, c: { "a.ts": C } });
    expect(r.outcome.violations.map((v) => v.unit)).toEqual(["a.ts::outer%3Ebig#arrow[0]"]);
  });

  it("duplicate keys on one side are never matched (defensive)", () => {
    const file = (side: "B" | "C"): FileMeasurement => {
      const f = buildFileMeasurement(side, "x.ts", side, {
        path: "x.ts",
        cognitive: 40,
        cyclomatic: 3,
        functions: [
          { name: "f", kind: "function", line: 1, cognitive: 20, cyclomatic: 1 },
          { name: "g", kind: "function", line: 5, cognitive: 20, cyclomatic: 1 },
        ],
      } as CcccFile, 10);
      f.units[1]!.key = f.units[0]!.key; // simulate a collision the escaping missed
      return f;
    };
    const r = matchUnits({ manifest: manifestOf([entry("M", "x.ts")]), b: new Map([["x.ts", file("B")]]), c: new Map([["x.ts", file("C")]]), lineMaps: [] });
    expect(r.duplicateKeys).toEqual(["x.ts::f#function[0]"]);
    expect(r.matches.map((m) => m.cKey)).toEqual(["x.ts::<module>"]);
  });
});

describe("F4: a stage-4 move needs an identical body to skip S5", () => {
  const edited = ifChain("legacy", 24).replace(/x === (\d+)/g, (_, n: string) => `x !== ${Number(n) + 100}`);

  it("logic edited with equal scores: still matched, but identity-changed → S5", () => {
    const r = runScenario({ b: { "src/old.ts": ifChain("legacy", 24) }, c: { "src/new.ts": edited } });
    expect(r.match.matches.map((m) => [m.stage, m.identityChanged])).toEqual([[4, true]]);
    expect(r.outcome.violations).toEqual([]);
    expect(triggerIds(r)).toContain("S5");
  });

  it("verbatim move (comments and whitespace aside): no S5", () => {
    const moved = "// moved here\n" + ifChain("legacy", 24).replace("  let y = 0;", "  let   y = 0; /* same */");
    const r = runScenario({ b: { "src/old.ts": ifChain("legacy", 24) }, c: { "src/new.ts": moved } });
    expect(r.match.matches.map((m) => [m.stage, m.identityChanged])).toEqual([[4, false]]);
    expect(triggerIds(r)).not.toContain("S5");
  });

  it("without sources the move is identity-changed", () => {
    const r = runScenario({ b: { "src/old.ts": ifChain("legacy", 24) }, c: { "src/new.ts": ifChain("legacy", 24) }, noSourcesForMatch: true });
    expect(r.match.matches[0]!.identityChanged).toBe(true);
    expect(triggerIds(r)).toContain("S5");
  });
});

describe("F3: production code under a test glob", () => {
  it("a new non-test file under a test path routes S11", () => {
    const P = "src/__tests__/pricing.ts";
    const r = runScenario({ b: {}, c: { [P]: ifChain("price", 30) }, tests: [P] });
    expect(r.outcome.violations).toEqual([]);
    expect(r.outcome.triggers.filter((t) => t.routing).map((t) => [t.id, t.evidence])).toEqual([["S11", "테스트 경로의 비테스트 코드 (A)"]]);
  });

  it("real test files, test-support paths and edits of existing helpers do not", () => {
    const T = "src/__tests__/pricing.test.ts";
    expect(triggerIds(runScenario({ b: {}, c: { [T]: ifChain("t", 3) }, tests: [T] }))).toEqual([]);
    const F = "src/__tests__/fixtures/orders.ts";
    expect(triggerIds(runScenario({ b: {}, c: { [F]: ifChain("order", 3) }, tests: [F] }))).toEqual([]);
    const H = "test/helpers.ts";
    expect(triggerIds(runScenario({ b: { [H]: ifChain("h", 2) }, c: { [H]: ifChain("h", 3) }, tests: [H] }))).toEqual([]);
  });

  it("a rename from product code into a test path routes S11", () => {
    const r = runScenario({ b: { "src/pricing.ts": ifChain("price", 30) }, c: { "test/pricing.ts": ifChain("price", 30) }, renames: { "test/pricing.ts": "src/pricing.ts" }, tests: ["test/pricing.ts"] });
    expect(r.outcome.triggers.some((t) => t.id === "S11" && t.file === "test/pricing.ts")).toBe(true);
  });
});

describe("F11 / bug #8: S2 coverage", () => {
  it("a top-level anonymous callback with CogC ≥ 8 fires S2 (audit-spec s2 repro)", () => {
    const body = Array.from({ length: 10 }, (_, i) => `  if (req.q === ${i}) res.n += ${i};`).join("\n");
    const r = runScenario({ b: {}, c: { "src/server.ts": `app.get("/", (req, res) => {\n${body}\n});\n` } });
    const s2 = r.outcome.triggers.filter((t) => t.id === "S2");
    expect(s2.map((t) => t.evidence)).toEqual(["익명 최상위 콜백 src/server.ts::<anonymous>#arrow[0] (행 1) CogC 10 ≥ 8"]);
  });

  it("growth through a deletion-only hunk fires S2 (audit-bugs repro)", () => {
    const B = `export function run(xs: number[], y: number) {\n  xs.forEach((x) => {\n    if (x) {}\n  }); xs.forEach((z) => {\n    if (y) { if (y) { if (y) { if (y) {} } } }\n  });\n}\n`;
    const C = `export function run(xs: number[], y: number) {\n  xs.forEach((x) => {\n    if (x) {}\n    if (y) { if (y) { if (y) { if (y) {} } } }\n  });\n}\n`;
    const r = runScenario({ b: { "a.ts": B }, c: { "a.ts": C } });
    expect(triggerIds(r)).toContain("S2");
  });
});

describe("S5 range edges (audit-spec s5 repro)", () => {
  const other = "function other(x) {\n  return x + 1;\n}\n";
  const added = "function added(x) {\n  return x * 2;\n}\n";
  const b = { "src/a.ts": ifChain("legacy", 24) + "\n" + other };
  for (const [label, c] of [
    ["insert between the legacy unit and the next", ifChain("legacy", 24) + "\n" + added + "\n" + other],
    ["edit the next unit", ifChain("legacy", 24) + "\n" + other.replace("x + 1", "x + 2")],
    ["append at EOF", ifChain("legacy", 24) + "\n" + other + "\n" + added],
  ] as const) {
    it(`${label}: no S5 on the untouched legacy unit`, () => {
      const r = runScenario({ b, c: { "src/a.ts": c } });
      expect(r.outcome.violations).toEqual([]);
      expect(triggerIds(r)).not.toContain("S5");
    });
  }
});

describe("D21a: normalized-identical files match by ordinal", () => {
  it("reformatting a file with ambiguous same-name units keeps every allowance without S5", () => {
    const cls = (name: string, n: number, ind: string) =>
      `${ind}class ${name} {\n${ifChain("run", n, ind + "  ").replace(/function run/, "run")}${ind}}\n`;
    const b = cls("A", 20, "") + cls("B", 18, "");
    const c = cls("A", 20, "  ") + cls("B", 18, "  ");
    const r = runScenario({ b: { "src/a.js": b }, c: { "src/a.js": c }, normalizedIdentical: ["src/a.js"] });
    expect(r.match.matches.filter((m) => m.stage === 1 && !m.identityChanged)).toHaveLength(3);
    expect(r.outcome.violations).toEqual([]);
    expect(triggerIds(r)).not.toContain("S5");
  });

  it("a differing unit sequence falls back to the normal stages", () => {
    const r = runScenario({ b: { "src/a.js": ifChain("f", 20) }, c: { "src/a.js": ifChain("f", 21) }, normalizedIdentical: ["src/a.js"] });
    expect(r.outcome.violations.map((v) => v.reason)).toEqual(["LEGACY_WORSENED"]);
  });
});

describe("D18: S12 residue shift", () => {
  const ifs = (n: number) => Array.from({ length: n }, (_, i) => `if (cfg.k === ${i}) out.push(${i});`).join("\n");
  it("a new file whose module-level logic outweighs its functions", () => {
    const r = runScenario({ b: {}, c: { "src/cfg.js": `const cfg = globalThis.cfg; const out = [];\n${ifs(9)}\n` } });
    expect(r.outcome.triggers.filter((t) => t.id === "S12").map((t) => t.evidence)).toEqual(["<module> residue 신규→9 (함수 CogC 합 0)"]);
  });

  it("an existing file needs a rise of ≥ 5; small residues and function-heavy files stay quiet", () => {
    const base = `const cfg = globalThis.cfg; const out = [];\n${ifs(8)}\n`;
    expect(triggerIds(runScenario({ b: { "src/cfg.js": base }, c: { "src/cfg.js": base + ifs(4) + "\n" } }))).not.toContain("S12");
    expect(triggerIds(runScenario({ b: { "src/cfg.js": base }, c: { "src/cfg.js": base + ifs(5) + "\n" } }))).toContain("S12");
    expect(triggerIds(runScenario({ b: {}, c: { "src/cfg.js": `const cfg = globalThis.cfg; const out = [];\n${ifs(7)}\n` } }))).not.toContain("S12");
    const heavy = `const cfg = globalThis.cfg; const out = [];\n${ifs(9)}\n${ifChain("f", 10)}`;
    expect(triggerIds(runScenario({ b: {}, c: { "src/cfg.js": heavy } }))).not.toContain("S12");
  });

  it("PR-wide: residue spread thin across files", () => {
    const c: Record<string, string> = {};
    const b: Record<string, string> = {};
    for (let i = 0; i < 4; i++) {
      b[`src/m${i}.js`] = `const cfg = globalThis.cfg; const out = [];\n${ifs(4)}\n${ifChain("f", 5)}`;
      c[`src/m${i}.js`] = `const cfg = globalThis.cfg; const out = [];\n${ifs(8)}\n${ifChain("f", 5)}`;
    }
    const r = runScenario({ b, c });
    const s12 = r.outcome.triggers.filter((t) => t.id === "S12");
    expect(s12).toHaveLength(1);
    expect(s12[0]!.file).toBeUndefined();
    expect(s12[0]!.evidence).toMatch(/^PR 전체 residue 증가 16 > 15/);
  });
});

describe("D5: foreign-language files", () => {
  const py: ManifestEntry = { status: "A", b: null, c: { path: "tools/price.py", blob: "p", mode: "100644", measuredPath: "tools/price.py" }, measure: { B: false, C: false }, unmeasured: "FOREIGN_LANGUAGE" };
  const s11 = (r: ReturnType<typeof runScenario>) => r.outcome.triggers.filter((t) => t.id === "S11").map((t) => t.routing);

  it("observe only when the measured JS/TS did not lose CogC", () => {
    expect(s11(runScenario({ b: {}, c: { "src/a.js": ifChain("f", 2) }, extraEntries: [py] }))).toEqual([false]);
  });
  it("routes when measured CogC drops or the AI loop authored the PR", () => {
    expect(s11(runScenario({ b: { "src/a.js": ifChain("f", 9) }, c: { "src/a.js": ifChain("f", 2) }, extraEntries: [py] }))).toEqual([true]);
    expect(s11(runScenario({ b: {}, c: { "src/a.js": ifChain("f", 2) }, extraEntries: [py], isAiLoop: true }))).toEqual([true]);
  });
  it("unsupported formats keep routing", () => {
    const vue: ManifestEntry = { ...py, c: { ...py.c!, path: "src/App.vue" }, unmeasured: "UNSUPPORTED_FORMAT" };
    expect(s11(runScenario({ b: {}, c: { "src/a.js": ifChain("f", 2) }, extraEntries: [vue] }))).toEqual([true]);
  });
});

describe("bug #9: matching scales linearly", () => {
  it("10k trivial units modified in place match in well under a second", () => {
    const N = 10_000;
    const fns = Array.from({ length: N }, (_, i) => ({ name: `op${i}`, kind: "function", line: i + 1, cognitive: 0, cyclomatic: 1 }));
    const file = { path: "gen.ts", cognitive: 0, cyclomatic: N, functions: fns } as CcccFile;
    const b = buildFileMeasurement("B", "gen.ts", "x", file, N);
    const c = buildFileMeasurement("C", "gen.ts", "y", file, N);
    const t0 = performance.now();
    expect(countableUnits(c)).toHaveLength(N);
    const r = matchUnits({
      manifest: manifestOf([entry("M", "gen.ts")]),
      b: new Map([["gen.ts", b]]),
      c: new Map([["gen.ts", c]]),
      lineMaps: [{ pathB: "gen.ts", pathC: "gen.ts", hunks: [{ bStart: 0, bCount: 0, cStart: 1, cCount: 0 }] }],
    });
    expect(r.matches).toHaveLength(N + 1);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("10k same-name overload rows are classified in linear time", () => {
    const N = 10_000;
    const fns = Array.from({ length: N }, (_, i) => ({ name: "f", kind: "function", line: i + 1, cognitive: 0, cyclomatic: 1 }));
    const m = buildFileMeasurement("C", "o.ts", "y", { path: "o.ts", cognitive: 0, cyclomatic: N, functions: fns } as CcccFile, N);
    const t0 = performance.now();
    expect(countableUnits(m)).toHaveLength(1); // only the implementation (last row) counts
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

function entry(status: "M", path: string): ManifestEntry {
  const side = (blob: string) => ({ path, blob, mode: "100644", measuredPath: path });
  return { status, b: side("x"), c: side("y"), measure: { B: true, C: true } };
}

function manifestOf(entries: ManifestEntry[]): Manifest {
  return { baseSha: "b", candidateSha: "c", problems: [], sensitivePathsChanged: [], entries };
}
