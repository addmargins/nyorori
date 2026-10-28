// Acceptance rows for the questions the red-team pass left open: product
// logic parked under test-support paths, legacy allowances inherited through
// renames, and new tests without recognizable assertions.

import { describe, expect, it } from "vitest";
import { TestRepo, fnWithCogc, gate, run, servicePolicy, testPolicy } from "./helpers.js";

const routed = (out: Awaited<ReturnType<typeof run>>) =>
  out.verdict.triggers.filter((t) => t.routing).map((t) => t.id);

describe("logic parked under test-support paths", () => {
  it("product code importing complex logic from test/helpers is blocked", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/index.js": "export const v = 1;\n" });
    const c = repo.commit({
      "test/helpers/price.js": fnWithCogc("price", 30),
      "src/index.js": 'import { price } from "../test/helpers/price.js";\nexport const v = price(1, 0);\n',
    });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "deps").violations.map((v) => v.reason)).toContain("DEP_FORBIDDEN_EDGE");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });

  it("a src/helpers directory is product code and is measured normally", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/helpers/price.js": fnWithCogc("price", 16) });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").violations.map((v) => v.reason)).toEqual(["OVER_LIMIT_NEW"]);
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });
});

describe("legacy allowance inherited through a rename", () => {
  it("renaming a legacy unit while rewriting its body routes S5 identity-changed", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": fnWithCogc("legacy", 20) });
    // Same CogC, new name, different body: the allowance may only be inherited under review.
    const rewritten = fnWithCogc("renamed", 20).replace(/y \+= (\d+);/g, "y -= $1;");
    const c = repo.commit({ "src/a.js": rewritten });
    const out = await run(repo, b, c, servicePolicy());
    const g1 = gate(out, "complexity");
    // Stage 2 (same hunk) keeps the allowance, so the only guard is a routed S5.
    expect(g1.violations).toEqual([]);
    const s5 = g1.triggers.filter((t) => t.id === "S5");
    expect(s5).toHaveLength(1);
    expect(s5[0]).toMatchObject({ routing: true });
    expect(s5[0]!.evidence).toContain("identity-changed (stage 2)");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });

  it("a copy of a legacy unit under a new name gets the new-code limit", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.js": fnWithCogc("legacy", 20) });
    const c = repo.commit({ "src/a.js": fnWithCogc("legacy", 20) + fnWithCogc("copy", 20) });
    const out = await run(repo, b, c, servicePolicy());
    const units = gate(out, "complexity").violations.map((v) => v.unit ?? "");
    expect(units.some((u) => u.includes("copy"))).toBe(true);
    expect(units.some((u) => u.includes("legacy"))).toBe(false);
    repo.dispose();
  });
});

describe("new tests without recognizable assertions", () => {
  const wf = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["a".repeat(40)] };
  const report = (titles: string[]) =>
    JSON.stringify({
      numTotalTests: titles.length,
      numPassedTests: titles.length,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
      testResults: [
        {
          name: "src/a.test.js",
          status: "passed",
          assertionResults: titles.map((title) => ({ ancestorTitles: [], title, fullName: title, status: "passed" })),
        },
      ],
    });

  it("a new test whose only check hides in an unrecognized helper routes S7", async () => {
    const repo = new TestRepo();
    const b = repo.commit({
      "src/a.test.js": 'import { it, expect } from "vitest";\nit("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    });
    const c = repo.commit({
      "src/a.test.js":
        'import { it, expect } from "vitest";\nimport { looksFine } from "./support.js";\n' +
        'it("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n' +
        'it("prices", () => {\n  looksFine(2);\n});\n',
    });
    const policy = testPolicy({ coverage: { mode: "observe" }, provenance: { trusted_workflows: [wf] } });
    const out = await run(repo, b, c, policy, {
      artifacts: {
        tests: {
          reportB: report(["adds"]),
          reportC: report(["adds", "prices"]),
          provenance: {
            repository: wf.repository, workflowPath: wf.path, workflowSha: wf.shas[0]!,
            runId: 1, runAttempt: 1, headSha: c, event: "merge_group",
          },
        },
      },
    });
    expect(gate(out, "tests").triggers.map((t) => t.id)).toContain("S7");
    expect(routed(out)).toContain("S7");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });
});
