import { describe, expect, it } from "vitest";
import { codeLineCount, normalizedLineCount, normalizedLineCounts } from "../../src/measure/normalize.js";

describe("normalizedLineCount", () => {
  it("is independent of the author's formatting", async () => {
    const dense = "export function f(a:number,b:number){if(a){return b}else{return a}}\n";
    const airy = `export function f(
  a: number,
  b: number,
) {


  if (a) {
    return b;
  } else {
    return a;
  }
}
`;
    expect(await normalizedLineCount(dense, "x.ts")).toBe(await normalizedLineCount(airy, "x.ts"));
  });

  it("does not count comment-only lines, so padding or stripping comments changes nothing", async () => {
    const plain = "export const a = 1;\nexport const b = 2;\n";
    const padded = "// one\n/* two\n   three */\nexport const a = 1; // tail\n/** doc */\nexport const b = 2;\n";
    expect(await normalizedLineCount(padded, "x.ts")).toBe(await normalizedLineCount(plain, "x.ts"));
    expect(await normalizedLineCount(plain, "x.ts")).toBe(2);
  });

  it("counts multi-line template literals fully", () => {
    expect(codeLineCount("const s = `a\nb\nc`;\n", false)).toBe(3);
  });

  it("handles TSX and JSX", async () => {
    expect(await normalizedLineCount("export const A = () => <div>{x && <b/>}</div>;\n", "a.tsx")).toBeGreaterThan(0);
    expect(await normalizedLineCount("export const A = () => <div>{x && <b/>}</div>;\n", "a.js")).toBeGreaterThan(0);
  });

  it("returns null on syntax errors and unknown extensions", async () => {
    expect(await normalizedLineCount("export function (", "x.ts")).toBeNull();
    expect(await normalizedLineCount("x", "x.vue")).toBeNull();
  });

  it("normalizedLineCounts keys by the C path (B path for deletions)", async () => {
    const b = new Map([["old.ts", "export const a = 1;\n"]]);
    const c = new Map([["new.ts", "export const a = 1;\nexport const b = 2;\n"]]);
    const out = await normalizedLineCounts(b, c, [{ b: "old.ts", c: "new.ts" }, { b: "gone.ts", c: null }]);
    expect(out.get("new.ts")).toEqual({ B: 1, C: 2 });
    expect(out.get("gone.ts")).toEqual({});
  });
});
