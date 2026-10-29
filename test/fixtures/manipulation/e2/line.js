// (e′) The field-initializer class split into its own file.
class Ctx {
  constructor(item, user) {
    this.item = item;
    this.user = user;
  }
}

export class Line extends Ctx {
  isFood = this.item.category === "food";
  isBulk = !this.isFood && this.item.category === "electronics" && this.item.qty >= 3;
  rate = this.isFood
    ? this.user.member ? 0.95 : 1
    : this.isBulk ? 0.9 : this.item.clearance ? 0.7 : 1;
  value = this.item.qty <= 0 ? 0 : this.item.unitPrice * this.item.qty * this.rate;
}
