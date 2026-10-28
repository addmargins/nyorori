// Gate-owner approval for G4 integrity findings that waivers may not touch
// (spec 8.3: "C에서 사라진 테스트는 gate-owners 승인이 필요하다(waiver 대상 아님)").
// An approval accepts one violation at one head SHA. It is recorded as an
// approval, not a waiver, and does not use the waiver budget.

import { createHash } from "node:crypto";
import type { Policy } from "../policy/schema.js";
import type { ReasonCode, Violation, WaiverApplied } from "../types.js";
import { independenceProblem, inRoster, type PrIdentityContext, type TeamRosters } from "../review/independence.js";
import type { ReviewComment } from "../review/simplification.js";
import { findCommands, requireArgs } from "./command.js";

export const TEST_APPROVABLE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["TEST_REMOVED", "TEST_CONFIG_WEAKENED"]);

/** Recorded in `waivers_applied` with this metric so the aggregator can tell approvals from waivers. */
export const TEST_APPROVAL_METRIC = "test-approval";

/** Stable key the gate prints next to each approvable violation. */
export function testApprovalKey(v: Pick<Violation, "reason" | "unit" | "file">): string {
  return `${v.reason}:${v.unit ?? v.file}`;
}

export function testApprovalId(commentId: string, key: string): string {
  return `TA${createHash("sha256").update(`${commentId}|${key}`).digest("hex").slice(0, 10)}`;
}

export interface TestApprovalContext {
  policy: Policy;
  identity: PrIdentityContext;
  teams?: TeamRosters;
  /** Current PR head; an approval binds to the head its comment was posted against. */
  headSha: string;
}

export interface TestApprovalOutcome {
  violations: Violation[];
  applied: WaiverApplied[];
  rejected: Array<{ commentId: string; problem: string }>;
}

/**
 * Format: /gate-approve-tests key="TEST_REMOVED:src/a.test.ts > adds numbers" note="moved to b.test.ts"
 */
export function applyTestApprovals(
  violations: readonly Violation[],
  comments: readonly ReviewComment[],
  ctx: TestApprovalContext,
): TestApprovalOutcome {
  const out = violations.map((v) => ({ ...v }));
  const applied: WaiverApplied[] = [];
  const rejected: TestApprovalOutcome["rejected"] = [];
  const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of ordered) {
    const commentId = String(c.id);
    let cmds;
    try {
      cmds = findCommands(c.body, "gate-approve-tests");
      for (const cmd of cmds) requireArgs(cmd, ["key", "note"]);
    } catch (e) {
      rejected.push({ commentId, problem: (e as Error).message });
      continue;
    }
    for (const cmd of cmds) {
      const key = cmd.args.key!;
      const reject = (problem: string) => rejected.push({ commentId, problem: `${key}: ${problem}` });
      if (!inRoster(c.author.login, ctx.policy.review.gate_owners, ctx.teams)) {
        reject(`${c.author.login} is not a gate owner`);
        continue;
      }
      const indep = independenceProblem(c.author, ctx.identity, ctx.policy);
      if (indep) {
        reject(indep);
        continue;
      }
      if (!c.headSha || c.headSha !== ctx.headSha) {
        reject("approval was given on another head; approve again on the current head");
        continue;
      }
      const targets = out.filter((v) => !v.waivedBy && testApprovalKey(v) === key);
      if (targets.length === 0) {
        reject("no open violation with this key");
        continue;
      }
      if (targets.some((v) => !TEST_APPROVABLE_REASONS.has(v.reason))) {
        reject("only TEST_REMOVED and TEST_CONFIG_WEAKENED can be approved");
        continue;
      }
      const id = testApprovalId(commentId, key);
      for (const v of targets) v.waivedBy = id;
      applied.push({ id, unit: key, metric: TEST_APPROVAL_METRIC, ceiling: 0, approver: c.author.login });
    }
  }
  return { violations: out, applied, rejected };
}
