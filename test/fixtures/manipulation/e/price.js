// (e) Logic moved into class field initializers (module residue).
class Ctx {
  constructor(item, user) {
    this.item = item;
    this.user = user;
  }
}

class Line extends Ctx {
  isFood = this.item.category === "food";
  isBulk = !this.isFood && this.item.category === "electronics" && this.item.qty >= 3;
  rate = this.isFood
    ? this.user.member ? 0.95 : 1
    : this.isBulk ? 0.9 : this.item.clearance ? 0.7 : 1;
  value = this.item.qty <= 0 ? 0 : this.item.unitPrice * this.item.qty * this.rate;
}

class Totals {
  constructor(order, user, subtotal) {
    this.order = order;
    this.user = user;
    this.subtotal = subtotal;
  }
}

class Checkout extends Totals {
  coupon = this.order.coupon;
  afterCoupon = !this.coupon
    ? this.subtotal
    : this.coupon.type === "percent"
      ? this.subtotal * (1 - this.coupon.value / 100)
      : this.coupon.type === "fixed" && this.subtotal > this.coupon.value
        ? this.subtotal - this.coupon.value
        : this.subtotal;
  afterLoyalty = this.user.vip || this.afterCoupon > 500 ? this.afterCoupon * 0.97 : this.afterCoupon;
  shipping = this.afterLoyalty >= 100 ? 0 : this.user?.member ? 3 : 7;
  result = Math.round((this.afterLoyalty + this.shipping) * 100) / 100;
}

export function price(order, user) {
  let subtotal = 0;
  for (const item of order.items) subtotal += new Line(item, user).value;
  return new Checkout(order, user, subtotal).result;
}
