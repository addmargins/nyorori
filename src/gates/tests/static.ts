// Syntactic scan of test files with the TypeScript parser (no type checker,
// no tsconfig: the candidate's config is untrusted). It recovers the test
// tree, focus/skip markers, assertions per test and matcher strength.
//
// Out of scope by design: custom test functions created with `test.extend`
// or wrappers, `t.is`-style (ava/tap) assertions, and assertions inside helper
// functions defined elsewhere. Calls to identifiers named `expect*`/`assert*`/
// `verify*`/`check*` count as helper assertions so a shared helper does not
// make every test look assertion-free.

import ts from "typescript";
import { normalizeTitle } from "./report.js";

export type MarkerKind =
  | "only"
  | "skip"
  | "todo"
  | "fails"
  | "skipIf"
  | "runIf"
  | "x" // xit / xtest / xdescribe
  | "f"; // fit / fdescribe / ftest

export const FOCUS_SKIP_MARKERS: ReadonlySet<MarkerKind> = new Set([
  "only",
  "skip",
  "todo",
  "fails",
  "skipIf",
  "runIf",
  "x",
  "f",
]);

export type MatcherStrength = "strong" | "weak" | "snapshot" | "other";

export interface MatcherUse {
  name: string;
  negated: boolean;
  strength: MatcherStrength;
  line: number;
}

export interface StaticTestCase {
  kind: "test" | "suite";
  file: string;
  /** Static key: [file, ...ancestor titles, title] with non-literal titles as `<expr:source>`. */
  key: string;
  ancestors: string[];
  title: string;
  literalTitle: boolean;
  line: number;
  markers: MarkerKind[];
  /** `.each` / `.for`: one source case produces several runtime tests. */
  parameterized: boolean;
  assertionCount: number;
  hasAssertionDeclaration: boolean;
  matchers: MatcherUse[];
  /** Source text of `toMatchInlineSnapshot(...)` arguments, in order. */
  inlineSnapshots: string[];
  /** Runtime skip calls inside the body (`ctx.skip()`, destructured `skip()`). */
  runtimeSkips: number;
}

export interface IgnoreComment {
  tool: "istanbul" | "v8" | "c8";
  directive: string;
  line: number;
  text: string;
}

export interface StaticScan {
  file: string;
  cases: StaticTestCase[];
  ignoreComments: IgnoreComment[];
  syntaxErrors: number;
}

const TEST_BASES = new Set(["it", "test", "xit", "xtest", "fit", "ftest", "bench"]);
const SUITE_BASES = new Set(["describe", "suite", "xdescribe", "fdescribe", "context"]);
const MODIFIERS: Record<string, MarkerKind | null> = {
  only: "only",
  skip: "skip",
  todo: "todo",
  fails: "fails",
  failing: "fails",
  skipIf: "skipIf",
  runIf: "runIf",
  concurrent: null,
  sequential: null,
  shuffle: null,
  each: null,
  for: null,
};

const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  "toMatchFileSnapshot",
]);
const WEAK_MATCHERS = new Set([
  "toBeDefined",
  "toBeUndefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeTypeOf",
  "toHaveBeenCalled",
  "toBeCalled",
  "toHaveReturned",
  "toBeOneOf",
]);
const STRONG_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toThrow",
  "toThrowError",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toBeCalledWith",
  "toHaveBeenCalledTimes",
  "toBeCalledTimes",
  "toHaveReturnedWith",
  "toHaveLength",
  "toContain",
  "toContainEqual",
  "toHaveProperty",
  "toMatch",
  "toBeNull",
  "toBeNaN",
  "toBeCloseTo",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeInstanceOf",
  "toSatisfy",
  "toEqualTypeOf",
  "toMatchTypeOf",
  "resolves",
  "rejects",
]);
const CHAIN_MODIFIERS = new Set(["not", "resolves", "rejects", "soft", "poll"]);
const HELPER_ASSERTION = /^(expect|assert|verify|check|should)([A-Z_]|$)/;

interface CalleeChain {
  base: string;
  props: string[];
}

