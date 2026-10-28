// G3 `gate/deps`: changes to the cyclic part of the runtime graph (block),
// new imports from product code into tests or excluded paths (block), new
// forbidden layer edges (block from P2, observe before), and the S3
// module-split and S11 unmeasured-target triggers.

import { posix } from "node:path";
import type { Policy } from "../../policy/schema.js";
import type { GateState, Inconclusive, TriggerHit, Violation } from "../../types.js";
import { matchesAny } from "../../util/glob.js";
import { looksInternal, readAliasSpec, type AliasSpec } from "./aliases.js";
import { changedComponents, cyclicComponents, findNewCycles, type NewCycle } from "./cycles.js";
import { buildModuleGraph, CODE_EXTENSIONS, type Cruiser, type DepEdge, type ModuleGraph } from "./graph.js";

export interface EvaluateDepsInput {
  /** Directories holding the complete code tree of B and C (all code files, not only changed ones). */
  treeB: string;
  treeC: string;
  filesB: readonly string[];
  filesC: readonly string[];
  policy: Policy;
  /** C paths of modified or renamed files (S3 efferent check). */
  changedPaths: readonly string[];
  /** C path → B path for renames. Paths present on both sides map to themselves. */
  renames?: ReadonlyMap<string, string>;
  /**
   * Every path in the C tree (code or not). Lets S11 see an import of an
   * extensionless file, which CommonJS executes as JavaScript.
   */
  allFilesC?: readonly string[];
  cruiser?: Cruiser;
}

export interface DepsEvaluation {
  violations: Violation[];
  triggers: TriggerHit[];
  inconclusive: Inconclusive[];
  observe: {
    new_forbidden_edges: Array<{ rule: string; from: string; to: string }>;
    unmeasured_targets: Array<{ from: string; specifier: string }>;
    unresolved_internal_c: Array<{ from: string; specifier: string }>;
    ignored_tsconfig_extends: string[];
    new_type_only_cycle_edges: number;
    unresolved_local_c: Array<{ from: string; specifier: string }>;
    efferent_delta: Record<string, number>;
    modules_b: number;
    modules_c: number;
  };
}

const GATE = "deps" as const;

export async function evaluateDeps(input: EvaluateDepsInput): Promise<DepsEvaluation> {
  let gB: ModuleGraph;
  let gC: ModuleGraph;
  let aliases: AliasSpec;
  try {
    // B's resolver settings for both trees (audit F9).
    aliases = readAliasSpec(input.treeB);
    [gB, gC] = await Promise.all([
      buildModuleGraph(input.treeB, input.filesB, input.cruiser, aliases),
      buildModuleGraph(input.treeC, input.filesC, input.cruiser, aliases),
    ]);
  } catch (e) {
    return {
      violations: [],
      triggers: [],
      inconclusive: [{ reason: "TOOL_ERROR", detail: `dependency-cruiser failed: ${(e as Error).message}`, authorFixable: false }],
      observe: emptyObserve(),
    };
  }
  const result = compareGraphs(gB, gC, { ...input, aliases });
  result.observe.ignored_tsconfig_extends = aliases.ignoredExtends;
  return result;
}

function emptyObserve(): DepsEvaluation["observe"] {
  return {
    new_forbidden_edges: [],
    unmeasured_targets: [],
    unresolved_internal_c: [],
    ignored_tsconfig_extends: [],
    new_type_only_cycle_edges: 0,
    unresolved_local_c: [],
    efferent_delta: {},
    modules_b: 0,
    modules_c: 0,
  };
}

export function compareGraphs(
  gB: ModuleGraph,
  gC: ModuleGraph,
  input: Pick<EvaluateDepsInput, "policy" | "changedPaths" | "renames" | "allFilesC"> & { aliases?: AliasSpec },
): DepsEvaluation {
  const { policy } = input;
  const toB = (c: string): string | undefined => {
    const renamed = input.renames?.get(c);
    if (renamed !== undefined) return renamed;
    return gB.nodes.has(c) ? c : undefined;
  };
  const violations: Violation[] = [];
  const triggers: TriggerHit[] = [];
  const observe = emptyObserve();
  observe.modules_b = gB.nodes.size;
  observe.modules_c = gC.nodes.size;
  observe.unresolved_local_c = gC.unresolvedLocal;

  cycleFindings(gB, gC, toB, violations, triggers, observe);
  forbiddenEdges(gB, gC, toB, policy, violations, observe);
  unmeasuredTargets(gB, gC, toB, input.allFilesC, triggers, observe);
  internalLookingUnresolved(gB, gC, toB, input.aliases, triggers, observe);
  moduleSplitTriggers(gB, gC, toB, input, triggers, observe);
  return { violations, triggers, inconclusive: [], observe };
}

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((m, i) => m === b[i]);
const isSubset = (small: readonly string[], big: readonly string[]) => small.every((m) => big.includes(m));

