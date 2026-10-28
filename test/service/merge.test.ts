// Merge-time bookkeeping: the merged verdict's waivers reach the ledger and
// open one debt issue each, exactly once across webhook redeliveries.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPolicy } from "../../src/policy/schema.js";
import type { GitHubClient, IssueRequest } from "../../src/service/client.js";
import { dispatchEvent, type ServiceDeps } from "../../src/service/handlers.js";
import { FileLedgerStore } from "../../src/service/ledger.js";
import { IssuedDebtStore, recordMergedPullRequest } from "../../src/service/merge.js";
import { VerdictStore, type StoredVerdict } from "../../src/service/verdicts.js";
import type { ValidWaiver } from "../../src/waivers/index.js";

const REPO = { owner: "org", repo: "app" };
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const waiver: ValidWaiver = {
  id: "W0123456789",
  commentId: "1",
  requester: "alice",
  gate: "complexity",
  unit: "src/a.ts::run#function[0]",
  file: "src/a.ts",
  metric: "cognitive",
  ceiling: 18,
  reason: "explicit state table",
  requestedAt: "2026-10-28T10:00:00Z",
  approver: "wendy",
  approvedAt: "2026-10-28T11:00:00Z",
  expiresAt: "2027-01-26T11:00:00Z",
  blob: "c".repeat(40),
};

function stored(over: Partial<StoredVerdict> = {}): StoredVerdict {
  return {
    repository: "org/app",
    pr: 7,
    headSha: HEAD,
    kind: "merge_group",
    base: "d".repeat(40),
    candidate: "e".repeat(40),
    verdict: { state: "ACCEPTED_WITH_WAIVER", mergeAllowed: true, policy_revision: "p" },
    appliedWaivers: [{ waiver, value: 18 }],
    storedAt: "2026-10-28T12:00:00Z",
    ...over,
  };
}

const issues: IssueRequest[] = [];
const client = { createIssue: async (_r: unknown, i: IssueRequest) => (issues.push(i), 40 + issues.length) } as unknown as GitHubClient;

describe("merge-time waiver ledger", () => {
  let dir: string;
  let deps: Parameters<typeof recordMergedPullRequest>[0];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nyorori-merge-"));
    issues.length = 0;
    deps = {
      client,
      ledger: new FileLedgerStore(join(dir, "waivers.jsonl")),
      verdicts: new VerdictStore(join(dir, "verdicts")),
      issued: new IssuedDebtStore(join(dir, "debt-issues.json")),
      policy: defaultPolicy(),
      now: () => new Date("2026-10-29T00:00:00Z"),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const merged = (action = "closed", isMerged = true) => ({
    action,
    repository: { owner: { login: "org" }, name: "app" },
    pull_request: { number: 7, head: { sha: HEAD }, state: "closed", merged: isMerged, merge_commit_sha: MERGE },
  });
  const service = (): ServiceDeps => ({
    client,
    appId: 1,
    evaluate: async () => {
      throw new Error("a merge must not re-evaluate");
    },
    onMerged: async (m) => {
      await recordMergedPullRequest(deps, m);
    },
  });

  it("appends each applied waiver once and opens one 90-day debt issue, across redeliveries", async () => {
    await deps.verdicts.save(REPO, stored());
    expect(await dispatchEvent(service(), "pull_request", merged())).toBeNull();
    await dispatchEvent(service(), "pull_request", merged());
    const lines = readFileSync(join(dir, "waivers.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ waiver_id: waiver.id, repository: "org/app", pr: 7, merge_commit: MERGE, value: 18, approver: "wendy" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toEqual(["complexity-debt"]);
    expect(issues[0]!.body).toContain("due: 2027-01-27");
    expect(await deps.ledger.quarterCount("org/app", new Date("2026-11-01T00:00:00Z"))).toBe(1);
  });

  it("prefers the merge-queue verdict over the PR pre-check", async () => {
    await deps.verdicts.save(REPO, stored({ kind: "pull_request", appliedWaivers: [] }));
    await deps.verdicts.save(REPO, stored());
    expect((await recordMergedPullRequest(deps, { repo: REPO, pr: 7, headSha: HEAD, mergeCommit: MERGE })).appended).toEqual([waiver.id]);
  });

  it("records nothing for a blocking verdict, a missing verdict, or a closed-unmerged PR", async () => {
    expect((await recordMergedPullRequest(deps, { repo: REPO, pr: 7, headSha: HEAD, mergeCommit: MERGE })).skipped).toMatch(/no published verdict/);
    await deps.verdicts.save(REPO, stored({ verdict: { state: "FAIL", mergeAllowed: false, policy_revision: "p" } }));
    expect((await recordMergedPullRequest(deps, { repo: REPO, pr: 7, headSha: HEAD, mergeCommit: MERGE })).appended).toEqual([]);
    await deps.verdicts.save(REPO, stored());
    await dispatchEvent(service(), "pull_request", merged("closed", false));
    expect(issues).toEqual([]);
  });

  it("refuses path-like names from payloads", async () => {
    await expect(deps.verdicts.save({ owner: "..", repo: "x" }, stored())).rejects.toThrow(/unsafe/);
    await expect(deps.verdicts.load(REPO, 7, "../../etc")).rejects.toThrow(/invalid head/);
  });
});
