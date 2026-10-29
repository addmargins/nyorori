// (f″) Generic combinators `when` / `match` hide every branch.
const call = (f) => f();
const when = (c, then, otherwise = () => undefined) => call([otherwise, then][+!!c]);
const match = (v, cases) => when(Object.hasOwn(cases, v), () => cases[v](), () => cases._());

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    when(item.qty > 0, () => {
      const base = item.unitPrice * item.qty;
      const rate = match(item.category, {
        food: () => when(user.member, () => 0.95, () => 1),
        electronics: () =>
          when(item.qty >= 3, () => 0.9, () => when(item.clearance, () => 0.7, () => 1)),
        _: () => when(item.clearance, () => 0.7, () => 1),
      });
      total += base * rate;
    });
  }
  when(order.coupon, () =>
    match(order.coupon.type, {
      percent: () => { total *= 1 - order.coupon.value / 100; },
      fixed: () => when(total > order.coupon.value, () => { total -= order.coupon.value; }),
      _: () => undefined,
    }),
  );
  when(user.vip, () => { total *= 0.97; }, () => when(total > 500, () => { total *= 0.97; }));
  const shipping = when(total >= 100, () => 0, () => when(user?.member, () => 3, () => 7));
  return Math.round((total + shipping) * 100) / 100;
}
