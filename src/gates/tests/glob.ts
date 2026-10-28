// Policy glob matching shared by the test, coverage and mutation evaluators.
// Patterns without a slash match the basename anywhere in the tree (gitignore
// style), so `tsconfig*.json` also protects `packages/api/tsconfig.json`.

import { posix } from "node:path";

export function matchesPolicyGlob(path: string, pattern: string): boolean {
  const p = path.replace(/^\.\//, "");
  if (posix.matchesGlob(p, pattern)) return true;
  if (!pattern.includes("/")) return posix.matchesGlob(posix.basename(p), pattern);
  return false;
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((g) => matchesPolicyGlob(path, g));
}
