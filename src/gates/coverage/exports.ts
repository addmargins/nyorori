// Line spans of exported functions in a C source, used to find changed
// exported functions that no test executed (spec 8.4).

import ts from "typescript";

export interface ExportedFunction {
  name: string;
  /** Line of the declaration start (`export function`, `export const f =`). */
  startLine: number;
  /** Line where the body starts; coverage providers place `decl` between the two. */
  bodyLine: number;
  endLine: number;
}

function isFn(e: ts.Node | undefined): e is ts.ArrowFunction | ts.FunctionExpression {
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
}

function unwrap(e: ts.Expression | undefined): ts.Expression | undefined {
  let x = e;
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x))) x = x.expression;
  return x;
}

export function exportedFunctions(path: string, source: string): ExportedFunction[] {
  const kind = /\.tsx$|\.jsx$|\.js$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const hasExport = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const local = new Map<string, ExportedFunction>();
  const exported: ExportedFunction[] = [];
  const record = (name: string, node: ts.Node, body: ts.Node | undefined, isExported: boolean) => {
    const f = { name, startLine: line(node.getStart(sf)), bodyLine: line((body ?? node).getStart(sf)), endLine: line(node.getEnd()) };
    local.set(name, f);
    if (isExported) exported.push(f);
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      record(st.name?.text ?? "default", st, st.body, hasExport(st));
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = unwrap(d.initializer);
        if (ts.isIdentifier(d.name) && isFn(init)) record(d.name.text, d, init.body, hasExport(st));
      }
    } else if (ts.isExportAssignment(st)) {
      const e = unwrap(st.expression);
      if (isFn(e)) record("default", st, e.body, true);
      else if (e && ts.isIdentifier(e)) {
        const f = local.get(e.text);
        if (f) exported.push(f);
      }
    } else if (ts.isClassDeclaration(st) && hasExport(st)) {
      for (const m of st.members) {
        if (!(ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) || !m.body) continue;
        const isPrivate = (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword);
        if (isPrivate || (m.name && ts.isPrivateIdentifier(m.name))) continue;
        const name = ts.isConstructorDeclaration(m) ? "constructor" : m.name.getText(sf);
        record(`${st.name?.text ?? "default"}.${name}`, m, m.body, true);
      }
    }
  }
  // `export { a, b as c }` without a module specifier refers to locals.
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const f = local.get((el.propertyName ?? el.name).text);
        if (f && !exported.includes(f)) exported.push(f);
      }
    }
  }
  return exported;
}
