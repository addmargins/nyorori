#!/usr/bin/env node
// nyorori command line: `run` one gate evaluation, check the measurer against
// the calculation-rule `fixtures`, or `serve` the GitHub App webhook.

import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkCalculationRules } from "./fixtures/rules.js";
import { isolationFromEnv, runGatesIsolated } from "./pipeline/isolated.js";
import { assertToolsOutsideRepo, RepoPathError } from "./pipeline/paths.js";
import { runGates } from "./pipeline/run.js";
import { replayCommand } from "./replay/cli.js";
import type { PullRequestContext, RunGatesOptions } from "./pipeline/types.js";
import { loadPolicy } from "./policy/load.js";
import { dispatchEvent, replayPendingJobs, sweepWaiting, type ServiceDeps } from "./service/handlers.js";
import { CommandSigner, createSigner, signerEnvironment, type AppJwtSigner } from "./service/signer.js";
import { FileDeliveryStore, JobJournal } from "./service/journal.js";
import { loadArtifactDir } from "./replay/inputs.js";
import { writeRunOutputs } from "./replay/outputs.js";
import { createServiceEvaluator } from "./service/evaluator.js";
import { GitHubApi } from "./service/github.js";
import { FileLedgerStore } from "./service/ledger.js";
import { IssuedDebtStore, recordMergedPullRequest, type MergedPullRequest } from "./service/merge.js";
import { VerdictStore } from "./service/verdicts.js";
import { createWebhookServer } from "./service/http.js";
import { EXIT_CODE } from "./types.js";
import { errorMessage } from "./util/errors.js";

/** Usage errors use EX_USAGE so they are never confused with FAIL (1) or INCONCLUSIVE (2). */
export const EXIT_USAGE = 64;

class UsageError extends Error {}

const USAGE = `usage:
  nyorori run --repo <dir> --base <rev> --candidate <rev> --policy <file.json>
              [--cccc <bin>] [--out <dir>] [--artifacts <dir>] [--pr <pr.json>]
              [--comments <comments.json>] [--policy-revision <rev>] [--runner-commit <sha>]
              [--in-process] [--allow-repo-paths]
      The policy, measurer, outputs and artifacts must live outside --repo (spec 10.2);
      --allow-repo-paths lifts that for fixtures. Local results carry authority "local":
      they are not merge approvals. NYORORI_WORKER_COMMAND (JSON argv prefix, e.g. a
      "docker run" line) wraps the analysis worker in a container; see docs/operations.md.
  nyorori fixtures [--cccc <bin>] [--dir <fixtures dir>]
  nyorori replay --repo <dir> --pairs <pairs.json> --policy <file.json> --out <dir> [...]  (see: nyorori replay --help)
  nyorori serve [--port <n>]   (env: NYORORI_APP_ID, NYORORI_WEBHOOK_SECRET, NYORORI_POLICY, NYORORI_CCCC,
                                NYORORI_WORKDIR, NYORORI_LEDGER, NYORORI_SIGNER=file|command with
                                NYORORI_PRIVATE_KEY_PATH or NYORORI_SIGNER_COMMAND[/_ENV/_TIMEOUT_MS/_KID],
                                NYORORI_WORKER_COMMAND[/_MODULE/_TIMEOUT_MS])

exit codes: 0 PASS/N/A/waived · 1 FAIL · 2 INCONCLUSIVE · 64 usage error`;

function ccccFrom(flag: string | undefined): string {
  const bin = flag ?? process.env.NYORORI_CCCC ?? "cccc";
  return bin;
}

