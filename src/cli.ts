#!/usr/bin/env node
// nyorori command line: `run` one gate evaluation, check the measurer against
// the calculation-rule `fixtures`, or `serve` the GitHub App webhook.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ArtifactProvenance } from "./aggregate/index.js";
import { checkCalculationRules } from "./fixtures/rules.js";
import { runGates } from "./pipeline/run.js";
import type { Artifacts, PullRequestContext, RunGatesOutput } from "./pipeline/types.js";
import { loadPolicy } from "./policy/load.js";
import { dispatchEvent } from "./service/handlers.js";
import { createServiceEvaluator } from "./service/evaluator.js";
import { GitHubApi } from "./service/github.js";
import { createWebhookServer } from "./service/http.js";
import { EXIT_CODE } from "./types.js";

/** Usage errors use EX_USAGE so they are never confused with FAIL (1) or INCONCLUSIVE (2). */
export const EXIT_USAGE = 64;

class UsageError extends Error {}

const USAGE = `usage:
  nyorori run --repo <dir> --base <rev> --candidate <rev> --policy <file.json>
              [--cccc <bin>] [--out <dir>] [--artifacts <dir>] [--pr <pr.json>]
              [--comments <comments.json>] [--policy-revision <rev>] [--runner-commit <sha>]
  nyorori fixtures [--cccc <bin>] [--dir <fixtures dir>]
  nyorori serve [--port <n>]   (env: NYORORI_APP_ID, NYORORI_PRIVATE_KEY_PATH,
                                NYORORI_WEBHOOK_SECRET, NYORORI_POLICY, NYORORI_CCCC, NYORORI_WORKDIR)

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

async function optionalText(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

/**
 * Same layout as the required workflow's artifact (tests.C.json, tests.B.json,
 * coverage/coverage-final.json, coverage-meta.json, mutation.json,
 * metadata.json). provenance.json is a local stand-in for the provenance the
 * service reads from the GitHub API; without it no artifact can make a gate pass.
 */
async function loadArtifacts(dir: string): Promise<Artifacts> {
  const provPath = join(dir, "provenance.json");
  const provenance = existsSync(provPath) ? await readJson<ArtifactProvenance>(provPath) : undefined;
  const meta = await optionalText(join(dir, "metadata.json"));
  const rootDir = meta ? (JSON.parse(meta) as { root_dir?: string }).root_dir : undefined;
  const common = { ...(provenance ? { provenance } : {}), ...(rootDir ? { rootDir } : {}) };
  const out: Artifacts = {};
  const testsC = await optionalText(join(dir, "tests.C.json"));
  if (testsC !== undefined) {
    const testsB = await optionalText(join(dir, "tests.B.json"));
    out.tests = { reportC: testsC, ...(testsB !== undefined ? { reportB: testsB } : {}), ...common };
  }
  const cov = await optionalText(join(dir, "coverage", "coverage-final.json"));
  if (cov !== undefined) out.coverage = { coverageFinal: cov, meta: (await optionalText(join(dir, "coverage-meta.json"))) ?? "", ...common };
  const mut = await optionalText(join(dir, "mutation.json"));
  if (mut !== undefined) out.mutation = { report: mut, ...common };
  return out;
}

async function writeOutputs(dir: string, out: RunGatesOutput): Promise<void> {
  await mkdir(dir, { recursive: true });
  const w = (name: string, data: string | Buffer) => writeFile(join(dir, name), data);
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  await w("manifest.json", json(out.manifest));
  const bySide: Record<string, number> = {};
  for (const run of out.ccccRuns) {
    const n = (bySide[run.side] = (bySide[run.side] ?? 0) + 1);
    const suffix = n === 1 ? "" : `.${n}`;
    await w(`raw.${run.side}${suffix}.json`, run.stdout);
    await w(`raw.${run.side}${suffix}.stderr`, run.stderr);
  }
  for (const r of out.results) await w(`gate-result.${r.gate}.json`, json(r));
  await w("quality-gate.json", json(out.verdict));
  await w("gate-summary.md", out.summaryMarkdown + "\n");
  await w("gate-feedback.json", json(out.feedback));
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
    },
    strict: true,
  });
  const loaded = await loadPolicy(required(values, "policy"), values["policy-revision"] ? { revision: values["policy-revision"] } : {});
  const pr = values.pr ? await readJson<PullRequestContext>(values.pr) : undefined;
  const comments = values.comments ? await readJson<PullRequestContext["comments"]>(values.comments) : undefined;
  const prContext: PullRequestContext | undefined =
    pr || comments
      ? { ...(pr ?? { comments: [], identity: { prAuthor: "", commits: [], agentInvokers: [] } }), ...(comments ? { comments } : {}) }
      : undefined;
  const out = await runGates({
    repoDir: resolve(required(values, "repo")),
    base: required(values, "base"),
    candidate: required(values, "candidate"),
    policy: loaded.policy,
    policyRevision: loaded.revision,
    ccccBinary: ccccFrom(values.cccc),
    workDir: values.workdir ?? join(tmpdir(), "nyorori"),
    runnerCommit: values["runner-commit"] ?? process.env.NYORORI_RUNNER_COMMIT ?? "local",
    ...(values.artifacts ? { artifacts: await loadArtifacts(values.artifacts) } : {}),
    ...(prContext ? { pr: prContext } : {}),
  });
  if (values.out) await writeOutputs(values.out, out);
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

async function cmdServe(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8080" } }, strict: true });
  const appId = Number(env("NYORORI_APP_ID"));
  if (!Number.isInteger(appId)) throw new UsageError("NYORORI_APP_ID must be an integer");
  const loaded = await loadPolicy(env("NYORORI_POLICY"));
  const api = new GitHubApi({ appId, privateKeyPem: await readFile(env("NYORORI_PRIVATE_KEY_PATH"), "utf8") });
  const log = (msg: string, extra?: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ msg, ...extra })}\n`);
  const evaluate = createServiceEvaluator({
    api,
    policy: loaded.policy,
    policyRevision: loaded.revision,
    ccccBinary: env("NYORORI_CCCC"),
    workDir: process.env.NYORORI_WORKDIR ?? join(tmpdir(), "nyorori-service"),
    runnerCommit: process.env.NYORORI_RUNNER_COMMIT ?? "service",
    log,
  });
  const server = createWebhookServer({
    secret: env("NYORORI_WEBHOOK_SECRET"),
    dispatch: (event, payload) => dispatchEvent({ client: api, appId, evaluate, log }, event, payload),
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
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    process.stderr.write(`nyorori: ${(e as Error).message}\n${usage ? USAGE + "\n" : ""}`);
    // Anything that is not a usage error is a gate that could not run: never a pass.
    return usage ? EXIT_USAGE : EXIT_CODE.INCONCLUSIVE;
  }
}

// npm installs the bin as a symlink, so compare real paths.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
