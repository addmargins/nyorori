// Round-2 fixes: rulings D13–D17 and audit/bug items assigned to the platform layer.
import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { aggregateQualityGate, type AggregateInput, type SubmittedResult } from "../../src/aggregate/index.js";
import { decideRetry, mergePreviousAttemptTriggers, previousAttemptTriggers } from "../../src/ailoop/index.js";
import { applyOverrides } from "../../src/override/index.js";
import { renderWaiverApprovalHints } from "../../src/report/markdown.js";
import { toCheckRun } from "../../src/report/checkrun.js";
import type { ReviewComment } from "../../src/review/simplification.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { checkExternalId, runAndPublish, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { createWebhookServer, signatureFor } from "../../src/service/http.js";
import type { GateId, TriggerHit } from "../../src/types.js";
import { applyWaivers, evaluateWaivers, isWaivable, parseWaiverRequest } from "../../src/waivers/index.js";
import { applyTestApprovals, testApprovalKey } from "../../src/waivers/test-approval.js";
import { B, BLOB, BLOB2, C, HEAD, REV, RUNNER, comment, identity, policy, result, violation } from "./helpers.js";

const WF = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["9".repeat(40)] };
const svc = (gate: GateId, over: Partial<Parameters<typeof result>[0]> = {}): SubmittedResult => ({ source: "service", result: result({ gate, ...over }) });
const prov = (over: Partial<NonNullable<SubmittedResult["provenance"]>> = {}) => ({
  repository: WF.repository, workflowPath: WF.path, workflowSha: WF.shas[0]!, runId: 10, runAttempt: 1, headSha: C, event: "merge_group", ...over,
});
const act = (gate: GateId, over: Partial<Parameters<typeof result>[0]> = {}, p = prov()): SubmittedResult => ({
  source: "actions", result: result({ gate, fingerprint: { runner_commit: "w", policy_revision: REV }, ...over }), provenance: p,
});
const all = (): SubmittedResult[] => [svc("complexity"), svc("lint-structure"), svc("deps"), act("tests"), act("coverage"), act("mutation")];
const swap = (gate: GateId, s: SubmittedResult, list = all()) => list.map((x) => (x.result.gate === gate ? s : x));
function agg(results: SubmittedResult[], over: Partial<AggregateInput> = {}) {
  return aggregateQualityGate({
    policy: policy(),
    expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER },
    results,
    trustedWorkflows: { workflows: [WF] },
    review: { headSha: HEAD, comments: [], identity },
    ...over,
  });
}

describe("bug #3: webhook server survives hostile clients", () => {
  it("a client reset mid-body does not crash the process; oversized bodies get 413", async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    const logs: string[] = [];
    const server = createWebhookServer({ secret: "s", dispatch: async () => {}, log: (m) => logs.push(m), maxBodyBytes: 1024, bodyTimeoutMs: 200 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await new Promise<void>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc");
          setTimeout(() => sock.resetAndDestroy(), 50);
        });
        sock.on("error", () => {});
        sock.on("close", () => setTimeout(resolve, 100));
      });
      const big = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "x".repeat(4096) });
      expect(big.status).toBe(413);
      // A stalled body times out instead of holding the request forever.
      const stalled = await new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab"));
        let data = "";
        sock.on("data", (d) => (data += d.toString()));
        sock.on("close", () => resolve(data));
        sock.on("error", () => resolve(data));
      });
      expect(stalled).toContain("408");
      const body = JSON.stringify({ ok: 1 });
      const good = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "x-hub-signature-256": signatureFor("s", body), "x-github-event": "ping" } });
      expect(good.status).toBe(202);
      expect(rejections).toEqual([]);
      expect(logs).toContain("webhook body rejected");
    } finally {
      process.off("unhandledRejection", onRej);
      server.close();
    }
  });
});

