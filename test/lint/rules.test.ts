import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintFiles } from "../../src/gates/lint/run.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { hitIds, lintSnippet, writeTree } from "./helpers.js";

const DYN = "nyorori/dynamic-code";
const HIDE = "nyorori/branch-hiding";

async function ids(code: string, file?: string) {
  return hitIds(await lintSnippet(code, file));
}

describe("dynamic code (block, spec 7.2 i / V17)", () => {
  it.each([
    ["new Function", `export const f = new Function("a", "return a");`, "no-new-func"],
    ["Function call", `export const r = Function("return 1")();`, "no-new-func"],
    ["Object.constructor.constructor", `export const f = Object.constructor.constructor("order", "user", body);`, `${DYN}:constructor`],
    ["arrow .constructor", `export const f = (() => {}).constructor("return 1");`, `${DYN}:constructor`],
    [
      "AsyncFunction constructor",
      `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\nexport const f = new AsyncFunction("x", "return x");`,
      `${DYN}:constructor`,
    ],
    ["GeneratorFunction constructor", `export const G = Object.getPrototypeOf(function* () {}).constructor;`, `${DYN}:constructor`],
    ["Reflect.construct(Function)", `export const f = Reflect.construct(Function, ["return 1"]);`, `${DYN}:functionValue`],
    ["Reflect.apply(Function)", `export const f = Reflect.apply(Function, null, ["return 1"]);`, `${DYN}:functionValue`],
    ["Function alias", `const F = Function;\nexport const f = F("return 1");`, `${DYN}:functionValue`],
    ["globalThis.Function", `export const f = globalThis.Function("return 1");`, `${DYN}:functionValue`],
    ["computed constructor", `export const f = (() => 0)["constructor"]("return 1");`, `${DYN}:constructor`],
    ["destructured constructor", `const { constructor: C } = () => {};\nexport const f = C("return 1");`, `${DYN}:destructure`],
    ["data: import", `export const m = import("data:text/javascript,export default 1");`, `${DYN}:dynamicImport`],
    ["non-literal import", `export const load = (p: string) => import(p);`, `${DYN}:dynamicImport`],
    ["vm import", `import vm from "node:vm";\nexport const ctx = vm;`, `${DYN}:vm`],
    ["vm require", `const vm = require("vm");\nexport default vm;`, `${DYN}:vm`],
    ["eval", `export const v = eval("1");`, "no-eval"],
    ["indirect eval", `export const v = (0, eval)("1");`, "no-eval"],
    ["globalThis.eval", `export const v = globalThis.eval("1");`, "no-eval"],
    ["string setTimeout", `setTimeout("doIt()", 10);`, "no-implied-eval"],
    ["worker eval", `export const w = new Worker("postMessage(1)", { eval: true });`, `${DYN}:workerEval`],
  ])("%s", async (_name, code, expected) => {
    expect(await ids(code)).toContain(expected);
  });

  it.each([
    ["clone via this.constructor", `export class A { clone() { return new (this as any).constructor(); } }`],
    ["constructor comparison", `export const same = (x: object, Foo: unknown) => x.constructor === Foo;`],
    ["constructor name", `export const n = (x: object) => x.constructor.name;`],
    ["instanceof Function", `export const isFn = (x: unknown) => x instanceof Function;`],
    ["Function as a type", `export function run(cb: Function): void { void cb; }`],
    ["literal import", `export const m = () => import("./mod.js");`],
    ["literal template import", "export const m = () => import(`./mod.js`);"],
    ["no-arg constructor read on class", `class K {}\nexport const k = new K();`],
  ])("no false positive: %s", async (_name, code) => {
    const hits = await ids(code);
    expect(hits.filter((h) => h.startsWith(DYN) || h.startsWith("no-new-func") || h.startsWith("no-eval"))).toEqual([]);
  });

  it("does not double-report new Function as a Function value", async () => {
    expect(await ids(`export const f = new Function("x");`)).toEqual(["no-new-func"]);
  });
});

