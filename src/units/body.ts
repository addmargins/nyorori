// Token-level view of a unit's source. Two uses: proving that a stage-4
// cross-file move is verbatim (audit F4: equal scores alone do not show
// that the logic is unchanged), and finding where a unit really ends. cccc
// gives no end position, so the unit is cut at the brace that closes its
// first top-level block; an expression-bodied arrow keeps the whole
// approximate range (start line to the next unit).

import ts from "typescript";
import type { Unit } from "../types.js";

export interface UnitScan {
  /** Tokens without whitespace or comments. */
  tokens: string[];
  /** 1-based line of the closing brace of the first block, when one closes inside the range. */
  closingLine: number | undefined;
}

function sliceLines(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join("\n");
}

function scan(text: string, firstLine: number): UnitScan {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const tokens: string[] = [];
  // Openers: "(" "[" "{" and "`" for template substitutions.
  const stack: string[] = [];
  let blockOpened = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && stack.at(-1) === "`") {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) stack.pop();
      tokens.push(scanner.getTokenText());
      continue;
    }
    tokens.push(scanner.getTokenText());
    switch (kind) {
      case ts.SyntaxKind.TemplateHead:
        stack.push("`");
        break;
      case ts.SyntaxKind.OpenParenToken:
      case ts.SyntaxKind.OpenBracketToken:
        stack.push("(");
        break;
      case ts.SyntaxKind.OpenBraceToken:
        if (stack.length === 0) blockOpened = true;
        stack.push("{");
        break;
      case ts.SyntaxKind.CloseParenToken:
      case ts.SyntaxKind.CloseBracketToken:
      case ts.SyntaxKind.CloseBraceToken:
        stack.pop();
        if (blockOpened && stack.length === 0 && kind === ts.SyntaxKind.CloseBraceToken) {
          const upto = text.slice(0, scanner.getTokenStart());
          return { tokens, closingLine: firstLine + (upto.match(/\n/g)?.length ?? 0) };
        }
        break;
    }
  }
  return { tokens, closingLine: undefined };
}

export function scanUnit(source: string, u: Unit): UnitScan {
  return scan(sliceLines(source, u.line, u.endLine), u.line);
}

/** The unit's tokens without whitespace or comments, joined by single spaces. */
export function unitBodyText(source: string, u: Unit): string {
  return scanUnit(source, u).tokens.join(" ");
}

/** Last line of the unit: its closing brace when found, else the approximate range end. */
export function unitLastLine(source: string, u: Unit): number {
  return scanUnit(source, u).closingLine ?? u.endLine;
}
