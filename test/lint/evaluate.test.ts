import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateLint, lintState } from "../../src/gates/lint/evaluate.js";
import { lintFiles } from "../../src/gates/lint/run.js";
import { defaultPolicy, type Policy } from "../../src/policy/schema.js";
import type { CcccFunction, FileLineMap, Hunk, Manifest, ManifestEntry, UnitMatch } from "../../src/types.js";
import { buildFileMeasurement } from "../../src/units/model.js";
import { writeTree } from "./helpers.js";

function hunks(a: string, b: string): Hunk[] {
  const dir = mkdtempSync(join(tmpdir(), "nyorori-diff-"));
  writeFileSync(join(dir, "a"), a);
  writeFileSync(join(dir, "b"), b);
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--no-index", "-U0", "a", "b"], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    out = (e as { stdout: string }).stdout; // exit 1 means "differs"
  }
  return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    bStart: Number(m[1]),
    bCount: m[2] === undefined ? 1 : Number(m[2]),
    cStart: Number(m[3]),
    cCount: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

interface Side {
  path: string;
  code: string;
  fns: CcccFunction[];
}

const fn = (name: string, line: number, extra: Partial<CcccFunction> = {}): CcccFunction => ({
  name,
  kind: "function",
  line,
  cognitive: 0,
  cyclomatic: 1,
  ...extra,
});

function measurement(side: "B" | "C", s: Side) {
  const total = (fs: CcccFunction[]): [number, number] =>
    fs.reduce<[number, number]>(
      (acc, f) => {
        const [c, y] = total(f.children ?? []);
        return [acc[0] + f.cognitive + c, acc[1] + f.cyclomatic + y];
      },
      [0, 0],
    );
  const [cog, cyc] = total(s.fns);
  return buildFileMeasurement(side, s.path, "blob", { path: s.path, cognitive: cog, cyclomatic: cyc, functions: s.fns }, s.code.split("\n").length);
}

async function runCase(opts: { b?: Side; c: Side; matches?: UnitMatch[]; policy?: Policy; measureC?: boolean }) {
  const policy = opts.policy ?? defaultPolicy();
  const { b, c } = opts;
  const side = (s: Side) => ({ path: s.path, blob: "x", mode: "100644", measuredPath: s.path });
  const entry: ManifestEntry = {
    status: b ? (b.path === c.path ? "M" : "R") : "A",
    b: b ? side(b) : null,
    c: side(c),
    measure: { B: !!b, C: true },
  };
  const manifest: Manifest = { baseSha: "B", candidateSha: "C", entries: [entry], problems: [], sensitivePathsChanged: [] };
  const lintB = b ? await lintFiles(writeTree({ [b.path]: b.code }), [b.path], policy) : new Map();
  const lintC = await lintFiles(writeTree({ [c.path]: c.code }), [c.path], policy);
  const lineMaps: FileLineMap[] = b ? [{ pathB: b.path, pathC: c.path, hunks: hunks(b.code, c.code) }] : [];
  const measurementsB = new Map(b ? [[b.path, measurement("B", b)]] : []);
  const measurementsC = new Map(opts.measureC === false ? [] : [[c.path, measurement("C", c)]]);
  const result = evaluateLint({
    manifest,
    lintB,
    lintC,
    measurementsB,
    measurementsC,
    matches: opts.matches ?? [],
    lineMaps,
    sourcesB: new Map(b ? [[b.path, b.code]] : []),
    sourcesC: new Map([[c.path, c.code]]),
    policy,
  });
  return { result, state: lintState(result, manifest.entries) };
}

const match = (bKey: string, cKey: string, stage: 1 | 2 | 3 | 4 = 1): UnitMatch => ({
  bKey,
  cKey,
  stage,
  identityChanged: stage === 2 || stage === 3,
});

