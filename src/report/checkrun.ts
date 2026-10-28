// GitHub check-run payloads. GitHub treats `neutral` and `skipped` as passing
// for required checks, so this module can only ever emit success or failure.

import type { GateResult, GateState } from "../types.js";
import { shadowNote } from "../aggregate/index.js";
import { QUALITY_GATE_CHECK, type QualityGateVerdict } from "../aggregate/types.js";
import { renderGateSection, renderSummaryMarkdown } from "./markdown.js";

export type CheckConclusion = "success" | "failure";

export interface CheckRunOutput {
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  text?: string;
}

/** GitHub limits: title 255? (practically), summary/text 65535 characters. */
const MAX_TITLE = 250;
const MAX_BODY = 65_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n…(truncated)`;
}

export function conclusionFor(state: GateState): CheckConclusion {
  return state === "PASS" || state === "NOT_APPLICABLE" || state === "ACCEPTED_WITH_WAIVER" ? "success" : "failure";
}

function titleFor(state: GateState, headline: string, reasons: readonly string[]): string {
  switch (state) {
    case "NOT_APPLICABLE":
      return "N/A";
    case "INCONCLUSIVE":
      return `INCONCLUSIVE: ${reasons.join(", ") || "unknown"}`;
    default:
      return headline;
  }
}

/**
 * Informational sub-check `gate/<id>`. Observe and degraded gates never fail
 * their check: a degraded gate's findings reach the verdict through the
 * simplification review instead.
 */
export function toCheckRun(result: GateResult): CheckRunOutput {
  const observe = result.mode !== "enforce";
  const conclusion: CheckConclusion = observe ? "success" : conclusionFor(result.state);
  const inconclusiveReasons = [...new Set(result.inconclusive.map((i) => i.reason))];
  const title = titleFor(result.state, result.summary, inconclusiveReasons);
  return {
    name: `gate/${result.gate}`,
    conclusion,
    title: clip(observe ? `[${result.mode}] ${title}` : title, MAX_TITLE),
    summary: clip(renderGateSection(result), MAX_BODY),
  };
}

export function verdictToCheckRun(verdict: QualityGateVerdict, results: GateResult[]): CheckRunOutput {
  // FAIL dominates INCONCLUSIVE, so an INCONCLUSIVE verdict's reasons are all measurement reasons.
  return {
    name: QUALITY_GATE_CHECK,
    conclusion: verdict.mergeAllowed ? "success" : "failure",
    title: clip([titleFor(verdict.state, verdict.summary, verdict.reasons), shadowNote(verdict)].filter(Boolean).join(" · "), MAX_TITLE),
    summary: clip(renderSummaryMarkdown(results, verdict), MAX_BODY),
  };
}
