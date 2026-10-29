import { describe, expect, it } from "vitest";
import { matchesAny, matchesGlob } from "../../src/util/glob.js";
import { createPathResolver } from "../../src/gates/tests/paths.js";

describe("policy globs", () => {
  it("matches slash-less patterns against the basename anywhere", () => {
    expect(matchesGlob("tsconfig.json", "tsconfig*.json")).toBe(true);
    expect(matchesGlob("packages/api/tsconfig.build.json", "tsconfig*.json")).toBe(true);
    expect(matchesGlob("packages/api/vitest.config.ts", "vitest.config.*")).toBe(true);
  });
  it("anchors patterns with a slash at the repository root", () => {
    expect(matchesGlob(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(matchesGlob("docs/.github/x.yml", ".github/**")).toBe(false);
    expect(matchesGlob("src/a.test.ts", "**/*.test.*")).toBe(true);
    expect(matchesGlob("a.test.ts", "**/*.test.*")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(matchesAny("src/tsconfig.ts", ["tsconfig*.json"])).toBe(false);
    expect(matchesAny("src/vitest.config.helper/x.ts", ["vitest.config.*"])).toBe(false);
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
