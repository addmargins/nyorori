// Regressions for the round-2 audit findings and rulings D8–D12, D17, D21c.

import { describe, expect, it } from "vitest";
import { lfPositionMapper } from "../../src/gates/lint/positions.js";
import { scanBidi } from "../../src/gates/lint/text.js";
import { hitIds, lintSnippet } from "./helpers.js";
import { lintScenario, reasons, triggerIds } from "./scenario.js";

const DYN = "nyorori/dynamic-code";
const HIDE = "nyorori/branch-hiding";

describe("audit bug #2: LF-based positions", () => {
  // ESLint counts U+2028/U+2029/CR as line breaks; git and cccc count only LF.
  const B = `function x(a: string) {\n  return a;\n}\nfunction y(s: string) {\n  return eval(s);\n}\n`;
  // The separators sit in a comment: a raw CR inside a string literal would not parse.
  const C = (pad: string) => `/* ${pad} */ const sep = 1;\nfunction x(a: string) {\n  return eval(a);\n}\nfunction y(s: string) {\n  return s;\n}\n`;

  it.each([
    ["plain", "plain"],
    ["U+2028 x3", "\u2028\u2028\u2028"],
    ["U+2029", "\u2029"],
    ["lone CR", "\r\r"],
  ])("eval moved from y into x is new in x (%s)", async (_name, pad) => {
    const e = await lintScenario({ b: { "a.ts": B }, c: { "a.ts": C(pad) } });
    expect(e.violations.map((v) => [v.reason, v.unit, v.line])).toEqual([["DYNAMIC_CODE", "a.ts::x#function[0]", 3]]);
  });

  it("maps ESLint positions to LF lines", () => {
    const map = lfPositionMapper("a\u2028b\r\nc\rd\ne");
    expect(map(2, 1)).toEqual({ line: 1, column: 3 }); // b
    expect(map(3, 1)).toEqual({ line: 2, column: 1 }); // c
    expect(map(4, 1)).toEqual({ line: 2, column: 3 }); // d
    expect(map(5, 1)).toEqual({ line: 3, column: 1 }); // e
  });

  it("scanBidi counts LF lines only", () => {
    expect(scanBidi("x\u2028y\n\u202E")).toEqual([{ line: 2, column: 1, codePoint: "U+202E" }]);
  });
});

