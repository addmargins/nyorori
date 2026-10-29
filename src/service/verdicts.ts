// Published verdicts per (repository, PR, head), so the merge event can record
// exactly the waivers the merged verdict applied (spec 11.1) without
// re-running the gates.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QualityGateVerdict } from "../aggregate/index.js";
import type { AppliedWaiver } from "../pipeline/types.js";
import type { RepoRef } from "./client.js";

export interface StoredVerdict {
  repository: string;
  pr: number;
  headSha: string;
  kind: "pull_request" | "merge_group";
  base: string;
  candidate: string;
  verdict: Pick<QualityGateVerdict, "state" | "mergeAllowed" | "policy_revision">;
  appliedWaivers: AppliedWaiver[];
  storedAt: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class VerdictStore {
  constructor(private readonly dir: string) {}

  private path(repo: RepoRef, pr: number, head: string, kind: StoredVerdict["kind"]): string {
    // Every segment comes from webhook payloads: refuse anything that is not a plain name.
    if (!SEGMENT.test(repo.owner) || !SEGMENT.test(repo.repo) || repo.owner.startsWith(".") || repo.repo.startsWith(".")) {
      throw new Error(`unsafe repository name ${repo.owner}/${repo.repo}`);
    }
    if (!Number.isInteger(pr) || pr <= 0) throw new Error(`invalid PR number ${pr}`);
    if (!SHA.test(head)) throw new Error(`invalid head sha ${head}`);
    return join(this.dir, repo.owner, repo.repo, `pr-${pr}`, `${head}.${kind}.json`);
  }

  async save(repo: RepoRef, v: StoredVerdict): Promise<void> {
    const file = this.path(repo, v.pr, v.headSha, v.kind);
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(v));
    await rename(tmp, file);
  }

  /** The official merge-queue verdict when there is one, else the PR pre-check. */
  async load(repo: RepoRef, pr: number, head: string): Promise<StoredVerdict | null> {
    for (const kind of ["merge_group", "pull_request"] as const) {
      try {
        return JSON.parse(await readFile(this.path(repo, pr, head, kind), "utf8")) as StoredVerdict;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return null;
  }
}
