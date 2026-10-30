// Replay dataset: the (B, C) pairs of recently merged PRs that a measurer or
// policy upgrade is replayed against (spec 6.1 step 2, 13.4 recovery). The
// file and every path it names must live outside the repository under test so
// a PR can never author the dataset that judges the gate.

import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { isObjectId } from "../util/ids.js";
import { errorMessage } from "../util/errors.js";

export const MAX_PAIRS = 1000;

const sha = z
  .string()
  .refine(isObjectId, "must be a full lowercase commit id, 40 or 64 hex digits (no refs, no abbreviations)");

/** Pair ids become output directory names, so they are restricted to a safe charset. */
const pairId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");

/** Paths are relative to the dataset file; absolute paths are accepted. Never empty, never with control characters. */
const relPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => ![...p].some((ch) => ch.charCodeAt(0) < 0x20), "path must not contain control characters");

export const replayPairSchema = z
  .object({
    id: pairId,
    base: sha,
    candidate: sha,
    /** PullRequestContext JSON, same shape as `nyorori run --pr`. */
    pr: relPath.optional(),
    /** Comments JSON, same shape as `nyorori run --comments`. */
    comments: relPath.optional(),
    /** Artifact directory, same layout as `nyorori run --artifacts`. */
    artifacts: relPath.optional(),
    /** AI fix loop only: C_{n-1} (ruling D17). */
    previous_attempt: sha.optional(),
  })
  .strict();

export const replayDatasetSchema = z
  .object({
    schema_version: z.literal(1),
    repository: z.string().min(1).max(256).optional(),
    pairs: z.array(replayPairSchema).min(1).max(MAX_PAIRS),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.pairs.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pairs", i, "id"], message: `duplicate pair id ${p.id}` });
      seen.add(p.id);
      if (p.base === p.candidate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pairs", i], message: "base and candidate are the same commit" });
    });
  });

export type ReplayPair = z.infer<typeof replayPairSchema>;
export type ReplayDataset = z.infer<typeof replayDatasetSchema>;

export class DatasetError extends Error {
  override name = "DatasetError";
}

export function parseDataset(raw: unknown): ReplayDataset {
  const r = replayDatasetSchema.safeParse(raw);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
  throw new DatasetError(`invalid replay dataset:\n  ${issues.join("\n  ")}`);
}

/** A pair with every path resolved to an absolute real path outside the repository. */
export interface ResolvedPair {
  id: string;
  base: string;
  candidate: string;
  pr?: string;
  comments?: string;
  artifacts?: string;
  previousAttempt?: string;
}

export interface LoadedDataset {
  path: string;
  dataset: ReplayDataset;
  pairs: ResolvedPair[];
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** Real path of `p`, following its existing ancestors when `p` itself does not exist yet. */
export async function realpathUpward(p: string): Promise<string> {
  const abs = resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return missing.length ? resolve(real, ...missing) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) throw new DatasetError(`cannot resolve ${abs}`);
      missing.unshift(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}

/** Resolves `p` (absolute or relative to `baseDir`) and refuses anything inside the repository. */
export async function resolveOutsideRepo(p: string, baseDir: string, repoReal: string, what: string): Promise<string> {
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  const real = await realpathUpward(abs);
  if (isWithin(repoReal, real)) throw new DatasetError(`${what} ${p} resolves inside the repository (${repoReal}); replay inputs must live outside it`);
  return real;
}

/** Reads, validates and resolves a dataset file. `repoDir` is the repository the pairs will be measured in. */
export async function loadDataset(path: string, repoDir: string, readText: (p: string) => Promise<string>): Promise<LoadedDataset> {
  const repoReal = await realpath(repoDir);
  const datasetPath = await resolveOutsideRepo(path, process.cwd(), repoReal, "dataset");
  if (!(await stat(datasetPath).catch(() => null))?.isFile()) throw new DatasetError(`dataset ${path} is not a file`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(datasetPath));
  } catch (e) {
    throw new DatasetError(`dataset ${path} is not valid JSON: ${errorMessage(e)}`);
  }
  const dataset = parseDataset(raw);
  const baseDir = dirname(datasetPath);
  const pairs: ResolvedPair[] = [];
  for (const p of dataset.pairs) {
    const r: ResolvedPair = { id: p.id, base: p.base, candidate: p.candidate };
    if (p.pr) r.pr = await resolveOutsideRepo(p.pr, baseDir, repoReal, `pair ${p.id} pr`);
    if (p.comments) r.comments = await resolveOutsideRepo(p.comments, baseDir, repoReal, `pair ${p.id} comments`);
    if (p.artifacts) r.artifacts = await resolveOutsideRepo(p.artifacts, baseDir, repoReal, `pair ${p.id} artifacts`);
    if (p.previous_attempt) r.previousAttempt = p.previous_attempt;
    pairs.push(r);
  }
  return { path: datasetPath, dataset, pairs };
}