describe("audit F7: dynamic-code gaps", () => {
  it.each([
    ["non-literal require", `export function a(code: string) { const vm = require("v" + "m"); return vm.runInThisContext(code); }`, "vm"],
    ["require(variable)", `export const load = (p: string) => require(p);`, "dynamicRequire"],
    ["require.call", `export const load = (p: string) => require.call(null, p);`, "dynamicRequire"],
    ["require.apply", `export const load = (p: string) => require.apply(null, [p]);`, "dynamicRequire"],
    ["module.require", `export const load = (p: string) => module.require(p);`, "dynamicRequire"],
    ["createRequire()()", `import { createRequire } from "node:module";\nexport const load = (p: string) => createRequire(import.meta.url)(p);`, "dynamicRequire"],
    ["createRequire alias", `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const load = (p: string) => req(p);`, "dynamicRequire"],
    ["aliased global computed eval", `export function b(code: string) { const g: any = globalThis; return g["ev" + "al"](code); }`, "evalAccess"],
    ["aliased global eval", `export function b(code: string) { const g: any = globalThis; return g.eval(code); }`, "evalAccess"],
    ["global computed call", `export function b(k: string, code: string) { return (globalThis as any)[k](code); }`, "globalComputedCall"],
    ["getPrototypeOf constructor", `export function c() { return Object.getPrototypeOf(function () {}).constructor; }`, "constructor"],
    ["const key constructor", `export function d(code: string) { const k = "constructor"; return (() => 0)[k]("o", code); }`, "constructor"],
    ["folded key constructor", `export function d(code: string) { return (() => 0)["constr" + "uctor"]("o", code); }`, "constructor"],
    ["Reflect.get constructor", `export function e(code: string) { return Reflect.get(() => 0, "construct" + "or")("o", code); }`, "constructor"],
    ["const import specifier vm", `export function f() { const m = "node:vm"; return import(m); }`, "vm"],
    ["module _compile", `export function g() { return require("module").prototype._compile; }`, "moduleInternals"],
    ["require.extensions", `export function g() { return (require as any)._extensions; }`, "moduleInternals"],
    ["worker eval via computed require", `export function i(code: string) { return new (require("node:" + "worker_threads").Worker)(code, { eval: true }); }`, "workerEval"],
    ["process.binding", `export function j() { return process.binding("contextify"); }`, "nativeBinding"],
    ["process.dlopen", `export function j(m: object) { return process.dlopen(m, "x.node"); }`, "nativeBinding"],
    ["computed destructure", `export function k() { const { ["constr" + "uctor"]: C } = (() => 0) as any; return C; }`, "destructure"],
    ["setTimeout(string param)", `export function l(code: string) { return setTimeout(code); }`, "impliedEval"],
    ["setTimeout(const string)", `const code = "go()";\nexport const t = () => setTimeout(code, 1);`, "impliedEval"],
    ["descriptor of Function.prototype", `export function m(code: string) { return Object.getOwnPropertyDescriptor(Function.prototype, "constructor")!.value("o", code); }`, "constructor"],
  ])("%s", async (_name, code, messageId) => {
    expect(await idsOf(code)).toContain(`${DYN}:${messageId}`);
  });

  it.each([
    ["alias then call", `function g() {}\nconst F = g.constructor;\nexport const price = F("o", "return o.total * 2");`],
    [".constructor.call", `function g() {}\nexport const price = g.constructor.call(null, "o", "return o.total * 2");`],
    [".constructor.bind", `function g() {}\nexport const price = g.constructor.bind(null)("o", "return 1");`],
    ["Reflect.apply", `function g() {}\nexport const price = Reflect.apply(g.constructor, null, ["o", "return 1"]);`],
    ["array index", `function g() {}\nexport const price = [g.constructor][0]("o", "return 1");`],
    ["object literal", `function g() {}\nconst t = { F: g.constructor };\nexport const price = t.F("o", "return 1");`],
    ["param constructor", `export function mk(fn: Function) { const F = fn.constructor; return F("o", "return 1"); }`],
    ["returned", `function g() {}\nexport function mk() { return g.constructor; }`],
    ["template key", "function g() {}\nexport const price = g[`constructor`](\"o\", \"return 1\");"],
    ["computed const key, escaping", `function g() {}\nconst k = "constr" + "uctor";\nconst F = g[k];\nexport const price = F("o", "return 1");`],
    ["optional chain", `declare const g: any;\nexport const F = g?.constructor;`],
    ["conditional", `declare const g: any; declare const h: any;\nexport const F = (g ? g.constructor : h.constructor);`],
    ["new", `function g() {}\nexport const price = new g.constructor("o", "return 1");`],
    ["Reflect.construct", `function g() {}\nexport const price = Reflect.construct(g.constructor, ["o", "return 1"]);`],
    ["Reflect.get then call", `declare const g: any;\nexport const price = Reflect.get(g, "constructor")("o", "return 1");`],
    ["yield", `declare const g: any;\nexport function* it() { yield g.constructor; }`],
    ["await", `declare const g: any;\nexport async function f() { return await g.constructor; }`],
    ["tagged template", `declare const g: any; declare const tag: any;\nexport const price = tag\`\${g.constructor}\`;`],
    ["spread into call", `declare const g: any; declare const run: any;\nexport const price = run(...[g.constructor]);`],
    ["folded .call key", `function g() {}\nexport const price = g.constructor["ca" + "ll"](null, "o", "return 1");`],
    ["arrow body", `declare const g: any;\nexport const F = () => g.constructor;`],
    ["logical fallback", `declare const g: any; declare const Y: any;\nexport const F = g.constructor || Y;`],
    ["alias of alias then call", `function g() {}\nexport function mk() { const a = g.constructor; const b = a; return b("o", "return 1"); }`],
    ["let alias reassigned", `function g() {}\nexport function mk() { let a = g.constructor; a = a; return a; }`],
    ["alias passed on", `declare const g: any; declare const run: any;\nexport function mk() { const a = g.constructor; run(a); }`],
  ])("constructor value escape: %s", async (_name, code) => {
    expect(await idsOf(code)).toContain(`${DYN}:constructor`);
  });

  it.each([
    ["name read", `export function tag(x: object) { return x.constructor.name; }`],
    ["equality", `export const same = (x: object, Y: unknown) => x.constructor === Y;`],
    ["typeof", `export const t = (x: object) => typeof x.constructor;`],
    ["if test", `export const f = (x: any) => { if (x.constructor) return 1; return 0; }`],
    ["instanceof right", `declare const x: any;\nexport const i = (y: object) => y instanceof x.constructor;`],
    ["prototype wiring write", `function Base() {}\nfunction Child() {}\nChild.prototype = Object.create(Base.prototype);\nChild.prototype.constructor = Child;`],
    ["this.constructor clone", `export class A { clone() { return new (this as any).constructor(); } }`],
    ["property key string", `export const keys = { constructor: 1 };\nexport const has = (o: object) => "constructor" in o;`],
    ["negation", `export const none = (x: any) => !x.constructor;`],
    ["reversed equality", `export const same = (x: object, Y: unknown) => Y === x.constructor;`],
    ["delete", `export const drop = (x: any) => { delete x.constructor; };`],
    ["string interpolation", `export const label = (x: object) => \`\${x.constructor}\`;`],
    ["computed key", `export const byCtor = (x: object, m: Record<string, number>) => m[x.constructor as any];`],
    ["object literal key", `export const byCtor = (x: object) => ({ [x.constructor as any]: 1 });`],
    ["for-in", `export const keys = (x: object) => { const out = []; for (const k in x.constructor) out.push(k); return out; };`],
    ["this alias in class", `export class A { clone() { const self = this; return new (self as any).constructor(); } }`],
    ["self alias passed", `export class A { make() { const self = this as any; return Reflect.construct(self.constructor, []); } }`],
    ["array literal object", `export const A = [].constructor;\nexport const O = ({}).constructor;\nexport const S = "".constructor;`],
    ["prototype of named class", `class Foo {}\nexport const F = Foo.prototype.constructor;`],
    ["Reflect.get compared", `declare const g: any; declare const Y: any;\nexport const same = Reflect.get(g, "constructor") === Y;`],
    ["if-test logical", `export const f = (x: any, y: any) => { if (x.constructor && y) return 1; return 0; }`],
    ["isPlainObject idiom", `export function isPlain(o: any) { const ctor = o.constructor; if (ctor === undefined) return true; const prot = ctor.prototype; return typeof prot === "object" && ctor.name !== "X"; }`],
  ])("constructor stays clean: %s", async (_name, code) => {
    expect((await idsOf(code)).filter((h) => h.startsWith(DYN))).toEqual([]);
  });

  it("every function of the audit repro is blocked", async () => {
    const repro = [
      `export function a(code: string) { const vm = require("v" + "m"); return vm.runInThisContext(code); }`,
      `export function b(code: string) { const g: any = globalThis; return g["ev" + "al"](code); }`,
      `export function c(code: string) { const F = Object.getPrototypeOf(function () {}).constructor; return F; }`,
      `export function d(code: string) { const k = "constructor"; return (() => 0)[k]("o", code); }`,
      `export function e(code: string) { return Reflect.get(() => 0, "construct" + "or")("o", code); }`,
      `export function f(code: string) { const m = "node:vm"; return import(m); }`,
      `export function g(code: string) { return require("module").prototype._compile; }`,
      `export function h(code: string) { return (0, eval)(code); }`,
      `export function i(code: string) { return new (require("node:" + "worker_threads").Worker)(code, { eval: true }); }`,
      `export function j(code: string) { return process.binding("contextify"); }`,
      `export function k(code: string) { const { constructor: C } = (() => 0) as any; return C; }`,
      `export function l(code: string) { return setTimeout(code); }`,
      `export function m(code: string) { const p = Object.getOwnPropertyDescriptor(Function.prototype, "constructor")!; return p.value("o", code); }`,
    ];
    const r = await lintSnippet(repro.join("\n"));
    const blockedLines = new Set(r.messages.filter((m) => m.category === "block").map((m) => m.line));
    expect([...blockedLines].sort((x, y) => x - y)).toEqual(repro.map((_, i) => i + 1));
  });

  it("indirect eval stays core no-eval", async () => {
    expect(await idsOf(`export function h(code: string) { return (0, eval)(code); }`)).toContain("no-eval");
  });

  it.each([
    ["literal require", `const fs = require("node:fs");\nexport default fs;`],
    ["createRequire of a literal", `import { createRequire } from "node:module";\nexport const pkg = createRequire(import.meta.url)("./package.json");`],
    ["map dispatch by key", `declare const handlers: Record<string, () => void>; declare const k: string;\nhandlers[k]();`],
    ["this[method]()", `export class A { run(m: "a" | "b") { return (this as any)[m](); } a() { return 1; } b() { return 2; } }`],
    ["legacy prototype wiring", `function Base() {}\nfunction Child() {}\nChild.prototype = Object.create(Base.prototype);\nChild.prototype.constructor = Child;`],
    ["window property read", `export const href = () => window.location.href;`],
    ["process.env", `export const env = () => process.env.NODE_ENV;`],
    ["setTimeout(callback)", `export const later = (cb: () => void) => setTimeout(cb, 10);`],
  ])("no false positive: %s", async (_name, code) => {
    expect((await idsOf(code)).filter((h) => h.startsWith(DYN))).toEqual([]);
  });

  it("dynamic_code_allowlist turns a hit into observe", async () => {
    const code = `export const load = (p: string) => require(p);\n`;
    const plain = await lintScenario({ b: {}, c: { "src/loader.ts": code } });
    expect(reasons(plain)).toEqual(["DYNAMIC_CODE"]);
    const allowed = await lintScenario({ b: {}, c: { "src/loader.ts": code }, policy: { lint: { dynamic_code_allowlist: ["src/loader.ts"] } } });
    expect(allowed.violations).toEqual([]);
    expect(allowed.observe.new_observe_hits.map((h) => h.why)).toEqual(["lint.dynamic_code_allowlist"]);
  });
});

