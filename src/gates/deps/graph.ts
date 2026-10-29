// Module graph of one tree, built with dependency-cruiser from an in-code
// options object. Nothing that can execute code is consulted: no
// .dependency-cruiser.js, no webpack or babel config. tsconfig `paths` and
// `baseUrl` are read as data only, from B's tree (see aliases.ts).

import { cruise, type ICruiseResult, type IDependency } from "dependency-cruiser";
import { applyAliasSpec, readAliasSpec, type AliasSpec, type ResolveSettings } from "./aliases.js";

export interface DepEdge {
  from: string;
  /** Resolved path (tree-relative) for local edges, the specifier otherwise. */
  to: string;
  specifier: string;
  kinds: string[];
  /** Local file that is part of the graph. */
  local: boolean;
  /** Present at runtime: not type-only, not lazily loaded. */
  runtime: boolean;
}

export interface ModuleGraph {
  nodes: Set<string>;
  edges: DepEdge[];
  /** Relative specifiers that resolved to nothing: a sign the tree is incomplete. */
  unresolvedLocal: Array<{ from: string; specifier: string }>;
  /** Bare specifiers that resolved to nothing (packages, or aliases the resolver missed). */
  unresolvedBare: Array<{ from: string; specifier: string }>;
}

/**
 * Edge kinds that do not take part in runtime cycles. `dynamic-import` is
 * excluded because a lazy `import()` is the standard way to break a cycle;
 * counting it would punish the fix.
 */
const NON_RUNTIME_KINDS = new Set([
  "type-only",
  "type-import",
  "pre-compilation-only",
  "dynamic-import",
  "triple-slash-type-reference",
  "triple-slash-file-reference",
  "triple-slash-directive",
  "triple-slash-amd-dependency",
  "jsdoc",
  "jsdoc-bracket-import",
  "jsdoc-import-tag",
]);

export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

export type Cruiser = (files: string[], baseDir: string, resolve: ResolveSettings) => Promise<ICruiseResult>;

export const defaultCruiser: Cruiser = async (files, baseDir, { alias, baseUrlDir }) => {
  const result = await cruise(
    files,
    {
      baseDir,
      doNotFollow: { path: "(^|/)node_modules/" },
      tsPreCompilationDeps: "specify",
      outputType: "json",
      validate: false,
      cache: false,
      progress: { type: "none" },
    },
    {
      extensions: CODE_EXTENSIONS,
      alias,
      // tsconfig baseUrl makes bare specifiers resolve inside the repository.
      ...(baseUrlDir ? { modules: ["node_modules", "node_modules/@types", baseUrlDir] } : {}),
    },
  );
  return (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as ICruiseResult;
};

function isRuntime(kinds: readonly string[]): boolean {
  return !kinds.some((k) => NON_RUNTIME_KINDS.has(k));
}

export function graphFromCruise(files: readonly string[], result: ICruiseResult): ModuleGraph {
  const nodes = new Set(files);
  const edges: DepEdge[] = [];
  const unresolvedLocal: ModuleGraph["unresolvedLocal"] = [];
  const unresolvedBare: ModuleGraph["unresolvedBare"] = [];
  for (const mod of result.modules) {
    if (!nodes.has(mod.source)) continue;
    for (const dep of mod.dependencies as IDependency[]) {
      const kinds = [...(dep.dependencyTypes ?? [])];
      const local = !dep.couldNotResolve && nodes.has(dep.resolved);
      if (dep.couldNotResolve) {
        const relativeSpec = /^\.{1,2}(\/|$)/.test(dep.module);
        (relativeSpec ? unresolvedLocal : unresolvedBare).push({ from: mod.source, specifier: dep.module });
      }
      edges.push({
        from: mod.source,
        to: local ? dep.resolved : dep.module,
        specifier: dep.module,
        kinds,
        local,
        runtime: isRuntime(kinds),
      });
    }
  }
  return { nodes, edges, unresolvedLocal, unresolvedBare };
}

/**
 * Builds the graph of `files` (tree-relative POSIX paths) under `treeRoot`.
 * `files` must list every code file of the tree: cycles are a whole-graph
 * property and a partial tree silently hides them.
 */
export async function buildModuleGraph(
  treeRoot: string,
  files: readonly string[],
  cruiser: Cruiser = defaultCruiser,
  aliases: AliasSpec = readAliasSpec(treeRoot),
): Promise<ModuleGraph> {
  if (files.length === 0) return { nodes: new Set(), edges: [], unresolvedLocal: [], unresolvedBare: [] };
  const result = await cruiser([...files], treeRoot, applyAliasSpec(aliases, treeRoot));
  return graphFromCruise(files, result);
}
