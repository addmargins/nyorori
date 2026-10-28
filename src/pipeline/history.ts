// First-parent history of the base branch, read once per run for the moving
// baseline (spec 7.5). One `git log --name-status` over a bounded window
// replaces three `git log … -- <path>` calls per changed file.

import { gitText } from "../git/exec.js";

export interface HistoryCommit {
  sha: string;
  /** Committer time, seconds since the epoch. */
  time: number;
  /** Path → status letter (A, M, D, R…) for the files this commit touched. */
  touched: Map<string, string>;
}

/** Newest first; index 0 is the base commit itself. */
export type FirstParentHistory = HistoryCommit[];

/** Commits scanned at most; beyond this a baseline older than the window is simply not chosen. */
export const MAX_HISTORY_COMMITS = 20_000;

const RECORD = "\u0001";

/**
 * Parses `git log --first-parent --name-status -z --format=<RECORD>%H %ct`.
 * With `-z` every token is NUL-separated: "<sha> <time>\0\n" then
 * "<status>\0<path>\0" per file (a rename/copy carries "<status>\0<old>\0<new>\0").
 */
export function parseHistory(out: string): FirstParentHistory {
  const commits: FirstParentHistory = [];
  for (const block of out.split(RECORD)) {
    if (!block.trim()) continue;
    const tokens = block.split("\0").map((t, i) => (i === 1 ? t.replace(/^\n/, "") : t));
    const [sha, time] = (tokens[0] ?? "").trim().split(" ");
    if (!sha || !time) continue;
    const touched = new Map<string, string>();
    const fields = tokens.slice(1).filter((t) => t.length > 0);
    for (let i = 0; i < fields.length; ) {
      const status = fields[i]!;
      const path = fields[i + 1];
      if (path === undefined) break;
      if (status.startsWith("R") || status.startsWith("C")) {
        const dest = fields[i + 2];
        touched.set(path, status.startsWith("R") ? "D" : "M");
        if (dest !== undefined) touched.set(dest, status.charAt(0));
        i += 3;
      } else {
        touched.set(path, status.charAt(0));
        i += 2;
      }
    }
    commits.push({ sha, time: Number(time), touched });
  }
  return commits;
}

export async function readFirstParentHistory(repoDir: string, base: string, maxCommits = MAX_HISTORY_COMMITS): Promise<FirstParentHistory> {
  const out = await gitText(repoDir, [
    "log", "--first-parent", `-n${maxCommits}`, "--name-status", "-z", "--no-renames",
    `--format=${RECORD}%H %ct`, base,
  ], { maxBuffer: 1024 * 1024 * 1024 });
  return parseHistory(out);
}

export interface BaselineCandidates {
  /** The run's B. */
  base: string;
  /** The `lookbackMerges`-th most recent first-parent commit touching the file (the oldest one seen if fewer). */
  nthTouch: string | null;
  /** The latest first-parent commit at least `lookbackDays` older than B. */
  beforeCutoff: string | null;
  /** The first-parent commit that (most recently) added the file: the baseline is never older. */
  creation: string | null;
}

/** Index of each commit in the (newest-first) history: a larger index is an older commit. */
export function historyIndex(h: FirstParentHistory): Map<string, number> {
  return new Map(h.map((c, i) => [c.sha, i]));
}

/** Latest commit whose time is at or before `baseTime − lookbackDays`; computed once for the run. */
export function cutoffCommit(h: FirstParentHistory, lookbackDays: number): string | null {
  const baseTime = h[0]?.time ?? 0;
  const cutoff = baseTime - lookbackDays * 86_400;
  return h.find((c) => c.time <= cutoff)?.sha ?? null;
}

export function candidatesFor(h: FirstParentHistory, path: string, lookbackMerges: number, beforeCutoff: string | null): BaselineCandidates {
  const touches: string[] = [];
  let creation: string | null = null;
  for (const c of h) {
    const status = c.touched.get(path);
    if (status === undefined) continue;
    touches.push(c.sha);
    if (status === "A") {
      creation = c.sha;
      break; // nothing before the (most recent) creation matters
    }
  }
  const nthTouch = touches.length === 0 ? null : touches[Math.min(lookbackMerges, touches.length) - 1]!;
  return { base: h[0]?.sha ?? "", nthTouch, beforeCutoff, creation };
}

/**
 * The older of the two lookback candidates, clamped to the file's creation.
 * Null when the pick would be B itself. `index` orders commits newest-first.
 */
export function chooseBaseline(c: BaselineCandidates, index: ReadonlyMap<string, number>): string | null {
  const older = (x: string, y: string) => (index.get(x) ?? -1) >= (index.get(y) ?? -1);
  let pick: string | null;
  if (c.nthTouch && c.beforeCutoff) pick = older(c.nthTouch, c.beforeCutoff) ? c.nthTouch : c.beforeCutoff;
  else pick = c.nthTouch ?? c.beforeCutoff;
  if (pick && c.creation && pick !== c.creation && older(pick, c.creation)) pick = c.creation;
  return pick && pick !== c.base ? pick : null;
}
