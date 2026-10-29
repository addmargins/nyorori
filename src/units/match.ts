// B→C unit correspondence (spec 5.4): "if it is not certain, it is new".
// A legacy allowance (limit > T) is only inherited through one of four
// pieces of evidence; anything else is matched to nothing, which can only
// make the verdict stricter. Rulings D21 add two narrow cases: a file whose
// normalized text did not change, and k-to-k groups of same-named siblings.

import { cRangeTouched as linemapCRangeTouched, hunkOfB, hunkOfC, mapLine } from "../git/linemap.js";
import type {
  FileLineMap,
  FileMeasurement,
  Hunk,
  Manifest,
  MatchStage,
  Unit,
  UnitMatch,
} from "../types.js";
import { matchesAny } from "../util/glob.js";
import { unitBodyText } from "./body.js";
import { flattenUnits } from "./model.js";
import { checkName } from "./names.js";

const ANONYMOUS = "<anonymous>";

// ---------------------------------------------------------------------------
// Line-map helpers over `git diff -U0` hunks
// ---------------------------------------------------------------------------

/** linemap.ts helpers take a FileLineMap; they never mutate the hunks. */
function lineMapOf(hunks: readonly Hunk[]): Pick<FileLineMap, "hunks"> {
  return { hunks: hunks as Hunk[] };
}

/**
 * Does any hunk add or modify C lines inside [start, end], or delete lines
 * strictly inside it? Same semantics as `src/git/linemap.ts`.
 */
export function cRangeTouched(hunks: readonly Hunk[], start: number, end: number): boolean {
  return linemapCRangeTouched(lineMapOf(hunks), start, end);
}

/**
 * Does any hunk remove/modify B lines inside [start, end], or insert lines
 * strictly inside the range (after a line in [start, end - 1])?
 */
export function bRangeTouched(hunks: readonly Hunk[], start: number, end: number): boolean {
  return hunks.some((h) =>
    h.bCount > 0
      ? h.bStart <= end && h.bStart + h.bCount - 1 >= start
      : h.bStart >= start && h.bStart < end,
  );
}

/**
 * Residue-gap semantics for S5: the gap [start, end] between two units (it may
 * be empty, start = end + 1) is touched by a modification overlapping it or by
 * an insertion after any line in [start − 1, end], i.e. anywhere between the
 * previous unit's last line and the next unit's first line.
 */
export function bGapTouched(hunks: readonly Hunk[], start: number, end: number): boolean {
  return hunks.some((h) =>
    h.bCount > 0
      ? h.bStart <= end && h.bStart + h.bCount - 1 >= start
      : h.bStart >= start - 1 && h.bStart <= end,
  );
}

