// G1 `gate/complexity` (spec 5): the CogC decision for every unit of every
// changed C file, plus the review-routing triggers derived from the same
// cccc data (spec 7.5). Pure: all inputs are measurements already taken.

import type { Policy } from "../../policy/schema.js";
import type {
  FileLineMap,
  FileMeasurement,
  Hunk,
  Inconclusive,
  Manifest,
  ManifestEntry,
  TriggerHit,
  Unit,
  UnitMatch,
  Violation,
} from "../../types.js";
import { countableUnits, flattenUnits, isOverloadSignature, visibleBranches } from "../../units/model.js";
import { unitLastLine } from "../../units/body.js";
import {
  bGapTouched,
  bRangeTouched,
  cRangeTouched,
  filePairs,
  scopeChangesOf,
  scopeIndex,
  type FilePair,
  type ScopeChange,
} from "../../units/match.js";
import { checkName, normalizeName } from "../../units/names.js";
import { matchesAny } from "../../util/glob.js";

const ANONYMOUS = "<anonymous>";

export interface ComplexityInput {
  manifest: Manifest;
  /** Keyed by B path. */
  b: ReadonlyMap<string, FileMeasurement>;
  /** Keyed by C path. */
  c: ReadonlyMap<string, FileMeasurement>;
  lineMaps: readonly FileLineMap[];
  matches: readonly UnitMatch[];
  policy: Policy;
  /** Prettier-normalized line counts per C path (spec 7.5); raw line counts are used when absent. */
  normalizedLines?: ReadonlyMap<string, { B?: number; C?: number }>;
  /** C sources, for the S11 "name survives as a binding" check. */
  sourcesC?: ReadonlyMap<string, string>;
  /** B sources, for the residue gaps of S5 (a unit's real last line); without them only the file head counts. */
  sourcesB?: ReadonlyMap<string, string>;
  /** C paths whose B side failed to parse. */
  baselineMissing?: ReadonlySet<string>;
  /** The PR was authored by the AI fix loop (ruling D5: foreign-language files always route). */
  isAiLoop?: boolean;
  /** C paths whose pinned-Prettier normalization equals B's (ruling D21a): a pure reformat. */
  normalizedIdentical?: ReadonlySet<string>;
}

export interface UnitObservation {
  unit: string;
  line: number;
  cognitive: number;
  cyclomatic: number;
  before?: number;
}

export interface ComplexityObserve {
  cc_ge_20: UnitObservation[];
  s8_near_limit: UnitObservation[];
  legacy_debt: UnitObservation[];
  inclusive_cognitive: Record<string, number>;
  unmatched_over_budget: number;
  /** Test-file violations, observed only while tests are not enforced. */
  test_file_violations: Violation[];
  name_warnings: Array<{ unit: string; warning: string }>;
}

export interface ComplexityOutcome {
  violations: Violation[];
  triggers: TriggerHit[];
  observe: ComplexityObserve;
  inconclusive: Inconclusive[];
}

interface Ctx {
  input: ComplexityInput;
  T: number;
  bUnits: Map<string, Unit>;
  cUnits: Map<string, Unit>;
  byC: Map<string, UnitMatch>;
  byB: Map<string, UnitMatch>;
  /** Matches kept: a pair crossing the test/product boundary is dropped even if a caller matched it. */
  matches: UnitMatch[];
  pairs: FilePair[];
  pairByC: Map<string, FilePair>;
  /** File pairs and verbatim moves refused for crossing the test/product boundary (S11). */
  scopeChanges: ScopeChange[];
  /** B paths of files whose baseline failed to parse. */
  noBaselineB: Set<string>;
  /** B and C paths of test files while tests are observe-only: no triggers. */
  observedOnly: Set<string>;
  /** File pairs that produce triggers (test files excluded unless enforced). */
  triggerPairs: FilePair[];
}

export { countableUnits, isOverloadSignature };

function allUnits(m: FileMeasurement): Unit[] {
  return [...flattenUnits(m.units), m.residue];
}

