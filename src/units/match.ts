// B→C unit correspondence (spec 5.4): "if it is not certain, it is new".
// A legacy allowance (limit > T) is only inherited through one of four
// pieces of evidence; anything else is matched to nothing, which can only
// make the verdict stricter.

import type {
  FileLineMap,
  FileMeasurement,
  Hunk,
  Manifest,
  MatchStage,
  Unit,
  UnitMatch,
} from "../types.js";
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

/** Does any hunk add or modify C lines inside [start, end]? */
export function cRangeTouched(hunks: readonly Hunk[], start: number, end: number): boolean {
  return hunks.some(
    (h) => h.cCount > 0 && h.cStart <= end && h.cStart + h.cCount - 1 >= start,
  );
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
}

export interface MatchResult {
  matches: UnitMatch[];
  byC: Map<string, UnitMatch>;
  byB: Map<string, UnitMatch>;
  /** C units whose suspicious names barred them from name-based matching. */
  nameWarnings: Array<{ unit: string; warning: string }>;
}

export interface FilePair {
  b: FileMeasurement;
  c: FileMeasurement;
  hunks: readonly Hunk[];
}

/** Modified or renamed files measured on both sides, with their hunks. */
export function filePairs(input: MatchInput): FilePair[] {
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

class Matcher {
  readonly matches: UnitMatch[] = [];
  readonly byC = new Map<string, UnitMatch>();
  readonly byB = new Map<string, UnitMatch>();
  readonly nameWarnings: Array<{ unit: string; warning: string }> = [];
  private readonly warned = new Set<string>();

  add(b: Unit, c: Unit, stage: MatchStage): void {
    const m: UnitMatch = {
      bKey: b.key,
      cKey: c.key,
      stage,
      identityChanged: stage === 2 || stage === 3,
    };
    this.matches.push(m);
    this.byB.set(b.key, m);
    this.byC.set(c.key, m);
  }

  isMatched(u: Unit, side: "B" | "C"): boolean {
    return (side === "B" ? this.byB : this.byC).has(u.key);
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

  /** Stages 1-3 for one sibling group, then recurse into matched pairs. */
  matchSiblings(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    const counterpart = (b: Unit) => this.byB.get(b.key);
    this.stageFixedPoint(bs, cs, hunks);
    this.stageSameHunk(bs, cs, hunks);
    this.stageUniqueName(bs, cs);
    const cByKey = new Map(cs.map((c) => [c.key, c]));
    for (const b of bs) {
      const m = counterpart(b);
      const c = m && cByKey.get(m.cKey);
      if (c) this.matchSiblings(b.children, c.children, hunks);
    }
  }

  private stageFixedPoint(bs: readonly Unit[], cs: readonly Unit[], hunks: readonly Hunk[]): void {
    for (const b of bs) {
      if (this.isMatched(b, "B")) continue;
      const target = mapBLine(hunks, b.line);
      if (target === undefined) continue;
      const nameB = b.name.normalize("NFKC");
      const candidates = cs.filter(
        (c) =>
          !this.isMatched(c, "C") &&
          c.name.normalize("NFKC") === nameB &&
          c.kind === b.kind &&
          c.line === target &&
          c.lineOrdinal === b.lineOrdinal,
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
      if (this.isMatched(b, "B")) continue;
      const h = hunkIndexOfB(hunks, b.line);
      if (h >= 0) group(h, b.kind).b.push(b);
    }
    for (const c of cs) {
      if (this.isMatched(c, "C")) continue;
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

  private stageUniqueName(bs: readonly Unit[], cs: readonly Unit[]): void {
    const index = (us: readonly Unit[], side: "B" | "C") => {
      const m = new Map<string, Unit[]>();
      for (const u of us) {
        if (this.isMatched(u, side)) continue;
        const name = this.trustedName(u);
        if (name === undefined) continue;
        const k = `${name}\u0000${u.kind}`;
        const list = m.get(k);
        if (list) list.push(u);
        else m.set(k, [u]);
      }
      return m;
    };
    const bIdx = index(bs, "B");
    const cIdx = index(cs, "C");
    for (const [k, bList] of bIdx) {
      const cList = cIdx.get(k);
      if (bList.length === 1 && cList?.length === 1) this.add(bList[0]!, cList[0]!, 3);
    }
  }

  /** Stage 4: verbatim move anywhere in the PR, unique PR-wide. */
  matchVerbatimMoves(bUnits: readonly Unit[], cUnits: readonly Unit[]): void {
    const signature = (u: Unit, name: string) => `${name}\u0000${shape(u)}`;
    const pool = (us: readonly Unit[], side: "B" | "C") => {
      const m = new Map<string, Unit[]>();
      for (const u of us) {
        if (u.isResidue || this.isMatched(u, side)) continue;
        const name = this.trustedName(u);
        if (name === undefined) continue;
        const k = signature(u, name);
        const list = m.get(k);
        if (list) list.push(u);
        else m.set(k, [u]);
      }
      return m;
    };
    const bPool = pool(bUnits, "B");
    const cPool = pool(cUnits, "C");
    for (const [k, bList] of bPool) {
      const cList = cPool.get(k);
      if (bList.length !== 1 || cList?.length !== 1) continue;
      const [b, c] = [bList[0]!, cList[0]!];
      if (this.isMatched(b, "B") || this.isMatched(c, "C")) continue;
      this.pairTree(b, c);
    }
  }

  /** Identical shapes: pair the trees node by node. */
  private pairTree(b: Unit, c: Unit): void {
    if (this.isMatched(b, "B") || this.isMatched(c, "C")) return;
    this.add(b, c, 4);
    b.children.forEach((bc, i) => {
      const cc = c.children[i];
      if (cc) this.pairTree(bc, cc);
    });
  }
}

/** Structural fingerprint used by stage 4: kind, CogC, CC, recursively. */
function shape(u: Unit): string {
  return `${u.kind}:${u.cognitive}:${u.cyclomatic}(${u.children.map(shape).join(",")})`;
}

export function matchUnits(input: MatchInput): MatchResult {
  const m = new Matcher();
  for (const pair of filePairs(input)) {
    m.add(pair.b.residue, pair.c.residue, 1);
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
  m.matchVerbatimMoves(bUnits, cUnits);

  return { matches: m.matches, byC: m.byC, byB: m.byB, nameWarnings: m.nameWarnings };
}
