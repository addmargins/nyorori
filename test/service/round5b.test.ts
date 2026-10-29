// Round 5b: the independent verifier's findings on the evidence wait (B3 race,
// B6 two workflows, B7c throw-on-resume, B9 journal growth, A3 late run) and
// the signer's environment allowlist.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateQualityGate, type SubmittedResult } from "../../src/aggregate/index.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { dispatchEvent, EvaluationQueue, sweepWaiting, type Evaluation, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { JobJournal, MemoryWaitStore } from "../../src/service/journal.js";
import { CommandSigner, createSigner, signerEnvironment } from "../../src/service/signer.js";
import { readZip, writeStoredZip } from "../../src/service/zip.js";
import { B, C, HEAD, REV, RUNNER, identity, policy, result } from "../platform/helpers.js";

const WF = ".github/workflows/gate-untrusted-tests.yml";
const WF2 = ".github/workflows/gate-untrusted-coverage.yml";
const HEAD2 = "e".repeat(40);
const C2 = "f".repeat(40);
const repo = { owner: { login: "o" }, name: "r" };
const prEvent = (head: string) => ({ action: "synchronize", repository: repo, pull_request: { number: 7, head: { sha: head }, state: "open" } });
const runEvent = (head: string, path = WF) => ({ action: "completed", repository: repo, workflow_run: { head_sha: head, path, conclusion: "success", run_attempt: 1, event: "pull_request" } });

class Fake implements GitHubClient {
  runs: Array<CheckRunRecord & { req: CheckRunRequest }> = [];
  current = HEAD;
  merge: Record<string, string> = { [HEAD]: C, [HEAD2]: C2 };
  parents: Record<string, string[]> = { [C]: [B, HEAD], [C2]: [B, HEAD2] };
  workflowRuns: Array<{ id: number; path: string; status: string; conclusion: string | null; headSha: string; event: string }> = [];
  async getPullRequest() { return { number: 7, headSha: this.current, author: "alice", state: "open" as const }; }
  async resolveRef() { return this.merge[this.current] ?? null; }
  async getCommitParents(_r: unknown, sha: string) { return this.parents[sha] ?? []; }
  async listCheckRuns(_r: unknown, sha: string) { return this.runs.filter((r) => r.headSha === sha); }
  async createCheckRun(_r: unknown, req: CheckRunRequest) {
    const id = this.runs.length + 1;
    this.runs.push({ id, name: req.name, headSha: req.headSha, appId: 1, status: req.status, conclusion: req.conclusion ?? null, externalId: req.externalId, req });
    return id;
  }
  async updateCheckRun(_r: unknown, id: number, req: CheckRunRequest) {
    Object.assign(this.runs.find((r) => r.id === id)!, { status: req.status, conclusion: req.conclusion ?? null, externalId: req.externalId, req });
  }
  async createIssue() { return 1; }
  async listWorkflowRuns(_r: unknown, head: string) { return this.workflowRuns.filter((r) => r.headSha === head); }
  qg(sha: string) { return this.runs.filter((r) => r.name === "quality-gate" && r.headSha === sha).sort((a, b) => b.id - a.id)[0]; }
}

const svc = (gate: SubmittedResult["result"]["gate"], over: Partial<Parameters<typeof result>[0]> = {}): SubmittedResult => ({ source: "service", result: result({ gate, ...over }) });
function verdict(ctx: EvaluationContext, withTests: boolean) {
  const results = [svc("complexity"), svc("lint-structure"), svc("deps")];
  if (withTests) {
    const prov = { repository: "org/gate", workflowPath: WF, workflowSha: "s", runId: 1, runAttempt: 1, headSha: ctx.prHeadSha ?? ctx.candidate, event: ctx.kind, testMergeSha: ctx.candidate, runConclusion: "success" };
    results.push({ ...svc("tests"), source: "actions", result: { ...result({ gate: "tests" }), measurement_fingerprint: { runner_commit: "w", policy_revision: REV } }, provenance: prov });
  }
  const fixed = results.map((s) => ({ ...s, result: { ...s.result, base_sha: ctx.base, candidate_sha: ctx.candidate } }));
  return aggregateQualityGate({ policy: policy({ coverage: { mode: "observe" } }), expected: { base: ctx.base, candidate: ctx.candidate, policyRevision: REV, runnerCommit: RUNNER }, results: fixed, trustedWorkflows: { workflows: [{ repository: "org/gate", path: WF, shas: ["s"] }] }, review: { headSha: HEAD, comments: [], identity } });
}
interface Hooks { evidence: Set<string>; before?: (ctx: EvaluationContext) => Promise<void>; fail?: boolean }
function evaluator(h: Hooks, calls: EvaluationContext[] = []) {
  return async (ctx: EvaluationContext): Promise<Evaluation> => {
    calls.push(ctx);
    await h.before?.(ctx);
    if (h.fail) throw new Error("mirror exploded");
    if (!h.evidence.has(ctx.candidate)) {
      const v = verdict(ctx, false);
      return { verdict: v, results: [v.review], waiting: { workflows: [WF] }, evidenceWaitMinutes: 45 };
    }
    return { verdict: verdict(ctx, true), results: [] };
  };
}
function deps(client: Fake, evaluate: ServiceDeps["evaluate"], over: Partial<ServiceDeps> = {}): ServiceDeps {
  return { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), waits: new MemoryWaitStore(), sleep: async () => {}, evaluate, ...over };
}

