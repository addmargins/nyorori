// Wires the GitHub data sources to the gate pipeline for one service event.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withVerdictInconclusive, type ArtifactProvenance } from "../aggregate/index.js";
import { runGatesIsolated } from "../pipeline/isolated.js";
import type { ArtifactZip, Artifacts, PullRequestContext } from "../pipeline/types.js";
import type { Policy } from "../policy/schema.js";
import { inRoster, isAiLoopBot, MAX_ENUMERABLE_COMMITS, type CommitIdentity, type TeamRosters } from "../review/independence.js";
import { collectAgentInvokers, linkedIssueNumbers } from "../review/invokers.js";
import { parseReview, type CarryOverInfo, type ReviewComment } from "../review/simplification.js";
import { screenComments, type IssueComment } from "../waivers/index.js";
import { bindArtifact } from "./evidence.js";
import { ensureMirror, provenanceOf, type GitHubApi, type WorkflowRun } from "./github.js";
import { withFileLock } from "./lock.js";
import type { Evaluation, EvaluationContext } from "./handlers.js";
import type { LedgerStore } from "./ledger.js";
import type { VerdictStore } from "./verdicts.js";

export interface ServiceConfig {
  api: GitHubApi;
  policy: Policy;
  policyRevision: string;
  ccccBinary: string;
  workDir: string;
  runnerCommit: string;
  gitBaseUrl?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Waiver ledger for the quarterly budget; absent means no waivers used this quarter. */
  ledger?: LedgerStore;
  /** Published verdicts per (PR, head), read back when the PR merges. */
  verdicts?: VerdictStore;
}

type Timeline = Array<{ sha: string; observedAt: string }>;

/**
 * Issue comments carry no head SHA, so the service keeps a timeline of the PR
 * heads it has observed. A comment is bound to the latest head observed at
 * least `skewMs` before the comment was created. A head the service has not
 * observed yet can therefore never receive an approval written before it
 * existed: binding errs towards an older head, which only makes an approval
 * stale (re-approve) and never makes it cover unseen code. Approvals also name
 * their head explicitly (`sha=`); this binding is the service's own record.
 */
export class CommentHeadStore {
  constructor(
    private readonly file: string,
    private readonly skewMs = 30_000,
    private readonly log?: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  private async load(): Promise<Record<string, Timeline>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {};
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, Timeline>;
    } catch {
      // fall through
    }
    // Losing the timeline only unbinds old comments (safe direction); keep running.
    this.log?.("comment head store was corrupt; rebuilding", { file: this.file });
    return {};
  }

  /** Records `head` as observed now (if it is new) and returns commentId → bound head ("" when none). */
  async resolve(
    prKey: string,
    comments: readonly { id: number | string; createdAt: string }[],
    head: string,
    now: Date = new Date(),
  ): Promise<Map<string, string>> {
    const timeline = await withFileLock(this.file, async () => {
      const all = await this.load();
      const t = Array.isArray(all[prKey]) ? all[prKey]! : [];
      if (t[t.length - 1]?.sha !== head) {
        t.push({ sha: head, observedAt: now.toISOString() });
        all[prKey] = t;
        const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(all));
        await rename(tmp, this.file);
      }
      return t;
    });
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

const execFileP = promisify(execFile);
const OID = /^[0-9a-f]{40}$/;
const gitEnv = (mirror: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: mirror, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

async function git(mirror: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", mirror, ...args], { env: gitEnv(mirror), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** `git patch-id --stable` of the diff from..to, or null when it cannot be computed. */
async function patchId(mirror: string, from: string, to: string): Promise<string | null> {
  const diff = await git(mirror, ["diff", "--no-ext-diff", "--no-textconv", from, to]);
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", mirror, "patch-id", "--stable"], { env: gitEnv(mirror) });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? (out.split(/\s+/)[0] ?? null) || null : null));
    child.stdin.end(diff);
  });
}

/**
 * Carry-over evidence for approvals given on an older head (spec 7.6): the
 * files changed since that head, and whether the change set is a pure rebase
 * (equal patch-id against the base). Heads that cannot be fetched get no
 * entry, so their approvals stay stale.
 */
