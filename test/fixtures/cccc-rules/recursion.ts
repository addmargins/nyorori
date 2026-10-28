export function f(n: number): number { return n <= 0 ? 0 : f(n - 1) + f(n - 2); }
