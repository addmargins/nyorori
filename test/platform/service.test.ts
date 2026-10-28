import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { aggregateQualityGate } from "../../src/aggregate/index.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { dispatchEvent, ownCheckRuns, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { createWebhookHandler, signatureFor, verifySignature } from "../../src/service/http.js";
import { B, C, HEAD, REV, RUNNER, identity, policy } from "./helpers.js";

const APP = 42;
const repoPayload = { owner: { login: "org" }, name: "app" };

class FakeClient implements GitHubClient {
  runs: Array<CheckRunRecord & { req?: CheckRunRequest }> = [];
  updates: Array<{ id: number; req: CheckRunRequest }> = [];
  nextId = 100;
  constructor(public refs: Record<string, string | null>, public parents: Record<string, string[]>) {}
  async getPullRequest() {
    return { number: 7, headSha: HEAD, author: "author-erin", state: "open" as const };
  }
  async resolveRef(_r: unknown, ref: string) {
    return this.refs[ref] ?? null;
  }
  async getCommitParents(_r: unknown, sha: string) {
    return this.parents[sha] ?? [];
  }
  async listCheckRuns(_r: unknown, sha: string) {
    return this.runs.filter((r) => r.headSha === sha);
  }
  async createCheckRun(_r: unknown, req: CheckRunRequest) {
    const id = this.nextId++;
    this.runs.push({ id, name: req.name, headSha: req.headSha, appId: APP, status: req.status, conclusion: req.conclusion ?? null, req });
    return id;
  }
  async updateCheckRun(_r: unknown, id: number, req: CheckRunRequest) {
    this.updates.push({ id, req });
    const run = this.runs.find((r) => r.id === id)!;
    Object.assign(run, { status: req.status, conclusion: req.conclusion ?? null, req });
  }
  final(name: string, sha = HEAD) {
    return this.runs.find((r) => r.name === name && r.headSha === sha && r.appId === APP)?.req;
  }
}

function verdictFor(ctx: EvaluationContext) {
  return {
    verdict: aggregateQualityGate({
      policy: policy(),
      expected: { base: ctx.base, candidate: ctx.candidate, policyRevision: REV, runnerCommit: RUNNER },
      results: [],
      trustedWorkflows: { workflows: [] },
      review: { headSha: HEAD, comments: [], identity },
    }),
    results: [],
  };
}

function deps(client: GitHubClient, evaluate: ServiceDeps["evaluate"] = async (ctx) => verdictFor(ctx)): ServiceDeps & { calls: EvaluationContext[] } {
  const calls: EvaluationContext[] = [];
  return { client, appId: APP, calls, evaluate: async (ctx) => (calls.push(ctx), evaluate(ctx)) };
}

const prEvent = { action: "synchronize", repository: repoPayload, pull_request: { number: 7, head: { sha: HEAD }, state: "open" } };