export function findLineMap(
  lineMaps: readonly FileLineMap[],
  pathB: string,
  pathC: string,
): FileLineMap | undefined {
  return lineMaps.find((m) => m.pathB === pathB && m.pathC === pathC);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchInput {
  manifest: Manifest;
  /** Keyed by B path. */
  b: ReadonlyMap<string, FileMeasurement>;
  /** Keyed by C path. */
  c: ReadonlyMap<string, FileMeasurement>;
  lineMaps: readonly FileLineMap[];
  /** C paths whose B side failed to parse: no baseline, every C unit is new. */
  baselineMissing?: ReadonlySet<string>;
  /** Sources keyed by B / C path; without them a stage-4 move is identity-changed. */
  sourcesB?: ReadonlyMap<string, string>;
  sourcesC?: ReadonlyMap<string, string>;
  /** C paths whose pinned-Prettier normalization equals B's (ruling D21a). */
  normalizedIdentical?: ReadonlySet<string>;
  /** policy.complexity.cognitive_limit, for k-to-k groups (ruling D21b). Default 15. */
  limit?: number;
  /**
   * policy.scope.test_globs. A unit never matches across the test/product
   * boundary: a test file's allowance must not travel into product code.
   * Without the globs, only the manifest's primary-path `isTest` is known.
   */
  testGlobs?: readonly string[];
}

export type ScopeClass = "test" | "product";

/** A B→C pair the matcher refused because the two sides live in different scopes. */
export interface ScopeChange {
  bPath: string;
  cPath: string;
  from: ScopeClass;
  to: ScopeClass;
  /** Set for a verbatim unit move between a deleted and an added file. */
  bKey?: string;
  cKey?: string;
}

export function scopeOf(path: string, testGlobs: readonly string[] | undefined): ScopeClass {
  return testGlobs && matchesAny(path, testGlobs) ? "test" : "product";
}

/** Scope of every B and C path of the PR, keyed by side. */
export interface ScopeIndex {
  b: ReadonlyMap<string, ScopeClass>;
  c: ReadonlyMap<string, ScopeClass>;
}

/**
 * Per-side classification: the manifest's `isTestB` / `isTestC` when present,
 * else `policy.scope.test_globs`, else the legacy primary-path `isTest` (which
 * cannot tell the sides of a rename apart, so it never refuses a pair).
 */
function sideScope(path: string, flag: boolean | undefined, legacy: boolean | undefined, globs: readonly string[] | undefined): ScopeClass {
  if (flag !== undefined) return flag ? "test" : "product";
  if (globs) return scopeOf(path, globs);
  return legacy ? "test" : "product";
}

export function scopeIndex(input: Pick<MatchInput, "manifest" | "testGlobs">): ScopeIndex {
  const b = new Map<string, ScopeClass>();
  const c = new Map<string, ScopeClass>();
  for (const e of input.manifest.entries) {
    if (e.b) b.set(e.b.path, sideScope(e.b.path, e.isTestB, e.isTest, input.testGlobs));
    if (e.c) c.set(e.c.path, sideScope(e.c.path, e.isTestC, e.isTest, input.testGlobs));
  }
  return { b, c };
}

const scopeB = (idx: ScopeIndex, path: string): ScopeClass => idx.b.get(path) ?? "product";
const scopeC = (idx: ScopeIndex, path: string): ScopeClass => idx.c.get(path) ?? "product";

/**
 * Records a refused verbatim move unless its file pair was already refused
 * as a whole (the units of a refused rename are left unmatched, so stage 4
 * finds them again; one S11 per file is enough).
 */
function refuseMove(refused: ScopeChange[], b: Unit, c: Unit, from: ScopeClass, to: ScopeClass): void {
  if (refused.some((r) => r.bKey === undefined && r.bPath === b.path && r.cPath === c.path)) return;
  refused.push({ bPath: b.path, cPath: c.path, from, to, bKey: b.key, cKey: c.key });
}

export interface MatchResult {
  matches: UnitMatch[];
  byC: Map<string, UnitMatch>;
  byB: Map<string, UnitMatch>;
  /** C units whose suspicious names barred them from name-based matching. */
  nameWarnings: Array<{ unit: string; warning: string }>;
  /** Keys that occur more than once on one side; such units are never matched. */
  duplicateKeys?: string[];
  /** File pairs and verbatim moves refused for crossing the test/product boundary (S11). */
  scopeChanges?: ScopeChange[];
}

export interface FilePair {
  b: FileMeasurement;
  c: FileMeasurement;
  hunks: readonly Hunk[];
}

type PairInput = Pick<MatchInput, "manifest" | "b" | "c" | "lineMaps" | "baselineMissing" | "testGlobs">;

/**
 * Modified or renamed files measured on both sides, with their hunks. A
 * rename across the test/product boundary is not a pair: it is reported in
 * `refused` and both sides are treated as new / deleted.
 */
export function filePairs(input: PairInput, refused?: ScopeChange[]): FilePair[] {
  const pairs: FilePair[] = [];
  const idx = scopeIndex(input);
  for (const e of input.manifest.entries) {
    if (e.status !== "M" && e.status !== "R") continue;
    if (!e.b || !e.c || !e.measure.B || !e.measure.C) continue;
    if (input.baselineMissing?.has(e.c.path)) continue;
    const b = input.b.get(e.b.path);
    const c = input.c.get(e.c.path);
    if (!b || !c) continue;
    const from = scopeB(idx, e.b.path);
    const to = scopeC(idx, e.c.path);
    if (from !== to) {
      refused?.push({ bPath: e.b.path, cPath: e.c.path, from, to });
      continue;
    }
    const hunks = findLineMap(input.lineMaps, e.b.path, e.c.path)?.hunks ?? [];
    pairs.push({ b, c, hunks });
  }
  return pairs;
}

function duplicateKeySet(files: Iterable<FileMeasurement>): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const f of files) {
    for (const u of [...flattenUnits(f.units), f.residue]) {
      if (seen.has(u.key)) dup.add(u.key);
      seen.add(u.key);
    }
  }
  return dup;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

