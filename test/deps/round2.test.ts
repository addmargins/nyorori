// Regressions for rulings D7, D19, audit F6 (S11 targets) and F9 (aliases).

import { describe, expect, it } from "vitest";
import { evaluateDeps, depsState } from "../../src/gates/deps/evaluate.js";
import { readAliasSpec } from "../../src/gates/deps/aliases.js";
import { defaultPolicy, type PolicyInput } from "../../src/policy/schema.js";
import { writeTree } from "../lint/helpers.js";

const isCode = (p: string) => /\.(c|m)?[jt]sx?$/.test(p);

async function run(
  b: Record<string, string>,
  c: Record<string, string>,
  opts: { policy?: Partial<PolicyInput>; renames?: Map<string, string>; allFilesC?: boolean } = {},
) {
  const result = await evaluateDeps({
    treeB: writeTree(b),
    treeC: writeTree(c),
    filesB: Object.keys(b).filter(isCode),
    filesC: Object.keys(c).filter(isCode),
    policy: defaultPolicy(opts.policy ?? {}),
    changedPaths: [],
    ...(opts.renames ? { renames: opts.renames } : {}),
    ...(opts.allFilesC ? { allFilesC: Object.keys(c) } : {}),
  });
  return { result, state: depsState(result, Object.keys(c).filter(isCode)), ids: result.triggers.map((t) => t.id) };
}

