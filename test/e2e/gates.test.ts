// Spec 14 rows that cross module boundaries, run end to end: real git
// repositories, the real cccc binary, the full pipeline and aggregation.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/review/simplification.js";
import { waiverId } from "../../src/waivers/index.js";
import { TestRepo, approvalBody, fnWithCogc, gate, run, servicePolicy, testPolicy } from "./helpers.js";

const MANIP = new URL("../fixtures/manipulation/", import.meta.url).pathname;
const original = readFileSync(`${MANIP}original/price.js`, "utf8");
const variantB = readFileSync(`${MANIP}b/price.js`, "utf8");

const identity = { prAuthor: "alice", commits: [{ sha: "x", authorLogin: "alice", committerLogin: "alice" }], agentInvokers: [] };
const comment = (id: number, login: string, body: string, headSha: string): ReviewComment => ({
  id,
  author: { login },
  body,
  createdAt: `2026-10-28T12:${String(id).padStart(2, "0")}:00Z`,
  headSha,
});

function reasons(out: Awaited<ReturnType<typeof run>>, id: string): string[] {
  return gate(out, id).violations.filter((v) => !v.waivedBy).map((v) => v.reason);
}
function triggerIds(out: Awaited<ReturnType<typeof run>>): string[] {
  return [...new Set(out.verdict.triggers.map((t) => t.id))].sort();
}

describe("G1 complexity end to end", () => {
  it("new unit: CogC 15 passes, 16 fails with OVER_LIMIT_NEW", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c15 = repo.commit({ "src/a.js": fnWithCogc("a", 15) });
    const c16 = repo.commit({ "src/a.js": fnWithCogc("a", 16) });
    const pass = await run(repo, b, c15, servicePolicy());
    expect(gate(pass, "complexity").state).toBe("PASS");
    expect(pass.verdict.state).toBe("PASS");
    const fail = await run(repo, b, c16, servicePolicy());
    expect(reasons(fail, "complexity")).toEqual(["OVER_LIMIT_NEW"]);
    expect(fail.verdict.state).toBe("FAIL");
    expect(fail.checkRun.conclusion).toBe("failure");
    repo.dispose();
  });

  it("legacy unit over the limit: +1 fails, untouched legacy in a changed file passes without S5", async () => {
    const repo = new TestRepo();
    const legacy = fnWithCogc("legacy", 20);
    const b = repo.commit({ "src/l.js": `${legacy}export function small(x) {\n  return x;\n}\n` });
    const worse = repo.commit({ "src/l.js": `${fnWithCogc("legacy", 21)}export function small(x) {\n  return x;\n}\n` });
    const out = await run(repo, b, worse, servicePolicy());
    expect(reasons(out, "complexity")).toEqual(["LEGACY_WORSENED"]);

    const repo2 = new TestRepo();
    const b2 = repo2.commit({ "src/l.js": `${legacy}export function small(x) {\n  return x;\n}\n` });
    const c2 = repo2.commit({ "src/l.js": `${legacy}export function small(x) {\n  if (x) return 1;\n  return x;\n}\n` });
    const ok = await run(repo2, b2, c2, servicePolicy());
    expect(gate(ok, "complexity").state).toBe("PASS");
    expect(triggerIds(ok)).not.toContain("S5");
    expect(ok.verdict.state).toBe("PASS");
    repo.dispose();
    repo2.dispose();
  });

  it("a PR-supplied cccc.toml excluding src/** cannot hide an over-limit unit", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "cccc.toml": 'exclude = ["src/**"]\n', ".cccc.toml": 'exclude = ["**"]\n', "src/a.js": fnWithCogc("a", 16) });
    const out = await run(repo, b, c, servicePolicy());
    expect(reasons(out, "complexity")).toEqual(["OVER_LIMIT_NEW"]);
    repo.dispose();
  });

  it(".gitattributes working-tree-encoding does not change measurement and routes S11 to review", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": fnWithCogc("a", 3) });
    repo.commit({ "src/a.js": fnWithCogc("a", 16) });
    // With this attribute a checkout re-encodes every .js file to UTF-16 and cccc skips them all.
    const c = repo.commit({ ".gitattributes": "*.js working-tree-encoding=UTF-16\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(reasons(out, "complexity")).toEqual(["OVER_LIMIT"]);
    expect(triggerIds(out)).toContain("S11");
    expect(reasons(out, "simplification-review")).toEqual(["REVIEW_REQUIRED"]);
    repo.dispose();
  });

  it("moving code to an unmeasured .vue file routes S11 instead of passing silently", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": fnWithCogc("a", 16) });
    const c = repo.commit({ "src/a.ts": null, "src/A.vue": `<script>\n${fnWithCogc("a", 16)}</script>\n` });
    const out = await run(repo, b, c, servicePolicy());
    expect(triggerIds(out)).toContain("S11");
    expect(out.verdict.mergeAllowed).toBe(false);
    expect(reasons(out, "simplification-review")).toEqual(["REVIEW_REQUIRED"]);
    repo.dispose();
  });

  it("a candidate syntax error is INCONCLUSIVE, never a pass, and its check fails", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.ts": `${fnWithCogc("a", 30)}\nfunction broken( {\n` });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").state).toBe("INCONCLUSIVE");
    expect(gate(out, "complexity").reasons).toContain("PARSE_ERROR_CANDIDATE");
    expect(out.verdict.state).toBe("INCONCLUSIVE");
    expect(out.checkRun.conclusion).toBe("failure");
    expect(out.checkRun.title).toMatch(/^INCONCLUSIVE/);
    repo.dispose();
  });

  it("a syntax error that swallows named legacy units also routes S11, and FAIL outranks INCONCLUSIVE", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": fnWithCogc("a", 3) });
    const c = repo.commit({ "src/a.ts": `${fnWithCogc("a", 30)}\nfunction broken( {\n` });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").state).toBe("INCONCLUSIVE");
    expect(triggerIds(out)).toContain("S11");
    expect(out.verdict.state).toBe("FAIL");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });

  it("an implementation hidden in a .d.ts file is INCONCLUSIVE", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/types.d.ts": `export function f(a: number) {\n  if (a) return 1;\n  return 2;\n}\n` });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").inconclusive.map((i) => i.reason)).toContain("PARSE_ERROR_CANDIDATE");
    repo.dispose();
  });
});