/** Whether one side of an entry is a test path: `isTestB`/`isTestC`, falling back to the legacy `isTest`. */
function isTestSide(e: ManifestEntry, side: "B" | "C"): boolean {
  const flag = side === "B" ? e.isTestB : e.isTestC;
  return flag ?? e.isTest ?? false;
}

function maxCognitive(m: FileMeasurement): number {
  return allUnits(m).reduce((mx, u) => Math.max(mx, u.cognitive), 0);
}

function displayName(u: Unit): string {
  return u.isResidue ? u.key : `${u.path}::${u.name}`;
}

function buildCtx(input: ComplexityInput): Ctx {
  const bUnits = new Map<string, Unit>();
  for (const m of input.b.values()) for (const u of allUnits(m)) bUnits.set(u.key, u);
  const cUnits = new Map<string, Unit>();
  for (const m of input.c.values()) for (const u of allUnits(m)) cUnits.set(u.key, u);
  const testGlobs = input.policy.scope.test_globs;
  const scopes = scopeIndex({ manifest: input.manifest, testGlobs });
  const byC = new Map<string, UnitMatch>();
  const byB = new Map<string, UnitMatch>();
  const matches: UnitMatch[] = [];
  for (const m of input.matches) {
    // A test unit's allowance never travels into product code (or back), whatever the matcher did.
    const bp = bUnits.get(m.bKey)?.path;
    const cp = cUnits.get(m.cKey)?.path;
    if (bp !== undefined && cp !== undefined && (scopes.b.get(bp) ?? "product") !== (scopes.c.get(cp) ?? "product")) continue;
    matches.push(m);
    byC.set(m.cKey, m);
    byB.set(m.bKey, m);
  }
  const pairInput = {
    manifest: input.manifest,
    b: input.b,
    c: input.c,
    lineMaps: input.lineMaps,
    testGlobs,
    ...(input.baselineMissing ? { baselineMissing: input.baselineMissing } : {}),
  };
  const scopeChanges = scopeChangesOf(pairInput, matches);
  // A pure reformat whose units all matched is no edit at all: no range touches (D21a).
  const pairs = filePairs(pairInput).map((p) =>
    input.normalizedIdentical?.has(p.c.path) && flattenUnits(p.c.units).every((u) => byC.has(u.key))
      ? { ...p, hunks: [] }
      : p,
  );
  const noBaselineB = new Set<string>();
  const observedOnly = new Set<string>();
  for (const e of input.manifest.entries) {
    if (e.b && e.c && input.baselineMissing?.has(e.c.path)) noBaselineB.add(e.b.path);
    // Per side: a rename across the boundary has one observed side and one enforced side.
    if (!input.policy.complexity.enforce_on_tests) {
      if (e.b && isTestSide(e, "B")) observedOnly.add(e.b.path);
      if (e.c && isTestSide(e, "C")) observedOnly.add(e.c.path);
    }
  }
  return {
    noBaselineB,
    observedOnly,
    triggerPairs: pairs.filter((p) => !observedOnly.has(p.c.path)),
    input,
    T: input.policy.complexity.cognitive_limit,
    bUnits,
    cUnits,
    byC,
    byB,
    matches,
    pairs,
    pairByC: new Map(pairs.map((p) => [p.c.path, p])),
    scopeChanges,
  };
}

