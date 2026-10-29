export function f(a: any, b: any) { a ??= b; a ||= b; a &&= b; return a; }
