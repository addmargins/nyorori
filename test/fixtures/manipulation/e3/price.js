// (e″) Discount tables parsed at load time in `static {}` and top-level
// statements; the per-order function only looks values up.
const CONFIG = {
  categories: [
    { name: "food", memberRate: 0.95 },
    { name: "electronics", bulkQty: 3, bulkRate: 0.9 },
  ],
  clearanceRate: 0.7,
  loyalty: { threshold: 500, rate: 0.97 },
  shipping: { freeFrom: 100, member: 3, standard: 7 },
};

const RULES = new Map();
for (const c of CONFIG.categories) {
  if (c.memberRate !== undefined) RULES.set(c.name, { kind: "member", rate: c.memberRate });
  else if (c.bulkQty !== undefined && c.bulkRate !== undefined) {
    RULES.set(c.name, { kind: "bulk", qty: c.bulkQty, rate: c.bulkRate });
  }
}

class Tables {
  static loyalty;
  static shipping;
  static {
    const l = CONFIG.loyalty;
    if (l && l.threshold > 0 && l.rate > 0 && l.rate <= 1) this.loyalty = l;
    else this.loyalty = { threshold: Infinity, rate: 1 };
    const s = CONFIG.shipping;
    if (s && s.freeFrom >= 0) this.shipping = s;
    else this.shipping = { freeFrom: Infinity, member: 0, standard: 0 };
    for (const k of ["member", "standard"]) {
      if (typeof this.shipping[k] !== "number" || this.shipping[k] < 0) this.shipping[k] = 0;
    }
  }
}

function itemRate(item, user) {
  const rule = RULES.get(item.category);
  if (rule?.kind === "member") return user.member ? rule.rate : 1;
  if (rule?.kind === "bulk" && item.qty >= rule.qty) return rule.rate;
  return item.clearance ? CONFIG.clearanceRate : 1;
}

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    if (item.qty > 0) total += item.unitPrice * item.qty * itemRate(item, user);
  }
  const c = order.coupon;
  if (c?.type === "percent") total *= 1 - c.value / 100;
  else if (c?.type === "fixed" && total > c.value) total -= c.value;
  if (user.vip || total > Tables.loyalty.threshold) total *= Tables.loyalty.rate;
  const s = Tables.shipping;
  const shipping = total >= s.freeFrom ? 0 : user?.member ? s.member : s.standard;
  return Math.round((total + shipping) * 100) / 100;
}