function measuredCEntries(ctx: Ctx): Array<{ entry: ManifestEntry; file: FileMeasurement }> {
  const out: Array<{ entry: ManifestEntry; file: FileMeasurement }> = [];
  for (const entry of ctx.input.manifest.entries) {
    if (!entry.c || !entry.measure.C) continue;
    const file = ctx.input.c.get(entry.c.path);
    if (file) out.push({ entry, file });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decision (spec 5.3)
// ---------------------------------------------------------------------------

/** Unmatched B units over the limit that could plausibly be this C unit's origin. */
/**
 * Unmatched over-limit B units that could be this C unit's origin: in the
 * paired file any unit of the same kind (it lost its identity), elsewhere in
 * the PR a unit with the same name. Files without a baseline offer none.
 */
function plausibleOrigins(ctx: Ctx, cu: Unit): Unit[] {
  const pair = ctx.pairByC.get(cu.path);
  const name = cu.name === ANONYMOUS ? undefined : normalizeName(cu.name);
  const out: Unit[] = [];
  for (const bu of ctx.bUnits.values()) {
    if (bu.isResidue !== cu.isResidue || bu.cognitive <= ctx.T || ctx.byB.has(bu.key)) continue;
    if (ctx.noBaselineB.has(bu.path)) continue;
    if (pair && bu.path === pair.b.path) {
      if (bu.kind === cu.kind) out.push(bu);
    } else if (name !== undefined && bu.name !== ANONYMOUS && normalizeName(bu.name) === name) {
      out.push(bu);
    }
  }
  return out;
}

function judgeUnit(ctx: Ctx, cu: Unit, obs: ComplexityObserve): Violation | undefined {
  const T = ctx.T;
  const m = ctx.byC.get(cu.key);
  const bu = m ? ctx.bUnits.get(m.bKey) : undefined;
  const before = bu?.cognitive;
  const legacy = before !== undefined && before > T;
  const limit = before !== undefined ? Math.max(T, before) : T;
  if (legacy && cu.cognitive <= limit) {
    obs.legacy_debt.push({
      unit: cu.key,
      line: cu.line,
      cognitive: cu.cognitive,
      cyclomatic: cu.cyclomatic,
      before,
    });
  }
  if (cu.cognitive <= limit) return undefined;

  let reason: Violation["reason"];
  const details: Record<string, unknown> = {
    inclusive_cognitive: cu.inclusiveCognitive,
    cyclomatic_observe: cu.cyclomatic,
    stage: m?.stage ?? null,
    legacy_debt: legacy,
  };
  if (bu) {
    reason = legacy ? "LEGACY_WORSENED" : "OVER_LIMIT";
  } else {
    const origins = plausibleOrigins(ctx, cu);
    if (origins.length > 0) {
      reason = "UNMATCHED_OVER_BUDGET";
      obs.unmatched_over_budget++;
      details.b_candidates = origins.map((o) => ({
        unit: o.key,
        line: o.line,
        cognitive: o.cognitive,
      }));
    } else {
      reason = "OVER_LIMIT_NEW";
    }
  }
  const what = legacy ? `기존 ${before}에서 증가` : `한도 ${limit} 초과`;
  return {
    gate: "complexity",
    reason,
    file: cu.path,
    unit: cu.key,
    line: cu.line,
    metric: "cognitive",
    before: before ?? null,
    after: cu.cognitive,
    limit,
    message: `${cu.isResidue ? "<module>" : cu.name}: CogC ${cu.cognitive}, ${what} (${reason})`,
    details,
  };
}

// ---------------------------------------------------------------------------
// Triggers (spec 7.5)
// ---------------------------------------------------------------------------

interface SideStats {
  v: number;
  units: number;
  maxCog: number;
}

function stats(files: readonly FileMeasurement[]): SideStats {
  return {
    v: files.reduce((s, f) => s + visibleBranches(f), 0),
    units: files.reduce((s, f) => s + countableUnits(f).length, 0),
    maxCog: files.reduce((mx, f) => Math.max(mx, maxCognitive(f)), 0),
  };
}

function crossedLimit(ctx: Ctx, files: readonly FileMeasurement[]): boolean {
  return files.some((f) =>
    allUnits(f).some((cu) => {
      const m = ctx.byC.get(cu.key);
      const bu = m && ctx.bUnits.get(m.bKey);
      return !!bu && bu.cognitive > ctx.T && cu.cognitive <= ctx.T;
    }),
  );
}

function redistribution(ctx: Ctx, bFiles: FileMeasurement[], cFiles: FileMeasurement[]) {
  const s1 = ctx.input.policy.triggers.s1;
  const b = stats(bFiles);
  const c = stats(cFiles);
  const fires =
    c.v >= b.v - s1.visible_branch_slack &&
    c.units - b.units >= s1.min_unit_increase &&
    (b.maxCog - c.maxCog >= s1.min_max_cognitive_drop || crossedLimit(ctx, cFiles));
  return {
    fires,
    evidence: `V ${b.v}→${c.v}, 단위 ${b.units}→${c.units}, 최대 CogC ${b.maxCog}→${c.maxCog}`,
  };
}

function s1Triggers(ctx: Ctx): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const p of ctx.triggerPairs) {
    const r = redistribution(ctx, [p.b], [p.c]);
    if (r.fires) hits.push({ id: "S1", gate: "complexity", file: p.c.path, evidence: r.evidence, routing: true });
  }
  if (hits.length > 0) return hits;
  // PR-wide: redistribution across files (file split) is invisible per pair.
  const bFiles: FileMeasurement[] = [];
  const cFiles: FileMeasurement[] = [];
  for (const e of ctx.input.manifest.entries) {
    const bf = e.b && e.measure.B ? ctx.input.b.get(e.b.path) : undefined;
    const cf = e.c && e.measure.C ? ctx.input.c.get(e.c.path) : undefined;
    if (bf && !ctx.observedOnly.has(bf.path)) bFiles.push(bf);
    if (cf && !ctx.observedOnly.has(cf.path)) cFiles.push(cf);
  }
  if (bFiles.length + cFiles.length > 1) {
    const r = redistribution(ctx, bFiles, cFiles);
    if (r.fires) {
      hits.push({ id: "S1", gate: "complexity", evidence: `PR 전체: ${r.evidence}`, routing: true });
    }
  }
  return hits;
}

