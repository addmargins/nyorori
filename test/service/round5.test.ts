// Round 5 (deployment-shapes §5): evidence wait instead of REPORT_MISSING on
// the first evaluation after a push, and App-key custody behind a signer.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateQualityGate, type SubmittedResult } from "../../src/aggregate/index.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { evidenceRequired } from "../../src/service/evaluator.js";
import { appJwtSigningInput, GitHubApi } from "../../src/service/github.js";
import { dispatchEvent, EvaluationQueue, replayPendingJobs, sweepWaiting, type Evaluation, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { payloadMatchesEvent } from "../../src/service/http.js";
import { JobJournal, MemoryWaitStore, waitKey } from "../../src/service/journal.js";
import { CommandSigner, createSigner, FileKeySigner, SignerError } from "../../src/service/signer.js";
import { B, C, HEAD, REV, RUNNER, identity, policy, result, violation } from "../platform/helpers.js";

const WF = ".github/workflows/gate-untrusted-tests.yml";
const HEAD2 = "e".repeat(40);
const C2 = "f".repeat(40);
const repo = { owner: { login: "o" }, name: "r" };
const prEvent = (head = HEAD) => ({ action: "synchronize", repository: repo, pull_request: { number: 7, head: { sha: head }, state: "open" } });
const mgEvent = { action: "checks_requested", repository: repo, merge_group: { head_sha: C, base_sha: B } };
const runEvent = (head: string, path = WF, conclusion: string | null = "success") => ({ action: "completed", repository: repo, workflow_run: { head_sha: head, path, conclusion, run_attempt: 1, event: "pull_request" } });

class Fake implements GitHubClient {
  runs: Array<CheckRunRecord & { req: CheckRunRequest }> = [];
  merge: Record<string, string> = { [HEAD]: C, [HEAD2]: C2 };
  parents: Record<string, string[]> = { [C]: [B, HEAD], [C2]: [B, HEAD2] };
  /** Trusted runs the sweeper can discover via the API (race: artifact before webhook). */
  workflowRuns: Array<{ id: number; path: string; status: string; conclusion: string | null; headSha: string; event: string }> = [];
  current = HEAD;
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
  qg(sha = HEAD) { return this.runs.filter((r) => r.name === "quality-gate" && r.headSha === sha).sort((a, b) => b.id - a.id)[0]; }
}

const svc = (gate: SubmittedResult["result"]["gate"], over: Partial<Parameters<typeof result>[0]> = {}): SubmittedResult => ({ source: "service", result: result({ gate, ...over }) });
function verdict(ctx: EvaluationContext, extra: SubmittedResult[] = []) {
  const results = [svc("complexity"), svc("lint-structure"), svc("deps"), ...extra].map((s) => ({ ...s, result: { ...s.result, base_sha: ctx.base, candidate_sha: ctx.candidate } }));
  return aggregateQualityGate({ policy: policy({ coverage: { mode: "observe" } }), expected: { base: ctx.base, candidate: ctx.candidate, policyRevision: REV, runnerCommit: RUNNER }, results, trustedWorkflows: { workflows: [{ repository: "org/gate", path: WF, shas: ["s"] }] }, review: { headSha: HEAD, comments: [], identity } });
}
/** Evaluator stand-in: waits until `evidence` is set, then reports tests (pass or fail). */
function evaluator(state: { evidence: null | "pass" | "fail" }, calls: EvaluationContext[] = []) {
  return async (ctx: EvaluationContext): Promise<Evaluation> => {
    calls.push(ctx);
    if (state.evidence === null) {
      const v = verdict(ctx);
      return { verdict: v, results: [v.review], waiting: { workflows: [WF] }, evidenceWaitMinutes: 90 };
    }
    const tests = state.evidence === "pass" ? svc("tests") : svc("tests", { violations: [violation({ gate: "tests", reason: "TESTS_FAILED", message: "2 tests failed" })] });
    const prov = { repository: "org/gate", workflowPath: WF, workflowSha: "s", runId: 1, runAttempt: 1, headSha: ctx.prHeadSha ?? ctx.candidate, event: ctx.kind, testMergeSha: ctx.candidate, runConclusion: state.evidence === "pass" ? "success" : "failure" };
    const v = verdict(ctx, [{ ...tests, source: "actions", result: { ...tests.result, measurement_fingerprint: { runner_commit: "w", policy_revision: REV } }, provenance: prov }]);
    return { verdict: v, results: [] };
  };
}
function deps(client: Fake, evaluate: ServiceDeps["evaluate"], over: Partial<ServiceDeps> = {}): ServiceDeps {
  return { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), waits: new MemoryWaitStore(), sleep: async () => {}, evaluate, ...over };
}

