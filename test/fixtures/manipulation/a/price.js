// (a) Honest refactor: guard clauses, named helpers, one shipping table.
const SHIPPING = { free: 0, member: 3, standard: 7 };

function itemRate(item, user) {
  if (item.category === "food") return user.member ? 0.95 : 1;
  if (item.category === "electronics" && item.qty >= 3) return 0.9;
  return item.clearance ? 0.7 : 1;
}

function applyCoupon(total, coupon) {
  if (!coupon) return total;
  if (coupon.type === "percent") return total * (1 - coupon.value / 100);
  if (coupon.type === "fixed" && total > coupon.value) return total - coupon.value;
  return total;
}

function shippingFor(total, user) {
  if (total >= 100) return SHIPPING.free;
  return user?.member ? SHIPPING.member : SHIPPING.standard;
}

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    total += item.unitPrice * item.qty * itemRate(item, user);
  }
  total = applyCoupon(total, order.coupon);
  if (user.vip || total > 500) total *= 0.97;
  return Math.round((total + shippingFor(total, user)) * 100) / 100;
}
