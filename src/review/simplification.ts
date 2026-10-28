// G6 simplification review (spec 7.6). Any routing trigger makes a human
// review mandatory; the approval is bound to the head SHA it was given on and
// survives a push only when the push provably did not touch what was reviewed.

import type { Policy } from "../policy/schema.js";
import type { GateMode, GateResult, MeasurementFingerprint, TriggerHit, Violation } from "../types.js";
import { NON_ROUTING_TRIGGERS } from "../types.js";
import { finalizeGateResult } from "../report/result.js";
import { CommandError, findCommands } from "../waivers/command.js";
import type { IssueComment } from "../waivers/index.js";
import { independenceProblem, inRoster, type PrIdentityContext, type TeamRosters } from "./independence.js";

export type ReviewVerdict = "NO_SIMPLIFICATION_NEEDED" | "SUGGESTED" | "REQUIRED";

export interface RubricAnswer {
  question: 1 | 2 | 3 | 4 | 5;
  pass: boolean;
  /** file:line references; mandatory for a failed item. */
  evidence: string[];
  note: string;
}

export interface ParsedReview {
  verdict: ReviewVerdict;
  answers: RubricAnswer[];
}

/** A review comment plus the PR head SHA it was posted against (recorded by the service). */
export interface ReviewComment extends IssueComment {
  headSha: string;
}

export const RUBRIC_QUESTIONS = [
  "같은 동작을 훨씬 적은 개념이나 행으로 쓸 수 없다 (pass = 더 단순한 모양이 없다).",
  "새 helper·모듈·매개변수·옵션 객체·제네릭은 두 곳 이상에서 쓰이거나 이름 붙일 수 있는 도메인 개념이다.",
  "추측성 일반화, 죽은 코드, 중복 로직, 불가능한 일에 대한 방어 코드가 없다.",
  "중첩된 제어 흐름을 early return, 데이터 표, 조건 병합으로 더 평평하게 만들 여지가 없다.",
  "독자가 다른 새 정의를 두 번 넘게 따라가지 않고 각 변경 함수를 이해할 수 있다.",
] as const;

const EVIDENCE = /^[^\s:]+:\d+$/;

/**
 * Format (each rubric item is pass/fail so polarity never depends on how the
 * question is phrased):
 *
 *   /simplification-review REQUIRED
 *   q1: pass
 *   q2: fail src/billing/plan.ts:42 processPart2 is a single-use helper dragging 5 locals
 *   q3: pass
 *   q4: pass
 *   q5: pass
 */
