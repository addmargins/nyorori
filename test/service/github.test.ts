import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CommentHeadStore } from "../../src/service/evaluator.js";
import { GitHubApi, appJwt, ensureMirror, provenanceOf, type WorkflowRun } from "../../src/service/github.js";
import { mergeGroupPrNumber } from "../../src/service/handlers.js";
import { readZip } from "../../src/service/zip.js";
import { TestRepo } from "../git/repo.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const REPO = { owner: "o", repo: "r" };

interface Call {
  url: string;
  method: string;
  auth: string;
  body?: unknown;
}

function fakeFetch(routes: Record<string, (c: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    const c: Call = { url, method: init?.method ?? "GET", auth: headers.authorization ?? "", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(c);
    const path = url.replace("https://api.github.com", "");
    const key = Object.keys(routes).find((k) => `${c.method} ${path}`.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]!(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const tokenRoutes = {
  "GET /repos/o/r/installation": () => ({ body: { id: 7 } }),
  "POST /app/installations/7/access_tokens": () => ({ body: { token: "ghs_x", expires_at: "2026-10-28T13:00:00Z" } }),
};

describe("GitHub App client", () => {
  it("signs an RS256 JWT with backdated iat and a 9 minute expiry", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const [h, p, s] = appJwt(42, PEM, now).split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "42" });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });

  it("caches installation tokens and uses them for REST calls", async () => {
    const f = fakeFetch({
      ...tokenRoutes,
      "GET /repos/o/r/pulls/5": () => ({ body: { number: 5, head: { sha: "h" }, user: { login: "alice" }, state: "open" } }),
      "POST /repos/o/r/check-runs": (c) => ({ body: { id: 99, echo: c.body } }),
    });
    const api = new GitHubApi({ appId: 1, privateKeyPem: PEM }, f.impl, () => Date.parse("2026-10-28T12:00:00Z"));
    expect(await api.getPullRequest(REPO, 5)).toEqual({ number: 5, headSha: "h", author: "alice", state: "open" });
    const id = await api.createCheckRun(REPO, { name: "quality-gate", headSha: "h", status: "completed", conclusion: "failure", title: "t", summary: "s", externalId: "e" });
    expect(id).toBe(99);
    expect(f.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(f.calls.find((c) => c.url.endsWith("/installation"))!.auth).toMatch(/^Bearer /);
    expect(f.calls.find((c) => c.url.endsWith("/check-runs"))!.auth).toBe("token ghs_x");
    expect(f.calls.find((c) => c.url.endsWith("/check-runs"))!.body).toMatchObject({ name: "quality-gate", conclusion: "failure", output: { title: "t" } });
  });

  it("resolveRef returns null for a missing test merge and paginates check runs", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: "x", head_sha: "h", app: { id: 1 }, status: "completed", conclusion: "success" }));
    const f = fakeFetch({
      ...tokenRoutes,
      "GET /repos/o/r/git/ref/pull/3/merge": () => ({ status: 404, body: {} }),
      "GET /repos/o/r/commits/h/check-runs?per_page=100&page=1": () => ({ body: { check_runs: page(100) } }),
      "GET /repos/o/r/commits/h/check-runs?per_page=100&page=2": () => ({ body: { check_runs: page(3) } }),
    });
    const api = new GitHubApi({ appId: 1, privateKeyPem: PEM }, f.impl, () => Date.parse("2026-10-28T12:00:00Z"));
    expect(await api.resolveRef(REPO, "refs/pull/3/merge")).toBeNull();
    expect(await api.listCheckRuns(REPO, "h")).toHaveLength(103);
  });
});

