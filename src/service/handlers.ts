// Gate-service event handlers. They compute B and C per spec 6.2, run the
// injected evaluation and publish the single required check `quality-gate`.
// Any failure publishes a failing check: the required check must never be
// left pending forever or reported as passing by omission.

import type { GateResult } from "../types.js";
import { QUALITY_GATE_CHECK, type QualityGateVerdict } from "../aggregate/types.js";
import { toCheckRun, verdictToCheckRun, type CheckRunOutput } from "../report/checkrun.js";
import { hasGateCommand } from "../waivers/command.js";
import type { CheckRunRecord, GitHubClient, RepoRef } from "./client.js";
import type { JobJournal } from "./journal.js";
import type { MergedPullRequest } from "./merge.js";

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
  /** Webhook delivery that caused this evaluation, for the job journal. */
  deliveryId?: string;
}

export interface Evaluation {
  verdict: QualityGateVerdict;
  results: GateResult[];
  /** Called once the verdict's check run is published (e.g. to store it for the merge event). */
  onPublished?: () => Promise<void>;
}

export interface ServiceDeps {
  client: GitHubClient;
  appId: number;
  evaluate: (ctx: EvaluationContext) => Promise<Evaluation>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Policy revision the evaluation uses; part of the check run's external id. */
  policyRevision?: string;
  /** Per-PR serialization and generations; defaults to one queue per process. */
  queue?: EvaluationQueue;
  /** Called once a PR is merged (pull_request closed + merged), e.g. to record its waivers. */
  onMerged?: (m: MergedPullRequest) => Promise<void>;
  /** Durable job records; replayed on startup by `replayPendingJobs`. */
  journal?: JobJournal;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Evaluations of one PR (or merge-group commit) run one at a time, and each
 * gets a generation when its event arrives. An evaluation publishes only if
 * no newer one has started since, so a slow evaluation built from an older
 * comment snapshot can never overwrite a newer verdict.
 */
export class EvaluationQueue {
  private readonly gens = new Map<string, { gen: number; externalId: string }>();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Last published check outputs per key, so a yielding evaluation can re-assert them. */
  readonly published = new Map<string, { externalId: string; checks: CheckRunOutput[] }>();

  begin(key: string, externalId: string): number {
    const gen = (this.gens.get(key)?.gen ?? 0) + 1;
    this.gens.set(key, { gen, externalId });
    return gen;
  }

  isLatest(key: string, gen: number): boolean {
    return this.gens.get(key)?.gen === gen;
  }

