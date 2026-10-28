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
import { decodePath, git, isInvalidPath, resolveCommit, splitNul } from "./exec.js";
import { matchesAny } from "./glob.js";

export const MODE_REGULAR = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_GITLINK = "160000";

const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** git-lfs pointers are at most 1024 bytes by specification. */
const LFS_MAX_POINTER = 1024;
/** Upper bound on bytes requested from one `cat-file --batch` call. */
export const BLOB_BATCH_BYTES = 64 * 1024 * 1024;

/** Measured-path suffixes for extensionless scripts (rulings D6); distinctive so `bin/cli` and `bin/cli.js` can coexist. */
export const SHEBANG_SUFFIX = { js: ".shebang.js", ts: ".shebang.ts" } as const;

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
  /** No extension: the first line decides (classifyExtensionless). */
  | { kind: "extensionless" }
  /** Markup that may embed script: the content decides (classifyScriptCapable). */
  | { kind: "script-capable" };

export type ShebangKind = "js" | "ts" | "foreign";

/** `git ls-tree -r -z --full-tree <sha>` as a path → entry map. */
export async function listTree(repoDir: string, sha: string): Promise<Map<string, TreeEntry>> {
  const out = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", sha]);
  const map = new Map<string, TreeEntry>();
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue;
    const rec = out.subarray(start, i);
    start = i + 1;
    const tab = rec.indexOf(0x09);
    const [mode, type, blob] = rec.subarray(0, tab).toString("latin1").split(" ");
    map.set(decodePath(rec.subarray(tab + 1)), { mode: mode!, type: type!, blob: blob! });
  }
  return map;
}

