export function f(xs: number[]) { if (xs.length) { return xs.map((x) => { if (x) { return 1; } return 0; }); } return []; }
