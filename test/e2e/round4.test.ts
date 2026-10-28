// Round-4 rows: differential-test findings (docs/review/branch-comparison.md),
// measured .d.ts files, the pending-waiver flow, authority markers and the
// "gate inputs outside the repository" rule.

import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/review/simplification.js";
import { TestRepo, fnWithCogc, gate, run, servicePolicy } from "./helpers.js";

const identity = { prAuthor: "alice", commits: [{ sha: "x", authorLogin: "alice", committerLogin: "alice" }], agentInvokers: [] };
const comment = (id: number, login: string, body: string, headSha: string): ReviewComment => ({
  id,
  author: { login },
  body,
  createdAt: `2026-10-28T12:${String(id).padStart(2, "0")}:00Z`,
  headSha,
});
const routed = (out: Awaited<ReturnType<typeof run>>) => [...new Set(out.verdict.triggers.map((t) => t.id))].sort();

describe("differential findings", () => {
  it("a test→product move with identical bytes gets no allowance: FAIL plus S11", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "test/helpers.test.js": fnWithCogc("helper", 20) });
    const c = repo.commit({ "test/helpers.test.js": null, "src/helper.js": fnWithCogc("helper", 20) });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").violations.map((v) => v.reason)).toContain("OVER_LIMIT_NEW");
    expect(routed(out)).toContain("S11");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });

  it("a new anonymous unit at 18 beside a legacy anonymous 18 does not inherit its allowance", async () => {
    const anon = (name: string, n: number) =>
      `export const ${name} = function (x, y) {\n${Array.from({ length: n }, (_, i) => `  if (x === ${i}) y += ${i};`).join("\n")}\n  return y;\n};\n`;
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": anon("legacy", 18) });
    const c = repo.commit({ "src/a.js": `${anon("legacy", 18)}${anon("added", 18)}` });
    const out = await run(repo, b, c, servicePolicy());
    const reasons = gate(out, "complexity").violations.map((v) => v.reason);
    expect(reasons).toHaveLength(1);
    expect(["UNMATCHED_OVER_BUDGET", "OVER_LIMIT_NEW"]).toContain(reasons[0]);
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });

  it("reaching the Function constructor through a stored `.constructor` is DYNAMIC_CODE", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": "export function g() {}\nconst F = g.constructor;\nexport const run = F(\"return 1\");\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "lint-structure").violations.map((v) => v.reason)).toContain("DYNAMIC_CODE");
    repo.dispose();
  });
});

describe("declaration files are measured (spec 2.3)", () => {
  it("a clean zero-function .d.ts is measured and passes, not N/A", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/types.d.ts": "export interface Order {\n  total: number;\n}\nexport declare function price(o: Order): number;\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(out.manifest.entries.find((e) => e.c?.path === "src/types.d.ts")?.measure.C).toBe(true);
    expect(gate(out, "complexity").state).toBe("PASS");
    expect(out.verdict.state).toBe("PASS");
    repo.dispose();
  });

  it("an implementation inside a .d.ts is an author-fixable PARSE_ERROR_CANDIDATE", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/types.d.ts": "export function f(a: number) {\n  if (a) return 1;\n  return 2;\n}\n" });
    const out = await run(repo, b, c, servicePolicy());
    const hit = gate(out, "complexity").inconclusive.find((i) => i.reason === "PARSE_ERROR_CANDIDATE");
    expect(hit).toMatchObject({ file: "src/types.d.ts", authorFixable: true });
    expect(out.verdict.state).toBe("INCONCLUSIVE");
    repo.dispose();
  });
});

describe("pending waivers are usable end to end", () => {
  it("a request without approval prints the exact approve command; posting it clears the FAIL", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 18) });
    const blob = repo.git("rev-parse", `${c}:src/a.js`).trim();
    const unit = "src/a.js::a#function[0]";
    const policy = servicePolicy({ review: { waiver_approvers: ["wendy"], simplification_reviewers: ["wendy"] } });
    const request = comment(1, "alice", `/gate-waive gate=complexity unit="${unit}" metric=cogc ceiling=18 reason="explicit state table"`, c);

    const pending = await run(repo, b, c, policy, { pr: { comments: [request], identity, headSha: c } });
    expect(gate(pending, "complexity").state).toBe("FAIL");
    expect(pending.pendingWaivers).toHaveLength(1);
    const p = pending.pendingWaivers[0]!;
    expect(p).toMatchObject({ unit, metric: "cognitive", ceiling: 18, blob, requester: "alice" });
    const line = `/gate-waive-approve ${p.id} blob=${blob}`;
    expect(pending.summaryMarkdown).toContain(line);
    expect((gate(pending, "complexity").observe.pending_waivers as unknown[]).length).toBe(1);

    const approved = await run(repo, b, c, policy, { pr: { comments: [request, comment(2, "wendy", line, c)], identity, headSha: c } });
    expect(gate(approved, "complexity").state).toBe("ACCEPTED_WITH_WAIVER");
    expect(approved.pendingWaivers).toEqual([]);
    expect(approved.summaryMarkdown).not.toContain("/gate-waive-approve");
    repo.dispose();
  });
});

describe("authority", () => {
  it("defaults to local and is stamped on the verdict and the summary", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 3) });
    const out = await run(repo, b, c, servicePolicy());
    expect(out.authority).toBe("local");
    expect(out.verdict.authority).toBe("local");
    expect(out.summaryMarkdown.split("\n")[0]).toContain("authority: local");
    repo.dispose();
  });
});
