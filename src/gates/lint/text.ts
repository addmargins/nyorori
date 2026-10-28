// Pure text scans that do not need an AST: bidi control characters
// (Trojan Source) and classification of suppression-directive comments.

/** U+202A–U+202E (embeddings/overrides) and U+2066–U+2069 (isolates). */
const BIDI_RE = /[‪-‮⁦-⁩]/g;

export interface BidiHit {
  line: number;
  column: number;
  codePoint: string;
}

export function scanBidi(source: string): BidiHit[] {
  const hits: BidiHit[] = [];
  // LF only, like git and cccc: U+2028/U+2029/CR are not line breaks here.
  const lines = source.split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(BIDI_RE)) {
      hits.push({
        line: i + 1,
        column: (m.index ?? 0) + 1,
        codePoint: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      });
    }
  });
  return hits;
}

export type DirectiveKind =
  | "eslint-disable"
  | "eslint-config"
  | "ts-ignore"
  | "ts-nocheck"
  | "ts-expect-error"
  | "coverage-ignore"
  | "stryker-disable";

export interface Directive {
  kind: DirectiveKind;
  /**
   * Stable text used to compare B and C and to match the allowlist, e.g.
   * "eslint-disable-next-line no-console,no-new-func" or "@ts-ignore".
   */
  normalized: string;
}

const ESLINT_DISABLE_RE = /^\s*(eslint-disable(?:-next-line|-line)?)(?:\s+([^\n]*?))?\s*(?:--.*)?$/s;
// `/* eslint rule: value */` inline config. `eslint-env` and `global(s)` are
// not suppressions; `eslint-enable` re-enables and is harmless.
const ESLINT_CONFIG_RE = /^\s*eslint\s+[@\w/-]+\s*:/;
const COVERAGE_RE = /^\s*(istanbul|c8|v8|node:coverage)\s+(ignore|disable)\b/;
const STRYKER_RE = /^\s*Stryker\s+disable\b/i;

function normalizeRuleList(list: string | undefined): string {
  if (!list) return "";
  return list
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * Classifies a comment body (without the comment delimiters).
 *
 * `@ts-expect-error` is treated as a suppression on purpose: it is the
 * TypeScript-recommended replacement for `@ts-ignore`, so leaving it out would
 * make banning `@ts-ignore` a no-op. Teams that want it can allowlist it.
 */
export function classifyDirectiveComment(body: string, type: "Line" | "Block"): Directive | null {
  const text = type === "Block" ? body.replace(/^\*+/, "").replace(/^\s*\*\s?/gm, "") : body;
  const trimmed = text.trim();

  const disable = ESLINT_DISABLE_RE.exec(trimmed);
  if (disable) {
    const rules = normalizeRuleList(disable[2]);
    return { kind: "eslint-disable", normalized: rules ? `${disable[1]} ${rules}` : disable[1]! };
  }
  if (ESLINT_CONFIG_RE.test(trimmed)) {
    return { kind: "eslint-config", normalized: `eslint ${trimmed.replace(/^eslint\s+/, "").replace(/\s+/g, " ")}` };
  }
  // TypeScript only honours these pragmas in comments that start with them.
  const ts = /^\/?\s*@ts-(ignore|nocheck|expect-error)\b/.exec(text.trimStart());
  if (ts) {
    const kind = `ts-${ts[1]}` as DirectiveKind;
    return { kind, normalized: `@ts-${ts[1]}` };
  }
  const cov = COVERAGE_RE.exec(trimmed);
  if (cov) {
    const rest = trimmed.slice(cov[0].length).trim().split(/\s+/)[0] ?? "";
    return { kind: "coverage-ignore", normalized: `${cov[1]} ${cov[2]}${rest ? ` ${rest}` : ""}` };
  }
  if (STRYKER_RE.test(trimmed)) {
    return { kind: "stryker-disable", normalized: trimmed.replace(/\s+/g, " ") };
  }
  return null;
}

/**
 * True when the directive is allowed by policy. An allowlist entry matches the
 * full normalized text ("eslint-disable-next-line no-console") or the bare
 * directive keyword ("@ts-expect-error").
 */
export function isAllowlisted(d: Directive, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  const keyword = d.normalized.split(" ")[0]!;
  return allowlist.some((a) => a.trim() === d.normalized || a.trim() === keyword);
}
