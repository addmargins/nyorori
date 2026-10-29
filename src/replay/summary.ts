// replay-summary.md: what changed comes first, then what broke, then the
// friction metrics and the per-pair table.

import type { GateState } from "../types.js";
import { GATE_STATES } from "../types.js";
import type { PairDelta, TriggerRow, ViolationRow, Totals } from "./delta.js";
import type { PairReport, ReplayReport } from "./driver.js";

function escapeMd(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/([|`*_<>])/g, "\\$1");
}

function violationLine(v: ViolationRow): string {
  const where = v.unit ?? v.file;
  const value = v.after !== null && v.limit !== null ? ` ${v.after} > ${v.limit}` : "";
  const waived = v.waived_by ? ` — waiver ${escapeMd(v.waived_by)}` : "";
  return `\`${escapeMd(where)}\` **${v.reason}** (${v.gate})${value}${waived}`;
}

function triggerLine(t: TriggerRow): string {
  const where = t.unit ?? t.file ?? t.gate;
  return `\`${escapeMd(where)}\` **${t.id}** ${escapeMd(t.evidence)}${t.routing ? "" : " _(관측 only)_"}`;
}

function pct(r: number | null): string {
  return r === null ? "–" : `${(r * 100).toFixed(1)}%`;
}

function deltaSection(p: PairReport, d: PairDelta): string[] {
  const lines = [`### ${p.id} (\`${p.base.slice(0, 12)}\` → \`${p.candidate.slice(0, 12)}\`)`, ""];
  if (d.state) lines.push(`- 집계 (aggregate): **${d.state.before} → ${d.state.after}**`);
  if (d.merge_allowed) lines.push(`- 병합 허용 (mergeAllowed): ${d.merge_allowed.before} → ${d.merge_allowed.after}`);
  if (d.would_block) lines.push(`- shadow 차단 (would_block): ${d.would_block.before} → ${d.would_block.after}`);
  for (const g of d.gates) {
    const r = (x: typeof g.before) => `${x.state}/${x.mode}${x.reasons.length ? ` [${x.reasons.join(", ")}]` : ""}`;
    lines.push(`- gate/${g.gate}: ${r(g.before)} → ${r(g.after)}`);
  }
  for (const v of d.violations.added) lines.push(`- 위반 추가 (violation added): ${violationLine(v)}`);
  for (const v of d.violations.removed) lines.push(`- 위반 제거 (violation removed): ${violationLine(v)}`);
  for (const t of d.triggers.added) lines.push(`- 트리거 추가 (trigger added): ${triggerLine(t)}`);
  for (const t of d.triggers.removed) lines.push(`- 트리거 제거 (trigger removed): ${triggerLine(t)}`);
  lines.push("");
  return lines;
}

function totalsTable(current: Totals, comparison: Totals | null): string[] {
  const rows: Array<[string, (t: Totals) => string]> = [
    ["pairs run", (t) => String(t.runs)],
    ...GATE_STATES.map((s): [string, (t: Totals) => string] => [s, (t) => String(t.states[s])]),
    ["FAIL per PR (목표 ≤ 10%)", (t) => pct(t.fail_rate)],
    ["INCONCLUSIVE per PR (목표 < 1%)", (t) => pct(t.inconclusive_rate)],
    ["waived PRs (목표 ≤ 3%)", (t) => `${t.waived_pair_count} (${pct(t.waived_pair_rate)}), ${t.waiver_count} waiver(s)`],
    ["G6 review required", (t) => `${t.review_required_count} (${pct(t.review_required_rate)})`],
    ["service gate INCONCLUSIVE", (t) => String(t.service_inconclusive_count)],
    ["triggers by id", (t) => Object.entries(t.triggers_by_id).sort().map(([k, n]) => `${k}:${n}`).join(" ") || "–"],
  ];
  const head = comparison ? "| metric | current | comparison |" : "| metric | current |";
  const sep = comparison ? "|---|---|---|" : "|---|---|";
  return [head, sep, ...rows.map(([label, f]) => (comparison ? `| ${label} | ${f(current)} | ${f(comparison)} |` : `| ${label} | ${f(current)} |`))];
}

function gateStateTable(current: Totals, comparison: Totals | null): string[] {
  const states: GateState[] = [...GATE_STATES];
  const head = `| gate | ${states.join(" | ")} |`;
  const sep = `|---|${states.map(() => "---").join("|")}|`;
  const row = (t: Totals, gate: keyof Totals["gate_states"]) => states.map((s) => t.gate_states[gate][s]).join(" | ");
  const out = [head, sep];
  for (const gate of Object.keys(current.gate_states) as Array<keyof Totals["gate_states"]>) {
    out.push(`| ${gate} (current) | ${row(current, gate)} |`);
    if (comparison) out.push(`| ${gate} (comparison) | ${row(comparison, gate)} |`);
  }
  return out;
}

export function renderReplaySummary(r: ReplayReport): string {
  const out: string[] = [];
  const verdict = r.exit_code === 2 ? "ERROR" : r.exit_code === 1 ? "DELTAS" : "NO DELTAS";
  out.push(`# replay: ${verdict} — ${r.counts.pairs} pairs, ${r.counts.changed} changed, ${r.counts.errored} errored, ${r.counts.service_inconclusive} service-INCONCLUSIVE`, "");
  out.push(`dataset \`${r.dataset.path}\` (sha256 ${r.dataset.sha256.slice(0, 12)})${r.repository ? ` · repository \`${r.repository}\`` : ""} · jobs ${r.jobs}`);
  out.push(`- current: policy \`${r.sides.current.policy_revision}\` · cccc \`${r.sides.current.cccc_binary}\``);
  if (r.sides.comparison) out.push(`- comparison: policy \`${r.sides.comparison.policy_revision}\` · cccc \`${r.sides.comparison.cccc_binary}\``);
  else out.push("- comparison: none (single-sided recovery check)");
  out.push("");

  const changed = r.pairs.filter((p) => p.delta?.changed);
  out.push(`## 판정 차이 (deltas): ${changed.length}`, "");
  if (changed.length === 0) out.push(r.sides.comparison ? "변경된 판정이 없습니다 (no pair judged differently)." : "비교 대상이 없어 차이를 계산하지 않았습니다.", "");
  for (const p of changed) out.push(...deltaSection(p, p.delta!));

  const broken = r.pairs.filter((p) => p.errors.length > 0 || (p.current?.service_inconclusive.length ?? 0) > 0);
  if (broken.length) {
    out.push(`## 실행 오류·측정 불가 (errors, service-gate INCONCLUSIVE): ${broken.length}`, "");
    for (const p of broken) {
      for (const e of p.errors) out.push(`- ${p.id} [${e.side}]: ${escapeMd(e.message)}`);
      if (p.current?.service_inconclusive.length) out.push(`- ${p.id} [current]: INCONCLUSIVE in ${p.current.service_inconclusive.join(", ")} — see \`${p.current.out_dir}/gate-summary.md\``);
    }
    out.push("");
  }

  out.push("## 마찰 지표 (friction, spec 13.3)", "", ...totalsTable(r.totals.current, r.totals.comparison), "");
  out.push("## 게이트별 상태 분포 (gate states)", "", ...gateStateTable(r.totals.current, r.totals.comparison), "");

  out.push("## 전체 쌍 (all pairs)", "");
  out.push(r.sides.comparison ? "| pair | current | comparison | changed |" : "| pair | current |");
  out.push(r.sides.comparison ? "|---|---|---|---|" : "|---|---|");
  for (const p of r.pairs) {
    const c = p.current ? `${p.current.state}${p.current.review_required ? " +G6" : ""}` : "ERROR";
    if (!r.sides.comparison) out.push(`| ${p.id} | ${c} |`);
    else {
      const k = p.comparison ? `${p.comparison.state}${p.comparison.review_required ? " +G6" : ""}` : "ERROR";
      out.push(`| ${p.id} | ${c} | ${k} | ${p.delta ? (p.delta.changed ? "yes" : "no") : "–"} |`);
    }
  }
  out.push("", "_수치는 이 데이터셋의 쌍에서만 계산했으며 저장소 전체 통계가 아닙니다. Actions 산출물이 없는 쌍에서 enforce 모드의 G4·G5·G7은 INCONCLUSIVE입니다._");
  return out.join("\n");
}
