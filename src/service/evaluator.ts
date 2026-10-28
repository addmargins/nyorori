// Wires the GitHub data sources to the gate pipeline for one service event.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactProvenance } from "../aggregate/index.js";
import { runGates } from "../pipeline/run.js";
import type { Artifacts, PullRequestContext } from "../pipeline/types.js";
import type { Policy } from "../policy/schema.js";
import type { TeamRosters } from "../review/independence.js";
import type { ReviewComment } from "../review/simplification.js";
import { ensureMirror, provenanceOf, type GitHubApi, type WorkflowRun } from "./github.js";
import type { Evaluation, EvaluationContext } from "./handlers.js";

export interface ServiceConfig {
  api: GitHubApi;
  policy: Policy;
  policyRevision: string;
  ccccBinary: string;
  workDir: string;
  runnerCommit: string;
  gitBaseUrl?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Issue comments carry no head SHA, so the service keeps a timeline of the PR
 * heads it has observed. A comment is bound to the latest head observed at
 * least `skewMs` before the comment was created. A head the service has not
 * observed yet can therefore never receive an approval written before it
 * existed: binding errs towards an older head, which only makes an approval
 * stale (re-approve) and never makes it cover unseen code.
 */
export class CommentHeadStore {
  constructor(
    private readonly file: string,
    private readonly skewMs = 30_000,
  ) {}

  private async load(): Promise<Record<string, Array<{ sha: string; observedAt: string }>>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, Array<{ sha: string; observedAt: string }>>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {};
    }
  }

  /** Records `head` as observed now (if it is new) and returns commentId → bound head ("" when none). */
  async resolve(
    prKey: string,
    comments: readonly { id: number | string; createdAt: string }[],
    head: string,
    now: Date = new Date(),
  ): Promise<Map<string, string>> {
    const all = await this.load();
    const timeline = all[prKey] ?? [];
    if (timeline[timeline.length - 1]?.sha !== head) {
      timeline.push({ sha: head, observedAt: now.toISOString() });
      all[prKey] = timeline;
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all));
      await rename(tmp, this.file);
    }
    const out = new Map<string, string>();
    for (const c of comments) {
      const created = Date.parse(c.createdAt);
      let bound = "";
      for (const h of timeline) if (Date.parse(h.observedAt) + this.skewMs <= created) bound = h.sha;
      out.set(String(c.id), bound);
    }
    return out;
  }
}

/** Roster entries `@org/team`; rosters are keyed `org/team` (see inRoster). */
function teamsIn(policy: Policy): string[] {
  const r = policy.review;
  const all = [...r.simplification_reviewers, ...r.waiver_approvers, ...r.gate_owners];
  return [...new Set(all.filter((x) => x.startsWith("@") && x.includes("/")).map((x) => x.slice(1)))];
}

async function pullRequestContext(cfg: ServiceConfig, ctx: EvaluationContext, store: CommentHeadStore): Promise<{ pr: PullRequestContext; head: string } | undefined> {
  if (ctx.prNumber === undefined) return undefined;
  const pr = await cfg.api.getPullRequest(ctx.repo, ctx.prNumber);
  const head = ctx.prHeadSha ?? pr.headSha;
  const [raw, commits] = await Promise.all([
    cfg.api.listIssueComments(ctx.repo, ctx.prNumber),
    cfg.api.listPullCommits(ctx.repo, ctx.prNumber),
  ]);
  const heads = await store.resolve(`${ctx.repo.owner}/${ctx.repo.repo}#${ctx.prNumber}`, raw, head);
  const comments: ReviewComment[] = raw.map((c) => ({ ...c, headSha: heads.get(String(c.id)) ?? "" }));
  const teams: TeamRosters = {};
  for (const t of teamsIn(cfg.policy)) teams[t] = await cfg.api.listTeamMembers(ctx.repo, t);
  return {
    head,
    pr: { comments, identity: { prAuthor: pr.author, commits, agentInvokers: [] }, teams, headSha: head },
  };
}

const text = (files: Map<string, Buffer>, name: string) => files.get(name)?.toString("utf8");

