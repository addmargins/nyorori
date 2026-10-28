// Round 4: agent-invoker independence, evidence binding, shadow verdict,
// AI-loop stop conditions, job journal, and the fresh-review supplement
// (test-merge backoff, FAIL kept on provenance problems, verdict stored only
// after publication, locked debt issues, re-asserted checks, file::unit waivers).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateQualityGate, shadowNote, type SubmittedResult } from "../../src/aggregate/index.js";
import { decideRetry } from "../../src/ailoop/index.js";
import { verdictToCheckRun } from "../../src/report/checkrun.js";
import { buildGateFeedback } from "../../src/report/feedback.js";
import { renderSummaryMarkdown } from "../../src/report/markdown.js";
import { requiredApprovers, secondApproverReason, type PrIdentityContext } from "../../src/review/independence.js";
import { collectAgentInvokers, linkedIssueNumbers } from "../../src/review/invokers.js";
import { evaluateSimplificationReview, type ReviewComment } from "../../src/review/simplification.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { bindArtifact } from "../../src/service/evidence.js";
import type { ArtifactRef, WorkflowRun } from "../../src/service/github.js";
import { dispatchEvent, EvaluationQueue, replayPendingJobs, runAndPublish, TEST_MERGE_BACKOFF_MS, type Evaluation, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { FileDeliveryStore, JobJournal } from "../../src/service/journal.js";
import { IssuedDebtStore } from "../../src/service/merge.js";
import { applyWaivers, type ValidWaiver } from "../../src/waivers/index.js";
import { B, C, HEAD, REV, RUNNER, identity, policy, result, violation } from "../platform/helpers.js";

const WF = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["9".repeat(40)] };
const svc = (gate: SubmittedResult["result"]["gate"], over: Partial<Parameters<typeof result>[0]> = {}): SubmittedResult => ({ source: "service", result: result({ gate, ...over }) });
const prov = (over: Partial<NonNullable<SubmittedResult["provenance"]>> = {}) => ({
  repository: WF.repository, workflowPath: WF.path, workflowSha: WF.shas[0]!, runId: 10, runAttempt: 1, headSha: C, event: "merge_group", runConclusion: "success", ...over,
});
const act = (gate: SubmittedResult["result"]["gate"], over: Partial<Parameters<typeof result>[0]> = {}, p = prov()): SubmittedResult => ({
  source: "actions", result: result({ gate, fingerprint: { runner_commit: "w", policy_revision: REV }, ...over }), provenance: p,
});
const all = (): SubmittedResult[] => [svc("complexity"), svc("lint-structure"), svc("deps"), act("tests"), act("coverage"), act("mutation")];
const swap = (gate: SubmittedResult["result"]["gate"], s: SubmittedResult, list = all()) => list.map((x) => (x.result.gate === gate ? s : x));
const agg = (results: SubmittedResult[], p = policy()) =>
  aggregateQualityGate({ policy: p, expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER }, results, trustedWorkflows: { workflows: [WF] }, review: { headSha: HEAD, comments: [], identity } });

describe("1. agent-invoker independence", () => {
  const bot = "ai-agent[bot]";
  const aiPr = (invokers: string[]): PrIdentityContext => ({ prAuthor: bot, commits: [], agentInvokers: invokers, authorIsAiLoop: true });

  it("collects assignees, body mentions, @bot comment authors and linked-issue authors, never bots", () => {
    const got = collectAgentInvokers(
      {
        botLogin: bot,
        assignees: ["Alice"],
        body: "Requested by @bob in #12. cc @helper-bot @ai-agent[bot]",
        comments: [
          { author: "carol", body: `@${bot} please also fix the tests` },
          { author: "dave", body: "looks fine" },
          { author: "eve", body: "mentions @someone-else" },
        ],
        linkedIssueAuthors: ["frank"],
      },
      policy(),
    );
    expect(got).toEqual(["alice", "bob", "carol", "frank"]);
    expect(linkedIssueNumbers("Closes #12, fixes: #7, resolves other/repo#9, resolved org/app#3, see #99", "org/app")).toEqual([12, 7, 3]);
  });

  it("an AI-loop PR with unknown invokers needs two approvers; a known invoker cannot approve", () => {
    expect(requiredApprovers(aiPr([]))).toBe(2);
    expect(secondApproverReason(aiPr([]))).toMatch(/unknown invokers/);
    expect(requiredApprovers(aiPr(["alice"]))).toBe(1);
    const rubric = `q1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: pass\nS1: fine`;
    const rc = (id: number, login: string): ReviewComment => ({ id, author: { login }, body: `/simplification-review NO_SIMPLIFICATION_NEEDED sha=${HEAD}\n${rubric}`, createdAt: `2026-10-28T12:0${id}:00Z`, headSha: HEAD });
    const S1 = { id: "S1" as const, gate: "complexity" as const, file: "src/a.ts", evidence: "e", routing: true };
    const g6 = (ident: PrIdentityContext, comments: ReviewComment[]) =>
      evaluateSimplificationReview({ policy: policy(), mode: "enforce", base: B, candidate: C, headSha: HEAD, fingerprint: { runner_commit: RUNNER, policy_revision: REV }, triggers: [S1], comments, identity: ident });
    expect(g6(aiPr([]), [rc(1, "rev-alice")]).state).toBe("FAIL");
    expect(g6(aiPr([]), [rc(1, "rev-alice"), rc(2, "rev-bob")]).state).toBe("PASS");
    expect(g6(aiPr(["rev-alice"]), [rc(1, "rev-alice")]).state).toBe("FAIL");
    expect(g6(aiPr(["carol"]), [rc(1, "rev-alice")]).state).toBe("PASS");
  });
});

