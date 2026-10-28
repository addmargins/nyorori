// Detects test, coverage and type-check configuration that got weaker between
// B and C (spec 8.3). Config files are parsed, never executed: values computed
// at runtime are reported as opaque so a reviewer still sees the change.

import ts from "typescript";
import { posix } from "node:path";

export type ConfigValue = number | boolean | string | string[] | { opaque: string };

export interface ConfigWeakening {
  path: string;
  setting: string;
  before: ConfigValue | null;
  after: ConfigValue | null;
  why: string;
}

const WEAK_IF_TRUE = new Set([
  "passWithNoTests",
  "allowOnly",
  "update",
  "dangerouslyIgnoreUnhandledErrors",
  "ignoreSourceErrors",
]);
const WEAK_IF_FALSE = new Set(["enabled", "reportOnFailure", "all", "collectCoverage"]);
const GROWTH_WEAKENS = new Set([
  "exclude",
  "testPathIgnorePatterns",
  "coveragePathIgnorePatterns",
  "modulePathIgnorePatterns",
]);
const SHRINK_WEAKENS = new Set(["include", "testMatch", "testRegex", "roots", "files"]);
const TS_STRICT = new Set([
  "noImplicitAny",
  "noImplicitReturns",
  "noImplicitThis",
  "noImplicitOverride",
  "noUncheckedIndexedAccess",
  "noFallthroughCasesInSwitch",
  "exactOptionalPropertyTypes",
  "useUnknownInCatchVariables",
  "alwaysStrict",
]);
const WEAK_SCRIPT_FLAGS = [
  "--passWithNoTests",
  "-u",
  "--update",
  "--updateSnapshot",
  "--allowOnly",
  "--coverage.enabled=false",
  "--no-coverage",
  "--changed",
  "--changedSince",
  "--onlyChanged",
  "-o",
  "--findRelatedTests",
  "--testPathIgnorePatterns",
  "--exclude",
  "--dangerouslyIgnoreUnhandledErrors",
  "--typecheck.ignoreSourceErrors",
  "--bail",
];

type Settings = Map<string, ConfigValue>;

function literalValue(sf: ts.SourceFile, e: ts.Expression): ConfigValue {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
    return -Number(e.operand.text);
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isArrayLiteralExpression(e) && e.elements.every((x) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x))) {
    return e.elements.map((x) => (x as ts.StringLiteral).text);
  }
  return { opaque: e.getText(sf).slice(0, 200) };
}

function propName(n: ts.PropertyName): string | null {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return null;
}

function collectObject(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, prefix: string, out: Settings): void {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const name = propName(p.name);
      if (name === null) continue;
      const key = prefix ? `${prefix}.${name}` : name;
      if (ts.isObjectLiteralExpression(p.initializer)) collectObject(sf, p.initializer, key, out);
      else out.set(key, literalValue(sf, p.initializer));
    } else if (ts.isShorthandPropertyAssignment(p)) {
      const key = prefix ? `${prefix}.${p.name.text}` : p.name.text;
      out.set(key, { opaque: p.name.text });
    }
  }
}

function settingsFromScript(path: string, source: string): Settings {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: Settings = new Map();
  const visit = (n: ts.Node, insideObject: boolean): void => {
    if (ts.isObjectLiteralExpression(n) && !insideObject) {
      collectObject(sf, n, "", out);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, insideObject));
  };
  visit(sf, false);
  return out;
}

function stripJsonComments(s: string): string {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? "").replace(/,\s*([}\]])/g, "$1");
}

function settingsFromJson(value: unknown, prefix = "", out: Settings = new Map()): Settings {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) settingsFromJson(v, key, out);
      else if (Array.isArray(v)) out.set(key, v.every((x) => typeof x === "string") ? (v as string[]) : { opaque: JSON.stringify(v) });
      else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out.set(key, v);
      else out.set(key, { opaque: JSON.stringify(v) });
    }
  }
  return out;
}

function parseSettings(path: string, source: string | null): Settings | "unparsed" {
  if (source === null) return new Map();
  if (/\.(m|c)?(j|t)sx?$/.test(path)) return settingsFromScript(path, source);
  try {
    return settingsFromJson(JSON.parse(stripJsonComments(source)));
  } catch {
    return "unparsed";
  }
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1);
}

