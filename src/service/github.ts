// GitHub REST implementation of the service's client interface, plus the data
// the evaluation needs (comments, commits, teams, workflow artifacts) and a
// local bare mirror for git objects. Only global fetch and node:crypto: the
// App's private key never leaves this process and tokens never reach argv.

import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { ArtifactProvenance } from "../aggregate/index.js";
import type { CommitIdentity } from "../review/independence.js";
import type { IssueComment } from "../waivers/index.js";
import type { CheckRunRecord, CheckRunRequest, GitHubClient, IssueRequest, PullRequestInfo, RepoRef } from "./client.js";
import { FileKeySigner, type AppJwtSigner } from "./signer.js";
import { DEFAULT_ZIP_LIMITS, readZip, ZipError, type ZipLimits } from "./zip.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AppCredentials {
  appId: number;
  /** In-process key (FileKeySigner). Prefer `signer` so the key stays out of this process. */
  privateKeyPem?: string;
  signer?: AppJwtSigner;
  apiBase?: string;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** Unsigned `<header>.<payload>` for an App JWT; iat backdated 60 s for clock skew, exp under GitHub's 10 min cap. */
export function appJwtSigningInput(appId: number, nowMs: number, kid?: string): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  return `${header}.${payload}`;
}

export async function appJwtWith(appId: number, signer: AppJwtSigner, nowMs = Date.now()): Promise<string> {
  const input = appJwtSigningInput(appId, nowMs, signer.kid);
  return `${input}.${await signer.sign(input)}`;
}

/** RS256 App JWT signed in-process (kept for tools and tests that hold the PEM). */
export function appJwt(appId: number, privateKeyPem: string, nowMs = Date.now()): string {
  const input = appJwtSigningInput(appId, nowMs);
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  return `${input}.${b64url(signer.sign(privateKeyPem))}`;
}

/**
 * Installation tokens are narrowed to one repository and to the permissions
 * the service uses: checks (publish), contents (git fetch, commits), pull
 * requests (PR, commits, comments), issues (comments, linked issues, debt
 * issues), actions (runs, artifacts), members (team rosters). Requesting a
 * permission the App was not granted makes GitHub refuse the token, which is
 * the right failure: the service must not run half-authorized.
 */
export function tokenScope(repo: RepoRef): { repositories: string[]; permissions: Record<string, string> } {
  return {
    repositories: [repo.repo],
    permissions: { checks: "write", contents: "read", pull_requests: "read", issues: "write", actions: "read", members: "read" },
  };
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`GitHub API ${status} for ${path}: ${body.slice(0, 300)}`);
  }
}

export interface WorkflowRun {
  id: number;
  runAttempt: number;
  event: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  repository: string;
  path: string;
  /** Required (org ruleset) workflows referenced by the run: `owner/repo/path@sha`. */
  referencedWorkflows: Array<{ path: string; sha: string }>;
  /** ISO time the (latest attempt of the) run started; artifacts must be newer. */
  runStartedAt?: string;
  /** Repository that owns the run's workflow definition (from `workflow_url`); the gate repo for required workflows. */
  workflowRepository?: string;
}

export interface ArtifactRef {
  id: number;
  name: string;
  expired: boolean;
  createdAt?: string;
  /** head_sha of the run that produced it, from the API's `workflow_run` block. */
  workflowRunHeadSha?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const repoKey = (r: RepoRef) => `${r.owner}/${r.repo}`;

export class GitHubApi implements GitHubClient {
  private readonly api: string;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly installations = new Map<string, number>();

  private readonly signer: AppJwtSigner;

  constructor(
    private readonly creds: AppCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.api = (creds.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    if (creds.signer) this.signer = creds.signer;
    else if (creds.privateKeyPem) this.signer = new FileKeySigner(creds.privateKeyPem);
    else throw new Error("GitHubApi needs a signer or a private key");
  }

  private async call(auth: string, method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "nyorori-gate",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  }

  private async json<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) throw new GitHubApiError(res.status, path, await res.text());
    return (await res.json()) as T;
  }

  /** Installation token for the repository, cached until five minutes before expiry. */
  async installationToken(repo: RepoRef): Promise<string> {
    const key = repoKey(repo);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached.token;
    const jwt = `Bearer ${await appJwtWith(this.creds.appId, this.signer, this.now())}`;
    let id = this.installations.get(key);
    if (id === undefined) {
      const path = `/repos/${key}/installation`;
      id = (await this.json<{ id: number }>(await this.call(jwt, "GET", path), path)).id;
      this.installations.set(key, id);
    }
    const path = `/app/installations/${id}/access_tokens`;
    const t = await this.json<{ token: string; expires_at: string }>(await this.call(jwt, "POST", path, tokenScope(repo)), path);
    const entry = { token: t.token, expiresAt: Date.parse(t.expires_at) };
    this.tokens.set(key, entry);
    return entry.token;
  }

