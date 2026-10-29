// Moving-baseline slice: part of the original rewritten with `&&=` (spec 7.2 f).
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

// Untouched by the slices: keeps each slice under the per-PR S9 thresholds.
export function zone(code) {
  switch (code) {
    case "Z1":
      return 1;
    case "Z2":
      return 2;
    case "Z3":
      return 3;
    case "Z4":
      return 4;
    case "Z5":
      return 5;
    case "Z6":
      return 6;
    case "Z7":
      return 7;
    case "Z8":
      return 8;
    case "Z9":
      return 9;
    case "Z10":
      return 10;
    case "Z11":
      return 11;
    case "Z12":
      return 12;
    case "Z13":
      return 13;
    case "Z14":
      return 14;
    case "Z15":
      return 15;
    case "Z16":
      return 16;
    case "Z17":
      return 17;
    case "Z18":
      return 18;
    case "Z19":
      return 19;
    case "Z20":
      return 20;
    default:
      return 0;
  }
}
