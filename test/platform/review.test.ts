import { describe, expect, it } from "vitest";
import { evaluateSimplificationReview, parseReview, type ReviewComment, type SimplificationReviewInput } from "../../src/review/simplification.js";
import type { TriggerHit } from "../../src/types.js";
import { B, C, HEAD, identity, policy } from "./helpers.js";

const S1: TriggerHit = { id: "S1", gate: "complexity", file: "src/plan.ts", evidence: "V 16→16, units 1→12", routing: true };
const S4: TriggerHit = { id: "S4", gate: "lint-structure", file: "src/long.ts", evidence: "72 lines", routing: true };
const S8: TriggerHit = { id: "S8", gate: "complexity", file: "src/a.ts", evidence: "CogC 13", routing: false };

const RUBRIC_OK = "q1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: pass";
const APPROVE = `/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC_OK}\nS1: helpers are named pricing rules\nS4: exhaustive state table\nS3: modules are separate bounded contexts\nS6: accepted in review`;
const REQUIRE = "/simplification-review REQUIRED\nq1: pass\nq2: fail src/plan.ts:40 processPart2 is a single-use helper\nq3: pass\nq4: pass\nq5: fail src/plan.ts:10 five hops";

function rc(id: number, login: string, body: string, headSha = HEAD): ReviewComment {
  return { id, author: { login }, body, createdAt: `2026-10-28T12:${String(id).padStart(2, "0")}:00Z`, headSha };
}

function input(over: Partial<SimplificationReviewInput> = {}): SimplificationReviewInput {
  return {
    policy: policy(),
    mode: "enforce",
    base: B,
    candidate: C,
    headSha: HEAD,
    fingerprint: { runner_commit: "r", policy_revision: "rev-1" },
    triggers: [S1, S4],
    comments: [],
    identity,
    ...over,
  };
}

describe("rubric parsing", () => {
  it("parses a complete rubric", () => {
    const r = parseReview(REQUIRE);
    expect(r && !("problem" in r) && r.answers[1]).toMatchObject({ pass: false, evidence: ["src/plan.ts:40"] });
  });

  it.each([
    ["missing item", "/simplification-review NO_SIMPLIFICATION_NEEDED\nq1: pass"],
    ["fail without evidence", "/simplification-review REQUIRED\nq1: fail nope\nq2: pass\nq3: pass\nq4: pass\nq5: pass"],
    ["REQUIRED without a core failure", "/simplification-review REQUIRED\nq1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: fail a.ts:1"],
    ["approval contradicting a failure", "/simplification-review NO_SIMPLIFICATION_NEEDED\nq1: fail a.ts:1\nq2: pass\nq3: pass\nq4: pass\nq5: pass"],
    ["bad verdict", "/simplification-review LGTM\nq1: pass"],
  ])("rejects %s", (_l, body) => {
    expect(parseReview(body)).toHaveProperty("problem");
  });

  it("returns null when there is no command", () => {
    expect(parseReview("looks fine")).toBeNull();
  });
});