describe("artifact provenance", () => {
  const run: WorkflowRun = {
    id: 10, runAttempt: 2, event: "merge_group", headSha: "c", status: "completed", conclusion: "success",
    repository: "o/r", path: ".github/workflows/x.yml",
    referencedWorkflows: [{ path: "org/gate/.github/workflows/gate-untrusted-tests.yml@refs/heads/main", sha: "w".repeat(40) }],
  };
  it("reads org-required workflows from referenced_workflows", () => {
    expect(provenanceOf(run, { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml" })).toEqual({
      repository: "org/gate", workflowPath: ".github/workflows/gate-untrusted-tests.yml", workflowSha: "w".repeat(40),
      runId: 10, runAttempt: 2, headSha: "c", event: "merge_group",
    });
  });
  it("ignores runs of other workflows", () => {
    expect(provenanceOf(run, { repository: "org/gate", path: ".github/workflows/other.yml" })).toBeNull();
  });
});

describe("service helpers", () => {
  it("derives the PR number from a merge-queue branch", () => {
    expect(mergeGroupPrNumber("refs/heads/gh-readonly-queue/main/pr-123-0123abcd")).toBe(123);
    expect(mergeGroupPrNumber("refs/heads/feature")).toBeUndefined();
  });

  it("binds a comment to the head observed before it was written, never to a later one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-store-"));
    const store = new CommentHeadStore(join(dir, "heads.json"), 30_000);
    const t = (m: number) => new Date(Date.UTC(2026, 9, 28, 12, m));
    const c = (id: number, m: number) => ({ id, createdAt: t(m).toISOString() });
    // h1 observed at 12:00; comment 1 at 12:05 saw h1.
    expect(await store.resolve("o/r#1", [c(1, 5)], "h1", t(0))).toEqual(new Map([["1", "h1"]]));
    // h2 pushed and first observed at 12:10, while comment 1 was evaluated late: it stays on h1.
    // Comment 2 written at 12:09 (before h2 was observed) binds to h1, comment 3 at 12:12 to h2.
    const m = await store.resolve("o/r#1", [c(1, 5), c(2, 9), c(3, 12)], "h2", t(10));
    expect(m).toEqual(new Map([["1", "h1"], ["2", "h1"], ["3", "h2"]]));
    // A comment older than any observation is unbound, and other PRs are separate.
    expect(await store.resolve("o/r#2", [c(4, 1)], "x1", t(2))).toEqual(new Map([["4", ""]]));
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads stored and deflated zip entries", () => {
    const entries = [
      { name: "tests.C.json", data: Buffer.from('{"a":1}'), method: 0 },
      { name: "coverage/coverage-final.json", data: Buffer.from("x".repeat(1000)), method: 8 },
    ];
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const comp = e.method === 8 ? deflateRawSync(e.data) : e.data;
      const name = Buffer.from(e.name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt32LE(comp.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(e.method, 10);
      central.writeUInt32LE(comp.length, 20);
      central.writeUInt32LE(e.data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, comp);
      centrals.push(central, name);
      offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const zip = readZip(Buffer.concat([...locals, cd, eocd]));
    expect(zip.get("tests.C.json")!.toString()).toBe('{"a":1}');
    expect(zip.get("coverage/coverage-final.json")!.length).toBe(1000);
  });

  it("mirrors exactly the requested commits without putting the token in argv or the remote config", async () => {
    const src = new TestRepo();
    const sha = src.commit({ "a.txt": "a\n" });
    const dir = mkdtempSync(join(tmpdir(), "nyorori-mirror-"));
    execFileSync("git", ["-C", src.dir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
    await ensureMirror(`file://${src.dir}`, "secret-token", join(dir, "m.git"), [sha]);
    expect(execFileSync("git", ["-C", join(dir, "m.git"), "cat-file", "-t", sha]).toString().trim()).toBe("commit");
    const config = execFileSync("git", ["-C", join(dir, "m.git"), "config", "--list", "--local"]).toString();
    expect(config).not.toContain("secret-token");
    await expect(ensureMirror(`file://${src.dir}`, "t", join(dir, "m.git"), ["main"])).rejects.toThrow(/full object ids/);
    rmSync(dir, { recursive: true, force: true });
    src.dispose();
  });
});