/** The latest attempt of the required workflow for this candidate, with provenance from the API. */
async function findArtifacts(cfg: ServiceConfig, ctx: EvaluationContext, prHead: string | undefined): Promise<Artifacts> {
  const lookupSha = ctx.kind === "merge_group" ? ctx.candidate : prHead;
  if (!lookupSha) return {};
  const runs = await cfg.api.listWorkflowRuns(ctx.repo, lookupSha);
  let best: { run: WorkflowRun; prov: ArtifactProvenance } | undefined;
  for (const run of runs) {
    if (run.status !== "completed") continue;
    for (const wf of cfg.policy.provenance.trusted_workflows) {
      const prov = provenanceOf(run, wf);
      if (!prov) continue;
      if (!best || run.id > best.run.id || (run.id === best.run.id && run.runAttempt > best.run.runAttempt)) best = { run, prov };
    }
  }
  if (!best) return {};
  const artifact = (await cfg.api.listRunArtifacts(ctx.repo, best.run.id)).find(
    (a) => a.name === `nyorori-gate-${ctx.candidate}` && !a.expired,
  );
  if (!artifact) return {};
  const files = await cfg.api.downloadArtifact(ctx.repo, artifact.id);
  let rootDir: string | undefined;
  let testMerge: string | undefined;
  try {
    const meta = JSON.parse(text(files, "metadata.json") ?? "{}") as { root_dir?: string; candidate_sha?: string };
    rootDir = meta.root_dir;
    testMerge = typeof meta.candidate_sha === "string" ? meta.candidate_sha : undefined;
  } catch {
    rootDir = undefined;
  }
  // A pull_request run reports the PR head as head_sha; the commit it tested
  // (refs/pull/N/merge) is only in its metadata, and must equal C (spec 6.2).
  const prov: ArtifactProvenance =
    best.prov.event === "pull_request" && testMerge ? { ...best.prov, testMergeSha: testMerge } : best.prov;
  const root = rootDir ? { rootDir } : {};
  const out: Artifacts = {};
  const testsC = text(files, "tests.C.json");
  if (testsC !== undefined) {
    const testsB = text(files, "tests.B.json");
    out.tests = { reportC: testsC, ...(testsB !== undefined ? { reportB: testsB } : {}), provenance: prov, ...root };
  }
  const cov = text(files, "coverage/coverage-final.json");
  if (cov !== undefined) out.coverage = { coverageFinal: cov, meta: text(files, "coverage-meta.json") ?? "", provenance: prov, ...root };
  const mut = text(files, "mutation.json");
  if (mut !== undefined) out.mutation = { report: mut, provenance: prov, ...root };
  return out;
}

export function createServiceEvaluator(cfg: ServiceConfig): (ctx: EvaluationContext) => Promise<Evaluation> {
  const store = new CommentHeadStore(join(cfg.workDir, "comment-heads.json"));
  return async (ctx) => {
    await mkdir(cfg.workDir, { recursive: true });
    const token = await cfg.api.installationToken(ctx.repo);
    const mirror = join(cfg.workDir, "mirrors", ctx.repo.owner, `${ctx.repo.repo}.git`);
    const prc = await pullRequestContext(cfg, ctx, store);
    const shas = [...new Set([ctx.base, ctx.candidate, ...(prc ? [prc.head] : [])])];
    await ensureMirror(`${cfg.gitBaseUrl ?? "https://github.com"}/${ctx.repo.owner}/${ctx.repo.repo}.git`, token, mirror, shas);
    const artifacts = await findArtifacts(cfg, ctx, prc?.head);
    const out = await runGates({
      repoDir: mirror,
      base: ctx.base,
      candidate: ctx.candidate,
      policy: cfg.policy,
      policyRevision: cfg.policyRevision,
      ccccBinary: cfg.ccccBinary,
      workDir: join(cfg.workDir, "runs"),
      runnerCommit: cfg.runnerCommit,
      artifacts,
      ...(prc ? { pr: prc.pr } : {}),
    });
    cfg.log?.("evaluated", { repo: ctx.repo, kind: ctx.kind, base: ctx.base, candidate: ctx.candidate, state: out.verdict.state });
    return { verdict: out.verdict, results: out.results.filter((r) => r.gate !== "simplification-review") };
  };
}