describe("D16: observe and degraded modes", () => {
  const s11: TriggerHit = { id: "S11", gate: "complexity", file: "src/a.vue", evidence: "unmeasured SFC", routing: true };
  const s1: TriggerHit = { id: "S1", gate: "complexity", file: "src/a.ts", evidence: "V kept", routing: true };

  it("observe-mode gates route only S6/S11", () => {
    const p = policy({ complexity: { mode: "observe" } });
    expect(agg(swap("complexity", svc("complexity", { triggers: [s1] })), { policy: p }).state).toBe("PASS");
    const v = agg(swap("complexity", svc("complexity", { triggers: [s1, s11] })), { policy: p });
    expect(v.state).toBe("FAIL");
    expect(v.triggers.map((t) => t.id)).toEqual(["S11"]);
    // The gate's own routing flag still holds: an ordinary foreign-language file is observe-only (ruling D5).
    const foreign: TriggerHit = { ...s11, file: "tools/x.py", evidence: "FOREIGN_LANGUAGE", routing: false };
    expect(agg(swap("complexity", svc("complexity", { triggers: [foreign] })), { policy: p }).state).toBe("PASS");
  });

  it("a degraded gate never blocks; its FAILs and triggers require the simplification review", () => {
    const p = policy({ complexity: { mode: "degraded" } });
    const v = agg(swap("complexity", svc("complexity", { violations: [violation()], triggers: [s1] })), { policy: p });
    expect(v.blocking.map((b) => b.reason)).toEqual(["REVIEW_REQUIRED"]);
    expect(v.triggers.some((t) => t.evidence.startsWith("degraded gate complexity: OVER_LIMIT_NEW"))).toBe(true);
    expect(v.triggers.some((t) => t.id === "S1")).toBe(true);
    expect(v.gates.find((g) => g.gate === "complexity")).toMatchObject({ mode: "degraded", counted: false });
    expect(toCheckRun(result({ mode: "degraded", violations: [violation()] }))).toMatchObject({ conclusion: "success", title: expect.stringMatching(/^\[degraded\]/) });
    // A clean degraded gate adds nothing; a missing one still reaches a human.
    expect(agg(all(), { policy: p }).state).toBe("PASS");
    const missing = agg(all().filter((x) => x.result.gate !== "complexity"), { policy: p });
    expect(missing.missing).toEqual([]);
    expect(missing.triggers[0]!.evidence).toBe("degraded gate complexity: did not report");
  });
});

describe("D13 via aggregation: review must dispose of every trigger", () => {
  it("a degraded-gate S6 needs an explicit disposition", () => {
    const p = policy({ complexity: { mode: "degraded" } });
    const rubric = "q1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: pass";
    const review = (body: string): ReviewComment => ({ id: 9, author: { login: "rev-alice" }, body, createdAt: "2026-10-28T13:00:00Z", headSha: HEAD });
    const run = (body: string) =>
      agg(swap("complexity", svc("complexity", { violations: [violation()] })), { policy: p, review: { headSha: HEAD, comments: [review(body)], identity } });
    expect(run(`/simplification-review NO_SIMPLIFICATION_NEEDED\n${rubric}`).state).toBe("FAIL");
    expect(run(`/simplification-review NO_SIMPLIFICATION_NEEDED\n${rubric}\nS6: incident 42, reviewed by hand`).state).toBe("PASS");
  });
});

describe("D14: waivability", () => {
  it.each([
    [{ reason: "TESTS_FAILED" as const }, false],
    [{ reason: "TESTS_FAILED" as const, details: { base_broken: true } }, true],
    [{ reason: "TESTS_FAILED_ON_BASE" as const }, true],
    [{ reason: "SUPPRESSION_ADDED" as const }, false],
    [{ reason: "SUPPRESSION_ADDED" as const, details: { waivable: true } }, true],
    [{ reason: "SUPPRESSION_ADDED_WAIVABLE" as const }, true],
    [{ reason: "TEST_NO_ASSERTION" as const }, true],
    [{ reason: "DYNAMIC_CODE" as const }, false],
    [{ reason: "BIDI_CONTROL" as const }, false],
    [{ reason: "TEST_REMOVED" as const }, false],
    [{ reason: "REVIEW_REQUIRED" as const }, false],
    [{ reason: "MANIFEST_MISMATCH" as const }, false],
  ])("%j → %s", (over, expected) => {
    expect(isWaivable(violation(over))).toBe(expected);
  });

  it("a test failing on B too is waived with metric=<reason> ceiling=0", () => {
    const unit = "test/a.test.ts::adds numbers";
    const req = comment(1, "author-erin", `/gate-waive gate=tests unit="${unit}" metric=TESTS_FAILED_ON_BASE ceiling=0 reason="flaky on main, tracked in #12"`);
    const id = (parseWaiverRequest(req, policy()) as Array<{ id: string }>)[0]!.id;
    const ctx = { policy: policy(), identity, now: new Date("2026-10-29T00:00:00Z"), candidateBlob: () => BLOB };
    const { valid } = evaluateWaivers([req, comment(20, "appr-carol", `/gate-waive-approve ${id} blob=${BLOB}`)], ctx);
    const v = violation({ gate: "tests", reason: "TESTS_FAILED_ON_BASE", unit, file: "test/a.test.ts", metric: undefined, after: undefined, limit: undefined });
    expect(applyWaivers([v], valid, policy()).applied).toHaveLength(1);
    expect(applyWaivers([{ ...v, reason: "TESTS_FAILED" }], valid, policy()).applied).toHaveLength(0);
  });
});

