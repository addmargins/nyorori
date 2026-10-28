// Round 4 (two-branch comparative review): jsconfig aliases, convention
// aliases without a spec, and extensionless targets through allFilesC.

import { describe, expect, it } from "vitest";
import { readAliasSpec } from "../../src/gates/deps/aliases.js";
import { depsState, evaluateDeps } from "../../src/gates/deps/evaluate.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { writeTree } from "../lint/helpers.js";

const isCode = (p: string) => /\.(c|m)?[jt]sx?$/.test(p);

async function run(b: Record<string, string>, c: Record<string, string>, opts: { listing?: boolean } = {}) {
  const result = await evaluateDeps({
    treeB: writeTree(b),
    treeC: writeTree(c),
    filesB: Object.keys(b).filter(isCode),
    filesC: Object.keys(c).filter(isCode),
    policy: defaultPolicy(),
    changedPaths: [],
    ...(opts.listing === false ? {} : { allFilesC: Object.keys(c) }),
  });
  return { result, state: depsState(result, Object.keys(c).filter(isCode)), ids: result.triggers.map((t) => t.id) };
}

describe("jsconfig.json aliases (probe p5a)", () => {
  const jsconfig = `{\n  // JS projects configure paths here\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },\n}\n`;

  it("reads jsconfig.json with comments and trailing commas", () => {
    expect(readAliasSpec(writeTree({ "jsconfig.json": jsconfig }))).toEqual({ aliases: { "@": "src" }, baseUrl: "", ignoredExtends: [] });
  });

  it("tsconfig.json wins when both exist", () => {
    const root = writeTree({ "jsconfig.json": jsconfig, "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["lib/*"] } } }) });
    expect(readAliasSpec(root).aliases).toEqual({ "~": "lib" });
  });

  it("a cycle through a jsconfig alias is DEP_NEW_CYCLE", async () => {
    const { state, result } = await run(
      { "jsconfig.json": jsconfig, "src/a.js": `import "@/b";\n`, "src/b.js": `export {};\n` },
      { "jsconfig.json": jsconfig, "src/a.js": `import "@/b";\n`, "src/b.js": `import "@/a";\n` },
    );
    expect(state).toBe("FAIL");
    expect(result.violations.map((v) => v.reason)).toEqual(["DEP_NEW_CYCLE"]);
  });
});

describe("bare specifiers with no alias spec", () => {
  it("`@/x` that matches src/x.* routes S3 as an unresolved alias", async () => {
    const { ids, result, state } = await run(
      { "src/a.ts": `export {};\n`, "src/x.ts": `export {};\n` },
      { "src/a.ts": `import "@/x";\n`, "src/x.ts": `import "./a";\n` },
    );
    expect(state).toBe("PASS"); // the cycle is invisible; a human is told why
    expect(ids).toEqual(["S3"]);
    expect(result.observe.unresolved_internal_c).toEqual([{ from: "src/a.ts", specifier: "@/x" }]);
  });

  it.each([
    ["scoped npm package", `import "@scope/pkg";\n`],
    ["@/ with no matching file", `import "@/nothing";\n`],
    ["plain package", `import "lodash/fp";\n`],
  ])("no S3: %s", async (_name, code) => {
    expect((await run({ "src/a.ts": `export {};\n`, "src/x.ts": `export {};\n` }, { "src/a.ts": code, "src/x.ts": `export {};\n` })).ids).toEqual([]);
  });

  it("stays quiet without a file listing", async () => {
    expect((await run({ "src/a.ts": `export {};\n` }, { "src/a.ts": `import "@/x";\n`, "src/x.ts": `export {};\n` }, { listing: false })).ids).toEqual([]);
  });
});

describe("extensionless targets with the pipeline's allFilesC", () => {
  it.each([
    ["require", `const p = require("./pricing");\nmodule.exports = p;\n`],
    ["import", `import p from "./pricing";\nexport default p;\n`],
    ["nested path", `import p from "../lib/pricing";\nexport default p;\n`],
  ])("%s of an extensionless file routes S11", async (_name, code) => {
    const target = code.includes("../lib") ? "lib/pricing" : "src/pricing";
    const { ids, result, state } = await run(
      { "src/main.js": "module.exports = 1;\n" },
      { "src/main.js": code, [target]: "module.exports = function (x) { if (x) { if (x > 1) return 2; } return 0; };\n" },
    );
    expect(state).toBe("PASS");
    expect(ids).toEqual(["S11"]);
    expect(result.triggers[0]!.evidence).toContain(`→ ${target} (relative), a file the gate does not measure (no extension)`);
  });

  it("an extensionless specifier that resolves to a code file is clean", async () => {
    const { ids } = await run(
      { "src/main.js": "module.exports = 1;\n" },
      { "src/main.js": `const p = require("./pricing");\nmodule.exports = p;\n`, "src/pricing.js": "module.exports = 1;\n" },
    );
    expect(ids).toEqual([]);
  });

  it("an existing import of the extensionless file does not route again", async () => {
    const tree = { "src/main.js": `const p = require("./pricing");\nmodule.exports = p;\n`, "src/pricing": "module.exports = 1;\n" };
    expect((await run(tree, { ...tree, "src/main.js": `${tree["src/main.js"]}exports.y = 1;\n` })).ids).toEqual([]);
  });
});
