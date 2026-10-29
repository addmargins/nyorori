// (a′) The same helpers as nested closures.
export function price(order, user) {
  const itemRate = (item) => {
    if (item.category === "food") return user.member ? 0.95 : 1;
    if (item.category === "electronics" && item.qty >= 3) return 0.9;
    return item.clearance ? 0.7 : 1;
  };
  const applyCoupon = (total, coupon) => {
    if (!coupon) return total;
    if (coupon.type === "percent") return total * (1 - coupon.value / 100);
    if (coupon.type === "fixed" && total > coupon.value) return total - coupon.value;
    return total;
  };
  const shippingFor = (total) => (total >= 100 ? 0 : user?.member ? 3 : 7);

  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    total += item.unitPrice * item.qty * itemRate(item);
  }
  total = applyCoupon(total, order.coupon);
  if (user.vip || total > 500) total *= 0.97;
  return Math.round((total + shippingFor(total)) * 100) / 100;
}
