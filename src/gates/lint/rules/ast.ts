// AST helpers shared by the gate's ESLint rules.

import type { Rule } from "eslint";

// The AST mixes ESTree and typescript-estree node types; the rules only read
// a handful of fields, so a structural type keeps them honest without
// depending on @typescript-eslint/types directly.
export interface AstNode {
  type: string;
  parent?: AstNode;
  // ESTree nodes are walked generically; a field can hold a node, a list or a literal.
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type Scope = Rule.RuleContext["sourceCode"]["scopeManager"]["globalScope"];
export type Variable = NonNullable<ReturnType<NonNullable<Scope>["set"]["get"]>>;
export type SourceCode = Rule.RuleContext["sourceCode"];

const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

export function unwrap(node: AstNode): AstNode {
  let n = node;
  while (WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

/** Walks up through wrappers so `(x as any)()` still counts as a call of x. */
export function outermostWrapper(node: AstNode): AstNode {
  let n = node;
  while (n.parent && WRAPPERS.has(n.parent.type)) n = n.parent;
  return n;
}

export function isFunctionLike(n: AstNode): boolean {
  return n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
}

export function isAnyFunction(n: AstNode): boolean {
  return isFunctionLike(n) || n.type === "FunctionDeclaration";
}

export function isCalleeOf(node: AstNode): boolean {
  const p = node.parent;
  return !!p && (p.type === "CallExpression" || p.type === "NewExpression") && unwrap(p.callee) === node;
}

export function literalString(n: AstNode | undefined | null): string | null {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}

/** Name of a member's property when it is syntactically static. */
export function staticPropertyName(member: AstNode): string | null {
  const p = member.property;
  if (!member.computed) return p.type === "Identifier" || p.type === "PrivateIdentifier" ? p.name : null;
  return literalString(p);
}

function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v.type === "string") out.push(v);
    } else if (typeof (value as AstNode).type === "string") {
      out.push(value as AstNode);
    }
  }
  return out;
}

/** Depth-first search. With `stopAtFunctions`, nested function bodies are not entered. */
export function contains(node: AstNode, pred: (n: AstNode) => boolean, stopAtFunctions = false): boolean {
  if (pred(node)) return true;
  for (const c of children(node)) {
    if (stopAtFunctions && isAnyFunction(c)) continue;
    if (contains(c, pred, stopAtFunctions)) return true;
  }
  return false;
}

export function findVariable(scope: Scope | null, name: string): Variable | null {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v) return v;
  }
  return null;
}

export function isShadowed(scope: Scope | null, name: string): boolean {
  const v = findVariable(scope, name);
  return !!v && v.defs.length > 0;
}

/**
 * The single initializer of a variable that is never reassigned, e.g. the
 * `"constructor"` of `const k = "constructor"`.
 */
export function constInit(v: Variable | null): AstNode | null {
  if (!v || v.defs.length !== 1) return null;
  const def = v.defs[0]!;
  if (def.type !== "Variable") return null;
  const decl = def.node as unknown as AstNode;
  if (!decl.init || decl.id.type !== "Identifier") return null;
  if (v.references.some((r) => r.isWrite() && (r.identifier as unknown as AstNode) !== decl.id)) return null;
  return decl.init as AstNode;
}

/**
 * Folds a string-valued expression: literals, `+` concatenation, template
 * literals and identifiers bound once to a foldable value. Returns null when
 * the value is not statically known.
 */
export function foldString(node: AstNode | null | undefined, sc: SourceCode, depth = 0): string | null {
  if (!node || depth > 8) return null;
  const n = unwrap(node);
  if (n.type === "Literal") return typeof n.value === "string" ? n.value : null;
  if (n.type === "TemplateLiteral") {
    let out = n.quasis[0].value.cooked ?? "";
    for (let i = 0; i < n.expressions.length; i++) {
      const part = foldString(n.expressions[i], sc, depth + 1);
      if (part === null) return null;
      out += part + (n.quasis[i + 1].value.cooked ?? "");
    }
    return out;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = foldString(n.left, sc, depth + 1);
    const r = l === null ? null : foldString(n.right, sc, depth + 1);
    return l === null || r === null ? null : l + r;
  }
  if (n.type === "Identifier") {
    const init = constInit(findVariable(sc.getScope(n as never) as Scope, n.name));
    return init ? foldString(init, sc, depth + 1) : null;
  }
  return null;
}

/** Property name of a member, folding computed keys. */
export function propertyName(member: AstNode, sc: SourceCode): string | null {
  return staticPropertyName(member) ?? (member.computed ? foldString(member.property, sc) : null);
}
