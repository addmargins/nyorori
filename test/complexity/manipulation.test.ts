// Spec 7.2/7.5 experiment with the real cccc binary: the G1 verdict for each
// behavior-preserving variant and the review triggers G1 fires. These pin
// measured behavior (see test/fixtures/manipulation/RESULTS.md); comments
// flag where it differs from the spec's table.

import { describe, expect, it } from "vitest";
import { analyzeVariant, type VariantRow } from "./analyze.js";
import { VARIANTS } from "./variants.js";

const cache = new Map<string, Promise<VariantRow>>();
const row = (id: string): Promise<VariantRow> => {
  let r = cache.get(id);
  if (!r) {
    const v =
      id === "original"
        ? { id, dir: "original", description: "원본", kind: "manipulation" as const }
        : VARIANTS.find((x) => x.id === id)!;
    r = analyzeVariant(v);
    cache.set(id, r);
  }
  return r;
};

describe("spec 7.2 variants through G1", () => {
  it("original: CogC 24 / CC 17 fails as new code; unchanged legacy passes silently", async () => {
    const r = await row("original");
    expect([r.units, r.maxCognitive, r.maxCyclomatic, r.visibleBranches]).toEqual([1, 24, 17, 16]);
    expect(r.newCodeVerdict).toBe("FAIL");
    expect(r.fresh.outcome.violations[0]!.reason).toBe("OVER_LIMIT_NEW");
    expect(r.legacyVerdict).toBe("PASS");
    expect(r.legacyTriggers).toEqual([]);
  });

  // [id, G1 verdict as new code, routing triggers with the original in B, routing triggers as new code]
  const expected: Array<[string, "PASS" | "FAIL", string[], string[]]> = [
    ["a", "PASS", ["S1", "S5"], []], // honest refactor routes too (spec admits S1 fires on (a))
    ["a′", "PASS", ["S1", "S5"], []],
    ["b", "PASS", ["S1", "S5", "S10"], ["S10"]],
    ["c", "PASS", ["S5", "S9", "S10"], ["S10"]],
    ["d", "PASS", ["S5", "S9", "S10"], ["S10"]],
    ["d′", "PASS", ["S1", "S5", "S10"], ["S10"]], // density exactly 0.60 (spec measured 0.36)
    ["e", "FAIL", ["S5"], []], // <module> residue 22 > 15
    ["e′", "PASS", ["S5", "S9"], []], // residues 12 + 10: the file split defeats the residue rule
    ["e″", "PASS", ["S5"], []], // residue 15 = limit (spec: 28, FAIL — different code)
    ["f", "PASS", ["S5", "S9"], []], // invisible to G1 as new code: G2's S9 selectors must catch it
    ["f′", "PASS", ["S5", "S9"], []],
    ["f″", "PASS", ["S5", "S9", "S10"], ["S10"]],
    ["g", "FAIL", ["S5"], []],
    ["h", "PASS", ["S1", "S5"], []],
    ["i", "PASS", ["S9", "S11"], []], // only G2 DYNAMIC_CODE stops new-code (i)
    ["i′", "PASS", ["S1", "S5", "S10"], ["S10"]],
    ["j", "PASS", ["S1", "S5"], []],
  ];

  for (const [id, verdict, legacy, fresh] of expected) {
    it(`${id}: G1 ${verdict}; legacy ${legacy.join("+") || "-"}; new ${fresh.join("+") || "-"}`, async () => {
      const r = await row(id);
      expect(r.newCodeVerdict).toBe(verdict);
      expect(r.legacyTriggers).toEqual(legacy);
      expect(r.newTriggers).toEqual(fresh);
    });
  }

  it("S1 never fires on new code: it needs the concentrated version in B", async () => {
    for (const v of VARIANTS) expect((await row(v.id)).newTriggers).not.toContain("S1");
  });

  it("S1 evidence uses visible branches, not ΣCogC (b: V 16→16, ΣCogC 24→17)", async () => {
    const r = await row("b");
    const s1 = r.legacy.outcome.triggers.find((t) => t.id === "S1")!;
    expect(s1.evidence).toBe("V 16→16, 단위 1→12, 최대 CogC 24→4");
  });

  it("(i) vanish: the bound name survives, so S11 fires", async () => {
    const r = await row("i");
    const s11 = r.legacy.outcome.triggers.find((t) => t.id === "S11")!;
    expect(s11.unit).toBe("src/pricing.js::price#function[0]");
  });

  it("(e) fails on the module residue, not on a function", async () => {
    const r = await row("e");
    expect(r.fresh.outcome.violations.map((v) => [v.unit, v.after])).toEqual([["src/pricing.js::<module>", 22]]);
  });
});
