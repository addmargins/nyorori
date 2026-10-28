// Release-readiness regressions (docs/traceability.md gaps): spec 9.1 N/A
// rules, V10, moving-baseline S1/S10 and P2 blocking, scope files in C,
// determinism, zero-function files, Prettier-formatted splitting, deep nesting.

import { readFileSync } from "node:fs";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { TestRepo, fnWithCogc, gate, run, servicePolicy } from "./helpers.js";

const FIX = new URL("../fixtures/", import.meta.url).pathname;
const original = readFileSync(`${FIX}manipulation/original/price.js`, "utf8");
const variantB = readFileSync(`${FIX}manipulation/b/price.js`, "utf8");
const routed = (out: Awaited<ReturnType<typeof run>>) => [...new Set(out.verdict.triggers.map((t) => t.id))].sort();
const G1 = ["complexity", "lint-structure", "deps"] as const;

describe("spec 9.1 applicability", () => {
  it("a deletion-only change is NOT_APPLICABLE with the reason recorded", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": fnWithCogc("a", 20), "src/b.ts": fnWithCogc("b", 3) });
    const c = repo.commit({ "src/a.ts": null });
    const out = await run(repo, b, c, servicePolicy());
    for (const g of G1) {
      expect(gate(out, g).state, g).toBe("NOT_APPLICABLE");
      expect(gate(out, g).summary, g).toBe("N/A: deletion only");
      expect(gate(out, g).observe.not_applicable_reason).toBe("deletion only");
    }
    expect(out.verdict.state).toBe("NOT_APPLICABLE");
    repo.dispose();
  });

  it("a docs-only change says no measured code changed", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "a\n" });
    const c = repo.commit({ "README.md": "b\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").summary).toBe("N/A: no measured code changed");
    repo.dispose();
  });

  it("a file with no functions is measured and passes", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "a\n" });
    const c = repo.commit({ "src/consts.ts": "export const LIMIT = 15;\nexport type Id = string;\n" });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").state).toBe("PASS");
    expect(out.verdict.state).toBe("PASS");
    repo.dispose();
  });
});

describe("V10: hiding part of a legacy unit to pay for a new branch", () => {
  it("routes S5 and S9 and blocks the merge although the unit did not worsen", async () => {
    const coupon = original.slice(original.indexOf("  if (order.coupon) {"), original.indexOf("  if (user.vip"));
    const hidden = [
      "  const coupon = order.coupon;",
      "  let pct = !!coupon;",
      '  pct &&= coupon.type === "percent";',
      "  pct &&= ((total *= 1 - coupon.value / 100), true);",
      "  let fixed = !!coupon;",
      '  fixed &&= coupon.type === "fixed";',
      "  fixed &&= total > coupon.value;",
      "  fixed &&= ((total -= coupon.value), true);",
      "",
    ].join("\n");
    const withBranch = original
      .replace(coupon, hidden)
      .replace("    total += line;\n", "    if (item.gift) {\n      if (user.member) line = 0;\n    }\n    total += line;\n");
    const repo = new TestRepo();
    const b = repo.commit({ "src/price.js": original });
    const c = repo.commit({ "src/price.js": withBranch });
    const out = await run(repo, b, c, servicePolicy());
    const unit = gate(out, "complexity");
    expect(unit.violations).toEqual([]);
    expect(routed(out)).toEqual(expect.arrayContaining(["S5", "S9"]));
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });
});

