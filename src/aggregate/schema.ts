// Runtime validation for gate-result.json read back from artifacts. Results
// produced by PR-executing jobs are untrusted input to the aggregator.

import { z } from "zod";
import { GATE_IDS, GATE_MODES, GATE_STATES, INCONCLUSIVE_REASONS, REASON_CODES, SIDES, TRIGGER_IDS, UNMEASURED_REASONS, type GateResult } from "../types.js";

const violation = z
  .object({
    gate: z.enum(GATE_IDS),
    reason: z.enum(REASON_CODES),
    file: z.string(),
    unit: z.string().optional(),
    line: z.number().int().optional(),
    metric: z.string().optional(),
    before: z.number().nullable().optional(),
    after: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    waivedBy: z.string().optional(),
  })
  .passthrough();

const trigger = z.object({
  id: z.enum(TRIGGER_IDS),
  gate: z.enum(GATE_IDS),
  file: z.string().optional(),
  unit: z.string().optional(),
  evidence: z.string(),
  routing: z.boolean(),
});

export const gateResultSchema = z.object({
  schema_version: z.literal(1),
  gate: z.enum(GATE_IDS),
  state: z.enum(GATE_STATES),
  mode: z.enum(GATE_MODES),
  base_sha: z.string(),
  candidate_sha: z.string(),
  policy_revision: z.string(),
  measurement_fingerprint: z
    .object({
      cccc_version: z.string().optional(),
      cccc_sha256: z.string().optional(),
      runner_commit: z.string(),
      policy_revision: z.string(),
      args_template: z.array(z.string()).optional(),
      tools: z.record(z.string()).optional(),
    })
    .passthrough(),
  reasons: z.array(z.enum(REASON_CODES)),
  violations: z.array(violation),
  inconclusive: z.array(
    z.object({ reason: z.enum(INCONCLUSIVE_REASONS), file: z.string().optional(), detail: z.string(), authorFixable: z.boolean() }),
  ),
  triggers: z.array(trigger),
  waivers_applied: z.array(
    z.object({ id: z.string(), unit: z.string(), metric: z.string(), ceiling: z.number(), approver: z.string() }),
  ),
  unmeasured: z.array(z.object({ path: z.string(), side: z.enum(SIDES), reason: z.enum(UNMEASURED_REASONS) })),
  observe: z.record(z.unknown()),
  summary: z.string(),
});

export function parseGateResult(raw: unknown): GateResult {
  return gateResultSchema.parse(raw) satisfies GateResult;
}