/**
 * Ruling D7. FAIL only when the cyclic SCC partition changes. A new edge
 * inside an unchanged component, or a cycle that closes only through a new
 * lazy `import()`, routes as S3. Type-only cycles are recorded.
 */
function cycleFindings(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  violations: Violation[],
  triggers: TriggerHit[],
  observe: DepsEvaluation["observe"],
): void {
  const pick = (g: ModuleGraph, keep: (e: DepEdge) => boolean) => g.edges.filter((e) => e.local && keep(e));
  const runtime = (e: DepEdge) => e.runtime;
  const lazyToo = (e: DepEdge) => e.runtime || (e.kinds.includes("dynamic-import") && !e.kinds.some((k) => TYPE_KINDS.has(k)));

  const changedRuntime = changedComponents(
    cyclicComponents(gC.nodes, pick(gC, runtime)),
    cyclicComponents(gB.nodes, pick(gB, runtime)),
    toB,
  );
  const newEdgeCycles = findNewCycles(gC.nodes, pick(gC, runtime), pick(gB, runtime), toB);
  for (const members of changedRuntime) {
    const evidence = newEdgeCycles.find((c) => sameMembers(c.members, members));
    violations.push(cycleViolation(evidence ?? { members, newEdges: [], witness: members }));
  }
  for (const c of newEdgeCycles) {
    if (changedRuntime.some((m) => sameMembers(m, c.members))) continue;
    const e = c.newEdges[0]!;
    triggers.push({
      id: "S3",
      gate: GATE,
      file: e.from,
      evidence: `new import ${e.from} → ${e.to} inside an existing import cycle (${c.members.length} modules): ${c.witness.join(" → ")}`,
      routing: true,
    });
  }

  const changedLazy = changedComponents(
    cyclicComponents(gC.nodes, pick(gC, lazyToo)),
    cyclicComponents(gB.nodes, pick(gB, lazyToo)),
    toB,
  ).filter((members) => !changedRuntime.some((rt) => isSubset(rt, members)));
  for (const members of changedLazy) {
    triggers.push({
      id: "S3",
      gate: GATE,
      file: members[0]!,
      evidence: `import cycle closed only through a lazy import(): ${members.join(", ")}`,
      routing: true,
    });
  }

  // Cycles through type-only edges are erased at runtime; recorded, not blocked.
  const runtimeNew = new Set(newEdgeCycles.flatMap((c) => c.newEdges.map((e) => edgeKey(e.from, e.to))));
  observe.new_type_only_cycle_edges = findNewCycles(gC.nodes, pick(gC, () => true), pick(gB, () => true), toB)
    .flatMap((c) => c.newEdges)
    .filter((e) => !runtimeNew.has(edgeKey(e.from, e.to))).length;
}