describe("2. evidence binding", () => {
  const run: WorkflowRun = { id: 10, runAttempt: 2, event: "merge_group", headSha: C, status: "completed", conclusion: "success", repository: "o/r", path: WF.path, referencedWorkflows: [], runStartedAt: "2026-10-28T12:00:00Z" };
  const art = (over: Partial<ArtifactRef> = {}): ArtifactRef => ({ id: 1, name: `nyorori-gate-${C}`, expired: false, createdAt: "2026-10-28T12:05:00Z", workflowRunHeadSha: C, ...over });

  it("binds only an artifact created after the attempt started for the looked-up commit", () => {
    expect(bindArtifact(run, [art()], C, C).artifact?.id).toBe(1);
    expect(bindArtifact(run, [art({ createdAt: "2026-10-28T11:59:00Z" })], C, C).problem).toMatch(/predates attempt 2/);
    expect(bindArtifact(run, [art({ workflowRunHeadSha: "0".repeat(40) })], C, C).problem).toMatch(/belongs to a run of/);
    expect(bindArtifact(run, [art({ createdAt: undefined })], C, C).problem).toMatch(/no created_at/);
    expect(bindArtifact({ ...run, runStartedAt: undefined }, [art()], C, C).problem).toMatch(/no run_started_at/);
    expect(bindArtifact(run, [art({ name: "other" })], C, C)).toEqual({});
    // An older upload next to a fresh one: the fresh one binds.
    expect(bindArtifact(run, [art({ id: 5, createdAt: "2026-10-28T11:00:00Z" }), art({ id: 6 })], C, C).artifact?.id).toBe(6);
  });
});

describe("3. shadow verdict", () => {
  it("records what every gate enforced would decide, without blocking", () => {
    const p = policy({ complexity: { mode: "observe" } });
    const v = agg(swap("complexity", svc("complexity", { violations: [violation()] })), p);
    expect(v.state).toBe("PASS");
    expect(v.mergeAllowed).toBe(true);
    expect(v.would_block).toBe(true);
    expect(v.shadow.state).toBe("FAIL");
    expect(v.shadow.blocking[0]).toMatchObject({ gate: "complexity", reason: "OVER_LIMIT_NEW" });
    expect(v.shadow.promoted).toContainEqual({ gate: "complexity", mode: "observe", state: "FAIL" });
    expect(v.shadow.promoted.map((x) => x.gate)).toEqual(["complexity", "coverage", "mutation"]);
    expect(shadowNote(v)).toBe("shadow: would block — G1 FAIL OVER_LIMIT_NEW");
    expect(verdictToCheckRun(v, []).title).toContain("shadow: would block");
    expect(renderSummaryMarkdown([], v)).toContain("Shadow 판정");
    const fb = buildGateFeedback([], { attempt: 0, preserve: [], maxRetries: 2, verdict: v });
    expect(fb).toMatchObject({ state: "PASS", would_block: true, max_retries: 2 });
    expect(fb.shadow?.state).toBe("FAIL");
    expect(fb.stop_if.map((s) => s.id)).toContain("inconclusive");
    expect(fb.forbidden_changes.length).toBeGreaterThan(3);
  });

  it("an observe gate that never reported is not a hypothetical failure; degraded routes count", () => {
    const clean = agg(all().filter((s) => s.result.gate !== "mutation"));
    expect(clean.would_block).toBe(false);
    expect(clean.shadow.state).toBe("PASS");
    const S1 = { id: "S1" as const, gate: "complexity" as const, file: "src/a.ts", evidence: "e", routing: true };
    const degraded = agg(swap("complexity", svc("complexity", { triggers: [S1] })), policy({ complexity: { mode: "degraded" } }));
    expect(degraded.state).toBe("FAIL"); // review required through the degraded route
    expect(degraded.shadow.triggers.map((t) => t.id)).toEqual(["S1"]);
    const enforced = agg(all(), policy({ coverage: { mode: "enforce" }, mutation: { mode: "enforce" } }));
    expect(enforced.shadow.promoted).toEqual([]);
    expect(enforced.would_block).toBe(false);
  });
});