async function carryOverFor(
  mirror: string,
  fetchSha: (sha: string) => Promise<boolean>,
  shas: readonly string[],
  target: string,
  base: string,
): Promise<Record<string, CarryOverInfo>> {
  const out: Record<string, CarryOverInfo> = {};
  const targetBase = await git(mirror, ["merge-base", target, base]).then((s) => s.trim(), () => "");
  const targetPatch = targetBase ? await patchId(mirror, targetBase, target).catch(() => null) : null;
  for (const sha of shas) {
    if (sha === target || !(await fetchSha(sha))) continue;
    try {
      const files = (await git(mirror, ["diff", "--no-renames", "--name-only", "-z", sha, target])).split("\0").filter(Boolean);
      const shaBase = (await git(mirror, ["merge-base", sha, base])).trim();
      const p = shaBase ? await patchId(mirror, shaBase, sha) : null;
      out[sha] = { patchIdEqual: p !== null && targetPatch !== null && p === targetPatch, filesChangedSince: files };
    } catch {
      // unreachable or unrelated history: no carry-over
    }
  }
  return out;
}

interface PrData {
  number: number;
  author: string;
  authorIsAiLoop: boolean;
  headSha: string;
  comments: IssueComment[];
  commits: CommitIdentity[];
  /** Humans who invoked the AI-loop bot (empty for human PRs). */
  invokers: string[];
}

async function loadPr(cfg: ServiceConfig, ctx: EvaluationContext, number: number): Promise<PrData> {
  const pr = await cfg.api.getPullRequest(ctx.repo, number);
  const [comments, commits] = await Promise.all([
    cfg.api.listIssueComments(ctx.repo, number),
    cfg.api.listPullCommits(ctx.repo, number),
  ]);
  const authorIsAiLoop = isAiLoopBot(pr.author, cfg.policy);
  let invokers: string[] = [];
  if (authorIsAiLoop) {
    const repository = `${ctx.repo.owner}/${ctx.repo.repo}`;
    const linkedIssueAuthors: string[] = [];
    if (cfg.api.getIssueAuthor) {
      for (const n of linkedIssueNumbers(pr.body, repository)) {
        const a = await cfg.api.getIssueAuthor(ctx.repo, n).catch(() => null);
        if (a) linkedIssueAuthors.push(a);
      }
    }
    invokers = collectAgentInvokers(
      {
        botLogin: pr.author,
        assignees: pr.assignees ?? [],
        body: pr.body,
        comments: comments.map((c) => ({ author: c.author.login, body: c.body })),
        linkedIssueAuthors,
      },
      cfg.policy,
    );
  }
  return { number, author: pr.author, authorIsAiLoop, headSha: pr.headSha, comments, commits, invokers };
}

/**
 * PRs whose heads are merged into the merge-group commit: second parents of the
 * merge commits on the first-parent chain C..B, matched to open PR heads. The
 * group's own PR (from the queue branch name) is always included. Squash or
 * rebase queues leave no merge commits; then only that PR is known.
 */
async function mergeGroupPrs(cfg: ServiceConfig, ctx: EvaluationContext, mirror: string): Promise<number[]> {
  const prs = new Set<number>(ctx.prNumber !== undefined ? [ctx.prNumber] : []);
  try {
    const lines = (await git(mirror, ["rev-list", "--first-parent", "--parents", "--max-count=100", ctx.candidate, `^${ctx.base}`])).split("\n");
    const heads = new Set(lines.flatMap((l) => l.trim().split(/\s+/).slice(2)));
    if (heads.size > 0) {
      for (const p of await cfg.api.listOpenPullRequests(ctx.repo)) if (heads.has(p.headSha)) prs.add(p.number);
    }
  } catch (e) {
    cfg.log?.("merge group PR discovery failed", { error: String(e) });
  }
  return [...prs].sort((a, b) => a - b);
}

interface PrContextResult {
  pr: PullRequestContext;
  head: string;
  ignoredEdited: Array<{ id: string; author: string }>;
}

