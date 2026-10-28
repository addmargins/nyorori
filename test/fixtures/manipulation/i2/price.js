// (i′) A rule list and a small interpreter.
const ITEM_RULES = [
  { test: (it, u) => it.category === "food", rate: (it, u) => (u.member ? 0.95 : 1) },
  { test: (it) => it.category === "electronics" && it.qty >= 3, rate: () => 0.9 },
  { test: () => true, rate: (it) => (it.clearance ? 0.7 : 1) },
];
const COUPON_RULES = [
  { test: (c) => c.type === "percent", apply: (t, c) => t * (1 - c.value / 100) },
  { test: (c, t) => c.type === "fixed" && t > c.value, apply: (t, c) => t - c.value },
];

function firstMatch(rules, ...args) {
  for (const r of rules) if (r.test(...args)) return r;
  return undefined;
}

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    total += item.unitPrice * item.qty * firstMatch(ITEM_RULES, item, user).rate(item, user);
  }
  const coupon = order.coupon;
  const rule = coupon ? firstMatch(COUPON_RULES, coupon, total) : undefined;
  if (rule) total = rule.apply(total, coupon);
  if (user.vip || total > 500) total *= 0.97;
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