describe("4. AI loop stop conditions", () => {
  const base = { attempt: 1, previousViolations: ["a", "b"], currentViolations: ["a"], newTriggers: [], forbidden: [] };
  it("hands off on INCONCLUSIVE and on base/policy/fingerprint drift, and counts attempts", () => {
    expect(decideRetry({ ...base, inconclusive: [{ reason: "MANIFEST_MISMATCH", detail: "x", authorFixable: true }] }, policy())).toMatchObject({ action: "handoff", reason: "inconclusive: MANIFEST_MISMATCH", attemptsRemaining: 1 });
    const first = { base: B, policyRevision: REV, fingerprint: "f" };
    expect(decideRetry({ ...base, first, current: { ...first, base: "0".repeat(40) } }, policy()).reason).toMatch(/^measurement_drift: base/);
    expect(decideRetry({ ...base, first, current: { ...first, policyRevision: "rev-2" } }, policy()).reason).toMatch(/policy/);
    expect(decideRetry({ ...base, first, current: { ...first, fingerprint: "g" } }, policy()).reason).toMatch(/fingerprint/);
    expect(decideRetry({ ...base, first, current: first }, policy())).toMatchObject({ action: "retry", attemptsRemaining: 1 });
    expect(decideRetry({ ...base, attempt: 2, previousViolations: ["z"] }, policy())).toMatchObject({ action: "handoff", reason: expect.stringMatching(/^retry_limit/), attemptsRemaining: 0 });
  });
});

class Fake implements GitHubClient {
  runs: Array<CheckRunRecord & { req: CheckRunRequest }> = [];
  merges: Array<string | null> = [C];
  parents: Record<string, string[]> = { [C]: [B, HEAD] };
  issues: number[] = [];
  createDelay: Promise<void> | null = null;
  async getPullRequest() { return { number: 7, headSha: HEAD, author: "alice", state: "open" as const }; }
  async resolveRef() { return this.merges.length > 1 ? this.merges.shift()! : this.merges[0]!; }
  async getCommitParents(_r: unknown, sha: string) { return this.parents[sha] ?? []; }
  async listCheckRuns(_r: unknown, sha: string) { return this.runs.filter((r) => r.headSha === sha); }
  async createCheckRun(_r: unknown, req: CheckRunRequest) {
    if (this.createDelay) { const d = this.createDelay; this.createDelay = null; await d; }
    const id = this.runs.length + 1;
    this.runs.push({ id, name: req.name, headSha: req.headSha, appId: 1, status: req.status, conclusion: req.conclusion ?? null, externalId: req.externalId, req });
    return id;
  }
  async updateCheckRun(_r: unknown, id: number, req: CheckRunRequest) {
    // PATCH /check-runs updates external_id too, which the placeholder take-over relies on.
    Object.assign(this.runs.find((r) => r.id === id)!, { status: req.status, conclusion: req.conclusion ?? null, externalId: req.externalId, req });
  }
  async createIssue() { this.issues.push(this.issues.length + 100); return this.issues[this.issues.length - 1]!; }
}
function verdictFor(ctx: EvaluationContext, pass = true): Evaluation {
  const p = policy({ tests: { mode: "observe" } });
  const results = pass ? all().slice(0, 3) : swap("complexity", svc("complexity", { violations: [violation()] }), all().slice(0, 3));
  const fixed = results.map((s) => ({ ...s, result: { ...s.result, base_sha: ctx.base, candidate_sha: ctx.candidate } }));
  return { results: [], verdict: aggregateQualityGate({ policy: p, expected: { base: ctx.base, candidate: ctx.candidate, policyRevision: REV, runnerCommit: RUNNER }, results: fixed, trustedWorkflows: { workflows: [] }, review: { headSha: HEAD, comments: [], identity } }) };
}
const prEvent = { action: "synchronize", repository: { owner: { login: "o" }, name: "r" }, pull_request: { number: 7, head: { sha: HEAD }, state: "open" } };
const mgEvent = { action: "checks_requested", repository: { owner: { login: "o" }, name: "r" }, merge_group: { head_sha: C, base_sha: B } };