/** `it.concurrent.only`, `test.skipIf(x)`, `it.each(table)` and `it.each\`...\`` all reduce to a base plus properties. */
function calleeChain(expr: ts.Expression): CalleeChain | null {
  if (ts.isIdentifier(expr)) return { base: expr.text, props: [] };
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = calleeChain(expr.expression);
    return inner ? { base: inner.base, props: [...inner.props, expr.name.text] } : null;
  }
  if (ts.isCallExpression(expr)) return calleeChain(expr.expression);
  if (ts.isTaggedTemplateExpression(expr)) return calleeChain(expr.tag);
  if (ts.isParenthesizedExpression(expr)) return calleeChain(expr.expression);
  return null;
}

function markersOf(chain: CalleeChain): { markers: MarkerKind[]; parameterized: boolean } | null {
  const markers: MarkerKind[] = [];
  if (chain.base.startsWith("x") && chain.base !== "x") markers.push("x");
  if (chain.base.startsWith("f") && (chain.base === "fit" || chain.base === "ftest" || chain.base === "fdescribe")) {
    markers.push("f");
  }
  let parameterized = false;
  for (const p of chain.props) {
    if (!(p in MODIFIERS)) return null; // e.g. `test.extend(...)`, `describe.name`
    const m = MODIFIERS[p];
    if (m) markers.push(m);
    if (p === "each" || p === "for") parameterized = true;
  }
  return { markers, parameterized };
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function titleOf(sf: ts.SourceFile, arg: ts.Expression | undefined): { title: string; literal: boolean } {
  if (!arg) return { title: "<missing>", literal: false };
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { title: normalizeTitle(arg.text), literal: true };
  }
  return { title: `<expr:${normalizeTitle(arg.getText(sf))}>`, literal: false };
}

function callbackOf(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  for (const a of call.arguments) {
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
  }
  return undefined;
}

/** The final matcher of an `expect(...)...matcher(...)` chain, or null when the call is not one. */
function matcherOf(call: ts.CallExpression): { name: string; negated: boolean; root: ts.CallExpression } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const name = call.expression.name.text;
  let negated = false;
  let e: ts.Expression = call.expression.expression;
  while (ts.isPropertyAccessExpression(e)) {
    if (!CHAIN_MODIFIERS.has(e.name.text)) return null;
    if (e.name.text === "not") negated = !negated;
    e = e.expression;
  }
  if (!ts.isCallExpression(e)) return null;
  const root = calleeChain(e.expression);
  if (!root) return null;
  const isExpect =
    (root.base === "expect" && root.props.every((p) => p === "soft" || p === "poll")) ||
    (root.base === "expectTypeOf" && root.props.length === 0);
  return isExpect ? { name, negated, root: e } : null;
}

