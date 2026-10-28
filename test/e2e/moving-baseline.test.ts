// Spec 7.5 moving baseline: a `&&=` rewrite (spec 7.2 f) split over three PRs.
// Each PR alone stays under the S9 thresholds against its own B; against the
// moving baseline the third PR shows the whole rewrite.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseBaseline } from "../../src/pipeline/moving-baseline.js";
import type { ReviewComment } from "../../src/review/simplification.js";
import { TestRepo, approvalBody, run, servicePolicy } from "./helpers.js";

const FIX = new URL("../fixtures/", import.meta.url).pathname;
const original = readFileSync(`${FIX}moving-baseline/original.js`, "utf8");
const steps = [1, 2, 3].map((n) => readFileSync(`${FIX}moving-baseline/step${n}.js`, "utf8"));

type Price = (order: unknown, user: unknown) => number;
async function load(path: string): Promise<Price> {
  return ((await import(path)) as { price: Price }).price;
}

function randomOrder(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const cats = ["food", "electronics", "toys"];
  const items = Array.from({ length: Math.floor(rnd() * 5) }, () => ({
    qty: Math.floor(rnd() * 6) - 1,
    unitPrice: Math.round(rnd() * 20000) / 100,
    category: cats[Math.floor(rnd() * 3)],
    clearance: rnd() < 0.3,
  }));
  const coupon = rnd() < 0.5 ? { type: rnd() < 0.5 ? "percent" : "fixed", value: Math.floor(rnd() * 60) } : undefined;
  return [{ items, coupon }, { member: rnd() < 0.5, vip: rnd() < 0.2 }] as const;
}

const s9 = (out: Awaited<ReturnType<typeof run>>) =>
  out.results.find((r) => r.gate === "complexity")!.triggers.filter((t) => t.id === "S9");

describe("moving baseline (spec 7.5)", () => {
  it("every slice preserves the original behaviour", async () => {
    const fns = await Promise.all([load(`${FIX}moving-baseline/original.js`), ...[1, 2, 3].map((n) => load(`${FIX}moving-baseline/step${n}.js`))]);
    for (let seed = 1; seed <= 2000; seed++) {
      const [order, user] = randomOrder(seed);
      const want = fns[0]!(order, user);
      for (const f of fns.slice(1)) expect(f(order, user)).toBe(want);
    }
  });

  it("chooses the older lookback candidate, never older than the file", async () => {
    // Linear history: a (oldest) < b < c < d.
    const order = ["a", "b", "c", "d"];
    const isAncestor = async (x: string, y: string) => order.indexOf(x) <= order.indexOf(y);
    expect(await chooseBaseline({ base: "d", nthTouch: "c", beforeCutoff: "b", creation: "a" }, isAncestor)).toBe("b");
    expect(await chooseBaseline({ base: "d", nthTouch: "b", beforeCutoff: "c", creation: "a" }, isAncestor)).toBe("b");
    expect(await chooseBaseline({ base: "d", nthTouch: "b", beforeCutoff: "a", creation: "c" }, isAncestor)).toBe("c");
    expect(await chooseBaseline({ base: "d", nthTouch: "d", beforeCutoff: null, creation: "d" }, isAncestor)).toBeNull();
  });

  it("a rewrite split over three PRs shows up against the moving baseline only", async () => {
    const repo = new TestRepo();
    const c0 = repo.commit({ "src/price.js": original });
    const heads = [c0];
    // G2's absolute S9 selectors also flag `&&=` with a side effect; lint is
    // observed here so the verdict shows what the G1 moving baseline adds.
    const observed = servicePolicy({ lint: { mode: "observe" }, triggers: { moving_baseline: { route: false } } });
    let last: Awaited<ReturnType<typeof run>> | undefined;
    for (const [i, step] of steps.entries()) {
      // Each PR is judged against the base-branch tip, then lands on it.
      const pr = repo.commit({ "src/price.js": step });
      last = await run(repo, heads[i]!, pr, observed);
      expect(s9(last).filter((t) => !t.evidence.startsWith("moving baseline")), `PR ${i + 1} own S9`).toEqual([]);
      heads.push(pr);
    }
    const moving = s9(last!).filter((t) => t.evidence.startsWith("moving baseline"));
    expect(moving).toHaveLength(1);
    expect(moving[0]).toMatchObject({ file: "src/price.js", routing: false });
    expect(moving[0]!.evidence).toContain(`moving baseline ${c0.slice(0, 12)}`);
    expect(last!.verdict.triggers.some((t) => t.evidence.startsWith("moving baseline"))).toBe(false);
    expect(last!.verdict.mergeAllowed).toBe(true); // P1: observe only

    const routed = servicePolicy({
      lint: { mode: "observe" },
      triggers: { moving_baseline: { route: true } },
      review: { simplification_reviewers: ["rita"] },
    });
    const identity = { prAuthor: "alice", commits: [], agentInvokers: [] };
    const required = await run(repo, heads[2]!, heads[3]!, routed, { pr: { comments: [], identity, headSha: heads[3]! } });
    expect(required.results.find((r) => r.gate === "simplification-review")!.violations.map((v) => v.reason)).toEqual(["REVIEW_REQUIRED"]);
    const review: ReviewComment = {
      id: 1,
      author: { login: "rita" },
      body: approvalBody(required.verdict.triggers.map((t) => t.id), heads[3]!),
      createdAt: "2026-10-28T12:00:00Z",
      headSha: heads[3]!,
    };
    const approved = await run(repo, heads[2]!, heads[3]!, routed, { pr: { comments: [review], identity, headSha: heads[3]! } });
    expect(approved.verdict.mergeAllowed).toBe(true);

    const off = await run(repo, heads[2]!, heads[3]!, servicePolicy({ lint: { mode: "observe" }, triggers: { moving_baseline: { enabled: false } } }));
    expect(s9(off)).toEqual([]);
    repo.dispose();
  });

  it("an added file has no history and costs nothing", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/price.js": steps[2]! });
    const out = await run(repo, b, c, servicePolicy());
    expect(out.results.find((r) => r.gate === "complexity")!.observe.moving_baseline).toBeUndefined();
    repo.dispose();
  });
});