export function parseNameStatus(out: Buffer | string): RawChange[] {
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

function hasSuffixIn(path: string, list: readonly string[]): boolean {
  const lower = new Set(list.map((e) => e.toLowerCase()));
  return extensionCandidates(path).some((s) => lower.has(s.toLowerCase()));
}

function isExtensionless(path: string): boolean {
  const c = extensionCandidates(path);
  return c.length === 1 && c[0] === "";
}

/**
 * Classification of a regular file path by policy alone (mode handled by the
 * caller). An extension listed nowhere is unmeasured UNSUPPORTED_FORMAT, routed
 * to a human (rulings D5) rather than failing the whole run.
 */
export function classifyPath(path: string, policy: Policy): PathClass {
  const s = policy.scope;
  if (hasSuffixIn(path, s.declaration_suffixes)) return { kind: "excluded", reason: "DECLARATION_FILE" };
  if (matchesAny(path, s.exclude)) return { kind: "excluded", reason: "POLICY_EXCLUDE" };
  if (hasSuffixIn(path, s.unmeasured_code_extensions)) return { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
  if (hasSuffixIn(path, s.extensions)) return { kind: "measure" };
  if (hasSuffixIn(path, s.foreign_code_extensions)) return { kind: "unmeasured", reason: "FOREIGN_LANGUAGE" };
  if (isExtensionless(path)) return { kind: "extensionless" };
  if (hasSuffixIn(path, s.script_capable_extensions)) return { kind: "script-capable" };
  if (hasSuffixIn(path, s.non_code_extensions)) return { kind: "excluded", reason: "NOT_CODE" };
  return { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
}

/** Interpreter named by a `#!` first line (rulings D6). Only the first 256 bytes are read. */
export function shebangKind(content: Buffer): ShebangKind | null {
  if (content[0] !== 0x23 || content[1] !== 0x21) return null;
  const nl = content.indexOf(0x0a);
  const line = content.subarray(0, Math.min(nl === -1 ? content.length : nl, 256)).toString("latin1");
  // ts first: `ts-node` contains the word `node`.
  if (/\b(tsx|ts-node)\b/.test(line)) return "ts";
  if (/\b(node|bun|deno)\b/.test(line)) return "js";
  return "foreign";
}

/** Final class of an extensionless file given its content (null when unread, e.g. oversize). */
export function classifyExtensionless(path: string, content: Buffer | null, policy: Policy): PathClass {
  if (content === null) return { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
  const kind = shebangKind(content);
  if (kind === "js" || kind === "ts") return { kind: "measure" };
  if (kind === "foreign") return { kind: "unmeasured", reason: "FOREIGN_LANGUAGE" };
  return hasSuffixIn(path, policy.scope.non_code_extensions)
    ? { kind: "excluded", reason: "NOT_CODE" }
    : { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
}

const EMBEDDED_SCRIPT = [/<script\b/i, /\son[a-z]+\s*=/i, /javascript:/i];

/** Whether markup carries inline script (case-insensitive, whole blob). */
export function hasEmbeddedScript(content: Buffer): boolean {
  const text = content.toString("latin1");
  return EMBEDDED_SCRIPT.some((re) => re.test(text));
}

/** Final class of script-capable markup given its content (null when unread, e.g. oversize). */
export function classifyScriptCapable(content: Buffer | null): PathClass {
  if (content === null || hasEmbeddedScript(content)) return { kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" };
  return { kind: "excluded", reason: "NOT_CODE" };
}

/** Linux limits: NAME_MAX per segment, PATH_MAX for the whole path (in bytes). */
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_BYTES = 4096;

/** Why a repository path cannot be written under the gate's work dir, or null. */
export function pathTooLong(path: string): string | null {
  const total = Buffer.byteLength(path, "utf8");
  if (total > MAX_PATH_BYTES) return `path is ${total} bytes (limit ${MAX_PATH_BYTES})`;
  const seg = path.split("/").find((x) => Buffer.byteLength(x, "utf8") > MAX_SEGMENT_BYTES);
  return seg === undefined ? null : `a path segment is ${Buffer.byteLength(seg, "utf8")} bytes (limit ${MAX_SEGMENT_BYTES})`;
}

/**
 * Collision key: Unicode NFC (APFS/HFS+ treat NFC and NFD as one name) plus a
 * full case fold through upper case (NTFS upcase maps ı→I and ſ→S). NFKC is
 * deliberately not applied: no common file system folds compatibility forms.
 */
export function foldPathForCollision(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase();
}

/** Would this path be code (measured or a known unmeasured format) if it were not excluded? */
export function isCodePath(path: string, policy: Policy): boolean {
  const s = policy.scope;
  if (hasSuffixIn(path, s.declaration_suffixes)) return false;
  return (
    hasSuffixIn(path, s.extensions) ||
    hasSuffixIn(path, s.unmeasured_code_extensions) ||
    hasSuffixIn(path, s.foreign_code_extensions)
  );
}

export function measuredPathFor(path: string, policy: Policy, shebang?: ShebangKind | null): string {
  if (shebang === "js" || shebang === "ts") return `${path}${SHEBANG_SUFFIX[shebang]}`;
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
}

function verdictOf(cls: PathClass): SideVerdict {
  switch (cls.kind) {
    case "measure":
      return { measure: true };
    case "unmeasured":
      return { measure: false, unmeasured: cls.reason };
    case "excluded":
      return { measure: false, excluded: cls.reason };
    case "extensionless":
    case "script-capable":
      throw new Error(`${cls.kind} paths need their content`);
  }
}

export interface BatchInfo {
  type: string;
  size: number;
}

export async function batchCheck(repoDir: string, blobs: string[]): Promise<Map<string, BatchInfo>> {
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

/**
 * Reads blobs in batches whose cumulative size stays under `budget`, so a big
 * change never needs one giant child-process buffer.
 */
export async function readBlobsBatched(
  repoDir: string,
  blobs: string[],
  budget = BLOB_BATCH_BYTES,
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(blobs)];
  const sizes = await batchCheck(repoDir, unique);
  const map = new Map<string, Buffer>();
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    for (const [k, v] of await readBlobs(repoDir, batch)) map.set(k, v);
    batch = [];
    bytes = 0;
  };
  for (const b of unique) {
    const size = sizes.get(b)?.size ?? 0;
    if (batch.length > 0 && bytes + size > budget) await flush();
    batch.push(b);
    bytes += size;
  }
  await flush();
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
  const changes = parseNameStatus(nameStatus);
  return assembleManifest(repoDir, baseSha, candidateSha, changes, treeB, treeC, policy);
}

interface PendingSide {
  path: string;
  tree: TreeEntry;
}

/** Content of every side the path alone cannot classify. Oversize blobs stay unread (null). */
async function readContentClassified(
  repoDir: string,
  sides: PendingSide[],
  policy: Policy,
): Promise<Map<string, Buffer | null>> {
  const blobs = [...new Set(sides.map((s) => s.tree.blob))];
  const info = await batchCheck(repoDir, blobs);
  const readable = blobs.filter((b) => (info.get(b)?.size ?? Infinity) <= policy.scope.max_file_bytes);
  const contents = await readBlobsBatched(repoDir, readable);
  const out = new Map<string, Buffer | null>();
  for (const b of blobs) out.set(b, contents.get(b) ?? null);
  return out;
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

  const pending: PendingSide[] = [];
  for (const ch of changes) {
    for (const [p, tree] of [[ch.pathB, treeB], [ch.pathC, treeC]] as const) {
      const t = p ? tree.get(p) : undefined;
      if (!p || !t || !isRegular(t.mode) || isInvalidPath(p)) continue;
      const kind = classifyPath(p, policy).kind;
      if (kind === "extensionless" || kind === "script-capable") pending.push({ path: p, tree: t });
    }
  }
  const firstBytes = await readContentClassified(repoDir, pending, policy);

  const judge = (path: string, t: TreeEntry): { v: SideVerdict; shebang: ShebangKind | null; tooLong?: string } => {
    const byMode = modeUnmeasured(t.mode);
    if (byMode) return { v: { measure: false, unmeasured: byMode }, shebang: null };
    if (!isRegular(t.mode)) return { v: { measure: false, unmeasured: "TYPE_CHANGE" }, shebang: null };
    if (isInvalidPath(path)) return { v: { measure: false, unmeasured: "UNSUPPORTED_FORMAT" }, shebang: null };
    let cls = classifyPath(path, policy);
    let shebang: ShebangKind | null = null;
    if (cls.kind === "extensionless") {
      const content = firstBytes.get(t.blob) ?? null;
      shebang = content ? shebangKind(content) : null;
      cls = classifyExtensionless(path, content, policy);
    } else if (cls.kind === "script-capable") {
      cls = classifyScriptCapable(firstBytes.get(t.blob) ?? null);
    }
    const tooLong = cls.kind === "measure" ? pathTooLong(path) : null;
    if (tooLong !== null) return { v: { measure: false }, shebang, tooLong };
    return { v: verdictOf(cls), shebang };
  };

  for (const ch of changes) {
    for (const p of [ch.pathB, ch.pathC]) if (p && matchesAny(p, policy.scope.sensitive_paths)) sensitive.add(p);

    const tb = ch.pathB ? treeB.get(ch.pathB) : undefined;
    const tc = ch.pathC ? treeC.get(ch.pathC) : undefined;
    if ((ch.pathB && !tb) || (ch.pathC && !tc)) throw new Error(`path missing from tree listing: ${ch.pathB ?? ch.pathC}`);

    const jb = ch.pathB && tb && ch.status !== "A" && ch.status !== "C" ? judge(ch.pathB, tb) : undefined;
    const jc = ch.pathC && tc && ch.status !== "D" ? judge(ch.pathC, tc) : undefined;
    const side = (path: string, t: TreeEntry, shebang: ShebangKind | null): ManifestSide => ({
      path,
      blob: t.blob,
      mode: t.mode,
      measuredPath: measuredPathFor(path, policy, shebang),
    });
    const b = jb ? side(ch.pathB!, tb!, jb.shebang) : null;
    const c = jc ? side(ch.pathC!, tc!, jc.shebang) : null;
    const vb = jb?.v;
    const vc = jc?.v;

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

    // A measurable file whose path the work dir cannot hold (ENAMETOOLONG).
    if (c && jc?.tooLong) {
      problems.push({
        reason: "PATH_TOO_LONG",
        path: c.path,
        detail: `path too long for the gate's work dir (${jc.tooLong}); rename it`,
      });
    }
    if (c && isInvalidPath(c.path)) {
      problems.push({
        reason: "INVALID_ENCODING",
        path: c.path,
        detail: `a candidate path is not valid UTF-8 (bytes ${c.path.slice(c.path.indexOf(":") + 1)}); rename it`,
      });
    }
    entries.push(entry);
  }

  await checkBlobs(repoDir, entries, policy, problems);
  checkCollisions(entries, "B", treeB, problems);
  checkCollisions(entries, "C", treeC, problems);
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

/**
 * Measured paths that collide, case-insensitively, with any other path of the
 * same side's full tree (unchanged files included) or with another measured
 * path (a `.jsx`/shebang suffix). Colliding sides are not materialized: they
 * would overwrite each other, and the run is INCONCLUSIVE anyway.
 */
function checkCollisions(
  entries: ManifestEntry[],
  key: "B" | "C",
  tree: Map<string, TreeEntry>,
  problems: Manifest["problems"],
): void {
  const owners = new Map<string, Set<string>>();
  const claim = (name: string, owner: string) => {
    const folded = foldPathForCollision(name);
    let set = owners.get(folded);
    if (!set) owners.set(folded, (set = new Set()));
    set.add(owner);
  };
  for (const p of tree.keys()) claim(p, p);
  const measured = entries.filter((e) => e.measure[key] && (key === "B" ? e.b : e.c));
  for (const e of measured) {
    const s = (key === "B" ? e.b : e.c)!;
    claim(s.measuredPath, s.path);
  }
  for (const e of measured) {
    const s = (key === "B" ? e.b : e.c)!;
    const others = [...(owners.get(foldPathForCollision(s.measuredPath)) ?? [])].filter((o) => o !== s.path);
    if (others.length === 0) continue;
    e.measure[key] = false;
    if (key === "C") {
      problems.push({
        reason: "CASE_COLLISION",
        path: s.path,
        detail: `${JSON.stringify(s.measuredPath)} collides with ${others.map((o) => JSON.stringify(o)).join(", ")}`,
      });
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
    reason === "INVALID_ENCODING" ||
    reason === "PATH_TOO_LONG"
  );
}