class Matcher {
  readonly matches: UnitMatch[] = [];
  readonly byC = new Map<string, UnitMatch>();
  readonly byB = new Map<string, UnitMatch>();
  readonly nameWarnings: Array<{ unit: string; warning: string }> = [];
  private readonly warned = new Set<string>();

  private readonly dupB: ReadonlySet<string>;
  private readonly dupC: ReadonlySet<string>;
  private readonly limit: number;

  constructor(dupB: ReadonlySet<string>, dupC: ReadonlySet<string>, limit: number) {
    this.dupB = dupB;
    this.dupC = dupC;
    this.limit = limit;
  }

  add(b: Unit, c: Unit, stage: MatchStage, identityChanged = stage === 2 || stage === 3): void {
    const m: UnitMatch = { bKey: b.key, cKey: c.key, stage, identityChanged };
    this.matches.push(m);
    this.byB.set(b.key, m);
    this.byC.set(c.key, m);
  }

  /** Matched already, or barred because its key is not unique on its side. */
  unavailable(u: Unit, side: "B" | "C"): boolean {
    return side === "B"
      ? this.byB.has(u.key) || this.dupB.has(u.key)
      : this.byC.has(u.key) || this.dupC.has(u.key);
  }

  /** Name usable for name-based evidence; records a warning otherwise. */
  trustedName(u: Unit): string | undefined {
    if (u.name === ANONYMOUS) return undefined;
    const check = checkName(u.name);
    if (check.suspicious) {
      if (!this.warned.has(u.key)) {
        this.warned.add(u.key);
        this.nameWarnings.push({ unit: u.key, warning: check.warning ?? "suspicious name" });
      }
      return undefined;
    }
    return check.normalized;
  }

  /** Ruling D21a: unchanged normalized text with an identical unit sequence → ordinal match. */
  matchIdentical(pair: FilePair): boolean {
    const bs = flattenUnits(pair.b.units);
    const cs = flattenUnits(pair.c.units);
    if (bs.length !== cs.length) return false;
    const sig = (u: Unit) => `${u.depth}\u0000${u.name}\u0000${u.kind}\u0000${u.cognitive}\u0000${u.cyclomatic}`;
    if (bs.some((b, i) => sig(b) !== sig(cs[i]!))) return false;
    if (bs.some((b, i) => this.unavailable(b, "B") || this.unavailable(cs[i]!, "C"))) return false;
    bs.forEach((b, i) => this.add(b, cs[i]!, 1, false));
    return true;
  }

  /** Stages 1-3 and k-to-k for one sibling group, then recurse into matched pairs. */
  matchSiblings(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    this.stageFixedPoint(bs, cs, hunks);
    this.stageSameHunk(bs, cs, hunks);
    this.stageUniqueName(bs, cs);
    this.stageKToK(bs, cs);
    const cByKey = new Map(cs.map((c) => [c.key, c]));
    for (const b of bs) {
      const m = this.byB.get(b.key);
      const c = m && cByKey.get(m.cKey);
      if (c) this.matchSiblings(b.children, c.children, hunks);
    }
  }

  private stageFixedPoint(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    const lm = lineMapOf(hunks);
    const index = new Map<string, Unit[]>();
    const at = (name: string, kind: string, line: number, ordinal: number) =>
      `${name}\u0000${kind}\u0000${line}\u0000${ordinal}`;
    for (const c of cs) {
      if (!this.unavailable(c, "C")) push(index, at(c.name.normalize("NFKC"), c.kind, c.line, c.lineOrdinal), c);
    }
    for (const b of bs) {
      if (this.unavailable(b, "B")) continue;
      const target = mapLine(lm, b.line);
      if (target === undefined) continue;
      const candidates = (index.get(at(b.name.normalize("NFKC"), b.kind, target, b.lineOrdinal)) ?? []).filter(
        (c) => !this.unavailable(c, "C"),
      );
      if (candidates.length === 1) this.add(b, candidates[0]!, 1);
    }
  }

