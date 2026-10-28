// (f′) Boolean arithmetic and `[x, y][+cond]` indexing.
const NONE = { type: "none", value: 0 };

export function price(order, user) {
  let total = 0;
  for (const item of order.items) {
    const line = item.unitPrice * item.qty;
    const isFood = +(item.category === "food");
    const bulk = +(item.category === "electronics") * +(item.qty >= 3);
    const foodRate = [1, 0.95][+!!user.member];
    const otherRate = [[1, 0.7][+!!item.clearance], 0.9][bulk];
    const rate = [otherRate, foodRate][isFood];
    total = [total, total + line * rate][+(item.qty > 0)];
  }
  const c = [order.coupon, NONE][+!order.coupon];
  total = [total, total * (1 - c.value / 100)][+(c.type === "percent")];
  total = [total, total - c.value][+(c.type === "fixed") * +(total > c.value)];
  total = [total, total * 0.97][Math.max(+!!user.vip, +(total > 500))];
  const shipping = [[7, 3][+!!user?.member], 0][+(total >= 100)];
  return Math.round((total + shipping) * 100) / 100;
}
