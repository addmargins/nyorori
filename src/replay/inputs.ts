// Per-pair inputs recorded next to the dataset: the PR context, comments and
// required-workflow artifacts of the original run, in the same layouts the
// `run` command accepts (`--pr`, `--comments`, `--artifacts`).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactProvenance } from "../aggregate/index.js";
import type { Artifacts, PullRequestContext } from "../pipeline/types.js";
import type { ResolvedPair } from "./dataset.js";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function optionalText(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

/**
 * Artifact directory layout of the required workflow (tests.C.json, tests.B.json,
 * coverage/coverage-final.json, coverage-meta.json, mutation.json, metadata.json)
 * plus a local provenance.json stand-in. Without provenance an artifact can only
 * block, never pass a gate. Mirrors the `run` command's loader.
 */
export async function loadArtifactDir(dir: string): Promise<Artifacts> {
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

export interface PairInputs {
  pr?: PullRequestContext;
  artifacts?: Artifacts;
  previousAttempt?: string;
}

export async function loadPairInputs(pair: ResolvedPair): Promise<PairInputs> {
  const inputs: PairInputs = {};
  const pr = pair.pr ? await readJson<PullRequestContext>(pair.pr) : undefined;
  const comments = pair.comments ? await readJson<PullRequestContext["comments"]>(pair.comments) : undefined;
  if (pr || comments) {
    inputs.pr = {
      ...(pr ?? { comments: [], identity: { prAuthor: "", commits: [], agentInvokers: [] } }),
      ...(comments ? { comments } : {}),
    };
  }
  if (pair.artifacts) inputs.artifacts = await loadArtifactDir(pair.artifacts);
  if (pair.previousAttempt) inputs.previousAttempt = pair.previousAttempt;
  return inputs;
}
