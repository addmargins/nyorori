import { describe, expect, it } from "vitest";
import { analyzeConfigChange } from "../../src/gates/tests/config.js";

const why = (p: string, b: string | null, c: string | null) => analyzeConfigChange(p, b, c).map((w) => `${w.setting}: ${w.why}`);

describe("config weakening", () => {
  it("detects vitest coverage and run weakening", () => {
    const b = `export default defineConfig({ test: { coverage: { thresholds: { branches: 80, lines: 90 }, exclude: ["dist/**"], reportOnFailure: true } } });`;
    const c = `export default defineConfig({ test: { passWithNoTests: true, coverage: { thresholds: { branches: 70 }, exclude: ["dist/**", "src/billing/**"], reportOnFailure: false } } });`;
    expect(why("vitest.config.ts", b, c)).toEqual([
      "test.coverage.exclude: entries added to exclude: src/billing/**",
      "test.coverage.reportOnFailure: reportOnFailure disabled",
      "test.coverage.thresholds.branches: coverage threshold lowered",
      "test.coverage.thresholds.lines: coverage threshold removed",
      "test.passWithNoTests: passWithNoTests enabled",
    ]);
  });
  it("accepts strengthening and neutral edits", () => {
    const b = `export default { test: { coverage: { thresholds: { branches: 80 } }, include: ["src/**/*.test.ts"] } };`;
    const c = `export default { test: { coverage: { thresholds: { branches: 85 } }, include: ["src/**/*.test.ts", "lib/**/*.test.ts"], testTimeout: 10000 } };`;
    expect(why("vitest.config.ts", b, c)).toEqual([]);
  });
  it("detects jest config weakening, including deletion", () => {
    const b = `{ "coverageThreshold": { "global": { "branches": 80 } }, "testMatch": ["**/*.test.ts"] }`;
    expect(why("jest.config.json", b, null)).toEqual([
      "coverageThreshold.global.branches: coverage threshold removed",
      "testMatch: entries removed from testMatch: **/*.test.ts",
    ]);
  });
  it("detects tsconfig strictness weakening with comments and trailing commas", () => {
    const b = `{ // base\n "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, }, "exclude": ["dist"] }`;
    const c = `{ "compilerOptions": { "strict": false }, "exclude": ["dist", "src/legacy"] }`;
    expect(why("packages/a/tsconfig.json", b, c)).toEqual([
      "compilerOptions.noUncheckedIndexedAccess: type-check strictness turned off",
      "compilerOptions.strict: type-check strictness turned off",
      "exclude: entries added to exclude: src/legacy",
    ]);
  });
  it("detects weakened package.json test scripts", () => {
    const b = JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } });
    expect(why("package.json", b, JSON.stringify({ scripts: { test: "vitest run --passWithNoTests -u", build: "tsc -b" } }))).toEqual([
      "scripts.test: weakening flags added: --passWithNoTests -u",
    ]);
    expect(why("package.json", b, JSON.stringify({ scripts: { test: "echo ok" } }))).toEqual([
      "scripts.test: test script no longer invokes a known test runner",
    ]);
    expect(why("package.json", b, JSON.stringify({ scripts: {} }))).toEqual(["scripts.test: test script removed"]);
    expect(why("package.json", b, JSON.stringify({ scripts: { test: "vitest run --coverage.enabled=false" } }))).toEqual([
      "scripts.test: weakening flags added: --coverage.enabled=false",
    ]);
  });
  it("reports computed values and unparseable configs instead of guessing", () => {
    const b = `export default { test: { exclude: ["dist/**"] } };`;
    const c = `export default { test: { exclude: [...configDefaults.exclude, "src/**"] } };`;
    expect(why("vitest.config.ts", b, c)).toEqual(["test.exclude: exclude changed to a computed value"]);
    expect(why(".nycrc", "{", "{}")).toEqual(["*: config could not be parsed statically; review the change"]);
  });
});
