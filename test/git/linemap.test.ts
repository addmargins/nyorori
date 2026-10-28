import { describe, expect, it } from "vitest";
import {
  cRangeTouched,
  hunkOfB,
  hunkOfC,
  mapLine,
  parseUnifiedZeroDiff,
} from "../../src/git/linemap.js";

const map = (patch: string) => ({ hunks: parseUnifiedZeroDiff(patch) });

describe("parseUnifiedZeroDiff", () => {
  it("parses omitted counts as 1", () => {
    expect(parseUnifiedZeroDiff("@@ -3 +3 @@\n-a\n+b\n")).toEqual([{ bStart: 3, bCount: 1, cStart: 3, cCount: 1 }]);
  });
  it("parses insertions and deletions", () => {
    expect(parseUnifiedZeroDiff("@@ -0,0 +1,2 @@ ctx\n+x\n+y\n@@ -9,2 +10,0 @@\n-a\n-b\n")).toEqual([
      { bStart: 0, bCount: 0, cStart: 1, cCount: 2 },
      { bStart: 9, bCount: 2, cStart: 10, cCount: 0 },
    ]);
  });
  it("tolerates CRLF headers and no-newline markers", () => {
    const p = "diff --git a b\r\n@@ -1 +1 @@\r\n-a\r\n\\ No newline at end of file\r\n+b\r\n\\ No newline at end of file\r\n";
    expect(parseUnifiedZeroDiff(p)).toEqual([{ bStart: 1, bCount: 1, cStart: 1, cCount: 1 }]);
  });
  it("ignores body lines that look like headers only when they start with @@ ", () => {
    expect(parseUnifiedZeroDiff("@@ -1 +1 @@\n-@@ fake\n+ @@ -9 +9 @@\n")).toHaveLength(1);
  });
  it("rejects malformed headers", () => {
    expect(() => parseUnifiedZeroDiff("@@ -x +1 @@\n")).toThrow();
  });
});

describe("mapLine", () => {
  it("identity without hunks", () => {
    expect(mapLine({ hunks: [] }, 7)).toBe(7);
  });
  it("insertion at the top shifts everything", () => {
    const m = map("@@ -0,0 +1,3 @@\n");
    expect(mapLine(m, 1)).toBe(4);
    expect(mapLine(m, 10)).toBe(13);
  });
  it("insertion after line 5 leaves 1..5 alone", () => {
    const m = map("@@ -5,0 +6,2 @@\n");
    expect(mapLine(m, 5)).toBe(5);
    expect(mapLine(m, 6)).toBe(8);
  });
  it("lines inside a rewrite hunk have no mapping", () => {
    const m = map("@@ -3,2 +3,4 @@\n");
    expect(mapLine(m, 2)).toBe(2);
    expect(mapLine(m, 3)).toBeUndefined();
    expect(mapLine(m, 4)).toBeUndefined();
    expect(mapLine(m, 5)).toBe(7);
  });
  it("deletion at EOF", () => {
    const m = map("@@ -9,2 +8,0 @@\n");
    expect(mapLine(m, 8)).toBe(8);
    expect(mapLine(m, 9)).toBeUndefined();
    expect(mapLine(m, 10)).toBeUndefined();
  });
  it("adjacent hunks accumulate", () => {
    const m = map("@@ -2 +2,3 @@\n@@ -3,0 +6 @@\n@@ -5,2 +8,0 @@\n");
    expect(mapLine(m, 1)).toBe(1);
    expect(mapLine(m, 2)).toBeUndefined();
    expect(mapLine(m, 3)).toBe(5);
    expect(mapLine(m, 4)).toBe(7);
    expect(mapLine(m, 5)).toBeUndefined();
    expect(mapLine(m, 7)).toBe(8);
  });
});

describe("hunk lookups", () => {
  const m = map("@@ -3,2 +3,4 @@\n@@ -10,0 +13,2 @@\n@@ -20 +23,0 @@\n");
  it("hunkOfB / hunkOfC", () => {
    expect(hunkOfB(m, 3)).toBe(0);
    expect(hunkOfB(m, 10)).toBe(-1); // pure insertion removes nothing
    expect(hunkOfB(m, 20)).toBe(2);
    expect(hunkOfC(m, 6)).toBe(0);
    expect(hunkOfC(m, 13)).toBe(1);
    expect(hunkOfC(m, 23)).toBe(-1);
  });
  it("every rewritten or added C line belongs to exactly one hunk; every removed B line too", () => {
    const changedC = Array.from({ length: 30 }, (_, i) => i + 1).filter((l) => hunkOfC(m, l) !== -1);
    const removedB = Array.from({ length: 30 }, (_, i) => i + 1).filter((l) => hunkOfB(m, l) !== -1);
    expect(changedC).toEqual([3, 4, 5, 6, 13, 14]);
    expect(removedB).toEqual([3, 4, 20]);
  });
  it("cRangeTouched sees rewrites and deletions inside a range", () => {
    expect(cRangeTouched(m, 1, 2)).toBe(false);
    expect(cRangeTouched(m, 6, 9)).toBe(true);
    expect(cRangeTouched(m, 20, 30)).toBe(true); // deletion after C line 23
    expect(cRangeTouched(m, 24, 30)).toBe(false);
  });
});