describe("ruling D10: template-literal import()", () => {
  const run = (code: string, file = "src/i18n.ts", policy?: object) =>
    lintScenario({ b: {}, c: { [file]: code }, ...(policy ? { policy } : {}) });

  it("data suffix from a fixed directory is observe", async () => {
    const e = await run("export const load = (l: string) => import(`./locales/${l}.json`);\n");
    expect(e.violations).toEqual([]);
    expect(e.triggers).toEqual([]);
    expect(e.observe.new_observe_hits).toHaveLength(1);
  });

  it("code suffix from a fixed directory is S11", async () => {
    const e = await run("export const load = (p: string) => import(`./plugins/${p}.js`);\n");
    expect(e.violations).toEqual([]);
    expect(triggerIds(e)).toEqual(["S11"]);
  });

  it.each([
    ["no directory", "export const load = (p: string) => import(`./${p}.js`);\n"],
    ["parent directory", "export const load = (p: string) => import(`../x/${p}.js`);\n"],
    ["computed head", "export const load = (d: string, p: string) => import(`${d}/${p}.js`);\n"],
    ["vendor directory", "export const load = (p: string) => import(`./vendor/${p}.js`);\n"],
  ])("%s stays DYNAMIC_CODE", async (_name, code) => {
    expect(reasons(await run(code))).toEqual(["DYNAMIC_CODE"]);
  });

  it("policy-excluded directory stays DYNAMIC_CODE", async () => {
    const e = await run("export const load = (p: string) => import(`./gen/${p}.json`);\n", "src/i18n.ts", { scope: { exclude: ["src/gen/**"] } });
    expect(reasons(e)).toEqual(["DYNAMIC_CODE"]);
  });
});