describe("new-violation rule", () => {
  it("FAILs on new Function added under a base-branch /* eslint-disable */ (spec 14)", async () => {
    const b = { path: "src/a.ts", code: `/* eslint-disable */\nexport function f() {\n  return 1;\n}\n`, fns: [fn("f", 2)] };
    const c = {
      path: "src/a.ts",
      code: `/* eslint-disable */\nexport function f() {\n  return new Function("return 1")();\n}\n`,
      fns: [fn("f", 2)],
    };
    const { result, state } = await runCase({ b, c, matches: [match("src/a.ts::f#function[0]", "src/a.ts::f#function[0]")] });
    expect(state).toBe("FAIL");
    expect(result.violations.map((v) => v.reason)).toEqual(["DYNAMIC_CODE"]);
    expect(result.violations[0]!.unit).toBe("src/a.ts::f#function[0]");
  });

  it("FAILs when a fifth parameter is added on another line (reported at the function's first line)", async () => {
    const b = { path: "src/p.ts", code: `export function f(\n  a: number,\n  b: number,\n  c: number,\n  d: number,\n) {\n  return a + b + c + d;\n}\n`, fns: [fn("f", 1)] };
    const c = {
      path: "src/p.ts",
      code: `export function f(\n  a: number,\n  b: number,\n  c: number,\n  d: number,\n  e: number,\n) {\n  return a + b + c + d + e;\n}\n`,
      fns: [fn("f", 1)],
    };
    const { result, state } = await runCase({ b, c, matches: [match("src/p.ts::f#function[0]", "src/p.ts::f#function[0]")] });
    expect(state).toBe("FAIL");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ reason: "LINT_NEW_VIOLATION", metric: "@typescript-eslint/max-params", line: 1, before: 0, after: 1 });
  });

  const five = `export function f(a: number, b: number, c: number, d: number, e: number) {\n  return a + b + c + d + e;\n}\n`;

  it("does not fail an existing violation in an unrelated edit", async () => {
    const b = { path: "src/p.ts", code: five, fns: [fn("f", 1)] };
    const c = { path: "src/p.ts", code: `// header\n${five}export const x = 1;\n`, fns: [fn("f", 2)] };
    const { result, state } = await runCase({ b, c, matches: [match("src/p.ts::f#function[0]", "src/p.ts::f#function[0]")] });
    expect(result.violations).toEqual([]);
    expect(state).toBe("PASS");
  });

  it("follows unit matches across a rename", async () => {
    const b = { path: "src/old.ts", code: five, fns: [fn("f", 1)] };
    const c = { path: "src/new.ts", code: five, fns: [fn("f", 1)] };
    const { result } = await runCase({ b, c, matches: [match("src/old.ts::f#function[0]", "src/new.ts::f#function[0]", 4)] });
    expect(result.violations).toEqual([]);
  });

  it("a copy of a violating function is new (no shared allowance)", async () => {
    const b = { path: "src/p.ts", code: five, fns: [fn("f", 1)] };
    const c = {
      path: "src/p.ts",
      code: `${five}export function g(a: number, b: number, c: number, d: number, e: number) {\n  return a + b + c + d + e;\n}\n`,
      fns: [fn("f", 1), fn("g", 4)],
    };
    const { result } = await runCase({ b, c, matches: [match("src/p.ts::f#function[0]", "src/p.ts::f#function[0]")] });
    expect(result.violations.map((v) => v.unit)).toEqual(["src/p.ts::g#function[0]"]);
  });

  it("counts multiplicity within a unit", async () => {
    const b = { path: "src/d.ts", code: `export function f() {\n  return eval("1");\n}\n`, fns: [fn("f", 1)] };
    const c = { path: "src/d.ts", code: `export function f() {\n  eval("2");\n  return eval("1");\n}\n`, fns: [fn("f", 1)] };
    const { result } = await runCase({ b, c, matches: [match("src/d.ts::f#function[0]", "src/d.ts::f#function[0]")] });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ reason: "DYNAMIC_CODE", line: 2, before: 1, after: 2 });
  });

  it("an added file has no baseline", async () => {
    const c = { path: "src/n.ts", code: `export const f = (() => 0).constructor("return 1");\n`, fns: [fn("<anonymous>", 1, { kind: "arrow" })] };
    const { result } = await runCase({ c });
    expect(result.violations.map((v) => v.reason)).toEqual(["DYNAMIC_CODE"]);
  });

  it("falls back to file-level comparison when the candidate has no measurement", async () => {
    const b = { path: "src/p.ts", code: five, fns: [fn("f", 1)] };
    const c = { path: "src/p.ts", code: five, fns: [] };
    const { result } = await runCase({ b, c, measureC: false });
    expect(result.violations).toEqual([]);
  });
});

