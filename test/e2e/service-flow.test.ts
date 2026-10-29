// The service end to end with a fake GitHub behind the REAL GitHubApi client
// and the REAL pipeline (worker, mirror, artifact zip): a push parks the
// required check as "waiting for test evidence" with G1–G3 already published,
// the trusted workflow's completion resumes it to a final verdict; the
// merge-group variant; and the deadline sweeper.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRunRequest } from "../../src/service/client.js";
import { createServiceEvaluator } from "../../src/service/evaluator.js";
import { GitHubApi } from "../../src/service/github.js";
import { dispatchEvent, sweepWaiting, type ServiceDeps } from "../../src/service/handlers.js";
import { JobJournal } from "../../src/service/journal.js";
import { CCCC, TestRepo, fnWithCogc, testPolicy } from "./helpers.js";
import { buildZip } from "./zip.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP_ID = 77;
const WF = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["b".repeat(40)] };
const T0 = Date.parse("2026-10-29T10:00:00Z");

interface CheckRecord extends CheckRunRequest {
  id: number;
}

/** GitHub as the service sees it: PR metadata, a test-merge ref, check runs, workflow runs and one artifact. */
class FakeGitHub {
  readonly checks: CheckRecord[] = [];
  runs: Array<Record<string, unknown>> = [];
  artifactZip: Buffer | null = null;
  constructor(public pr: { number: number; head: string; mergeRef: string; base: string }) {}

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const p = this.pr;
    if (path === "/repos/org/app/installation") return json({ id: 3 });
    if (path === "/app/installations/3/access_tokens") return json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
    if (path === `/repos/org/app/pulls/${p.number}`) return json({ number: p.number, head: { sha: p.head }, user: { login: "alice" }, state: "open", body: "", assignees: [] });
    if (path === "/repos/org/app/pulls?state=open&per_page=100&page=1") return json([{ number: p.number, head: { sha: p.head }, user: { login: "alice" } }]);
    if (path === `/repos/org/app/git/ref/pull/${p.number}/merge`) return json({ object: { sha: p.mergeRef } });
    if (path === `/repos/org/app/git/commits/${p.mergeRef}`) return json({ parents: [{ sha: p.base }, { sha: p.head }] });
    if (path.startsWith(`/repos/org/app/issues/${p.number}/comments`)) return json([]);
    if (path.startsWith(`/repos/org/app/pulls/${p.number}/commits`)) {
      return json([{ sha: p.head, author: { login: "alice" }, committer: { login: "alice" }, commit: { message: "feat", author: { email: "alice@example.com" }, committer: { email: "alice@example.com" } } }]);
    }
    const checksOf = /^\/repos\/org\/app\/commits\/([0-9a-f]+)\/check-runs/.exec(path);
    if (checksOf) {
      const runs = this.checks.filter((c) => c.headSha === checksOf[1]).map((c) => ({ id: c.id, name: c.name, head_sha: c.headSha, app: { id: APP_ID }, status: c.status, conclusion: c.conclusion ?? null }));
      return json({ check_runs: runs });
    }
    if (method === "POST" && path === "/repos/org/app/check-runs") {
      const rec = this.fromBody(body, this.checks.length + 1);
      this.checks.push(rec);
      return json({ id: rec.id }, 201);
    }
    const patch = /^\/repos\/org\/app\/check-runs\/(\d+)$/.exec(path);
    if (method === "PATCH" && patch) {
      const idx = this.checks.findIndex((c) => c.id === Number(patch[1]));
      this.checks[idx] = this.fromBody(body, Number(patch[1]));
      return json({ id: Number(patch[1]) });
    }
    if (path.startsWith("/repos/org/app/actions/runs?head_sha=")) {
      const sha = new URL(url).searchParams.get("head_sha");
      return json({ workflow_runs: this.runs.filter((r) => r.head_sha === sha) });
    }
    if (path.startsWith("/repos/org/app/actions/runs/1/artifacts")) {
      return json({ artifacts: this.artifactZip ? [{ id: 5, name: `nyorori-gate-${p.mergeRef}`, expired: false, created_at: "2026-10-29T10:05:00Z", workflow_run: { head_sha: this.runs[0]?.head_sha } }] : [] });
    }
    if (path === "/repos/org/app/actions/artifacts/5/zip") return new Response(this.artifactZip ?? "", { status: 200 });
    return new Response(`unexpected ${method} ${path}`, { status: 404 });
  };

  private fromBody(b: Record<string, unknown>, id: number): CheckRecord {
    const out = b.output as { title: string; summary: string; text?: string };
    return {
      id,
      name: b.name as string,
      headSha: b.head_sha as string,
      status: b.status as CheckRunRequest["status"],
      ...(b.conclusion ? { conclusion: b.conclusion as CheckRunRequest["conclusion"] } : {}),
      title: out.title,
      summary: out.summary,
      ...(out.text ? { text: out.text } : {}),
      externalId: b.external_id as string,
    };
  }

  /** The trusted workflow finished for `headSha` (its artifact names the test merge it checked out). */
  completeWorkflow(headSha: string, event: "pull_request" | "merge_group", mergeSha: string): void {
    this.runs = [{
      id: 1, run_attempt: 1, event, head_sha: headSha, status: "completed", conclusion: "success",
      // An org-required workflow run reports the gate repository's workflow path and is defined there.
      path: WF.path, repository: { full_name: "org/app" }, workflow_url: `https://api.github.com/repos/${WF.repository}/actions/workflows/1`,
      referenced_workflows: [{ path: `${WF.repository}/${WF.path}@refs/heads/main`, sha: WF.shas[0]! }],
      run_started_at: "2026-10-29T10:01:00Z",
    }];
    const report = JSON.stringify({
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
      testResults: [{ name: "src/a.test.js", status: "passed", assertionResults: [{ ancestorTitles: [], title: "a", fullName: "a", status: "passed" }] }],
    });
    this.artifactZip = buildZip([
      { name: "tests.C.json", data: Buffer.from(report), deflate: true },
      { name: "metadata.json", data: Buffer.from(JSON.stringify({ candidate_sha: mergeSha })) },
    ]);
  }

  quality(headSha: string): CheckRecord | undefined {
    return [...this.checks].reverse().find((c) => c.name === "quality-gate" && c.headSha === headSha);
  }
}

