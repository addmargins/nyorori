// Builds the measurement manifest for a B→C change (spec 6.2). The manifest is
// the single source of truth for what gets measured: everything else in the
// gate (materialization, cccc arguments, the MANIFEST_MISMATCH check) derives
// from it, and nothing in the candidate tree can widen or narrow it except
// through the trusted policy.

import type { Policy } from "../policy/schema.js";
import type {
  ChangeStatus,
  ExcludedReason,
  InconclusiveReason,
  Manifest,
  ManifestEntry,
  ManifestSide,
  UnmeasuredReason,
} from "../types.js";
import { git, resolveCommit, splitNul } from "./exec.js";
import { matchesAny } from "./glob.js";

export const MODE_REGULAR = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_GITLINK = "160000";

const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** git-lfs pointers are at most 1024 bytes by specification. */
const LFS_MAX_POINTER = 1024;

export interface TreeEntry {
  mode: string;
  type: string;
  blob: string;
}

export interface RawChange {
  status: ChangeStatus;
  similarity?: number;
  pathB: string | null;
  pathC: string | null;
}

export type PathClass =
  | { kind: "measure" }
  | { kind: "unmeasured"; reason: UnmeasuredReason }
  | { kind: "excluded"; reason: ExcludedReason }
  | { kind: "unregistered"; ext: string };

/** `git ls-tree -r -z --full-tree <sha>` as a path → entry map. */
export async function listTree(repoDir: string, sha: string): Promise<Map<string, TreeEntry>> {
  const out = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", sha]);
  const map = new Map<string, TreeEntry>();
  for (const rec of splitNul(out)) {
    const tab = rec.indexOf("\t");
    const [mode, type, blob] = rec.slice(0, tab).split(" ");
    map.set(rec.slice(tab + 1), { mode: mode!, type: type!, blob: blob! });
  }
  return map;
}

export function parseNameStatus(out: string): RawChange[] {
  const f = splitNul(out);
  const changes: RawChange[] = [];
  for (let i = 0; i < f.length; ) {
    const code = f[i++]!;
    const letter = code[0] as ChangeStatus | "U" | "X";
    const score = code.length > 1 ? Number.parseInt(code.slice(1), 10) : undefined;
    if (letter === "R" || letter === "C") {
      const from = f[i++]!;
      const to = f[i++]!;
      changes.push({ status: letter, similarity: score, pathB: from, pathC: to });
    } else if (letter === "A") {
      changes.push({ status: "A", pathB: null, pathC: f[i++]! });
    } else if (letter === "D") {
      changes.push({ status: "D", pathB: f[i++]!, pathC: null });
    } else if (letter === "M" || letter === "T") {
      const p = f[i++]!;
      changes.push({ status: letter, pathB: p, pathC: p });
    } else {
      throw new Error(`unexpected git diff status ${JSON.stringify(code)}`);
    }
  }
  return changes;
}

/** Suffixes of a basename starting at each dot: `a.d.ts` → [".d.ts", ".ts"]; `Makefile` → [""]. */
export function extensionCandidates(path: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const out: string[] = [];
  for (let i = 0; i < base.length; i++) if (base[i] === ".") out.push(base.slice(i));
  return out.length > 0 ? out : [""];
}

function longestSuffixIn(path: string, list: readonly string[]): string | undefined {
  const lower = new Set(list.map((e) => e.toLowerCase()));
  return extensionCandidates(path).find((s) => lower.has(s.toLowerCase()));
}