function changedOrNew(ctx: Ctx, cu: Unit, hunks: readonly Hunk[] | undefined): boolean {
  if (!ctx.byC.has(cu.key)) return true;
  return hunks !== undefined && cRangeTouched(hunks, cu.line, cu.endLine);
}

function s2Triggers(ctx: Ctx, cFiles: Array<{ entry: ManifestEntry; file: FileMeasurement }>): TriggerHit[] {
  const cfg = ctx.input.policy.complexity;
  const hits: TriggerHit[] = [];
  for (const { file } of cFiles) {
    const hunks = ctx.pairByC.get(file.path)?.hunks;
    for (const cu of flattenUnits(file.units)) {
      if (!changedOrNew(ctx, cu, hunks)) continue;
      // Top-level callbacks (`app.get("/", (req, res) => {…})`) count too (audit F11).
      if (cu.name === ANONYMOUS && cu.cognitive >= cfg.anonymous_child_trigger) {
        hits.push({
          id: "S2",
          gate: "complexity",
          file: file.path,
          unit: cu.key,
          evidence: `익명 ${cu.parentKey === null ? "최상위 콜백" : "자식"} ${cu.key} (행 ${cu.line}) CogC ${cu.cognitive} ≥ ${cfg.anonymous_child_trigger}`,
          routing: true,
        });
      } else if (cu.cognitive <= ctx.T && cu.inclusiveCognitive > cfg.inclusive_cognitive_trigger) {
        hits.push({
          id: "S2",
          gate: "complexity",
          file: file.path,
          unit: cu.key,
          evidence: `${displayName(cu)}: 자기 CogC ${cu.cognitive}, 포함 CogC ${cu.inclusiveCognitive} > ${cfg.inclusive_cognitive_trigger}`,
          routing: true,
        });
      }
    }
  }
  return hits;
}

