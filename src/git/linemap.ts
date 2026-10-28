// B→C line correspondence from `git diff -U0` (spec 5.4). Each file pair is
// diffed blob-to-blob, which sidesteps path quoting and keeps the candidate's
// .gitattributes (diff drivers, `-diff`, textconv) out of the result.

import type { FileLineMap, Hunk, Manifest } from "../types.js";
import { git } from "./exec.js";
import { readBlobs } from "./manifest.js";
import { countLines } from "./tree.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses hunk headers of a unified diff. Only headers matter at -U0. */
export function parseUnifiedZeroDiff(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("@@ ")) continue;
    const m = HUNK_RE.exec(line);
    if (!m) throw new Error(`malformed hunk header ${JSON.stringify(line)}`);
    hunks.push({
      bStart: Number(m[1]),
      bCount: m[2] === undefined ? 1 : Number(m[2]),
      cStart: Number(m[3]),
      cCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks.sort((a, b) => a.bStart - b.bStart || a.cStart - b.cStart);
}

/** Whether a hunk lies entirely before B line `bLine` (so it shifts it). */
function beforeB(h: Hunk, bLine: number): boolean {
  return h.bCount > 0 ? h.bStart + h.bCount - 1 < bLine : h.bStart < bLine;
}

/** C line of an unchanged B line; undefined when the line was removed or rewritten. */
export function mapLine(map: Pick<FileLineMap, "hunks">, bLine: number): number | undefined {
  let delta = 0;
  for (const h of map.hunks) {
    if (h.bCount > 0 && bLine >= h.bStart && bLine < h.bStart + h.bCount) return undefined;
    if (beforeB(h, bLine)) delta += h.cCount - h.bCount;
    else break;
  }
  return bLine + delta;
}

/** Index of the hunk that removed/rewrote B line `bLine`, or -1. */
export function hunkOfB(map: Pick<FileLineMap, "hunks">, bLine: number): number {
  return map.hunks.findIndex((h) => h.bCount > 0 && bLine >= h.bStart && bLine < h.bStart + h.bCount);
}

/** Index of the hunk that added/rewrote C line `cLine`, or -1. */
export function hunkOfC(map: Pick<FileLineMap, "hunks">, cLine: number): number {
  return map.hunks.findIndex((h) => h.cCount > 0 && cLine >= h.cStart && cLine < h.cStart + h.cCount);
}

/** Whether any changed C line falls in [start, end]. */
export function cRangeTouched(map: Pick<FileLineMap, "hunks">, start: number, end: number): boolean {
  return map.hunks.some((h) => {
    if (h.cCount > 0) return h.cStart <= end && h.cStart + h.cCount - 1 >= start;
    // Pure deletion: lines vanished between C line cStart and cStart+1.
    return h.cStart >= start && h.cStart < end;
  });
}

export async function blobLineDiff(repoDir: string, blobB: string | null, blobC: string | null): Promise<Hunk[]> {
  if (blobB === null || blobC === null) {
    const only = (blobB ?? blobC)!;
    const n = countLines((await readBlobs(repoDir, [only])).get(only)!);
    if (n === 0) return [];
    return blobB === null
      ? [{ bStart: 0, bCount: 0, cStart: 1, cCount: n }]
      : [{ bStart: 1, bCount: n, cStart: 0, cCount: 0 }];
  }
  const out = await git(repoDir, [
    "diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv",
    "--diff-algorithm=myers", "--indent-heuristic", "--no-prefix", blobB, blobC,
  ]);
  return parseUnifiedZeroDiff(out.toString("utf8"));
}

/**
 * Line maps for every manifest entry with a measured side. Added files get a
 * single hunk covering the whole file; deleted files a single removal hunk.
 */
export async function fileLineMaps(repoDir: string, manifest: Manifest, concurrency = 8): Promise<FileLineMap[]> {
  const todo = manifest.entries.filter((e) => e.measure.B || e.measure.C);
  const out: FileLineMap[] = new Array(todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = next++;
      const e = todo[i]!;
      const blobB = e.b?.blob ?? null;
      const blobC = e.c?.blob ?? null;
      const hunks = blobB === blobC ? [] : await blobLineDiff(repoDir, blobB, blobC);
      out[i] = { pathB: e.b?.path ?? "", pathC: e.c?.path ?? "", hunks };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}
