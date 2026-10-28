// Round-2 rulings end to end: degraded mode (D16), foreign-language files (D5),
// shebang scripts (D6), waivable @ts-ignore (D9), test renames (D3).

import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/review/simplification.js";
import { normalizeMetric, waiverId } from "../../src/waivers/index.js";
import { TestRepo, approvalBody, fnWithCogc, gate, run, servicePolicy, testPolicy } from "./helpers.js";

const identity = { prAuthor: "alice", commits: [{ sha: "x", authorLogin: "alice", committerLogin: "alice" }], agentInvokers: [] };
const comment = (id: number, login: string, body: string, headSha: string): ReviewComment => ({
  id,
  author: { login },
  body,
  createdAt: `2026-10-28T12:${String(id).padStart(2, "0")}:00Z`,
  headSha,
});
const routedIds = (out: Awaited<ReturnType<typeof run>>) => [...new Set(out.verdict.triggers.map((t) => t.id))].sort();

describe("degraded mode (ruling D16)", () => {
  it("a degraded gate's FAIL routes to the simplification review instead of blocking", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 16) });
    const policy = servicePolicy({ complexity: { mode: "degraded" }, review: { simplification_reviewers: ["rita"] } });
    const out = await run(repo, b, c, policy, { pr: { comments: [], identity, headSha: c } });
    expect(gate(out, "complexity").state).toBe("FAIL");
    expect(out.verdict.blocking.map((v) => v.reason)).toEqual(["REVIEW_REQUIRED"]);
    expect(out.verdict.gates.find((g) => g.gate === "complexity")).toMatchObject({ mode: "degraded", counted: false });

    const approved = await run(repo, b, c, policy, {
      pr: { comments: [comment(1, "rita", approvalBody(routedIds(out)), c)], identity, headSha: c },
    });
    expect(approved.verdict.mergeAllowed).toBe(true);
    repo.dispose();
  });
});

describe("foreign-language files (ruling D5)", () => {
  it("a .py file next to a net CogC drop routes S11; a plain .py change does not", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": fnWithCogc("a", 12) });
    const moved = repo.commit({ "src/a.js": fnWithCogc("a", 2), "tools/rules.py": "def rules(x):\n    return x\n" });
    const out = await run(repo, b, moved, servicePolicy());
    expect(out.verdict.triggers.filter((t) => t.id === "S11").map((t) => t.file)).toEqual(["tools/rules.py"]);
    expect(gate(out, "complexity").unmeasured).toContainEqual({ path: "tools/rules.py", side: "C", reason: "FOREIGN_LANGUAGE" });

    const plain = repo.commit({ "tools/rules.py": "def rules(x):\n    return x + 1\n" });
    const ordinary = await run(repo, moved, plain, servicePolicy());
    expect(routedIds(ordinary)).not.toContain("S11");
    expect(ordinary.verdict.mergeAllowed).toBe(true);
    repo.dispose();
  });
});

describe("shebang scripts (ruling D6)", () => {
  it("an extensionless node script is measured as JavaScript", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "bin/cli": `#!/usr/bin/env node\n${fnWithCogc("main", 16)}` });
    const out = await run(repo, b, c, servicePolicy());
    const v = gate(out, "complexity").violations;
    expect(v.map((x) => [x.reason, x.unit])).toEqual([["OVER_LIMIT_NEW", "bin/cli::main#function[0]"]]);
    expect(gate(out, "lint-structure").state).not.toBe("INCONCLUSIVE");
    repo.dispose();
  });
});

describe("@ts-ignore (ruling D9)", () => {
  it("is a waivable FAIL that an independent waiver clears", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": "export const x: number = 1;\n" });
    const c = repo.commit({ "src/a.ts": "// @ts-ignore\nexport const x: number = 'a';\n" });
    const policy = servicePolicy({ review: { waiver_approvers: ["wendy"], simplification_reviewers: ["wendy"] } });
    const out = await run(repo, b, c, policy, { pr: { comments: [], identity, headSha: c } });
    const [v] = gate(out, "lint-structure").violations;
    expect(v).toMatchObject({ reason: "SUPPRESSION_ADDED_WAIVABLE", unit: "src/a.ts::<module>" });

    const blob = repo.git("rev-parse", `${c}:src/a.ts`).trim();
    const metric = v!.metric!;
    const request = comment(1, "alice", `/gate-waive gate=lint-structure unit="${v!.unit}" metric=${metric} ceiling=1 reason="third-party typing bug"`, c);
    const id = waiverId("1", "lint-structure", v!.unit!, normalizeMetric(metric), 1);
    const waived = await run(repo, b, c, policy, {
      pr: { comments: [request, comment(2, "wendy", `/gate-waive-approve ${id} blob=${blob}`, c)], identity, headSha: c },
    });
    expect(gate(waived, "lint-structure").state).toBe("ACCEPTED_WITH_WAIVER");
    expect(waived.verdict.mergeAllowed).toBe(true);
    repo.dispose();
  });
});

describe("test renames (ruling D3)", () => {
  const wf = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["a".repeat(40)] };
  const report = (title: string) =>
    JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
      testResults: [
        { name: "src/a.test.js", status: "passed", assertionResults: [{ ancestorTitles: [], title, fullName: title, status: "passed" }] },
      ],
    });
  const testFile = (title: string, body: string) => `import { it, expect } from "vitest";\nit("${title}", () => {\n  ${body}\n});\n`;

  it("a renamed test with a byte-identical body is not TEST_REMOVED; a changed body is", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.test.js": testFile("adds", "expect(1 + 1).toBe(2);") });
    const renamed = repo.commit({ "src/a.test.js": testFile("adds numbers", "expect(1 + 1).toBe(2);") });
    const policy = testPolicy({ coverage: { mode: "observe" }, provenance: { trusted_workflows: [wf] } });
    const prov = (head: string) => ({
      repository: wf.repository, workflowPath: wf.path, workflowSha: wf.shas[0]!, runId: 1, runAttempt: 1, headSha: head, event: "merge_group",
    });
    const out = await run(repo, b, renamed, policy, {
      artifacts: { tests: { reportB: report("adds"), reportC: report("adds numbers"), provenance: prov(renamed) } },
    });
    expect(gate(out, "tests").violations.map((v) => v.reason)).not.toContain("TEST_REMOVED");
    expect(gate(out, "tests").state).toBe("PASS");

    const gutted = repo.commit({ "src/a.test.js": testFile("adds numbers", "expect(1).toBe(1);") });
    const out2 = await run(repo, b, gutted, policy, {
      artifacts: { tests: { reportB: report("adds"), reportC: report("adds numbers"), provenance: prov(gutted) } },
    });
    expect(gate(out2, "tests").violations.map((v) => v.reason)).toContain("TEST_REMOVED");
    repo.dispose();
  });
});
