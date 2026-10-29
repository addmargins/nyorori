// gate-feedback.json for the AI fix loop (spec 12.1). Hints are limited to
// what the measurer actually reports; cccc gives no per-construct breakdown,
// so the feedback never pretends to attribute points to specific lines.

import { FORBIDDEN_CHANGES, STOP_IF } from "../ailoop/index.js";
import type { QualityGateVerdict } from "../aggregate/types.js";
import type { GateResult, GateState, TriggerHit, Violation } from "../types.js";

export const AI_LOOP_INSTRUCTIONS = [
  "지정된 단위의 복잡도를 줄이되 early return, 이름 있는 조건 함수, 데이터 표를 우선하라.",
  "helper는 이름 붙일 수 있는 개념이고 매개변수가 4개 이하일 때만 추출하라.",
  "테스트와 설정을 바꾸지 마라.",
  "다음은 단순화 리뷰에서 실패로 간주된다: 클로저 표, 논리 할당을 이용한 제어 흐름, 불리언 인덱싱, 범용 조합자, 즉시 실행 함수, 필드 초기화식 로직, context 객체를 통한 helper 연쇄, 문자열로 만든 함수.",
  "기능 삭제나 정책 완화를 해법으로 쓰지 마라. 원래 요구사항과 동작 검증을 유지한 채 고쳐라.",
].join("\n");

export const FORBIDDEN_PATTERNS = [
  "closure-table",
  "logical-assignment-control-flow",
  "boolean-indexing",
  "generic-combinators",
  "iife",
  "field-initializer-logic",
  "context-object-helper-chain",
  "string-built-function",
] as const;

/** Generic hints keyed by reason, derived from the cccc calculation rules (spec 3.3). */
const HINTS: Partial<Record<string, string>> = {
  OVER_LIMIT_NEW:
    "CogC는 if/삼항/반복/catch마다 1+중첩 깊이, else/else if마다 1, 연속된 같은 논리 연산자 구간마다 1을 더한다. 중첩을 early return으로 평평하게 하라.",
  OVER_LIMIT: "예산 안의 증가만 허용된다. 새 분기를 이름 있는 조건 함수나 데이터 표로 옮겨라.",
  LEGACY_WORSENED: "기준 점수를 넘는 기존 부채 단위는 +1도 허용되지 않는다. 변경을 늘리지 말고 같은 단위를 줄여라.",
  UNMATCHED_OVER_BUDGET:
    "이 단위는 기존 단위와 확실히 대응되지 않아 신규 한도가 적용됐다. 한도 이하로 줄이거나, 선언 행을 바꾸지 않는 편집으로 대응을 유지하라.",
};

export interface FeedbackItem {
  unit?: string;
  location?: string;
  reason: string;
  metric?: string;
  value?: number | null;
  limit?: number | null;
  baseline?: number | null;
  hint?: string;
}

export interface GateFeedback {
  schema_version: 1;
  base_sha: string;
  candidate_sha: string;
  /** Verdict state of this attempt, when the caller supplies the verdict. */
  state?: GateState;
  attempt: number;
  max_retries?: number;
  /** Conditions under which the loop must stop and hand off (spec 12.3). */
  stop_if: ReadonlyArray<{ id: string; description: string }>;
  /** Changes the loop may never make (spec 12.2), machine-readable. */
  forbidden_changes: ReadonlyArray<{ id: string; description: string }>;
  /** The shadow verdict and whether it would block (spec 13.1). */
  would_block?: boolean;
  shadow?: QualityGateVerdict["shadow"];
  instructions: string;
  forbidden_patterns: readonly string[];
  violations: FeedbackItem[];
  triggers: Array<Pick<TriggerHit, "id" | "file" | "unit" | "evidence">>;
  /** Behaviour that must be preserved: the caller fills the commands/tests the loop must keep green. */
  preserve: string[];
}

function item(v: Violation): FeedbackItem {
  return {
    unit: v.unit,
    location: v.file ? (v.line ? `${v.file}:${v.line}` : v.file) : undefined,
    reason: v.reason,
    metric: v.metric,
    value: v.after ?? null,
    limit: v.limit ?? null,
    baseline: v.before ?? null,
    hint: HINTS[v.reason],
  };
}

export function buildGateFeedback(
  results: GateResult[],
  opts: { attempt: number; preserve: string[]; maxRetries?: number; verdict?: QualityGateVerdict },
): GateFeedback {
  const first = results[0];
  const v = opts.verdict;
  return {
    schema_version: 1,
    base_sha: first?.base_sha ?? v?.base_sha ?? "",
    candidate_sha: first?.candidate_sha ?? v?.candidate_sha ?? "",
    ...(v ? { state: v.state, would_block: v.would_block, shadow: v.shadow } : {}),
    attempt: opts.attempt,
    ...(opts.maxRetries !== undefined ? { max_retries: opts.maxRetries } : {}),
    stop_if: STOP_IF,
    forbidden_changes: FORBIDDEN_CHANGES,
    instructions: AI_LOOP_INSTRUCTIONS,
    forbidden_patterns: FORBIDDEN_PATTERNS,
    violations: results.flatMap((r) => r.violations.filter((v) => !v.waivedBy).map(item)),
    triggers: results.flatMap((r) =>
      r.triggers.filter((t) => t.routing).map(({ id, file, unit, evidence }) => ({ id, file, unit, evidence })),
    ),
    preserve: opts.preserve,
  };
}