function cycleViolation(cycle: NewCycle): Violation {
  const first = cycle.newEdges[0];
  return {
    gate: GATE,
    reason: "DEP_NEW_CYCLE",
    file: first?.from ?? cycle.members[0]!,
    metric: "cycle",
    message: first
      ? `New import cycle: ${cycle.witness.join(" → ")}. The import ${first.from} → ${first.to} closes it.`
      : `The import cycle among ${cycle.members.join(", ")} is new or grew.`,
    details: { members: cycle.members, new_edges: cycle.newEdges, witness: cycle.witness },
  };
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

const TYPE_KINDS = new Set(["type-only", "type-import", "pre-compilation-only"]);

/** C edges whose mapped counterpart does not exist in B (any kind). */
function newEdges(gB: ModuleGraph, gC: ModuleGraph, toB: (c: string) => string | undefined): DepEdge[] {
  const bEdges = new Set(gB.edges.map((e) => edgeKey(e.from, e.to)));
  const seen = new Set<string>();
  return gC.edges.filter((e) => {
    const k = edgeKey(e.from, e.to);
    if (seen.has(k)) return false;
    seen.add(k);
    const from = toB(e.from);
    const to = e.local ? toB(e.to) : e.to;
    return !(from !== undefined && to !== undefined && bEdges.has(edgeKey(from, to)));
  });
}

function forbiddenEdges(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  policy: Policy,
  violations: Violation[],
  observe: DepsEvaluation["observe"],
): void {
  const fresh = newEdges(gB, gC, toB);
  const { test_globs: tests, exclude } = policy.scope;
  const isProduct = (p: string) => !matchesAny(p, tests) && !matchesAny(p, exclude);

  // Ruling D19 / spec V8: product code may not reach into tests or excluded
  // paths, which are measured as observe-only or not at all. Always on.
  for (const e of fresh) {
    if (!e.local || !isProduct(e.from)) continue;
    const into = matchesAny(e.to, tests) ? "test" : matchesAny(e.to, exclude) ? "excluded" : null;
    if (!into) continue;
    violations.push({
      gate: GATE,
      reason: "DEP_FORBIDDEN_EDGE",
      file: e.from,
      metric: into === "test" ? "product-imports-test" : "product-imports-excluded",
      message: `New import ${e.from} → ${e.to}: product code may not import ${into === "test" ? "test code" : "a path excluded from measurement"}, where it would escape the gate.`,
      details: { rule: `product-imports-${into}`, specifier: e.specifier, kinds: e.kinds },
    });
  }

  const rules = policy.deps.forbidden.map((r) => ({ ...r, fromRe: new RegExp(r.from), toRe: new RegExp(r.to) }));
  for (const e of fresh) {
    for (const r of rules) {
      if (!r.fromRe.test(e.from) || !r.toRe.test(e.to)) continue;
      observe.new_forbidden_edges.push({ rule: r.name, from: e.from, to: e.to });
      if (policy.deps.block_forbidden_edges) {
        violations.push({
          gate: GATE,
          reason: "DEP_FORBIDDEN_EDGE",
          file: e.from,
          metric: r.name,
          message: `New import ${e.from} → ${e.to} breaks the layer rule "${r.name}".`,
          details: { rule: r.name, specifier: e.specifier, kinds: e.kinds },
        });
      }
    }
  }
}

/**
 * Data and asset formats that bundlers load as data. Anything else outside
 * the code extensions (.txt, .md, .html, .node, .wasm, extensionless) is
 * code the gate cannot measure: CommonJS `require()` runs unknown extensions
 * as JavaScript (audit F6).
 */
const DATA_EXTENSIONS = new Set([
  ".json", ".jsonc", ".json5", ".css", ".scss", ".sass", ".less", ".styl", ".pcss", ".postcss",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".webm", ".wav", ".ogg", ".m4a", ".mov",
  ".graphql", ".gql", ".yaml", ".yml", ".toml", ".csv", ".tsv",
]);
/** Bundler queries that import a file as a string or URL, never as code. */
const DATA_QUERY_RE = /[?&](raw|url|inline)\b/;

function unmeasuredTargets(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  allFilesC: readonly string[] | undefined,
  triggers: TriggerHit[],
  observe: DepsEvaluation["observe"],
): void {
  const before = new Set(gB.edges.map((e) => edgeKey(e.from, e.specifier)));
  const allFiles = allFilesC ? new Set(allFilesC) : null;
  const seen = new Set<string>();
  for (const e of gC.edges) {
    if (e.local || !/^\.{1,2}\//.test(e.specifier)) continue;
    const from = toB(e.from);
    if (from !== undefined && before.has(edgeKey(from, e.specifier))) continue;
    if (seen.has(edgeKey(e.from, e.specifier))) continue;
    seen.add(edgeKey(e.from, e.specifier));
    if (DATA_QUERY_RE.test(e.specifier)) continue;
    const bare = e.specifier.split(/[?#]/)[0]!;
    const target = posix.normalize(posix.join(posix.dirname(e.from), bare));
    const ext = posix.extname(target).toLowerCase();
    let unmeasured: boolean;
    if (ext === "") unmeasured = allFiles?.has(target) ?? false;
    else unmeasured = !CODE_EXTENSIONS.includes(ext) && !DATA_EXTENSIONS.has(ext);
    if (!unmeasured) continue;
    observe.unmeasured_targets.push({ from: e.from, specifier: e.specifier });
    triggers.push({
      id: "S11",
      gate: GATE,
      file: e.from,
      evidence: `${e.from} imports ${e.specifier}, a file the gate does not measure (${ext || "no extension"})`,
      routing: true,
    });
  }
}

/** Bare specifiers that look like aliases or baseUrl paths but did not resolve: edges the graph may be missing. */
function internalLookingUnresolved(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  aliases: AliasSpec | undefined,
  triggers: TriggerHit[],
  observe: DepsEvaluation["observe"],
): void {
  if (!aliases) return;
  const baseEntries = new Set<string>();
  if (aliases.baseUrl !== null) {
    const prefix = aliases.baseUrl === "" ? "" : `${aliases.baseUrl}/`;
    for (const n of gC.nodes) {
      if (n.startsWith(prefix)) baseEntries.add(n.slice(prefix.length).split("/")[0]!.replace(/\.[^.]+$/, ""));
    }
  }
  const before = new Set(gB.unresolvedBare.map((u) => edgeKey(u.from, u.specifier)));
  const fresh = gC.unresolvedBare.filter((u) => {
    if (!looksInternal(u.specifier, aliases, baseEntries)) return false;
    const from = toB(u.from);
    return from === undefined || !before.has(edgeKey(from, u.specifier));
  });
  if (fresh.length === 0) return;
  observe.unresolved_internal_c = fresh;
  triggers.push({
    id: "S3",
    gate: GATE,
    file: fresh[0]!.from,
    evidence: `${fresh.length} import(s) look internal but did not resolve, so cycle detection could not see them: ${fresh
      .slice(0, 5)
      .map((u) => `${u.from} → ${u.specifier}`)
      .join(", ")}`,
    routing: true,
  });
}

function isTest(path: string, globs: readonly string[]): boolean {
  return matchesAny(path, globs);
}

/** Distinct import targets (local files and packages) per module. */
function efferent(g: ModuleGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of g.edges) {
    const set = out.get(e.from) ?? new Set<string>();
    set.add(e.to);
    out.set(e.from, set);
  }
  return out;
}

function moduleSplitTriggers(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  input: Pick<EvaluateDepsInput, "policy" | "changedPaths">,
  triggers: TriggerHit[],
  observe: DepsEvaluation["observe"],
): void {
  const { s3 } = input.policy.triggers;
  const testGlobs = input.policy.scope.test_globs;

  const importers = new Map<string, Set<string>>();
  for (const e of gC.edges) {
    if (!e.local || e.from === e.to || isTest(e.from, testGlobs)) continue;
    const set = importers.get(e.to) ?? new Set<string>();
    set.add(e.from);
    importers.set(e.to, set);
  }
  const singleImporter = [...gC.nodes]
    .filter((n) => toB(n) === undefined && !isTest(n, testGlobs) && importers.get(n)?.size === 1)
    .sort();
  if (singleImporter.length >= s3.min_single_importer_modules) {
    const detail = singleImporter.map((n) => `${n} ← ${[...importers.get(n)!][0]}`).join(", ");
    triggers.push({
      id: "S3",
      gate: GATE,
      file: singleImporter[0]!,
      evidence: `${singleImporter.length} new modules each imported by a single module: ${detail}`,
      routing: true,
    });
  }

  const effB = efferent(gB);
  const effC = efferent(gC);
  for (const path of input.changedPaths) {
    const before = toB(path);
    if (before === undefined) continue;
    const delta = (effC.get(path)?.size ?? 0) - (effB.get(before)?.size ?? 0);
    if (delta !== 0) observe.efferent_delta[path] = delta;
    if (delta >= s3.min_efferent_increase) {
      triggers.push({
        id: "S3",
        gate: GATE,
        file: path,
        evidence: `${path} imports ${delta} more modules than before (${effB.get(before)?.size ?? 0} → ${effC.get(path)?.size ?? 0})`,
        routing: true,
      });
    }
  }
}

export function depsState(e: DepsEvaluation, filesC: readonly string[]): GateState {
  if (e.violations.length > 0) return "FAIL";
  if (e.inconclusive.length > 0) return "INCONCLUSIVE";
  return filesC.length === 0 ? "NOT_APPLICABLE" : "PASS";
}

export type { DepEdge, ModuleGraph };
