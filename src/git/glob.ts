// Policy glob matcher. Kept in-house (instead of the experimental
// `path.matchesGlob`) so scope decisions cannot shift with a Node upgrade.
//
// Semantics:
//   `*` any run of characters except `/`, `?` one character except `/`,
//   `**` as a whole segment spans zero or more directories,
//   `{a,b}` alternation, `[abc]` / `[!abc]` classes.
//   Dot files are matched like any other name (scope rules must not miss them).
//   A pattern without `/` also matches the basename at any depth (gitignore style),
//   so `tsconfig*.json` protects nested packages too.

const cache = new Map<string, RegExp>();

function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function segmentToRe(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      re += negate ? `[^/${body}]` : `[${body}]`;
      i = close;
    } else if (ch === "{") {
      const close = findClosingBrace(pattern, i);
      if (close === -1) {
        re += "\\{";
        continue;
      }
      const alts = splitTopLevel(pattern.slice(i + 1, close));
      re += `(?:${alts.map(globBodyToRe).join("|")})`;
      i = close;
    } else {
      re += escapeRe(ch);
    }
  }
  return re;
}

function findClosingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function globBodyToRe(pattern: string): string {
  const segments = pattern.split("/");
  let re = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (seg === "**") {
      // `a/**/b` → a/ + zero or more dirs + b ; trailing `a/**` → anything below a/
      re += last ? "(?:.*)" : "(?:[^/]+/)*";
      continue;
    }
    re += segmentToRe(seg);
    if (!last) re += "/";
  }
  return re;
}

export function globToRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    const p = pattern.startsWith("./") ? pattern.slice(2) : pattern.startsWith("/") ? pattern.slice(1) : pattern;
    re = new RegExp(`^${globBodyToRe(p)}$`, "s");
    cache.set(pattern, re);
  }
  return re;
}

export function matchesGlob(path: string, pattern: string): boolean {
  if (globToRegExp(pattern).test(path)) return true;
  const anchored = pattern.startsWith("/") || pattern.replace(/\{[^}]*\}/g, "").includes("/");
  if (!anchored) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return globToRegExp(pattern).test(base);
  }
  return false;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}