  private async req<T>(repo: RepoRef, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.installationToken(repo);
    return this.json<T>(await this.call(`token ${token}`, method, path, body), path);
  }

  /** Follows `per_page=100` pages until a short page; `pick` extracts the list from wrapped responses. */
  private async paginate<T, R = T[]>(repo: RepoRef, path: string, pick?: (r: R) => T[], maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.req<R>(repo, "GET", `${path}${sep}per_page=100&page=${page}`);
      const items = pick ? pick(r) : (r as unknown as T[]);
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new Error(`pagination limit reached for ${path}`);
  }

  // --- GitHubClient --------------------------------------------------------

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo> {
    const pr = await this.req<{
      number: number;
      head: { sha: string };
      user: { login: string };
      state: "open" | "closed";
      body: string | null;
      assignees?: Array<{ login: string }>;
    }>(repo, "GET", `/repos/${repoKey(repo)}/pulls/${number}`);
    return {
      number: pr.number,
      headSha: pr.head.sha,
      author: pr.user.login,
      state: pr.state,
      body: pr.body,
      assignees: (pr.assignees ?? []).map((a) => a.login),
    };
  }

  async getIssueAuthor(repo: RepoRef, number: number): Promise<string | null> {
    const path = `/repos/${repoKey(repo)}/issues/${number}`;
    const token = await this.installationToken(repo);
    const res = await this.call(`token ${token}`, "GET", path);
    if (res.status === 404 || res.status === 410) return null;
    return (await this.json<{ user: { login: string } | null }>(res, path)).user?.login ?? null;
  }

  async resolveRef(repo: RepoRef, ref: string): Promise<string | null> {
    const path = `/repos/${repoKey(repo)}/git/ref/${ref.replace(/^refs\//, "")}`;
    const token = await this.installationToken(repo);
    const res = await this.call(`token ${token}`, "GET", path);
    if (res.status === 404) return null;
    return (await this.json<{ object: { sha: string } }>(res, path)).object.sha;
  }

  async getCommitParents(repo: RepoRef, sha: string): Promise<string[]> {
    const c = await this.req<{ parents: Array<{ sha: string }> }>(repo, "GET", `/repos/${repoKey(repo)}/git/commits/${sha}`);
    return c.parents.map((p) => p.sha);
  }

  async listCheckRuns(repo: RepoRef, sha: string): Promise<CheckRunRecord[]> {
    type Raw = { id: number; name: string; head_sha: string; app: { id: number } | null; status: CheckRunRecord["status"]; conclusion: string | null; external_id?: string | null };
    const runs = await this.paginate<Raw, { check_runs: Raw[] }>(repo, `/repos/${repoKey(repo)}/commits/${sha}/check-runs`, (r) => r.check_runs);
    return runs.map((r) => ({ id: r.id, name: r.name, headSha: r.head_sha, appId: r.app?.id ?? null, status: r.status, conclusion: r.conclusion, externalId: r.external_id ?? null }));
  }

  private checkBody(req: CheckRunRequest): Record<string, unknown> {
    return {
      name: req.name,
      head_sha: req.headSha,
      status: req.status,
      external_id: req.externalId,
      ...(req.conclusion ? { conclusion: req.conclusion } : {}),
      output: { title: req.title, summary: req.summary, ...(req.text ? { text: req.text } : {}) },
    };
  }

  async createCheckRun(repo: RepoRef, req: CheckRunRequest): Promise<number> {
    return (await this.req<{ id: number }>(repo, "POST", `/repos/${repoKey(repo)}/check-runs`, this.checkBody(req))).id;
  }

