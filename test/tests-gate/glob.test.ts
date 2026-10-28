import { describe, expect, it } from "vitest";
import { matchesAnyGlob, matchesPolicyGlob } from "../../src/gates/tests/glob.js";
import { createPathResolver } from "../../src/gates/tests/paths.js";

describe("policy globs", () => {
  it("matches slash-less patterns against the basename anywhere", () => {
    expect(matchesPolicyGlob("tsconfig.json", "tsconfig*.json")).toBe(true);
    expect(matchesPolicyGlob("packages/api/tsconfig.build.json", "tsconfig*.json")).toBe(true);
    expect(matchesPolicyGlob("packages/api/vitest.config.ts", "vitest.config.*")).toBe(true);
  });
  it("anchors patterns with a slash at the repository root", () => {
    expect(matchesPolicyGlob(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(matchesPolicyGlob("docs/.github/x.yml", ".github/**")).toBe(false);
    expect(matchesPolicyGlob("src/a.test.ts", "**/*.test.*")).toBe(true);
    expect(matchesPolicyGlob("a.test.ts", "**/*.test.*")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(matchesAnyGlob("src/tsconfig.ts", ["tsconfig*.json"])).toBe(false);
    expect(matchesAnyGlob("src/vitest.config.helper/x.ts", ["vitest.config.*"])).toBe(false);
  });
});

describe("report path resolution", () => {
  it("strips a recorded runner root", () => {
    const r = createPathResolver({ rootDir: "/home/runner/work/app/app" });
    expect(r("/home/runner/work/app/app/src/a.test.ts")).toEqual({ ok: true, path: "src/a.test.ts" });
  });
  it("maps absolute paths by unique suffix on a segment boundary", () => {
    const r = createPathResolver({ knownFiles: ["src/a.test.ts", "lib/xa.test.ts"] });
    expect(r("/w/repo/src/a.test.ts")).toEqual({ ok: true, path: "src/a.test.ts" });
    expect(r("/w/repo/other/a.test.ts").ok).toBe(false);
  });
  it("prefers the longest suffix and rejects escapes", () => {
    const r = createPathResolver({ knownFiles: ["a.test.ts", "src/a.test.ts"] });
    expect(r("/w/repo/src/a.test.ts")).toEqual({ ok: true, path: "src/a.test.ts" });
    expect(r("../outside.ts").ok).toBe(false);
    expect(r("./src/a.test.ts")).toEqual({ ok: true, path: "src/a.test.ts" });
  });
});