function s5Triggers(ctx: Ctx): TriggerHit[] {
  const hits: TriggerHit[] = [];
  const seen = new Set<string>();
  const push = (u: Unit, file: string, evidence: string) => {
    if (seen.has(u.key)) return;
    seen.add(u.key);
    hits.push({ id: "S5", gate: "complexity", file, unit: u.key, evidence, routing: true });
  };
  for (const p of ctx.triggerPairs) {
    if (p.hunks.length === 0) continue;
    for (const bu of flattenUnits(p.b.units)) {
      const m = ctx.byB.get(bu.key);
      if (!m || bu.cognitive <= ctx.T) continue;
      if (bRangeTouched(p.hunks, bu.line, bu.endLine)) {
        const cu = ctx.cUnits.get(m.cKey);
        push(bu, p.c.path, `부채 단위 ${bu.name} (B CogC ${bu.cognitive} → C ${cu?.cognitive ?? "?"}) 범위 ${bu.line}-${bu.endLine} 수정`);
      }
    }
    // The residue's range is every gap between units (spec 7.5 S5): any
    // change in its scores means it was edited, and so does a hunk in a gap.
    const br = p.b.residue;
    const cr = p.c.residue;
    if (br.cognitive > ctx.T) {
      const scoreChanged = br.cognitive !== cr.cognitive || br.cyclomatic !== cr.cyclomatic;
      const gap = residueGaps(ctx, p.b).find(([s, e]) => bGapTouched(p.hunks, s, e));
      if (scoreChanged || gap) {
        const where = gap ? `범위 ${gap[0]}-${Math.max(gap[0], gap[1])} 수정` : "점수 변화";
        push(br, p.c.path, `부채 <module> residue (B CogC ${br.cognitive} → C ${cr.cognitive}) ${where}`);
      }
    }
  }
  for (const m of ctx.matches) {
    if (!m.identityChanged) continue;
    const bu = ctx.bUnits.get(m.bKey);
    if (!bu || bu.cognitive <= ctx.T || ctx.observedOnly.has(bu.path)) continue;
    const file = ctx.cUnits.get(m.cKey)?.path ?? m.cKey.slice(0, m.cKey.indexOf("::"));
    if (seen.has(bu.key)) {
      const hit = hits.find((h) => h.unit === bu.key);
      if (hit) hit.evidence += `; identity-changed (stage ${m.stage})`;
    } else {
      push(bu, file, `identity-changed: ${bu.key} → ${m.cKey} (stage ${m.stage}, B CogC ${bu.cognitive})`);
    }
  }
  return hits;
}

/**
 * B-side line ranges that belong to the `<module>` residue: the file head up
 * to the first top-level unit, the gap after each unit's closing brace up to
 * the next unit, and the tail after the last one. cccc gives no end line, so
 * the closing brace comes from the token scan of the B source; without the
 * source only the head is known (the old, conservative behaviour).
 */
function residueGaps(ctx: Ctx, b: FileMeasurement): Array<[number, number]> {
  const src = ctx.input.sourcesB?.get(b.path);
  const gaps: Array<[number, number]> = [];
  let from = 1;
  for (const u of b.units) {
    gaps.push([from, u.line - 1]);
    if (src === undefined) return gaps;
    from = unitLastLine(src, u) + 1;
  }
  gaps.push([from, Math.max(b.lineCount, from - 1)]);
  return gaps;
}

function lines(ctx: Ctx, p: FilePair): { b: number; c: number; normalized: boolean } {
  const n = ctx.input.normalizedLines?.get(p.c.path);
  if (n?.B !== undefined && n.C !== undefined) return { b: n.B, c: n.C, normalized: true };
  return { b: p.b.lineCount, c: p.c.lineCount, normalized: false };
}

