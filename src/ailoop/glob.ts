// Minimal, dependency-free glob matcher for policy path lists.
// Semantics follow .gitignore for the cases the policy uses: a pattern
// without "/" matches the basename at any depth, otherwise it is anchored at
// the repository root. Supports **, *, ?, and {a,b}.

const cache = new Map<string, RegExp>();

function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function compile(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.replace(/^\.\//, "");
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  let braceDepth = 0;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const atSegStart = i === 0 || p[i - 1] === "/";
        const atSegEnd = i + 2 === p.length || p[i + 2] === "/";
        if (atSegStart && atSegEnd) {
          if (p[i + 2] === "/") {
            re += "(?:[^/]+/)*";
            i += 2;
          } else {
            re += ".*";
            i += 1;
          }
          continue;
        }
        re += "[^/]*";
        i += 1;
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      braceDepth++;
      re += "(?:";
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
    } else if (ch === "," && braceDepth > 0) {
      re += "|";
    } else {
      re += escapeRe(ch);
    }
  }
  const full = anchored ? `^${re}$` : `^(?:.*/)?${re}$`;
  const compiled = new RegExp(full);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchGlob(path: string, pattern: string): boolean {
  return compile(pattern).test(path.replace(/^\.\//, ""));
}

export function matchAny(path: string, patterns: readonly string[]): string | null {
  for (const p of patterns) if (matchGlob(path, p)) return p;
  return null;
}