describe("suppressions and bidi", () => {
  it("FAILs on an added suppression but not on an existing one", async () => {
    const b = { path: "src/s.ts", code: `// @ts-ignore\nexport const a: number = "x";\n`, fns: [] };
    const c = { path: "src/s.ts", code: `// @ts-ignore\nexport const a: number = "x";\n// eslint-disable-next-line no-new-func\nconsole.log(a);\n`, fns: [] };
    const { result } = await runCase({ b, c });
    expect(result.violations.map((v) => [v.reason, v.line])).toEqual([["SUPPRESSION_ADDED", 3]]);
  });

  it("honours the policy allowlist", async () => {
    const policy = defaultPolicy({ lint: { suppression_allowlist: ["eslint-disable-next-line max-params"] } });
    const c = { path: "src/s.ts", code: `// eslint-disable-next-line max-params\nconsole.log(1);\n`, fns: [] };
    const { result } = await runCase({ c, policy });
    expect(result.violations).toEqual([]);
  });

  it("FAILs on an added bidi control character", async () => {
    const b = { path: "src/t.ts", code: `export const ok = true;\n`, fns: [] };
    const c = { path: "src/t.ts", code: `export const ok = true;\nexport const s = "admin\u202E \u2066// user\u2069";\n`, fns: [] };
    const { result } = await runCase({ b, c });
    expect(result.violations.map((v) => [v.reason, v.line, v.details?.codePoint])).toEqual([
      ["BIDI_CONTROL", 2, "U+202E"],
      ["BIDI_CONTROL", 2, "U+2066"],
      ["BIDI_CONTROL", 2, "U+2069"],
    ]);
  });

  it("does not fail bidi characters already on the base branch", async () => {
    const code = `export const s = "\u202E";\n`;
    const { result } = await runCase({ b: { path: "src/t.ts", code, fns: [] }, c: { path: "src/t.ts", code: `${code}export const y = 1;\n`, fns: [] } });
    expect(result.violations).toEqual([]);
  });
});

