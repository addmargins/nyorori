// B→C unit correspondence (spec 5.4): "if it is not certain, it is new".
// A legacy allowance (limit > T) is only inherited through one of four
// pieces of evidence; anything else is matched to nothing, which can only
// make the verdict stricter. Rulings D21 add two narrow cases: a file whose
// normalized text did not change, and k-to-k groups of same-named siblings.

import { cRangeTouched as linemapCRangeTouched } from "../git/linemap.js";
import type {
  FileLineMap,
  FileMeasurement,
  Hunk,
  Manifest,
  MatchStage,
  Unit,
  UnitMatch,
} from "../types.js";
import { unitBodyText } from "./body.js";
import { flattenUnits } from "./model.js";
import { checkName } from "./names.js";

const ANONYMOUS = "<anonymous>";

// ---------------------------------------------------------------------------
// Line-map helpers over `git diff -U0` hunks
// ---------------------------------------------------------------------------

/** True when the hunk replaces/removes B lines containing `bLine`. */
function bHunkContains(h: Hunk, bLine: number): boolean {
  return h.bCount > 0 && bLine >= h.bStart && bLine < h.bStart + h.bCount;
}

/** True when the hunk adds C lines containing `cLine`. */
function cHunkContains(h: Hunk, cLine: number): boolean {
  return h.cCount > 0 && cLine >= h.cStart && cLine < h.cStart + h.cCount;
}

/** Hunks lie entirely before `bLine` in B (insertions sit after `bStart`). */
function hunkBeforeB(h: Hunk, bLine: number): boolean {
  return h.bCount > 0 ? h.bStart + h.bCount - 1 < bLine : h.bStart < bLine;
}

/** C line for an unmodified B line, or undefined when the B line was changed. */
export function mapBLine(hunks: readonly Hunk[], bLine: number): number | undefined {
  let offset = 0;
  for (const h of hunks) {
    if (bHunkContains(h, bLine)) return undefined;
    if (hunkBeforeB(h, bLine)) offset += h.cCount - h.bCount;
  }
  return bLine + offset;
}

export function hunkIndexOfB(hunks: readonly Hunk[], bLine: number): number {
  return hunks.findIndex((h) => bHunkContains(h, bLine));
}

export function hunkIndexOfC(hunks: readonly Hunk[], cLine: number): number {
  return hunks.findIndex((h) => cHunkContains(h, cLine));
}

/**
 * Does any hunk add or modify C lines inside [start, end], or delete lines
 * strictly inside it? Same semantics as `src/git/linemap.ts`.
 */
export function cRangeTouched(hunks: readonly Hunk[], start: number, end: number): boolean {
  return linemapCRangeTouched({ hunks: [...hunks] }, start, end);
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
}

export interface MatchResult {
  matches: UnitMatch[];
  byC: Map<string, UnitMatch>;
  byB: Map<string, UnitMatch>;
  /** C units whose suspicious names barred them from name-based matching. */
  nameWarnings: Array<{ unit: string; warning: string }>;
  /** Keys that occur more than once on one side; such units are never matched. */
  duplicateKeys?: string[];
}

export interface FilePair {
  b: FileMeasurement;
  c: FileMeasurement;
  hunks: readonly Hunk[];
}