describe("G6 simplification review", () => {
  it("is N/A without routing triggers; S8 never routes", () => {
    expect(evaluateSimplificationReview(input({ triggers: [] })).state).toBe("NOT_APPLICABLE");
    expect(evaluateSimplificationReview(input({ triggers: [S8] })).state).toBe("NOT_APPLICABLE");
  });

  it("fails with the trigger list until a reviewer approves", () => {
    const r = evaluateSimplificationReview(input());
    expect(r.state).toBe("FAIL");
    expect(r.violations[0]!.message).toBe("simplification review required: S1, S4");
  });

  it("passes with an independent reviewer's rubric approval on the head SHA", () => {
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE)] })).state).toBe("PASS");
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE.replace("NO_SIMPLIFICATION_NEEDED", "SUGGESTED"))] })).state).toBe("PASS");
  });

  it("ignores approvals from non-reviewers, the author, commit participants, invokers and bots", () => {
    const p = policy({ review: { simplification_reviewers: ["author-erin", "committer-ivan", "invoker-frank", "ai-agent[bot]", "heidi"] } });
    for (const login of ["outsider", "author-erin", "committer-ivan", "invoker-frank", "ai-agent[bot]", "heidi"]) {
      const r = evaluateSimplificationReview(input({ policy: p, comments: [rc(1, login, APPROVE)] }));
      expect(r.state, login).toBe("FAIL");
    }
  });

  it("a human REQUIRED blocks even when another reviewer approved", () => {
    const r = evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE), rc(2, "rev-bob", REQUIRE)] }));
    expect(r.reasons).toEqual(["REVIEW_CHANGES_REQUESTED"]);
  });

  it("a reviewer's later comment supersedes their earlier one", () => {
    const r = evaluateSimplificationReview(input({ comments: [rc(1, "rev-bob", REQUIRE), rc(2, "rev-bob", APPROVE)] }));
    expect(r.state).toBe("PASS");
  });

  it("is invalidated by a new push touching triggered files", () => {
    const old = "0".repeat(40);
    const r = evaluateSimplificationReview(
      input({ comments: [rc(1, "rev-alice", APPROVE, old)], carryOver: { [old]: { patchIdEqual: false, filesChangedSince: ["src/plan.ts"] } } }),
    );
    expect(r.state).toBe("FAIL");
    expect(r.violations[0]!.reason).toBe("REVIEW_REQUIRED");
  });

  it("carries over on a patch-id-equal rebase or a push that avoids triggered files", () => {
    const old = "0".repeat(40);
    const rebase = { [old]: { patchIdEqual: true, filesChangedSince: ["src/plan.ts"] } };
    const unrelated = { [old]: { patchIdEqual: false, filesChangedSince: ["README.md"] } };
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE, old)], carryOver: rebase })).state).toBe("PASS");
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE, old)], carryOver: unrelated })).state).toBe("PASS");
    // No carry-over evidence: an old approval never applies.
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE, old)] })).state).toBe("FAIL");
  });

  it("a file-less trigger only carries over on a pure rebase", () => {
    const old = "0".repeat(40);
    const fileless: TriggerHit = { id: "S3", gate: "deps", evidence: "2 single-importer modules", routing: true };
    const r = evaluateSimplificationReview(
      input({ triggers: [fileless], comments: [rc(1, "rev-alice", APPROVE, old)], carryOver: { [old]: { patchIdEqual: false, filesChangedSince: ["README.md"] } } }),
    );
    expect(r.state).toBe("FAIL");
  });

  it("an S6 from a waiver is cleared when the waiver approver is a simplification reviewer", () => {
    const s6: TriggerHit = { id: "S6", gate: "complexity", unit: "src/a.ts::f#function[0]", file: "src/a.ts", evidence: "waiver W1: cognitive ≤ 22, approved by x", routing: true };
    expect(evaluateSimplificationReview(input({ triggers: [s6], waiverApprovers: [{ unit: s6.unit!, approver: "rev-alice" }] })).state).toBe("NOT_APPLICABLE");
    expect(evaluateSimplificationReview(input({ triggers: [s6], waiverApprovers: [{ unit: s6.unit!, approver: "appr-carol" }] })).state).toBe("FAIL");
  });

  it("records the LLM reviewer as observe-only", () => {
    const r = evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", APPROVE)], llm: { verdict: "REQUIRED", model: "m" } }));
    expect(r.state).toBe("PASS");
    expect(r.observe.llm).toMatchObject({ verdict: "REQUIRED" });
  });

  it("D13: an approval must dispose of every fired trigger; REQUIRED needs none", () => {
    const partial = `/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC_OK}\nS1: fine`;
    const r = evaluateSimplificationReview(input({ comments: [rc(1, "rev-alice", partial)] }));
    expect(r.state).toBe("FAIL");
    expect(JSON.stringify(r.observe.rejected_reviews)).toContain("no disposition for S4");
    expect(evaluateSimplificationReview(input({ comments: [rc(1, "rev-bob", REQUIRE)] })).reasons).toEqual(["REVIEW_CHANGES_REQUESTED"]);
  });

  it("D13: empty or duplicate dispositions are rejected", () => {
    expect(parseReview(`/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC_OK}\nS1:   `)).toHaveProperty("problem");
    expect(parseReview(`/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC_OK}\nS1: a\nS1: b`)).toHaveProperty("problem");
  });

  it("D13: an approval on an old head does not cover a trigger that fired later", () => {
    const old = "0".repeat(40);
    const onlyS1 = `/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC_OK}\nS1: fine`;
    const carry = { [old]: { patchIdEqual: true, filesChangedSince: [] } };
    expect(evaluateSimplificationReview(input({ triggers: [S1], comments: [rc(1, "rev-alice", onlyS1, old)], carryOver: carry })).state).toBe("PASS");
    expect(evaluateSimplificationReview(input({ triggers: [S1, S4], comments: [rc(1, "rev-alice", onlyS1, old)], carryOver: carry })).state).toBe("FAIL");
  });

  it("an override S6 is never cleared by a waiver approver", () => {
    const s6: TriggerHit = { id: "S6", gate: "complexity", unit: "src/a.ts::f#function[0]", file: "src/a.ts", evidence: "measurement override of SCHEMA by o", routing: true };
    expect(evaluateSimplificationReview(input({ triggers: [s6], waiverApprovers: [{ unit: s6.unit!, approver: "rev-alice" }] })).state).toBe("FAIL");
  });
});