/** Classification of a regular file path by policy alone (mode handled by the caller). */
export function classifyPath(path: string, policy: Policy): PathClass {
  const s = policy.scope;
  if (longestSuffixIn(path, s.declaration_suffixes)) return { kind: "excluded", reason: "DECLARATION_FILE" };
  if (matchesAny(path, s.exclude)) return { kind: "excluded", reason: "POLICY_EXCLUDE" };
  if (longestSuffixIn(path, s.unmeasured_code_extensions)) return { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
  if (longestSuffixIn(path, s.extensions)) return { kind: "measure" };
  if (longestSuffixIn(path, s.non_code_extensions)) return { kind: "excluded", reason: "NOT_CODE" };
  const cands = extensionCandidates(path);
  return { kind: "unregistered", ext: cands[cands.length - 1]! };
}

/** Would this path be code (measured or a known unmeasured format) if it were not excluded? */
export function isCodePath(path: string, policy: Policy): boolean {
  const s = policy.scope;
  if (longestSuffixIn(path, s.declaration_suffixes)) return false;
  return Boolean(longestSuffixIn(path, s.extensions) || longestSuffixIn(path, s.unmeasured_code_extensions));
}

export function measuredPathFor(path: string, policy: Policy): string {
  const isJs = /\.(js|mjs|cjs)$/i.test(path);
  return isJs && matchesAny(path, policy.scope.jsx_in_js) ? `${path}.jsx` : path;
}

function modeUnmeasured(mode: string): UnmeasuredReason | undefined {
  if (mode === MODE_SYMLINK) return "SYMLINK";
  if (mode === MODE_GITLINK) return "SUBMODULE";
  return undefined;
}

function isRegular(mode: string): boolean {
  return mode === MODE_REGULAR || mode === MODE_EXECUTABLE;
}

interface SideVerdict {
  measure: boolean;
  unmeasured?: UnmeasuredReason;
  excluded?: ExcludedReason;
  unregistered?: string;
}

function judgeSide(path: string, mode: string, policy: Policy): SideVerdict {
  const byMode = modeUnmeasured(mode);
  if (byMode) return { measure: false, unmeasured: byMode };
  if (!isRegular(mode)) return { measure: false, unmeasured: "TYPE_CHANGE" };
  const cls = classifyPath(path, policy);
  switch (cls.kind) {
    case "measure":
      return { measure: true };
    case "unmeasured":
      return { measure: false, unmeasured: cls.reason };
    case "excluded":
      return { measure: false, excluded: cls.reason };
    case "unregistered":
      return { measure: false, unregistered: cls.ext };
  }
}

interface BatchInfo {
  type: string;
  size: number;
}

async function batchCheck(repoDir: string, blobs: string[]): Promise<Map<string, BatchInfo>> {
  const map = new Map<string, BatchInfo>();
  if (blobs.length === 0) return map;
  const out = await git(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: blobs.join("\n") + "\n",
  });
  for (const line of out.toString("utf8").split("\n")) {
    const [name, type, size] = line.split(" ");
    if (name && type && size !== undefined) map.set(name, { type, size: Number(size) });
  }
  return map;
}

/** Reads whole blobs via `git cat-file --batch` (no filters, no attributes). */
export async function readBlobs(repoDir: string, blobs: string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(blobs)];
  const map = new Map<string, Buffer>();
  if (unique.length === 0) return map;
  const out = await git(repoDir, ["cat-file", "--batch"], { input: unique.join("\n") + "\n" });
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = out.subarray(pos, nl).toString("utf8");
    const [name, type, sizeStr] = header.split(" ");
    if (type === "missing" || sizeStr === undefined) throw new Error(`git cat-file: ${header}`);
    const size = Number(sizeStr);
    const start = nl + 1;
    map.set(name!, out.subarray(start, start + size));
    pos = start + size + 1; // content is followed by a LF
  }
  return map;
}

export function isLfsPointer(content: Buffer): boolean {
  return content.length <= LFS_MAX_POINTER && content.subarray(0, LFS_PREFIX.length).toString("latin1") === LFS_PREFIX;
}

export async function buildManifest(
  repoDir: string,
  baseRev: string,
  candidateRev: string,
  policy: Policy,
): Promise<Manifest> {
  const baseSha = await resolveCommit(repoDir, baseRev);
  const candidateSha = await resolveCommit(repoDir, candidateRev);
  const sim = policy.scope.rename_similarity;
  const [nameStatus, treeB, treeC] = await Promise.all([
    git(repoDir, [
      "diff", "--name-status", "-z", "--no-color", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", `-M${sim}%`, `-C${sim}%`, baseSha, candidateSha,
    ]),
    listTree(repoDir, baseSha),
    listTree(repoDir, candidateSha),
  ]);
  const changes = parseNameStatus(nameStatus.toString("utf8"));
  return assembleManifest(repoDir, baseSha, candidateSha, changes, treeB, treeC, policy);
}

