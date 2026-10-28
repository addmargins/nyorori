export function f(n: number): number { const g = f; return n <= 0 ? 0 : g(n - 1); }
