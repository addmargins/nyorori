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
import {
  bRangeTouched,
  cRangeTouched,
  filePairs,
  type FilePair,
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
  /** C paths whose B side failed to parse. */
  baselineMissing?: ReadonlySet<string>;
  /** The PR was authored by the AI fix loop (ruling D5: foreign-language files always route). */
  isAiLoop?: boolean;
}

/**
 * Thresholds from rulings D17, D18 and D20 that the policy schema does not
 * carry yet. `policy.triggers.s9.min_branch_drop` remains the density-path
 * minimum; a policy may override the rest once the schema has the fields.
 */
const RULING_DEFAULTS = {
  s9_min_branch_drop_lines: 2,
  s10_min_visible_branches: 8,
  s12_min_residue: 8,
  s12_min_rise: 5,
  s12_pr_total_rise: 15,
};

function rulingThreshold(policy: Policy, group: "s9" | "s10" | "s12", field: string, key: keyof typeof RULING_DEFAULTS): number {
  const fromPolicy = (policy.triggers as Record<string, Record<string, unknown> | undefined>)[group]?.[field];
  return typeof fromPolicy === "number" ? fromPolicy : RULING_DEFAULTS[key];
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
  pairs: FilePair[];
  pairByC: Map<string, FilePair>;
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
  const byC = new Map<string, UnitMatch>();
  const byB = new Map<string, UnitMatch>();
  for (const m of input.matches) {
    byC.set(m.cKey, m);
    byB.set(m.bKey, m);
  }
  const pairs = filePairs(input);
  const noBaselineB = new Set<string>();
  const observedOnly = new Set<string>();
  for (const e of input.manifest.entries) {
    if (e.b && e.c && input.baselineMissing?.has(e.c.path)) noBaselineB.add(e.b.path);
    if (e.isTest && !input.policy.complexity.enforce_on_tests) {
      if (e.b) observedOnly.add(e.b.path);
      if (e.c) observedOnly.add(e.c.path);
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
    pairs,
    pairByC: new Map(pairs.map((p) => [p.c.path, p])),
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
    // The residue has no line range of its own: code before the first unit
    // is residue-only, and any change in residue scores means it was edited.
    const br = p.b.residue;
    const cr = p.c.residue;
    if (br.cognitive > ctx.T) {
      const firstUnit = p.b.units[0]?.line ?? p.b.lineCount + 1;
      const headTouched = bRangeTouched(p.hunks, 1, Math.max(1, firstUnit - 1));
      if (headTouched || br.cognitive !== cr.cognitive || br.cyclomatic !== cr.cyclomatic) {
        push(br, p.c.path, `부채 <module> residue (B CogC ${br.cognitive} → C ${cr.cognitive}) 수정`);
      }
    }
  }
  for (const m of ctx.input.matches) {
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
    const minLines = rulingThreshold(ctx.input.policy, "s9", "min_branch_drop_lines", "s9_min_branch_drop_lines");
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
    const minV = rulingThreshold(ctx.input.policy, "s10", "min_visible_branches", "s10_min_visible_branches");
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
 * test is production-shaped code hiding from enforcement. New files and
 * copies count, and so does a rename whose B path was outside the test globs.
 */
function isNewUnderTestGlob(ctx: Ctx, e: ManifestEntry): boolean {
  if (e.status === "A" || e.status === "C") return true;
  if (e.status === "R" && e.b) return !matchesAny(e.b.path, ctx.input.policy.scope.test_globs);
  return false;
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
  const minResidue = rulingThreshold(policy, "s12", "min_residue", "s12_min_residue");
  const minRise = rulingThreshold(policy, "s12", "min_rise", "s12_min_rise");
  const prTotal = rulingThreshold(policy, "s12", "pr_total_rise", "s12_pr_total_rise");
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
    if (e.c && e.isTest && !TEST_FILE_NAME.test(e.c.path) && isNewUnderTestGlob(ctx, e)) {
      hits.push({ id: "S11", gate: "complexity", file: e.c.path, evidence: `테스트 경로의 비테스트 코드 (${e.status})`, routing: true });
    }
    if (e.newInExcludedPath) {
      hits.push({ id: "S11", gate: "complexity", file: path, evidence: `제외 경로의 신규 파일`, routing: true });
    }
  }
  for (const p of m.sensitivePathsChanged) {
    hits.push({ id: "S11", gate: "complexity", file: p, evidence: `민감 경로 변경: ${p}`, routing: true });
  }
  for (const p of ctx.pairs) {
    const source = ctx.input.sourcesC?.get(p.c.path);
    if (source === undefined) continue;
    const cNames = new Set(flattenUnits(p.c.units).map((u) => normalizeName(u.name)));
    let identifiers: Set<string> | undefined;
    for (const bu of flattenUnits(p.b.units)) {
      if (bu.name === ANONYMOUS || ctx.byB.has(bu.key)) continue;
      const name = normalizeName(bu.name);
      if (cNames.has(name)) continue;
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
    const enforce = !entry.isTest || cfg.enforce_on_tests;
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