describe("triggers", () => {
  const longBody = (name: string) =>
    `export function ${name}() {\n  let x = 0;\n${Array.from({ length: 61 }, (_, i) => `  x += ${i};`).join("\n")}\n  return x;\n}\n`;

  it("S4 for a new long function, not for an unchanged existing one", async () => {
    const b = { path: "src/l.ts", code: longBody("old"), fns: [fn("old", 1)] };
    const c = { path: "src/l.ts", code: longBody("old") + longBody("fresh"), fns: [fn("old", 1), fn("fresh", 65)] };
    const { result, state } = await runCase({ b, c, matches: [match("src/l.ts::old#function[0]", "src/l.ts::old#function[0]")] });
    expect(result.triggers.filter((t) => t.id === "S4").map((t) => t.unit)).toEqual(["src/l.ts::fresh#function[0]"]);
    expect(state).toBe("PASS"); // triggers never fail G2
  });

  it("S4 for a re-declared (stage 2) long function", async () => {
    const b = { path: "src/l.ts", code: longBody("old"), fns: [fn("old", 1)] };
    const c = { path: "src/l.ts", code: longBody("renamed"), fns: [fn("renamed", 1)] };
    const { result } = await runCase({ b, c, matches: [match("src/l.ts::old#function[0]", "src/l.ts::renamed#function[0]", 2)] });
    expect(result.triggers.map((t) => t.id)).toEqual(["S4"]);
  });

  it("S9 for new branch hiding, not for pre-existing", async () => {
    const base = `declare function apply(): boolean;\nexport function f() {\n  let ok = true;\n  ok &&= apply();\n  return ok;\n}\n`;
    const b = { path: "src/h.ts", code: base, fns: [fn("f", 2)] };
    const same = await runCase({ b, c: { ...b }, matches: [match("src/h.ts::f#function[0]", "src/h.ts::f#function[0]")] });
    expect(same.result.triggers).toEqual([]);
    const c = { path: "src/h.ts", code: base.replace("return ok;", "ok &&= apply();\n  return ok;"), fns: [fn("f", 2)] };
    const more = await runCase({ b, c, matches: [match("src/h.ts::f#function[0]", "src/h.ts::f#function[0]")] });
    expect(more.result.triggers.map((t) => [t.id, t.routing])).toEqual([["S9", true]]);
  });

  it("S10 for ctx-mutating helpers (spec 7.2 b)", async () => {
    const c = {
      path: "src/b.ts",
      code: [
        "interface Ctx { total: number; vip: boolean }",
        "function applyVip(ctx: Ctx) { if (ctx.vip) ctx.total -= 10; }",
        "function applyFloor(ctx: Ctx) { if (ctx.total < 0) ctx.total = 0; }",
        "export function price(ctx: Ctx) { applyVip(ctx); applyFloor(ctx); return ctx.total; }",
        "",
      ].join("\n"),
      fns: [fn("applyVip", 2, { cognitive: 1, cyclomatic: 2 }), fn("applyFloor", 3, { cognitive: 1, cyclomatic: 2 }), fn("price", 4)],
    };
    const { result } = await runCase({ c });
    expect(result.triggers.filter((t) => t.id === "S10").map((t) => t.unit)).toEqual([
      "src/b.ts::applyVip#function[0]",
      "src/b.ts::applyFloor#function[0]",
    ]);
  });
});

describe("fail closed", () => {
  it("INCONCLUSIVE when the candidate cannot be parsed", async () => {
    const { result, state } = await runCase({ c: { path: "src/x.ts", code: "export const = ;", fns: [] } });
    expect(state).toBe("INCONCLUSIVE");
    expect(result.inconclusive[0]).toMatchObject({ reason: "PARSE_ERROR_CANDIDATE", authorFixable: true });
  });

  it("INCONCLUSIVE when a measured file has no lint result", () => {
    const entry: ManifestEntry = { status: "A", b: null, c: { path: "src/x.ts", blob: "x", mode: "100644", measuredPath: "src/x.ts" }, measure: { B: false, C: true } };
    const result = evaluateLint({
      manifest: { baseSha: "B", candidateSha: "C", entries: [entry], problems: [], sensitivePathsChanged: [] },
      lintB: new Map(),
      lintC: new Map(),
      measurementsB: new Map(),
      measurementsC: new Map(),
      matches: [],
      lineMaps: [],
      sourcesB: new Map(),
      sourcesC: new Map(),
      policy: defaultPolicy(),
    });
    expect(result.inconclusive.map((i) => i.reason)).toEqual(["REPORT_MISSING"]);
    expect(lintState(result, [entry])).toBe("INCONCLUSIVE");
  });

  it("NOT_APPLICABLE without measured candidate files", () => {
    const result = evaluateLint({
      manifest: { baseSha: "B", candidateSha: "C", entries: [], problems: [], sensitivePathsChanged: [] },
      lintB: new Map(),
      lintC: new Map(),
      measurementsB: new Map(),
      measurementsC: new Map(),
      matches: [],
      lineMaps: [],
      sourcesB: new Map(),
      sourcesC: new Map(),
      policy: defaultPolicy(),
    });
    expect(lintState(result, [])).toBe("NOT_APPLICABLE");
  });
});
