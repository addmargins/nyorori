export function f(a: boolean) { try { if (a) throw new Error("x"); } finally { void 0; } }