async function assembleManifest(
  repoDir: string,
  baseSha: string,
  candidateSha: string,
  changes: RawChange[],
  treeB: Map<string, TreeEntry>,
  treeC: Map<string, TreeEntry>,
  policy: Policy,
): Promise<Manifest> {
  const problems: Manifest["problems"] = [];
  const entries: ManifestEntry[] = [];
  const sensitive = new Set<string>();

  for (const ch of changes) {
    for (const p of [ch.pathB, ch.pathC]) if (p && matchesAny(p, policy.scope.sensitive_paths)) sensitive.add(p);

    const tb = ch.pathB ? treeB.get(ch.pathB) : undefined;
    const tc = ch.pathC ? treeC.get(ch.pathC) : undefined;
    if ((ch.pathB && !tb) || (ch.pathC && !tc)) throw new Error(`path missing from tree listing: ${ch.pathB ?? ch.pathC}`);

    const side = (path: string, t: TreeEntry): ManifestSide => ({
      path,
      blob: t.blob,
      mode: t.mode,
      measuredPath: measuredPathFor(path, policy),
    });
    const b = ch.pathB && tb && ch.status !== "A" && ch.status !== "C" ? side(ch.pathB, tb) : null;
    const c = ch.pathC && tc && ch.status !== "D" ? side(ch.pathC, tc) : null;
    const vb = b ? judgeSide(b.path, b.mode, policy) : undefined;
    const vc = c ? judgeSide(c.path, c.mode, policy) : undefined;

    const entry: ManifestEntry = {
      status: ch.status,
      ...(ch.similarity !== undefined ? { similarity: ch.similarity } : {}),
      b,
      c,
      measure: { B: Boolean(vb?.measure), C: Boolean(vc?.measure) },
    };
    const primary = vc ?? vb!;
    const primaryPath = (c ?? b)!.path;

    // A type change (file ⇄ symlink/submodule) is always routed to a human
    // (S11). Regular sides are still measured: that is strictly more evidence.
    if (ch.status === "T") entry.unmeasured = "TYPE_CHANGE";
    else if (vc?.unmeasured) entry.unmeasured = vc.unmeasured;
    if (primary.excluded) entry.excluded = primary.excluded;

    if (
      c &&
      (ch.status === "A" || ch.status === "C" || ch.status === "R") &&
      vc?.excluded === "POLICY_EXCLUDE" &&
      isCodePath(c.path, policy)
    ) {
      entry.newInExcludedPath = true;
    }
    if (matchesAny(primaryPath, policy.scope.test_globs)) entry.isTest = true;

    // Only the candidate side matters: deleting an unregistered file cannot hide code.
    if (vc?.unregistered !== undefined && c) {
      problems.push({
        reason: "UNREGISTERED_EXTENSION",
        path: c.path,
        detail: `extension ${JSON.stringify(vc.unregistered)} is not registered in the policy scope`,
      });
    }
    entries.push(entry);
  }

  await checkBlobs(repoDir, entries, policy, problems);
  checkCollisions(entries, problems);
  entries.sort((x, y) => cmp((x.c ?? x.b)!.path, (y.c ?? y.b)!.path));
  return { baseSha, candidateSha, entries, problems, sensitivePathsChanged: [...sensitive].sort(cmp) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Size cap and LFS pointer detection on every side handed to cccc. */
async function checkBlobs(
  repoDir: string,
  entries: ManifestEntry[],
  policy: Policy,
  problems: Manifest["problems"],
): Promise<void> {
  const sides: Array<{ entry: ManifestEntry; key: "B" | "C"; s: ManifestSide }> = [];
  for (const e of entries) {
    if (e.measure.B && e.b) sides.push({ entry: e, key: "B", s: e.b });
    if (e.measure.C && e.c) sides.push({ entry: e, key: "C", s: e.c });
  }
  const info = await batchCheck(repoDir, [...new Set(sides.map((x) => x.s.blob))]);
  const small = sides.filter((x) => (info.get(x.s.blob)?.size ?? 0) <= LFS_MAX_POINTER).map((x) => x.s.blob);
  const contents = await readBlobs(repoDir, small);
  const reported = new Set<string>();
  for (const { entry, key, s } of sides) {
    const size = info.get(s.blob)?.size;
    if (size === undefined) throw new Error(`blob ${s.blob} not found for ${s.path}`);
    const tag = `${key}:${s.path}`;
    if (size > policy.scope.max_file_bytes) {
      entry.measure[key] = false;
      if (!reported.has(tag)) {
        problems.push({
          reason: "FILE_TOO_LARGE",
          path: s.path,
          detail: `${key} side is ${size} bytes (limit ${policy.scope.max_file_bytes})`,
        });
        reported.add(tag);
      }
      continue;
    }
    const content = contents.get(s.blob);
    if (content && isLfsPointer(content)) {
      entry.measure[key] = false;
      if (!reported.has(tag)) {
        problems.push({ reason: "LFS_POINTER", path: s.path, detail: `${key} side is a Git LFS pointer, not source` });
        reported.add(tag);
      }
    }
  }
}

/** Two measured paths on one side that collide on a case-insensitive file system, or after the .jsx suffix. */
function checkCollisions(entries: ManifestEntry[], problems: Manifest["problems"]): void {
  for (const key of ["B", "C"] as const) {
    const seen = new Map<string, string>();
    for (const e of entries) {
      const s = key === "B" ? e.b : e.c;
      if (!s || !e.measure[key]) continue;
      const folded = s.measuredPath.toLowerCase();
      const prev = seen.get(folded);
      if (prev !== undefined) {
        problems.push({
          reason: "CASE_COLLISION",
          path: s.path,
          detail: `${key} side: ${JSON.stringify(s.path)} collides with ${JSON.stringify(prev)}`,
        });
      } else seen.set(folded, s.path);
    }
  }
}

/** Paths of each side that are handed to cccc. */
export function measuredSides(manifest: Manifest, side: "B" | "C"): ManifestSide[] {
  const out: ManifestSide[] = [];
  for (const e of manifest.entries) {
    const s = side === "B" ? e.b : e.c;
    if (s && e.measure[side]) out.push(s);
  }
  return out;
}

export function problemIsAuthorFixable(reason: InconclusiveReason): boolean {
  return (
    reason === "CASE_COLLISION" ||
    reason === "LFS_POINTER" ||
    reason === "FILE_TOO_LARGE" ||
    reason === "JSX_IN_JS" ||
    reason === "INVALID_ENCODING"
  );
}
