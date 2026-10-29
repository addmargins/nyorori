// Human summary (gate-summary.md). Failure causes come first; nothing that
// improved elsewhere is allowed to hide a violation (spec 9.2).

import type { GateResult, Inconclusive, TriggerHit, Violation } from "../types.js";
import { shadowNote } from "../aggregate/index.js";
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
    if (verdict.shadow.promoted.length) {
      const note = shadowNote(verdict);
      out.push(
        `**Shadow 판정** (모든 게이트를 enforce로 본 가상 판정): ${verdict.shadow.state}${note ? ` — ${note}` : ""}`,
        ...verdict.shadow.promoted.map((p) => `- ${p.gate} (${p.mode}) → ${p.state}`),
        ...(verdict.shadow.blocking.length ? ["", "shadow 차단 사유:", ...verdict.shadow.blocking.map((b) => `- ${b.gate} ${b.reason}${b.unit ? ` \`${b.unit}\`` : ""}`)] : []),
        "",
      );
    }
    if (verdict.blocking.length) out.push("**차단 원인**", ...verdict.blocking.map(violationLine), "");
    if (verdict.inconclusive.length) out.push("**측정 불가**", ...verdict.inconclusive.map(inconclusiveLine), "");
    out.push(...commandNotes(verdict));
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

interface IgnoredCommand {
  id: string;
  author: string;
}

/**
 * What the PR conversation needs to act on: edited command comments that were
 * ignored, and ready-to-paste commands pinned to the current head.
 */
function commandNotes(verdict: QualityGateVerdict): string[] {
  const out: string[] = [];
  const obs = verdict.review.observe;
  const ignored = Array.isArray(obs["ignored_edited_commands"]) ? (obs["ignored_edited_commands"] as IgnoredCommand[]) : [];
  if (ignored.length) {
    out.push(
      "**무시된 명령** — edited command ignored; post a new comment (수정된 댓글의 명령은 효력이 없다)",
      ...ignored.map((i) => `- comment ${escapeMd(i.id)} by ${escapeMd(i.author)}`),
      "",
    );
  }
  const head = typeof obs["head_sha"] === "string" ? (obs["head_sha"] as string) : "";
  const fired = Array.isArray(obs["fired_triggers"]) ? (obs["fired_triggers"] as string[]) : [];
  if (head && verdict.review.violations.some((v) => v.reason === "REVIEW_REQUIRED")) out.push(renderReviewTemplate(head, fired));
  const tests = verdict.blocking.filter((v) => v.reason === "TEST_REMOVED" || v.reason === "TEST_CONFIG_WEAKENED");
  if (head && tests.length) out.push(renderTestApprovalHints(tests, head));
  return out;
}

/** Ready-to-paste `/simplification-review` for reviewers, bound to the head they are looking at. */
export function renderReviewTemplate(headSha: string, firedTriggers: readonly string[]): string {
  return [
    "**단순화 리뷰 명령** — 리뷰어는 모든 문항과 트리거 처분을 채워 새 댓글로 남긴다.",
    "",
    "```",
    `/simplification-review NO_SIMPLIFICATION_NEEDED sha=${headSha}`,
    "q1: pass",
    "q2: pass",
    "q3: pass",
    "q4: pass",
    "q5: pass",
    ...firedTriggers.map((id) => `${id}: <one-line disposition>`),
    "```",
    "",
  ].join("\n");
}

/** Copyable gate-owner approvals for TEST_REMOVED / TEST_CONFIG_WEAKENED, bound to the head. */
export function renderTestApprovalHints(violations: readonly Violation[], headSha: string): string {
  return [
    "**테스트 승인 명령** (gate owners)",
    "",
    "```",
    ...violations.map((v) => `/gate-approve-tests key="${v.reason}:${v.unit ?? v.file}" sha=${headSha} note="<why>"`),
    "```",
    "",
  ].join("\n");
}
