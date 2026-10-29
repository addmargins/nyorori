import { describe, expect, it } from "vitest";
import { deriveState } from "../../src/report/result.js";
import { conclusionFor, toCheckRun } from "../../src/report/checkrun.js";
import { renderSummaryMarkdown, unitDisplayName } from "../../src/report/markdown.js";
import { buildGateFeedback } from "../../src/report/feedback.js";
import { GATE_STATES } from "../../src/types.js";
import { result, violation } from "./helpers.js";

const inc = { reason: "MANIFEST_MISMATCH" as const, detail: "src/a.ts missing from cccc output", file: "src/a.ts", authorFixable: true };

describe("gate state", () => {
  it("orders FAIL > INCONCLUSIVE > ACCEPTED_WITH_WAIVER > PASS > NOT_APPLICABLE", () => {
    expect(deriveState([violation()], [inc], true)).toBe("FAIL");
    expect(deriveState([], [inc], true)).toBe("INCONCLUSIVE");
    expect(deriveState([violation({ waivedBy: "W1" })], [inc], true)).toBe("INCONCLUSIVE");
    expect(deriveState([violation({ waivedBy: "W1" })], [], true)).toBe("ACCEPTED_WITH_WAIVER");
    expect(deriveState([violation({ waivedBy: "W1" }), violation({ unit: "x::y#function[0]" })], [], true)).toBe("FAIL");
    expect(deriveState([], [], true)).toBe("PASS");
    expect(deriveState([], [], false)).toBe("NOT_APPLICABLE");
    expect(deriveState([violation()], [], false)).toBe("FAIL");
  });

  it("reports FAIL and INCONCLUSIVE together, reasons deduped", () => {
    const r = result({ violations: [violation(), violation({ unit: "u2" })], inconclusive: [inc] });
    expect(r.state).toBe("FAIL");
    expect(r.reasons).toEqual(["OVER_LIMIT_NEW", "MANIFEST_MISMATCH"]);
    expect(r.summary).toContain("INCONCLUSIVE");
  });
});

describe("check runs", () => {
  it("never emits neutral or skipped for any state", () => {
    for (const s of GATE_STATES) expect(["success", "failure"]).toContain(conclusionFor(s));
  });

  it("INCONCLUSIVE is a failure titled with its reason", () => {
    const c = toCheckRun(result({ inconclusive: [inc] }));
    expect(c.conclusion).toBe("failure");
    expect(c.title).toBe("INCONCLUSIVE: MANIFEST_MISMATCH");
    expect(c.name).toBe("gate/complexity");
  });

  it("NOT_APPLICABLE is success titled N/A", () => {
    const c = toCheckRun(result({ applicable: false }));
    expect(c).toMatchObject({ conclusion: "success", title: "N/A" });
  });

  it("observe-mode gates are informational", () => {
    const c = toCheckRun(result({ mode: "observe", violations: [violation()] }));
    expect(c.conclusion).toBe("success");
    expect(c.title.startsWith("[observe] FAIL")).toBe(true);
  });
});

describe("markdown summary", () => {
  it("leads with the failure cause in the spec's wording", () => {
    const md = renderSummaryMarkdown([
      result({ gate: "lint-structure", applicable: true }),
      result({ violations: [violation()] }),
    ]);
    const failIdx = md.indexOf("applyDiscount: CogC 21, 한도 15 초과");
    expect(failIdx).toBeGreaterThan(0);
    expect(failIdx).toBeLessThan(md.indexOf("gate/lint-structure"));
  });

  it("shows legacy debt as debt, not as healthy", () => {
    const md = renderSummaryMarkdown([
      result({ observe: { legacy_debt: [{ unit: "src/a.ts::old#function[0]", before: 22, after: 22 }] } }),
    ]);
    expect(md).toContain("legacy debt");
    expect(md).toContain("건강한 코드가 아님");
  });

  it("extracts display names from unit keys", () => {
    expect(unitDisplayName("src/a.ts::Parser>run#method[0]")).toBe("run");
    expect(unitDisplayName("src/a.ts::<module>")).toBe("<module>");
  });
});

describe("AI feedback", () => {
  it("lists open violations and routing triggers with the forbidden-pattern instructions", () => {
    const fb = buildGateFeedback(
      [
        result({
          violations: [violation(), violation({ unit: "w", waivedBy: "W1" })],
          triggers: [
            { id: "S1", gate: "complexity", file: "src/a.ts", evidence: "V 16→16", routing: true },
            { id: "S8", gate: "complexity", file: "src/a.ts", evidence: "CogC 13", routing: false },
          ],
        }),
      ],
      { attempt: 1, preserve: ["npm test"] },
    );
    expect(fb.violations).toHaveLength(1);
    expect(fb.violations[0]).toMatchObject({ value: 21, limit: 15, location: "src/billing/plan.ts:42" });
    expect(fb.triggers.map((t) => t.id)).toEqual(["S1"]);
    expect(fb.instructions).toContain("문자열로 만든 함수");
  });
});

describe("waiver approval hints", () => {
  it("are fenced so the gate's own comment never counts as an approval", async () => {
    const { renderWaiverApprovalHints } = await import("../../src/report/markdown.js");
    const { findCommands } = await import("../../src/waivers/command.js");
    const md = renderWaiverApprovalHints([{ id: "W1", unit: "src/a.ts::f#function[0]", blob: "1".repeat(40) }]);
    expect(md).toContain("/gate-waive-approve W1 blob=");
    expect(findCommands(md, "gate-waive-approve")).toHaveLength(0);
  });
});