function mentionsAnything(sf: ts.SourceFile, call: ts.CallExpression): boolean {
  return call.arguments.some((a) => /\bexpect\.(anything|any)\s*\(/.test(a.getText(sf)));
}

function classify(sf: ts.SourceFile, call: ts.CallExpression, name: string, negated: boolean): MatcherStrength {
  if (SNAPSHOT_MATCHERS.has(name)) return "snapshot";
  if (WEAK_MATCHERS.has(name)) return "weak";
  if ((name === "toThrow" || name === "toThrowError") && call.arguments.length === 0) return "weak";
  if (mentionsAnything(sf, call)) return "weak";
  if (STRONG_MATCHERS.has(name)) return negated ? "weak" : "strong";
  return "other";
}

interface BodyStats {
  assertionCount: number;
  hasAssertionDeclaration: boolean;
  matchers: MatcherUse[];
  inlineSnapshots: string[];
  runtimeSkips: number;
}

function analyzeBody(sf: ts.SourceFile, fn: ts.FunctionLikeDeclaration | undefined): BodyStats {
  const stats: BodyStats = {
    assertionCount: 0,
    hasAssertionDeclaration: false,
    matchers: [],
    inlineSnapshots: [],
    runtimeSkips: 0,
  };
  if (!fn?.body) return stats;
  const ctxNames = new Set<string>();
  const skipNames = new Set<string>();
  const first = fn.parameters[0];
  if (first) {
    if (ts.isIdentifier(first.name)) ctxNames.add(first.name.text);
    else if (ts.isObjectBindingPattern(first.name)) {
      for (const el of first.name.elements) {
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
        if (ts.isIdentifier(el.name) && (prop ?? el.name.text) === "skip") skipNames.add(el.name.text);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const m = matcherOf(node);
      if (m) {
        stats.assertionCount++;
        const strength = classify(sf, node, m.name, m.negated);
        stats.matchers.push({ name: m.name, negated: m.negated, strength, line: lineOf(sf, node) });
        if (m.name === "toMatchInlineSnapshot" || m.name === "toThrowErrorMatchingInlineSnapshot") {
          stats.inlineSnapshots.push(node.arguments.map((a) => a.getText(sf)).join(", "));
        }
        // Do not descend into the expect(...) root again as a separate assertion.
        node.arguments.forEach(visit);
        m.root.arguments.forEach(visit);
        return;
      }
      const chain = calleeChain(node.expression);
      if (chain) {
        if (chain.base === "expect" && (chain.props[0] === "assertions" || chain.props[0] === "hasAssertions")) {
          stats.hasAssertionDeclaration = true;
        } else if (chain.base === "assert" || chain.base === "assertType") {
          stats.assertionCount++;
          stats.matchers.push({ name: ["assert", ...chain.props].join("."), negated: false, strength: "other", line: lineOf(sf, node) });
        } else if (chain.props.length === 0 && HELPER_ASSERTION.test(chain.base) && chain.base !== "expect") {
          stats.assertionCount++;
          stats.matchers.push({ name: chain.base, negated: false, strength: "other", line: lineOf(sf, node) });
        } else if (
          (chain.props.length === 1 && chain.props[0] === "skip" && ctxNames.has(chain.base)) ||
          (chain.props.length === 0 && skipNames.has(chain.base))
        ) {
          stats.runtimeSkips++;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return stats;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.(tsx)$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.(jsx)$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JSX; // JS test files commonly carry JSX
  return ts.ScriptKind.TS;
}

export function staticKey(file: string, ancestors: readonly string[], title: string): string {
  return JSON.stringify([file, ...ancestors, title]);
}

const IGNORE_RE = /\/\*\s*(istanbul|v8|c8)\s+ignore\b([^*]*)\*\//g;

export function findIgnoreComments(source: string): IgnoreComment[] {
  const out: IgnoreComment[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const m of source.matchAll(IGNORE_RE)) {
    out.push({
      tool: m[1] as IgnoreComment["tool"],
      directive: `${m[1]} ignore${m[2]!.replace(/\s+/g, " ").trimEnd()}`.trim(),
      line: lineAt(m.index ?? 0),
      text: m[0],
    });
  }
  return out;
}

export function scanTestSource(file: string, source: string): StaticScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const cases: StaticTestCase[] = [];
  const walk = (node: ts.Node, ancestors: string[]): void => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const isTest = chain && TEST_BASES.has(chain.base);
      const isSuite = chain && SUITE_BASES.has(chain.base);
      const m = chain && (isTest || isSuite) ? markersOf(chain) : null;
      if (chain && m) {
        const { title, literal } = titleOf(sf, node.arguments[0]);
        const cb = callbackOf(node);
        const body = isTest ? analyzeBody(sf, cb) : analyzeBody(sf, undefined);
        cases.push({
          kind: isTest ? "test" : "suite",
          file,
          key: staticKey(file, ancestors, title),
          ancestors,
          title,
          literalTitle: literal,
          line: lineOf(sf, node),
          markers: m.markers,
          parameterized: m.parameterized,
          ...body,
        });
        if (isSuite && cb?.body) {
          const next = [...ancestors, title];
          ts.forEachChild(cb.body, (c) => walk(c, next));
        }
        // Arguments other than the callback (tables) cannot contain tests.
        return;
      }
    }
    ts.forEachChild(node, (c) => walk(c, ancestors));
  };
  walk(sf, []);
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  return { file, cases, ignoreComments: findIgnoreComments(source), syntaxErrors: diagnostics.length };
}