describe("branch hiding (S9 trigger, spec 7.2 c/d/d′/f/f′/f″)", () => {
  it.each([
    ["(f) &&= with a write", `let ok = true; let total = 0;\nok &&= ((total -= 5), true);\nexport { ok, total };`, `${HIDE}:logicalAssignment`],
    ["(f) &&= with a call", `declare function apply(): boolean;\nlet ok = true;\nok &&= apply();\nexport { ok };`, `${HIDE}:logicalAssignment`],
    ["(d′) short-circuit IIFE", `declare const cond: boolean; let t = 0;\ncond && (() => { t -= 1; })();\nexport { t };`, `${HIDE}:shortCircuitStatement`],
    ["(d′) IIFE itself", `declare const cond: boolean; let t = 0;\ncond && (() => { t -= 1; })();\nexport { t };`, `${HIDE}:iife`],
    ["ternary statement", `declare function f(): void; declare function g(): void; declare const a: boolean;\na ? f() : g();`, `${HIDE}:shortCircuitStatement`],
    ["(f′) literal array by +cond", `declare const cond: boolean;\nexport const v = [1, 2][+cond];`, `${HIDE}:literalArrayIndex`],
    ["(f′) +(comparison) index", `declare const a: number;\nexport const v = [1, 2][+(a > 3)];`, `${HIDE}:booleanIndex`],
    ["(f′) Number(comparison) index", `declare const rates: number[]; declare const q: number;\nexport const r = rates[Number(q > 10)];`, `${HIDE}:booleanIndex`],
    ["(c) String(comparison) dispatch", `declare const BOOL: Record<string, () => number>; declare const a: number;\nexport const r = BOOL[String(a > 1)]();`, `${HIDE}:booleanIndex`],
    ["(f′) boolean arithmetic", `declare const q: number;\nexport const d = 5 * +(q > 10);`, `${HIDE}:booleanArithmetic`],
    ["(f′) arithmetic on comparison (js)", `export const d = (q) => 5 * (q > 10);`, `${HIDE}:booleanArithmetic`],
    ["(d) tiny array iteration", `declare const cond: boolean; declare function apply(): void;\n[cond].filter(Boolean).forEach(() => apply());`, `${HIDE}:tinyArrayIteration`],
    ["(f″) combinator definition", `export const when = (c: boolean, t: () => number, e: () => number) => (c ? t() : e());`, `${HIDE}:combinatorDefinition`],
    ["(f″) dispatcher definition", `export const match = (v: string, cases: Record<string, () => number>) => cases[v]();`, `${HIDE}:combinatorDefinition`],
    ["(f″) combinator call", `declare function when(c: boolean, a: () => number, b: () => number): number; declare const vip: boolean;\nexport const x = when(vip, () => 1, () => 2);`, `${HIDE}:combinatorCall`],
    ["(f″) match with case object", `declare function match(v: string, c: object): number; declare const k: string;\nexport const x = match(k, { a: () => 1, b: () => 2 });`, `${HIDE}:dispatchTable`],
    ["(c) dispatch variable", `declare const k: string;\nconst MAP: Record<string, () => number> = { a: () => 1, b: () => 2 };\nexport const x = MAP[k]();`, `${HIDE}:dispatchTable`],
    ["(c) true/false table", `declare const c: boolean;\nexport const x = ({ true: () => 1, false: () => 2 })[String(c) as "true"]();`, `${HIDE}:dispatchTable`],
  ])("%s", async (_name, code, expected) => {
    const file = _name.includes("(js)") ? "src/x.js" : "src/x.ts";
    expect(await ids(code, file)).toContain(expected);
  });

  it.each([
    ["memo ||=", `declare function compute(): number; let cache: number | undefined;\nexport const get = () => (cache ||= compute());`],
    ["memo ??=", `declare function load(): number; let v: number | undefined;\nexport function get() { v ??= load(); return v; }`],
    ["promise chain", `declare const p: Promise<number>;\nexport const r = [1, 2].map((x) => p.then((y) => y + x));`],
    [
      "handler map passed as values",
      `declare function go(): void; declare function show(): void; declare const el: HTMLElement;\nconst handlers = { onClick: () => go(), onHover: () => show() };\nel.addEventListener("click", handlers.onClick);`,
    ],
    ["exported api object", `export const api = { get: () => 1, put: () => 2 };`],
    ["top-level async entry", `declare function main(): Promise<void>;\n(async () => {\n  await main();\n})();`],
    ["async IIFE in an effect", `declare function useEffect(f: () => void): void; declare function load(): Promise<void>;\nuseEffect(() => {\n  void (async () => {\n    await load();\n  })();\n});`],
    ["plain forEach", `declare const items: number[]; declare function use(n: number): void;\nitems.forEach((i) => use(i));`],
    ["plain if", `declare function compute(): number; let cache: number | undefined;\nif (!cache) cache = compute();`],
    ["array literal index", `export const first = [1, 2][0];`],
    ["single fn arg call", `declare function debounce(f: () => void, ms: number): void;\ndebounce(() => {}, 10);`],
  ])("no false positive: %s", async (_name, code) => {
    expect((await ids(code)).filter((h) => h.startsWith(HIDE))).toEqual([]);
  });
});

