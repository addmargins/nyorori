// Spec 7.2/7.5 experiment with the real cccc binary: what G1 alone decides
// for each behavior-preserving variant, and which review triggers fire.
// The expectations record measured behavior; where it differs from the
// spec's table, the comment says so.

import { describe, expect, it } from "vitest";
import { analyzeVariant, type VariantRow } from "./analyze.js";
import { VARIANTS } from "./variants.js";

const rows = new Map<string, VariantRow>();
const row = async (id: string) => {
  let r = rows.get(id);
  if (!r) {
    const v = id === "original" ? { id, dir: "original", description: "원본", kind: "manipulation" as const } : VARIANTS.find((x) => x.id === id)!;
    r = await analyzeVariant(v);
    rows.set(id, r);
  }
  return r;
};

describe("spec 7.2 variants through G1", () => {
  it("original: CogC 24 / CC 17, FAILs as new code", async () => {
    const r = await row("original");
    expect([r.maxCognitive, r.maxCyclomatic, r.units]).toEqual([24, 17, 1]);
    expect(r.newCodeVerdict).toBe("FAIL");
    expect(r.fresh.outcome.violations[0]!.reason).toBe("OVER_LIMIT_NEW");
    // Unchanged legacy code never fails and fires no trigger.
    expect(r.legacyVerdict).toBe("PASS");
    expect(r.legacyTriggers).toEqual([]);
  });

  // [id, new-code G1 verdict, routing triggers when B holds the original]
  const expected: Array<[string, "PASS" | "FAIL", string[]]> = [
    ["a", "PASS", ["S1"]], // honest refactor also routes to review (spec: S1 fires on (a))
    ["a′", "PASS", ["S1"]],
    ["b", "PASS", ["S1", "S10"]],
    ["c", "PASS", ["S9", "S10"]],
    ["d", "PASS", ["S1", "S9", "S10"]],
    ["d′", "PASS", ["S1"]],
    ["e", "FAIL", ["S9"]], // module residue 22 > 15
    ["e′", "PASS", ["S9"]], // split across two files: residues 12 + 10, both pass
    ["e″", "FAIL", []],
    ["f", "PASS", ["S9"]],
    ["f′", "PASS", ["S9"]],
    ["f″", "PASS", ["S9", "S10"]],
    ["g", "FAIL", []],
    ["h", "PASS", ["S1"]],
    ["i", "PASS", ["S9", "S11"]],
    ["i′", "PASS", ["S1", "S10"]],
    ["j", "PASS", ["S1"]],
  ];

  for (const [id, verdict, triggers] of expected) {
    it(`${id}: G1 ${verdict}, legacy triggers ${triggers.join("+") || "none"}`, async () => {
      const r = await row(id);
      expect(r.newCodeVerdict).toBe(verdict);
      expect(r.legacyTriggers).toEqual(triggers);
    });
  }

  it("written from scratch, the hiding variants route only through S10 (S1/S9 need the complex version in B)", async () => {
    const fired = new Map<string, string[]>();
    for (const id of ["b", "d", "f", "f′", "f″", "i"]) fired.set(id, (await row(id)).newTriggers);
    expect(Object.fromEntries(fired)).toEqual({
      b: ["S10"],
      d: ["S10"],
      f: [],
      "f′": [],
      "f″": ["S10"],
      i: [],
    });
  });
});
