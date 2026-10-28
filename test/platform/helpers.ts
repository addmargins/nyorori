import { defaultPolicy, type PolicyInput } from "../../src/policy/schema.js";
import { finalizeGateResult, type GateResultInput } from "../../src/report/result.js";
import type { GateResult, Violation } from "../../src/types.js";
import type { PrIdentityContext } from "../../src/review/independence.js";

export const B = "b".repeat(40);
export const C = "c".repeat(40);
export const HEAD = "d".repeat(40);
export const BLOB = "1".repeat(40);
export const BLOB2 = "2".repeat(40);
export const REV = "rev-1";
export const RUNNER = "runner-1";

export function policy(overrides: Partial<PolicyInput> = {}) {
  return {
    ...defaultPolicy({
      review: {
        simplification_reviewers: ["rev-alice", "rev-bob", "@org/simplifiers"],
        waiver_approvers: ["appr-carol", "rev-alice", "@org/approvers"],
        gate_owners: ["owner-dave"],
        bots: ["helper-bot"],
      },
      ai_loop: { bot_accounts: ["ai-agent[bot]", "ai-agent"] },
      ...overrides,
    }),
    revision: REV,
  };
}

export const identity: PrIdentityContext = {
  prAuthor: "author-erin",
  agentInvokers: ["invoker-frank"],
  commits: [
    {
      sha: "e".repeat(40),
      authorLogin: "ai-agent[bot]",
      authorEmail: "agent@example.com",
      committerLogin: "web-flow",
      committerEmail: "noreply@github.com",
      message: "fix\n\nCo-authored-by: Grace <grace@example.com>\nCo-authored-by: Heidi <123+heidi@users.noreply.github.com>",
    },
    { sha: "f".repeat(40), authorLogin: "committer-ivan", committerLogin: "committer-ivan" },
    // Grace's trailer email is linked through her own commit, so no identity is unresolved.
    { sha: "a".repeat(40), authorLogin: "grace", authorEmail: "grace@example.com", committerLogin: "grace", committerEmail: "grace@example.com" },
  ],
};

export function violation(over: Partial<Violation> = {}): Violation {
  return {
    gate: "complexity",
    reason: "OVER_LIMIT_NEW",
    file: "src/billing/plan.ts",
    unit: "src/billing/plan.ts::applyDiscount#function[0]",
    line: 42,
    metric: "cognitive",
    before: null,
    after: 21,
    limit: 15,
    message: "applyDiscount: CogC 21 > 15",
    ...over,
  };
}

export function result(over: Partial<GateResultInput> = {}): GateResult {
  return finalizeGateResult({
    gate: "complexity",
    mode: "enforce",
    base: B,
    candidate: C,
    policyRevision: REV,
    fingerprint: { runner_commit: RUNNER, policy_revision: REV, cccc_version: "cccc 1.8.5", cccc_sha256: "a".repeat(64) },
    applicable: true,
    ...over,
  });
}

export function comment(id: number, login: string, body: string, createdAt = `2026-10-28T10:${String(id).padStart(2, "0")}:00Z`) {
  return { id, author: { login }, body, createdAt };
}

/** Adds the mandatory `sha=` to a /simplification-review command (round-3 item 8). */
export function withSha(body: string, sha: string): string {
  return body.replace(/^(\/simplification-review \S+)/m, `$1 sha=${sha}`);
}