describe("moving baseline: helper splitting over three PRs (spec 14.35)", () => {
  const n = 12;
  const helper = (i: number) => `function k${i}(x) {\n  if (x.f${i}) return ${i};\n  return 0;\n}\n`;
  /** `split` of the 12 checks moved into single-use helpers. */
  const source = (split: number) => {
    const helpers = Array.from({ length: split }, (_, i) => helper(i)).join("");
    const body = Array.from({ length: n }, (_, i) => (i < split ? `  t += k${i}(x);` : `  if (x.f${i}) t += ${i};`)).join("\n");
    return `${helpers}export function score(x) {\n  let t = 0;\n${body}\n  return t;\n}\n`;
  };

  it("no PR fires S1/S10 alone; the third fires them against the moving baseline, and P2 blocks", async () => {
    const repo = new TestRepo();
    const heads = [repo.commit({ "src/score.js": source(0) })];
    const observe = servicePolicy({ triggers: { moving_baseline: { route: false } } });
    let last: Awaited<ReturnType<typeof run>> | undefined;
    for (const split of [4, 8, 12]) {
      const pr = repo.commit({ "src/score.js": source(split) });
      last = await run(repo, heads[heads.length - 1]!, pr, observe);
      const own = gate(last, "complexity").triggers.filter((t) => !t.evidence.startsWith("moving baseline"));
      expect(own.filter((t) => t.id === "S1" || t.id === "S10"), `split ${split}`).toEqual([]);
      heads.push(pr);
    }
    const moving = gate(last!, "complexity").triggers.filter((t) => t.evidence.startsWith("moving baseline"));
    expect(moving.map((t) => t.id)).toEqual(expect.arrayContaining(["S1", "S10"]));
    expect(moving.every((t) => !t.routing)).toBe(true);
    expect(last!.verdict.mergeAllowed).toBe(true);

    const p2 = servicePolicy({ triggers: { moving_baseline: { route: true } } });
    const blocked = await run(repo, heads[2]!, heads[3]!, p2);
    expect(blocked.verdict.mergeAllowed).toBe(false);
    expect(blocked.verdict.blocking.map((v) => v.reason)).toEqual(["REVIEW_REQUIRED"]);
    repo.dispose();
  });
});

describe("scope cannot be changed from the candidate", () => {
  it(".cccc.toml, .ignore and .gitignore added by C leave the measured set unchanged", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({
      ".cccc.toml": 'exclude = ["**"]\n',
      ".ignore": "src/\n",
      ".gitignore": "src/\n",
      "src/a.ts": fnWithCogc("a", 16),
    });
    const out = await run(repo, b, c, servicePolicy());
    expect(out.manifest.entries.find((e) => e.c?.path === "src/a.ts")?.measure.C).toBe(true);
    expect(gate(out, "complexity").violations.map((v) => v.reason)).toEqual(["OVER_LIMIT_NEW"]);
    repo.dispose();
  });
});

describe("determinism (spec 14 repeat runs)", () => {
  it("the same B/C/P/M gives the same verdict and results", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "src/price.js": original });
    const c = repo.commit({ "src/price.js": variantB, "src/a.ts": fnWithCogc("a", 16) });
    const norm = (o: Awaited<ReturnType<typeof run>>) =>
      JSON.stringify({ verdict: o.verdict, results: o.results }).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");
    const first = await run(repo, b, c, servicePolicy());
    const second = await run(repo, b, c, servicePolicy());
    expect(norm(second)).toBe(norm(first));
    repo.dispose();
  });
});

describe("formatting does not hide splitting", () => {
  it("variant (b) reformatted with a different Prettier style still fires S1 and S10", async () => {
    const formatted = await format(variantB, { parser: "babel", printWidth: 40, singleQuote: true, semi: false });
    const repo = new TestRepo();
    const b = repo.commit({ "src/price.js": original });
    const c = repo.commit({ "src/price.js": formatted });
    const out = await run(repo, b, c, servicePolicy());
    expect(routed(out)).toEqual(expect.arrayContaining(["S1", "S10"]));
    repo.dispose();
  });
});

describe("pathological nesting", () => {
  it("a literal nested deeper than 1000 levels is INCONCLUSIVE PARSE_ERROR_CANDIDATE", async () => {
    const depth = 1100;
    const deep = `export const x = ${"[".repeat(depth)}${"]".repeat(depth)};\n`;
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/deep.js": deep });
    const out = await run(repo, b, c, servicePolicy());
    expect(gate(out, "complexity").inconclusive.map((i) => i.reason)).toContain("PARSE_ERROR_CANDIDATE");
    expect(out.verdict.mergeAllowed).toBe(false);
    repo.dispose();
  });
});
