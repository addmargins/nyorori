import { matchesGlob } from "../util/glob.js";

export const matchGlob = matchesGlob;

/** Returns the first matching pattern, or null. */
export function matchAny(path: string, patterns: readonly string[]): string | null {
  for (const p of patterns) if (matchesGlob(path, p)) return p;
  return null;
}