function s9Triggers(ctx: Ctx): TriggerHit[] {
  const cfg = ctx.input.policy.triggers.s9;
  const hits: TriggerHit[] = [];
  for (const p of ctx.triggerPairs) {
    const vb = visibleBranches(p.b);
    const vc = visibleBranches(p.c);
    const drop = vb - vc;
    const minLines = cfg.min_branch_drop_lines;
    if (vb <= 0 || drop < Math.min(cfg.min_branch_drop, minLines)) continue;
    const l = lines(ctx, p);
    const lineDrop = l.b > 0 ? (l.b - l.c) / l.b : 0;
    const branchDrop = drop / vb;
    const densityB = vb / Math.max(1, l.b);
    const densityC = vc / Math.max(1, l.c);
    const densityDrop = (densityB - densityC) / densityB;
    // Ruling D20: the line path already demands that lines did not shrink
    // (the V10 shape), so it needs a smaller absolute drop than the density path.
    const byLines = drop >= minLines && branchDrop > cfg.branch_drop_ratio && lineDrop < cfg.max_line_drop_ratio;
    const byDensity = drop >= cfg.min_branch_drop && densityDrop >= cfg.density_drop_ratio;
    if (!byLines && !byDensity) continue;
    const pct = (x: number) => `${x >= 0 ? "−" : "+"}${Math.abs(Math.round(x * 100))}%`;
    hits.push({
      id: "S9",
      gate: "complexity",
      file: p.c.path,
      evidence:
        `V ${vb}→${vc} (${pct(branchDrop)}), 행 ${l.b}→${l.c} (${pct(lineDrop)}` +
        `${l.normalized ? "" : ", 비정규화 행 수"}), 분기 밀도 ${densityB.toFixed(2)}→${densityC.toFixed(2)}`,
      routing: true,
    });
  }
  return hits;
}

function s10Triggers(ctx: Ctx, cFiles: Array<{ entry: ManifestEntry; file: FileMeasurement }>): TriggerHit[] {
  const cfg = ctx.input.policy.triggers.s10;
  const hits: TriggerHit[] = [];
  for (const { file } of cFiles) {
    const units = countableUnits(file);
    const sumCog = units.reduce((s, u) => s + u.cognitive, 0);
    const density = units.length / (sumCog + 1);
    const fresh = units.filter((u) => !ctx.byC.has(u.key)).length;
    // Ruling D17: a file with few visible branches is ordinary glue code.
    const v = visibleBranches(file);
    const minV = cfg.min_visible_branches;
    if (density >= cfg.min_density && fresh >= cfg.min_new_units && v >= minV) {
      hits.push({
        id: "S10",
        gate: "complexity",
        file: file.path,
        evidence: `단위 ${units.length} / (ΣCogC ${sumCog} + 1) = ${density.toFixed(2)} ≥ ${cfg.min_density}, 새 단위 ${fresh}, V ${v}`,
        routing: true,
      });
    }
  }
  return hits;
}

/** Every identifier-like word of the source, NFKC-normalized (one pass instead of a regex per name). */
function identifierSet(source: string): Set<string> {
  return new Set(source.normalize("NFKC").match(/[\p{L}\p{N}_$]+/gu) ?? []);
}

const TEST_FILE_NAME = /\.(test|spec)\.[^/]+$/;

/**
 * Audit F3: a file that lands under a test glob without being named as a
 * test is production-shaped code hiding from enforcement. Test support
 * paths (fixtures, helpers, mocks: policy.scope.test_support_globs) are exempt. New files and
 * copies count; a rename out of product code is a scope change (S11 below,
 * whatever the C file is named).
 */
function isNewUnderTestGlob(ctx: Ctx, e: ManifestEntry): boolean {
  const scope = ctx.input.policy.scope;
  if (e.c && matchesAny(e.c.path, scope.test_support_globs)) return false;
  return e.status === "A" || e.status === "C";
}

/** Σ C − Σ B of file CogC over the PR's measured files. */
function netCognitiveChange(ctx: Ctx): number {
  let delta = 0;
  for (const e of ctx.input.manifest.entries) {
    if (e.b && e.measure.B) delta -= ctx.input.b.get(e.b.path)?.totalCognitive ?? 0;
    if (e.c && e.measure.C) delta += ctx.input.c.get(e.c.path)?.totalCognitive ?? 0;
  }
  return delta;
}

/**
 * Ruling D18 S12 residue shift. Per C file: residue ≥ 8, residue above the
 * file's function CogC, and the file is new or its residue rose by ≥ 5.
 * PR-wide: the summed residue rise over changed files exceeds 15.
 */
