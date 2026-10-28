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
 * Issue comments carry no head SHA. Every gate command triggers an evaluation
 * right away, so the head seen when a comment is first evaluated is recorded
 * as the head it was posted against (a push racing the comment makes the
 * approval stale, which is the safe direction).
 */
export class CommentHeadStore {
  constructor(private readonly file: string) {}

  async resolve(comments: readonly { id: number | string }[], head: string): Promise<Map<string, string>> {
    let known: Record<string, string> = {};
    try {
      known = JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    let dirty = false;
    for (const c of comments) {
      const id = String(c.id);
      if (known[id] === undefined) {
        known[id] = head;
        dirty = true;
      }
    }
    if (dirty) {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(known));
      await rename(tmp, this.file);
    }
    return new Map(Object.entries(known));
  }
}

function teamsIn(policy: Policy): string[] {
  const r = policy.review;
  return [...new Set([...r.simplification_reviewers, ...r.waiver_approvers, ...r.gate_owners].filter((x) => x.includes("/")))];
}

async function pullRequestContext(cfg: ServiceConfig, ctx: EvaluationContext, store: CommentHeadStore): Promise<{ pr: PullRequestContext; head: string } | undefined> {
  if (ctx.prNumber === undefined) return undefined;
  const pr = await cfg.api.getPullRequest(ctx.repo, ctx.prNumber);
  const head = ctx.prHeadSha ?? pr.headSha;
  const [raw, commits] = await Promise.all([
    cfg.api.listIssueComments(ctx.repo, ctx.prNumber),
    cfg.api.listPullCommits(ctx.repo, ctx.prNumber),
  ]);
  const heads = await store.resolve(raw, head);
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
  // A pull_request run reports the PR head; it tested refs/pull/N/merge, which
  // the handler already verified is exactly C with that head as second parent.
  const prov =
    ctx.kind === "pull_request" && best.prov.event === "pull_request" && best.prov.headSha === prHead
      ? { ...best.prov, headSha: ctx.candidate }
      : best.prov;
  const artifact = (await cfg.api.listRunArtifacts(ctx.repo, best.run.id)).find(
    (a) => a.name === `nyorori-gate-${ctx.candidate}` && !a.expired,
  );
  if (!artifact) return {};
  const files = await cfg.api.downloadArtifact(ctx.repo, artifact.id);
  let rootDir: string | undefined;
  try {
    rootDir = (JSON.parse(text(files, "metadata.json") ?? "{}") as { root_dir?: string }).root_dir;
  } catch {
    rootDir = undefined;
  }
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