/** Modified or renamed files measured on both sides, with their hunks. */
export function filePairs(input: Pick<MatchInput, "manifest" | "b" | "c" | "lineMaps" | "baselineMissing">): FilePair[] {
  const pairs: FilePair[] = [];
  for (const e of input.manifest.entries) {
    if (e.status !== "M" && e.status !== "R") continue;
    if (!e.b || !e.c || !e.measure.B || !e.measure.C) continue;
    if (input.baselineMissing?.has(e.c.path)) continue;
    const b = input.b.get(e.b.path);
    const c = input.c.get(e.c.path);
    if (!b || !c) continue;
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
    const index = new Map<string, Unit[]>();
    const at = (name: string, kind: string, line: number, ordinal: number) =>
      `${name}\u0000${kind}\u0000${line}\u0000${ordinal}`;
    for (const c of cs) {
      if (!this.unavailable(c, "C")) push(index, at(c.name.normalize("NFKC"), c.kind, c.line, c.lineOrdinal), c);
    }
    for (const b of bs) {
      if (this.unavailable(b, "B")) continue;
      const target = mapBLine(hunks, b.line);
      if (target === undefined) continue;
      const candidates = (index.get(at(b.name.normalize("NFKC"), b.kind, target, b.lineOrdinal)) ?? []).filter(
        (c) => !this.unavailable(c, "C"),
      );
      if (candidates.length === 1) this.add(b, candidates[0]!, 1);
    }
  }

  private stageSameHunk(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    const groups = new Map<string, { b: Unit[]; c: Unit[] }>();
    const group = (hunk: number, kind: string) => {
      const k = `${hunk}\u0000${kind}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { b: [], c: [] }));
      return g;
    };
    for (const b of bs) {
      if (this.unavailable(b, "B")) continue;
      const h = hunkIndexOfB(hunks, b.line);
      if (h >= 0) group(h, b.kind).b.push(b);
    }
    for (const c of cs) {
      if (this.unavailable(c, "C")) continue;
      const h = hunkIndexOfC(hunks, c.line);
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

  private nameIndex(us: readonly Unit[], side: "B" | "C", allowAnonymous: boolean): Map<string, Unit[]> {
    const m = new Map<string, Unit[]>();
    for (const u of us) {
      if (this.unavailable(u, side)) continue;
      const name = u.name === ANONYMOUS && allowAnonymous ? ANONYMOUS : this.trustedName(u);
      if (name !== undefined) push(m, `${name}\u0000${u.kind}`, u);
    }
    return m;
  }

  private stageUniqueName(bs: readonly Unit[], cs: readonly Unit[]): void {
    const bIdx = this.nameIndex(bs, "B", false);
    const cIdx = this.nameIndex(cs, "C", false);
    for (const [k, bList] of bIdx) {
      const cList = cIdx.get(k);
      if (bList.length === 1 && cList?.length === 1) this.add(bList[0]!, cList[0]!, 3);
    }
  }

  /**
   * Ruling D21b: k ≥ 2 leftover siblings of one (name, kind) on both sides.
   * Pair them by CogC descending; accept the whole group only when no C unit
   * would exceed max(T, its paired B), so the guess can never raise a limit
   * above what some B unit already had. Every pair is identity-changed.
   */
  private stageKToK(bs: readonly Unit[], cs: readonly Unit[]): void {
    const bIdx = this.nameIndex(bs, "B", true);
    const cIdx = this.nameIndex(cs, "C", true);
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

  /** Stage 4: verbatim move anywhere in the PR, unique PR-wide. */
  matchVerbatimMoves(
    bUnits: readonly Unit[],
    cUnits: readonly Unit[],
    sourcesB?: ReadonlyMap<string, string>,
    sourcesC?: ReadonlyMap<string, string>,
  ): void {
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
    for (const [k, bList] of bPool) {
      const cList = cPool.get(k);
      if (bList.length !== 1 || cList?.length !== 1) continue;
      const [b, c] = [bList[0]!, cList[0]!];
      if (this.unavailable(b, "B") || this.unavailable(c, "C")) continue;
      // Equal scores are not equal logic (audit F4): without proof, S5 reviews it.
      const srcB = sourcesB?.get(b.path);
      const srcC = sourcesC?.get(c.path);
      const verbatim = srcB !== undefined && srcC !== undefined && unitBodyText(srcB, b) === unitBodyText(srcC, c);
      this.pairTree(b, c, !verbatim);
    }
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

export function matchUnits(input: MatchInput): MatchResult {
  const dupB = duplicateKeySet(input.b.values());
  const dupC = duplicateKeySet(input.c.values());
  const m = new Matcher(dupB, dupC, input.limit ?? 15);
  for (const pair of filePairs(input)) {
    if (!dupB.has(pair.b.residue.key) && !dupC.has(pair.c.residue.key)) {
      m.add(pair.b.residue, pair.c.residue, 1);
    }
    if (input.normalizedIdentical?.has(pair.c.path) && m.matchIdentical(pair)) continue;
    m.matchSiblings(pair.b.units, pair.c.units, pair.hunks);
  }

  // Stage 4 sees every measured B and C unit of the PR except files with no baseline.
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
  m.matchVerbatimMoves(bUnits, cUnits, input.sourcesB, input.sourcesC);

  return {
    matches: m.matches,
    byC: m.byC,
    byB: m.byB,
    nameWarnings: m.nameWarnings,
    duplicateKeys: [...new Set([...dupB, ...dupC])].sort(),
  };
}
