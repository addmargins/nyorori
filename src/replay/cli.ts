// `nyorori replay`: argument parsing and exit codes for the replay driver.
// Self-contained so the main CLI only has to dispatch to it.

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPolicy } from "../policy/load.js";
import { DatasetError } from "./dataset.js";
import { DEFAULT_JOBS, replay } from "./driver.js";

/** Same value as the main CLI's EXIT_USAGE (not imported: cli.ts imports this module). */
const EXIT_USAGE = 64;
const EXIT_ERROR = 2;

export const REPLAY_USAGE = `usage:
  nyorori replay --repo <dir> --pairs <pairs.json> --policy <file.json> --out <dir>
                 [--compare-policy <file.json>] [--compare-cccc <bin>] [--cccc <bin>]
                 [--jobs <n>] [--policy-revision <rev>] [--compare-policy-revision <rev>]
                 [--runner-commit <sha>] [--workdir <dir>] [--quiet]

Replays each (base, candidate) pair of pairs.json through the gates under the
current policy and measurer, and once more under --compare-policy / --compare-cccc
when given. pairs.json, the paths it names and --out must be outside --repo.
For a measurer upgrade keep the Actions gates (tests, coverage, mutation) in
observe mode unless artifacts are supplied; pin the new binary's sha256 in the
comparison policy (spec 6.1: an upgrade is a policy change).

exit codes: 0 no deltas · 1 deltas · 2 run error or G1–G3 INCONCLUSIVE under the
current policy · 64 usage error`;

class ReplayUsageError extends Error {}

function required(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw new ReplayUsageError(`--${name} is required`);
  return v;
}

export async function replayCommand(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        pairs: { type: "string" },
        policy: { type: "string" },
        out: { type: "string" },
        cccc: { type: "string" },
        "compare-policy": { type: "string" },
        "compare-cccc": { type: "string" },
        jobs: { type: "string" },
        "policy-revision": { type: "string" },
        "compare-policy-revision": { type: "string" },
        "runner-commit": { type: "string" },
        workdir: { type: "string" },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values.help) {
      process.stdout.write(REPLAY_USAGE + "\n");
      return 0;
    }
    const jobs = values.jobs === undefined ? DEFAULT_JOBS : Number(values.jobs);
    if (!Number.isInteger(jobs) || jobs < 1) throw new ReplayUsageError(`--jobs must be a positive integer (got ${values.jobs})`);
    const policy = await loadPolicy(required(values, "policy"), values["policy-revision"] ? { revision: values["policy-revision"] } : {});
    const comparePolicy = values["compare-policy"]
      ? await loadPolicy(values["compare-policy"], values["compare-policy-revision"] ? { revision: values["compare-policy-revision"] } : {})
      : undefined;
    const report = await replay({
      repoDir: resolve(required(values, "repo")),
      datasetPath: required(values, "pairs"),
      outDir: required(values, "out"),
      workDir: values.workdir ?? join(tmpdir(), "nyorori-replay"),
      policy,
      ccccBinary: values.cccc ?? process.env.NYORORI_CCCC ?? "cccc",
      ...(comparePolicy ? { comparePolicy } : {}),
      ...(values["compare-cccc"] ? { compareCccc: values["compare-cccc"] } : {}),
      runnerCommit: values["runner-commit"] ?? process.env.NYORORI_RUNNER_COMMIT ?? "local",
      jobs,
      ...(values.quiet ? {} : { log: (line: string) => process.stderr.write(`replay ${line}\n`) }),
    });
    process.stdout.write(`replay: exit ${report.exit_code} — ${report.counts.changed} changed, ${report.counts.errored} errored, ${report.counts.service_inconclusive} service-INCONCLUSIVE of ${report.counts.pairs} pairs; see ${resolve(values.out!)}/replay-summary.md\n`);
    return report.exit_code;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const usage = e instanceof ReplayUsageError || e instanceof DatasetError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"));
    process.stderr.write(`nyorori replay: ${e instanceof Error ? e.message : String(e)}\n${usage ? REPLAY_USAGE + "\n" : ""}`);
    return usage ? EXIT_USAGE : EXIT_ERROR;
  }
}
