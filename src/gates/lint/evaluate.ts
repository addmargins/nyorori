// G2 verdict: which lint hits are new in C, and where they route (spec 7.4).
//
// A hit is new when C has more hits of the same rule in a unit than B had in
// the matching unit. Hits are attributed to units rather than lines because
// rules such as max-params report on the function's first line even when the
// offending parameter was added further down.

import type { Policy } from "../../policy/schema.js";
import type {
  FileLineMap,
  FileMeasurement,
  GateState,
  Inconclusive,
  Manifest,
  ManifestEntry,
  TriggerHit,
  Unit,
  UnitMatch,
  Violation,
} from "../../types.js";
import { flattenUnits, residueKey } from "../../units/model.js";
import { matchesAny } from "../../util/glob.js";
import { DYNAMIC_CODE_RULES, OBSERVE_IN_TESTS, RULE_CATEGORY, SUPPRESSION_RULE } from "./config.js";
import { isAllowlisted, scanBidi, type BidiHit, type DirectiveKind } from "./text.js";
import type { FileLintResult, LintMessage } from "./types.js";

export interface EvaluateLintInput {
  manifest: Manifest;
  /** Lint results keyed by repository path on the B side. */
  lintB: ReadonlyMap<string, FileLintResult>;
  /** Lint results keyed by repository path on the C side. */
  lintC: ReadonlyMap<string, FileLintResult>;
  measurementsB: ReadonlyMap<string, FileMeasurement>;
  measurementsC: ReadonlyMap<string, FileMeasurement>;
  matches: readonly UnitMatch[];
  lineMaps: readonly FileLineMap[];
  sourcesB: ReadonlyMap<string, string>;
  sourcesC: ReadonlyMap<string, string>;
  policy: Policy;
  /** The PR comes from the AI fix loop: every added suppression fails (spec 12.2). */
  isAiLoop?: boolean;
}

export interface LintEvaluation {
  violations: Violation[];
  triggers: TriggerHit[];
  inconclusive: Inconclusive[];
  observe: {
    new_observe_hits: Array<{ rule: string; file: string; line: number; unit: string; why: string }>;
    new_hits_by_category: Record<string, number>;
    base_parse_errors: string[];
    files_linted: number;
  };
}

const GATE = "lint-structure" as const;

/** Innermost unit containing `line`; units starting on that exact line win. */
export function unitAtLine(m: FileMeasurement, line: number): Unit {
  const flat = flattenUnits(m.units);
  let best: Unit | undefined;
  for (const u of flat) {
    if (u.line === line && (!best || best.line !== line || u.depth > best.depth)) best = u;
  }
  if (best) return best;
  for (const u of flat) {
    if (u.line <= line && line <= u.endLine && (!best || u.depth > best.depth || (u.depth === best.depth && u.line > best.line))) {
      best = u;
    }
  }
  return best ?? m.residue;
}

function groupOf(msg: LintMessage): string {
  if (msg.ruleId === SUPPRESSION_RULE) return `${msg.ruleId}|${msg.message}`;
  return msg.messageId ? `${msg.ruleId}|${msg.messageId}` : msg.ruleId;
}

/** C lines that `git diff -U0` reports as added or modified. */
export function addedLines(map: FileLineMap | undefined): (line: number) => boolean {
  if (!map) return () => true; // whole file is new
  return (line) => map.hunks.some((h) => h.cCount > 0 && line >= h.cStart && line < h.cStart + h.cCount);
}

interface Attributed {
  msg: LintMessage;
  /** Key used for B↔C comparison: a B unit key, or `new:` + C unit key. */
  compareKey: string;
  cUnit: Unit | null;
  unitNew: boolean;
  matchStage?: number;
}

function fileLevelKey(path: string): string {
  return `${path}::<file>`;
}

interface FileWork {
  pathC: string;
  pathB: string | null;
  isTest: boolean;
  isAdded: (line: number) => boolean;
  groups: Map<string, Attributed[]>;
}

/** Per (B file, rule group): hits that sat in B units which no longer exist in C. */
type CreditPools = Map<string, Map<string, number>>;

