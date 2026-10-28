import { describe, expect, it } from "vitest";
import { aggregateQualityGate, type AggregateInput, type SubmittedResult } from "../../src/aggregate/index.js";
import { parseGateResult } from "../../src/aggregate/schema.js";
import { verdictToCheckRun } from "../../src/report/checkrun.js";
import type { GateId, GateResult } from "../../src/types.js";
import { B, C, HEAD, REV, RUNNER, identity, policy, result, violation } from "./helpers.js";

const WF = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["9".repeat(40)] };

function svc(gate: GateId, over: Partial<Parameters<typeof result>[0]> = {}): SubmittedResult {
  return { source: "service", result: result({ gate, ...over }) };
}
function act(gate: GateId, over: Partial<Parameters<typeof result>[0]> = {}, prov: Partial<NonNullable<SubmittedResult["provenance"]>> = {}): SubmittedResult {
  return {
    source: "actions",
    result: result({ gate, fingerprint: { runner_commit: "workflow", policy_revision: REV }, ...over }),
    provenance: { repository: WF.repository, workflowPath: WF.path, workflowSha: WF.shas[0]!, runId: 10, runAttempt: 1, headSha: C, event: "merge_group", ...prov },
  };
}

function all(): SubmittedResult[] {
  return [svc("complexity"), svc("lint-structure"), svc("deps"), act("tests"), act("coverage"), act("mutation")];
}

function agg(results: SubmittedResult[], over: Partial<AggregateInput> = {}) {
  return aggregateQualityGate({
    policy: policy(),
    expected: { base: B, candidate: C, policyRevision: REV, runnerCommit: RUNNER, cccc: { version: "cccc 1.8.5", sha256: "a".repeat(64) } },
    results,
    trustedWorkflows: { workflows: [WF] },
    review: { headSha: HEAD, comments: [], identity },
    ...over,
  });
}