describe("ruling D8: logical assignment", () => {
  it.each([
    ["awaited memo", `export class S { c?: number; async get(create: () => Promise<number>) { this.c ??= await create(); return this.c; } }`],
    ["sync memo", `declare function compute(): number; let cache: number | undefined;\nexport const get = () => (cache ||= compute());`],
  ])("clean: %s", async (_name, code) => {
    expect((await idsOf(code)).filter((h) => h.startsWith(HIDE))).toEqual([]);
  });

  it("||= on a boolean flag with a call is S9", async () => {
    expect(await idsOf(`declare function step(): boolean;\nexport function run() { let done = false;\n  done ||= step();\n  return done; }`)).toContain(
      `${HIDE}:logicalAssignmentFlag`,
    );
  });

  it("an awaited call with a write is still S9", async () => {
    expect(await idsOf(`declare function f(n: number): Promise<number>; let i = 0; let c: number | undefined;\nexport const g = async () => (c ??= await f(i++));`)).toContain(
      `${HIDE}:logicalAssignment`,
    );
  });
});

describe("ruling D17: new S9 selectors", () => {
  it.each([
    ["switch (true)", `export function f(n: number) { switch (true) { case n > 1: return 1; default: return 0; } }`, "switchTrue"],
    ["assignment in && operand", `let t = 0;\nexport const f = (ok: boolean) => ok && (t -= 5);`, "assignmentInOperand"],
    ["update in ?: operand", `let t = 0;\nexport const f = (ok: boolean) => [ok ? t++ : t--];`, "assignmentInOperand"],
    ["alias recursion inside", `export function f(n: number): number { const g = f; return n > 0 ? g(n - 1) + 1 : 0; }`, "aliasRecursion"],
    ["alias recursion at module level", `export function f(n: number): number { return n > 0 ? g(n - 1) + 1 : 0; }\nconst g = f;`, "aliasRecursion"],
    ["bound alias recursion", `export function f(n: number): number { return n > 0 ? h(n - 1) + 1 : 0; }\nconst h = f.bind(null);`, "aliasRecursion"],
  ])("%s", async (_name, code, messageId) => {
    expect(await idsOf(code)).toContain(`${HIDE}:${messageId}`);
  });

  it.each([
    ["lazy init x || (x = …)", `let x: number[] | undefined;\nexport const get = () => x || (x = []);`],
    ["lazy init x ?? (x = …)", `let x: number[] | undefined;\nexport const get = () => x ?? (x = []);`],
    ["regex loop test", `export function all(re: RegExp, s: string) { let m; const out = []; while ((m = re.exec(s)) && m.index >= 0) out.push(m); return out; }`],
    ["assignment in a callback operand", `declare const xs: number[]; let t = 0;\nexport const f = (ok: boolean) => ok && xs.forEach((x) => { t += x; });`],
    ["direct recursion", `export function f(n: number): number { return n > 0 ? f(n - 1) + 1 : 0; }`],
    ["switch on a value", `export function f(n: number) { switch (n) { case 1: return 1; default: return 0; } }`],
  ])("no false positive: %s", async (_name, code) => {
    expect((await idsOf(code)).filter((h) => h.startsWith(HIDE))).toEqual([]);
  });
});

