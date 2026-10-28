// B→C line correspondence from `git diff -U0` (spec 5.4). Each file pair is
// diffed blob-to-blob, which sidesteps path quoting and keeps the candidate's
// .gitattributes (diff drivers, `-diff`, textconv) out of the result.

import type { FileLineMap, Hunk, Manifest } from "../types.js";
import { git } from "./exec.js";

/** git's well-known empty blob; always resolvable, even if not stored. */
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

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

/** Every C line that is new or rewritten. */
export function addedCLines(map: Pick<FileLineMap, "hunks">): Set<number> {
  const out = new Set<number>();
  for (const h of map.hunks) for (let i = 0; i < h.cCount; i++) out.add(h.cStart + i);
  return out;
}

/** Every B line that was removed or rewritten. */
export function removedBLines(map: Pick<FileLineMap, "hunks">): Set<number> {
  const out = new Set<number>();
  for (const h of map.hunks) for (let i = 0; i < h.bCount; i++) out.add(h.bStart + i);
  return out;
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
  const out = await git(repoDir, [
    "diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv",
    "--diff-algorithm=myers", "--indent-heuristic", "--no-prefix",
    blobB ?? EMPTY_BLOB, blobC ?? EMPTY_BLOB,
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
