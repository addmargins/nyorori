// param-mutation (S10): a named helper that writes to its parameters'
// properties and is called directly in the same file — the `ctx`-mutating
// split of spec 7.2 (b). Ruling D17 narrows `no-param-reassign {props}` to
// direct calls so Immer recipes and Express/Koa middleware (passed as values)
// stay quiet.

import type { Rule } from "eslint";
import { isAnyFunction, isCalleeOf, isFunctionLike, outermostWrapper, unwrap, type AstNode } from "./ast.js";

/** The binding name of a function: declaration id or `const name = () => …`. */
function bindingOf(fn: AstNode): AstNode | null {
  if (fn.type === "FunctionDeclaration") return fn.id ?? null;
  const p = outermostWrapper(fn).parent;
  return p?.type === "VariableDeclarator" && p.id.type === "Identifier" ? p.id : null;
}

/** True when `id` is the root object of a member that is written to. */
function isPropertyWrite(id: AstNode): boolean {
  let n: AstNode = outermostWrapper(id);
  let sawMember = false;
  while (n.parent && n.parent.type === "MemberExpression" && n.parent.object === n) {
    n = outermostWrapper(n.parent);
    sawMember = true;
  }
  if (!sawMember) return false;
  const p = n.parent;
  if (!p) return false;
  if (p.type === "AssignmentExpression" && p.left === n) return true;
  if (p.type === "UpdateExpression") return true;
  if (p.type === "UnaryExpression" && p.operator === "delete") return true;
  return (p.type === "ForInStatement" || p.type === "ForOfStatement") && p.left === n;
}

export const paramMutation: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      mutatesParam: "Helper `{{name}}` mutates properties of its parameter `{{param}}` and is called directly: shared state threaded through split helpers.",
    },
  },
  create(context) {
    const sc = context.sourceCode;
    const check = (node: never) => {
      const fn = node as AstNode;
      if (!isAnyFunction(fn) || (!isFunctionLike(fn) && fn.type !== "FunctionDeclaration")) return;
      const binding = bindingOf(fn);
      if (!binding) return;
      const mutated = sc
        .getDeclaredVariables(node)
        .filter((v) => v.defs.some((d) => d.type === "Parameter"))
        .find((v) => v.references.some((r) => isPropertyWrite(r.identifier as unknown as AstNode)));
      if (!mutated) return;
      const self = sc.getDeclaredVariables((binding.parent?.type === "VariableDeclarator" ? binding.parent : fn) as never).find(
        (v) => v.name === binding.name,
      );
      const calledDirectly = self?.references.some((r) => {
        const id = r.identifier as unknown as AstNode;
        return id !== binding && isCalleeOf(outermostWrapper(id)) && unwrap(outermostWrapper(id).parent!.callee) === id;
      });
      if (!calledDirectly) return;
      context.report({ node, messageId: "mutatesParam", data: { name: binding.name, param: mutated.name } });
    };
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    } as unknown as Rule.RuleListener;
  },
};
