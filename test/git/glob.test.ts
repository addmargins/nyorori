import { describe, expect, it } from "vitest";
import { matchesAny, matchesGlob } from "../../src/git/glob.js";

describe("matchesGlob", () => {
  it.each([
    ["src/a/b.ts", "src/**", true],
    ["src", "src/**", false],
    ["lib/a.ts", "src/**", false],
    ["a.test.ts", "**/*.test.*", true],
    ["x/y/a.test.ts", "**/*.test.*", true],
    ["x/y/a.ts", "**/*.test.*", false],
    [".gitattributes", "**/.gitattributes", true],
    ["pkg/.gitattributes", "**/.gitattributes", true],
    ["pkg/.gitattributes", ".gitattributes", true], // basename rule
    ["pkg/tsconfig.base.json", "tsconfig*.json", true],
    ["src/.hidden/a.ts", "src/**", true],
    ["src/a.ts", "src/*.ts", true],
    ["src/x/a.ts", "src/*.ts", false],
    ["a/b/c/d.ts", "a/**/d.ts", true],
    ["a/d.ts", "a/**/d.ts", true],
    ["src/a.spec.tsx", "**/*.{test,spec}.{ts,tsx}", true],
    ["src/a.int.ts", "**/*.{test,spec}.{ts,tsx}", false],
    ["generated/x.ts", "generated/**", true],
    ["a1.ts", "a[0-9].ts", true],
    ["ab.ts", "a[!0-9].ts", true],
    ["a1.ts", "a[!0-9].ts", false],
    ["a.ts", "a?ts", true],
    ["a/ts", "a?ts", false],
    ["file(1).ts", "file(1).ts", true],
    ["fileX1).ts", "file(1).ts", false],
    ["src/a.ts", "./src/a.ts", true],
    [".github/workflows/ci.yml", ".github/**", true],
  ])("%s ~ %s → %s", (path, pattern, want) => {
    expect(matchesGlob(path, pattern)).toBe(want);
  });

  it("matchesAny", () => {
    expect(matchesAny("x.vue", ["*.ts", "*.vue"])).toBe(true);
    expect(matchesAny("x.vue", [])).toBe(false);
  });
});
