// (d) `[cond].filter(Boolean).forEach(...)`: branches moved into callbacks.
export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    [item.qty > 0].filter(Boolean).forEach(() => {
      let line = item.unitPrice * item.qty;
      const isFood = item.category === "food";
      const isBulk = !isFood && item.category === "electronics" && item.qty >= 3;
      [isFood && user.member].filter(Boolean).forEach(() => {
        line *= 0.95;
      });
      [isBulk].filter(Boolean).forEach(() => {
        line *= 0.9;
      });
      [!isFood && !isBulk && item.clearance].filter(Boolean).forEach(() => {
        line *= 0.7;
      });
      total += line;
    });
  }
  const coupon = order.coupon;
  [coupon && coupon.type === "percent"].filter(Boolean).forEach(() => {
    total *= 1 - coupon.value / 100;
  });
  [coupon && coupon.type === "fixed" && total > coupon.value].filter(Boolean).forEach(() => {
    total -= coupon.value;
  });
  [user.vip || total > 500].filter(Boolean).forEach(() => {
    total *= 0.97;
  });
  let shipping = 7;
  [user?.member].filter(Boolean).forEach(() => {
    shipping = 3;
  });
  [total >= 100].filter(Boolean).forEach(() => {
    shipping = 0;
  });
  return Math.round((total + shipping) * 100) / 100;
}
