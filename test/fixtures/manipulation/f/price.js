// (f) Every `if` rewritten as `x &&= cond; x &&= (side effect, true)`.
export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    let line = item.unitPrice * item.qty;
    const go = item.qty > 0;
    const foodCat = item.category === "food";
    let member = go;
    member &&= foodCat;
    member &&= !!user.member;
    member &&= ((line *= 0.95), true);
    let bulk = go;
    bulk &&= !foodCat;
    bulk &&= item.category === "electronics";
    bulk &&= item.qty >= 3;
    let other = go;
    other &&= !foodCat;
    other &&= !bulk;
    other &&= !!item.clearance;
    other &&= ((line *= 0.7), true);
    bulk &&= ((line *= 0.9), true);
    let add = go;
    add &&= ((total += line), true);
  }
  const coupon = order.coupon;
  let pct = !!coupon;
  pct &&= coupon.type === "percent";
  pct &&= ((total *= 1 - coupon.value / 100), true);
  let fixed = !!coupon;
  fixed &&= coupon.type === "fixed";
  fixed &&= total > coupon.value;
  fixed &&= ((total -= coupon.value), true);
  let loyal = !!user.vip;
  loyal ||= total > 500;
  loyal &&= ((total *= 0.97), true);
  let shipping = 7;
  let mem = !!user.member;
  mem &&= ((shipping = 3), true);
  let free = total >= 100;
  free &&= ((shipping = 0), true);
  return Math.round((total + shipping) * 100) / 100;
}