  latestExternalId(key: string): string | undefined {
    return this.gens.get(key)?.externalId;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

const defaultQueue = new EvaluationQueue();

function queueKey(deps: ServiceDeps, ctx: EvaluationContext): string {
  const subject = ctx.kind === "pull_request" && ctx.prNumber !== undefined ? `pr${ctx.prNumber}` : `${ctx.kind}:${ctx.checkSha}`;
  return `${deps.appId}|${ctx.repo.owner}/${ctx.repo.repo}|${subject}`;
}

export const GATE_COMMANDS = ["/gate-waive", "/gate-waive-approve", "/gate-override", "/gate-approve-tests", "/simplification-review"];

/** Checks with our name but created by another app (or a PR workflow) are ignored, never updated or trusted. */
export function ownCheckRuns(runs: readonly CheckRunRecord[], appId: number, name?: string): CheckRunRecord[] {
  return runs.filter((r) => r.appId === appId && (name === undefined || r.name === name));
}

/** One check run per (B, C, P): concurrent evaluations of the same head never write each other's runs. */
export function checkExternalId(ctx: Pick<EvaluationContext, "base" | "candidate">, policyRevision: string | undefined): string {
  return `${ctx.base}:${ctx.candidate}:${policyRevision ?? "-"}`;
}

async function journal(deps: ServiceDeps, ctx: EvaluationContext, status: "running" | "done" | "superseded" | "failed", note?: string): Promise<void> {
  if (!deps.journal || !ctx.deliveryId) return;
  await deps.journal.update(`${ctx.repo.owner}/${ctx.repo.repo}`, ctx.deliveryId, status, note).catch((e) => deps.log?.("journal write failed", { error: String(e) }));
}

async function upsertCheck(deps: ServiceDeps, ctx: EvaluationContext, out: CheckRunOutput, status: "in_progress" | "completed"): Promise<void> {
  const id = checkExternalId(ctx, deps.policyRevision);
  const existing = ownCheckRuns(await deps.client.listCheckRuns(ctx.repo, ctx.checkSha), deps.appId, out.name).filter(
    (r) => r.externalId === id,
  );
  const req = {
    name: out.name,
    headSha: ctx.checkSha,
    status,
    ...(status === "completed" ? { conclusion: out.conclusion } : {}),
    title: out.title,
    summary: out.summary,
    ...(out.text ? { text: out.text } : {}),
    externalId: id,
  };
  const target = existing.sort((a, b) => b.id - a.id)[0];
  if (target) await deps.client.updateCheckRun(ctx.repo, target.id, req);
  else await deps.client.createCheckRun(ctx.repo, req);
}

/**
 * Whether B/C are still what GitHub would evaluate now. A merge group's
 * commits never move; a PR's test merge does when its base or head moves.
 */
async function stillCurrent(deps: ServiceDeps, ctx: EvaluationContext): Promise<boolean> {
  if (ctx.kind !== "pull_request" || ctx.prNumber === undefined) return true;
  const merge = await deps.client.resolveRef(ctx.repo, `refs/pull/${ctx.prNumber}/merge`);
  return merge === ctx.candidate;
}

function failingCheck(title: string, summary: string): CheckRunOutput {
  return { name: QUALITY_GATE_CHECK, conclusion: "failure", title, summary };
}

const SUPERSEDED = (ctx: EvaluationContext) =>
  failingCheck("SUPERSEDED: base or head moved", `B ${ctx.base}\nC ${ctx.candidate} is no longer current; a newer evaluation reports the result.`);

export async function runAndPublish(deps: ServiceDeps, ctx: EvaluationContext): Promise<Evaluation | null> {
  const queue = deps.queue ?? defaultQueue;
  const key = queueKey(deps, ctx);
  const ext = checkExternalId(ctx, deps.policyRevision);
  const gen = queue.begin(key, ext);
  // Pending right away, so the previous verdict is not what the required check shows while queued.
  await upsertCheck(deps, ctx, { name: QUALITY_GATE_CHECK, conclusion: "failure", title: "running", summary: `B ${ctx.base}\nC ${ctx.candidate}` }, "in_progress");
  return queue.run(key, () => evaluateAndPublish(deps, ctx, queue, key, gen, ext));
}

async function evaluateAndPublish(
  deps: ServiceDeps,
  ctx: EvaluationContext,
  queue: EvaluationQueue,
  key: string,
  gen: number,
  ext: string,
): Promise<Evaluation | null> {
  // A newer evaluation owns the check. If it publishes under another external
  // id, close ours. If it shares ours and has already published, our later
  // in_progress upsert may have reopened the run: re-assert what it published,
  // so no run is left pending with nobody left to complete it.
  const yieldToNewer = async () => {
    const latest = queue.latestExternalId(key);
    if (latest !== ext) {
      await upsertCheck(deps, ctx, SUPERSEDED(ctx), "completed");
    } else {
      const last = queue.published.get(key);
      if (last && last.externalId === ext) for (const c of last.checks) await upsertCheck(deps, ctx, c, "completed");
    }
    await journal(deps, ctx, "superseded");
    return null;
  };
  if (!queue.isLatest(key, gen)) return yieldToNewer();
  await journal(deps, ctx, "running");
  let evaluation: Evaluation;
  try {
    evaluation = await deps.evaluate(ctx);
  } catch (e) {
    deps.log?.("evaluation failed", { error: String(e), ...ctx });
    if (!queue.isLatest(key, gen)) return yieldToNewer();
    const out = failingCheck("INCONCLUSIVE: TOOL_ERROR", `gate evaluation failed: ${String(e)}`);
    await upsertCheck(deps, ctx, out, "completed");
    queue.published.set(key, { externalId: ext, checks: [out] });
    await journal(deps, ctx, "failed", String(e));
    return null;
  }
  if (!queue.isLatest(key, gen)) return yieldToNewer();
  if (evaluation.verdict.base_sha !== ctx.base || evaluation.verdict.candidate_sha !== ctx.candidate) {
    const out = failingCheck("INCONCLUSIVE: FINGERPRINT_MISMATCH", "evaluation was computed for a different B/C");
    await upsertCheck(deps, ctx, out, "completed");
    queue.published.set(key, { externalId: ext, checks: [out] });
    await journal(deps, ctx, "failed", "fingerprint mismatch");
    return null;
  }
  if (!(await stillCurrent(deps, ctx))) {
    // The test merge moved; close ours without touching any other run.
    await upsertCheck(deps, ctx, SUPERSEDED(ctx), "completed");
    await journal(deps, ctx, "superseded", "test merge moved");
    return null;
  }
  const checks = [
    ...evaluation.results.map((r) => toCheckRun(r)),
    toCheckRun(evaluation.verdict.review),
    verdictToCheckRun(evaluation.verdict, evaluation.results),
  ];
  for (const c of checks) await upsertCheck(deps, ctx, c, "completed");
  queue.published.set(key, { externalId: ext, checks });
  await evaluation.onPublished?.().catch((e) => deps.log?.("onPublished failed", { error: String(e) }));
  await journal(deps, ctx, "done");
  return evaluation;
}

/** Linear backoff 3 s → 10 s over five tries while GitHub computes the test merge. */
export const TEST_MERGE_BACKOFF_MS: readonly number[] = [3000, 4750, 6500, 8250, 10000];

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PullRequestPayload {
  action: string;
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number; head: { sha: string }; state: string; merged?: boolean; merge_commit_sha?: string | null };
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

/** Pre-check on `refs/pull/N/merge`: C is the test merge, B its first parent (spec 6.2). */
export async function handlePullRequestEvent(deps: ServiceDeps, payload: PullRequestPayload, deliveryId?: string): Promise<Evaluation | null> {
  if (payload.action === "closed" && payload.pull_request.merged === true) {
    await handleMergedPullRequest(deps, payload);
    return null;
  }
  if (!PR_ACTIONS.has(payload.action) || payload.pull_request.state !== "open") return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  return evaluatePullRequest(deps, repo, payload.pull_request.number, payload.pull_request.head.sha, deliveryId);
}

/** Merge-time bookkeeping (waiver ledger, debt issues); evaluates nothing. */
async function handleMergedPullRequest(deps: ServiceDeps, payload: PullRequestPayload): Promise<void> {
  const mergeCommit = payload.pull_request.merge_commit_sha;
  if (!deps.onMerged || !mergeCommit) return;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  await deps.onMerged({ repo, pr: payload.pull_request.number, headSha: payload.pull_request.head.sha, mergeCommit });
}

/**
 * GitHub computes `refs/pull/N/merge` asynchronously and sends no event when
 * it is ready, so a missing or stale test merge is polled with backoff while
 * the check stays in_progress (spec 11.2: one automatic retry for transient
 * causes). Only after the last try does the failing INCONCLUSIVE go out.
 */
export async function evaluatePullRequest(deps: ServiceDeps, repo: RepoRef, prNumber: number, headSha: string, deliveryId?: string): Promise<Evaluation | null> {
  const sleep = deps.sleep ?? realSleep;
  const pending: EvaluationContext = { repo, kind: "pull_request", prNumber, prHeadSha: headSha, base: "", candidate: "", checkSha: headSha, ...(deliveryId ? { deliveryId } : {}) };
  let problem = "";
  for (let attempt = 0; ; attempt++) {
    const merge = await deps.client.resolveRef(repo, `refs/pull/${prNumber}/merge`);
    if (merge) {
      const parents = await deps.client.getCommitParents(repo, merge);
      if (parents.length === 2 && parents[1] === headSha) {
        return runAndPublish(deps, { ...pending, base: parents[0]!, candidate: merge });
      }
      problem = `INCONCLUSIVE: stale test merge|refs/pull/${prNumber}/merge does not contain head ${headSha} yet; the next event re-evaluates.`;
    } else {
      problem = "INCONCLUSIVE: no test merge|refs/pull/N/merge is unavailable (merge conflict or not yet computed). Resolve conflicts with the base branch.";
    }
    const delay = TEST_MERGE_BACKOFF_MS[attempt];
    if (delay === undefined) break;
    if (attempt === 0) {
      await upsertCheck(deps, { ...pending, candidate: merge ?? "" }, { name: QUALITY_GATE_CHECK, conclusion: "failure", title: "waiting for the test merge", summary: `head ${headSha}` }, "in_progress");
    }
    await sleep(delay);
  }
  const [title, summary] = problem.split("|") as [string, string];
  await upsertCheck(deps, pending, failingCheck(title, summary), "completed");
  await journal(deps, pending, "failed", title);
  return null;
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
export async function handleMergeGroupEvent(deps: ServiceDeps, payload: MergeGroupPayload, deliveryId?: string): Promise<Evaluation | null> {
  if (payload.action !== "checks_requested") return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  const prNumber = mergeGroupPrNumber(payload.merge_group.head_ref);
  return runAndPublish(deps, {
    repo,
    kind: "merge_group",
    ...(deliveryId ? { deliveryId } : {}),
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
  comment: { body: string | null; user: { login: string } };
  changes?: { body?: { from?: string } };
}

/**
 * Commands change approval state, so the PR is re-evaluated; the evaluation
 * reads all comments afresh. Edits and deletions count too: removing a command
 * (old body in changes.body.from) must retract what it granted.
 */
export async function handleIssueComment(deps: ServiceDeps, payload: IssueCommentPayload, deliveryId?: string): Promise<Evaluation | null> {
  if (!payload.issue.pull_request) return null;
  const bodies = [payload.comment.body ?? "", payload.changes?.body?.from ?? ""];
  if (!bodies.some((b) => hasGateCommand(b) || GATE_COMMANDS.some((c) => b.includes(c)))) return null;
  const repo = { owner: payload.repository.owner.login, repo: payload.repository.name };
  const pr = await deps.client.getPullRequest(repo, payload.issue.number);
  if (pr.state !== "open") return null;
  return evaluatePullRequest(deps, repo, pr.number, pr.headSha, deliveryId);
}

/** Journals the delivery as queued before dispatching; the handlers move it to running/done. */
export async function dispatchEvent(deps: ServiceDeps, event: string, payload: unknown, deliveryId?: string): Promise<Evaluation | null> {
  const repoOf = (payload as { repository?: { owner?: { login?: string }; name?: string } } | null)?.repository;
  const repository = repoOf?.owner?.login && repoOf.name ? `${repoOf.owner.login}/${repoOf.name}` : undefined;
  if (deps.journal && deliveryId && repository && JOURNALED_EVENTS.has(event)) {
    await deps.journal.enqueue(repository, deliveryId, event, payload, 0).catch((e) => deps.log?.("journal write failed", { error: String(e) }));
  }
  const out = await dispatchInner(deps, event, payload, deliveryId);
  // An event the handlers ignored (closed PR, no command) is done as far as the journal is concerned.
  if (out === null && deps.journal && deliveryId && repository && JOURNALED_EVENTS.has(event)) {
    await deps.journal.update(repository, deliveryId, "done", "no evaluation needed or already reported").catch(() => undefined);
  }
  return out;
}

const JOURNALED_EVENTS = new Set(["pull_request", "merge_group", "issue_comment"]);

async function dispatchInner(deps: ServiceDeps, event: string, payload: unknown, deliveryId?: string): Promise<Evaluation | null> {
  switch (event) {
    case "pull_request":
      return handlePullRequestEvent(deps, payload as PullRequestPayload, deliveryId);
    case "merge_group":
      return handleMergeGroupEvent(deps, payload as MergeGroupPayload, deliveryId);
    case "issue_comment":
      return handleIssueComment(deps, payload as IssueCommentPayload, deliveryId);
    default:
      return null;
  }
}

/**
 * Startup: re-dispatch deliveries that were queued or running when the
 * process last stopped. Each one re-reads everything from GitHub, so a stale
 * job can only end as SUPERSEDED. Runs sequentially, oldest first.
 */
export async function replayPendingJobs(deps: ServiceDeps, journal: JobJournal): Promise<{ replayed: number; dropped: number }> {
  let replayed = 0;
  let dropped = 0;
  for (const job of await journal.pending()) {
    if (!job.replayable || job.payload === undefined) {
      await journal.update(job.repository, job.delivery, "failed", "payload not retained; cannot replay").catch(() => undefined);
      dropped++;
      continue;
    }
    deps.log?.("replaying job", { delivery: job.delivery, event: job.event, repository: job.repository });
    try {
      await dispatchEvent({ ...deps, journal }, job.event, job.payload, job.delivery);
      replayed++;
    } catch (e) {
      deps.log?.("replay failed", { delivery: job.delivery, error: String(e) });
      await journal.update(job.repository, job.delivery, "failed", String(e)).catch(() => undefined);
      dropped++;
    }
  }
  return { replayed, dropped };
}
