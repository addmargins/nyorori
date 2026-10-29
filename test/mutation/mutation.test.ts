import { describe, expect, it } from "vitest";
import { formatMutationComment, strykerMutateArgs, summarizeMutation } from "../../src/gates/mutation/stryker.js";

const P = "src/price.ts";
const maps = [{ pathB: P, pathC: P, hunks: [{ bStart: 2, bCount: 1, cStart: 2, cCount: 3 }, { bStart: 9, bCount: 2, cStart: 11, cCount: 0 }] }];

const mutant = (id: string, line: number, status: string, mutatorName = "ConditionalExpression", replacement = "true") => ({
  id,
  mutatorName,
  replacement,
  status,
  location: { start: { line, column: 3 }, end: { line, column: 9 } },
});

const report = JSON.stringify({
  schemaVersion: "1.0",
  thresholds: { high: 80, low: 60 },
  files: {
    "/home/runner/work/app/app/src/price.ts": {
      language: "typescript",
      source: "",
      mutants: [
        mutant("1", 2, "Killed"),
        mutant("2", 3, "Survived", "EqualityOperator", "qty < 0"),
        mutant("3", 4, "NoCoverage"),
        mutant("4", 4, "Timeout"),
        mutant("5", 9, "Survived"),
        mutant("6", 3, "CompileError"),
      ],
    },
    "/home/runner/work/app/app/src/new.ts": { language: "typescript", source: "", mutants: [mutant("7", 1, "Survived", "StringLiteral", '"|`x`|"')] },
  },
});

describe("G7 mutation (observe)", () => {
  it("builds --mutate ranges for changed hunks and whole added files", () => {
    expect(strykerMutateArgs(maps, ["src/new.ts"])).toEqual(["src/new.ts", "src/price.ts:2-4"]);
  });

  it("restricts survivors to changed lines and scores them", () => {
    const r = summarizeMutation(report, maps, ["src/new.ts"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.survived.map((m) => `${m.file}:${m.line}`)).toEqual(["src/new.ts:1", "src/price.ts:3"]);
    expect(r.summary.noCoverage).toHaveLength(1);
    expect(r.summary.score).toBeCloseTo(2 / 5);
    const comment = formatMutationComment(r.summary);
    expect(comment).toContain("40.0%");
    expect(comment).toContain("| `src/price.ts:3` | EqualityOperator | `qty < 0` | Survived |");
    expect(comment).toContain("\\|'x'\\|");
  });

  it("is INCONCLUSIVE for missing or malformed reports", () => {
    expect(summarizeMutation(null, maps)).toMatchObject({ ok: false, inconclusive: { reason: "REPORT_MISSING" } });
    expect(summarizeMutation('{"files":{}}', maps)).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
    expect(summarizeMutation("nope", maps)).toMatchObject({ ok: false, inconclusive: { reason: "SCHEMA" } });
  });

  it("says so when no mutant hits changed lines", () => {
    const r = summarizeMutation(JSON.stringify({ schemaVersion: "1", files: {} }), maps);
    expect(r.ok && r.summary.score).toBeNull();
    expect(r.ok && formatMutationComment(r.summary)).toContain("No mutants on changed lines.");
  });
});