describe("B3: a stale wait never supersedes the current head", () => {
  it("sequential: the old head's late workflow_run is dropped and its wait cleared; H2 keeps waiting", async () => {
    const client = new Fake();
    const calls: EvaluationContext[] = [];
    const d = deps(client, evaluator({ evidence: new Set([C]) }, calls));
    // H1 parks (no evidence yet), then a push to H2.
    const h = { evidence: new Set<string>() };
    d.evaluate = evaluator(h, calls);
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    client.current = HEAD2;
    await dispatchEvent(d, "pull_request", prEvent(HEAD2), "d2");
    expect((await d.waits!.listWaits()).map((w) => w.wait.checkSha)).toEqual([HEAD2]);
    const n = calls.length;
    h.evidence.add(C); // H1's evidence lands late
    expect(await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d3")).toBeNull();
    expect(calls.length).toBe(n); // no evaluation for the old head
    expect(client.qg(HEAD2)!.status).toBe("in_progress");
    expect(client.qg(HEAD2)!.req.title).not.toMatch(/SUPERSEDED/);
    expect((await d.waits!.listWaits()).map((w) => w.wait.checkSha)).toEqual([HEAD2]);
  });

  it("race: H1's workflow_run during H2's in-flight evaluation leaves H2 waiting, not SUPERSEDED", async () => {
    const client = new Fake();
    const calls: EvaluationContext[] = [];
    const h: Hooks = { evidence: new Set() };
    const d = deps(client, evaluator(h, calls));
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    client.current = HEAD2;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    h.before = async (ctx) => { if (ctx.checkSha === HEAD2) { entered(); await gate; } };
    const h2 = dispatchEvent(d, "pull_request", prEvent(HEAD2), "d2");
    await enteredP;
    h.evidence.add(C);
    const old = dispatchEvent(d, "workflow_run", runEvent(HEAD), "d3");
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [h2r, oldr] = await Promise.all([h2, old]);
    expect(oldr).toBeNull();
    expect(h2r?.waiting).toBeTruthy();
    expect(client.qg(HEAD2)).toMatchObject({ status: "in_progress" });
    expect(client.qg(HEAD2)!.req.title).toMatch(/^waiting for test evidence/);
    expect((await d.waits!.listWaits()).map((w) => w.wait.checkSha)).toEqual([HEAD2]);
  });

  it("the journal marks a replaced wait's delivery superseded and a workflow_run delivery done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-b9-"));
    const journal = new JobJournal(join(dir, "jobs"));
    const client = new Fake();
    const h: Hooks = { evidence: new Set() };
    const d = deps(client, evaluator(h), { journal, waits: journal });
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    h.evidence.add(C);
    await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d2"); // resumes → final verdict
    client.current = HEAD2;
    h.evidence.delete(C);
    await dispatchEvent(d, "pull_request", prEvent(HEAD2), "d3"); // parks H2
    client.current = HEAD;
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d4"); // replaces H2's wait (another head)
    const recs = Object.fromEntries(
      readdirSync(join(dir, "jobs", "o", "r")).map((f) => {
        const r = JSON.parse(readFileSync(join(dir, "jobs", "o", "r", f), "utf8")) as { delivery: string; status: string; payload?: unknown };
        return [r.delivery, `${r.status}${r.payload ? "+payload" : ""}`];
      }),
    );
    expect(recs["d2"]).toBe("done");
    expect(recs["d3"]).toBe("superseded");
    expect(Object.values(recs).filter((v) => v.includes("+payload"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resume in flight guard", () => {
  it("a duplicate webhook and a sweep tick during a resume do not evaluate again", async () => {
    const client = new Fake();
    const calls: EvaluationContext[] = [];
    const h: Hooks = { evidence: new Set() };
    const d = deps(client, evaluator(h, calls));
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    h.evidence.add(C);
    client.workflowRuns.push({ id: 1, path: WF, status: "completed", conclusion: "success", headSha: HEAD, event: "pull_request" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.before = async () => gate;
    const n = calls.length;
    const a = dispatchEvent(d, "workflow_run", runEvent(HEAD), "x1");
    await new Promise((r) => setTimeout(r, 10));
    const b = dispatchEvent(d, "workflow_run", runEvent(HEAD), "x2");
    const c = sweepWaiting(d);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b, c]);
    expect(calls.length - n).toBe(1);
    expect(client.qg(HEAD)).toMatchObject({ status: "completed", conclusion: "success" });
    expect(client.runs.filter((r) => r.name === "quality-gate" && r.headSha === HEAD)).toHaveLength(1);
  });
});

describe("B7c: a throwing resume ends the wait", () => {
  it("publishes TOOL_ERROR once and is not re-resumed by later sweeps", async () => {
    const client = new Fake();
    const calls: EvaluationContext[] = [];
    const h: Hooks = { evidence: new Set() };
    const d = deps(client, evaluator(h, calls));
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    h.fail = true;
    client.workflowRuns.push({ id: 1, path: WF, status: "completed", conclusion: "success", headSha: HEAD, event: "pull_request" });
    await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d2");
    expect(client.qg(HEAD)!.req.title).toBe("INCONCLUSIVE: TOOL_ERROR");
    const n = calls.length;
    for (let i = 0; i < 3; i++) expect(await sweepWaiting(d)).toEqual({ expired: 0, resumed: 0 });
    expect(calls.length).toBe(n);
    expect(await d.waits!.listWaits()).toEqual([]);
  });
});

describe("A3: a late workflow_run after expiry re-evaluates once", () => {
  it("expired wait is kept one more period; a matching run resumes it, then it is forgotten", async () => {
    const client = new Fake();
    const h: Hooks = { evidence: new Set() };
    const calls: EvaluationContext[] = [];
    const d = deps(client, evaluator(h, calls));
    await dispatchEvent(d, "pull_request", prEvent(HEAD), "d1");
    const t0 = Date.now();
    expect(await sweepWaiting(d, new Date(t0 + 46 * 60_000))).toEqual({ expired: 1, resumed: 0 });
    expect(client.qg(HEAD)!.req.title).toBe("INCONCLUSIVE: REPORT_MISSING");
    expect((await d.waits!.listWaits())[0]!.wait.expired).toBe(true);
    expect(await sweepWaiting(d, new Date(t0 + 47 * 60_000))).toEqual({ expired: 0, resumed: 0 }); // not re-expired
    h.evidence.add(C);
    const n = calls.length;
    await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d2");
    expect(calls.length).toBe(n + 1);
    expect(client.qg(HEAD)).toMatchObject({ status: "completed", conclusion: "success" });
    expect(await d.waits!.listWaits()).toEqual([]);
    // Without a late run the expired record is dropped after another wait period.
    const d2 = deps(new Fake(), evaluator({ evidence: new Set() }));
    await dispatchEvent(d2, "pull_request", prEvent(HEAD), "d1");
    await sweepWaiting(d2, new Date(t0 + 46 * 60_000));
    await sweepWaiting(d2, new Date(t0 + 95 * 60_000));
    expect(await d2.waits!.listWaits()).toEqual([]);
  });
});

describe("B6: evidence across two trusted workflows", () => {
  it("writeStoredZip round-trips through readZip; the evaluator's merge refuses conflicting entries", () => {
    const merged = new Map([["tests.C.json", Buffer.from("{\"a\":1}")], ["coverage/coverage-final.json", Buffer.from("{}")]]);
    const back = readZip(writeStoredZip(merged));
    expect([...back.keys()].sort()).toEqual(["coverage/coverage-final.json", "tests.C.json"]);
    expect(back.get("tests.C.json")!.toString()).toBe("{\"a\":1}");
    // The handler waits while any trusted workflow is pending, even with one artifact bound.
    expect([WF, WF2].filter((p) => p !== WF)).toEqual([WF2]);
  });
});

describe("signer environment allowlist", () => {
  it("passes only the named variables, never NYORORI_*, GITHUB_TOKEN or *_SECRET", () => {
    const env = signerEnvironment(["AWS_PROFILE", "NYORORI_WEBHOOK_SECRET", "GITHUB_TOKEN", "KMS_SECRET", "MISSING", "bad-name"], {
      PATH: "/bin", AWS_PROFILE: "gate", NYORORI_WEBHOOK_SECRET: "s", GITHUB_TOKEN: "t", KMS_SECRET: "k",
    });
    expect(env).toEqual({ PATH: "/bin", AWS_PROFILE: "gate" });
    const s = createSigner({ kind: "command", command: '["/usr/bin/kms"]', envPassthrough: '["AWS_REGION"]', timeoutMs: "2500" });
    expect(s).toBeInstanceOf(CommandSigner);
    expect(() => createSigner({ kind: "command", command: '["/usr/bin/kms"]', envPassthrough: "AWS_REGION" })).toThrow(/JSON array/);
    expect(() => createSigner({ kind: "command", command: '["/usr/bin/kms"]', timeoutMs: "soon" })).toThrow(/TIMEOUT_MS/);
  });
});
