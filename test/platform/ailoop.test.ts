import { describe, expect, it } from "vitest";
import { addedLineDirectives, decideRetry, detectForbiddenChanges } from "../../src/ailoop/index.js";
import { matchesGlob as matchGlob } from "../../src/util/glob.js";
import { policy } from "./helpers.js";

describe("glob", () => {
  it("matches basenames anywhere for slash-less patterns and anchors the rest", () => {
    expect(matchGlob("packages/a/tsconfig.build.json", "tsconfig*.json")).toBe(true);
    expect(matchGlob("vitest.config.ts", "vitest.config.*")).toBe(true);
    expect(matchGlob(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(matchGlob("src/.github/x", ".github/**")).toBe(false);
    expect(matchGlob("src/a/b/c.test.ts", "**/*.test.*")).toBe(true);
    expect(matchGlob("src/x.ts", "src/{x,y}.ts")).toBe(true);
    expect(matchGlob("src/z.ts", "src/{x,y}.ts")).toBe(false);
  });
});

describe("AI loop forbidden changes (spec 12.2)", () => {
  const p = policy({ scope: { exclude: ["src/generated/**"] } });
  it("flags gate and tool configuration paths", () => {
    for (const path of ["cccc.toml", "eslint.config.js", "vitest.config.ts", "tsconfig.json", ".gitattributes", ".github/workflows/ci.yml", "waivers.jsonl", "src/__snapshots__/a.snap"]) {
      const v = detectForbiddenChanges([{ status: "M", pathB: path, pathC: path }], p);
      expect(v, path).toHaveLength(1);
      expect(v[0]!.reason).toBe("POLICY_PATH_MODIFIED");
    }
    expect(detectForbiddenChanges([{ status: "M", pathB: "src/a.ts", pathC: "src/a.ts" }], p)).toEqual([]);
  });

  it("flags moves out of measured extensions and into excluded paths", () => {
    expect(detectForbiddenChanges([{ status: "R", pathB: "src/a.ts", pathC: "src/a.vue" }], p)).toHaveLength(1);
    expect(detectForbiddenChanges([{ status: "R", pathB: "src/a.ts", pathC: "src/generated/a.ts" }], p)).toHaveLength(1);
    expect(detectForbiddenChanges([{ status: "A", pathB: null, pathC: "src/generated/b.ts" }], p)).toHaveLength(1);
  });

  it("flags added suppression directives unless allowlisted", () => {
    const change = { status: "M" as const, pathB: "src/a.ts", pathC: "src/a.ts", addedLines: [{ line: 3, text: "// eslint-disable-next-line no-new-func" }, { line: 9, text: "/* v8 ignore next */" }] };
    expect(detectForbiddenChanges([change], p)).toHaveLength(2);
    const allow = policy({ lint: { suppression_allowlist: ["eslint-disable-next-line no-new-func", "v8 ignore next"] } });
    expect(detectForbiddenChanges([change], allow)).toHaveLength(0);
  });

  it("classifies directives in real comments only, Stryker included", () => {
    const kinds = (t: string) => addedLineDirectives(t).map((d) => d.kind);
    expect(kinds("// Stryker disable next-line all")).toEqual(["stryker-disable"]);
    expect(kinds(" * eslint-disable no-new-func")).toEqual(["eslint-disable"]);
    expect(kinds("const s = '// eslint-disable-next-line';")).toEqual([]);
    expect(kinds("foo(); /* @ts-nocheck */ // istanbul ignore next")).toEqual(["ts-nocheck", "coverage-ignore"]);
    expect(kinds("{/* eslint-disable-next-line */}")).toEqual(["eslint-disable"]);
  });

  it("flags test script changes in package.json but not dependency bumps", () => {
    const before = JSON.stringify({ scripts: { test: "vitest run", build: "tsc" }, dependencies: { a: "1" } });
    const bump = JSON.stringify({ scripts: { test: "vitest run", build: "tsc -b" }, dependencies: { a: "2" } });
    const weakened = JSON.stringify({ scripts: { test: "vitest run --passWithNoTests", build: "tsc" } });
    expect(detectForbiddenChanges([], p, [{ path: "package.json", before, after: bump }])).toHaveLength(0);
    expect(detectForbiddenChanges([], p, [{ path: "package.json", before, after: weakened }])).toHaveLength(1);
  });
});

describe("retry decision (spec 12.3)", () => {
  const base = { attempt: 0, previousViolations: [], currentViolations: ["a"], newTriggers: [], forbidden: [] };
  it("retries at most max_retries times", () => {
    expect(decideRetry(base, policy()).action).toBe("retry");
    expect(decideRetry({ ...base, attempt: 1, previousViolations: ["a", "b"] }, policy()).action).toBe("retry");
    expect(decideRetry({ ...base, attempt: 2, previousViolations: ["a", "b"] }, policy())).toMatchObject({ action: "handoff", reason: expect.stringContaining("limit") });
  });
  it("stops early on no progress, redistribution/hiding and forbidden changes", () => {
    expect(decideRetry({ ...base, attempt: 1, previousViolations: ["a"] }, policy()).reason).toMatch(/no_progress/);
    expect(decideRetry({ ...base, attempt: 1, newTriggers: [{ id: "S9", gate: "complexity", evidence: "", routing: true }] }, policy()).action).toBe("handoff");
    expect(decideRetry({ ...base, forbidden: [{ gate: "tests", reason: "POLICY_PATH_MODIFIED", file: "x", message: "m" }] }, policy()).action).toBe("handoff");
  });
  it("is done when nothing is left", () => {
    expect(decideRetry({ ...base, attempt: 1, currentViolations: [] }, policy()).action).toBe("done");
  });
});
