// Round-3 security review regressions (repros were under /tmp/secreview).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { aggregateQualityGate, type SubmittedResult } from "../../src/aggregate/index.js";
import { renderSummaryMarkdown } from "../../src/report/markdown.js";
import { requiredApprovers, unresolvedIdentities, type PrIdentityContext } from "../../src/review/independence.js";
import { evaluateSimplificationReview, type ReviewComment } from "../../src/review/simplification.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient } from "../../src/service/client.js";
import { CommentHeadStore } from "../../src/service/evaluator.js";
import { GitHubApi } from "../../src/service/github.js";
import { dispatchEvent, EvaluationQueue, runAndPublish, type Evaluation, type EvaluationContext, type ServiceDeps } from "../../src/service/handlers.js";
import { createWebhookHandler, payloadMatchesEvent, signatureFor } from "../../src/service/http.js";
import { FileLedgerStore, quarterStart } from "../../src/service/ledger.js";
import { readZip, ZipError } from "../../src/service/zip.js";
import { findCommands } from "../../src/waivers/command.js";
import { evaluateWaivers, isEdited, parseWaiverRequest } from "../../src/waivers/index.js";
import { applyTestApprovals } from "../../src/waivers/test-approval.js";
import { B, BLOB, C, HEAD, REV, RUNNER, comment, policy, result, violation } from "../platform/helpers.js";

const RUBRIC = "q1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: pass\nS1: named pricing rules";
const S1 = { id: "S1" as const, gate: "complexity" as const, file: "src/a.ts", evidence: "V kept", routing: true };
const clean: PrIdentityContext = { prAuthor: "alice", commits: [{ sha: "1".repeat(40), authorLogin: "alice", authorEmail: "alice@x.io", committerLogin: "alice", committerEmail: "alice@x.io" }], agentInvokers: [] };
const review = (id: number, login: string, sha = HEAD, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id, author: { login }, body: `/simplification-review NO_SIMPLIFICATION_NEEDED sha=${sha}\n${RUBRIC}`,
  createdAt: `2026-10-28T12:0${id}:00Z`, headSha: HEAD, ...extra,
});
const g6 = (comments: ReviewComment[], identity = clean, extra = {}) =>
  evaluateSimplificationReview({ policy: policy(), mode: "enforce", base: B, candidate: C, headSha: HEAD, fingerprint: { runner_commit: RUNNER, policy_revision: REV }, triggers: [S1], comments, identity, ...extra });