describe("D15: waiver carry-over to a new blob", () => {
  const UNIT = "src/billing/plan.ts::applyDiscount#function[0]";
  const req = comment(1, "author-erin", `/gate-waive gate=complexity unit="${UNIT}" metric=cogc ceiling=22 reason="state machine"`);
  const id = (parseWaiverRequest(req, policy()) as Array<{ id: string }>)[0]!.id;
  const comments = [req, comment(20, "appr-carol", `/gate-waive-approve ${id} blob=${BLOB}`)];
  const base = { policy: policy(), identity, now: new Date("2026-10-29T00:00:00Z"), candidateBlob: () => BLOB2 };

  it("carries over when the diff does not touch the unit, and asks the right question", () => {
    const asked: unknown[] = [];
    const r = evaluateWaivers(comments, { ...base, unitTouchedSince: (q) => (asked.push(q), false) });
    expect(r.valid[0]).toMatchObject({ blob: BLOB, currentBlob: BLOB2 });
    expect(asked).toEqual([{ file: "src/billing/plan.ts", unit: UNIT, approvedBlob: BLOB, currentBlob: BLOB2 }]);
    expect(applyWaivers([violation({ after: 23 })], r.valid, policy()).applied).toHaveLength(0); // ceiling still holds
  });

  it("is void when the unit was touched or the caller cannot tell", () => {
    expect(evaluateWaivers(comments, { ...base, unitTouchedSince: () => true }).valid).toHaveLength(0);
    expect(evaluateWaivers(comments, base).valid).toHaveLength(0);
  });
});

describe("F12: gate-owner test approvals", () => {
  const removed = violation({ gate: "tests", reason: "TEST_REMOVED", unit: "test/a.test.ts::adds", file: "test/a.test.ts", metric: undefined, after: undefined });
  const key = testApprovalKey(removed);
  const rc = (login: string, headSha = HEAD, body = `/gate-approve-tests key="${key}" note="moved to b.test.ts"`): ReviewComment => ({
    id: 3, author: { login }, body, createdAt: "2026-10-28T12:00:00Z", headSha,
  });
  const ctx = { policy: policy(), identity, headSha: HEAD };

  it("accepts the violation as an approval outside the waiver budget", () => {
    const r = applyTestApprovals([removed], [rc("owner-dave")], ctx);
    expect(r.violations[0]!.waivedBy).toMatch(/^TA/);
    expect(r.applied[0]).toMatchObject({ metric: "test-approval", approver: "owner-dave" });
    const res = result({ gate: "tests", violations: r.violations, waivers: r.applied });
    expect(res.state).toBe("ACCEPTED_WITH_WAIVER");
    const v = agg(swap("tests", { ...svc("tests"), result: res, provenance: prov() }));
    expect(v.state).toBe("ACCEPTED_WITH_WAIVER");
  });

  it("rejects non-owners, non-independent owners, another head and other reasons", () => {
    expect(applyTestApprovals([removed], [rc("appr-carol")], ctx).applied).toHaveLength(0);
    expect(applyTestApprovals([removed], [rc("owner-dave")], { ...ctx, identity: { ...identity, agentInvokers: ["owner-dave"] } }).applied).toHaveLength(0);
    expect(applyTestApprovals([removed], [rc("owner-dave", "0".repeat(40))], ctx).rejected[0]!.problem).toMatch(/another head/);
    const focus = { ...removed, reason: "TEST_FOCUS_OR_SKIP" as const };
    expect(applyTestApprovals([focus], [rc("owner-dave", HEAD, `/gate-approve-tests key="${testApprovalKey(focus)}" note=x`)], ctx).applied).toHaveLength(0);
  });
});

