// Property check before deduplicating the hunk helpers: src/git/linemap.ts
// and the former matcher copies must agree with a ground-truth simulation of
// `git diff -U0` hunks (sorted, non-overlapping, insertions after bStart).

import { describe, expect, it } from "vitest";
import { hunkOfB, hunkOfC, mapLine } from "../../src/git/linemap.js";
import type { Hunk } from "../../src/types.js";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  hunks: Hunk[];
  bLines: number;
  cLines: number;
  /** Ground truth: C line of each unchanged B line, undefined when removed/rewritten. */
  map: Map<number, number | undefined>;
  /** Hunk index that removed/rewrote each B line, and that added each C line. */
  bOwner: Map<number, number>;
  cOwner: Map<number, number>;
}

/** Walks B, emitting git-style hunks; gaps of unchanged lines separate hunks. */
function randomCase(r: () => number): Case {
  const bLines = Math.floor(r() * 40);
  const hunks: Hunk[] = [];
  const map = new Map<number, number | undefined>();
  const bOwner = new Map<number, number>();
  const cOwner = new Map<number, number>();
  let b = 1;
  let c = 1;
  let lastWasHunk = false;
  while (b <= bLines + 1) {
    if (!lastWasHunk && r() < 0.3) {
      const del = b <= bLines ? Math.floor(r() * Math.min(4, bLines - b + 2)) : 0;
      const ins = Math.floor(r() * 4);
      if (del + ins > 0) {
        const idx = hunks.length;
        hunks.push({ bStart: del > 0 ? b : b - 1, bCount: del, cStart: ins > 0 ? c : c - 1, cCount: ins });
        for (let i = 0; i < del; i++) {
          map.set(b + i, undefined);
          bOwner.set(b + i, idx);
        }
        for (let i = 0; i < ins; i++) cOwner.set(c + i, idx);
        b += del;
        c += ins;
        lastWasHunk = true;
        continue;
      }
    }
    if (b > bLines) break;
    map.set(b, c);
    b++;
    c++;
    lastWasHunk = false;
  }
  return { hunks, bLines, cLines: c - 1, map, bOwner, cOwner };
}

describe("linemap helpers agree with a -U0 simulation", () => {
  it("mapLine / hunkOfB / hunkOfC on 3,000 random hunk lists", () => {
    const r = rng(42);
    for (let n = 0; n < 3000; n++) {
      const k = randomCase(r);
      const lm = { hunks: k.hunks };
      for (let bl = 1; bl <= k.bLines; bl++) {
        expect(mapLine(lm, bl)).toBe(k.map.get(bl));
        expect(hunkOfB(lm, bl)).toBe(k.bOwner.get(bl) ?? -1);
      }
      for (let cl = 1; cl <= k.cLines; cl++) expect(hunkOfC(lm, cl)).toBe(k.cOwner.get(cl) ?? -1);
    }
  });
});
