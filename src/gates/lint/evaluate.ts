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
import { DYNAMIC_CODE_RULES, SUPPRESSION_RULE } from "./config.js";
import { isAllowlisted, scanBidi, type BidiHit } from "./text.js";
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
}

export interface LintEvaluation {
  violations: Violation[];
  triggers: TriggerHit[];
  inconclusive: Inconclusive[];
  observe: {
    new_observe_hits: Array<{ rule: string; file: string; line: number; unit: string }>;
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
  const lineMapByC = new Map(input.lineMaps.map((l) => [l.pathC, l]));
  const allow = policy.lint.suppression_allowlist;

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
    const lintB = pathB ? input.lintB.get(pathB) : undefined;
    if (lintB?.parseError) observe.base_parse_errors.push(pathB!);

    const isAdded = addedLines(pathB ? lineMapByC.get(pathC) : undefined);
    const mB = pathB ? input.measurementsB.get(pathB) : undefined;
    const mC = input.measurementsC.get(pathC);
    // Without unit trees on both sides, compare at file level so that a
    // missing measurement can only make the comparison stricter.
    const fileLevel = !mC || (pathB !== null && !mB);

    const countsB = new Map<string, number>();
    for (const msg of lintB?.messages ?? []) {
      if (isAllowedSuppression(msg, allow)) continue;
      const unitKey = fileLevel || !mB ? fileLevelKey(pathB!) : unitAtLine(mB, msg.line).key;
      const k = `${unitKey}|${groupOf(msg)}`;
      countsB.set(k, (countsB.get(k) ?? 0) + 1);
    }

    const groups = new Map<string, Attributed[]>();
    for (const msg of lintC.messages) {
      if (isAllowedSuppression(msg, allow)) continue;
      const a = attribute(msg, { fileLevel, mC, pathB, matchByC });
      const k = `${a.compareKey}|${groupOf(msg)}`;
      const list = groups.get(k) ?? [];
      list.push(a);
      groups.set(k, list);
    }

    for (const [k, list] of groups) {
      const baseline = countsB.get(k) ?? 0;
      const surplus = list.length - baseline;
      // Unit-level rules (S4, S10) look at the unit, not at the surplus.
      for (const a of list) routeUnitLevel(a, pathC, triggers);
      if (surplus <= 0) continue;
      // Prefer reporting the hits sitting on added lines as the new ones.
      const ordered = [...list].sort(
        (x, y) => Number(isAdded(y.msg.line)) - Number(isAdded(x.msg.line)) || x.msg.line - y.msg.line,
      );
      for (const a of ordered.slice(0, surplus)) {
        routeNew(a, pathC, { baseline, inC: list.length }, { violations, triggers, observe });
      }
    }

    const bidi = newBidi(input.sourcesB.get(pathB ?? ""), input.sourcesC.get(pathC), isAdded, pathB !== null);
    for (const hit of bidi) {
      violations.push({
        gate: GATE,
        reason: "BIDI_CONTROL",
        file: pathC,
        line: hit.line,
        metric: "bidi",
        message: `Bidirectional control character ${hit.codePoint} at ${pathC}:${hit.line}:${hit.column} can make code read differently than it runs (Trojan Source).`,
        details: { column: hit.column, codePoint: hit.codePoint },
      });
    }
  }

  return { violations, triggers: dedupeTriggers(triggers), inconclusive, observe };
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

function routeUnitLevel(a: Attributed, file: string, triggers: TriggerHit[]): void {
  const unit = a.cUnit?.key;
  if (a.msg.category === "trigger:S4" && (a.unitNew || a.matchStage === 2)) {
    triggers.push({
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
    triggers.push({
      id: "S10",
      gate: GATE,
      file,
      ...(unit ? { unit } : {}),
      evidence: `new helper mutates a parameter at ${file}:${a.msg.line}: ${a.msg.message}`,
      routing: true,
    });
  }
}

function routeNew(
  a: Attributed,
  file: string,
  counts: { baseline: number; inC: number },
  sink: Pick<LintEvaluation, "violations" | "triggers" | "observe">,
): void {
  const { msg } = a;
  const unit = a.cUnit?.key;
  sink.observe.new_hits_by_category[msg.category] = (sink.observe.new_hits_by_category[msg.category] ?? 0) + 1;
  switch (msg.category) {
    case "block": {
      const reason =
        msg.ruleId === SUPPRESSION_RULE ? "SUPPRESSION_ADDED" : DYNAMIC_CODE_RULES.has(msg.ruleId) ? "DYNAMIC_CODE" : "LINT_NEW_VIOLATION";
      const v: Violation = {
        gate: GATE,
        reason,
        file,
        line: msg.line,
        metric: msg.ruleId,
        before: counts.baseline,
        after: counts.inC,
        message:
          reason === "SUPPRESSION_ADDED"
            ? `Added suppression directive \`${msg.message}\` at ${file}:${msg.line}. Suppressions are not honoured by the gate and may not be added.`
            : `${msg.ruleId} at ${file}:${msg.line}: ${msg.message}`,
        details: { ruleId: msg.ruleId, column: msg.column, ...(msg.messageId ? { messageId: msg.messageId } : {}) },
      };
      if (unit) v.unit = unit;
      sink.violations.push(v);
      return;
    }
    case "trigger:S9":
      sink.triggers.push({
        id: "S9",
        gate: GATE,
        file,
        ...(unit ? { unit } : {}),
        evidence: `${file}:${msg.line}: ${msg.message}`,
        routing: true,
      });
      return;
    case "observe":
      sink.observe.new_observe_hits.push({ rule: msg.ruleId, file, line: msg.line, unit: unit ?? fileLevelKey(file) });
      return;
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

function dedupeTriggers(triggers: TriggerHit[]): TriggerHit[] {
  const seen = new Set<string>();
  return triggers.filter((t) => {
    const k = `${t.id}|${t.file}|${t.unit ?? ""}|${t.evidence}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** G2 state from the evaluation alone; waivers and mode are applied by the aggregator. */
export function lintState(e: LintEvaluation, manifestEntries: readonly ManifestEntry[]): GateState {
  if (e.violations.length > 0) return "FAIL";
  if (e.inconclusive.length > 0) return "INCONCLUSIVE";
  return manifestEntries.some((x) => x.c && x.measure.C) ? "PASS" : "NOT_APPLICABLE";
}