describe("structural limits", () => {
  it("max-params blocks 5 parameters but not 4", async () => {
    expect(await ids(`export function f(a: number, b: number, c: number, d: number, e: number) { return a + b + c + d + e; }`)).toContain(
      "@typescript-eslint/max-params",
    );
    expect(await ids(`export function f(a: number, b: number, c: number, d: number) { return a + b + c + d; }`)).not.toContain(
      "@typescript-eslint/max-params",
    );
  });

  it("does not count a `this: void` parameter", async () => {
    expect(
      await ids(`export function f(this: void, a: number, b: number, c: number, d: number) { return a + b + c + d; }`),
    ).not.toContain("@typescript-eslint/max-params");
  });

  const nested4 = `declare function cb(f: () => void): void;\ncb(() => { cb(() => { cb(() => { cb(() => {}); }); }); });`;
  it("max-nested-callbacks blocks depth 4 in source", async () => {
    expect(await ids(nested4)).toContain("max-nested-callbacks");
  });
  it("max-nested-callbacks still reports in test files (evaluate makes it observe, D11)", async () => {
    expect(await ids(nested4, "src/x.test.ts")).toContain("max-nested-callbacks");
  });
  it("depth 3 callbacks pass", async () => {
    expect(await ids(`declare function cb(f: () => void): void;\ncb(() => { cb(() => { cb(() => {}); }); });`)).not.toContain(
      "max-nested-callbacks",
    );
  });

  it("long function is an S4 hit", async () => {
    const body = Array.from({ length: 61 }, (_, i) => `  x += ${i};`).join("\n");
    const r = await lintSnippet(`export function long() {\n  let x = 0;\n${body}\n  return x;\n}`);
    expect(r.messages.find((m) => m.ruleId === "max-lines-per-function")?.category).toBe("trigger:S4");
  });

  it("parameter property mutation by a directly called helper is an S10 hit", async () => {
    const r = await lintSnippet(
      `function step(ctx: { total: number }) { ctx.total = 1; }\nfunction floor(ctx: { total: number }) { ctx.total = Math.max(0, ctx.total); }\nexport function run(c: { total: number }) { step(c); floor(c); return c.total; }`,
    );
    expect(r.messages.find((m) => m.ruleId === "nyorori/param-mutation")?.category).toBe("trigger:S10");
  });

  it.each([
    ["exported, never called here", `export function step(ctx: { total: number }) { ctx.total = 1; }`],
    ["Immer recipe passed as a value", `declare function produce<T>(s: T, f: (d: T) => void): T;\nconst recipe = (draft: { n: number }) => { draft.n += 1; };\nexport const next = produce({ n: 1 }, recipe);`],
    ["Express middleware", `declare const app: { use(f: (req: { user?: string }) => void): void };\nfunction auth(req: { user?: string }) { req.user = "u"; }\napp.use(auth);`],
    ["a single mutating helper", `function step(ctx: { total: number }) { ctx.total = 1; }\nexport function run(c: { total: number }) { step(c); return c.total; }`],
    ["rebinding a parameter", `function inc(n: number) { n += 1; return n; }\nexport const x = inc(1);`],
  ])("no S10 hit: %s", async (_name, code) => {
    expect((await lintSnippet(code)).messages.filter((m) => m.category === "trigger:S10")).toEqual([]);
  });
});

