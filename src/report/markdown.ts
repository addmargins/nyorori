// Human summary (gate-summary.md). Failure causes come first; nothing that
// improved elsewhere is allowed to hide a violation (spec 9.2).

import type { GateResult, Inconclusive, TriggerHit, Violation } from "../types.js";
import type { QualityGateVerdict } from "../aggregate/types.js";

const METRIC_LABEL: Record<string, string> = { cognitive: "CogC", cyclomatic: "CC" };

/** "src/a.ts::Parser>run#method[0]" → "run"; "src/a.ts::<module>" → "<module>". */
export function unitDisplayName(unitKey: string): string {
  const afterPath = unitKey.includes("::") ? unitKey.slice(unitKey.indexOf("::") + 2) : unitKey;
  const chain = afterPath.replace(/#[^#]*$/, "");
  const parts = chain.split(">");
  return parts[parts.length - 1] || chain;
}

function escapeMd(s: string): string {
  return s.replace(/([|`*_<>])/g, "\\$1");
}

function location(v: { file?: string; line?: number }): string {
  if (!v.file) return "";
  return v.line ? `${v.file}:${v.line}` : v.file;
}

export function violationLine(v: Violation): string {
  const loc = location(v);
  const metric = v.metric ? (METRIC_LABEL[v.metric] ?? v.metric) : undefined;
  let head: string;
  if (v.unit && metric && typeof v.after === "number" && typeof v.limit === "number") {
    const before = typeof v.before === "number" ? ` (기준 ${v.before})` : "";
    head = `${escapeMd(unitDisplayName(v.unit))}: ${metric} ${v.after}, 한도 ${v.limit} 초과${before}`;
  } else {
    head = escapeMd(v.message);
  }
  const waived = v.waivedBy ? ` — waiver ${escapeMd(v.waivedBy)}` : "";
  return `- **${v.reason}** ${head}${loc ? ` — \`${loc}\`` : ""}${waived}`;
}

function inconclusiveLine(i: Inconclusive): string {
  const who = i.authorFixable ? "작성자 수정 필요 (author-fixable)" : "게이트 담당자 조치 필요 (gate owner)";
  return `- **${i.reason}** ${escapeMd(i.detail)}${i.file ? ` — \`${i.file}\`` : ""} — ${who}`;
}

function triggerLine(t: TriggerHit): string {
  const where = t.unit ? `\`${t.unit}\`` : t.file ? `\`${t.file}\`` : "";
  const routing = t.routing ? "" : " _(관측 only)_";
  return `- **${t.id}** ${where} ${escapeMd(t.evidence)}${routing}`;
}

interface LegacyDebtEntry {
  unit: string;
  before?: number;
  after?: number;
}

function legacyDebt(result: GateResult): LegacyDebtEntry[] {
  const raw = result.observe["legacy_debt"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is LegacyDebtEntry => !!e && typeof e === "object" && typeof (e as LegacyDebtEntry).unit === "string",
  );
}

export function renderGateSection(result: GateResult): string {
  const lines: string[] = [];
  const mode =
    result.mode === "observe"
      ? " _(observe — 집계 제외)_"
      : result.mode === "degraded"
        ? " _(degraded — 차단하지 않고 단순화 리뷰로 라우팅)_"
        : "";
  lines.push(`### gate/${result.gate}: ${result.state}${mode}`, "");
  const open = result.violations.filter((v) => !v.waivedBy);
  const waived = result.violations.filter((v) => v.waivedBy);
  if (open.length) lines.push("**위반 (violations)**", ...open.map(violationLine), "");
  if (result.inconclusive.length) {
    lines.push("**측정 불가 (inconclusive)**", ...result.inconclusive.map(inconclusiveLine), "");
  }
  if (waived.length) lines.push("**waiver로 수용된 위반**", ...waived.map(violationLine), "");
  const routing = result.triggers.filter((t) => t.routing);
  if (routing.length) lines.push("**단순화 리뷰 트리거**", ...routing.map(triggerLine), "");
  const debt = legacyDebt(result);
  if (debt.length) {
    lines.push(
      "**기존 부채 유지 (legacy debt — 건강한 코드가 아님)**",
      ...debt.map(
        (d) =>
          `- \`${d.unit}\` CogC ${d.before ?? "?"} → ${d.after ?? "?"} (한도 초과 상태로 유지됨, 줄일 대상)`,
      ),
      "",
    );
  }
  if (result.unmeasured.length) {
    lines.push(
      "**측정하지 않은 파일 (unmeasured)**",
      ...result.unmeasured.map((u) => `- \`${u.path}\` (${u.side}) ${u.reason}`),
      "",
    );
  }
  const observeTriggers = result.triggers.filter((t) => !t.routing);
  if (observeTriggers.length) lines.push("<details><summary>관측 신호</summary>", "", ...observeTriggers.map(triggerLine), "", "</details>", "");
  return lines.join("\n");
}

export function renderSummaryMarkdown(results: GateResult[], verdict?: QualityGateVerdict): string {
  const out: string[] = [];
  if (verdict) {
    out.push(`## quality-gate: ${verdict.state} — ${verdict.mergeAllowed ? "병합 허용" : "병합 차단"}`, "");
    out.push(`base \`${verdict.base_sha}\` · candidate \`${verdict.candidate_sha}\` · policy \`${verdict.policy_revision}\``, "");
    if (verdict.blocking.length) out.push("**차단 원인**", ...verdict.blocking.map(violationLine), "");
    if (verdict.inconclusive.length) out.push("**측정 불가**", ...verdict.inconclusive.map(inconclusiveLine), "");
    out.push("| gate | mode | state | 집계 |", "|---|---|---|---|");
    for (const g of verdict.gates) {
      out.push(`| ${g.gate} | ${g.mode} | ${g.state} | ${g.counted ? "yes" : "no"} |`);
    }
    out.push("");
  }
  // Failing gates first so the cause is the first thing a reader sees.
  const order = ["FAIL", "INCONCLUSIVE", "ACCEPTED_WITH_WAIVER", "PASS", "NOT_APPLICABLE"];
  const sorted = [...results].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  for (const r of sorted) out.push(renderGateSection(r));
  out.push("_수치는 변경 파일에서만 계산했으며 저장소 전체 통계가 아닙니다._");
  return out.join("\n");
}

/**
 * Copyable approval commands for pending waivers, pinned to the blob the
 * approver is looking at. They sit inside a code fence, which the command
 * parser ignores, so the gate's own comment never approves anything.
 */
export function renderWaiverApprovalHints(pending: ReadonlyArray<{ id: string; unit: string; blob: string }>): string {
  if (pending.length === 0) return "";
  return [
    "**승인 대기 중인 waiver** — 승인자는 아래 명령을 복사해 새 댓글로 남긴다.",
    "",
    "```",
    ...pending.map((p) => `/gate-waive-approve ${p.id} blob=${p.blob}   # ${p.unit}`),
    "```",
    "",
  ].join("\n");
}
