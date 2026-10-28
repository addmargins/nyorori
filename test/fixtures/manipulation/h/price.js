// (h) Recursion through an alias so the recursion increment never applies.
function rateOf(item, user) {
  if (item.category === "food") return user.member ? 0.95 : 1;
  if (item.category === "electronics" && item.qty >= 3) return 0.9;
  return item.clearance ? 0.7 : 1;
}

function sumLines(items, i, user, acc) {
  if (i >= items.length) return acc;
  const item = items[i];
  const next = item.qty <= 0 ? acc : acc + item.unitPrice * item.qty * rateOf(item, user);
  return again(items, i + 1, user, next);
}
const again = sumLines;

function afterCoupon(total, coupon) {
  if (!coupon) return total;
  if (coupon.type === "percent") return total * (1 - coupon.value / 100);
  if (coupon.type === "fixed" && total > coupon.value) return total - coupon.value;
  return total;
}

export function price(order, user) {
  let total = afterCoupon(sumLines(order.items, 0, user, 0), order.coupon);
  if (user.vip || total > 500) total *= 0.97;
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
