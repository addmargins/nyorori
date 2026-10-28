// Gate-service event handlers. They compute B and C per spec 6.2, run the
// injected evaluation and publish the single required check `quality-gate`.
// Any failure publishes a failing check: the required check must never be
// left pending forever or reported as passing by omission.

import type { GateResult } from "../types.js";
import { QUALITY_GATE_CHECK, type QualityGateVerdict } from "../aggregate/types.js";
import { toCheckRun, verdictToCheckRun, type CheckRunOutput } from "../report/checkrun.js";
import type { CheckRunRecord, GitHubClient, RepoRef } from "./client.js";

export interface EvaluationContext {
  repo: RepoRef;
  kind: "pull_request" | "merge_group";
  prNumber?: number;
  /** PR head SHA that reviews and waivers are bound to (pull_request only). */
  prHeadSha?: string;
  base: string;
  candidate: string;
  /** Commit the check runs are attached to. */
  checkSha: string;
}

export interface Evaluation {
  verdict: QualityGateVerdict;
  results: GateResult[];
}

export interface ServiceDeps {
  client: GitHubClient;
  appId: number;
  evaluate: (ctx: EvaluationContext) => Promise<Evaluation>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const GATE_COMMANDS = ["/gate-waive", "/gate-waive-approve", "/gate-override", "/simplification-review"];

/** Checks with our name but created by another app (or a PR workflow) are ignored, never updated or trusted. */
export function ownCheckRuns(runs: readonly CheckRunRecord[], appId: number, name?: string): CheckRunRecord[] {
  return runs.filter((r) => r.appId === appId && (name === undefined || r.name === name));
}

function externalId(ctx: EvaluationContext): string {
  return `${ctx.kind}:${ctx.base}:${ctx.candidate}`;
}

async function upsertCheck(deps: ServiceDeps, ctx: EvaluationContext, out: CheckRunOutput, status: "in_progress" | "completed"): Promise<void> {
  const existing = ownCheckRuns(await deps.client.listCheckRuns(ctx.repo, ctx.checkSha), deps.appId, out.name);
  const req = {
    name: out.name,
    headSha: ctx.checkSha,
    status,
    ...(status === "completed" ? { conclusion: out.conclusion } : {}),
    title: out.title,
    summary: out.summary,
    ...(out.text ? { text: out.text } : {}),
    externalId: externalId(ctx),
  };
  const target = existing.find((r) => r.status !== "completed") ?? existing[0];
  if (target) await deps.client.updateCheckRun(ctx.repo, target.id, req);
  else await deps.client.createCheckRun(ctx.repo, req);
}

function failingCheck(title: string, summary: string): CheckRunOutput {
  return { name: QUALITY_GATE_CHECK, conclusion: "failure", title, summary };
}

export async function runAndPublish(deps: ServiceDeps, ctx: EvaluationContext): Promise<Evaluation | null> {
  await upsertCheck(deps, ctx, { name: QUALITY_GATE_CHECK, conclusion: "failure", title: "running", summary: `B ${ctx.base}\nC ${ctx.candidate}` }, "in_progress");
  let evaluation: Evaluation;
  try {
    evaluation = await deps.evaluate(ctx);
  } catch (e) {
    deps.log?.("evaluation failed", { error: String(e), ...ctx });
    await upsertCheck(deps, ctx, failingCheck("INCONCLUSIVE: TOOL_ERROR", `gate evaluation failed: ${String(e)}`), "completed");
    return null;
  }
  if (evaluation.verdict.base_sha !== ctx.base || evaluation.verdict.candidate_sha !== ctx.candidate) {
    await upsertCheck(deps, ctx, failingCheck("INCONCLUSIVE: FINGERPRINT_MISMATCH", "evaluation was computed for a different B/C"), "completed");
    return null;
  }
  for (const r of evaluation.results) await upsertCheck(deps, ctx, toCheckRun(r), "completed");
  await upsertCheck(deps, ctx, toCheckRun(evaluation.verdict.review), "completed");
  await upsertCheck(deps, ctx, verdictToCheckRun(evaluation.verdict, evaluation.results), "completed");
  return evaluation;
}

interface PullRequestPayload {
  action: string;
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number; head: { sha: string }; state: string };
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

/** Pre-check on `refs/pull/N/merge`: C is the test merge, B its first parent (spec 6.2). */
export async function handlePullRequestEvent(deps: ServiceDeps, payload: PullRequestPayload): Promise<Evaluation | null> {
  if (!PR_ACTIONS.has(payload.action) || payload.pull_request.state !== "open") return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  return evaluatePullRequest(deps, repo, payload.pull_request.number, payload.pull_request.head.sha);
}

export async function evaluatePullRequest(deps: ServiceDeps, repo: RepoRef, prNumber: number, headSha: string): Promise<Evaluation | null> {
  const merge = await deps.client.resolveRef(repo, `refs/pull/${prNumber}/merge`);
  const pending: EvaluationContext = { repo, kind: "pull_request", prNumber, prHeadSha: headSha, base: "", candidate: merge ?? "", checkSha: headSha };
  if (!merge) {
    await upsertCheck(deps, pending, failingCheck("INCONCLUSIVE: no test merge", "refs/pull/N/merge is unavailable (merge conflict or not yet computed). Resolve conflicts with the base branch."), "completed");
    return null;
  }
  const parents = await deps.client.getCommitParents(repo, merge);
  if (parents.length !== 2 || parents[1] !== headSha) {
    // GitHub recomputes the test merge asynchronously; never judge a stale one.
    await upsertCheck(deps, pending, failingCheck("INCONCLUSIVE: stale test merge", `refs/pull/${prNumber}/merge does not contain head ${headSha} yet; the next event re-evaluates.`), "completed");
    return null;
  }
  return runAndPublish(deps, { ...pending, base: parents[0]!, candidate: merge });
}

interface MergeGroupPayload {
  action: string;
  repository: { owner: { login: string }; name: string };
  merge_group: { head_sha: string; base_sha: string; head_ref?: string };
}

/** Merge-queue branches are named `gh-readonly-queue/<base>/pr-<N>-<sha>`. */
export function mergeGroupPrNumber(headRef: string | undefined): number | undefined {
  const m = /\/pr-(\d+)-[0-9a-f]+$/.exec(headRef ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Official verdict: C is the commit that will be merged, B the queue's base (spec 6.2). */
export async function handleMergeGroupEvent(deps: ServiceDeps, payload: MergeGroupPayload): Promise<Evaluation | null> {
  if (payload.action !== "checks_requested") return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  const prNumber = mergeGroupPrNumber(payload.merge_group.head_ref);
  return runAndPublish(deps, {
    repo,
    kind: "merge_group",
    ...(prNumber !== undefined ? { prNumber } : {}),
    base: payload.merge_group.base_sha,
    candidate: payload.merge_group.head_sha,
    checkSha: payload.merge_group.head_sha,
  });
}

interface IssueCommentPayload {
  action: string;
  repository: { owner: { login: string }; name: string };
  issue: { number: number; pull_request?: unknown };
  comment: { body: string; user: { login: string } };
}

/** Commands change approval state, so the PR is re-evaluated; the evaluation reads all comments afresh. */
export async function handleIssueComment(deps: ServiceDeps, payload: IssueCommentPayload): Promise<Evaluation | null> {
  if (!payload.issue.pull_request) return null;
  const body = payload.comment.body ?? "";
  if (!GATE_COMMANDS.some((c) => body.includes(c))) return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  const pr = await deps.client.getPullRequest(repo, payload.issue.number);
  if (pr.state !== "open") return null;
  return evaluatePullRequest(deps, repo, pr.number, pr.headSha);
}

export async function dispatchEvent(deps: ServiceDeps, event: string, payload: unknown): Promise<Evaluation | null> {
  switch (event) {
    case "pull_request":
      return handlePullRequestEvent(deps, payload as PullRequestPayload);
    case "merge_group":
      return handleMergeGroupEvent(deps, payload as MergeGroupPayload);
    case "issue_comment":
      return handleIssueComment(deps, payload as IssueCommentPayload);
    default:
      return null;
  }
}
