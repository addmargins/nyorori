// Security review #4: imports of unmeasured files through non-relative
// specifiers and query-looking file names route S11 (repros s2, s2b, s2c).

import { describe, expect, it } from "vitest";
import { depsState, evaluateDeps } from "../../src/gates/deps/evaluate.js";
import { matchSubpath } from "../../src/gates/deps/targets.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { writeTree } from "../lint/helpers.js";

const isCode = (p: string) => /\.(c|m)?[jt]sx?$/.test(p);
const hidden = Array.from({ length: 20 }, (_, i) => `if (x === ${i}) { if (y) { y += ${i}; } }`).join("\n");
const logic = `module.exports = function (x, y) {\n${hidden}\nreturn y; };\n`;

async function run(b: Record<string, string>, c: Record<string, string>, opts: { withListing?: boolean } = {}) {
  const result = await evaluateDeps({
    treeB: writeTree(b),
    treeC: writeTree(c),
    filesB: Object.keys(b).filter(isCode),
    filesC: Object.keys(c).filter(isCode),
    policy: defaultPolicy(),
    changedPaths: [],
    ...(opts.withListing === false ? {} : { allFilesC: Object.keys(c) }),
  });
  return { result, state: depsState(result, Object.keys(c).filter(isCode)), ids: result.triggers.map((t) => t.id) };
}

describe("s2: tsconfig alias and baseUrl targets", () => {
  const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
  const b = { "tsconfig.json": tsconfig, "src/main.js": "module.exports = 1;\n" };
  it.each([
    ["relative ./logic.txt", "./logic.txt", "src/logic.txt"],
    ["paths alias @/logic.txt", "@/logic.txt", "src/logic.txt"],
    ["baseUrl src/logic.txt", "src/logic.txt", "src/logic.txt"],
    ["paths alias, extensionless @/logic", "@/logic", "src/logic"],
  ])("%s routes S11, not S3", async (_name, spec, target) => {
    const { ids, result } = await run(b, { "tsconfig.json": tsconfig, [target]: logic, "src/main.js": `module.exports = require(${JSON.stringify(spec)});\n` });
    expect(ids).toEqual(["S11"]);
    expect(result.triggers[0]!.evidence).toContain(`→ ${target}`);
  });

  it("an alias import of a missing file stays S3 evidence", async () => {
    const { ids } = await run(b, { ...b, "src/main.js": `module.exports = require("@/gone");\n` });
    expect(ids).toEqual(["S3"]);
  });
});

describe("s2b: package.json imports and self-reference", () => {
  const pkg = JSON.stringify({ name: "victim", type: "commonjs", imports: { "#*": "./src/*" }, exports: { "./*": "./src/*" } });
  const b = { "package.json": pkg, "src/main.js": "module.exports = 1;\n" };
  it.each([
    ["imports #logic.txt", "#logic.txt"],
    ["self-reference victim/logic.txt", "victim/logic.txt"],
  ])("%s routes S11", async (_name, spec) => {
    const { ids, state } = await run(b, { ...b, "src/logic.txt": logic, "src/main.js": `module.exports = require(${JSON.stringify(spec)});\n` });
    expect(state).toBe("PASS");
    expect(ids).toEqual(["S11"]);
  });

  it("a mapping the candidate adds is checked too (C's map is what runs)", async () => {
    const c = {
      "package.json": JSON.stringify({ name: "victim", imports: { "#logic": "./src/logic.txt" } }),
      "src/logic.txt": logic,
      "src/main.js": `module.exports = require("#logic");\n`,
    };
    expect((await run({ "src/main.js": "module.exports = 1;\n" }, c)).ids).toEqual(["S11"]);
  });

  it("a nested package's map applies to its own files", async () => {
    const c = {
      "packages/a/package.json": JSON.stringify({ name: "a", imports: { "#x": { require: "./lib/x.md", default: "./lib/x.js" } } }),
      "packages/a/lib/x.md": logic,
      "packages/a/main.js": `module.exports = require("#x");\n`,
    };
    expect((await run({ "packages/a/main.js": "module.exports = 1;\n" }, c)).ids).toEqual(["S11"]);
  });

  it.each([
    ["json data via imports", `{"#cfg": "./src/cfg.json"}`, "src/cfg.json", "#cfg"],
    ["unrelated package", `{"#*": "./src/*"}`, "src/logic.txt", "lodash/README.md"],
  ])("no S11: %s", async (_name, imports, file, spec) => {
    const c = { "package.json": `{"name":"victim","imports":${imports}}`, [file]: "{}\n", "src/main.js": `module.exports = require(${JSON.stringify(spec)});\n` };
    expect((await run({ "src/main.js": "module.exports = 1;\n" }, c)).ids).toEqual([]);
  });

  it("matches Node subpath patterns", () => {
    expect(matchSubpath({ "#*": "./src/*" }, "#a/b.txt")).toEqual(["./src/a/b.txt"]);
    expect(matchSubpath({ "./feature/*.js": { node: "./f/*.cjs", default: "./f/*.mjs" } }, "./feature/x.js")).toEqual(["./f/x.cjs", "./f/x.mjs"]);
    expect(matchSubpath({ require: "./i.cjs" }, ".")).toEqual(["./i.cjs"]);
    expect(matchSubpath("./i.js", ".")).toEqual(["./i.js"]);
  });
});

describe("s2c: a literal file name wins over a query reading", () => {
  it.each(["x?raw", "x?url", "logic.txt?inline", "a#b"])("require('./%s') of an existing file routes S11", async (name) => {
    const { ids, result } = await run(
      { "src/main.js": "module.exports = 1;\n" },
      { [`src/${name}`]: logic, "src/main.js": `module.exports = require("./${name}");\n` },
    );
    expect(ids).toEqual(["S11"]);
    expect(result.triggers[0]!.evidence).toContain("? or #");
  });

  it("a real bundler query on an existing data file stays clean", async () => {
    const { ids } = await run(
      { "src/main.ts": "export {};\n" },
      { "src/notes.md": "# notes\n", "src/main.ts": `import text from "./notes.md?raw";\nexport default text;\n` },
    );
    expect(ids).toEqual([]);
  });
});