/** A PR whose head H adds a small file; M is GitHub's test merge (parents base, H). */
function prRepo(): { repo: TestRepo; base: string; head: string; merge: string; head2: string; merge2: string; bare: string; gitBase: string } {
  const repo = new TestRepo();
  const base = repo.commit({ "README.md": "x\n", "src/a.test.js": "import { it, expect } from 'vitest';\nit('a', () => { expect(1).toBe(1); });\n" });
  repo.git("checkout", "-q", "-b", "feature");
  const head = repo.commit({ "src/a.js": fnWithCogc("a", 3) });
  repo.git("checkout", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "-m", "test merge", "feature");
  const merge = repo.git("rev-parse", "HEAD").trim();
  // A later push H2 on the same PR and GitHub's new test merge M2 (parents base, H2).
  repo.git("checkout", "-q", "feature");
  const head2 = repo.commit({ "src/b.js": fnWithCogc("b", 2) });
  repo.git("checkout", "-q", "--detach", base);
  repo.git("merge", "-q", "--no-ff", "-m", "test merge 2", "feature");
  const merge2 = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "main");
  const gitBase = mkdtempSync(join(tmpdir(), "nyorori-remote-"));
  mkdirSync(join(gitBase, "org"));
  const bare = join(gitBase, "org", "app.git");
  execFileSync("git", ["clone", "-q", "--bare", repo.dir, bare]);
  execFileSync("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  return { repo, base, head, merge, head2, merge2, bare, gitBase };
}

