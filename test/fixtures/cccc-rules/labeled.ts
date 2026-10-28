export function f(xs: number[][]) { outer: for (const r of xs) { for (const x of r) { if (x) continue outer; break outer; } } }
