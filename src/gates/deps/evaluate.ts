// G3 `gate/deps`: new runtime cycles (block), new forbidden layer edges
// (block from P2, observe before) and the S3 module-split trigger.

import { matchesGlob } from "node:path";
import type { Policy } from "../../policy/schema.js";
import type { GateState, Inconclusive, TriggerHit, Violation } from "../../types.js";
import { findNewCycles, type NewCycle } from "./cycles.js";
import { buildModuleGraph, type Cruiser, type DepEdge, type ModuleGraph } from "./graph.js";

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
  cruiser?: Cruiser;
}

export interface DepsEvaluation {
  violations: Violation[];
  triggers: TriggerHit[];
  inconclusive: Inconclusive[];
  observe: {
    new_forbidden_edges: Array<{ rule: string; from: string; to: string }>;
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
  try {
    [gB, gC] = await Promise.all([
      buildModuleGraph(input.treeB, input.filesB, input.cruiser),
      buildModuleGraph(input.treeC, input.filesC, input.cruiser),
    ]);
  } catch (e) {
    return {
      violations: [],
      triggers: [],
      inconclusive: [{ reason: "TOOL_ERROR", detail: `dependency-cruiser failed: ${(e as Error).message}`, authorFixable: false }],
      observe: emptyObserve(),
    };
  }
  return compareGraphs(gB, gC, input);
}

function emptyObserve(): DepsEvaluation["observe"] {
  return { new_forbidden_edges: [], new_type_only_cycle_edges: 0, unresolved_local_c: [], efferent_delta: {}, modules_b: 0, modules_c: 0 };
}

export function compareGraphs(
  gB: ModuleGraph,
  gC: ModuleGraph,
  input: Pick<EvaluateDepsInput, "policy" | "changedPaths" | "renames">,
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

  const localRuntime = (g: ModuleGraph) => g.edges.filter((e) => e.local && e.runtime);
  const runtimeCycles = findNewCycles(gC.nodes, localRuntime(gC), localRuntime(gB), toB);
  for (const cycle of runtimeCycles) violations.push(cycleViolation(cycle));
  // Cycles that exist only through type-only or lazy edges are erased or
  // deferred at runtime; they are recorded, not blocked.
  const allLocal = (g: ModuleGraph) => g.edges.filter((e) => e.local);
  const runtimeNew = new Set(runtimeCycles.flatMap((c) => c.newEdges.map((e) => edgeKey(e.from, e.to))));
  observe.new_type_only_cycle_edges = findNewCycles(gC.nodes, allLocal(gC), allLocal(gB), toB)
    .flatMap((c) => c.newEdges)
    .filter((e) => !runtimeNew.has(edgeKey(e.from, e.to))).length;

  forbiddenEdges(gB, gC, toB, policy, violations, observe);
  moduleSplitTriggers(gB, gC, toB, input, triggers, observe);
  return { violations, triggers, inconclusive: [], observe };
}

function cycleViolation(cycle: NewCycle): Violation {
  const first = cycle.newEdges[0]!;
  return {
    gate: GATE,
    reason: "DEP_NEW_CYCLE",
    file: first.from,
    metric: "cycle",
    message: `New import cycle: ${cycle.witness.join(" → ")}. The import ${first.from} → ${first.to} closes it.`,
    details: { members: cycle.members, new_edges: cycle.newEdges, witness: cycle.witness },
  };
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function forbiddenEdges(
  gB: ModuleGraph,
  gC: ModuleGraph,
  toB: (c: string) => string | undefined,
  policy: Policy,
  violations: Violation[],
  observe: DepsEvaluation["observe"],
): void {
  const rules = policy.deps.forbidden.map((r) => ({ ...r, fromRe: new RegExp(r.from), toRe: new RegExp(r.to) }));
  if (rules.length === 0) return;
  const bEdges = new Set(gB.edges.map((e) => edgeKey(e.from, e.to)));
  const seen = new Set<string>();
  for (const e of gC.edges) {
    const from = toB(e.from);
    const to = e.local ? toB(e.to) : e.to;
    if (from !== undefined && to !== undefined && bEdges.has(edgeKey(from, to))) continue;
    for (const r of rules) {
      if (!r.fromRe.test(e.from) || !r.toRe.test(e.to)) continue;
      const k = `${r.name}|${edgeKey(e.from, e.to)}`;
      if (seen.has(k)) continue;
      seen.add(k);
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

function isTest(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
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