describe("suppression directives", () => {
  it.each([
    ["// eslint-disable-next-line no-console, no-new-func\nconsole.log(1);", "eslint-disable-next-line no-console,no-new-func"],
    ["/* eslint-disable */\nexport {};", "eslint-disable"],
    ["// eslint-disable-line max-params -- reason\nexport {};", "eslint-disable-line max-params"],
    ["/* eslint no-new-func: off */\nexport {};", "eslint no-new-func: off"],
    ["// @ts-ignore\nexport const x: number = 'a';", "@ts-ignore"],
    ["// @ts-nocheck\nexport {};", "@ts-nocheck"],
    ["// @ts-expect-error\nexport const x: number = 'a';", "@ts-expect-error"],
    ["/* istanbul ignore next */\nexport const f = () => 1;", "istanbul ignore next"],
    ["/* v8 ignore start */\nexport const f = () => 1;", "v8 ignore start"],
    ["/* c8 ignore next */\nexport const f = () => 1;", "c8 ignore next"],
    ["// Stryker disable all\nexport {};", "Stryker disable all"],
  ])("%s", async (code, normalized) => {
    const r = await lintSnippet(code);
    expect(r.messages.filter((m) => m.ruleId === "nyorori/suppression-directive").map((m) => m.message)).toContain(normalized);
  });

  it("ignores directive-looking text in strings and ordinary comments", async () => {
    const r = await lintSnippet(`// see eslint docs\nexport const s = "// eslint-disable-line";\n// eslint-enable no-console\n/* global foo */`);
    expect(r.messages.filter((m) => m.ruleId === "nyorori/suppression-directive")).toEqual([]);
  });
});

describe("trust boundary", () => {
  it("never loads the candidate eslint config and ignores inline disables", async () => {
    const marker = join(writeTree({}), "MARKER");
    const root = writeTree({
      "eslint.config.js": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "pwned"); export default [{ rules: {} }];`,
      "eslint.config.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "pwned"); export default [];`,
      ".eslintrc.json": `{ "root": true, "rules": { "no-new-func": "off" } }`,
      "package.json": `{ "eslintConfig": { "rules": { "no-new-func": "off" } } }`,
      "src/a.ts": `/* eslint-disable */\n// eslint-disable-next-line no-new-func\nexport const f = new Function("return 1");\n`,
    });
    const results = await lintFiles(root, ["src/a.ts"], defaultPolicy());
    expect(existsSync(marker)).toBe(false);
    const ruleIds = results.get("src/a.ts")!.messages.map((m) => m.ruleId);
    expect(ruleIds).toContain("no-new-func");
    expect(ruleIds.filter((r) => r === "nyorori/suppression-directive")).toHaveLength(2);
  });

  it("reports parse errors instead of silently passing", async () => {
    const r = await lintSnippet(`export const = ;`);
    expect(r.parseError).toBeDefined();
    expect(r.messages).toEqual([]);
  });

  it("parses JSX in .js and generics in .ts", async () => {
    expect((await lintSnippet(`export const el = <div>{x && <b />}</div>;`, "src/x.js")).parseError).toBeUndefined();
    expect((await lintSnippet(`export const id = <T,>(x: T) => x;\nexport function g<T>(x: unknown) { return <T>x; }`)).parseError).toBeUndefined();
  });
});
