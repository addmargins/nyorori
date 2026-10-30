// Every closed set (trigger ids, gate modes, reason codes) has one source in
// src/types.ts. A schema or lookup that lists the members by hand drifts when
// the set grows, so the schemas must accept exactly the union, checked both at
// compile time (tsc fails) and at run time.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { gateResultSchema, parseGateResult } from "../../src/aggregate/schema.js";
import { policySchema } from "../../src/policy/schema.js";
import { isWaivable } from "../../src/waivers/index.js";
import type { GateMode, GateResult, InconclusiveReason, ReasonCode, TriggerId } from "../../src/types.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Parsed = z.infer<typeof gateResultSchema>;

const triggerIdsMatch: Equal<Parsed["triggers"][number]["id"], TriggerId> = true;
const modesMatch: Equal<Parsed["mode"], GateMode> = true;
const policyModesMatch: Equal<z.infer<typeof policySchema>["complexity"]["mode"], GateMode> = true;
const reasonsMatch: Equal<Parsed["reasons"][number], ReasonCode> = true;
const inconclusiveMatch: Equal<Parsed["inconclusive"][number]["reason"], InconclusiveReason> = true;

const result: GateResult = {
  schema_version: 1,
  gate: "complexity",
  state: "PASS",
  mode: "degraded",
  base_sha: "b",
  candidate_sha: "c",
  policy_revision: "r",
  measurement_fingerprint: { runner_commit: "x", policy_revision: "r" },
  reasons: [],
  violations: [],
  inconclusive: [{ reason: "PATH_TOO_LONG", detail: "d", authorFixable: true }],
  triggers: [{ id: "S12", gate: "complexity", evidence: "e", routing: true }],
  waivers_applied: [],
  unmeasured: [],
  observe: {},
  summary: "s",
};

describe("closed sets have one source", () => {
  it("the compile-time checks above hold", () => {
    expect([triggerIdsMatch, modesMatch, policyModesMatch, reasonsMatch, inconclusiveMatch]).toEqual([true, true, true, true, true]);
  });

  it("gate-result.json accepts every trigger id and gate mode of the union", () => {
    expect(parseGateResult(JSON.parse(JSON.stringify(result)))).toMatchObject({ mode: "degraded", triggers: [{ id: "S12" }] });
  });

  it("rejects a reason code outside the union", () => {
    expect(() => parseGateResult({ ...result, mode: "enforce", triggers: [], inconclusive: [], reasons: ["NOT_A_REASON"] })).toThrow();
  });

  it("no measurement reason is waivable", () => {
    const v = { gate: "complexity" as const, file: "a.ts", message: "m", reason: "PATH_TOO_LONG" as unknown as ReasonCode };
    expect(isWaivable(v)).toBe(false);
  });
});
