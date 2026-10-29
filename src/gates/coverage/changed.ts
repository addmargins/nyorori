// Changed C-side lines per file, from `git diff -U0` hunks (spec 5.4 data).

import type { FileLineMap, Hunk } from "../../types.js";

export function changedLinesFromHunks(hunks: readonly Hunk[]): Set<number> {
  const out = new Set<number>();
  for (const h of hunks) for (let l = h.cStart; l < h.cStart + h.cCount; l++) out.add(l);
  return out;
}

export function allLines(lineCount: number): Set<number> {
  const out = new Set<number>();
  for (let l = 1; l <= lineCount; l++) out.add(l);
  return out;
}

export function lineCountOf(source: string): number {
  if (source === "") return 0;
  const n = source.split("\n").length;
  return source.endsWith("\n") ? n - 1 : n;
}

export function overlaps(range: { start: number; end: number }, lines: ReadonlySet<number>): boolean {
  if (lines.size === 0) return false;
  if (range.end - range.start + 1 < lines.size) {
    for (let l = range.start; l <= range.end; l++) if (lines.has(l)) return true;
    return false;
  }
  for (const l of lines) if (l >= range.start && l <= range.end) return true;
  return false;
}

/** Index line maps by C path. */
export function lineMapsByC(maps: readonly FileLineMap[]): Map<string, FileLineMap> {
  return new Map(maps.map((m) => [m.pathC, m]));
}
