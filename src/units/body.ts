// Token-level text of a unit, used to prove that a stage-4 cross-file move
// is verbatim (audit F4): equal scores alone do not show that the logic is
// unchanged. cccc gives no end position, so the unit is cut at the brace
// that closes its first top-level block; an expression-bodied arrow keeps
// the whole approximate range (start line to the next unit).

import ts from "typescript";
import type { Unit } from "../types.js";

function sliceLines(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join("\n");
}

function tokens(text: string, cutAtFirstBlock: boolean): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const out: string[] = [];
  // Openers: "(" "[" "{" and "`" for template substitutions.
  const stack: string[] = [];
  let blockOpened = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && stack.at(-1) === "`") {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) stack.pop();
      out.push(scanner.getTokenText());
      continue;
    }
    out.push(scanner.getTokenText());
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
        if (cutAtFirstBlock && blockOpened && stack.length === 0 && kind === ts.SyntaxKind.CloseBraceToken) {
          return out;
        }
        break;
    }
  }
  return out;
}

/** Tokens without whitespace or comments, joined by single spaces. */
export function normalizedTokens(text: string): string {
  return tokens(text, false).join(" ");
}

export function unitBodyText(source: string, u: Unit): string {
  return tokens(sliceLines(source, u.line, u.endLine), true).join(" ");
}