  private stageSameHunk(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    const lm = lineMapOf(hunks);
    const groups = new Map<string, { b: Unit[]; c: Unit[] }>();
    const group = (hunk: number, kind: string) => {
      const k = `${hunk}\u0000${kind}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { b: [], c: [] }));
      return g;
    };
    for (const b of bs) {
      if (this.unavailable(b, "B")) continue;
      const h = hunkOfB(lm, b.line);
      if (h >= 0) group(h, b.kind).b.push(b);
    }
    for (const c of cs) {
      if (this.unavailable(c, "C")) continue;
      const h = hunkOfC(lm, c.line);
      if (h >= 0) group(h, c.kind).c.push(c);
    }
    for (const g of groups.values()) {
      if (g.b.length !== 1 || g.c.length !== 1) continue;
      const [b, c] = [g.b[0]!, g.c[0]!];
      // A rename onto a look-alike name is treated as a new unit (spec 14).
      if (c.name !== b.name && checkName(c.name).suspicious) {
        this.trustedName(c);
        continue;
      }
      this.add(b, c, 2);
    }
  }

  private nameIndex(us: readonly Unit[], side: "B" | "C"): Map<string, Unit[]> {
    const m = new Map<string, Unit[]>();
    for (const u of us) {
      if (this.unavailable(u, side)) continue;
      const name = this.trustedName(u);
      if (name !== undefined) push(m, `${name}\u0000${u.kind}`, u);
    }
    return m;
  }

  private stageUniqueName(bs: readonly Unit[], cs: readonly Unit[]): void {
    const bIdx = this.nameIndex(bs, "B");
    const cIdx = this.nameIndex(cs, "C");
    for (const [k, bList] of bIdx) {
      const cList = cIdx.get(k);
      if (bList.length === 1 && cList?.length === 1) this.add(bList[0]!, cList[0]!, 3);
    }
  }

  /**
   * Ruling D21b: k ≥ 2 leftover named siblings of one (name, kind) on both
   * sides. Pair them by CogC descending; accept the whole group only when no
   * C unit would exceed max(T, its paired B), so the guess can never raise a
   * limit above what some B unit already had. Every pair is identity-changed.
   * Anonymous units stay out (spec 5.4 step 3): a new callback could
   * otherwise inherit a legacy callback's allowance.
   */
  private stageKToK(bs: readonly Unit[], cs: readonly Unit[]): void {
    const bIdx = this.nameIndex(bs, "B");
    const cIdx = this.nameIndex(cs, "C");
    const byCog = (x: Unit, y: Unit) => y.cognitive - x.cognitive || x.line - y.line;
    for (const [k, bList] of bIdx) {
      const cList = cIdx.get(k);
      if (!cList || bList.length < 2 || bList.length !== cList.length) continue;
      const sb = [...bList].sort(byCog);
      const sc = [...cList].sort(byCog);
      if (sc.some((c, i) => c.cognitive > Math.max(this.limit, sb[i]!.cognitive))) continue;
      sb.forEach((b, i) => this.add(b, sc[i]!, 3, true));
    }
  }

  /**
   * Stage 4: verbatim move anywhere in the PR, unique PR-wide. A move across
   * the test/product boundary is refused and reported instead.
   */
  matchVerbatimMoves(
    bUnits: readonly Unit[],
    cUnits: readonly Unit[],
    input: Pick<MatchInput, "sourcesB" | "sourcesC">,
    idx: ScopeIndex,
    refused: ScopeChange[],
  ): void {
    for (const [b, c] of this.verbatimCandidates(bUnits, cUnits)) {
      if (this.unavailable(b, "B") || this.unavailable(c, "C")) continue;
      const from = scopeB(idx, b.path);
      const to = scopeC(idx, c.path);
      if (from !== to) {
        refuseMove(refused, b, c, from, to);
        continue;
      }
      // Equal scores are not equal logic (audit F4): without proof, S5 reviews it.
      const srcB = input.sourcesB?.get(b.path);
      const srcC = input.sourcesC?.get(c.path);
      const verbatim = srcB !== undefined && srcC !== undefined && unitBodyText(srcB, b) === unitBodyText(srcC, c);
      this.pairTree(b, c, !verbatim);
    }
  }

  /** Unmatched B/C units with a PR-wide unique (name, shape) on both sides. */
  verbatimCandidates(bUnits: readonly Unit[], cUnits: readonly Unit[]): Array<[Unit, Unit]> {
    const pool = (us: readonly Unit[], side: "B" | "C") => {
      const m = new Map<string, Unit[]>();
      for (const u of us) {
        if (u.isResidue || this.unavailable(u, side)) continue;
        const name = this.trustedName(u);
        if (name !== undefined) push(m, `${name}\u0000${shape(u)}`, u);
      }
      return m;
    };
    const bPool = pool(bUnits, "B");
    const cPool = pool(cUnits, "C");
    const out: Array<[Unit, Unit]> = [];
    for (const [k, bList] of bPool) {
      const cList = cPool.get(k);
      if (bList.length === 1 && cList?.length === 1) out.push([bList[0]!, cList[0]!]);
    }
    return out;
  }

  /** Identical shapes: pair the trees node by node. */
  private pairTree(b: Unit, c: Unit, identityChanged: boolean): void {
    if (this.unavailable(b, "B") || this.unavailable(c, "C")) return;
    this.add(b, c, 4, identityChanged);
    b.children.forEach((bc, i) => {
      const cc = c.children[i];
      if (cc) this.pairTree(bc, cc, identityChanged);
    });
  }
}

/** Structural fingerprint used by stage 4: kind, CogC, CC, recursively. */
function shape(u: Unit): string {
  return `${u.kind}:${u.cognitive}:${u.cyclomatic}(${u.children.map(shape).join(",")})`;
}

/** Every measured B and C unit of the PR, except files with no baseline. */
function prUnits(input: PairInput): { bUnits: Unit[]; cUnits: Unit[] } {
  const bUnits: Unit[] = [];
  const cUnits: Unit[] = [];
  const missingB = new Set<string>();
  for (const e of input.manifest.entries) {
    if (e.c && input.baselineMissing?.has(e.c.path) && e.b) missingB.add(e.b.path);
  }
  for (const e of input.manifest.entries) {
    if (e.b && e.measure.B && !missingB.has(e.b.path)) {
      const f = input.b.get(e.b.path);
      if (f) bUnits.push(...flattenUnits(f.units));
    }
    if (e.c && e.measure.C && !input.baselineMissing?.has(e.c.path)) {
      const f = input.c.get(e.c.path);
      if (f) cUnits.push(...flattenUnits(f.units));
    }
  }
  return { bUnits, cUnits };
}

export function matchUnits(input: MatchInput): MatchResult {
  const dupB = duplicateKeySet(input.b.values());
  const dupC = duplicateKeySet(input.c.values());
  const m = new Matcher(dupB, dupC, input.limit ?? 15);
  const scopeChanges: ScopeChange[] = [];
  for (const pair of filePairs(input, scopeChanges)) {
    if (!dupB.has(pair.b.residue.key) && !dupC.has(pair.c.residue.key)) {
      m.add(pair.b.residue, pair.c.residue, 1);
    }
    if (input.normalizedIdentical?.has(pair.c.path) && m.matchIdentical(pair)) continue;
    m.matchSiblings(pair.b.units, pair.c.units, pair.hunks);
  }

  const { bUnits, cUnits } = prUnits(input);
  m.matchVerbatimMoves(bUnits, cUnits, input, scopeIndex(input), scopeChanges);

  return {
    matches: m.matches,
    byC: m.byC,
    byB: m.byB,
    nameWarnings: m.nameWarnings,
    duplicateKeys: [...new Set([...dupB, ...dupC])].sort(),
    scopeChanges,
  };
}

/**
 * Re-derives the scope changes from a finished match (for a caller that has
 * the policy but not the matcher's result): refused file pairs plus verbatim
 * moves between a deleted product unit and an added test unit or vice versa.
 */
export function scopeChangesOf(input: PairInput, matches: readonly UnitMatch[]): ScopeChange[] {
  const refused: ScopeChange[] = [];
  filePairs(input, refused);
  const m = new Matcher(new Set(), new Set(), 15);
  for (const x of matches) {
    m.matches.push(x);
    m.byB.set(x.bKey, x);
    m.byC.set(x.cKey, x);
  }
  const { bUnits, cUnits } = prUnits(input);
  const idx = scopeIndex(input);
  for (const [b, c] of m.verbatimCandidates(bUnits, cUnits)) {
    const from = scopeB(idx, b.path);
    const to = scopeC(idx, c.path);
    if (from !== to) refuseMove(refused, b, c, from, to);
  }
  return refused;
}