describe("scope and applicability", () => {
  it("a docs-only PR is NOT_APPLICABLE and merge-allowed, even with tests enforced", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": fnWithCogc("a", 3), "README.md": "a\n" });
    const c = repo.commit({ "README.md": "b\n", "docs/guide.md": "c\n" });
    const out = await run(repo, b, c, testPolicy());
    expect(out.verdict.state).toBe("NOT_APPLICABLE");
    expect(out.verdict.mergeAllowed).toBe(true);
    expect(out.checkRun.conclusion).toBe("success");
    expect(out.checkRun.title).toBe("N/A");
    repo.dispose();
  });

  it("enforced tests without the workflow artifact are INCONCLUSIVE, never PASS", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 3) });
    const out = await run(repo, b, c, testPolicy({ coverage: { mode: "observe" } }));
    expect(gate(out, "tests").state).toBe("INCONCLUSIVE");
    expect(out.verdict.state).toBe("INCONCLUSIVE");
    expect(out.checkRun.conclusion).toBe("failure");
  });

  it("a passing test report counts only with workflow provenance", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 3), "src/a.test.js": "import { it, expect } from 'vitest';\nit('a', () => { expect(1).toBe(1); });\n" });
    const report = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
      testResults: [
        { name: "src/a.test.js", status: "passed", assertionResults: [{ ancestorTitles: [], title: "a", fullName: "a", status: "passed" }] },
      ],
    });
    const wf = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["a".repeat(40)] };
    const policy = testPolicy({ coverage: { mode: "observe" }, provenance: { trusted_workflows: [wf] } });
    const unproven = await run(repo, b, c, policy, { artifacts: { tests: { reportC: report } } });
    expect(unproven.verdict.reasons).toContain("UNTRUSTED_ARTIFACT");
    expect(unproven.verdict.mergeAllowed).toBe(false);
    const provenance = {
      repository: wf.repository,
      workflowPath: wf.path,
      workflowSha: wf.shas[0]!,
      runId: 1,
      runAttempt: 1,
      headSha: c,
      event: "merge_group",
    };
    const proven = await run(repo, b, c, policy, { artifacts: { tests: { reportC: report, provenance } } });
    expect(gate(proven, "tests").state).toBe("PASS");
    expect(proven.verdict.state).toBe("PASS");
    repo.dispose();
  });
});

