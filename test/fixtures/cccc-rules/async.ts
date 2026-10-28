export async function f(p: Promise<number>) { const x = await p; return x; }
export function* g() { yield 1; yield* [2]; }
