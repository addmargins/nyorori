// (g) Exceptions used as goto.
const SKIP = Symbol("skip");
const DONE = Symbol("done");

function lineValue(item, user) {
  let line = item.unitPrice * item.qty;
  try {
    if (item.category === "food") {
      if (user.member) line *= 0.95;
      throw DONE;
    }
    if (item.category === "electronics" && item.qty >= 3) {
      line *= 0.9;
      throw DONE;
    }
    if (item.clearance) line *= 0.7;
  } catch (e) {
    if (e !== DONE) throw e;
  }
  return line;
}

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    try {
      if (item.qty <= 0) throw SKIP;
      total += lineValue(item, user);
    } catch (e) {
      if (e !== SKIP) throw e;
    }
  }
  try {
    if (!order.coupon) throw DONE;
    if (order.coupon.type === "percent") {
      total *= 1 - order.coupon.value / 100;
      throw DONE;
    }
    if (order.coupon.type === "fixed" && total > order.coupon.value) total -= order.coupon.value;
  } catch (e) {
    if (e !== DONE) throw e;
  }
  if (user.vip || total > 500) total *= 0.97;
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