describe("G2 lint end to end", () => {
  it("new Function under a base-side eslint-disable header still FAILs", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": "/* eslint-disable */\nexport const x = 1;\n" });
    const c = repo.commit({ "src/a.js": "/* eslint-disable */\nexport const x = 1;\nexport const f = new Function('a', 'return a');\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(reasons(out, "lint-structure")).toContain("DYNAMIC_CODE");
    expect(out.verdict.state).toBe("FAIL");
    repo.dispose();
  });

  it("P1 lint.enforced_rules blocks only the listed rules and observes the rest", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": "export function f(a, b, c, d, e) {\n  return a + b + c + d + e;\n}\n" });
    const enforced = servicePolicy({ lint: { enforced_rules: ["nyorori/dynamic-code", "no-new-func"] } });
    const out = await run(repo, b, c, enforced);
    expect(gate(out, "lint-structure").state).toBe("PASS");
    expect((gate(out, "lint-structure").observe.unenforced_violations as unknown[]).length).toBe(1);
    const strict = await run(repo, b, c, servicePolicy());
    expect(reasons(strict, "lint-structure")).toEqual(["LINT_NEW_VIOLATION"]);
    repo.dispose();
  });
});

describe("G6 simplification review end to end", () => {
  it("helper-splitting manipulation routes to review; an independent approval clears it until a push touches the file", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/price.js": original });
    const c = repo.commit({ "src/price.js": variantB });
    const policy = servicePolicy({ review: { simplification_reviewers: ["rita", "alice"] } });

    const before = await run(repo, b, c, policy, { pr: { comments: [], identity, headSha: c } });
    expect(gate(before, "complexity").state).toBe("PASS");
    expect(triggerIds(before)).toEqual(expect.arrayContaining(["S1", "S10"]));
    expect(reasons(before, "simplification-review")).toEqual(["REVIEW_REQUIRED"]);
    const APPROVE = approvalBody(triggerIds(before), c);

    const self = await run(repo, b, c, policy, { pr: { comments: [comment(1, "alice", APPROVE, c)], identity, headSha: c } });
    expect(reasons(self, "simplification-review")).toEqual(["REVIEW_REQUIRED"]);

    const approved = await run(repo, b, c, policy, { pr: { comments: [comment(2, "rita", APPROVE, c)], identity, headSha: c } });
    expect(gate(approved, "simplification-review").state).toBe("PASS");
    expect(approved.verdict.mergeAllowed).toBe(true);

    const c2 = repo.commit({ "src/price.js": `${variantB}\n// touch\n` });
    const pushed = await run(repo, b, c2, policy, {
      pr: {
        comments: [comment(2, "rita", APPROVE, c)],
        identity,
        headSha: c2,
        carryOver: { [c]: { patchIdEqual: false, filesChangedSince: ["src/price.js"] } },
      },
    });
    expect(reasons(pushed, "simplification-review")).toEqual(["REVIEW_REQUIRED"]);
    repo.dispose();
  });
});

describe("waivers end to end", () => {
  it("an independent approver's waiver accepts the FAIL; the author's own approval is rejected", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 18) });
    const blob = repo.git("rev-parse", `${c}:src/a.js`).trim();
    const unit = "src/a.js::a#function[0]";
    const request = comment(1, "alice", `/gate-waive gate=complexity unit="${unit}" metric=cogc ceiling=18 reason="explicit state table"`, c);
    const id = waiverId("1", "complexity", unit, "cognitive", 18);
    const policy = servicePolicy({ review: { waiver_approvers: ["alice", "wendy"], simplification_reviewers: ["wendy"] } });

    const ok = await run(repo, b, c, policy, {
      pr: { comments: [request, comment(2, "wendy", `/gate-waive-approve ${id} blob=${blob}`, c)], identity, headSha: c },
    });
    expect(gate(ok, "complexity").state).toBe("ACCEPTED_WITH_WAIVER");
    expect(ok.verdict.state).toBe("ACCEPTED_WITH_WAIVER");
    expect(ok.verdict.mergeAllowed).toBe(true);

    const selfApproved = await run(repo, b, c, policy, {
      pr: { comments: [request, comment(2, "alice", `/gate-waive-approve ${id} blob=${blob}`, c)], identity, headSha: c },
    });
    expect(gate(selfApproved, "complexity").state).toBe("FAIL");

    const exhausted = await run(repo, b, c, policy, {
      pr: { comments: [request, comment(2, "wendy", `/gate-waive-approve ${id} blob=${blob}`, c)], identity, headSha: c, quarterWaiversUsed: 30 },
    });
    expect(gate(exhausted, "complexity").state).toBe("FAIL");
    repo.dispose();
  });
});