describe("F13: the gate's own copyable approval command works", () => {
  it("parses the rendered line once it is copied out of the fence", () => {
    const UNIT = "src/billing/plan.ts::applyDiscount#function[0]";
    const req = comment(1, "author-erin", `/gate-waive gate=complexity unit="${UNIT}" metric=cogc ceiling=22 reason="r"`);
    const id = (parseWaiverRequest(req, policy()) as Array<{ id: string }>)[0]!.id;
    const md = renderWaiverApprovalHints([{ id, unit: UNIT, blob: BLOB }]);
    const line = md.split("\n").find((l) => l.startsWith("/gate-waive-approve"))!;
    const ctx = { policy: policy(), identity, now: new Date("2026-10-29T00:00:00Z"), candidateBlob: () => BLOB };
    expect(evaluateWaivers([req, comment(20, "appr-carol", line)], ctx)).toMatchObject({ rejected: [], valid: [{ id }] });
  });
});

describe("F14: waivedBy is only trusted when the service applied it", () => {
  const applied = [{ id: "W1", unit: violation().unit!, metric: "cognitive", ceiling: 22, approver: "appr-carol" }];
  it("drops waivedBy from Actions artifacts", () => {
    const forged = act("tests", { violations: [violation({ gate: "tests", reason: "TEST_REMOVED", waivedBy: "Wfake" })], waivers: [{ ...applied[0]!, id: "Wfake" }] });
    expect(agg(swap("tests", forged)).state).toBe("FAIL");
  });
  it("drops waivedBy without an applied waiver or on a non-waivable reason", () => {
    expect(agg(swap("complexity", svc("complexity", { violations: [violation({ waivedBy: "W1" })] }))).state).toBe("FAIL");
    const dyn = svc("lint-structure", { violations: [violation({ gate: "lint-structure", reason: "DYNAMIC_CODE", waivedBy: "W1" })], waivers: applied });
    expect(agg(swap("lint-structure", dyn)).state).toBe("FAIL");
    expect(agg(swap("complexity", svc("complexity", { violations: [violation({ waivedBy: "W1" })], waivers: applied }))).state).toBe("ACCEPTED_WITH_WAIVER");
  });
});

describe("F17 / D17: AI loop", () => {
  const base = { attempt: 1, previousViolations: ["a", "b"], currentViolations: ["a"], forbidden: [] };
  it("hands off on any new routing trigger, not only S1/S9", () => {
    for (const id of ["S2", "S4", "S5", "S10", "S11", "S12"] as const) {
      expect(decideRetry({ ...base, newTriggers: [{ id, gate: "complexity", evidence: "", routing: true }] }, policy()).action, id).toBe("handoff");
    }
    expect(decideRetry({ ...base, newTriggers: [{ id: "S8", gate: "complexity", evidence: "", routing: false }] }, policy()).action).toBe("retry");
  });
  it("merges S1/S9/S10 computed against the previous attempt for files that had a G1 violation", () => {
    const vsPrev: TriggerHit[] = [
      { id: "S1", gate: "complexity", file: "src/a.ts", evidence: "V 16→16", routing: false },
      { id: "S9", gate: "complexity", file: "src/other.ts", evidence: "V drop", routing: true },
      { id: "S4", gate: "complexity", file: "src/a.ts", evidence: "long", routing: true },
    ];
    expect(previousAttemptTriggers(vsPrev, ["src/a.ts"])).toEqual([{ ...vsPrev[0]!, routing: true, evidence: "V 16→16 (vs previous attempt)" }]);
    const merged = mergePreviousAttemptTriggers([vsPrev[2]!], vsPrev, ["src/a.ts"]);
    expect(merged.map((t) => t.id)).toEqual(["S4", "S1"]);
  });
});

describe("F18: pull_request provenance", () => {
  const prRun = (over = {}) => prov({ event: "pull_request", headSha: HEAD, ...over });
  const withPr = { expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER, prHeadSha: HEAD } };
  it("needs run head = PR head and test merge = C", () => {
    expect(agg(swap("tests", act("tests", {}, prRun({ testMergeSha: C }))), withPr).state).toBe("PASS");
    expect(agg(swap("tests", act("tests", {}, prRun({ testMergeSha: "7".repeat(40) }))), withPr).reasons).toContain("UNTRUSTED_ARTIFACT");
    expect(agg(swap("tests", act("tests", {}, prRun())), withPr).reasons).toContain("UNTRUSTED_ARTIFACT");
    expect(agg(swap("tests", act("tests", {}, prRun({ headSha: "6".repeat(40), testMergeSha: C }))), withPr).reasons).toContain("UNTRUSTED_ARTIFACT");
  });
});

