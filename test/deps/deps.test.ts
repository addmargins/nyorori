import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findNewCycles, stronglyConnectedComponents, adjacency } from "../../src/gates/deps/cycles.js";
import { depsState, evaluateDeps } from "../../src/gates/deps/evaluate.js";
import { aliasesFromPaths } from "../../src/gates/deps/aliases.js";
import { defaultPolicy, type Policy } from "../../src/policy/schema.js";
import { writeTree } from "../lint/helpers.js";

async function run(
  b: Record<string, string>,
  c: Record<string, string>,
  opts: { policy?: Policy; renames?: Map<string, string>; changed?: string[] } = {},
) {
  const code = (t: Record<string, string>) => Object.keys(t).filter((p) => /\.(c|m)?[jt]sx?$/.test(p));
  const result = await evaluateDeps({
    treeB: writeTree(b),
    treeC: writeTree(c),
    filesB: code(b),
    filesC: code(c),
    policy: opts.policy ?? defaultPolicy(),
    changedPaths: opts.changed ?? [],
    renames: opts.renames,
  });
  return { result, state: depsState(result, code(c)) };
}

describe("new cycles", () => {
  const a = `import { b } from "./b";\nexport const a = () => b;\n`;
  const bBack = `import { a } from "./a";\nexport const b = () => a;\n`;

  it("FAILs when an import closes a new cycle", async () => {
    const { result, state } = await run(
      { "src/a.ts": a, "src/b.ts": `export const b = 1;\n` },
      { "src/a.ts": a, "src/b.ts": bBack },
    );
    expect(state).toBe("FAIL");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ reason: "DEP_NEW_CYCLE", file: "src/b.ts" });
    expect(result.violations[0]!.details?.witness).toEqual(["src/b.ts", "src/a.ts", "src/b.ts"]);
  });

  it("does not fail an existing cycle", async () => {
    const tree = { "src/a.ts": a, "src/b.ts": bBack };
    const { state } = await run(tree, { ...tree, "src/b.ts": `${bBack}export const extra = 1;\n` });
    expect(state).toBe("PASS");
  });

  it("follows renames", async () => {
    const { state } = await run(
      { "src/a.ts": a, "src/b.ts": bBack },
      { "src/a.ts": `import { b } from "./c";\nexport const a = () => b;\n`, "src/c.ts": bBack },
      { renames: new Map([["src/c.ts", "src/b.ts"]]) },
    );
    expect(state).toBe("PASS");
  });

  it("FAILs when a new module joins an existing cycle", async () => {
    const { result } = await run(
      { "src/a.ts": a, "src/b.ts": bBack },
      {
        "src/a.ts": `import { b } from "./b";\nimport { c } from "./c";\nexport const a = () => b + c;\n`,
        "src/b.ts": bBack,
        "src/c.ts": `import { a } from "./a";\nexport const c = () => a;\n`,
      },
    );
    expect(result.violations.map((v) => v.details?.members)).toEqual([["src/a.ts", "src/b.ts", "src/c.ts"]]);
  });

  it("FAILs on a new edge inside an existing tangle", async () => {
    const tree = {
      "src/a.ts": `import "./b";\n`,
      "src/b.ts": `import "./c";\n`,
      "src/c.ts": `import "./a";\n`,
    };
    const { result } = await run(tree, { ...tree, "src/c.ts": `import "./a";\nimport "./b";\n` });
    expect(result.violations[0]!.details?.new_edges).toEqual([{ from: "src/c.ts", to: "src/b.ts" }]);
  });

  it("FAILs on a self import", async () => {
    const { result } = await run({ "src/s.ts": `export const s = 1;\n` }, { "src/s.ts": `import "./s";\nexport const s = 1;\n` });
    expect(result.violations[0]!.details?.witness).toEqual(["src/s.ts", "src/s.ts"]);
  });

  it("detects require() cycles in CommonJS", async () => {
    const { state } = await run(
      { "lib/x.cjs": `module.exports = 1;\n`, "lib/y.cjs": `require("./x.cjs");\n` },
      { "lib/x.cjs": `require("./y.cjs");\nmodule.exports = 1;\n`, "lib/y.cjs": `require("./x.cjs");\n` },
    );
    expect(state).toBe("FAIL");
  });

  it("resolves .js specifiers to .ts sources", async () => {
    const { state } = await run(
      { "src/a.ts": `import "./b.js";\n`, "src/b.ts": `export {};\n` },
      { "src/a.ts": `import "./b.js";\n`, "src/b.ts": `import "./a.js";\n` },
    );
    expect(state).toBe("FAIL");
  });

  it("does not block type-only cycles but records them", async () => {
    const { result, state } = await run(
      { "src/a.ts": `import type { B } from "./b";\nexport type A = B;\n`, "src/b.ts": `export type B = 1;\n` },
      { "src/a.ts": `import type { B } from "./b";\nexport type A = B;\n`, "src/b.ts": `import type { A } from "./a";\nexport type B = A | 1;\n` },
    );
    expect(state).toBe("PASS");
    expect(result.observe.new_type_only_cycle_edges).toBe(1);
  });

  it("does not block cycles closed only by a lazy import()", async () => {
    const { state } = await run(
      { "src/a.ts": a, "src/b.ts": `export const b = 1;\n` },
      { "src/a.ts": a, "src/b.ts": `export const b = () => import("./a");\n` },
    );
    expect(state).toBe("PASS");
  });

  it("resolves tsconfig path aliases", async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    const { state } = await run(
      { "tsconfig.json": tsconfig, "src/a.ts": `import "@/b";\n`, "src/b.ts": `export {};\n` },
      { "tsconfig.json": tsconfig, "src/a.ts": `import "@/b";\n`, "src/b.ts": `import "@/a";\n` },
    );
    expect(state).toBe("FAIL");
  });

  it("never loads a dependency-cruiser config from the tree", async () => {
    const marker = join(writeTree({}), "MARKER");
    const evil = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); module.exports = {};\n`;
    await run(
      { "src/a.ts": `export {};\n` },
      { ".dependency-cruiser.cjs": evil, ".dependency-cruiser.js": evil, "src/a.ts": `export {};\n` },
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("forbidden edges", () => {
  const rule = { name: "ui-not-db", from: "^src/ui/", to: "^src/db/" };
  const b = { "src/ui/v.ts": `export {};\n`, "src/db/q.ts": `export {};\n` };
  const c = { "src/ui/v.ts": `import "../db/q";\n`, "src/db/q.ts": `export {};\n` };

  it("observes only before P2", async () => {
    const { result, state } = await run(b, c, { policy: defaultPolicy({ deps: { forbidden: [rule] } }) });
    expect(state).toBe("PASS");
    expect(result.observe.new_forbidden_edges).toEqual([{ rule: "ui-not-db", from: "src/ui/v.ts", to: "src/db/q.ts" }]);
  });

  it("blocks when enabled", async () => {
    const { result } = await run(b, c, { policy: defaultPolicy({ deps: { forbidden: [rule], block_forbidden_edges: true } }) });
    expect(result.violations.map((v) => v.reason)).toEqual(["DEP_FORBIDDEN_EDGE"]);
  });

  it("does not block an existing edge", async () => {
    const { result } = await run(c, c, { policy: defaultPolicy({ deps: { forbidden: [rule], block_forbidden_edges: true } }) });
    expect(result.violations).toEqual([]);
  });
});

describe("S3 module split", () => {
  it("fires for new modules that each have a single importer", async () => {
    const { result, state } = await run(
      { "src/main.ts": `export const run = () => 1;\n` },
      {
        "src/main.ts": `import { p1 } from "./part1";\nimport { p2 } from "./part2";\nexport const run = () => p1() + p2();\n`,
        "src/part1.ts": `export const p1 = () => 1;\n`,
        "src/part2.ts": `export const p2 = () => 2;\n`,
        "src/part1.test.ts": `import { p1 } from "./part1";\np1();\n`,
      },
      { changed: ["src/main.ts"] },
    );
    expect(state).toBe("PASS");
    expect(result.triggers.map((t) => [t.id, t.routing])).toEqual([["S3", true]]);
    expect(result.triggers[0]!.evidence).toContain("src/part1.ts ← src/main.ts");
  });

  it("does not fire for a single new shared module", async () => {
    const { result } = await run(
      { "src/a.ts": `export {};\n`, "src/b.ts": `export {};\n` },
      { "src/a.ts": `import "./shared";\n`, "src/b.ts": `import "./shared";\n`, "src/shared.ts": `export {};\n` },
    );
    expect(result.triggers).toEqual([]);
  });

  it("fires when a changed file's efferent imports grow by 5", async () => {
    const libs = ["a", "b", "c", "d", "e"];
    const { result } = await run(
      { "src/m.ts": `export {};\n` },
      { "src/m.ts": libs.map((l) => `import "${l}";`).join("\n") + "\n" },
      { changed: ["src/m.ts"] },
    );
    expect(result.triggers.map((t) => t.evidence)).toEqual(["src/m.ts imports 5 more modules than before (0 → 5)"]);
  });
});

describe("fail closed", () => {
  it("INCONCLUSIVE when the cruiser fails", async () => {
    const result = await evaluateDeps({
      treeB: "/nope",
      treeC: "/nope",
      filesB: ["a.ts"],
      filesC: ["a.ts"],
      policy: defaultPolicy(),
      changedPaths: [],
      cruiser: async () => {
        throw new Error("boom");
      },
    });
    expect(depsState(result, ["a.ts"])).toBe("INCONCLUSIVE");
    expect(result.inconclusive[0]).toMatchObject({ reason: "TOOL_ERROR" });
  });

  it("NOT_APPLICABLE without code files", async () => {
    const { state } = await run({}, {});
    expect(state).toBe("NOT_APPLICABLE");
  });
});

describe("cycle primitives", () => {
  it("handles very deep chains without recursion", () => {
    const n = 20000;
    const nodes = Array.from({ length: n }, (_, i) => `m${i}`);
    const edges = nodes.slice(1).map((to, i) => ({ from: nodes[i]!, to }));
    const comp = stronglyConnectedComponents(nodes, adjacency([...edges, { from: nodes[n - 1]!, to: nodes[0]! }]));
    expect(new Set(comp.values()).size).toBe(1);
    expect(findNewCycles(nodes, edges, [], (p) => p)).toEqual([]);
  });

  it("ignores edges into unrelated components", () => {
    const cycles = findNewCycles(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "b", to: "c" },
      ],
      [],
      () => undefined,
    );
    expect(cycles.map((c) => c.members)).toEqual([["a", "b"]]);
  });

  it("drops aliases that escape the tree", () => {
    expect(aliasesFromPaths("/repo", ".", { "@/*": ["src/*"], "x/*": ["../outside/*"], exact: ["src/e.ts"] })).toEqual({
      "@": "/repo/src",
      exact$: "/repo/src/e.ts",
    });
  });
});
