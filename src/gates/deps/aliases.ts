// tsconfig `paths` / `baseUrl` → resolver settings, read strictly as data.
//
// dependency-cruiser's own tsConfig option hands the file to the TypeScript
// config loader, which follows `extends` into node_modules. Here only JSONC
// files inside the tree are read: relative `extends` chains are followed,
// package `extends` are ignored, and targets that leave the tree are dropped.
//
// The settings come from B's tree and are applied to both trees (audit F9):
// a candidate that rewrites its aliases must not be able to un-resolve the
// edge that closes a cycle. tsconfig*.json is also a protected path (G4).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Resolver settings relative to a tree root, so they can be applied to another tree. */
export interface AliasSpec {
  /** enhanced-resolve alias key (`@` for `@/*`, `name$` for an exact match) → tree-relative target. */
  aliases: Record<string, string>;
  /** Tree-relative baseUrl, when set. */
  baseUrl: string | null;
  /** Package `extends` that were not followed. */
  ignoredExtends: string[];
}

interface CompilerPathOptions {
  baseUrl?: string;
  paths?: Record<string, unknown>;
}

const MAX_EXTENDS_DEPTH = 8;

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readJsonc(file: string): Record<string, unknown> | null {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  return parsed.error || typeof parsed.config !== "object" || parsed.config === null ? null : (parsed.config as Record<string, unknown>);
}

/**
 * Effective `baseUrl` and `paths` of `<treeRoot>/tsconfig.json`, merging
 * relative `extends` like tsc does: the child's value wins, and `baseUrl` /
 * `paths` targets resolve against the file that declared them.
 */
export function readAliasSpec(treeRoot: string): AliasSpec {
  const root = resolve(treeRoot);
  const spec: AliasSpec = { aliases: {}, baseUrl: null, ignoredExtends: [] };
  let baseUrlAbs: string | null = null;
  let paths: { value: Record<string, unknown>; dir: string } | null = null;
  const seen = new Set<string>();

  const visit = (file: string, depth: number): void => {
    if (depth > MAX_EXTENDS_DEPTH || seen.has(file) || !inside(root, file) || !existsSync(file)) return;
    seen.add(file);
    const config = readJsonc(file);
    if (!config) return;
    const dir = dirname(file);
    const options = (config.compilerOptions ?? {}) as CompilerPathOptions;
    // The child is visited first, so a value that is already set wins.
    if (baseUrlAbs === null && typeof options.baseUrl === "string") baseUrlAbs = resolve(dir, options.baseUrl);
    if (paths === null && typeof options.paths === "object" && options.paths !== null) paths = { value: options.paths, dir };
    const parents = Array.isArray(config.extends) ? config.extends : config.extends === undefined ? [] : [config.extends];
    for (const parent of parents) {
      if (typeof parent !== "string") continue;
      if (!parent.startsWith(".")) {
        spec.ignoredExtends.push(parent);
        continue;
      }
      const target = resolve(dir, parent);
      visit(existsSync(target) || target.endsWith(".json") ? target : `${target}.json`, depth + 1);
    }
  };
  visit(join(root, "tsconfig.json"), 0);

  if (baseUrlAbs !== null && inside(root, baseUrlAbs)) spec.baseUrl = relative(root, baseUrlAbs);
  const p = paths as { value: Record<string, unknown>; dir: string } | null;
  if (p) {
    // tsc resolves `paths` against baseUrl when set, else against the declaring file.
    const base = baseUrlAbs ?? p.dir;
    for (const [key, target] of Object.entries(aliasesFromPaths(root, relative(root, base) || ".", p.value))) {
      spec.aliases[key] = relative(root, target);
    }
  }
  return spec;
}

/** Absolute alias targets for one tree root. */
export function aliasesFromPaths(treeRoot: string, baseUrl: unknown, paths: unknown): Record<string, string> {
  const root = resolve(treeRoot);
  const base = resolve(root, typeof baseUrl === "string" ? baseUrl : ".");
  const out: Record<string, string> = {};
  if (typeof paths !== "object" || paths === null) return out;
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets) || typeof targets[0] !== "string") continue;
    const target = targets[0];
    const wildcard = pattern.endsWith("/*") && target.endsWith("/*");
    if (pattern.includes("*") && !wildcard) continue;
    const dest = resolve(base, wildcard ? target.slice(0, -2) : target);
    if (!inside(root, dest)) continue;
    out[wildcard ? pattern.slice(0, -2) : `${pattern}$`] = dest;
  }
  return out;
}

/** Back-compat: aliases of a tree's own tsconfig, as absolute paths. */
export function readPathAliases(treeRoot: string): Record<string, string> {
  return applyAliasSpec(readAliasSpec(treeRoot), treeRoot).alias;
}

export interface ResolveSettings {
  alias: Record<string, string>;
  /** Extra module directory for bare specifiers (tsconfig baseUrl). */
  baseUrlDir: string | null;
}

export function applyAliasSpec(spec: AliasSpec, treeRoot: string): ResolveSettings {
  const root = resolve(treeRoot);
  const alias: Record<string, string> = {};
  for (const [k, rel] of Object.entries(spec.aliases)) alias[k] = resolve(root, rel);
  return { alias, baseUrlDir: spec.baseUrl === null ? null : resolve(root, spec.baseUrl) };
}

/** True when a bare specifier would resolve inside the repository under `spec`. */
export function looksInternal(specifier: string, spec: AliasSpec, baseUrlEntries: ReadonlySet<string>): boolean {
  for (const key of Object.keys(spec.aliases)) {
    if (key.endsWith("$") ? specifier === key.slice(0, -1) : specifier === key || specifier.startsWith(`${key}/`)) return true;
  }
  const first = specifier.split("/")[0]!;
  return spec.baseUrl !== null && baseUrlEntries.has(first);
}
