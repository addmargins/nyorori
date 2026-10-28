// Materializes measurement trees straight from git blobs (spec 6.2). Using
// `cat-file --batch` instead of checkout/archive means the candidate's
// .gitattributes (working-tree-encoding, filter, export-ignore, eol) cannot
// change which bytes cccc sees.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Manifest, Side } from "../types.js";
import { listTree, MODE_EXECUTABLE, MODE_REGULAR, readBlobs } from "./manifest.js";

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

export async function materializeSide(
  repoDir: string,
  manifest: Manifest,
  side: Side,
  destDir: string,
): Promise<MaterializedFile[]> {
  const sides = manifest.entries.flatMap((e) => {
    const s = side === "B" ? e.b : e.c;
    return s && e.measure[side] ? [s] : [];
  });
  await mkdir(destDir, { recursive: true });
  const blobs = await readBlobs(repoDir, sides.map((s) => s.blob));
  const out: MaterializedFile[] = [];
  for (const s of sides) {
    const content = blobs.get(s.blob);
    if (!content) throw new Error(`blob ${s.blob} for ${s.path} not returned by git`);
    await writeUnder(destDir, s.measuredPath, content);
    out.push({
      path: s.path,
      measuredPath: s.measuredPath,
      blob: s.blob,
      bytes: content.length,
      lineCount: countLines(content),
      text: content.toString("utf8"),
    });
  }
  return out;
}

export interface FullTreeFile {
  path: string;
  blob: string;
  bytes: number;
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
): Promise<FullTreeFile[]> {
  const tree = await listTree(repoDir, sha);
  const chosen = [...tree.entries()].filter(
    ([p, t]) => t.type === "blob" && (t.mode === MODE_REGULAR || t.mode === MODE_EXECUTABLE) && filter(p),
  );
  await mkdir(destDir, { recursive: true });
  const out: FullTreeFile[] = [];
  const batch = 2000;
  for (let i = 0; i < chosen.length; i += batch) {
    const slice = chosen.slice(i, i + batch);
    const blobs = await readBlobs(repoDir, slice.map(([, t]) => t.blob));
    for (const [p, t] of slice) {
      const content = blobs.get(t.blob)!;
      await writeUnder(destDir, p, content);
      out.push({ path: p, blob: t.blob, bytes: content.length });
    }
  }
  return out;
}

export function treePath(root: string, rel: string): string {
  assertSafeRelativePath(rel);
  return join(root, rel);
}
