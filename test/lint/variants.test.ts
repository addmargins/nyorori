// Behaviour-preserving rewrites of one pricing function (spec 7.2). Honest
// refactors must stay clean; manipulations must produce a block or a trigger.

import { describe, expect, it } from "vitest";
import { lintSnippet } from "./helpers.js";

const HEADER = `interface Order { items: { price: number; qty: number }[]; coupon?: string; country: string }\ninterface User { vip: boolean; years: number }\n`;

const variants: Record<string, string> = {
  original: `${HEADER}export function price(order: Order, user: User): number {
  let total = 0;
  for (const it of order.items) {
    if (it.qty > 0) {
      if (it.qty >= 10) total += it.price * it.qty * 0.9;
      else total += it.price * it.qty;
    }
  }
  if (user.vip) {
    if (user.years > 5) total *= 0.8;
    else total *= 0.9;
  } else if (order.coupon === "SAVE10") {
    total -= 10;
  }
  if (order.country !== "KR" && total < 50) total += 5;
  return total < 0 ? 0 : total;
}
`,
  "a: guard clauses, named helpers, table": `${HEADER}const VIP_RATE = [0.9, 0.8] as const;
function lineTotal(it: { price: number; qty: number }): number {
  if (it.qty <= 0) return 0;
  const bulk = it.qty >= 10 ? 0.9 : 1;
  return it.price * it.qty * bulk;
}
function discount(total: number, order: Order, user: User): number {
  if (user.vip) return total * (user.years > 5 ? VIP_RATE[1] : VIP_RATE[0]);
  if (order.coupon === "SAVE10") return total - 10;
  return total;
}
function shipping(total: number, order: Order): number {
  return order.country !== "KR" && total < 50 ? 5 : 0;
}
export function price(order: Order, user: User): number {
  const subtotal = order.items.reduce((s, it) => s + lineTotal(it), 0);
  const discounted = discount(subtotal, order, user);
  return Math.max(0, discounted + shipping(discounted, order));
}
`,
  "j: strategy objects and reduce pipeline": `${HEADER}interface Rule { apply(total: number, order: Order, user: User): number }
class VipRule implements Rule {
  apply(total: number, _o: Order, user: User) {
    if (!user.vip) return total;
    return total * (user.years > 5 ? 0.8 : 0.9);
  }
}
class CouponRule implements Rule {
  apply(total: number, order: Order, user: User) {
    return !user.vip && order.coupon === "SAVE10" ? total - 10 : total;
  }
}
const RULES: Rule[] = [new VipRule(), new CouponRule()];
export function price(order: Order, user: User): number {
  const subtotal = order.items.reduce((s, it) => s + (it.qty > 0 ? it.price * it.qty * (it.qty >= 10 ? 0.9 : 1) : 0), 0);
  const total = RULES.reduce((t, r) => r.apply(t, order, user), subtotal);
  const ship = order.country !== "KR" && total < 50 ? 5 : 0;
  return Math.max(0, total + ship);
}
`,
  "b: ctx-mutating helpers": `${HEADER}interface Ctx { order: Order; user: User; total: number }
function addItems(ctx: Ctx) { for (const it of ctx.order.items) if (it.qty > 0) ctx.total += it.price * it.qty; }
function bulk(ctx: Ctx) { for (const it of ctx.order.items) if (it.qty >= 10) ctx.total -= it.price * it.qty * 0.1; }
function vip(ctx: Ctx) { if (ctx.user.vip) ctx.total *= ctx.user.years > 5 ? 0.8 : 0.9; }
function coupon(ctx: Ctx) { if (!ctx.user.vip && ctx.order.coupon === "SAVE10") ctx.total -= 10; }
function ship(ctx: Ctx) { if (ctx.order.country !== "KR" && ctx.total < 50) ctx.total += 5; }
function floor(ctx: Ctx) { if (ctx.total < 0) ctx.total = 0; }
export function price(order: Order, user: User): number {
  const ctx: Ctx = { order, user, total: 0 };
  addItems(ctx); bulk(ctx); vip(ctx); coupon(ctx); ship(ctx); floor(ctx);
  return ctx.total;
}
`,
  "d: tiny-array iteration": `${HEADER}export function price(order: Order, user: User): number {
  let total = 0;
  order.items.forEach((it) => [it.qty > 0].filter(Boolean).forEach(() => { total += it.price * it.qty * (it.qty >= 10 ? 0.9 : 1); }));
  [user.vip].filter(Boolean).forEach(() => { total *= user.years > 5 ? 0.8 : 0.9; });
  [!user.vip && order.coupon === "SAVE10"].filter(Boolean).forEach(() => { total -= 10; });
  return Math.max(0, total);
}
`,
  "f: logical assignment control flow": `${HEADER}export function price(order: Order, user: User): number {
  let total = 0;
  for (const it of order.items) {
    let go = it.qty > 0;
    go &&= ((total += it.price * it.qty), true);
  }
  let vip = user.vip;
  vip &&= ((total *= 0.9), true);
  let coupon = !user.vip && order.coupon === "SAVE10";
  coupon &&= ((total -= 10), true);
  return Math.max(0, total);
}
`,
  "f′: boolean arithmetic": `${HEADER}export function price(order: Order, user: User): number {
  let total = order.items.reduce((s, it) => s + it.price * it.qty * [1, 0.9][+(it.qty >= 10)], 0);
  total *= [1, [0.9, 0.8][+(user.years > 5)]][+user.vip]!;
  total -= 10 * +(!user.vip && order.coupon === "SAVE10");
  return Math.max(0, total);
}
`,
  "f″: generic combinators": `${HEADER}const when = <T,>(c: boolean, t: () => T, e: () => T): T => (c ? t() : e());
export function price(order: Order, user: User): number {
  const sub = order.items.reduce((s, it) => s + when(it.qty >= 10, () => it.price * it.qty * 0.9, () => it.price * it.qty), 0);
  const disc = when(user.vip, () => sub * 0.9, () => when(order.coupon === "SAVE10", () => sub - 10, () => sub));
  return Math.max(0, disc);
}
`,
  "i: Function constructor": `${HEADER}const body = "let t = 0; for (const it of order.items) if (it.qty > 0) t += it.price * it.qty; return user.vip ? t * 0.9 : t;";
export const price = new Function("order", "user", body) as (o: Order, u: User) => number;
`,
  "V17: Object.constructor.constructor": `${HEADER}const body = "return order.items.length";
export const price = Object.constructor.constructor("order", "user", body) as (o: Order, u: User) => number;
`,
};

type Outcome = "clean" | "block" | "S9" | "S10";

const expected: Record<string, Outcome[]> = {
  original: ["clean"],
  "a: guard clauses, named helpers, table": ["clean"],
  "j: strategy objects and reduce pipeline": ["clean"],
  "b: ctx-mutating helpers": ["S10"],
  "d: tiny-array iteration": ["S9"],
  "f: logical assignment control flow": ["S9"],
  "f′: boolean arithmetic": ["S9"],
  "f″: generic combinators": ["S9"],
  "i: Function constructor": ["block"],
  "V17: Object.constructor.constructor": ["block"],
};

describe("spec 7.2 rewrites", () => {
  it.each(Object.keys(variants))("%s", async (name) => {
    const r = await lintSnippet(variants[name]!);
    expect(r.parseError).toBeUndefined();
    const got = new Set<Outcome>();
    for (const m of r.messages) {
      if (m.category === "block") got.add("block");
      if (m.category === "trigger:S9") got.add("S9");
      if (m.category === "trigger:S10") got.add("S10");
    }
    if (got.size === 0) got.add("clean");
    for (const outcome of expected[name]!) expect([...got]).toContain(outcome);
    if (expected[name]!.includes("clean")) expect([...got]).toEqual(["clean"]);
  });
});
