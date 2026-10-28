// tsconfig `paths` → resolver aliases, read strictly as data.
//
// dependency-cruiser's own tsConfig option hands the file to the TypeScript
// config loader, which follows `extends` into node_modules. Here only the
// tree's root tsconfig.json is parsed (JSONC), `extends` is ignored and
// targets that leave the tree are dropped. tsconfig*.json is a protected path
// (G4), so a candidate cannot quietly rewrite aliases to hide an edge.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export function readPathAliases(treeRoot: string): Record<string, string> {
  const file = join(treeRoot, "tsconfig.json");
  if (!existsSync(file)) return {};
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (parsed.error || typeof parsed.config !== "object" || parsed.config === null) return {};
  const options = (parsed.config as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } }).compilerOptions ?? {};
  return aliasesFromPaths(treeRoot, options.baseUrl, options.paths);
}

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
    const rel = relative(root, dest);
    if (rel.startsWith("..")) continue;
    out[wildcard ? pattern.slice(0, -2) : `${pattern}$`] = dest;
  }
  return out;
}
