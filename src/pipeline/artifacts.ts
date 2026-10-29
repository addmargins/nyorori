// Turns the entries of a required-workflow artifact into gate inputs. Runs in
// the isolated worker; the parent never inflates PR-produced bytes.

import { readFile } from "node:fs/promises";
import type { ArtifactProvenance } from "../aggregate/index.js";
import { readZip } from "../service/zip.js";
import type { ArtifactZip, Artifacts } from "./types.js";

/** Entry names the gates read; anything else in the archive is never inflated. */
export const ARTIFACT_ENTRIES: ReadonlySet<string> = new Set([
  "metadata.json",
  "tests.B.json",
  "tests.C.json",
  "tests.C.rc",
  "changed.txt",
  "coverage/coverage-final.json",
  "coverage-meta.json",
  "mutation.json",
]);

const text = (files: ReadonlyMap<string, Buffer>, name: string) => files.get(name)?.toString("utf8");

export function artifactsFromEntries(files: ReadonlyMap<string, Buffer>, provenance: ArtifactProvenance): Artifacts {
  let meta: { root_dir?: unknown; candidate_sha?: unknown } = {};
  try {
    meta = JSON.parse(text(files, "metadata.json") ?? "{}") as typeof meta;
  } catch {
    meta = {};
  }
  const rootDir = typeof meta.root_dir === "string" ? meta.root_dir : undefined;
  // A pull_request run reports the PR head as head_sha; the commit it tested
  // (refs/pull/N/merge) is only in its metadata, and must equal C (spec 6.2).
  const prov: ArtifactProvenance =
    provenance.event === "pull_request" && typeof meta.candidate_sha === "string"
      ? { ...provenance, testMergeSha: meta.candidate_sha }
      : provenance;
  const common = { provenance: prov, ...(rootDir ? { rootDir } : {}) };
  const out: Artifacts = {};
  const testsC = text(files, "tests.C.json");
  if (testsC !== undefined) {
    const testsB = text(files, "tests.B.json");
    out.tests = { reportC: testsC, ...(testsB !== undefined ? { reportB: testsB } : {}), ...common };
  }
  const cov = text(files, "coverage/coverage-final.json");
  if (cov !== undefined) out.coverage = { coverageFinal: cov, meta: text(files, "coverage-meta.json") ?? "", ...common };
  const mut = text(files, "mutation.json");
  if (mut !== undefined) out.mutation = { report: mut, ...common };
  return out;
}

/** Parses a downloaded archive with the service's zip limits; throws ZipError on a hostile archive. */
export async function artifactsFromZip(zip: ArtifactZip): Promise<Artifacts> {
  const files = readZip(await readFile(zip.path), (n) => ARTIFACT_ENTRIES.has(n));
  return artifactsFromEntries(files, zip.provenance);
}
