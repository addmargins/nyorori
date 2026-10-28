// Pins the measurer (spec 6.1): the exact binary bytes, its self-reported
// version and the argument template all go into every gate result, and a
// mismatch with the policy makes the run INCONCLUSIVE before anything is measured.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Policy } from "../policy/schema.js";
import type { Inconclusive, MeasurementFingerprint } from "../types.js";

/** Arguments before the `--` file list; the only invocation shape the runner uses. */
export function ccccArgsTemplate(jobs: number): string[] {
  return ["--no-config", "--no-cache", "--lang", "es", "-j", String(jobs), "--"];
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function probeVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

export interface MeasurerIdentity {
  version: string;
  sha256: string;
}

export async function identifyMeasurer(binary: string): Promise<MeasurerIdentity> {
  const [sha256, version] = await Promise.all([sha256File(binary), probeVersion(binary)]);
  return { sha256, version };
}

/** Policy sections whose mode is not plain observation. */
export function enforcingGates(policy: Policy): string[] {
  const sections = {
    complexity: policy.complexity.mode,
    "lint-structure": policy.lint.mode,
    deps: policy.deps.mode,
    tests: policy.tests.mode,
    coverage: policy.coverage.mode,
    "simplification-review": policy.review.mode,
    mutation: policy.mutation.mode,
  };
  return Object.entries(sections)
    .filter(([, mode]) => mode !== "observe")
    .map(([gate]) => gate);
}

/**
 * Pure comparison against the policy pin. An empty pin is accepted only when
 * every gate observes or the policy explicitly allows unpinned local runs.
 */
export function checkMeasurer(id: MeasurerIdentity, policy: Policy): Inconclusive[] {
  const out: Inconclusive[] = [];
  const m = policy.measurer;
  if (id.version !== m.cccc_version) {
    out.push({
      reason: "MEASURER_MISMATCH",
      detail: `measurer reports ${JSON.stringify(id.version)}, policy pins ${JSON.stringify(m.cccc_version)}`,
      authorFixable: false,
    });
  }
  if (m.cccc_sha256 === "" && !m.allow_unpinned && enforcingGates(policy).length > 0) {
    out.push({
      reason: "MEASURER_MISMATCH",
      detail: `policy pins no cccc sha256 while ${enforcingGates(policy).join(", ")} enforce; pin the attested binary (measurer.allow_unpinned is for local runs only)`,
      authorFixable: false,
    });
  }
  if (m.cccc_sha256 !== "" && id.sha256 !== m.cccc_sha256) {
    out.push({
      reason: "MEASURER_MISMATCH",
      detail: `measurer sha256 ${id.sha256} differs from policy pin ${m.cccc_sha256}`,
      authorFixable: false,
    });
  }
  return out;
}

export function buildFingerprint(
  id: MeasurerIdentity,
  policy: Policy,
  runnerCommit: string,
  tools: Record<string, string> = {},
): MeasurementFingerprint {
  return {
    cccc_version: id.version,
    cccc_sha256: id.sha256,
    runner_commit: runnerCommit,
    policy_revision: policy.revision,
    args_template: ccccArgsTemplate(policy.measurer.jobs),
    tools,
  };
}