describe("ruling D7: FAIL only when the cyclic partition changes", () => {
  it("FAILs when two cycles merge", async () => {
    const b = {
      "src/a.ts": `import "./b";\n`,
      "src/b.ts": `import "./a";\n`,
      "src/c.ts": `import "./d";\n`,
      "src/d.ts": `import "./c";\n`,
    };
    const { result, state } = await run(b, { ...b, "src/b.ts": `import "./a";\nimport "./c";\n`, "src/d.ts": `import "./c";\nimport "./a";\n` });
    expect(state).toBe("FAIL");
    expect(result.violations[0]!.details?.members).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("FAILs when an acyclic module becomes cyclic with existing ones", async () => {
    const b = { "src/a.ts": `import "./b";\n`, "src/b.ts": `export {};\n` };
    const { state } = await run(b, { ...b, "src/b.ts": `import "./a";\n` });
    expect(state).toBe("FAIL");
  });

  it("does not fail a cycle that shrank", async () => {
    const b = { "src/a.ts": `import "./b";\n`, "src/b.ts": `import "./a";\nimport "./c";\n`, "src/c.ts": `import "./b";\n` };
    const { state, ids } = await run(b, { ...b, "src/c.ts": `export {};\n` });
    expect(state).toBe("PASS");
    expect(ids).toEqual([]);
  });

  it("routes a cycle closed only by a new lazy import() as S3", async () => {
    const b = { "src/a.ts": `import "./b";\n`, "src/b.ts": `export const b = 1;\n` };
    const { result, state } = await run(b, { ...b, "src/b.ts": `export const load = () => import("./a");\n` });
    expect(state).toBe("PASS");
    expect(result.triggers.map((t) => [t.id, t.evidence])).toEqual([["S3", "import cycle closed only through a lazy import(): src/a.ts, src/b.ts"]]);
  });

  it("a lazy edge on top of a new runtime cycle is just the FAIL", async () => {
    const b = { "src/a.ts": `export {};\n`, "src/b.ts": `export {};\n` };
    const { state, ids } = await run(b, { "src/a.ts": `import "./b";\n`, "src/b.ts": `import "./a";\nexport const l = () => import("./a");\n` });
    expect(state).toBe("FAIL");
    expect(ids).toEqual([]);
  });
});

describe("ruling D19: product code may not import tests or excluded paths", () => {
  it("FAILs a new product → test edge", async () => {
    const { result } = await run(
      { "src/a.ts": `export {};\n`, "src/__tests__/fixtures.ts": `export const f = 1;\n` },
      { "src/a.ts": `import { f } from "./__tests__/fixtures";\nexport const x = f;\n`, "src/__tests__/fixtures.ts": `export const f = 1;\n` },
    );
    expect(result.violations.map((v) => [v.reason, v.metric])).toEqual([["DEP_FORBIDDEN_EDGE", "product-imports-test"]]);
  });

  it("FAILs a new product → excluded edge regardless of block_forbidden_edges", async () => {
    const { result } = await run(
      { "src/a.ts": `export {};\n`, "src/gen/logic.ts": `export const g = 1;\n` },
      { "src/a.ts": `import { g } from "./gen/logic";\nexport const x = g;\n`, "src/gen/logic.ts": `export const g = 1;\n` },
      { policy: { scope: { exclude: ["src/gen/**"] } } },
    );
    expect(result.violations.map((v) => v.metric)).toEqual(["product-imports-excluded"]);
  });

  it("allows tests to import product code, and existing edges", async () => {
    const tree = { "src/a.ts": `import "./a.test";\nexport {};\n`, "src/a.test.ts": `import "./a";\n` };
    const { result } = await run(tree, { ...tree, "src/b.test.ts": `import "./a";\n` });
    expect(result.violations.filter((v) => v.reason === "DEP_FORBIDDEN_EDGE")).toEqual([]);
  });
});

describe("audit F6: imports of files the gate does not measure route S11", () => {
  const b = { "src/a.ts": `export {};\n` };
  it.each([
    ["require of .txt", `const logic = require("./logic.txt");\nexport default logic;\n`],
    ["import of .md", `import doc from "./doc.md";\nexport default doc;\n`],
    ["require of .node", `const addon = require("./build/addon.node");\nexport default addon;\n`],
    ["import of .wasm", `import w from "./x.wasm";\nexport default w;\n`],
  ])("%s", async (_name, code) => {
    const { ids, state } = await run(b, { "src/a.ts": code });
    expect(state).toBe("PASS");
    expect(ids).toEqual(["S11"]);
  });

  it.each([
    ["json", `import data from "./data.json";\nexport default data;\n`],
    ["css", `import "./a.css";\n`],
    ["svg asset", `import logo from "./logo.svg";\nexport default logo;\n`],
    ["raw query", `import text from "./notes.md?raw";\nexport default text;\n`],
    ["missing code file", `import "./missing";\n`],
  ])("no S11: %s", async (_name, code) => {
    expect((await run(b, { "src/a.ts": code })).ids).toEqual([]);
  });

  it("an existing import of the same target does not route again", async () => {
    const code = `const logic = require("./logic.txt");\nexport default logic;\n`;
    expect((await run({ "src/a.ts": code }, { "src/a.ts": `${code}export const y = 1;\n` })).ids).toEqual([]);
  });

  it("an extensionless file is seen through allFilesC", async () => {
    const c = { "src/a.ts": `const p = require("./pricing");\nexport default p;\n`, "src/pricing": `module.exports = 1;\n` };
    expect((await run(b, c, { allFilesC: true })).ids).toEqual(["S11"]);
    expect((await run(b, c)).ids).toEqual([]);
  });
});

describe("audit F9: resolver settings come from B", () => {
  const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });

  it("resolves baseUrl bare imports (audit repro)", async () => {
    const cfg = JSON.stringify({ compilerOptions: { baseUrl: "." } });
    const { state } = await run(
      { "tsconfig.json": cfg, "src/a.ts": `export const a = 1;\n`, "src/b.ts": `export const b = 2;\n` },
      { "tsconfig.json": cfg, "src/a.ts": `import { b } from "src/b";\nexport const a = b;\n`, "src/b.ts": `import { a } from "./a";\nexport const b = a;\n` },
    );
    expect(state).toBe("FAIL");
  });

  it("a candidate that drops its aliases cannot hide a cycle", async () => {
    const { state } = await run(
      { "tsconfig.json": tsconfig, "src/a.ts": `import "@/b";\n`, "src/b.ts": `export {};\n` },
      { "tsconfig.json": `{}`, "src/a.ts": `import "@/b";\n`, "src/b.ts": `import "@/a";\n` },
    );
    expect(state).toBe("FAIL");
  });

  it("follows relative extends within the tree", async () => {
    const base = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~lib/*": ["lib/*"] } } });
    const root = writeTree({ "tsconfig.base.json": base, "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }), "configs/x.json": "{}" });
    expect(readAliasSpec(root)).toEqual({ aliases: { "~lib": "lib" }, baseUrl: "", ignoredExtends: [] });
    const viaPkg = writeTree({ "tsconfig.json": JSON.stringify({ extends: "@tsconfig/node20/tsconfig.json" }) });
    expect(readAliasSpec(viaPkg).ignoredExtends).toEqual(["@tsconfig/node20/tsconfig.json"]);
  });

  it("child options win over extended ones", async () => {
    const root = writeTree({
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "base", paths: { "@/*": ["x/*"] } } }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    });
    expect(readAliasSpec(root)).toEqual({ aliases: { "@": "base/src" }, baseUrl: "base", ignoredExtends: [] });
  });

  it("does not follow extends out of the tree", async () => {
    const root = writeTree({ "tsconfig.json": JSON.stringify({ extends: "../../etc/tsconfig.json" }) });
    expect(readAliasSpec(root)).toEqual({ aliases: {}, baseUrl: null, ignoredExtends: [] });
  });

  it("unresolved internal-looking specifiers are S3 evidence, not silent", async () => {
    const { result } = await run(
      { "tsconfig.json": tsconfig, "src/a.ts": `export {};\n` },
      { "tsconfig.json": tsconfig, "src/a.ts": `import "@/gone";\nimport "lodash";\n` },
    );
    expect(result.observe.unresolved_internal_c).toEqual([{ from: "src/a.ts", specifier: "@/gone" }]);
    expect(result.triggers.map((t) => t.id)).toEqual(["S3"]);
  });
});