function required(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw new UsageError(`--${name} is required`);
  return v;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      candidate: { type: "string" },
      policy: { type: "string" },
      cccc: { type: "string" },
      out: { type: "string" },
      artifacts: { type: "string" },
      pr: { type: "string" },
      comments: { type: "string" },
      "policy-revision": { type: "string" },
      "runner-commit": { type: "string" },
      workdir: { type: "string" },
      "in-process": { type: "boolean", default: false },
      "allow-repo-paths": { type: "boolean", default: false },
    },
    strict: true,
  });
  const repoDir = resolve(required(values, "repo"));
  if (!statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--repo ${repoDir} is not a directory`);
  const ccccBinary = ccccFrom(values.cccc);
  const workDir = values.workdir ?? join(tmpdir(), "nyorori");
  if (!values["allow-repo-paths"]) {
    const items = [
      { label: "policy", path: required(values, "policy") },
      { label: "cccc binary", path: ccccBinary },
      { label: "work dir", path: workDir },
      ...(values.out ? [{ label: "--out", path: values.out }] : []),
      ...(values.artifacts ? [{ label: "--artifacts", path: values.artifacts }] : []),
    ];
    try {
      await assertToolsOutsideRepo(repoDir, items);
    } catch (e) {
      if (e instanceof RepoPathError) throw new UsageError(e.message);
      throw e;
    }
  }
  const loaded = await loadPolicy(required(values, "policy"), values["policy-revision"] ? { revision: values["policy-revision"] } : {});
  const pr = values.pr ? await readJson<PullRequestContext>(values.pr) : undefined;
  const comments = values.comments ? await readJson<PullRequestContext["comments"]>(values.comments) : undefined;
  const prContext: PullRequestContext | undefined =
    pr || comments
      ? { ...(pr ?? { comments: [], identity: { prAuthor: "", commits: [], agentInvokers: [] } }), ...(comments ? { comments } : {}) }
      : undefined;
  const options: RunGatesOptions = {
    repoDir,
    base: required(values, "base"),
    candidate: required(values, "candidate"),
    policy: loaded.policy,
    policyRevision: loaded.revision,
    ccccBinary,
    workDir,
    runnerCommit: values["runner-commit"] ?? process.env.NYORORI_RUNNER_COMMIT ?? "local",
    authority: "local",
    allowRepoPaths: values["allow-repo-paths"],
    ...(values.artifacts ? { artifacts: await loadArtifactDir(values.artifacts) } : {}),
    ...(prContext ? { pr: prContext } : {}),
  };
  // The isolated worker is the production path; --in-process keeps stack traces for debugging.
  const out = values["in-process"] ? await runGates(options) : await runGatesIsolated(options, isolationFromEnv());
  if (values.out) await writeRunOutputs(values.out, out);
  process.stdout.write(out.summaryMarkdown + "\n");
  return EXIT_CODE[out.verdict.state];
}

async function cmdFixtures(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { cccc: { type: "string" }, dir: { type: "string" } }, strict: true });
  const r = await checkCalculationRules(ccccFrom(values.cccc), ...(values.dir ? [values.dir] : []));
  for (const d of r.drifts) process.stdout.write(`DRIFT ${d.file}\n  expected ${JSON.stringify(d.expected)}\n  actual   ${JSON.stringify(d.actual)}\n`);
  for (const u of r.unpaired) process.stdout.write(`UNPAIRED ${u}\n`);
  process.stdout.write(`${r.checked} fixtures, ${r.drifts.length} drift(s)\n`);
  return r.drifts.length === 0 && r.unpaired.length === 0 ? 0 : 1;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new UsageError(`${name} is not set`);
  return v;
}

/** JSON array of strings from an environment variable, or a usage error naming it. */
function envStringArray(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string" && x.length > 0)) throw new UsageError(`${name} must be a JSON array of strings`);
  return parsed as string[];
}

/**
 * Key custody (docs/operations.md 4b). NYORORI_SIGNER=file reads the PEM;
 * NYORORI_SIGNER=command never touches a key file: the signing command gets
 * only PATH plus the variables named in NYORORI_SIGNER_ENV (cloud credentials
 * for the KMS CLI), and NYORORI_SIGNER_TIMEOUT_MS bounds each signature.
 */
export async function signerFromEnv(): Promise<AppJwtSigner> {
  const kind = process.env.NYORORI_SIGNER ?? "file";
  if (kind === "file") {
    return createSigner({ kind: "file", privateKeyPem: await readFile(env("NYORORI_PRIVATE_KEY_PATH"), "utf8") });
  }
  if (kind !== "command") throw new UsageError("NYORORI_SIGNER must be \"file\" or \"command\"");
  const argv = envStringArray("NYORORI_SIGNER_COMMAND");
  if (!argv || argv.length === 0) throw new UsageError("NYORORI_SIGNER=command needs NYORORI_SIGNER_COMMAND (JSON argv)");
  // The allowlist goes through signerEnvironment so the denylist (NYORORI_*,
  // tokens, secrets) holds even when an operator names one of them.
  const forwarded = signerEnvironment(envStringArray("NYORORI_SIGNER_ENV") ?? []);
  const timeoutRaw = process.env.NYORORI_SIGNER_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new UsageError("NYORORI_SIGNER_TIMEOUT_MS must be a positive integer");
  return new CommandSigner({
    argv,
    env: forwarded,
    ...(process.env.NYORORI_SIGNER_KID ? { kid: process.env.NYORORI_SIGNER_KID } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

async function cmdServe(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8080" } }, strict: true });
  const appId = Number(env("NYORORI_APP_ID"));
  if (!Number.isInteger(appId)) throw new UsageError("NYORORI_APP_ID must be an integer");
  const loaded = await loadPolicy(env("NYORORI_POLICY"));
  const signer = await signerFromEnv();
  const api = new GitHubApi({ appId, signer });
  const log = (msg: string, extra?: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ msg, ...extra })}\n`);
  const workDir = process.env.NYORORI_WORKDIR ?? join(tmpdir(), "nyorori-service");
  const ledgerPath = process.env.NYORORI_LEDGER ?? join(workDir, "waivers.jsonl");
  // Mirrors of judged repositories live under the work dir; nothing the gate trusts may sit in one.
  try {
    await assertToolsOutsideRepo(join(workDir, "mirrors"), [
      { label: "policy", path: env("NYORORI_POLICY") },
      { label: "cccc binary", path: env("NYORORI_CCCC") },
      { label: "ledger", path: ledgerPath },
    ]);
  } catch (e) {
    if (e instanceof RepoPathError) throw new UsageError(e.message);
    throw e;
  }
  const ledger = new FileLedgerStore(ledgerPath);
  const verdicts = new VerdictStore(join(workDir, "verdicts"));
  const issued = new IssuedDebtStore(join(workDir, "debt-issues.json"));
  const evaluate = createServiceEvaluator({
    api,
    policy: loaded.policy,
    policyRevision: loaded.revision,
    ccccBinary: env("NYORORI_CCCC"),
    workDir,
    runnerCommit: process.env.NYORORI_RUNNER_COMMIT ?? "service",
    log,
    ledger,
    verdicts,
    isolation: isolationFromEnv(),
  });
  const onMerged = async (m: MergedPullRequest) => {
    const r = await recordMergedPullRequest({ client: api, ledger, verdicts, issued, policy: loaded.policy, log }, m);
    log("merge recorded", { repo: m.repo, pr: m.pr, ...r });
  };
  // Durable job journal: deliveries queued or running at the last shutdown are replayed, old ones pruned.
  const journal = new JobJournal(join(workDir, "jobs"));
  const deliveries = new FileDeliveryStore(join(workDir, "deliveries.log"));
  const deps: ServiceDeps = { client: api, appId, evaluate, log, policyRevision: loaded.revision, onMerged, journal, waits: journal };
  const replayed = await replayPendingJobs(deps, journal);
  const pruned = await journal.prune(30 * 24 * 60 * 60 * 1000);
  log("journal", { ...replayed, pruned });
  // Parked evaluations (waiting for test evidence) expire or resume even when a workflow_run webhook is lost.
  const sweeper = setInterval(() => sweepWaiting(deps).catch((e) => log("sweep failed", { error: String(e) })), 60_000);
  sweeper.unref();
  const server = createWebhookServer({
    secret: env("NYORORI_WEBHOOK_SECRET"),
    dispatch: (event, payload, delivery) => dispatchEvent(deps, event, payload, delivery),
    deliveries,
    health: () => ({ ok: true, policy_revision: loaded.revision, runner_commit: process.env.NYORORI_RUNNER_COMMIT ?? "service" }),
    log,
  });
  await new Promise<void>((done) => server.listen(Number(values.port), done));
  log("listening", { port: Number(values.port) });
  await new Promise<void>((done) => server.on("close", done));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(rest);
      case "fixtures":
        return await cmdFixtures(rest);
      case "replay":
        return await replayCommand(rest);
      case "serve":
        return await cmdServe(rest);
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE + "\n");
        return 0;
      default:
        throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const usage = e instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"));
    process.stderr.write(`nyorori: ${errorMessage(e)}\n${usage ? USAGE + "\n" : ""}`);
    // Anything that is not a usage error is a gate that could not run: never a pass.
    return usage ? EXIT_USAGE : EXIT_CODE.INCONCLUSIVE;
  }
}

// npm installs the bin as a symlink, so compare real paths.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`nyorori: ${String(e)}\n`);
      process.exitCode = EXIT_CODE.INCONCLUSIVE;
    },
  );
}
