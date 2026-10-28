import { describe, expect, it } from "vitest";
import { applyWaivers, approveCommand, debtIssue, evaluateWaivers, ledgerLine, parseWaiverRequest, waiverTriggers, type IssueComment } from "../../src/waivers/index.js";
import { findCommands } from "../../src/waivers/command.js";
import { BLOB, BLOB2, comment, identity, policy, violation } from "./helpers.js";

const UNIT = "src/billing/plan.ts::applyDiscount#function[0]";
const request = (id = 1, login = "author-erin", extra = "") =>
  comment(id, login, `please\n/gate-waive gate=complexity unit="${UNIT}" metric=cogc ceiling=22 reason="explicit state machine, splitting hurts" ${extra}`);

function waiverIdOf(c: IssueComment): string {
  const r = parseWaiverRequest(c, policy());
  if (!Array.isArray(r)) throw new Error(r.problem);
  return r[0]!.id;
}

function ctx(over: Partial<Parameters<typeof evaluateWaivers>[1]> = {}) {
  return {
    policy: policy(),
    identity,
    now: new Date("2026-10-29T00:00:00Z"),
    candidateBlob: (p: string) => (p === "src/billing/plan.ts" ? BLOB : null),
    ...over,
  };
}

function approvedBy(login: string, blob = BLOB, at = 20) {
  const req = request();
  return [req, comment(at, login, approveCommand(waiverIdOf(req), blob))];
}

describe("waiver parsing", () => {
  it("parses quoted values and normalises the metric", () => {
    const r = parseWaiverRequest(request(), policy());
    expect(Array.isArray(r) && r[0]).toMatchObject({ gate: "complexity", unit: UNIT, metric: "cognitive", ceiling: 22, file: "src/billing/plan.ts" });
  });

  it("rejects wildcards, file-level units, non-waivable gates and unknown args", () => {
    const bad = [
      `/gate-waive gate=complexity unit="src/*::x#function[0]" metric=cogc ceiling=1 reason=r`,
      `/gate-waive gate=complexity unit="src/a.ts" metric=cogc ceiling=1 reason=r`,
      `/gate-waive gate=simplification-review unit="src/a.ts::x#function[0]" metric=cogc ceiling=1 reason=r`,
      `/gate-waive gate=complexity unit="src/a.ts::x#function[0]" metric=cogc ceiling=1 reason=r scope=pr`,
      `/gate-waive gate=complexity unit="src/a.ts::x#function[0]" metric=cogc ceiling=-1 reason=r`,
      `/gate-waive gate=complexity unit="unterminated metric=cogc ceiling=1 reason=r`,
    ];
    for (const body of bad) expect(Array.isArray(parseWaiverRequest(comment(1, "author-erin", body), policy()))).toBe(false);
  });

  it("refuses requests from the AI fix loop", () => {
    const r = parseWaiverRequest(request(1, "ai-agent[bot]"), policy());
    expect(r).toMatchObject({ problem: expect.stringContaining("AI fix loop") });
  });

  it("ignores commands quoted or in code fences", () => {
    expect(findCommands("> /gate-waive-approve W1 blob=x\n```\n/gate-waive-approve W2 blob=y\n```", "gate-waive-approve")).toHaveLength(0);
    expect(findCommands("/gate-waive-approve W1 blob=x", "gate-waive")).toHaveLength(0);
  });
});