export function evaluateLint(input: EvaluateLintInput): LintEvaluation {
  const { manifest, policy } = input;
  const violations: Violation[] = [];
  const triggers: TriggerHit[] = [];
  const inconclusive: Inconclusive[] = [];
  const observe: LintEvaluation["observe"] = {
    new_observe_hits: [],
    new_hits_by_category: {},
    base_parse_errors: [],
    files_linted: 0,
  };

  const matchByC = new Map(input.matches.map((m) => [m.cKey, m]));
  const matchedB = new Set(input.matches.map((m) => m.bKey));
  const lineMapByC = new Map(input.lineMaps.map((l) => [l.pathC, l]));
  const allow = policy.lint.suppression_allowlist;
  const ctx: RouteContext = {
    isAiLoop: input.isAiLoop === true,
    dynamicAllowlist: policy.lint.dynamic_code_allowlist,
  };

  // Baseline counts over every B file, so a unit that moved to another file
  // (stage-4 match) keeps its baseline. Counts are kept both per unit and per
  // file, for C files that must fall back to file-level comparison.
  const countsB = new Map<string, number>();
  const credits: CreditPools = new Map();
  const cPathsWithB = new Set(manifest.entries.flatMap((e) => (e.c && e.b ? [e.b.path] : [])));
  for (const entry of manifest.entries) {
    if (!entry.b || !entry.measure.B) continue;
    const pathB = entry.b.path;
    const lintB = input.lintB.get(pathB);
    if (!lintB) continue;
    if (lintB.parseError) observe.base_parse_errors.push(pathB);
    const mB = input.measurementsB.get(pathB);
    const fileDeleted = !cPathsWithB.has(pathB);
    for (const msg of lintB.messages) {
      if (isAllowedSuppression(msg, allow)) continue;
      const group = groupOf(msg);
      bump(countsB, `${fileLevelKey(pathB)}|${group}`);
      if (!mB) continue;
      const unit = unitAtLine(mB, msg.line);
      bump(countsB, `${unit.key}|${group}`);
      const vanished = unit.isResidue ? fileDeleted : !matchedB.has(unit.key);
      if (vanished) bump(pool(credits, pathB), group);
    }
  }

  const work: FileWork[] = [];
  for (const entry of manifest.entries) {
    if (!entry.c || !entry.measure.C) continue;
    const pathC = entry.c.path;
    const lintC = input.lintC.get(pathC);
    if (!lintC) {
      inconclusive.push({ reason: "REPORT_MISSING", file: pathC, detail: "no lint result for a measured file", authorFixable: false });
      continue;
    }
    if (lintC.parseError) {
      inconclusive.push({
        reason: "PARSE_ERROR_CANDIDATE",
        file: pathC,
        detail: `ESLint could not parse the file: ${lintC.parseError.message} (${lintC.parseError.line}:${lintC.parseError.column})`,
        authorFixable: true,
      });
      continue;
    }
    observe.files_linted++;
    const pathB = entry.b && entry.measure.B ? entry.b.path : null;
    const mB = pathB ? input.measurementsB.get(pathB) : undefined;
    const mC = input.measurementsC.get(pathC);
    // Without unit trees on both sides, compare at file level so that a
    // missing measurement can only make the comparison stricter.
    const fileLevel = !mC || (pathB !== null && !mB);
    const groups = new Map<string, Attributed[]>();
    for (const msg of lintC.messages) {
      if (isAllowedSuppression(msg, allow)) continue;
      const a = attribute(msg, { fileLevel, mC, pathB, matchByC });
      const k = `${a.compareKey}|${groupOf(msg)}`;
      const list = groups.get(k) ?? [];
      list.push(a);
      groups.set(k, list);
    }
    work.push({
      pathC,
      pathB,
      isTest: entry.isTest ?? matchesAny(pathC, policy.scope.test_globs),
      isAdded: addedLines(pathB ? lineMapByC.get(pathC) : undefined),
      groups,
    });
  }

  // Hits in unmatched C units are new unless they replace hits whose B unit
  // vanished (ruling D21c): first from the same file, then PR-wide for moves.
  // Only vanished units give credit, so fixing a hit elsewhere never pays
  // for a new one (spec 5.2, no offsetting).
  const newCount = new Map<string, number>();
  for (const pass of ["local", "global"] as const) {
    for (const w of work) {
      for (const [k, list] of w.groups) {
        if (!k.startsWith("new:")) continue;
        const group = groupOf(list[0]!.msg);
        let remaining = newCount.get(`${w.pathC}\u0000${k}`) ?? list.length;
        const sources = pass === "local" ? (w.pathB ? [w.pathB] : []) : [...credits.keys()];
        for (const src of sources) {
          if (remaining === 0) break;
          const p = credits.get(src);
          const take = Math.min(remaining, p?.get(group) ?? 0);
          if (take > 0) {
            p!.set(group, p!.get(group)! - take);
            remaining -= take;
          }
        }
        newCount.set(`${w.pathC}\u0000${k}`, remaining);
      }
    }
  }

  for (const w of work) {
    const sink = { violations, triggers, observe };
    for (const [k, list] of w.groups) {
      const baseline = k.startsWith("new:") ? 0 : (countsB.get(k) ?? 0);
      const surplus = k.startsWith("new:") ? newCount.get(`${w.pathC}\u0000${k}`)! : list.length - baseline;
      // Unit-level rules (S4, S10) look at the unit, not at the surplus.
      for (const a of list) routeUnitLevel(a, w, sink);
      if (surplus <= 0) continue;
      // Prefer reporting the hits sitting on added lines as the new ones.
      const ordered = [...list].sort(
        (x, y) => Number(w.isAdded(y.msg.line)) - Number(w.isAdded(x.msg.line)) || x.msg.line - y.msg.line,
      );
      for (const a of ordered.slice(0, surplus)) {
        routeNew(a, w, { baseline: list.length - surplus, inC: list.length }, ctx, sink);
      }
    }

    const bidi = newBidi(input.sourcesB.get(w.pathB ?? ""), input.sourcesC.get(w.pathC), w.isAdded, w.pathB !== null);
    for (const hit of bidi) {
      violations.push({
        gate: GATE,
        reason: "BIDI_CONTROL",
        file: w.pathC,
        line: hit.line,
        metric: "bidi",
        message: `Bidirectional control character ${hit.codePoint} at ${w.pathC}:${hit.line}:${hit.column} can make code read differently than it runs (Trojan Source).`,
        details: { column: hit.column, codePoint: hit.codePoint },
      });
    }
  }

  return { violations, triggers: dedupeTriggers(triggers), inconclusive, observe };
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function pool(credits: CreditPools, path: string): Map<string, number> {
  let p = credits.get(path);
  if (!p) credits.set(path, (p = new Map()));
  return p;
}

function isAllowedSuppression(msg: LintMessage, allow: readonly string[]): boolean {
  if (msg.ruleId !== SUPPRESSION_RULE) return false;
  return isAllowlisted({ kind: "eslint-disable", normalized: msg.message }, allow);
}

function attribute(
  msg: LintMessage,
  ctx: {
    fileLevel: boolean;
    mC: FileMeasurement | undefined;
    pathB: string | null;
    matchByC: ReadonlyMap<string, UnitMatch>;
  },
): Attributed {
  const { fileLevel, mC, pathB, matchByC } = ctx;
  if (fileLevel || !mC) {
    return {
      msg,
      compareKey: pathB ? fileLevelKey(pathB) : `new:${mC?.path ?? "?"}`,
      cUnit: null,
      unitNew: pathB === null,
    };
  }
  const cUnit = unitAtLine(mC, msg.line);
  if (cUnit.isResidue) {
    return { msg, compareKey: pathB ? residueKey(pathB) : `new:${cUnit.key}`, cUnit, unitNew: false };
  }
  const match = matchByC.get(cUnit.key);
  if (!match) return { msg, compareKey: `new:${cUnit.key}`, cUnit, unitNew: true };
  return { msg, compareKey: match.bKey, cUnit, unitNew: false, matchStage: match.stage };
}

interface RouteContext {
  isAiLoop: boolean;
  dynamicAllowlist: readonly string[];
}

type Sink = Pick<LintEvaluation, "violations" | "triggers" | "observe">;

function observeHit(sink: Sink, msg: LintMessage, file: string, unit: string | undefined, why: string): void {
  sink.observe.new_observe_hits.push({ rule: msg.ruleId, file, line: msg.line, unit: unit ?? fileLevelKey(file), why });
}

function routeUnitLevel(a: Attributed, w: FileWork, sink: Sink): void {
  const unit = a.cUnit?.key;
  const file = w.pathC;
  if (a.msg.category === "trigger:S4" && (a.unitNew || a.matchStage === 2)) {
    // Ruling D11: S4 is observe in test files.
    if (w.isTest) return observeHit(sink, a.msg, file, unit, "S4 in a test file");
    sink.triggers.push({
      id: "S4",
      gate: GATE,
      file,
      ...(unit ? { unit } : {}),
      evidence: `${a.unitNew ? "new" : "re-declared"} function at ${file}:${a.msg.line}: ${a.msg.message}`,
      routing: true,
    });
  }
  // S10 targets helpers that mutate a shared context object; rebinding a
  // parameter (`n += 1`) is local and says nothing about splitting.
  if (a.msg.category === "trigger:S10" && a.unitNew && a.msg.messageId !== "assignmentToFunctionParam") {
    if (w.isTest) return observeHit(sink, a.msg, file, unit, "S10 in a test file");
    sink.triggers.push({
      id: "S10",
      gate: GATE,
      file,
      ...(unit ? { unit } : {}),
      evidence: `new helper mutates a parameter at ${file}:${a.msg.line}: ${a.msg.message}`,
      routing: true,
    });
  }
}

type SuppressionVerdict = "block" | "waivable" | "observe";

/** Rule names an eslint directive mentions: `eslint-disable a,b` / `eslint a: off, b: 2`. */
function directiveRules(normalized: string): string[] {
  if (normalized.startsWith("eslint-disable")) {
    const list = normalized.split(" ")[1];
    return list ? list.split(",") : [];
  }
  return [...normalized.slice("eslint ".length).matchAll(/([@\w/-]+)\s*:/g)].map((m) => m[1]!);
}

/**
 * Rulings D9 + D14. Non-waivable: anything that switches off a rule the gate
 * runs, `@ts-nocheck`, coverage and mutation ignore hints. `@ts-ignore` is a
 * waivable FAIL. `@ts-expect-error` and directives naming only rules the gate
 * does not run are observe. The AI loop may add none of them (spec 12.2).
 */
export function suppressionVerdict(msg: LintMessage, isAiLoop: boolean): SuppressionVerdict {
  if (isAiLoop) return "block";
  switch (msg.messageId as DirectiveKind | undefined) {
    case "eslint-disable":
    case "eslint-config": {
      const rules = directiveRules(msg.message);
      if (rules.length === 0) return "block";
      return rules.some((r) => r in RULE_CATEGORY) ? "block" : "observe";
    }
    case "ts-ignore":
      return "waivable";
    case "ts-expect-error":
      return "observe";
    default:
      return "block";
  }
}

function routeNew(
  a: Attributed,
  w: FileWork,
  counts: { baseline: number; inC: number },
  ctx: RouteContext,
  sink: Sink,
): void {
  const { msg } = a;
  const unit = a.cUnit?.key;
  const file = w.pathC;
  sink.observe.new_hits_by_category[msg.category] = (sink.observe.new_hits_by_category[msg.category] ?? 0) + 1;
  switch (msg.category) {
    case "block": {
      let reason: Violation["reason"] = "LINT_NEW_VIOLATION";
      let waivable = false;
      if (msg.ruleId === SUPPRESSION_RULE) {
        const verdict = suppressionVerdict(msg, ctx.isAiLoop);
        if (verdict === "observe") return observeHit(sink, msg, file, unit, "suppression of a rule the gate does not run");
        waivable = verdict === "waivable";
        reason = waivable ? "SUPPRESSION_ADDED_WAIVABLE" : "SUPPRESSION_ADDED";
      } else if (DYNAMIC_CODE_RULES.has(msg.ruleId)) {
        if (matchesAny(file, ctx.dynamicAllowlist)) return observeHit(sink, msg, file, unit, "lint.dynamic_code_allowlist");
        reason = "DYNAMIC_CODE";
      } else if (w.isTest && OBSERVE_IN_TESTS.has(msg.ruleId)) {
        return observeHit(sink, msg, file, unit, "observe in test files (D11)");
      }
      const v: Violation = {
        gate: GATE,
        reason,
        file,
        line: msg.line,
        metric: msg.ruleId,
        before: counts.baseline,
        after: counts.inC,
        message:
          msg.ruleId === SUPPRESSION_RULE
            ? `Added suppression directive \`${msg.message}\` at ${file}:${msg.line}. Suppressions are not honoured by the gate${waivable ? "; a waiver can accept this one" : " and may not be added"}.`
            : `${msg.ruleId} at ${file}:${msg.line}: ${msg.message}`,
        details: {
          ruleId: msg.ruleId,
          column: msg.column,
          waivable,
          ...(msg.messageId ? { messageId: msg.messageId } : {}),
        },
      };
      if (unit) v.unit = unit;
      sink.violations.push(v);
      return;
    }
    case "trigger:S9":
      if (w.isTest) return observeHit(sink, msg, file, unit, "S9 in a test file");
      sink.triggers.push({ id: "S9", gate: GATE, file, ...(unit ? { unit } : {}), evidence: `${file}:${msg.line}: ${msg.message}`, routing: true });
      return;
    case "trigger:S11":
      sink.triggers.push({ id: "S11", gate: GATE, file, ...(unit ? { unit } : {}), evidence: `${file}:${msg.line}: ${msg.message}`, routing: true });
      return;
    case "observe":
      return observeHit(sink, msg, file, unit, "observe rule");
    default:
      return; // S4/S10 are routed per unit
  }
}

function newBidi(
  sourceB: string | undefined,
  sourceC: string | undefined,
  isAdded: (line: number) => boolean,
  hasBase: boolean,
): BidiHit[] {
  if (sourceC === undefined) return [];
  const hitsC = scanBidi(sourceC);
  const baseline = hasBase && sourceB !== undefined ? scanBidi(sourceB).length : 0;
  const surplus = hitsC.length - baseline;
  if (surplus <= 0) return [];
  const ordered = [...hitsC].sort((x, y) => Number(isAdded(y.line)) - Number(isAdded(x.line)) || x.line - y.line);
  return ordered.slice(0, surplus).sort((x, y) => x.line - y.line || x.column - y.column);
}

/** One trigger per (id, unit) for unit-level signals; their evidence is merged. */
function dedupeTriggers(triggers: TriggerHit[]): TriggerHit[] {
  const byKey = new Map<string, TriggerHit>();
  for (const t of triggers) {
    const unitLevel = (t.id === "S4" || t.id === "S10") && t.unit !== undefined;
    const k = unitLevel ? `${t.id}|${t.file}|${t.unit}` : `${t.id}|${t.file}|${t.unit ?? ""}|${t.evidence}`;
    const seen = byKey.get(k);
    if (!seen) byKey.set(k, { ...t });
    else if (!seen.evidence.split("; ").includes(t.evidence)) seen.evidence += `; ${t.evidence}`;
  }
  return [...byKey.values()];
}

/** G2 state from the evaluation alone; waivers and mode are applied by the aggregator. */
export function lintState(e: LintEvaluation, manifestEntries: readonly ManifestEntry[]): GateState {
  if (e.violations.length > 0) return "FAIL";
  if (e.inconclusive.length > 0) return "INCONCLUSIVE";
  return manifestEntries.some((x) => x.c && x.measure.C) ? "PASS" : "NOT_APPLICABLE";
}