describe("quality-gate aggregation", () => {
  it("passes when every enforce gate passes and no trigger fired", () => {
    const v = agg(all());
    expect(v.state).toBe("PASS");
    expect(v.mergeAllowed).toBe(true);
    expect(verdictToCheckRun(v, []).conclusion).toBe("success");
  });

  it("a gate that did not report is never a pass", () => {
    const v = agg(all().filter((s) => s.result.gate !== "tests"));
    expect(v.state).toBe("INCONCLUSIVE");
    expect(v.missing).toEqual(["tests"]);
    expect(v.mergeAllowed).toBe(false);
    const check = verdictToCheckRun(v, []);
    expect(check.conclusion).toBe("failure");
    expect(check.title).toBe("INCONCLUSIVE: REPORT_MISSING");
  });

  it("observe-mode gates (coverage, mutation by default) are excluded but listed", () => {
    const v = agg(all().map((s) => (s.result.gate === "coverage" ? act("coverage", { violations: [violation({ gate: "coverage", reason: "COVERAGE_UNEXECUTED" })] }) : s)));
    expect(v.state).toBe("PASS");
    expect(v.gates.find((g) => g.gate === "coverage")).toMatchObject({ mode: "observe", state: "FAIL", counted: false });
    // Missing observe gates do not block.
    expect(agg(all().filter((s) => s.result.gate !== "mutation")).state).toBe("PASS");
  });

  it("uses the policy's mode, not the artifact's claim", () => {
    const sneaky = act("tests", { mode: "observe", violations: [violation({ gate: "tests", reason: "TESTS_FAILED" })] });
    const v = agg(all().map((s) => (s.result.gate === "tests" ? sneaky : s)));
    expect(v.state).toBe("FAIL");
  });

  it("FAIL outranks INCONCLUSIVE and fail reasons come first", () => {
    const v = agg(
      all()
        .filter((s) => s.result.gate !== "tests")
        .map((s) => (s.result.gate === "complexity" ? svc("complexity", { violations: [violation()] }) : s)),
    );
    expect(v.state).toBe("FAIL");
    expect(v.reasons[0]).toBe("OVER_LIMIT_NEW");
    expect(v.reasons).toContain("REPORT_MISSING");
  });

  it("rejects results with another B/C/P/M", () => {
    for (const bad of [
      svc("complexity", { base: "x".repeat(40) }),
      svc("complexity", { policyRevision: "other" }),
      svc("complexity", { fingerprint: { runner_commit: "other", policy_revision: REV, cccc_version: "cccc 1.8.5", cccc_sha256: "a".repeat(64) } }),
      svc("complexity", { fingerprint: { runner_commit: RUNNER, policy_revision: REV, cccc_version: "cccc 1.8.4", cccc_sha256: "a".repeat(64) } }),
    ]) {
      const v = agg(all().map((s) => (s.result.gate === "complexity" ? bad : s)));
      expect(v.state).toBe("INCONCLUSIVE");
      expect(v.reasons).toContain("FINGERPRINT_MISMATCH");
    }
  });

  it("accepts PR-executing gates only from the pinned workflow for the candidate", () => {
    for (const prov of [
      { workflowPath: ".github/workflows/pr.yml" },
      { workflowSha: "8".repeat(40) },
      { headSha: HEAD },
      { event: "pull_request_target" },
      { repository: "attacker/fork" },
    ]) {
      const v = agg(all().map((s) => (s.result.gate === "tests" ? act("tests", {}, prov) : s)));
      expect(v.state, JSON.stringify(prov)).toBe("INCONCLUSIVE");
      expect(v.reasons).toContain("UNTRUSTED_ARTIFACT");
    }
    const noProv = { ...act("tests"), provenance: undefined };
    expect(agg(all().map((s) => (s.result.gate === "tests" ? noProv : s))).reasons).toContain("UNTRUSTED_ARTIFACT");
  });

  it("refuses service gates submitted from Actions", () => {
    const forged = act("complexity");
    const v = agg([forged, ...all().filter((s) => s.result.gate !== "complexity")]);
    expect(v.missing).toContain("complexity");
    expect(v.reasons).toContain("UNTRUSTED_ARTIFACT");
  });

  it("recomputes state from contents: a PASS claim with open violations fails", () => {
    const lying: GateResult = { ...result({ gate: "tests", violations: [violation({ gate: "tests", reason: "TEST_REMOVED" })] }), state: "PASS" };
    const v = agg(all().map((s) => (s.result.gate === "tests" ? { ...act("tests"), result: { ...lying, measurement_fingerprint: { runner_commit: "w", policy_revision: REV } } } : s)));
    expect(v.state).toBe("FAIL");
  });

  it("takes the latest run attempt among re-runs", () => {
    const first = act("tests", { violations: [violation({ gate: "tests", reason: "TESTS_FAILED" })] }, { runAttempt: 1 });
    const second = act("tests", {}, { runAttempt: 2 });
    expect(agg([...all().filter((s) => s.result.gate !== "tests"), first, second]).state).toBe("PASS");
  });

  it("conflicting duplicate service results are INCONCLUSIVE", () => {
    const v = agg([...all(), svc("complexity", { violations: [violation()] })]);
    expect(v.reasons).toContain("TOOL_ERROR");
  });

  it("routing triggers from enforce gates require a simplification review; observe-gate triggers do not", () => {
    const trig = { id: "S1" as const, gate: "complexity" as const, file: "src/a.ts", evidence: "e", routing: true };
    const v = agg(all().map((s) => (s.result.gate === "complexity" ? svc("complexity", { triggers: [trig] }) : s)));
    expect(v.state).toBe("FAIL");
    expect(v.reasons).toEqual(["REVIEW_REQUIRED"]);
    const observeCx = policy({ complexity: { mode: "observe" } });
    expect(agg(all().map((s) => (s.result.gate === "complexity" ? svc("complexity", { triggers: [trig] }) : s)), { policy: observeCx }).state).toBe("PASS");
  });

  it("waived violations give ACCEPTED_WITH_WAIVER and allow merge", () => {
    const v = agg(all().map((s) => (s.result.gate === "complexity" ? svc("complexity", { violations: [violation({ waivedBy: "W1" })], waivers: [{ id: "W1", unit: violation().unit!, metric: "cognitive", ceiling: 22, approver: "appr-carol" }] }) : s)));
    expect(v.state).toBe("ACCEPTED_WITH_WAIVER");
    expect(v.mergeAllowed).toBe(true);
  });

  it("policy-integrity findings block", () => {
    const v = agg(all(), { policyIntegrity: [violation({ gate: "tests", reason: "POLICY_PATH_MODIFIED", message: "loop edited vitest.config.ts" })] });
    expect(v.state).toBe("FAIL");
    expect(v.gates.find((g) => g.gate === "policy-integrity")?.state).toBe("FAIL");
  });

  it("all N/A gives N/A (docs-only PR still reports)", () => {
    const na = all().map((s) => ({ ...s, result: { ...s.result, ...result({ gate: s.result.gate, applicable: false, fingerprint: s.result.measurement_fingerprint }) } }));
    const v = agg(na);
    expect(v.state).toBe("NOT_APPLICABLE");
    expect(verdictToCheckRun(v, []).title).toBe("N/A");
  });

  it("validates artifact JSON", () => {
    expect(parseGateResult(JSON.parse(JSON.stringify(result())))).toMatchObject({ gate: "complexity" });
    expect(() => parseGateResult({ ...result(), state: "neutral" })).toThrow();
  });
});