describe("waiver approval validity (spec 14)", () => {
  it("accepts an independent approver on the current blob", () => {
    const { valid, rejected } = evaluateWaivers(approvedBy("appr-carol"), ctx());
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.approver).toBe("appr-carol");
  });

  it.each([
    ["author-erin", "not a waiver approver"],
    ["random-user", "not a waiver approver"],
  ])("rejects %s (non-roster)", (login, msg) => {
    expect(evaluateWaivers(approvedBy(login), ctx()).rejected[0]!.problem).toContain(msg);
  });

  it.each([
    ["PR author", { prAuthor: "appr-carol" }],
    ["commit author", { commits: [{ sha: "1", authorLogin: "appr-carol" }] }],
    ["committer", { commits: [{ sha: "1", authorLogin: "x", committerLogin: "appr-carol" }] }],
    ["co-author via noreply trailer", { commits: [{ sha: "1", message: "m\n\nCo-authored-by: C <99+appr-carol@users.noreply.github.com>" }] }],
    ["agent invoker", { agentInvokers: ["appr-carol"] }],
  ])("rejects an approver who is the %s", (_label, over) => {
    const r = evaluateWaivers(approvedBy("appr-carol"), ctx({ identity: { ...identity, ...over } }));
    expect(r.valid).toEqual([]);
    expect(r.rejected[0]!.problem).toMatch(/cannot approve/);
  });

  it("rejects a co-author matched by verified email", () => {
    const req = request();
    const app = { ...comment(20, "appr-carol", approveCommand(waiverIdOf(req), BLOB)), author: { login: "appr-carol", emails: ["GRACE@example.com"] } };
    expect(evaluateWaivers([req, app], ctx()).rejected[0]!.problem).toMatch(/co-author/);
  });

  it("rejects bots even when listed as approvers", () => {
    const p = policy({ review: { waiver_approvers: ["appr[bot]", "helper-bot"], bots: ["helper-bot"] } });
    for (const login of ["appr[bot]", "helper-bot"]) {
      expect(evaluateWaivers(approvedBy(login), ctx({ policy: p })).rejected[0]!.problem).toBe("bots cannot approve");
    }
  });

  it("resolves team rosters and fails closed for unresolved teams", () => {
    expect(evaluateWaivers(approvedBy("team-tom"), ctx({ teams: { "org/approvers": ["Team-Tom"] } })).valid).toHaveLength(1);
    expect(evaluateWaivers(approvedBy("team-tom"), ctx()).valid).toHaveLength(0);
  });

  it("is void when the code changed after approval", () => {
    expect(evaluateWaivers(approvedBy("appr-carol", BLOB2), ctx()).rejected[0]!.problem).toMatch(/changed/);
    expect(evaluateWaivers(approvedBy("appr-carol"), ctx({ candidateBlob: () => null })).valid).toHaveLength(0);
  });

  it("expires after max_days or the requested date", () => {
    expect(evaluateWaivers(approvedBy("appr-carol"), ctx({ now: new Date("2027-02-01T00:00:00Z") })).rejected[0]!.problem).toBe("waiver expired");
    const req = request(1, "author-erin", "expires=2026-10-28");
    const comments = [req, comment(20, "appr-carol", approveCommand(waiverIdOf(req), BLOB))];
    expect(evaluateWaivers(comments, ctx()).rejected[0]!.problem).toBe("waiver expired");
  });

  it("rejects approvals for unknown ids and the requester's self-approval", () => {
    expect(evaluateWaivers([comment(2, "appr-carol", `/gate-waive-approve Wdeadbeef00 blob=${BLOB}`)], ctx()).rejected[0]!.problem).toMatch(/no such/);
    const req = request(1, "appr-carol");
    expect(evaluateWaivers([req, comment(20, "appr-carol", approveCommand(waiverIdOf(req), BLOB))], ctx()).rejected[0]!.problem).toMatch(/own waiver/);
  });
});

describe("applying waivers", () => {
  const w = () => evaluateWaivers(approvedBy("appr-carol"), ctx()).valid;

  it("covers a matching violation within the ceiling", () => {
    const r = applyWaivers([violation()], w(), policy());
    expect(r.violations[0]!.waivedBy).toBe(w()[0]!.id);
    expect(r.applied).toHaveLength(1);
    expect(waiverTriggers(r.applied, w())[0]).toMatchObject({ id: "S6", routing: true, unit: UNIT });
  });

  it("does not cover a value above the ceiling", () => {
    const r = applyWaivers([violation({ after: 23 })], w(), policy());
    expect(r.violations[0]!.waivedBy).toBeUndefined();
    expect(r.unused[0]!.problem).toMatch(/ceiling/);
  });

  it("does not cover another unit, another metric or non-waivable reasons", () => {
    expect(applyWaivers([violation({ unit: UNIT.replace("[0]", "[1]") })], w(), policy()).applied).toHaveLength(0);
    expect(applyWaivers([violation({ metric: "cyclomatic" })], w(), policy()).applied).toHaveLength(0);
    expect(applyWaivers([violation({ reason: "DYNAMIC_CODE" })], w(), policy()).applied).toHaveLength(0);
  });

  it("enforces the per-PR budget", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...w()[0]!, id: `W${i}`, unit: `src/a.ts::f${i}#function[0]`, approvedAt: `2026-10-28T11:0${i}:00Z` }));
    const vs = many.map((m) => violation({ unit: m.unit }));
    const r = applyWaivers(vs, many, policy());
    expect(r.applied.map((a) => a.id)).toEqual(["W0", "W1", "W2"]);
    expect(r.unused).toEqual([{ id: "W3", problem: "per-PR waiver budget exhausted" }]);
  });

  it("builds a ledger line and a 90-day debt issue", () => {
    const line = ledgerLine(w()[0]!, { repository: "o/r", pr: 7, mergeCommit: "m", value: 21, recordedAt: "2026-10-30T00:00:00Z" });
    const entry = JSON.parse(line);
    expect(line.endsWith("\n")).toBe(true);
    expect(entry).toMatchObject({ unit: UNIT, value: 21, ceiling: 22, approver: "appr-carol" });
    const issue = debtIssue(entry, 90);
    expect(issue.labels).toEqual(["complexity-debt"]);
    expect(issue.dueDate).toBe("2027-01-28");
  });
});