  async createIssue(repo: RepoRef, issue: IssueRequest): Promise<number> {
    const r = await this.req<{ number: number }>(repo, "POST", `/repos/${repoKey(repo)}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    return r.number;
  }

  async updateCheckRun(repo: RepoRef, id: number, req: CheckRunRequest): Promise<void> {
    await this.req(repo, "PATCH", `/repos/${repoKey(repo)}/check-runs/${id}`, this.checkBody(req));
  }

  // --- evaluation data ------------------------------------------------------

  async listIssueComments(repo: RepoRef, number: number): Promise<IssueComment[]> {
    type Raw = { id: number; body: string | null; created_at: string; updated_at?: string; user: { login: string } | null };
    const raw = await this.paginate<Raw>(repo, `/repos/${repoKey(repo)}/issues/${number}/comments`);
    // updated_at is what exposes an edit: commands from edited comments do not count.
    return raw.map((c) => ({
      id: c.id,
      body: c.body ?? "",
      createdAt: c.created_at,
      updatedAt: c.updated_at ?? c.created_at,
      author: { login: c.user?.login ?? "ghost" },
    }));
  }

  async listPullCommits(repo: RepoRef, number: number): Promise<CommitIdentity[]> {
    type Raw = {
      sha: string;
      author: { login: string } | null;
      committer: { login: string } | null;
      commit: { message: string; author: { email: string } | null; committer: { email: string } | null };
    };
    const raw = await this.paginate<Raw>(repo, `/repos/${repoKey(repo)}/pulls/${number}/commits`);
    return raw.map((c) => ({
      sha: c.sha,
      authorLogin: c.author?.login ?? null,
      authorEmail: c.commit.author?.email ?? null,
      committerLogin: c.committer?.login ?? null,
      committerEmail: c.commit.committer?.email ?? null,
      message: c.commit.message,
    }));
  }

  /** `org/team` roster; the installation needs members:read on the organization. */
  async listTeamMembers(repo: RepoRef, team: string): Promise<string[]> {
    const [org, slug] = team.split("/");
    if (!org || !slug) throw new Error(`team must be "org/slug": ${team}`);
    const raw = await this.paginate<{ login: string }>(repo, `/orgs/${org}/teams/${slug}/members`);
    return raw.map((m) => m.login);
  }

  async listWorkflowRuns(repo: RepoRef, headSha: string): Promise<WorkflowRun[]> {
    type Raw = {
      id: number;
      run_attempt: number;
      event: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      path: string;
      repository: { full_name: string };
      referenced_workflows?: Array<{ path: string; sha: string }>;
      run_started_at?: string;
      workflow_url?: string;
    };
    const raw = await this.paginate<Raw, { workflow_runs: Raw[] }>(
      repo,
      `/repos/${repoKey(repo)}/actions/runs?head_sha=${headSha}`,
      (r) => r.workflow_runs,
      5,
    );
    return raw.map((r) => ({
      id: r.id,
      runAttempt: r.run_attempt,
      event: r.event,
      headSha: r.head_sha,
      status: r.status,
      conclusion: r.conclusion,
      repository: r.repository.full_name,
      path: r.path,
      referencedWorkflows: r.referenced_workflows ?? [],
      ...(r.run_started_at ? { runStartedAt: r.run_started_at } : {}),
      ...(workflowRepositoryOf(r.workflow_url) ? { workflowRepository: workflowRepositoryOf(r.workflow_url) } : {}),
    }));
  }

  async listRunArtifacts(repo: RepoRef, runId: number): Promise<ArtifactRef[]> {
    type Raw = { id: number; name: string; expired: boolean; created_at?: string; workflow_run?: { head_sha?: string } | null };
    const raw = await this.paginate<Raw, { artifacts: Raw[] }>(repo, `/repos/${repoKey(repo)}/actions/runs/${runId}/artifacts`, (r) => r.artifacts);
    return raw.map((a) => ({
      id: a.id,
      name: a.name,
      expired: a.expired,
      ...(a.created_at ? { createdAt: a.created_at } : {}),
      ...(a.workflow_run?.head_sha ? { workflowRunHeadSha: a.workflow_run.head_sha } : {}),
    }));
  }

  /** Open PRs, for mapping merge-group commits back to the PRs they contain. */
  async listOpenPullRequests(repo: RepoRef): Promise<Array<{ number: number; headSha: string; author: string }>> {
    type Raw = { number: number; head: { sha: string }; user: { login: string } | null };
    const raw = await this.paginate<Raw>(repo, `/repos/${repoKey(repo)}/pulls?state=open`, undefined, 10);
    return raw.map((p) => ({ number: p.number, headSha: p.head.sha, author: p.user?.login ?? "ghost" }));
  }

  /**
   * Downloads and unzips an artifact, reading only the entries `want` accepts.
   * The body is streamed under a byte cap so a hostile artifact cannot exhaust
   * memory before the zip limits apply. fetch drops the Authorization header
   * on the cross-origin redirect.
   */
  /** The capped archive bytes, unparsed: the isolated worker inflates them (spec 10.1). */
  async downloadArtifactArchive(repo: RepoRef, artifactId: number, cap = DEFAULT_ZIP_LIMITS.maxArchiveBytes): Promise<Buffer> {
    const token = await this.installationToken(repo);
    const path = `/repos/${repoKey(repo)}/actions/artifacts/${artifactId}/zip`;
    const res = await this.call(`token ${token}`, "GET", path);
    if (!res.ok) throw new GitHubApiError(res.status, path, await res.text());
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new ZipError(`artifact archive exceeds ${cap} bytes`);
    return readCapped(res, cap);
  }

  async downloadArtifact(
    repo: RepoRef,
    artifactId: number,
    want: (name: string) => boolean = () => true,
    limits: Partial<ZipLimits> = {},
  ): Promise<Map<string, Buffer>> {
    const cap = limits.maxArchiveBytes ?? DEFAULT_ZIP_LIMITS.maxArchiveBytes;
    const token = await this.installationToken(repo);
    const path = `/repos/${repoKey(repo)}/actions/artifacts/${artifactId}/zip`;
    const res = await this.call(`token ${token}`, "GET", path);
    if (!res.ok) throw new GitHubApiError(res.status, path, await res.text());
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new ZipError(`artifact archive exceeds ${cap} bytes`);
    return readZip(await readCapped(res, cap), want, limits);
  }
}

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new ZipError(`artifact archive exceeds ${cap} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Provenance from the API's view of a run. Org-required workflows show up in
 * `referenced_workflows` as `owner/repo/path@ref` with their commit; a
 * repository's own workflow is identified by the run's repository and path.
 */
/** `https://api.github.com/repos/{owner}/{repo}/actions/workflows/{id}` → `owner/repo`. */
export function workflowRepositoryOf(workflowUrl: string | undefined): string | undefined {
  const m = /\/repos\/([^/]+\/[^/]+)\/actions\/workflows\//.exec(workflowUrl ?? "");
  return m?.[1];
}

export function provenanceOf(run: WorkflowRun, workflow: { repository: string; path: string }): ArtifactProvenance | null {
  const base = { runId: run.id, runAttempt: run.runAttempt, headSha: run.headSha, event: run.event, runConclusion: run.conclusion ?? "unknown" };
  // The run itself must be the trusted workflow file, not merely reference it.
  if (run.path !== workflow.path) return null;
  // A PR-added workflow at the same path that `uses:` the trusted reusable
  // workflow also lists it in referenced_workflows; what tells them apart is
  // whose workflow definition ran (`workflow_url`). Required workflows run
  // from the gate repo. When the API gives no owner, the candidate-tree check
  // in the evaluator (a PR cannot define the trusted path) is the backstop.
  if (run.workflowRepository !== undefined && run.workflowRepository !== workflow.repository) return null;
  for (const ref of run.referencedWorkflows) {
    const m = /^([^/]+\/[^/]+)\/(.+?)(?:@.*)?$/.exec(ref.path);
    if (m && m[1] === workflow.repository && m[2] === workflow.path) {
      return { ...base, repository: m[1]!, workflowPath: m[2]!, workflowSha: ref.sha };
    }
  }
  if (run.repository === workflow.repository && run.path === workflow.path) {
    return { ...base, repository: run.repository, workflowPath: run.path, workflowSha: run.headSha };
  }
  return null;
}

const execFileP = promisify(execFile);

/**
 * Bare mirror holding B and C. The token travels in an http.extraHeader set
 * through GIT_CONFIG_* environment variables, never on the command line, and
 * the remote URL stored in the mirror carries no credentials.
 */
export async function ensureMirror(repoUrl: string, token: string, dir: string, shas: readonly string[]): Promise<void> {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  if (/@/.test(new URL(repoUrl).host) || new URL(repoUrl).username) throw new Error("repository URL must not carry credentials");
  const exists = await stat(`${dir}/HEAD`).then(() => true, () => false);
  if (!exists) {
    await mkdir(dir, { recursive: true });
    await execFileP("git", ["init", "--bare", "-q", dir], { env });
  }
  const want = shas.filter((s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s));
  if (want.length !== shas.length) throw new Error("ensureMirror only fetches full object ids");
  await execFileP("git", ["-C", dir, "fetch", "-q", "--no-tags", "--no-write-fetch-head", repoUrl, ...want], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}
