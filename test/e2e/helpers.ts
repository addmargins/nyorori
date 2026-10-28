// End-to-end harness: real git repositories, the real cccc binary, the full pipeline.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, type Policy, type PolicyInput } from "../../src/policy/schema.js";
import { runGatesIsolated } from "../../src/pipeline/isolated.js";
import { runGates } from "../../src/pipeline/run.js";
import type { RunGatesOptions, RunGatesOutput } from "../../src/pipeline/types.js";
import { TestRepo } from "../git/repo.js";

export const CCCC = process.env.NYORORI_CCCC ?? "/home/user/moznion/cccc/target/release/cccc";
if (!existsSync(CCCC)) throw new Error(`cccc binary not found at ${CCCC}; set NYORORI_CCCC`);

export { TestRepo };

/**
 * Default policy for local runs: the binary here is a source build, not the
 * attested release asset, so no sha256 is pinned (audit F10).
 */
export function testPolicy(over: Partial<PolicyInput> = {}): Policy {
  return defaultPolicy({ ...over, measurer: { allow_unpinned: true, ...over.measurer } });
}

/** Default policy with the PR-executing gates observed, so a run needs no artifacts. */
export function servicePolicy(over: Partial<PolicyInput> = {}): Policy {
  return testPolicy({ tests: { mode: "observe" }, coverage: { mode: "observe" }, ...over });
}

const RUBRIC_OK = "q1: pass\nq2: pass\nq3: pass\nq4: pass\nq5: pass";

/** A NO_SIMPLIFICATION_NEEDED review with the disposition line every fired trigger needs (ruling D13). */
/** `sha` is the PR head the reviewer looked at; approvals bind to it (round-3 item 8). */
export function approvalBody(triggerIds: readonly string[], sha: string): string {
  const lines = [...new Set(triggerIds)].map((id) => `${id}: reviewed, the shape is intended`);
  return [`/simplification-review NO_SIMPLIFICATION_NEEDED sha=${sha}`, RUBRIC_OK, ...lines].join("\n");
}

/** Built worker entry (vitest's globalSetup compiles it). */
export const WORKER = new URL("../../dist/pipeline/worker.js", import.meta.url).pathname;

export function baseOptions(repo: TestRepo, base: string, candidate: string, policy: Policy, workDir: string): RunGatesOptions {
  return {
    repoDir: repo.dir,
    base,
    candidate,
    policy,
    policyRevision: "e2e-policy",
    ccccBinary: CCCC,
    workDir,
    runnerCommit: "e2e-runner",
    // Never draw the determinism sample: the fixed value survives the worker boundary.
    rngValue: 1,
  };
}

/**
 * The production path: the gates run in the detached worker (spec 10.1).
 * `extra.rng` cannot cross the process boundary and is ignored here.
 */
export async function run(
  repo: TestRepo,
  base: string,
  candidate: string,
  policy: Policy,
  extra: Partial<RunGatesOptions> = {},
): Promise<RunGatesOutput> {
  const workDir = mkdtempSync(join(tmpdir(), "nyorori-e2e-"));
  try {
    const { rng: _rng, ...rest } = extra;
    return await runGatesIsolated({ ...baseOptions(repo, base, candidate, policy, workDir), ...rest }, { workerModule: WORKER });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Same run inside this process, for tests that need a function-valued option. */
export async function runInProcess(
  repo: TestRepo,
  base: string,
  candidate: string,
  policy: Policy,
  extra: Partial<RunGatesOptions> = {},
): Promise<RunGatesOutput> {
  const workDir = mkdtempSync(join(tmpdir(), "nyorori-e2e-"));
  try {
    return await runGates({ ...baseOptions(repo, base, candidate, policy, workDir), ...extra });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function gate(out: RunGatesOutput, id: string) {
  const r = out.results.find((x) => x.gate === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
}

/** A function whose CogC is exactly `n` (n flat `if`s at nesting 0). */
export function fnWithCogc(name: string, n: number): string {
  const body = Array.from({ length: n }, (_, i) => `  if (x === ${i}) y += ${i};`).join("\n");
  return `export function ${name}(x, y) {\n${body}\n  return y;\n}\n`;
}