describe("defect 1: the first evaluation waits for test evidence", () => {
  it("push → no run yet → quality-gate in_progress with G1–G3 published; workflow_run completed → final verdict", async () => {
    const client = new Fake();
    const state = { evidence: null as null | "pass" | "fail" };
    const calls: EvaluationContext[] = [];
    const d = deps(client, evaluator(state, calls));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    const waiting = client.qg()!;
    expect(waiting.status).toBe("in_progress");
    expect(waiting.req.title).toBe(`waiting for test evidence (${WF})`);
    expect(waiting.req.summary).toContain("gate/simplification-review");
    expect(client.runs.some((r) => r.name === "gate/simplification-review" && r.status === "completed")).toBe(true);
    expect((await d.waits!.listWaits()).map((w) => w.wait.checkSha)).toEqual([HEAD]);

    // Another head's run and another workflow are ignored.
    await dispatchEvent(d, "workflow_run", runEvent(HEAD2), "d2");
    await dispatchEvent(d, "workflow_run", runEvent(HEAD, ".github/workflows/lint.yml"), "d3");
    expect(calls).toHaveLength(1);
    expect(client.qg()!.status).toBe("in_progress");

    state.evidence = "pass";
    await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d4");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: "pull_request", prNumber: 7, base: B, candidate: C, waitDeadline: expect.any(String) });
    expect(client.qg()).toMatchObject({ status: "completed", conclusion: "success" });
    expect(await d.waits!.listWaits()).toEqual([]);
  });

  it("a failed run with a report is TESTS_FAILED, not a wait", async () => {
    const client = new Fake();
    const d = deps(client, evaluator({ evidence: "fail" }));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    expect(client.qg()).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(client.qg()!.req.title).toMatch(/^FAIL: 2 tests failed/);
    expect(await d.waits!.listWaits()).toEqual([]);
  });

  it("the deadline turns the wait into INCONCLUSIVE(REPORT_MISSING) with the workflow named", async () => {
    const client = new Fake();
    const d = deps(client, evaluator({ evidence: null }));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    const started = Date.now();
    expect(await sweepWaiting(d, new Date(started + 89 * 60_000))).toEqual({ expired: 0, resumed: 0 });
    expect(client.qg()!.status).toBe("in_progress");
    expect(await sweepWaiting(d, new Date(started + 91 * 60_000))).toEqual({ expired: 1, resumed: 0 });
    expect(client.qg()).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(client.qg()!.req).toMatchObject({ title: "INCONCLUSIVE: REPORT_MISSING", summary: `no evidence from ${WF} within 90 minutes` });
    expect(await d.waits!.listWaits()).toEqual([]);
  });

  it("a resumed wait keeps its original deadline", async () => {
    const client = new Fake();
    const state = { evidence: null as null | "pass" };
    const calls: EvaluationContext[] = [];
    const d = deps(client, evaluator(state, calls));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    const first = (await d.waits!.listWaits())[0]!.wait.deadline;
    await dispatchEvent(d, "workflow_run", runEvent(HEAD), "d2"); // run completed but artifact not yet bound: evaluator still waits
    expect(calls[1]!.waitDeadline).toBe(first);
    expect((await d.waits!.listWaits())[0]!.wait.deadline).toBe(first);
  });

  it("the sweeper resumes a wait whose trusted run completed without a webhook reaching us", async () => {
    const client = new Fake();
    const state = { evidence: null as null | "pass" };
    const d = deps(client, evaluator(state));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    client.workflowRuns.push({ id: 5, path: WF, status: "completed", conclusion: "success", headSha: HEAD, event: "pull_request" });
    state.evidence = "pass";
    expect(await sweepWaiting(d)).toEqual({ expired: 0, resumed: 1 });
    expect(client.qg()).toMatchObject({ status: "completed", conclusion: "success" });
    // An in-progress run or another head's run does not resume anything.
    const client2 = new Fake();
    const d2 = deps(client2, evaluator({ evidence: null }));
    await dispatchEvent(d2, "pull_request", prEvent(), "d1");
    client2.workflowRuns.push({ id: 6, path: WF, status: "in_progress", conclusion: null, headSha: HEAD, event: "pull_request" }, { id: 7, path: WF, status: "completed", conclusion: "success", headSha: HEAD2, event: "pull_request" });
    expect(await sweepWaiting(d2)).toEqual({ expired: 0, resumed: 0 });
  });

  it("a merge-group check stays in_progress so the queue waits; the run head equals C", async () => {
    const client = new Fake();
    const state = { evidence: null as null | "pass" };
    const d = deps(client, evaluator(state));
    await dispatchEvent(d, "merge_group", mgEvent, "d1");
    expect(client.qg(C)!.status).toBe("in_progress");
    state.evidence = "pass";
    await dispatchEvent(d, "workflow_run", { ...runEvent(C), workflow_run: { ...runEvent(C).workflow_run, event: "merge_group" } }, "d2");
    expect(client.qg(C)).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("a push during the wait supersedes it and starts a new wait for the new head", async () => {
    const client = new Fake();
    const d = deps(client, evaluator({ evidence: null }));
    await dispatchEvent(d, "pull_request", prEvent(), "d1");
    client.current = HEAD2;
    await dispatchEvent(d, "pull_request", prEvent(HEAD2), "d2");
    const waits = await d.waits!.listWaits();
    expect(waits.map((w) => w.wait.checkSha)).toEqual([HEAD2]);
    expect(waits[0]!.key).toBe(waitKey({ repository: "o/r", kind: "pull_request", pr: 7, checkSha: HEAD2 }));
    expect(client.qg(HEAD2)!.status).toBe("in_progress");
  });

  it("policies with every Actions gate observe or degraded never wait", () => {
    expect(evidenceRequired(defaultPolicy({ tests: { mode: "observe" }, coverage: { mode: "observe" } }))).toBe(false);
    expect(evidenceRequired(defaultPolicy({ tests: { mode: "degraded" }, coverage: { mode: "observe" } }))).toBe(false);
    expect(evidenceRequired(defaultPolicy())).toBe(true);
    expect(evidenceRequired(defaultPolicy({ tests: { mode: "observe" }, coverage: { mode: "enforce" } }))).toBe(true);
    expect(defaultPolicy().tests.evidence_wait_minutes).toBe(90);
  });

  it("a restart re-arms journaled waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-wait-"));
    const journal = new JobJournal(join(dir, "jobs"));
    const client = new Fake();
    const state = { evidence: null as null | "pass" };
    await dispatchEvent(deps(client, evaluator(state), { journal, waits: journal }), "pull_request", prEvent(), "d1");
    expect((await journal.listWaits()).map((w) => w.wait.workflows)).toEqual([[WF]]);
    // Process restarts; evidence arrived meanwhile.
    const fresh = new Fake();
    fresh.runs = client.runs;
    fresh.workflowRuns.push({ id: 5, path: WF, status: "completed", conclusion: "success", headSha: HEAD, event: "pull_request" });
    state.evidence = "pass";
    const r = await replayPendingJobs(deps(fresh, evaluator(state), { queue: new EvaluationQueue(), journal, waits: journal }), journal);
    expect(r).toMatchObject({ waits: 1 });
    expect(fresh.qg()).toMatchObject({ status: "completed", conclusion: "success" });
    expect(await journal.listWaits()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the webhook accepts only well-formed workflow_run payloads", () => {
    expect(payloadMatchesEvent("workflow_run", runEvent(HEAD))).toBe(true);
    expect(payloadMatchesEvent("workflow_run", { repository: repo, workflow_run: { head_sha: HEAD } })).toBe(false);
    expect(payloadMatchesEvent("pull_request", runEvent(HEAD))).toBe(false);
  });
});

