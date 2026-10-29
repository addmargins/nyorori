// (c) Arrow-function object maps + BOOL[String(cond)] dispatch.
const BOOL = { true: (t) => t(), false: (_t, f) => f() };
const pick = (cond, t, f) => BOOL[String(!!cond)](t, f);
const same = (x) => x;

const CATEGORY = {
  food: (item, user, line) => pick(user.member, () => line * 0.95, () => line),
  electronics: (item, user, line) =>
    pick(item.qty >= 3, () => line * 0.9, () => CATEGORY.other(item, user, line)),
  other: (item, _user, line) => pick(item.clearance, () => line * 0.7, () => line),
};
const categoryOf = (item) =>
  pick(Object.hasOwn(CATEGORY, item.category), () => CATEGORY[item.category], () => CATEGORY.other);

const COUPON = {
  percent: (total, c) => total * (1 - c.value / 100),
  fixed: (total, c) => pick(total > c.value, () => total - c.value, () => total),
};
const couponOf = (c) => pick(Object.hasOwn(COUPON, c.type), () => COUPON[c.type], () => same);

const lineOf = (item, user) =>
  pick(item.qty > 0, () => categoryOf(item)(item, user, item.unitPrice * item.qty), () => 0);

export function price(order, user) {
  let total = 0;
  for (const item of order.items) total += lineOf(item, user);
  total = pick(order.coupon, () => couponOf(order.coupon)(total, order.coupon), () => total);
  total = pick(user.vip || total > 500, () => total * 0.97, () => total);
  const shipping = pick(total >= 100, () => 0, () => pick(user?.member, () => 3, () => 7));
  return Math.round((total + shipping) * 100) / 100;
}