function s12Triggers(ctx: Ctx, cFiles: Array<{ entry: ManifestEntry; file: FileMeasurement }>): TriggerHit[] {
  const policy = ctx.input.policy;
  const { min_residue: minResidue, min_rise: minRise, pr_total_rise: prTotal } = policy.triggers.s12;
  const hits: TriggerHit[] = [];
  let totalRise = 0;
  const parts: string[] = [];
  for (const { entry, file } of cFiles) {
    const pair = ctx.pairByC.get(file.path);
    const before = pair ? pair.b.residue.cognitive : undefined;
    const isNew = entry.status === "A" || entry.status === "C" || (!pair && !(entry.b && entry.measure.B));
    const rC = file.residue.cognitive;
    const rise = rC - (before ?? 0);
    if (rise > 0) {
      totalRise += rise;
      parts.push(`${file.path} +${rise}`);
    }
    const fnCog = flattenUnits(file.units).reduce((s, u) => s + u.cognitive, 0);
    if (rC >= minResidue && rC > fnCog && (isNew || (before !== undefined && rise >= minRise))) {
      hits.push({
        id: "S12",
        gate: "complexity",
        file: file.path,
        unit: file.residue.key,
        evidence: `<module> residue ${before ?? "신규"}→${rC} (함수 CogC 합 ${fnCog})`,
        routing: true,
      });
    }
  }
  if (hits.length === 0 && totalRise > prTotal) {
    hits.push({ id: "S12", gate: "complexity", evidence: `PR 전체 residue 증가 ${totalRise} > ${prTotal}: ${parts.join(", ")}`, routing: true });
  }
  return hits;
}

/**
 * Manifest-level S11 plus unit vanish: a named B unit with no counterpart
 * whose name is still bound in the C file (e.g. `const price = new Function(…)`).
 * The binding check is a word-boundary search on the C source; it can
 * over-fire on comments or strings, which only costs a review.
 */