describe("defect 2: App key custody", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const verify = (jwt: string) => {
    const [h, p, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    return v.verify(publicKey, Buffer.from(s!, "base64url"));
  };

  it("FileKeySigner signs a JWT the public key verifies", async () => {
    const input = appJwtSigningInput(42, Date.parse("2026-10-29T00:00:00Z"));
    expect(verify(`${input}.${await new FileKeySigner(PEM).sign(input)}`)).toBe(true);
    expect(() => new FileKeySigner("not a key")).toThrow(SignerError);
  });

  it("CommandSigner gets the signature from an external command and never sees the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-signer-"));
    const keyFile = join(dir, "key.pem");
    writeFileSync(keyFile, PEM, { mode: 0o600 });
    const script = join(dir, "sign.cjs");
    writeFileSync(script, `
      const { createSign } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const input = readFileSync(0, "utf8");
      const s = createSign("RSA-SHA256"); s.update(input);
      process.stdout.write(s.sign(readFileSync(process.argv[2], "utf8")).toString("base64"));
    `);
    chmodSync(script, 0o700);
    const signer = new CommandSigner({ argv: [process.execPath, script, keyFile], kid: "kms-1" });
    const input = appJwtSigningInput(42, Date.now(), signer.kid);
    expect(verify(`${input}.${await signer.sign(input)}`)).toBe(true);
    expect(JSON.parse(Buffer.from(input.split(".")[0]!, "base64url").toString())).toMatchObject({ kid: "kms-1" });

    // The API client works with it end to end; the PEM never enters the GitHubApi.
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(String((init?.headers as Record<string, string>).authorization));
      const path = url.replace("https://api.github.com", "");
      if (path.startsWith("/repos/o/r/installation")) return Response.json({ id: 7 });
      if (path.startsWith("/app/installations/7/access_tokens")) return Response.json({ token: "ghs", expires_at: "2099-01-01T00:00:00Z" });
      return Response.json({ number: 1, head: { sha: "h" }, user: { login: "a" }, state: "open", body: null });
    };
    const api = new GitHubApi({ appId: 42, signer }, fetchImpl);
    await api.getPullRequest({ owner: "o", repo: "r" }, 1);
    expect(verify(calls[0]!.replace(/^Bearer /, ""))).toBe(true);

    // Error paths: non-zero exit, garbage output, timeout.
    writeFileSync(join(dir, "fail.cjs"), "process.exit(3)");
    await expect(new CommandSigner({ argv: [process.execPath, join(dir, "fail.cjs")] }).sign("x")).rejects.toThrow(/signer command failed/);
    writeFileSync(join(dir, "junk.cjs"), 'process.stdout.write("not base64!!")');
    await expect(new CommandSigner({ argv: [process.execPath, join(dir, "junk.cjs")] }).sign("x")).rejects.toThrow(/no base64url signature/);
    writeFileSync(join(dir, "slow.cjs"), "setTimeout(() => {}, 5000)");
    await expect(new CommandSigner({ argv: [process.execPath, join(dir, "slow.cjs")], timeoutMs: 200 }).sign("x")).rejects.toThrow(/timed out/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the factory validates its configuration", () => {
    expect(createSigner({ kind: "file", privateKeyPem: PEM })).toBeInstanceOf(FileKeySigner);
    expect(() => createSigner({ kind: "file" })).toThrow(SignerError);
    expect(createSigner({ kind: "command", command: '["/usr/bin/kms-sign","--key","app"]' })).toBeInstanceOf(CommandSigner);
    expect(() => createSigner({ kind: "command", command: "kms-sign --key app" })).toThrow(/JSON array/);
    expect(() => createSigner({ kind: "command", command: "[]" })).toThrow(SignerError);
    expect(() => new GitHubApi({ appId: 1 })).toThrow(/signer or a private key/);
  });
});
