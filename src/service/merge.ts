// After a PR merges: append its applied waivers to the ledger and open the
// 90-day complexity-debt issues (spec 11.1). Idempotent per waiver id, so a
// redelivered `closed` event records nothing twice.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Policy } from "../policy/schema.js";
import { debtIssue, ledgerLine, type LedgerEntry } from "../waivers/index.js";
import type { GitHubClient, RepoRef } from "./client.js";
import type { LedgerStore } from "./ledger.js";
import type { VerdictStore } from "./verdicts.js";

/** Waiver ids whose debt issue was opened, persisted so a retry opens no duplicate. */
export class IssuedDebtStore {
  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, number>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  async add(key: string, issue: number): Promise<void> {
    const all = await this.load();
    all[key] = issue;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all));
    await rename(tmp, this.file);
  }
}

export interface MergeRecorderDeps {
  client: GitHubClient;
  ledger: LedgerStore;
  verdicts: VerdictStore;
  issued: IssuedDebtStore;
  policy: Policy;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface MergedPullRequest {
  repo: RepoRef;
  pr: number;
  headSha: string;
  mergeCommit: string;
}

export interface MergeRecord {
  appended: string[];
  issues: number[];
  skipped?: string;
}

export async function recordMergedPullRequest(deps: MergeRecorderDeps, m: MergedPullRequest): Promise<MergeRecord> {
  const repository = `${m.repo.owner}/${m.repo.repo}`;
  const out: MergeRecord = { appended: [], issues: [] };
  const stored = await deps.verdicts.load(m.repo, m.pr, m.headSha);
  if (!stored) {
    out.skipped = "no published verdict for the merged head";
    deps.log?.("merge without a stored verdict", { repository, pr: m.pr, head: m.headSha });
    return out;
  }
  if (!stored.verdict.mergeAllowed) {
    // Merged past a failing verdict (ruleset bypass): the waivers did not carry it; record nothing.
    out.skipped = `stored verdict is ${stored.verdict.state}`;
    deps.log?.("merged with a blocking verdict", { repository, pr: m.pr, state: stored.verdict.state });
    return out;
  }
  const recorded = await deps.ledger.recordedWaiverIds(repository);
  const issued = await deps.issued.load();
  const recordedAt = (deps.now?.() ?? new Date()).toISOString();
  for (const { waiver, value } of stored.appliedWaivers) {
    const line = ledgerLine(waiver, { repository, pr: m.pr, mergeCommit: m.mergeCommit, value, recordedAt });
    if (!recorded.has(waiver.id)) {
      await deps.ledger.append(line);
      recorded.add(waiver.id);
      out.appended.push(waiver.id);
    }
    const key = `${repository}#${waiver.id}`;
    if (issued[key] === undefined) {
      const issue = debtIssue(JSON.parse(line) as LedgerEntry, deps.policy.waivers.max_days);
      const number = await deps.client.createIssue(m.repo, { title: issue.title, body: issue.body, labels: issue.labels });
      await deps.issued.add(key, number);
      out.issues.push(number);
    }
  }
  return out;
}