function s11Triggers(ctx: Ctx): TriggerHit[] {
  const hits: TriggerHit[] = [];
  const m = ctx.input.manifest;
  const foreignRoutes = ctx.input.isAiLoop === true || netCognitiveChange(ctx) < 0;
  for (const e of m.entries) {
    const path = e.c?.path ?? e.b?.path ?? "?";
    if (e.unmeasured === "FOREIGN_LANGUAGE") {
      // Ruling D5: foreign code is ordinary unless logic may have moved out of measurement.
      const why = ctx.input.isAiLoop ? "AI 수정 루프" : foreignRoutes ? "측정된 JS/TS의 순 CogC 감소" : "관측";
      hits.push({ id: "S11", gate: "complexity", file: path, evidence: `미측정: FOREIGN_LANGUAGE (${e.status}, ${why})`, routing: foreignRoutes });
    } else if (e.unmeasured) {
      hits.push({ id: "S11", gate: "complexity", file: path, evidence: `미측정: ${e.unmeasured} (${e.status})`, routing: true });
    }
    if (e.c && isTestSide(e, "C") && !TEST_FILE_NAME.test(e.c.path) && isNewUnderTestGlob(ctx, e)) {
      hits.push({ id: "S11", gate: "complexity", file: e.c.path, evidence: `테스트 경로의 비테스트 코드 (${e.status})`, routing: true });
    }
    if (e.newInExcludedPath) {
      hits.push({ id: "S11", gate: "complexity", file: path, evidence: `제외 경로의 신규 파일`, routing: true });
    }
  }
  for (const p of m.sensitivePathsChanged) {
    hits.push({ id: "S11", gate: "complexity", file: p, evidence: `민감 경로 변경: ${p}`, routing: true });
  }
  // A unit that crossed the test/product boundary keeps no allowance and is reviewed.
  for (const s of ctx.scopeChanges) {
    const what = s.bKey && s.cKey ? `${s.bKey} → ${s.cKey}` : `${s.bPath} → ${s.cPath}`;
    hits.push({
      id: "S11",
      gate: "complexity",
      file: s.cPath,
      ...(s.cKey ? { unit: s.cKey } : {}),
      evidence: `scope changed: ${s.from} → ${s.to} (${what})`,
      routing: true,
    });
  }
  // Unit vanish (spec 6.4): a named B unit with no counterpart whose name is
  // still bound in C. Another C unit of the same name is not a counterpart
  // (it did not match), so it does not clear the check. Signature-only rows
  // (overloads, `declare`, abstract) carry no logic and are skipped.
  for (const p of ctx.pairs) {
    const source = ctx.input.sourcesC?.get(p.c.path);
    if (source === undefined) continue;
    let identifiers: Set<string> | undefined;
    for (const bu of flattenUnits(p.b.units)) {
      if (bu.name === ANONYMOUS || bu.signatureOnly || ctx.byB.has(bu.key)) continue;
      const name = normalizeName(bu.name);
      identifiers ??= identifierSet(source);
      if (identifiers.has(name)) {
        hits.push({
          id: "S11",
          gate: "complexity",
          file: p.c.path,
          unit: bu.key,
          evidence: `단위 소실: ${bu.name} (B CogC ${bu.cognitive}, CC ${bu.cyclomatic})가 사라졌지만 이름이 C 파일에 남아 있음`,
          routing: true,
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------

export function evaluateComplexity(input: ComplexityInput): ComplexityOutcome {
  const ctx = buildCtx(input);
  const cfg = input.policy.complexity;
  const obs: ComplexityObserve = {
    cc_ge_20: [],
    s8_near_limit: [],
    legacy_debt: [],
    inclusive_cognitive: {},
    unmatched_over_budget: 0,
    test_file_violations: [],
    name_warnings: [],
  };
  const violations: Violation[] = [];
  const triggers: TriggerHit[] = [];
  const cFiles = measuredCEntries(ctx);
  const triggerFiles = cFiles.filter(({ file }) => !ctx.observedOnly.has(file.path));

  for (const { entry, file } of cFiles) {
    // Keyed on the C side: a test→product rename is product code now and is enforced.
    const enforce = !isTestSide(entry, "C") || cfg.enforce_on_tests;
    const hunks = ctx.pairByC.get(file.path)?.hunks;
    for (const cu of allUnits(file)) {
      if (cu.signatureOnly) continue;
      if (!cu.isResidue && cu.cyclomatic >= cfg.cyclomatic_observe_mark) {
        obs.cc_ge_20.push({ unit: cu.key, line: cu.line, cognitive: cu.cognitive, cyclomatic: cu.cyclomatic });
      }
      if (!cu.isResidue && changedOrNew(ctx, cu, hunks)) {
        obs.inclusive_cognitive[cu.key] = cu.inclusiveCognitive;
      }
      const isNew = !ctx.byC.has(cu.key);
      if (enforce && isNew && cu.cognitive >= cfg.near_limit_low && cu.cognitive <= ctx.T) {
        const o = { unit: cu.key, line: cu.line, cognitive: cu.cognitive, cyclomatic: cu.cyclomatic };
        obs.s8_near_limit.push(o);
        triggers.push({
          id: "S8",
          gate: "complexity",
          file: file.path,
          unit: cu.key,
          evidence: `신규 단위 CogC ${cu.cognitive} (한도 ${ctx.T} 근접)`,
          routing: false,
        });
      }
      const v = judgeUnit(ctx, cu, obs);
      if (v) (enforce ? violations : obs.test_file_violations).push(v);
    }
    for (const u of allUnits(file)) {
      const check = u.isResidue || u.name === ANONYMOUS ? undefined : checkName(u.name);
      if (check?.suspicious) obs.name_warnings.push({ unit: u.key, warning: check.warning ?? "" });
    }
  }

  triggers.push(
    ...s1Triggers(ctx),
    ...s2Triggers(ctx, triggerFiles),
    ...s5Triggers(ctx),
    ...s9Triggers(ctx),
    ...s10Triggers(ctx, triggerFiles),
    ...s11Triggers(ctx),
    ...s12Triggers(ctx, triggerFiles),
  );

  // UNITS_VANISHED is measure.ts's cross-check (bug #11); G1 keeps the field for compatibility.
  return { violations, triggers, observe: obs, inconclusive: [] };
}