describe("pull_request pre-check", () => {
  it("uses refs/pull/N/merge as C and its first parent as B", async () => {
    const client = new FakeClient({ "refs/pull/7/merge": C }, { [C]: [B, HEAD] });
    const d = deps(client);
    await dispatchEvent(d, "pull_request", prEvent);
    expect(d.calls[0]).toMatchObject({ base: B, candidate: C, checkSha: HEAD, kind: "pull_request", prNumber: 7 });
    // Missing gates → INCONCLUSIVE → failure, never pending or neutral.
    expect(client.final("quality-gate")).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("does not judge a stale test merge or a missing one", async () => {
    const stale = new FakeClient({ "refs/pull/7/merge": C }, { [C]: [B, "0".repeat(40)] });
    const d1 = deps(stale);
    await dispatchEvent(d1, "pull_request", prEvent);
    expect(d1.calls).toHaveLength(0);
    expect(stale.final("quality-gate")).toMatchObject({ conclusion: "failure", title: "INCONCLUSIVE: stale test merge" });

    const conflict = new FakeClient({}, {});
    await dispatchEvent(deps(conflict), "pull_request", prEvent);
    expect(conflict.final("quality-gate")?.conclusion).toBe("failure");
  });

  it("publishes failure when evaluation throws", async () => {
    const client = new FakeClient({ "refs/pull/7/merge": C }, { [C]: [B, HEAD] });
    await dispatchEvent(deps(client, async () => { throw new Error("boom"); }), "pull_request", prEvent);
    expect(client.final("quality-gate")).toMatchObject({ conclusion: "failure", title: "INCONCLUSIVE: TOOL_ERROR" });
  });

  it("ignores a same-name check posted by a PR workflow and creates its own", async () => {
    const client = new FakeClient({ "refs/pull/7/merge": C }, { [C]: [B, HEAD] });
    client.runs.push({ id: 1, name: "quality-gate", headSha: HEAD, appId: 15368 /* github-actions */, status: "completed", conclusion: "success" });
    await dispatchEvent(deps(client), "pull_request", prEvent);
    expect(client.updates.some((u) => u.id === 1)).toBe(false);
    expect(ownCheckRuns(client.runs, APP, "quality-gate")).toHaveLength(1);
    expect(client.final("quality-gate")?.conclusion).toBe("failure");
  });
});

describe("merge_group official verdict", () => {
  it("uses base_sha and head_sha of the group", async () => {
    const client = new FakeClient({}, {});
    const d = deps(client);
    await dispatchEvent(d, "merge_group", { action: "checks_requested", repository: repoPayload, merge_group: { head_sha: C, base_sha: B } });
    expect(d.calls[0]).toMatchObject({ kind: "merge_group", base: B, candidate: C, checkSha: C });
    expect(client.final("quality-gate", C)?.status).toBe("completed");
  });

  it("refuses an evaluation computed for another B/C", async () => {
    const client = new FakeClient({}, {});
    const d = deps(client, async (ctx) => verdictFor({ ...ctx, candidate: "x".repeat(40) }));
    await dispatchEvent(d, "merge_group", { action: "checks_requested", repository: repoPayload, merge_group: { head_sha: C, base_sha: B } });
    expect(client.final("quality-gate", C)?.title).toBe("INCONCLUSIVE: FINGERPRINT_MISMATCH");
  });
});

describe("issue comments", () => {
  it("re-evaluates the PR only for gate commands on PRs", async () => {
    const client = new FakeClient({ "refs/pull/7/merge": C }, { [C]: [B, HEAD] });
    const d = deps(client);
    const ev = (body: string, pr = true) => ({ action: "created", repository: repoPayload, issue: { number: 7, ...(pr ? { pull_request: {} } : {}) }, comment: { body, user: { login: "x" } } });
    await dispatchEvent(d, "issue_comment", ev("nice"));
    await dispatchEvent(d, "issue_comment", ev("/gate-waive-approve W1 blob=x", false));
    expect(d.calls).toHaveLength(0);
    await dispatchEvent(d, "issue_comment", ev("/simplification-review NO_SIMPLIFICATION_NEEDED"));
    expect(d.calls).toHaveLength(1);
  });
});

describe("webhook signature", () => {
  it("verifies HMAC-SHA256 and rejects tampering", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature("s3cret", body, signatureFor("s3cret", body))).toBe(true);
    expect(verifySignature("s3cret", Buffer.from('{"a":2}'), signatureFor("s3cret", body))).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
    expect(verifySignature("s3cret", body, "sha256=00")).toBe(false);
    expect(verifySignature("", body, signatureFor("", body))).toBe(false);
  });

  it("serves 401 on bad signatures, dispatches once per delivery", async () => {
    const seen: string[] = [];
    const handler = createWebhookHandler({ secret: "k", dispatch: async (e) => void seen.push(e) });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({ zen: "x" });
    const post = (sig: string, delivery: string) =>
      fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": "ping", "x-github-delivery": delivery } });
    try {
      expect((await post("sha256=bad", "d1")).status).toBe(401);
      expect((await post(signatureFor("k", body), "d1")).status).toBe(202);
      expect((await post(signatureFor("k", body), "d1")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(["ping"]);
    } finally {
      server.close();
    }
  });
});
