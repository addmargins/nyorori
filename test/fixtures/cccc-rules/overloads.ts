export function f(a: string): string;
export function f(a: number): number;
export function f(a: unknown) { return a; }
declare function g(): void;
export abstract class A { abstract m(): void; }