function isOpaque(v: ConfigValue | undefined): v is { opaque: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compareSettings(path: string, b: Settings, c: Settings, isTsconfig: boolean): ConfigWeakening[] {
  const out: ConfigWeakening[] = [];
  const keys = new Set([...b.keys(), ...c.keys()]);
  for (const key of [...keys].sort()) {
    const before = b.get(key);
    const after = c.get(key);
    const seg = lastSegment(key);
    const push = (why: string) => out.push({ path, setting: key, before: before ?? null, after: after ?? null, why });
    if (isTsconfig) {
      if ((seg === "strict" || seg.startsWith("strict") || TS_STRICT.has(seg)) && before === true && after !== true) {
        push("type-check strictness turned off");
      }
      if (seg === "exclude" || seg === "include" || seg === "files") {
        // falls through to the array rules below
      } else continue;
    }
    if (WEAK_IF_TRUE.has(seg) && after === true && before !== true) push(`${seg} enabled`);
    if (WEAK_IF_FALSE.has(seg) && /coverage/i.test(key) && before === true && after === false) push(`${seg} disabled`);
    if (/threshold/i.test(key) && typeof before === "number") {
      if (after === undefined) push("coverage threshold removed");
      else if (typeof after === "number" && (after < before || Math.sign(after) !== Math.sign(before))) {
        push("coverage threshold lowered");
      } else if (typeof after !== "number") push("coverage threshold made non-literal");
    }
    if (GROWTH_WEAKENS.has(seg)) {
      if (Array.isArray(after)) {
        const added = after.filter((x) => !(Array.isArray(before) ? before : []).includes(x));
        if (added.length > 0) push(`entries added to ${seg}: ${added.join(", ")}`);
      } else if (isOpaque(after) && JSON.stringify(after) !== JSON.stringify(before)) push(`${seg} changed to a computed value`);
    }
    if (SHRINK_WEAKENS.has(seg) && before !== undefined) {
      if (Array.isArray(before)) {
        const kept = Array.isArray(after) ? after : [];
        const removed = before.filter((x) => !kept.includes(x));
        if (removed.length > 0) push(`entries removed from ${seg}: ${removed.join(", ")}`);
      } else if (typeof before === "string" && before !== after) push(`${seg} narrowed or removed`);
    }
  }
  return out;
}

function scriptFlags(cmd: string): string[] {
  return cmd.split(/\s+/).map((t) => t.replace(/=.*$/, (m) => (t.startsWith("--coverage.enabled") ? m : "")));
}

function comparePackageJson(path: string, before: string | null, after: string | null): ConfigWeakening[] {
  const scripts = (src: string | null): Record<string, string> | "unparsed" => {
    if (src === null) return {};
    try {
      const j = JSON.parse(src) as { scripts?: Record<string, unknown> };
      const s: Record<string, string> = {};
      for (const [k, v] of Object.entries(j.scripts ?? {})) if (typeof v === "string") s[k] = v;
      return s;
    } catch {
      return "unparsed";
    }
  };
  const b = scripts(before);
  const c = scripts(after);
  if (b === "unparsed" || c === "unparsed") {
    return [{ path, setting: "scripts", before: null, after: null, why: "package.json could not be parsed" }];
  }
  const out: ConfigWeakening[] = [];
  const testScript = /^(pre|post)?(test|coverage)(:|$)/;
  for (const name of new Set([...Object.keys(b), ...Object.keys(c)])) {
    if (!testScript.test(name)) continue;
    const bs = b[name];
    const cs = c[name];
    if (bs === cs) continue;
    const setting = `scripts.${name}`;
    if (cs === undefined) {
      out.push({ path, setting, before: bs ?? null, after: null, why: "test script removed" });
      continue;
    }
    const bFlags = new Set(scriptFlags(bs ?? ""));
    const added = scriptFlags(cs).filter((f) => WEAK_SCRIPT_FLAGS.includes(f) && !bFlags.has(f));
    if (added.length > 0) out.push({ path, setting, before: bs ?? null, after: cs, why: `weakening flags added: ${added.join(" ")}` });
    else if (bs !== undefined && !/\b(vitest|jest|mocha|node --test|tsx --test|ava|tap)\b/.test(cs)) {
      out.push({ path, setting, before: bs, after: cs, why: "test script no longer invokes a known test runner" });
    }
  }
  return out;
}

/** Returns the weakenings found when `path` changed from `before` to `after` (null = absent). */
export function analyzeConfigChange(path: string, before: string | null, after: string | null): ConfigWeakening[] {
  const base = posix.basename(path);
  if (base === "package.json") return comparePackageJson(path, before, after);
  const b = parseSettings(path, before);
  const c = parseSettings(path, after);
  if (b === "unparsed" || c === "unparsed") {
    return [{ path, setting: "*", before: null, after: null, why: "config could not be parsed statically; review the change" }];
  }
  return compareSettings(path, b, c, /^tsconfig.*\.json$/.test(base));
}
