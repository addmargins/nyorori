export function f(o: object) { let s = 0; for (const k in o) { s += k.length; } return s; }