async function pullRequestContext(
  cfg: ServiceConfig,
  ctx: EvaluationContext,
  store: CommentHeadStore,
  mirror: string,
  fetchSha: (sha: string) => Promise<boolean>,
): Promise<PrContextResult | undefined> {
  if (ctx.prNumber === undefined) return undefined;
  const numbers = ctx.kind === "merge_group" ? await mergeGroupPrs(cfg, ctx, mirror) : [ctx.prNumber];
  const prs = await Promise.all(numbers.map((n) => loadPr(cfg, ctx, n)));
  const main = prs.find((p) => p.number === ctx.prNumber) ?? prs[0]!;
  const head = ctx.prHeadSha ?? main.headSha;

  const comments: ReviewComment[] = [];
  for (const p of prs) {
    const heads = await store.resolve(`${ctx.repo.owner}/${ctx.repo.repo}#${p.number}`, p.comments, p.number === main.number ? head : p.headSha);
    comments.push(...p.comments.map((c) => ({ ...c, headSha: heads.get(String(c.id)) ?? "" })));
  }
  const ignoredEdited = screenComments(comments).ignored;

  const teams: TeamRosters = {};
  for (const t of teamsIn(cfg.policy)) teams[t] = await cfg.api.listTeamMembers(ctx.repo, t);

  // Approvals name the head they reviewed; older heads may carry over (spec 7.6).
  // Only reviewers' comments are considered, so outsiders cannot make the service fetch SHAs.
  const reviewed = new Set<string>();
  for (const c of screenComments(comments).kept) {
    if (!inRoster(c.author.login, cfg.policy.review.simplification_reviewers, teams)) continue;
    const r = parseReview(c.body);
    if (r && !("problem" in r) && OID.test(r.sha) && r.sha !== head) reviewed.add(r.sha);
  }
  // In a merge group the code that merges is C, so carry-over is measured against C.
  const target = ctx.kind === "merge_group" ? ctx.candidate : head;
  const carryOver = reviewed.size
    ? await carryOverFor(mirror, fetchSha, [...reviewed].slice(0, 20), target, ctx.base)
    : {};

  const quarterWaiversUsed = cfg.ledger ? await cfg.ledger.quarterCount(`${ctx.repo.owner}/${ctx.repo.repo}`, new Date()) : 0;
  return {
    head,
    ignoredEdited,
    pr: {
      comments,
      identity: {
        prAuthor: main.author,
        additionalAuthors: prs.filter((p) => p !== main).map((p) => p.author),
        commits: prs.flatMap((p) => p.commits),
        // GitHub lists at most 250 commits per PR; a full page means the rest is unknown.
        commitsTruncated: prs.some((p) => p.commits.length >= MAX_ENUMERABLE_COMMITS),
        agentInvokers: [...new Set(prs.flatMap((p) => p.invokers))],
        authorIsAiLoop: prs.some((p) => p.authorIsAiLoop),
      },
      teams,
      headSha: head,
      carryOver,
      quarterWaiversUsed,
    },
  };
}

/** Entry names the gates read; the worker inflates only these (src/pipeline/artifacts.ts). */
export { ARTIFACT_ENTRIES } from "../pipeline/artifacts.js";

/**
 * The latest attempt of the required workflow for this candidate, with
 * provenance from the API. The run's event must match the evaluation kind;
 * its conclusion travels with the provenance so a failed run never supplies
 * passing evidence. A hostile artifact is reported, never crashes the service.
 */
async function findArtifacts(
  cfg: ServiceConfig,
  ctx: EvaluationContext,
  prHead: string | undefined,
): Promise<{ artifacts: Artifacts; artifactZip?: ArtifactZip; problem?: string }> {
  const lookupSha = ctx.kind === "merge_group" ? ctx.candidate : prHead;
  if (!lookupSha) return { artifacts: {} };
  const runs = await cfg.api.listWorkflowRuns(ctx.repo, lookupSha);
  let best: { run: WorkflowRun; prov: ArtifactProvenance } | undefined;
  for (const run of runs) {
    if (run.status !== "completed" || run.event !== ctx.kind) continue;
    for (const wf of cfg.policy.provenance.trusted_workflows) {
      const prov = provenanceOf(run, wf);
      if (!prov) continue;
      if (!best || run.id > best.run.id || (run.id === best.run.id && run.runAttempt > best.run.runAttempt)) best = { run, prov };
    }
  }
  if (!best) return { artifacts: {} };
  const bound = bindArtifact(best.run, await cfg.api.listRunArtifacts(ctx.repo, best.run.id), lookupSha, ctx.candidate);
  if (bound.problem) {
    cfg.log?.("artifact not bound to its run", { run: best.run.id, problem: bound.problem });
    return { artifacts: {}, problem: `artifact of run ${best.run.id} is not bound to the attempt: ${bound.problem}` };
  }
  const artifact = bound.artifact;
  if (!artifact) return { artifacts: {} };
  // Only the capped bytes are fetched here; the detached worker parses them.
  let archive: Buffer;
  try {
    archive = await cfg.api.downloadArtifactArchive(ctx.repo, artifact.id);
  } catch (e) {
    cfg.log?.("artifact rejected", { artifact: artifact.id, error: String(e) });
    return { artifacts: {}, problem: `artifact ${artifact.id} of run ${best.run.id} was rejected: ${(e as Error).message}` };
  }
  const zipDir = join(cfg.workDir, "artifacts");
  await mkdir(zipDir, { recursive: true });
  const path = join(zipDir, `${randomUUID()}.zip`);
  await writeFile(path, archive);
  return { artifacts: {}, artifactZip: { path, provenance: best.prov } };
}

