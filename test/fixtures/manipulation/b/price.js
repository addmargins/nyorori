// (b) Mechanical split: eleven helpers mutating a shared ctx object.
function startLine(ctx) {
  ctx.line = ctx.item.unitPrice * ctx.item.qty;
}
function applyFood(ctx) {
  if (ctx.user.member) ctx.line *= 0.95;
}
function applyBulk(ctx) {
  ctx.line *= 0.9;
}
function applyClearance(ctx) {
  if (ctx.item.clearance) ctx.line *= 0.7;
}
function applyCategory(ctx) {
  if (ctx.item.category === "food") applyFood(ctx);
  else if (ctx.item.category === "electronics" && ctx.item.qty >= 3) applyBulk(ctx);
  else applyClearance(ctx);
}
function processItem(ctx) {
  if (ctx.item.qty <= 0) return;
  startLine(ctx);
  applyCategory(ctx);
  ctx.total += ctx.line;
}
function applyPercent(ctx) {
  ctx.total *= 1 - ctx.order.coupon.value / 100;
}
function applyFixed(ctx) {
  if (ctx.total > ctx.order.coupon.value) ctx.total -= ctx.order.coupon.value;
}
function applyCouponStep(ctx) {
  if (!ctx.order.coupon) return;
  if (ctx.order.coupon.type === "percent") applyPercent(ctx);
  else if (ctx.order.coupon.type === "fixed") applyFixed(ctx);
}
function applyLoyalty(ctx) {
  if (ctx.user.vip || ctx.total > 500) ctx.total *= 0.97;
}
function computeShipping(ctx) {
  ctx.shipping = ctx.total >= 100 ? 0 : ctx.user?.member ? 3 : 7;
}
export function price(order, user) {
  const ctx = { order, user, total: 0, item: null, line: 0, shipping: 0 };
  for (const item of order.items) {
    ctx.item = item;
    processItem(ctx);
  }
  applyCouponStep(ctx);
  applyLoyalty(ctx);
  computeShipping(ctx);
  return Math.round((ctx.total + ctx.shipping) * 100) / 100;
}
