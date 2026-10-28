// (d′) `cond && (() => { ... })()`.
export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    item.qty > 0 &&
      (() => {
        let line = item.unitPrice * item.qty;
        const isFood = item.category === "food";
        const isBulk = !isFood && item.category === "electronics" && item.qty >= 3;
        isFood && user.member && (() => { line *= 0.95; })();
        isBulk && (() => { line *= 0.9; })();
        !isFood && !isBulk && item.clearance && (() => { line *= 0.7; })();
        total += line;
      })();
  }
  const coupon = order.coupon;
  coupon &&
    (() => {
      coupon.type === "percent" && (() => { total *= 1 - coupon.value / 100; })();
      coupon.type === "fixed" && total > coupon.value && (() => { total -= coupon.value; })();
    })();
  (user.vip || total > 500) && (() => { total *= 0.97; })();
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