export function createServiceEvaluator(cfg: ServiceConfig): (ctx: EvaluationContext) => Promise<Evaluation> {
  const store = new CommentHeadStore(join(cfg.workDir, "comment-heads.json"), 30_000, cfg.log);
  return async (ctx) => {
    await mkdir(cfg.workDir, { recursive: true });
    const token = await cfg.api.installationToken(ctx.repo);
    const mirror = join(cfg.workDir, "mirrors", ctx.repo.owner, `${ctx.repo.repo}.git`);
    const url = `${cfg.gitBaseUrl ?? "https://github.com"}/${ctx.repo.owner}/${ctx.repo.repo}.git`;
    await ensureMirror(url, token, mirror, [...new Set([ctx.base, ctx.candidate])]);
    const fetchSha = (sha: string) => ensureMirror(url, token, mirror, [sha]).then(() => true, () => false);
    const prc = await pullRequestContext(cfg, ctx, store, mirror, fetchSha);
    if (prc && prc.head !== ctx.candidate) await fetchSha(prc.head);
    const found = await findArtifacts(cfg, ctx, prc?.head);
    const out = await runGatesIsolated({
      repoDir: mirror,
      base: ctx.base,
      candidate: ctx.candidate,
      policy: cfg.policy,
      policyRevision: cfg.policyRevision,
      ccccBinary: cfg.ccccBinary,
      workDir: join(cfg.workDir, "runs"),
      runnerCommit: cfg.runnerCommit,
      artifacts: found.artifacts,
      ...(found.artifactZip ? { artifactZip: found.artifactZip } : {}),
      official: ctx.kind === "merge_group",
      authority: "github-app",
      ...(prc ? { pr: prc.pr } : {}),
    }).finally(() => (found.artifactZip ? rm(found.artifactZip.path, { force: true }) : undefined));
    let verdict = out.verdict;
    if (found.problem) {
      verdict = { ...withVerdictInconclusive(verdict, { reason: "UNTRUSTED_ARTIFACT", detail: found.problem, authorFixable: false }), authority: out.authority };
    }
    if (prc?.ignoredEdited.length) {
      verdict = { ...verdict, review: { ...verdict.review, observe: { ...verdict.review.observe, ignored_edited_commands: prc.ignoredEdited } } };
    }
    // The verdict is stored only once the handler has published it (a merge
    // must never record waivers from an evaluation nobody saw).
    const onPublished = async () => {
      if (!cfg.verdicts || !prc || ctx.prNumber === undefined) return;
      await cfg.verdicts.save(ctx.repo, {
        repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
        pr: ctx.prNumber,
        headSha: prc.head,
        kind: ctx.kind,
        base: ctx.base,
        candidate: ctx.candidate,
        verdict: { state: verdict.state, mergeAllowed: verdict.mergeAllowed, policy_revision: verdict.policy_revision },
        appliedWaivers: out.appliedWaivers,
        storedAt: new Date().toISOString(),
      });
    };
    cfg.log?.("evaluated", { repo: ctx.repo, kind: ctx.kind, base: ctx.base, candidate: ctx.candidate, state: verdict.state });
    return { verdict, results: out.results.filter((r) => r.gate !== "simplification-review"), onPublished };
  };
}