describe("service flow: evidence wait → workflow_run → verdict", () => {
  let work: string;
  let fixture: ReturnType<typeof prRepo>;
  let github: FakeGitHub;
  let deps: ServiceDeps & { now: () => Date };
  let clock: number;
  const logs: string[] = [];

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "nyorori-service-"));
    fixture = prRepo();
    github = new FakeGitHub({ number: 7, head: fixture.head, mergeRef: fixture.merge, base: fixture.base });
    const api = new GitHubApi({ appId: APP_ID, privateKeyPem: PEM }, github.fetch);
    const policy = testPolicy({ coverage: { mode: "observe" }, provenance: { trusted_workflows: [WF] } });
    clock = T0;
    const journal = new JobJournal(join(work, "jobs"));
    logs.length = 0;
    const log = (msg: string, extra?: Record<string, unknown>) => logs.push(`${msg} ${JSON.stringify(extra ?? {})}`);
    const evaluate = createServiceEvaluator({
      api, policy, policyRevision: "p1", ccccBinary: CCCC, workDir: work, runnerCommit: "r", gitBaseUrl: `file://${fixture.gitBase}`, log,
    });
    deps = { client: api, appId: APP_ID, evaluate, policyRevision: "p1", journal, now: () => new Date(clock), log };
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixture.gitBase, { recursive: true, force: true });
    fixture.repo.dispose();
  });

  const prEvent = { action: "opened", repository: { owner: { login: "org" }, name: "app" }, pull_request: { number: 7, head: { sha: "" }, state: "open" } };

  it("pull_request: parks with G1–G3 published, resumes on workflow_run, ends PASS", async () => {
    const parked = await dispatchEvent(deps, "pull_request", { ...prEvent, pull_request: { ...prEvent.pull_request, head: { sha: fixture.head } } }, "d1");
    // The evaluation ran (G1–G3 have results) but the verdict is held back.
    expect(parked?.waiting?.workflows).toEqual([WF.path]);
    const waiting = github.quality(fixture.head)!;
    expect(waiting.status).toBe("in_progress");
    expect(waiting.title).toBe(`waiting for test evidence (${WF.path})`);
    for (const g of ["complexity", "lint-structure", "deps"]) expect(waiting.summary).toContain(g);
    expect(github.checks.filter((c) => c.name.startsWith("gate/") && c.status === "completed").map((c) => c.name)).toEqual(
      expect.arrayContaining(["gate/complexity", "gate/lint-structure", "gate/deps"]),
    );
    expect(await deps.journal!.listWaits()).toHaveLength(1);

    github.completeWorkflow(fixture.head, "pull_request", fixture.merge);
    const resumed = await dispatchEvent(
      deps,
      "workflow_run",
      { action: "completed", repository: prEvent.repository, workflow_run: { head_sha: fixture.head, path: WF.path, conclusion: "success", run_attempt: 1, event: "pull_request" } },
      "d2",
    );
    expect(resumed?.verdict.state, JSON.stringify({ inconclusive: resumed?.verdict.inconclusive, logs })).toBe("PASS");
    expect((resumed?.verdict as { authority?: string } | undefined)?.authority).toBe("github-app");
    const final = github.quality(fixture.head)!;
    expect(final.status).toBe("completed");
    expect(final.conclusion).toBe("success");
    expect(await deps.journal!.listWaits()).toHaveLength(0);
  }, 60_000);

  it("merge_group: the official verdict waits the same way and resumes on the group head's run", async () => {
    const group = {
      action: "checks_requested",
      repository: prEvent.repository,
      merge_group: { head_sha: fixture.merge, base_sha: fixture.base, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${fixture.head.slice(0, 8)}` },
    };
    expect((await dispatchEvent(deps, "merge_group", group, "d3"))?.waiting?.workflows).toEqual([WF.path]);
    expect(github.quality(fixture.merge)).toMatchObject({ status: "in_progress", title: `waiting for test evidence (${WF.path})` });

    github.completeWorkflow(fixture.merge, "merge_group", fixture.merge);
    const resumed = await dispatchEvent(
      deps,
      "workflow_run",
      { action: "completed", repository: prEvent.repository, workflow_run: { head_sha: fixture.merge, path: WF.path, conclusion: "success", run_attempt: 1, event: "merge_group" } },
      "d4",
    );
    expect(resumed?.verdict.state, JSON.stringify({ inconclusive: resumed?.verdict.inconclusive, logs })).toBe("PASS");
    expect(github.quality(fixture.merge)).toMatchObject({ status: "completed", conclusion: "success" });
  }, 60_000);

  it("push during the wait: H2 gets its own wait and verdict; H1's late evidence never settles H2", async () => {
    const pr = (head: string) => ({ ...prEvent, action: "synchronize", pull_request: { ...prEvent.pull_request, head: { sha: head } } });
    const workflowRun = (head: string) => ({
      action: "completed",
      repository: prEvent.repository,
      workflow_run: { head_sha: head, path: WF.path, conclusion: "success", run_attempt: 1, event: "pull_request" },
    });
    // H1 parked.
    expect((await dispatchEvent(deps, "pull_request", pr(fixture.head), "r1"))?.waiting?.workflows).toEqual([WF.path]);
    // The author pushes H2: GitHub moves the PR head and recomputes the test merge.
    github.pr = { ...github.pr, head: fixture.head2, mergeRef: fixture.merge2 };
    // H1's evidence lands while H2 is being evaluated (the per-PR queue serializes them).
    github.completeWorkflow(fixture.head, "pull_request", fixture.merge);
    const [h2, h1Late] = await Promise.all([
      dispatchEvent(deps, "pull_request", pr(fixture.head2), "r2"),
      dispatchEvent(deps, "workflow_run", workflowRun(fixture.head), "r3"),
    ]);
    // H2 is parked on its own wait; H1's run can only ever resume H1 (now superseded), never finish H2.
    expect(h2?.waiting?.workflows).toEqual([WF.path]);
    expect(h1Late === null || h1Late.verdict.candidate_sha !== fixture.merge2).toBe(true);
    const waits = await deps.journal!.listWaits();
    expect(waits.map((w) => w.wait.checkSha)).toEqual([fixture.head2]);
    expect(github.quality(fixture.head2)).toMatchObject({ status: "in_progress", title: `waiting for test evidence (${WF.path})` });
    const h2Checks = github.checks.filter((c) => c.name === "quality-gate" && c.headSha === fixture.head2);
    expect(h2Checks.every((c) => c.status === "in_progress" || c.conclusion === "success")).toBe(true);
    // H2's own evidence completes H2.
    github.completeWorkflow(fixture.head2, "pull_request", fixture.merge2);
    const done = await dispatchEvent(deps, "workflow_run", workflowRun(fixture.head2), "r4");
    expect(done?.verdict.state, JSON.stringify({ inconclusive: done?.verdict.inconclusive, logs })).toBe("PASS");
    expect(done?.verdict.candidate_sha).toBe(fixture.merge2);
    expect(github.quality(fixture.head2)).toMatchObject({ status: "completed", conclusion: "success" });
    expect(await deps.journal!.listWaits()).toHaveLength(0);
  }, 90_000);

  it("a wait past its deadline becomes INCONCLUSIVE(REPORT_MISSING), never a pass", async () => {
    await dispatchEvent(deps, "pull_request", { ...prEvent, pull_request: { ...prEvent.pull_request, head: { sha: fixture.head } } }, "d5");
    expect(github.quality(fixture.head)!.status).toBe("in_progress");
    clock = T0 + 46 * 60_000; // policy default: 45 minutes (below the merge queue's 60-minute timeout)
    const swept = await sweepWaiting(deps);
    expect(swept.expired).toBe(1);
    const final = github.quality(fixture.head)!;
    expect(final.status).toBe("completed");
    expect(final.conclusion).toBe("failure");
    expect(final.title).toBe("INCONCLUSIVE: REPORT_MISSING");
  }, 60_000);
});
