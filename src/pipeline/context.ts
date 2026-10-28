// State shared by the gate steps of one run, computed once from git.

import { createRequire } from "node:module";
import { batchCheck, listTree, readBlobs, type TreeEntry } from "../git/manifest.js";
import type { Policy } from "../policy/schema.js";
import type { FileLineMap, Manifest, MeasurementFingerprint } from "../types.js";
import type { RunGatesOptions } from "./types.js";

export interface RunContext {
  opts: RunGatesOptions;
  policy: Policy;
  manifest: Manifest;
  lineMaps: FileLineMap[];
  treeC: Map<string, TreeEntry>;
  /** UTF-8 text of every changed path on each side (within the size cap), keyed by repository path. */
  textsB: Map<string, string>;
  textsC: Map<string, string>;
  /** Fingerprint for gates that do not run cccc. */
  fingerprint: MeasurementFingerprint;
  tools: Record<string, string>;
}

const require = createRequire(import.meta.url);

function versionOf(pkg: string): string {
  try {
    return (require(`${pkg}/package.json`) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Pinned tool versions recorded in every fingerprint (spec 6.1). */
export function toolVersions(): Record<string, string> {
  return {
    eslint: versionOf("eslint"),
    "typescript-eslint": versionOf("typescript-eslint"),
    typescript: versionOf("typescript"),
    "dependency-cruiser": versionOf("dependency-cruiser"),
    prettier: versionOf("prettier"),
  };
}

/** Reads both sides of every changed entry so the test, config and AI-loop checks see non-code files too. */
export async function readChangedTexts(
  repoDir: string,
  manifest: Manifest,
  maxBytes: number,
): Promise<{ B: Map<string, string>; C: Map<string, string> }> {
  const want = (side: "b" | "c") =>
    manifest.entries.flatMap((e) => {
      const s = e[side];
      return s && (s.mode === "100644" || s.mode === "100755") ? [s] : [];
    });
  const sidesB = want("b");
  const sidesC = want("c");
  const all = [...new Set([...sidesB, ...sidesC].map((s) => s.blob))];
  const sizes = await batchCheck(repoDir, all);
  const blobs = await readBlobs(repoDir, all.filter((b) => (sizes.get(b)?.size ?? Infinity) <= maxBytes));
  const toMap = (sides: typeof sidesB) => {
    const m = new Map<string, string>();
    for (const s of sides) {
      const buf = blobs.get(s.blob);
      if (buf && buf.length <= maxBytes) m.set(s.path, buf.toString("utf8"));
    }
    return m;
  };
  return { B: toMap(sidesB), C: toMap(sidesC) };
}

export async function candidateTree(repoDir: string, sha: string): Promise<Map<string, TreeEntry>> {
  return listTree(repoDir, sha);
}

export function candidateBlobLookup(tree: Map<string, TreeEntry>): (path: string) => string | null {
  return (path) => tree.get(path)?.blob ?? null;
}
