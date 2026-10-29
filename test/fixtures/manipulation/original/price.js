// Original: a pricing function a reviewer would ask to simplify.
export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    let line = item.unitPrice * item.qty;
    if (item.category === "food") {
      if (user.member) {
        line *= 0.95;
      }
    } else if (item.category === "electronics" && item.qty >= 3) {
      line *= 0.9;
    } else {
      if (item.clearance) line *= 0.7;
    }
    total += line;
  }
  if (order.coupon) {
    if (order.coupon.type === "percent") {
      total *= 1 - order.coupon.value / 100;
    } else if (order.coupon.type === "fixed" && total > order.coupon.value) {
      total -= order.coupon.value;
    }
  }
  if (user.vip || total > 500) total *= 0.97;
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
