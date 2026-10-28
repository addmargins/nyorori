// Runs the gates in a detached child process (spec 10.1): the parent, which
// may hold the App key, only ships the request and collects the result. A
// crash, a timeout or an oversized result turns into INCONCLUSIVE(TOOL_ERROR)
// for every service gate, so the required check is never left missing.

import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateQualityGate, policyMode } from "../aggregate/index.js";
import { resolveCommit } from "../git/exec.js";
import { buildGateFeedback } from "../report/feedback.js";
import { verdictToCheckRun } from "../report/checkrun.js";
import { renderSummaryMarkdown } from "../report/markdown.js";
import { finalizeGateResult } from "../report/result.js";
import { GATE_IDS, type GateResult, type Inconclusive } from "../types.js";
import { authorityLine } from "./run.js";
import type { Authority, RunGatesOptions, RunGatesOutput } from "./types.js";
import { fromWireOutput, toWireOptions, type WireOutput } from "./worker.js";

export interface IsolationOptions {
  /** Wall-clock limit for the whole analysis. */
  timeoutMs?: number;
  /** Largest JSON response accepted from the worker. */
  maxOutputBytes?: number;
  /** V8 heap cap passed to the child. */
  maxOldSpaceMb?: number;
  /** Worker entry module; defaults to the built `worker.js` next to this file. */
  workerModule?: string;
}

const DEFAULTS = { timeoutMs: 300_000, maxOutputBytes: 64 * 1024 * 1024, maxOldSpaceMb: 1024 };
const MAX_STDERR = 256 * 1024;

export class WorkerError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "OUTPUT_TOO_LARGE" | "EXIT" | "SPAWN" | "MALFORMED",
    message: string,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

function defaultWorkerModule(): string {
  return fileURLToPath(new URL("./worker.js", import.meta.url));
}

interface Collected {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

function spawnWorker(request: string, home: string, o: Required<IsolationOptions>): Promise<Collected> {
  return new Promise((done, fail) => {
    const child = fork(o.workerModule, [], {
      execArgv: [`--max-old-space-size=${o.maxOldSpaceMb}`],
      // No App key, proxy or cloud credentials, NODE_OPTIONS or preload hooks reach the analysis.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      f();
    };
    const timer = setTimeout(() => finish(() => (killGroup(), fail(new WorkerError("TIMEOUT", `analysis exceeded ${o.timeoutMs} ms`)))), o.timeoutMs);
    child.once("error", (e) => finish(() => (killGroup(), fail(new WorkerError("SPAWN", e.message)))));
    child.stdout!.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > o.maxOutputBytes) {
        finish(() => (killGroup(), fail(new WorkerError("OUTPUT_TOO_LARGE", "worker output too large"))));
        return;
      }
      out.push(c);
    });
    child.stderr!.on("data", (c: Buffer) => {
      if (err.length < MAX_STDERR) err += c.toString("utf8", 0, MAX_STDERR - err.length);
    });
    child.once("close", (code, signal) => finish(() => (killGroup(), done({ code, signal, stdout: Buffer.concat(out), stderr: err }))));
    child.stdin!.on("error", () => {
      // The child died before reading; `close` reports it.
    });
    child.stdin!.end(request);
    child.unref();
  });
}

/** Every service gate INCONCLUSIVE(TOOL_ERROR) with one aggregated verdict: the check still reports. */
export async function failedRunOutput(opts: RunGatesOptions, detail: string): Promise<RunGatesOutput> {
  const authority: Authority = opts.authority ?? "local";
  const policy = { ...opts.policy, revision: opts.policyRevision };
  const sha = async (rev: string) => resolveCommit(opts.repoDir, rev).catch(() => rev);
  const [base, candidate] = [await sha(opts.base), await sha(opts.candidate)];
  const fingerprint = { runner_commit: opts.runnerCommit, policy_revision: policy.revision };
  const problem: Inconclusive = { reason: "TOOL_ERROR", detail, authorFixable: false };
  const results: GateResult[] = GATE_IDS.filter((g) => g !== "simplification-review").map((gate) =>
    finalizeGateResult({ gate, mode: policyMode(policy, gate), base, candidate, policyRevision: policy.revision, fingerprint, inconclusive: [problem], applicable: true }),
  );
  const verdict = {
    ...aggregateQualityGate({
      policy,
      expected: { base, candidate, policyRevision: policy.revision, runnerCommit: opts.runnerCommit },
      results: results.map((result) => ({ result, source: "service" as const })),
      trustedWorkflows: { workflows: policy.provenance.trusted_workflows },
      review: {
        headSha: opts.pr?.headSha ?? candidate,
        comments: opts.pr?.comments ?? [],
        identity: opts.pr?.identity ?? { prAuthor: "", commits: [], agentInvokers: [] },
      },
    }),
    authority,
  };
  const all = [...results, verdict.review];
  return {
    authority,
    verdict,
    results: all,
    manifest: { baseSha: base, candidateSha: candidate, entries: [], problems: [], sensitivePathsChanged: [] },
    ccccRuns: [],
    summaryMarkdown: [authorityLine(authority), renderSummaryMarkdown(all, verdict)].join("\n"),
    checkRun: verdictToCheckRun(verdict, all),
    feedback: buildGateFeedback(all, { attempt: opts.attempt ?? 1, preserve: [] }),
    appliedWaivers: [],
    pendingWaivers: [],
  };
}

/** `runGates` in a detached child; never throws for an analysis failure. */
export async function runGatesIsolated(opts: RunGatesOptions, isolation: IsolationOptions = {}): Promise<RunGatesOutput> {
  const o: Required<IsolationOptions> = { ...DEFAULTS, workerModule: isolation.workerModule ?? defaultWorkerModule(), ...isolation };
  const home = await mkdtemp(join(tmpdir(), "nyorori-worker-home-"));
  try {
    const got = await spawnWorker(JSON.stringify(toWireOptions(opts)), home, o);
    if (got.code !== 0) {
      const why = got.signal ? `killed by ${got.signal}` : `exit ${got.code}`;
      throw new WorkerError("EXIT", `analysis worker ${why}${got.stderr ? `: ${got.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
    }
    let wire: WireOutput;
    try {
      wire = JSON.parse(got.stdout.toString("utf8")) as WireOutput;
    } catch (e) {
      throw new WorkerError("MALFORMED", `analysis worker returned no readable result: ${(e as Error).message}`);
    }
    return fromWireOutput(wire);
  } catch (e) {
    if (!(e instanceof WorkerError)) throw e;
    return failedRunOutput(opts, e.message);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
