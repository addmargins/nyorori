// State shared by the gate steps of one run, computed once from git.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * package.json locations of the pinned tools, resolved with literal specifiers
 * (the gate's own dynamic-code rule would flag a computed require).
 */
const TOOL_PACKAGES: ReadonlyArray<readonly [string, () => string]> = [
  ["eslint", () => require.resolve("eslint/package.json")],
  ["typescript-eslint", () => require.resolve("typescript-eslint/package.json")],
  ["typescript", () => require.resolve("typescript/package.json")],
  // dependency-cruiser does not export its package.json: walk up from its entry point.
  ["dependency-cruiser", () => packageJsonAbove(fileURLToPath(import.meta.resolve("dependency-cruiser")), "dependency-cruiser")],
  ["prettier", () => require.resolve("prettier/package.json")],
];

function packageJsonAbove(entry: string, name: string): string {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate) && (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === name) return candidate;
  }
  throw new Error(`package.json of ${name} not found`);
}

function versionAt(resolvePath: () => string): string {
  try {
    return (JSON.parse(readFileSync(resolvePath(), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Pinned tool versions recorded in every fingerprint (spec 6.1). */
export function toolVersions(): Record<string, string> {
  return Object.fromEntries(TOOL_PACKAGES.map(([name, at]) => [name, versionAt(at)]));
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