describe("rulings D9 + D14: suppression scope", () => {
  const added = (directive: string, isAiLoop = false) =>
    lintScenario({
      b: { "src/s.ts": `export const a = 1;\n` },
      c: { "src/s.ts": `export const a = 1;\n${directive}\nexport const b: number = 2;\n` },
      isAiLoop,
    });

  it.each([
    ["// eslint-disable-next-line", "SUPPRESSION_ADDED"],
    ["/* eslint-disable */", "SUPPRESSION_ADDED"],
    ["// eslint-disable-next-line no-new-func", "SUPPRESSION_ADDED"],
    ["// eslint-disable-next-line no-console, @typescript-eslint/max-params", "SUPPRESSION_ADDED"],
    ["/* eslint no-new-func: off */", "SUPPRESSION_ADDED"],
    ["// @ts-nocheck", "SUPPRESSION_ADDED"],
    ["/* istanbul ignore next */", "SUPPRESSION_ADDED"],
    ["/* v8 ignore next */", "SUPPRESSION_ADDED"],
    ["/* c8 ignore next */", "SUPPRESSION_ADDED"],
    ["// Stryker disable all", "SUPPRESSION_ADDED"],
    ["// @ts-ignore", "SUPPRESSION_ADDED_WAIVABLE"],
  ])("%s → %s", async (directive, reason) => {
    const e = await added(directive);
    expect(reasons(e)).toEqual([reason]);
    expect(e.violations[0]!.details?.waivable).toBe(reason === "SUPPRESSION_ADDED_WAIVABLE");
  });

  it.each(["// @ts-expect-error", "// eslint-disable-next-line no-console", "/* eslint max-params: off */"])("%s is observe for humans", async (directive) => {
    const e = await added(directive);
    expect(e.violations).toEqual([]);
    expect(e.observe.new_observe_hits).toHaveLength(1);
  });

  it.each(["// @ts-expect-error", "// eslint-disable-next-line no-console", "// @ts-ignore"])("%s fails non-waivably for the AI loop", async (directive) => {
    expect(reasons(await added(directive, true))).toEqual(["SUPPRESSION_ADDED"]);
  });

  it("test files: the non-waivable suppressions still block", async () => {
    const e = await lintScenario({
      b: { "src/a.test.ts": `export {};\n` },
      c: { "src/a.test.ts": `export {};\n/* eslint-disable */\n` },
      tests: ["src/a.test.ts"],
    });
    expect(reasons(e)).toEqual(["SUPPRESSION_ADDED"]);
  });
});

