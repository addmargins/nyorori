// Every variant must compute exactly the original's price (spec 7.2:
// 5,000 seeded random orders), so the manipulation table measures
// behavior-preserving rewrites only.

import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGINAL, VARIANTS, variantEntry } from "./variants.js";

type PriceFn = (order: unknown, user: unknown) => number;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomOrders(n: number, seed = 20261028): Array<[unknown, unknown]> {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: Array<[unknown, unknown]> = [];
  for (let i = 0; i < n; i++) {
    const items = Array.from({ length: Math.floor(rnd() * 7) }, () => ({
      qty: Math.floor(rnd() * 7) - 1,
      unitPrice: Math.round(rnd() * 25000) / 100,
      category: pick(["food", "electronics", "books", "toys"]),
      clearance: rnd() < 0.4,
    }));
    const coupon = pick([
      null,
      { type: "percent", value: Math.floor(rnd() * 50) + 1 },
      { type: "fixed", value: Math.floor(rnd() * 150) + 1 },
      { type: "bogus", value: 10 },
    ]);
    const user = { member: rnd() < 0.5, vip: rnd() < 0.2 };
    out.push([{ items, coupon }, user]);
  }
  return out;
}

const load = async (dir: string): Promise<PriceFn> =>
  ((await import(pathToFileURL(variantEntry(dir)).href)) as { price: PriceFn }).price;

describe("manipulation variants are behavior-preserving", () => {
  const orders = randomOrders(5000);
  let original: PriceFn;
  let expected: number[];
  beforeAll(async () => {
    original = await load(ORIGINAL);
    expected = orders.map(([o, u]) => original(o, u));
  });

  it("the generator exercises every branch of the original", () => {
    expect(new Set(expected.map((x) => Number.isFinite(x))).size).toBe(1);
    expect(expected.some((x) => x === 7)).toBe(true); // empty cart, standard shipping
  });

  for (const v of VARIANTS.filter((v) => v.equivalenceChecked)) {
    it(`${v.id} (${v.description})`, async () => {
      const fn = await load(v.dir);
      const mismatches = orders
        .map(([o, u], i) => ({ i, got: fn(o, u), want: expected[i] }))
        .filter((r) => !Object.is(r.got, r.want));
      expect(mismatches.slice(0, 3)).toEqual([]);
    });
  }
});
