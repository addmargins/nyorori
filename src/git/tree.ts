// Materializes measurement trees straight from git blobs (spec 6.2). Using
// `cat-file --batch` instead of checkout/archive means the candidate's
// .gitattributes (working-tree-encoding, filter, export-ignore, eol) cannot
// change which bytes cccc sees.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Inconclusive, Manifest, Side } from "../types.js";
import { isInvalidPath } from "./exec.js";
import { batchCheck, listTree, MODE_EXECUTABLE, MODE_REGULAR, readBlobsBatched } from "./manifest.js";

export interface MaterializedFile {
  /** Repository path. */
  path: string;
  /** Path under the tree root handed to cccc. */
  measuredPath: string;
  blob: string;
  bytes: number;
  lineCount: number;
  /** UTF-8 decoding of the content (lossy for invalid encodings). */
  text: string;
}

/** Rejects paths that could escape the tree root or confuse the measurer. */
export function assertSafeRelativePath(p: string): void {
  if (p.length === 0 || p.includes("\0") || isAbsolute(p) || p.startsWith("/")) {
    throw new Error(`unsafe path ${JSON.stringify(p)}`);
  }
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`unsafe path ${JSON.stringify(p)}`);
  }
}

/** Number of lines as an editor shows them: a trailing newline does not open a new line. */
export function countLines(content: Buffer | string): number {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

async function writeUnder(root: string, rel: string, content: Buffer): Promise<void> {
  assertSafeRelativePath(rel);
  const target = resolve(root, rel);
  const back = relative(root, target);
  if (back.startsWith("..") || isAbsolute(back) || back.split(sep).includes("..")) {
    throw new Error(`path escapes tree root: ${rel}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: "wx" });
}

export interface MaterializeResult {
  files: MaterializedFile[];
  /** Sides that could not be written (never thrown, so one bad path cannot abort the run). */
  problems: Inconclusive[];
}

/** Writes the manifest's measured blobs for one side; failures become INCONCLUSIVE records. */
export async function materializeSideChecked(
  repoDir: string,
  manifest: Manifest,
  side: Side,
  destDir: string,
): Promise<MaterializeResult> {
  const sides = manifest.entries.flatMap((e) => {
    const s = side === "B" ? e.b : e.c;
    return s && e.measure[side] ? [s] : [];
  });
  await mkdir(destDir, { recursive: true });
  const blobs = await readBlobsBatched(repoDir, sides.map((s) => s.blob));
  const files: MaterializedFile[] = [];
  const problems: Inconclusive[] = [];
  for (const s of sides) {
    const content = blobs.get(s.blob);
    if (!content) throw new Error(`blob ${s.blob} for ${s.path} not returned by git`);
    try {
      await writeUnder(destDir, s.measuredPath, content);
    } catch (e) {
      problems.push({
        reason: (e as NodeJS.ErrnoException).code === "EEXIST" ? "CASE_COLLISION" : "TOOL_ERROR",
        file: s.path,
        detail: `${side}: cannot materialize ${JSON.stringify(s.measuredPath)}: ${(e as Error).message}`,
        authorFixable: (e as NodeJS.ErrnoException).code === "EEXIST",
      });
      continue;
    }
    files.push({
      path: s.path,
      measuredPath: s.measuredPath,
      blob: s.blob,
      bytes: content.length,
      lineCount: countLines(content),
      text: content.toString("utf8"),
    });
  }
  return { files, problems };
}

/** As materializeSideChecked, but throws on the first side that cannot be written. */
export async function materializeSide(
  repoDir: string,
  manifest: Manifest,
  side: Side,
  destDir: string,
): Promise<MaterializedFile[]> {
  const r = await materializeSideChecked(repoDir, manifest, side, destDir);
  if (r.problems.length > 0) throw new Error(r.problems.map((p) => p.detail).join("; "));
  return r.files;
}

export interface FullTreeFile {
  path: string;
  blob: string;
  bytes: number;
}

export interface FullTreeOptions {
  /** Files above this size are skipped (default 2 MiB, the policy default). */
  maxFileBytes?: number;
  /** Called for every file that was filtered in but not written (oversize, invalid path). */
  onSkip?: (path: string, reason: "FILE_TOO_LARGE" | "INVALID_ENCODING") => void;
}

/**
 * Writes every regular file of a commit accepted by `filter` (G3 needs the
 * whole module graph, not just the changed files). Symlinks and submodules are
 * never written, so resolution cannot follow them out of the tree.
 */
export async function materializeFullTree(
  repoDir: string,
  sha: string,
  destDir: string,
  filter: (path: string) => boolean,
  opts: FullTreeOptions = {},
): Promise<FullTreeFile[]> {
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const tree = await listTree(repoDir, sha);
  const candidates = [...tree.entries()].filter(
    ([p, t]) => t.type === "blob" && (t.mode === MODE_REGULAR || t.mode === MODE_EXECUTABLE) && filter(p),
  );
  const chosen: typeof candidates = [];
  for (const c of candidates) {
    if (isInvalidPath(c[0])) opts.onSkip?.(c[0], "INVALID_ENCODING");
    else chosen.push(c);
  }
  const sizes = await batchCheck(repoDir, [...new Set(chosen.map(([, t]) => t.blob))]);
  const fitting = chosen.filter(([p, t]) => {
    const ok = (sizes.get(t.blob)?.size ?? 0) <= maxBytes;
    if (!ok) opts.onSkip?.(p, "FILE_TOO_LARGE");
    return ok;
  });
  await mkdir(destDir, { recursive: true });
  const blobs = await readBlobsBatched(repoDir, fitting.map(([, t]) => t.blob));
  const out: FullTreeFile[] = [];
  for (const [p, t] of fitting) {
    const content = blobs.get(t.blob)!;
    await writeUnder(destDir, p, content);
    out.push({ path: p, blob: t.blob, bytes: content.length });
  }
  return out;
}

export function treePath(root: string, rel: string): string {
  assertSafeRelativePath(rel);
  return join(root, rel);
}