describe("bug #11: concurrent evaluations and run-scoped overrides", () => {
  class Fake implements GitHubClient {
    runs: Array<CheckRunRecord & { req: CheckRunRequest }> = [];
    merge = C;
    async getPullRequest() { return { number: 7, headSha: HEAD, author: "a", state: "open" as const }; }
    async resolveRef() { return this.merge; }
    async getCommitParents() { return [B, HEAD]; }
    async listCheckRuns(_r: unknown, sha: string) { return this.runs.filter((r) => r.headSha === sha); }
    async createCheckRun(_r: unknown, req: CheckRunRequest) {
      const id = this.runs.length + 1;
      this.runs.push({ id, name: req.name, headSha: req.headSha, appId: 1, status: req.status, conclusion: req.conclusion ?? null, externalId: req.externalId, req });
      return id;
    }
    async updateCheckRun(_r: unknown, id: number, req: CheckRunRequest) {
      Object.assign(this.runs.find((r) => r.id === id)!, { status: req.status, conclusion: req.conclusion ?? null, req });
    }
  }
  const verdict = (ctx: EvaluationContext) =>
    aggregateQualityGate({ policy: policy(), expected: { base: ctx.base, candidate: ctx.candidate, policyRevision: REV, runnerCommit: RUNNER }, results: all().map((s) => ({ ...s, result: { ...s.result, base_sha: ctx.base, candidate_sha: ctx.candidate } })), trustedWorkflows: { workflows: [WF] }, review: { headSha: HEAD, comments: [], identity } });

  it("keys runs by (B, C, P) and never lets a stale evaluation overwrite a newer one", async () => {
    const client = new Fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const B2 = "a".repeat(40);
    const C2 = "e".repeat(40);
    const deps: ServiceDeps = {
      client, appId: 1, policyRevision: REV,
      evaluate: async (ctx) => {
        if (ctx.base === B) await gate; // the old evaluation is slow
        return { verdict: verdict(ctx), results: [] };
      },
    };
    const old = runAndPublish(deps, { repo: { owner: "o", repo: "r" }, kind: "pull_request", prNumber: 7, prHeadSha: HEAD, base: B, candidate: C, checkSha: HEAD });
    await new Promise((r) => setTimeout(r, 5));
    client.merge = C2; // base moved: the test merge is now C2
    await runAndPublish(deps, { repo: { owner: "o", repo: "r" }, kind: "pull_request", prNumber: 7, prHeadSha: HEAD, base: B2, candidate: C2, checkSha: HEAD });
    release();
    expect(await old).toBeNull();
    const qg = client.runs.filter((r) => r.name === "quality-gate");
    const newer = qg.find((r) => r.externalId === checkExternalId({ base: B2, candidate: C2 }, REV))!;
    const stale = qg.find((r) => r.externalId === checkExternalId({ base: B, candidate: C }, REV))!;
    expect(newer.req.title).not.toMatch(/SUPERSEDED/);
    expect(newer.status).toBe("completed");
    expect(stale.req).toMatchObject({ conclusion: "failure", title: expect.stringMatching(/^SUPERSEDED/) });
    expect(newer.id).toBeGreaterThan(stale.id); // GitHub shows the latest run of the name
  });

  it("gate owners may override NONDETERMINISM for this (B, C) only; MEASURER_MISMATCH stays", () => {
    const nd = { reason: "NONDETERMINISM" as const, detail: "-j1 differs", authorFixable: false };
    const mm = { reason: "MEASURER_MISMATCH" as const, detail: "sha256", authorFixable: false };
    const ctx = { policy: policy(), identity, candidateBlob: () => null, base: B, candidate: C };
    const cmd = (reason: string, cand = C) => comment(5, "owner-dave", `/gate-override gate=complexity reason=${reason} base=${B} candidate=${cand} note="flaky runner"`);
    const ok = applyOverrides("complexity", [nd, mm], [cmd("NONDETERMINISM")], ctx);
    expect(ok.inconclusive).toEqual([mm]);
    expect(ok.triggers[0]).toMatchObject({ id: "S6", routing: true });
    expect(ok.rerunRequired[0]).toMatch(/re-run/);
    expect(applyOverrides("complexity", [nd], [cmd("NONDETERMINISM", "e".repeat(40))], ctx).inconclusive).toEqual([nd]);
    expect(applyOverrides("complexity", [mm], [cmd("MEASURER_MISMATCH")], ctx).rejected[0]!.problem).toMatch(/without a file/);
    expect(applyOverrides("complexity", [nd], [cmd("NONDETERMINISM")], { ...ctx, base: undefined }).inconclusive).toEqual([nd]);
  });
});