describe("supplement (a): the test merge is polled before INCONCLUSIVE", () => {
  it("waits with backoff while refs/pull/N/merge is missing or stale, then evaluates", async () => {
    const client = new Fake();
    client.merges = [null, "stale".padEnd(40, "0"), C];
    client.parents["stale".padEnd(40, "0")] = [B, "0".repeat(40)];
    const slept: number[] = [];
    const deps: ServiceDeps = { client, appId: 1, queue: new EvaluationQueue(), sleep: async (ms) => void slept.push(ms), evaluate: async (ctx) => verdictFor(ctx) };
    const out = await dispatchEvent(deps, "pull_request", prEvent, "d1");
    expect(out).not.toBeNull();
    expect(slept).toEqual(TEST_MERGE_BACKOFF_MS.slice(0, 2));
    const qg = client.runs.filter((r) => r.name === "quality-gate");
    expect(qg).toHaveLength(1); // the waiting placeholder was taken over, not left pending
    expect(qg[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("gives up after the last try with the failing INCONCLUSIVE", async () => {
    const client = new Fake();
    client.merges = [null];
    const slept: number[] = [];
    const deps: ServiceDeps = { client, appId: 1, queue: new EvaluationQueue(), sleep: async (ms) => void slept.push(ms), evaluate: async (ctx) => verdictFor(ctx) };
    expect(await dispatchEvent(deps, "pull_request", prEvent, "d2")).toBeNull();
    expect(slept).toEqual([...TEST_MERGE_BACKOFF_MS]);
    expect(client.runs.find((r) => r.name === "quality-gate")!.req).toMatchObject({ status: "completed", conclusion: "failure", title: "INCONCLUSIVE: no test merge" });
  });
});

describe("supplement (b): a service FAIL survives a provenance problem", () => {
  it("keeps the FAIL and notes the problem; a PASS is still rejected", () => {
    const fail = { ...svc("tests", { violations: [violation({ gate: "tests", reason: "TEST_REMOVED" })] }), provenance: prov({ workflowSha: "8".repeat(40) }) };
    const v = agg(swap("tests", fail));
    expect(v.state).toBe("FAIL");
    expect(v.reasons).toContain("TEST_REMOVED");
    expect(v.inconclusive.some((i) => i.reason === "UNTRUSTED_ARTIFACT" && /FAIL is kept/.test(i.detail))).toBe(true);
    expect(agg(swap("tests", act("tests", {}, prov({ workflowSha: "8".repeat(40) })))).reasons).toContain("UNTRUSTED_ARTIFACT");
  });
});

describe("supplement (c)/(e): publication", () => {
  it("onPublished runs only after the verdict check is published, never for a superseded evaluation", async () => {
    const client = new Fake();
    const published: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const deps: ServiceDeps = { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), evaluate: async (ctx) => {
      const mine = ++n;
      if (mine === 1) await gate;
      return { ...verdictFor(ctx), onPublished: async () => void published.push(`e${mine}`) };
    } };
    const ctx: EvaluationContext = { repo: { owner: "o", repo: "r" }, kind: "pull_request", prNumber: 7, prHeadSha: HEAD, base: B, candidate: C, checkSha: HEAD };
    const a = runAndPublish(deps, ctx);
    await new Promise((r) => setTimeout(r, 5));
    const b = runAndPublish(deps, ctx);
    release();
    await Promise.all([a, b]);
    expect(published).toEqual(["e2"]);
  });

  it("a late in_progress upsert from a stale evaluation is re-asserted completed", async () => {
    const client = new Fake();
    let release!: () => void;
    client.createDelay = new Promise<void>((r) => (release = r)); // A's first (in_progress) create is slow
    const deps: ServiceDeps = { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), evaluate: async (ctx) => verdictFor(ctx, false) };
    const ctx: EvaluationContext = { repo: { owner: "o", repo: "r" }, kind: "pull_request", prNumber: 7, prHeadSha: HEAD, base: B, candidate: C, checkSha: HEAD };
    const a = runAndPublish(deps, ctx);
    await new Promise((r) => setTimeout(r, 5));
    await runAndPublish(deps, ctx); // B publishes FAIL
    release();
    await a;
    const qg = client.runs.filter((r) => r.name === "quality-gate");
    expect(qg.length).toBeGreaterThanOrEqual(1);
    expect(qg.every((r) => r.status === "completed" && r.conclusion === "failure")).toBe(true);
  });
});

describe("supplement (d): debt issues are claimed under a lock", () => {
  it("two concurrent merge recordings open one issue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-debt-"));
    const store = new IssuedDebtStore(join(dir, "issued.json"));
    let opened = 0;
    const open = async () => { await new Promise((r) => setTimeout(r, 5)); return ++opened + 100; };
    const [x, y] = await Promise.all([store.claim("o/r#W1", open), store.claim("o/r#W1", open)]);
    expect(opened).toBe(1);
    expect(x.issue).toBe(y.issue);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(JSON.parse(readFileSync(join(dir, "issued.json"), "utf8"))).toEqual({ "o/r#W1": 101 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("supplement (f): waivers match file::unit", () => {
  it("covers a violation whose unit lacks the path when the waiver names file::unit", () => {
    const w: ValidWaiver = { id: "W1", commentId: "1", requester: "r", gate: "tests", unit: "test/a.test.ts::adds", file: "test/a.test.ts", metric: "tests_failed_on_base", ceiling: 0, reason: "flaky", requestedAt: "2026-10-28T10:00:00Z", approver: "appr-carol", approvedAt: "2026-10-28T11:00:00Z", expiresAt: "2027-01-01T00:00:00Z", blob: "1".repeat(40) };
    const bare = violation({ gate: "tests", reason: "TESTS_FAILED_ON_BASE", unit: "adds", file: "test/a.test.ts", metric: undefined, after: undefined });
    const full = { ...bare, unit: "test/a.test.ts::adds" };
    expect(applyWaivers([bare], [w], policy()).applied).toHaveLength(1);
    expect(applyWaivers([full], [w], policy()).applied).toHaveLength(1);
    expect(applyWaivers([{ ...bare, file: "test/b.test.ts" }], [w], policy()).applied).toHaveLength(0);
  });
});

describe("5. job journal", () => {
  it("journals deliveries through queued → running → done and replays pending ones on startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-jobs-"));
    const journal = new JobJournal(join(dir, "jobs"));
    const client = new Fake();
    const deps: ServiceDeps = { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), journal, evaluate: async (ctx) => verdictFor(ctx) };
    await dispatchEvent(deps, "merge_group", mgEvent, "d-done");
    const file = join(dir, "jobs", "o", "r", "d-done.json");
    const done = JSON.parse(readFileSync(file, "utf8"));
    expect(done).toMatchObject({ status: "done", event: "merge_group", replayable: true });
    expect(done.payload).toBeUndefined();
    expect(done.startedAt && done.finishedAt).toBeTruthy();

    // A process that died mid-way left a running job; a restart replays it.
    await journal.enqueue("o/r", "d-crashed", "merge_group", mgEvent, 1);
    await journal.update("o/r", "d-crashed", "running");
    await journal.enqueue("o/r", "d-queued", "pull_request", prEvent, 2);
    expect((await journal.pending()).map((j) => j.delivery)).toEqual(["d-crashed", "d-queued"]);
    const fresh = new Fake();
    const r = await replayPendingJobs({ ...deps, client: fresh, queue: new EvaluationQueue(), sleep: async () => {} }, journal);
    expect(r).toEqual({ replayed: 2, dropped: 0 });
    expect(await journal.pending()).toEqual([]);
    expect(fresh.runs.filter((x) => x.name === "quality-gate" && x.status === "completed")).toHaveLength(2);

    // Unsafe names never touch the filesystem; old terminal records are pruned.
    await expect(journal.enqueue("../x/r", "d", "merge_group", {}, 0)).rejects.toThrow(/unsafe/);
    expect(await journal.prune(0, 0)).toBeGreaterThanOrEqual(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists seen deliveries across restarts, bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-deliv-"));
    const file = join(dir, "deliveries.log");
    const a = new FileDeliveryStore(file, 3);
    await a.add(["d1", "sha256:1"]);
    await a.add(["d2", "sha256:2"]);
    const b = new FileDeliveryStore(file, 3);
    expect(await b.has("d2")).toBe(true);
    expect(await b.has("sha256:1")).toBe(true);
    await b.add(["d3", "d4", "d5", "d6"]);
    const c = new FileDeliveryStore(file, 3);
    expect(await c.has("d6")).toBe(true);
    expect(await c.has("d1")).toBe(false); // compacted away
    rmSync(dir, { recursive: true, force: true });
  });
});
