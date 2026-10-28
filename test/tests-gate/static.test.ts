import { describe, expect, it } from "vitest";
import { findIgnoreComments, scanTestSource } from "../../src/gates/tests/static.js";

const SRC = `
import { describe, it, test, expect } from "vitest";
describe("cart", () => {
  describe.each([1, 2])("size %i", (n) => {
    it("adds", () => { expect(n).toBeGreaterThan(0); });
  });
  it.only("focused", async () => {
    await expect(load()).resolves.toEqual({ a: 1 });
    expect.soft(x).not.toBe(2);
  });
  it.concurrent.skip("skipped", () => {});
  test.skipIf(process.env.CI)("conditional", () => { assert.equal(1, 1); });
  it.todo("later");
  xit("disabled", () => {});
  it("weak", () => {
    expect(fn).toThrow();
    expect(v).toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.anything());
    expect(tree).toMatchInlineSnapshot(\`"<div/>"\`);
  });
  it(\`dynamic \${name}\`, () => { expectValid(x); });
  it("declares", () => { expect.assertions(1); });
  it("runtime skip", (ctx) => { if (x) ctx.skip(); expect(1).toBe(1); });
  it("destructured skip", ({ skip }) => { skip(); });
  it("nothing", () => { const iterator = items.values(); iterator.next(); });
});
`;

describe("static test scan", () => {
  const scan = scanTestSource("src/cart.test.ts", SRC);
  const byTitle = (t: string) => scan.cases.find((c) => c.title === t)!;

  it("recovers the test tree with ancestors and markers", () => {
    expect(scan.syntaxErrors).toBe(0);
    expect(byTitle("adds")).toMatchObject({ ancestors: ["cart", "size %i"], kind: "test", assertionCount: 1 });
    expect(byTitle("size %i")).toMatchObject({ kind: "suite", parameterized: true });
    expect(byTitle("focused").markers).toEqual(["only"]);
    expect(byTitle("skipped").markers).toEqual(["skip"]);
    expect(byTitle("conditional").markers).toEqual(["skipIf"]);
    expect(byTitle("later").markers).toEqual(["todo"]);
    expect(byTitle("disabled").markers).toEqual(["x"]);
  });

  it("counts assertions through modifiers and classifies matcher strength", () => {
    const f = byTitle("focused");
    expect(f.assertionCount).toBe(2);
    expect(f.matchers.map((m) => [m.name, m.negated, m.strength])).toEqual([
      ["toEqual", false, "strong"],
      ["toBe", true, "weak"],
    ]);
    const w = byTitle("weak");
    expect(w.matchers.map((m) => m.strength)).toEqual(["weak", "weak", "weak", "snapshot"]);
    expect(w.inlineSnapshots).toEqual(['`"<div/>"`']);
    expect(byTitle("conditional").assertionCount).toBe(1);
  });

  it("treats helper assertions and expect.assertions as assertions", () => {
    const d = scan.cases.find((c) => !c.literalTitle)!;
    expect(d.title).toBe("<expr:`dynamic ${name}`>");
    expect(d.assertionCount).toBe(1);
    expect(byTitle("declares")).toMatchObject({ assertionCount: 0, hasAssertionDeclaration: true });
    expect(byTitle("nothing").assertionCount).toBe(0);
  });

  it("finds runtime skips", () => {
    expect(byTitle("runtime skip").runtimeSkips).toBe(1);
    expect(byTitle("destructured skip").runtimeSkips).toBe(1);
    expect(byTitle("adds").runtimeSkips).toBe(0);
  });

  it("ignores non-test uses of it/test identifiers", () => {
    const s = scanTestSource("a.test.ts", "const it = gen(); it.next(); test.extend({})('x', () => {});");
    expect(s.cases).toEqual([]);
  });

  it("finds coverage ignore hints of every provider", () => {
    const c = findIgnoreComments("a\n/* istanbul ignore next */\nb /* v8 ignore start */ c\n/* c8  ignore   else */");
    expect(c.map((x) => [x.directive, x.line])).toEqual([
      ["istanbul ignore next", 2],
      ["v8 ignore start", 3],
      ["c8 ignore else", 4],
    ]);
  });
});
