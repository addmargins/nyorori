// Formatting-independent line counts for the line-based trigger conditions
// (S9; spec 7.5). Both sides are reformatted with one pinned Prettier
// configuration that lives here, never with the repository's own config, and
// only lines carrying code tokens are counted, so neither reflowing nor
// padding or stripping comments moves the number.

import { format } from "prettier";
import ts from "typescript";

/** Fixed formatting options. Changing them is a policy change. */
export const PRETTIER_OPTIONS = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  quoteProps: "as-needed",
  jsxSingleQuote: false,
  bracketSameLine: false,
  proseWrap: "preserve",
  embeddedLanguageFormatting: "off",
} as const;

function parserFor(path: string): { parser: string; jsx: boolean; fakeName: string } | null {
  const lower = path.toLowerCase();
  if (/\.(ts|mts|cts)$/.test(lower)) return { parser: "typescript", jsx: false, fakeName: "file.ts" };
  if (lower.endsWith(".tsx")) return { parser: "typescript", jsx: true, fakeName: "file.tsx" };
  if (/\.(js|mjs|cjs|jsx)$/.test(lower)) return { parser: "babel", jsx: true, fakeName: "file.jsx" };
  return null;
}

/** Lines of `source` that contain at least one non-comment token. */
export function codeLineCount(source: string, jsx: boolean): number {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia*/ true,
    jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lines = new Set<number>();
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenStart();
    const end = Math.max(start, scanner.getTokenEnd() - 1);
    for (let l = lineOf(start); l <= lineOf(end); l++) lines.add(l);
  }
  return lines.size;
}

/** `source` reformatted with the pinned options, or null when it cannot be formatted (e.g. syntax error). */
export async function normalizeSource(source: string, path: string): Promise<string | null> {
  const p = parserFor(path);
  if (!p) return null;
  try {
    return await format(source, { ...PRETTIER_OPTIONS, parser: p.parser, filepath: p.fakeName });
  } catch {
    return null;
  }
}

/** Code lines of an already normalized source (see normalizeSource). */
export function normalizedCodeLines(formatted: string, path: string): number {
  return codeLineCount(formatted, parserFor(path)?.jsx ?? true);
}

/** Normalized line count, or null when the source cannot be formatted (e.g. syntax error). */
export async function normalizedLineCount(source: string, path: string): Promise<number | null> {
  const formatted = await normalizeSource(source, path);
  return formatted === null ? null : normalizedCodeLines(formatted, path);
}

/** Normalized line counts for every path present on either side. */
export async function normalizedLineCounts(
  sourcesB: Map<string, string>,
  sourcesC: Map<string, string>,
  pairs: Array<{ b: string | null; c: string | null }>,
): Promise<Map<string, { B?: number; C?: number }>> {
  const out = new Map<string, { B?: number; C?: number }>();
  for (const { b, c } of pairs) {
    const key = c ?? b!;
    const rec: { B?: number; C?: number } = {};
    if (b !== null && sourcesB.has(b)) {
      const n = await normalizedLineCount(sourcesB.get(b)!, b);
      if (n !== null) rec.B = n;
    }
    if (c !== null && sourcesC.has(c)) {
      const n = await normalizedLineCount(sourcesC.get(c)!, c);
      if (n !== null) rec.C = n;
    }
    out.set(key, rec);
  }
  return out;
}