describe("ruling D11: test files", () => {
  const nested = `declare function cb(f: () => void): void;\ncb(() => { cb(() => { cb(() => { cb(() => {}); }); }); });\n`;
  const five = `export function h(a: number, b: number, c: number, d: number, e: number) { return a + b + c + d + e; }\n`;
  const long = `export function big() {\n  let x = 0;\n${Array.from({ length: 61 }, (_, i) => `  x += ${i};`).join("\n")}\n  return x;\n}\n`;
  const hiding = `declare const c: boolean; declare function f(): void;\nc && f();\n`;
  const code = `${nested}${five}${long}${hiding}export const ev = (s: string) => eval(s);\n`;

  it("max-params, max-nested-callbacks, S4, S9 are observe; DYNAMIC_CODE blocks", async () => {
    const e = await lintScenario({ b: {}, c: { "src/x.test.ts": code }, tests: ["src/x.test.ts"] });
    expect(reasons(e)).toEqual(["DYNAMIC_CODE"]);
    expect(e.triggers).toEqual([]);
    expect(e.observe.new_observe_hits.map((h) => h.rule).sort()).toEqual(
      expect.arrayContaining(["@typescript-eslint/max-params", "max-nested-callbacks", "max-lines-per-function", "nyorori/branch-hiding"]),
    );
  });

  it("the same code in a product file blocks and routes", async () => {
    const e = await lintScenario({ b: {}, c: { "src/x.ts": code } });
    expect(reasons(e).sort()).toEqual(["DYNAMIC_CODE", "LINT_NEW_VIOLATION", "LINT_NEW_VIOLATION"]);
    expect(new Set(triggerIds(e))).toEqual(new Set(["S4", "S9"]));
  });
});

describe("ruling D12: S4 statements path", () => {
  it("fires on 31 statements in 31 lines", async () => {
    const body = Array.from({ length: 31 }, (_, i) => `  t += o.a${i};`).join("\n");
    const e = await lintScenario({ b: {}, c: { "src/s.ts": `export function f(o: any) {\n  let t = 0;\n${body}\n  return t;\n}\n` } });
    expect(triggerIds(e)).toEqual(["S4"]);
    expect(e.triggers[0]!.evidence).toContain("statements");
  });

  it("fires on statements compressed onto few lines (audit s4 repro)", async () => {
    const pairs = Array.from({ length: 20 }, (_, i) => `t += o.a${i} * 2; t -= o.b${i};`).join(" ");
    const e = await lintScenario({ b: {}, c: { "src/s.ts": `export function long(o: any) {\n  let t = 0;\n  ${pairs}\n  return t;\n}\n` } });
    expect(triggerIds(e)).toEqual(["S4"]);
  });

  it("one S4 per unit when both paths fire", async () => {
    const body = Array.from({ length: 70 }, (_, i) => `  x += ${i};`).join("\n");
    const e = await lintScenario({ b: {}, c: { "src/s.ts": `export function f() {\n  let x = 0;\n${body}\n  return x;\n}\n` } });
    expect(triggerIds(e)).toEqual(["S4"]);
  });
});

describe("ruling D21c: unmatched units credit vanished baseline hits", () => {
  const evalFn = (name: string) => `export function ${name}(s: string) {\n  return eval(s);\n}\n`;

  it("a renamed-and-reshaped function keeps its existing hit", async () => {
    const e = await lintScenario({
      b: { "src/a.ts": `${evalFn("oldName")}export const k = 1;\n` },
      c: { "src/a.ts": `export const k = 1;\nexport const z = 2;\n${evalFn("newName").replace("return", "const v = 1;\n  return v + ")}` },
    });
    expect(reasons(e)).toEqual([]);
  });

  it("a function moved to a new file keeps its existing hit (PR-level)", async () => {
    const e = await lintScenario({
      b: { "src/a.ts": `${evalFn("f")}export const k = 1;\n` },
      c: { "src/a.ts": `export const k = 1;\n`, "src/b.ts": `${evalFn("g")}` },
    });
    expect(reasons(e)).toEqual([]);
  });

  it("fixing a hit in a kept unit does not pay for a new one (no offsetting)", async () => {
    const e = await lintScenario({
      b: { "src/a.ts": evalFn("f") },
      c: { "src/a.ts": `export function f(s: string) {\n  return s;\n}\n${evalFn("g")}` },
    });
    expect(reasons(e)).toEqual(["DYNAMIC_CODE"]);
  });

  it("a second copy is still new", async () => {
    const e = await lintScenario({
      b: { "src/a.ts": evalFn("f") },
      c: { "src/a.ts": `${evalFn("f")}${evalFn("g")}` },
    });
    expect(e.violations.map((v) => v.unit)).toEqual(["src/a.ts::g#function[0]"]);
  });
});

async function idsOf(code: string): Promise<string[]> {
  return hitIds(await lintSnippet(code));
}
