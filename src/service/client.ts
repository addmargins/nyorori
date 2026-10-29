// The slice of the GitHub API the gate service needs. Kept abstract so the
// service core runs without network access in tests and so the App's private
// key lives only in whatever implements this interface.

import type { CheckConclusion } from "../report/checkrun.js";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  headSha: string;
  /** App that created the check; null when unknown. */
  appId: number | null;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
  /** external_id the run was created with; the service only updates runs carrying its own (B, C, P) id. */
  externalId?: string | null;
}

export interface CheckRunRequest {
  name: string;
  headSha: string;
  status: "in_progress" | "completed";
  conclusion?: CheckConclusion;
  title: string;
  summary: string;
  text?: string;
  /** Binds the check to the evaluated B/C/P so a stale result is recognisable. */
  externalId: string;
}

export interface PullRequestInfo {
  number: number;
  headSha: string;
  author: string;
  state: "open" | "closed";
  /** For AI-loop PRs: assignees and the body name the human invoker (spec 2.4). */
  assignees?: string[];
  body?: string | null;
}

export interface GitHubClient {
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo>;
  /** Resolves a ref such as refs/pull/12/merge; null when it does not exist (e.g. conflicts). */
  resolveRef(repo: RepoRef, ref: string): Promise<string | null>;
  getCommitParents(repo: RepoRef, sha: string): Promise<string[]>;
  listCheckRuns(repo: RepoRef, sha: string): Promise<CheckRunRecord[]>;
  createCheckRun(repo: RepoRef, req: CheckRunRequest): Promise<number>;
  updateCheckRun(repo: RepoRef, id: number, req: CheckRunRequest): Promise<void>;
  /** Opens an issue (the 90-day complexity-debt issue of a merged waiver); returns its number. */
  createIssue(repo: RepoRef, issue: IssueRequest): Promise<number>;
  /** Author of an issue (for `closes #N` invoker discovery); null when unknown. */
  getIssueAuthor?(repo: RepoRef, number: number): Promise<string | null>;
  /** Workflow runs for a commit; lets the wait sweeper notice evidence that arrived without a webhook. */
  listWorkflowRuns?(repo: RepoRef, headSha: string): Promise<Array<{ id: number; path: string; status: string; conclusion: string | null; headSha: string; event: string }>>;
}

export interface IssueRequest {
  title: string;
  body: string;
  labels: string[];
}