describe("#1 edited comments never carry commands", () => {
  it("an approval edited into a comment is ignored with a visible note; ≤2 s jitter is not an edit", () => {
    const edited = review(1, "rev-alice", HEAD, { updatedAt: "2026-10-28T12:30:00Z" });
    const r = g6([edited]);
    expect(r.state).toBe("FAIL");
    expect(JSON.stringify(r.observe.rejected_reviews)).toContain("edited command ignored; post a new comment");
    expect(g6([review(1, "rev-alice", HEAD, { updatedAt: "2026-10-28T12:01:02Z" })]).state).toBe("PASS");
    expect(isEdited({ createdAt: "2026-10-28T12:00:00Z", updatedAt: "bogus" })).toBe(true);
  });

  it("waivers and test approvals ignore edited comments too", () => {
    const UNIT = "src/billing/plan.ts::applyDiscount#function[0]";
    const req = comment(1, "author-erin", `/gate-waive gate=complexity unit="${UNIT}" metric=cogc ceiling=22 reason=r`);
    const id = (parseWaiverRequest(req, policy()) as Array<{ id: string }>)[0]!.id;
    const approve = { ...comment(20, "appr-carol", `/gate-waive-approve ${id} blob=${BLOB}`), updatedAt: "2026-10-29T00:00:00Z" };
    const ctx = { policy: policy(), identity: clean, now: new Date("2026-10-29T01:00:00Z"), candidateBlob: () => BLOB };
    expect(evaluateWaivers([req, approve], ctx).valid).toHaveLength(0);
    const removed = violation({ gate: "tests", reason: "TEST_REMOVED", unit: "t::a", file: "t", metric: undefined, after: undefined });
    const ta: ReviewComment = { id: 3, author: { login: "owner-dave" }, body: `/gate-approve-tests key="TEST_REMOVED:t::a" sha=${HEAD} note=x`, createdAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T13:00:00Z", headSha: HEAD };
    expect(applyTestApprovals([removed], [ta], { policy: policy(), identity: clean, headSha: HEAD }).applied).toHaveLength(0);
  });

  it("the REST client carries updated_at", async () => {
    const fetchImpl = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (path.startsWith("/repos/o/r/installation")) return Response.json({ id: 7 });
      if (path.startsWith("/app/installations/7/access_tokens")) return Response.json({ token: "t", expires_at: "2099-01-01T00:00:00Z" });
      return Response.json([{ id: 1, body: "x", created_at: "2026-10-28T12:00:00Z", updated_at: "2026-10-28T12:10:00Z", user: { login: "bob" } }]);
    };
    const api = new GitHubApi({ appId: 1, privateKeyPem: (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString() }, fetchImpl);
    const [c] = await api.listIssueComments({ owner: "o", repo: "r" }, 1);
    expect(c).toMatchObject({ createdAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T12:10:00Z" });
  });
});

/** Minimal zip writer; `overrides` lets a test lie about sizes/offsets. */
function zip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; size?: number; localAt?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  for (const e of entries) {
    const comp = e.method === 0 ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.method ?? 8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.size ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    offsets.push(offset);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.method ?? 8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.size ?? e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.localAt ?? offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("#2 zip bombs and malformed archives", () => {
  const bomb = Buffer.alloc(64 * 1024 * 1024); // 64 MiB of zeros deflates ~1000x

  it("rejects high-ratio entries, oversize totals and too many entries without inflating them", () => {
    expect(() => readZip(zip([{ name: "tests.C.json", data: bomb }]))).toThrow(ZipError);
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}`, data: Buffer.from("x"), method: 0 as const }));
    expect(() => readZip(zip(many))).toThrow(/entries/);
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `big${i}`, data: Buffer.alloc(1024, i + 1), method: 0 as const }));
    expect(() => readZip(zip(four), () => true, { maxTotalBytes: 3000 })).toThrow(/inflates beyond/);
  });

  it("never inflates entries outside the whitelist", () => {
    const z = zip([{ name: "tests.C.json", data: Buffer.from("{}") }, { name: "junk.bin", data: bomb }]);
    expect([...readZip(z, (n) => n === "tests.C.json").keys()]).toEqual(["tests.C.json"]);
  });

  it("rejects lying sizes, overlapping and out-of-range local headers", () => {
    expect(() => readZip(zip([{ name: "a", data: Buffer.alloc(5000, 7), size: 100 }]))).toThrow(ZipError);
    expect(() => readZip(zip([{ name: "a", data: Buffer.from("hello"), method: 0 }, { name: "b", data: Buffer.from("world"), method: 0, localAt: 0 }]))).toThrow(/overlapping|duplicate|local/);
    expect(() => readZip(zip([{ name: "a", data: Buffer.from("x"), method: 0, localAt: 1_000_000 }]))).toThrow(ZipError);
    expect(() => readZip(Buffer.from("not a zip at all, definitely"))).toThrow(ZipError);
  });

  it("caps the streamed download", async () => {
    const fetchImpl = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (path.startsWith("/repos/o/r/installation")) return Response.json({ id: 7 });
      if (path.startsWith("/app/installations")) return Response.json({ token: "t", expires_at: "2099-01-01T00:00:00Z" });
      return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } }));
    };
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const api = new GitHubApi({ appId: 1, privateKeyPem: pem }, fetchImpl);
    await expect(api.downloadArtifact({ owner: "o", repo: "r" }, 5, () => true, { maxArchiveBytes: 1024 * 1024 })).rejects.toThrow(ZipError);
  });
});

class Fake implements GitHubClient {
  runs: Array<CheckRunRecord & { req: CheckRunRequest }> = [];
  async getPullRequest() { return { number: 7, headSha: HEAD, author: "alice", state: "open" as const }; }
  async resolveRef() { return C; }
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
const all = (): SubmittedResult[] => (["complexity", "lint-structure", "deps"] as const).map((g) => ({ source: "service" as const, result: result({ gate: g }) }));
function verdict(pass: boolean): Evaluation {
  const p = policy({ tests: { mode: "observe" } });
  const results = pass ? all() : all().map((s) => (s.result.gate === "complexity" ? { ...s, result: result({ violations: [violation()] }) } : s));
  return { results: [], verdict: aggregateQualityGate({ policy: p, expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER }, results, trustedWorkflows: { workflows: [] }, review: { headSha: HEAD, comments: [], identity: clean } }) };
}
const ctx: EvaluationContext = { repo: { owner: "o", repo: "r" }, kind: "pull_request", prNumber: 7, prHeadSha: HEAD, base: B, candidate: C, checkSha: HEAD };

describe("#5/#6 service races", () => {
  it("an older evaluation finishing last never overwrites a newer verdict (same B/C/P)", async () => {
    const client = new Fake();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let n = 0;
    const deps: ServiceDeps = { client, appId: 1, policyRevision: REV, queue: new EvaluationQueue(), evaluate: async () => {
      if (++n === 1) { await slow; return verdict(true); } // snapshot taken while an approval existed
      return verdict(false);
    } };
    const first = runAndPublish(deps, ctx);
    await new Promise((r) => setTimeout(r, 5));
    const second = runAndPublish(deps, ctx);
    release();
    await Promise.all([first, second]);
    const qg = client.runs.filter((r) => r.name === "quality-gate");
    expect(qg).toHaveLength(1);
    expect(qg[0]!.conclusion).toBe("failure");
    expect(n).toBe(2); // both evaluated; the stale one saw a newer generation and published nothing
  });

  it("an edit or deletion that removes a command re-evaluates", async () => {
    let evaluated = 0;
    const deps: ServiceDeps = { client: new Fake(), appId: 1, queue: new EvaluationQueue(), evaluate: async () => (evaluated++, verdict(false)) };
    const base = { repository: { owner: { login: "o" }, name: "r" }, issue: { number: 7, pull_request: {} } };
    await dispatchEvent(deps, "issue_comment", { ...base, action: "edited", comment: { body: "retracted", user: { login: "bob" } }, changes: { body: { from: `/simplification-review NO_SIMPLIFICATION_NEEDED sha=${HEAD}` } } });
    await dispatchEvent(deps, "issue_comment", { ...base, action: "deleted", comment: { body: `/gate-waive-approve W1 blob=${BLOB}`, user: { login: "bob" } } });
    await dispatchEvent(deps, "issue_comment", { ...base, action: "edited", comment: { body: "typo fix", user: { login: "bob" } }, changes: { body: { from: "tpyo fix" } } });
    expect(evaluated).toBe(2);
  });
});

describe("#7 independence when identities are unresolved", () => {
  const coauthored: PrIdentityContext = {
    ...clean,
    commits: [{ ...clean.commits[0]!, message: "x\n\nCo-authored-by: Bob <bob@corp.example>" }, { sha: "2".repeat(40), authorLogin: null, authorEmail: "ghost@corp.example", committerLogin: "web-flow", committerEmail: "noreply@github.com" }],
  };
  it("unmapped co-author or commit emails require two independent approvers", () => {
    expect(unresolvedIdentities(coauthored)).toEqual(["bob@corp.example", "ghost@corp.example"]);
    expect(requiredApprovers(coauthored)).toBe(2);
    const one = g6([review(1, "rev-alice")], coauthored);
    expect(one.state).toBe("FAIL");
    expect(one.violations[0]!.message).toMatch(/second independent approver/);
    expect(g6([review(1, "rev-alice"), review(2, "rev-bob")], coauthored).state).toBe("PASS");
  });
  it("a PR at GitHub's 250-commit listing cap rejects every approval", () => {
    const many = { ...clean, commits: Array.from({ length: 250 }, (_, i) => ({ ...clean.commits[0]!, sha: String(i).padStart(40, "0") })) };
    expect(JSON.stringify(g6([review(1, "rev-alice")], many).observe.rejected_reviews)).toMatch(/independence unknown/);
    expect(g6([review(1, "rev-alice")], { ...clean, commitsTruncated: true }).state).toBe("FAIL");
  });
  it("authors of other PRs in the merge group cannot approve", () => {
    expect(g6([review(1, "rev-alice")], { ...clean, additionalAuthors: ["rev-alice"] }).state).toBe("FAIL");
  });
});

describe("#8 approvals bind to an explicit sha=", () => {
  it("an approval naming another head does not count unless it carries over", () => {
    const old = "0".repeat(40);
    expect(g6([review(1, "rev-alice", old)]).state).toBe("FAIL");
    expect(g6([review(1, "rev-alice", old)], clean, { carryOver: { [old]: { patchIdEqual: false, filesChangedSince: ["README.md"] } } }).state).toBe("PASS");
    const noSha = { ...review(1, "rev-alice"), body: `/simplification-review NO_SIMPLIFICATION_NEEDED\n${RUBRIC}` };
    expect(JSON.stringify(g6([noSha]).observe.rejected_reviews)).toMatch(/missing sha=/);
  });
  it("the summary prints ready-to-paste review and test-approval commands with the head sha", () => {
    const p = policy();
    const v = aggregateQualityGate({
      policy: p,
      expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER },
      results: [...all().map((s) => (s.result.gate === "complexity" ? { ...s, result: result({ triggers: [S1] }) } : s))],
      trustedWorkflows: { workflows: [] },
      review: { headSha: HEAD, comments: [], identity: clean },
    });
    const md = renderSummaryMarkdown([], v);
    expect(md).toContain(`/simplification-review NO_SIMPLIFICATION_NEEDED sha=${HEAD}`);
    expect(md).toContain("S1: <one-line disposition>");
  });
});

describe("#11 webhook replay", () => {
  it("dedupes on the signed body and checks the event/payload shape", async () => {
    const seen: string[] = [];
    const h = createWebhookHandler({ secret: "s", dispatch: async (e, _p, d) => void seen.push(`${e}/${d}`) });
    const srv = createServer((q, s) => void h(q, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const body = JSON.stringify({ action: "synchronize", pull_request: { number: 1 }, repository: { name: "r" } });
    const send = (delivery: string, event: string) =>
      fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers: { "x-hub-signature-256": signatureFor("s", body), "x-github-event": event, "x-github-delivery": delivery } }).then((r) => r.status);
    try {
      expect(await send("d1", "pull_request")).toBe(202);
      expect(await send("d2-replayed", "pull_request")).toBe(200);
      expect(await send("d3", "merge_group")).toBe(400);
      expect(await send("d4", "ping")).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(["pull_request/d1"]);
    } finally {
      srv.close();
    }
    expect(payloadMatchesEvent("issue_comment", { comment: {}, issue: {}, repository: {} })).toBe(true);
    expect(payloadMatchesEvent("ping", { zen: "x" })).toBe(true);
  });
});

describe("defence in depth", () => {
  it.each([
    ["plain", "/simplification-review X", true],
    ["quote", "> /simplification-review X", false],
    ["lazy quote continuation", "> I agree\n/simplification-review X", false],
    ["``` fence", "```\n/simplification-review X\n```", false],
    ["fence with info string", "```text\n/simplification-review X\n```", false],
    ["4-backtick fence around ```", "````\n```\n/simplification-review X\n```\n````", false],
    ["~~~ fence", "~~~md\n/simplification-review X\n~~~", false],
    ["indented code", "text\n\n    /simplification-review X", false],
    ["HTML comment", "LGTM\n<!--\n/simplification-review X\n-->", false],
    ["unterminated HTML comment", "LGTM <!-- \n/simplification-review X", false],
    ["after a closed fence", "```\ncode\n```\n/simplification-review X", true],
    ["<details>", "<details>\n\n/simplification-review X\n</details>", true],
  ])("%s → counted=%s", (_l, body, counted) => {
    expect(findCommands(body, "simplification-review").length > 0).toBe(counted);
  });

  it("ledger counts this quarter's waivers per repository; garbage counts as used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-ledger-"));
    const file = join(dir, "waivers.jsonl");
    const store = new FileLedgerStore(file);
    const now = new Date("2026-11-15T00:00:00Z");
    expect(quarterStart(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(await store.quarterCount("o/r", now)).toBe(0);
    await store.append(JSON.stringify({ repository: "o/r", recorded_at: "2026-10-02T00:00:00Z" }));
    await store.append(JSON.stringify({ repository: "o/r", recorded_at: "2026-09-30T00:00:00Z" }));
    await store.append(JSON.stringify({ repository: "o/other", recorded_at: "2026-10-03T00:00:00Z" }));
    await store.append("{not json");
    expect(await store.quarterCount("o/r", now)).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a failed run's artifacts can prove a failure but never a pass", () => {
    const wf = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["9".repeat(40)] };
    const prov = { repository: wf.repository, workflowPath: wf.path, workflowSha: wf.shas[0]!, runId: 1, runAttempt: 1, headSha: C, event: "merge_group", runConclusion: "failure" };
    const run = (r: ReturnType<typeof result>) =>
      aggregateQualityGate({ policy: policy(), expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER }, results: [...all(), { source: "actions", result: r, provenance: prov }], trustedWorkflows: { workflows: [wf] }, review: { headSha: HEAD, comments: [], identity: clean } });
    const pass = run(result({ gate: "tests", fingerprint: { runner_commit: "w", policy_revision: REV } }));
    expect(pass.reasons).toContain("UNTRUSTED_ARTIFACT");
    const fail = run(result({ gate: "tests", fingerprint: { runner_commit: "w", policy_revision: REV }, violations: [violation({ gate: "tests", reason: "TESTS_FAILED" })] }));
    expect(fail.reasons).toContain("TESTS_FAILED");
    expect(fail.reasons).not.toContain("UNTRUSTED_ARTIFACT");
  });

  it("the comment head store survives a corrupt file and concurrent writers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-heads-"));
    const file = join(dir, "heads.json");
    writeFileSync(file, "{corrupt");
    const logs: string[] = [];
    const store = new CommentHeadStore(file, 0, (m) => logs.push(m));
    const t0 = new Date("2026-10-28T12:00:00Z");
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.resolve(`o/r#${i}`, [], `h${i}`, t0)));
    expect(logs).toContain("comment head store was corrupt; rebuilding");
    const m = await store.resolve("o/r#7", [{ id: 1, createdAt: "2026-10-28T12:05:00Z" }], "h7", t0);
    expect(m.get("1")).toBe("h7");
    const other = await store.resolve("o/r#19", [{ id: 2, createdAt: "2026-10-28T12:05:00Z" }], "h19", t0);
    expect(other.get("2")).toBe("h19"); // no writer lost another PR's timeline
    rmSync(dir, { recursive: true, force: true });
  });
});