export function parseReview(body: string): ParsedReview | { problem: string } | null {
  let cmds;
  try {
    cmds = findCommands(body, "simplification-review");
  } catch (e) {
    return { problem: (e as Error).message };
  }
  if (cmds.length === 0) return null;
  if (cmds.length > 1) return { problem: "more than one /simplification-review in a comment" };
  const cmd = cmds[0]!;
  try {
    const verdict = cmd.positional[0] as ReviewVerdict | undefined;
    if (verdict !== "NO_SIMPLIFICATION_NEEDED" && verdict !== "SUGGESTED" && verdict !== "REQUIRED") {
      throw new CommandError("verdict must be NO_SIMPLIFICATION_NEEDED, SUGGESTED or REQUIRED");
    }
    const answers = new Map<number, RubricAnswer>();
    for (const raw of cmd.bodyLines) {
      const m = /^\s*q([1-5])\s*[:=]\s*(pass|fail)\b(.*)$/i.exec(raw);
      if (!m) continue;
      const q = Number(m[1]) as RubricAnswer["question"];
      if (answers.has(q)) throw new CommandError(`q${q} answered twice`);
      const rest = m[3]!.trim();
      const words = rest.split(/\s+/).filter(Boolean);
      const evidence = words.filter((w) => EVIDENCE.test(w));
      const note = words.filter((w) => !EVIDENCE.test(w)).join(" ");
      const pass = m[2]!.toLowerCase() === "pass";
      if (!pass && evidence.length === 0) throw new CommandError(`q${q} fails without file:line evidence`);
      answers.set(q, { question: q, pass, evidence, note });
    }
    for (let q = 1; q <= 5; q++) if (!answers.has(q)) throw new CommandError(`q${q} is not answered`);
    const list = [...answers.values()].sort((a, b) => a.question - b.question);
    const coreFails = list.filter((a) => a.question <= 4 && !a.pass);
    if (verdict === "REQUIRED" && coreFails.length === 0) {
      throw new CommandError("REQUIRED needs at least one failed item among q1-q4");
    }
    if (verdict === "NO_SIMPLIFICATION_NEEDED" && coreFails.length > 0) {
      throw new CommandError("NO_SIMPLIFICATION_NEEDED contradicts a failed item among q1-q4");
    }
    return { verdict, answers: list };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}

export interface CarryOverInfo {
  /** patch-id of (approved SHA vs its base) equals that of (head vs base): a pure rebase. */
  patchIdEqual: boolean;
  /** Files touched by commits between the approved SHA and the current head. */
  filesChangedSince: string[];
}

export interface LlmReview {
  verdict: ReviewVerdict;
  model: string;
  answers?: RubricAnswer[];
}

export interface SimplificationReviewInput {
  policy: Policy;
  mode: GateMode;
  base: string;
  candidate: string;
  /** PR head the approval must be bound to (merge_group: the PR head under test). */
  headSha: string;
  fingerprint: MeasurementFingerprint;
  triggers: readonly TriggerHit[];
  comments: readonly ReviewComment[];
  identity: PrIdentityContext;
  teams?: TeamRosters;
  /** Keyed by the SHA a review was given on; absent means no carry-over evidence. */
  carryOver?: Readonly<Record<string, CarryOverInfo>>;
  /** Approvers of applied waivers, by unit key; a simplification reviewer among them clears that S6. */
  waiverApprovers?: ReadonlyArray<{ unit: string; approver: string }>;
  llm?: LlmReview;
}

interface AcceptedReview {
  reviewer: string;
  verdict: ReviewVerdict;
  sha: string;
  commentId: string;
}

export function routingTriggers(triggers: readonly TriggerHit[]): TriggerHit[] {
  return triggers.filter((t) => t.routing && !NON_ROUTING_TRIGGERS.has(t.id));
}

function appliesToHead(sha: string, input: SimplificationReviewInput, triggeredFiles: Set<string> | null): boolean {
  if (sha === input.headSha) return true;
  const info = input.carryOver?.[sha];
  if (!info) return false;
  if (info.patchIdEqual) return true;
  // A trigger without a file could be anywhere, so only a pure rebase carries it.
  if (triggeredFiles === null) return false;
  return info.filesChangedSince.every((f) => !triggeredFiles.has(f));
}

export function evaluateSimplificationReview(input: SimplificationReviewInput): GateResult {
  const { policy } = input;
  let routing = routingTriggers(input.triggers);

  // S6 from a waiver is satisfied when the waiver's approver is also a simplification reviewer.
  const clearedS6 = new Set(
    (input.waiverApprovers ?? [])
      .filter((w) => inRoster(w.approver, policy.review.simplification_reviewers, input.teams))
      .map((w) => w.unit),
  );
  routing = routing.filter((t) => !(t.id === "S6" && t.unit && clearedS6.has(t.unit)));

  const problems: Array<{ commentId: string; problem: string }> = [];
  const latestByReviewer = new Map<string, AcceptedReview>();
  const triggeredFiles = routing.every((t) => t.file) ? new Set(routing.map((t) => t.file!)) : null;
  const ordered = [...input.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of ordered) {
    const parsed = parseReview(c.body);
    if (parsed === null) continue;
    const commentId = String(c.id);
    if ("problem" in parsed) {
      problems.push({ commentId, problem: parsed.problem });
      continue;
    }
    if (!inRoster(c.author.login, policy.review.simplification_reviewers, input.teams)) {
      problems.push({ commentId, problem: `${c.author.login} is not a simplification reviewer` });
      continue;
    }
    const indep = independenceProblem(c.author, input.identity, policy);
    if (indep) {
      problems.push({ commentId, problem: indep });
      continue;
    }
    latestByReviewer.set(c.author.login.toLowerCase(), {
      reviewer: c.author.login,
      verdict: parsed.verdict,
      sha: c.headSha,
      commentId,
    });
  }

  const current = [...latestByReviewer.values()].filter((r) => appliesToHead(r.sha, input, triggeredFiles));
  const stale = [...latestByReviewer.values()].filter((r) => !current.includes(r));

  const violations: Violation[] = [];
  const requiredBy = current.filter((r) => r.verdict === "REQUIRED");
  const approvedBy = current.filter((r) => r.verdict !== "REQUIRED");
  const ids = [...new Set(routing.map((t) => t.id))].join(", ");
  if (routing.length > 0) {
    if (requiredBy.length > 0) {
      violations.push({
        gate: "simplification-review",
        reason: "REVIEW_CHANGES_REQUESTED",
        file: "",
        message: `simplification requested by ${requiredBy.map((r) => r.reviewer).join(", ")}`,
        details: { reviews: requiredBy },
      });
    } else if (approvedBy.length === 0) {
      violations.push({
        gate: "simplification-review",
        reason: "REVIEW_REQUIRED",
        file: "",
        message: `simplification review required: ${ids}`,
        details: { stale_reviews: stale.map((r) => ({ reviewer: r.reviewer, sha: r.sha })) },
      });
    }
  }

  return finalizeGateResult({
    gate: "simplification-review",
    mode: input.mode,
    base: input.base,
    candidate: input.candidate,
    policyRevision: policy.revision,
    fingerprint: input.fingerprint,
    violations,
    triggers: routing,
    applicable: routing.length > 0,
    observe: {
      approvals: approvedBy.map((r) => ({ reviewer: r.reviewer, verdict: r.verdict, sha: r.sha })),
      stale_reviews: stale.map((r) => ({ reviewer: r.reviewer, sha: r.sha })),
      rejected_reviews: problems,
      llm: input.llm ?? null,
    },
  });
}
