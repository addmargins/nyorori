// (j) Strategy classes and a reduce pipeline.
class FoodPolicy {
  rate(item, user) {
    return user.member ? 0.95 : 1;
  }
}
class ElectronicsPolicy {
  rate(item) {
    if (item.qty >= 3) return 0.9;
    return item.clearance ? 0.7 : 1;
  }
}
class DefaultPolicy {
  rate(item) {
    return item.clearance ? 0.7 : 1;
  }
}
const POLICIES = { food: new FoodPolicy(), electronics: new ElectronicsPolicy() };
const DEFAULT = new DefaultPolicy();

function couponed(total, coupon) {
  if (!coupon) return total;
  if (coupon.type === "percent") return total * (1 - coupon.value / 100);
  if (coupon.type === "fixed" && total > coupon.value) return total - coupon.value;
  return total;
}

export function price(order, user) {
  const subtotal = order.items
    .filter((item) => item.qty > 0)
    .reduce((sum, item) => {
      const policy = Object.hasOwn(POLICIES, item.category) ? POLICIES[item.category] : DEFAULT;
      return sum + item.unitPrice * item.qty * policy.rate(item, user);
    }, 0);
  let total = couponed(subtotal, order.coupon);
  if (user.vip || total > 500) total *= 0.97;
  const shipping = total >= 100 ? 0 : user?.member ? 3 : 7;
  return Math.round((total + shipping) * 100) / 100;
}
