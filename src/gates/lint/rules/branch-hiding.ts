// branch-hiding (S9): syntax that moves decisions where cccc assigns no
// cost (spec 7.2 c/d/d′/f/f′/f″, rulings D8 and D17). Routing only: each
// shape has legitimate uses, so a human decides.

import type { Rule } from "eslint";
import {
  contains,
  findVariable,
  isAnyFunction,
  isCalleeOf,
  isFunctionLike,
  literalString,
  outermostWrapper,
  staticPropertyName,
  unwrap,
  type AstNode,
  type Scope,
  type SourceCode,
} from "./ast.js";

const COMPARISON_OPS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"]);
const ARITHMETIC_OPS = new Set(["*", "-", "/", "%", "**", "|", "&", "^", "<<", ">>", ">>>"]);
const ITERATION_METHODS = new Set(["forEach", "map", "filter", "some", "every", "reduce", "flatMap", "find", "findIndex"]);
/** Combinator names from fp libraries and the 7.2 (f″) experiment. */
const COMBINATOR_NAMES = new Set(["when", "unless", "ifElse", "cond", "match", "caseOf", "switchCase", "branch", "choose"]);

function isBooleanish(node: AstNode): boolean {
  const n = unwrap(node);
  if (n.type === "BinaryExpression") return COMPARISON_OPS.has(n.operator);
  // `a ?? 0` and `x || 0` are numbers; only a combination of booleans is boolean.
  if (n.type === "LogicalExpression") return n.operator !== "??" && isBooleanish(n.left) && isBooleanish(n.right);
  if (n.type === "UnaryExpression") return n.operator === "!";
  if (n.type === "Literal") return typeof n.value === "boolean";
  if (n.type === "CallExpression") {
    const c = unwrap(n.callee);
    return c.type === "Identifier" && c.name === "Boolean";
  }
  return false;
}

function isCallTo(n: AstNode, name: string): boolean {
  if (n.type !== "CallExpression") return false;
  const c = unwrap(n.callee);
  return c.type === "Identifier" && c.name === name && n.arguments.length === 1;
}

/** `+b`, `Number(b)`, `String(b)`, `` `${b}` ``, `b ? 1 : 0` for a boolean-ish b. */
function isBooleanCoercion(node: AstNode): boolean {
  const n = unwrap(node);
  if (n.type === "UnaryExpression" && (n.operator === "+" || n.operator === "-" || n.operator === "~")) {
    return isBooleanish(n.argument);
  }
  if (isCallTo(n, "Number") || isCallTo(n, "String")) return isBooleanish(n.arguments[0]);
  if (n.type === "TemplateLiteral" && n.expressions.length === 1) {
    return n.quasis.every((q: AstNode) => q.value.cooked === "") && isBooleanish(n.expressions[0]);
  }
  if (n.type === "ConditionalExpression") {
    return n.consequent.type === "Literal" && n.alternate.type === "Literal" && typeof n.consequent.value === "number";
  }
  return false;
}

const SIDE_EFFECT_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "SequenceExpression",
  "AwaitExpression",
  "YieldExpression",
]);

function hasWrite(n: AstNode): boolean {
  return contains(n, (x) => SIDE_EFFECT_TYPES.has(x.type) || (x.type === "UnaryExpression" && x.operator === "delete"));
}

/** An assignment or update outside nested functions. */
function hasAssignment(n: AstNode): boolean {
  return contains(n, (x) => x.type === "AssignmentExpression" || x.type === "UpdateExpression", true);
}

/** `await f(x)` with nothing else going on: the async memo `c ??= await create()`. */
function isSingleAwaitedCall(n: AstNode): boolean {
  const a = unwrap(n);
  if (a.type !== "AwaitExpression") return false;
  const call = unwrap(a.argument);
  return call.type === "CallExpression" && !hasWrite(call);
}

/** A local initialised from a boolean-ish expression: `let done = false`. */
function isBooleanLocal(id: AstNode, sc: SourceCode): boolean {
  if (id.type !== "Identifier") return false;
  const v = findVariable(sc.getScope(id as never) as Scope, id.name);
  const def = v?.defs[0];
  if (!v || v.defs.length !== 1 || def?.type !== "Variable") return false;
  const init = (def.node as unknown as AstNode).init as AstNode | null;
  return !!init && isBooleanish(init);
}

const TEST_PARENTS: Record<string, string> = {
  IfStatement: "test",
  WhileStatement: "test",
  DoWhileStatement: "test",
  ForStatement: "test",
  ConditionalExpression: "test",
};

/** Statement or test position: shortCircuitStatement covers the former, loops/ifs the latter. */
function inStatementOrTestPosition(n: AstNode): boolean {
  const outer = outermostWrapper(n);
  const p = outer.parent;
  if (!p) return false;
  if (p.type === "ExpressionStatement") return true;
  if (p.type === "UnaryExpression" && p.operator === "void" && p.parent?.type === "ExpressionStatement") return true;
  const key = TEST_PARENTS[p.type];
  return key !== undefined && p[key] === outer;
}

/** `x || (x = …)` / `x ?? (x = …)`: lazy initialisation. */
function isLazyInit(n: AstNode, sc: SourceCode): boolean {
  if (n.type !== "LogicalExpression" || (n.operator !== "||" && n.operator !== "??")) return false;
  const r = unwrap(n.right);
  return r.type === "AssignmentExpression" && r.operator === "=" && sc.getText(r.left as never) === sc.getText(n.left as never);
}

/** Operands that run conditionally; the test of `?:` runs always. */
function conditionalOperands(n: AstNode): AstNode[] {
  return n.type === "ConditionalExpression" ? [n.consequent, n.alternate] : [n.left, n.right];
}

function isLogicalOrConditional(n: AstNode | undefined): boolean {
  return !!n && (n.type === "LogicalExpression" || n.type === "ConditionalExpression");
}

/** The function a name is bound to: `function f(){}` or `const f = () => {}`. */
function functionBoundTo(v: ReturnType<typeof findVariable>): AstNode | null {
  const def = v?.defs[0];
  if (!v || v.defs.length !== 1 || !def) return null;
  const node = def.node as unknown as AstNode;
  if (def.type === "FunctionName" && isAnyFunction(node)) return node;
  if (def.type === "Variable" && node.init && isFunctionLike(unwrap(node.init))) return unwrap(node.init);
  return null;
}

function hasCall(n: AstNode): boolean {
  return contains(n, (x) => x.type === "CallExpression" || x.type === "NewExpression");
}

function functionValuedProperties(obj: AstNode): number {
  return obj.properties.filter(
    (p: AstNode) => p.type === "Property" && !p.method && p.kind === "init" && isFunctionLike(p.value),
  ).length;
}

function propertyKeyName(p: AstNode): string | null {
  if (p.type !== "Property") return null;
  if (!p.computed && p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal") return String(p.key.value);
  return null;
}

function paramNames(fn: AstNode): Set<string> {
  const out = new Set<string>();
  for (const p of fn.params) {
    const id = p.type === "AssignmentPattern" ? p.left : p;
    if (id.type === "Identifier") out.add(id.name);
  }
  return out;
}

/** `t()` or `cases[k]()` where t / cases is one of the function's parameters. */
function callsParam(node: AstNode | null | undefined, params: Set<string>): boolean {
  if (!node) return false;
  return contains(node, (x) => {
    if (x.type !== "CallExpression") return false;
    const c = unwrap(x.callee);
    if (c.type === "Identifier") return params.has(c.name);
    return c.type === "MemberExpression" && c.computed && c.object.type === "Identifier" && params.has(c.object.name);
  });
}

/** A function whose whole job is to pick and invoke one of its own parameters. */
function isCombinatorDefinition(fn: AstNode): boolean {
  if (fn.params.length < 2) return false;
  const params = paramNames(fn);
  let body: AstNode = fn.body;
  if (body.type === "BlockStatement") {
    const stmts = body.body.filter((s: AstNode) => s.type !== "EmptyStatement");
    if (stmts.length === 0 || stmts.length > 2) return false;
    const first = stmts[0];
    if (first.type === "IfStatement") return callsParam(first.consequent, params) || callsParam(first.alternate, params);
    if (first.type !== "ReturnStatement" || !first.argument) return false;
    body = first.argument;
  }
  const b = unwrap(body);
  if (b.type === "ConditionalExpression") return callsParam(b.consequent, params) || callsParam(b.alternate, params);
  if (b.type === "LogicalExpression") return callsParam(b.right, params);
  if (b.type === "CallExpression") {
    const c = unwrap(b.callee);
    return c.type === "MemberExpression" && c.computed && c.object.type === "Identifier" && params.has(c.object.name);
  }
  return false;
}

function calleeName(call: AstNode): string | null {
  const c = unwrap(call.callee);
  return c.type === "Identifier" ? c.name : null;
}

export const branchHiding: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      logicalAssignment: "Logical assignment `{{op}}` with a side effect hides a branch from the complexity measurement.",
      logicalAssignmentFlag: "`{{op}}` on a boolean flag with a call runs the call conditionally: a hidden `if`.",
      switchTrue: "`switch (true)` is an if/else chain the measurement scores as one switch.",
      assignmentInOperand: "An assignment inside a short-circuit or conditional operand is a hidden branch.",
      aliasRecursion: "Recursion through the alias `{{alias}}` of `{{fn}}` is not counted by the measurement.",
      shortCircuitStatement: "A short-circuit or conditional expression used as a statement is an `if` the measurement scores flat.",
      iife: "An immediately-invoked function moves logic out of the enclosing unit.",
      booleanIndex: "Indexing by a coerced boolean is a branch the measurement cannot see.",
      literalArrayIndex: "Indexing a literal array by a computed value selects a branch the measurement cannot see.",
      booleanArithmetic: "Arithmetic on a boolean is a branch the measurement cannot see.",
      dispatchTable: "An object of functions used as a dispatch table moves branches into separately scored closures.",
      combinatorDefinition: "A combinator that picks which parameter to call hides the caller's branches.",
      combinatorCall: "Passing several inline functions to a combinator hides branches in separately scored closures.",
      tinyArrayIteration: "Iterating a literal array of {{count}} element(s) is an `if` the measurement scores as a callback.",
    },
  },
  create(context) {
    const sc = context.sourceCode;
    const localCombinators = new Set<string>();
    const dispatchCandidates: AstNode[] = [];

    const checkFunction = (fn: AstNode) => {
      if (!isCombinatorDefinition(fn)) return;
      context.report({ node: fn as never, messageId: "combinatorDefinition" });
      if (fn.type === "FunctionDeclaration" && fn.id) localCombinators.add(fn.id.name);
      const p = fn.parent;
      if (p?.type === "VariableDeclarator" && p.id.type === "Identifier") localCombinators.add(p.id.name);
    };

    const isDispatchedVariable = (obj: AstNode): boolean => {
      const decl = obj.parent;
      if (decl?.type !== "VariableDeclarator" || decl.init !== obj) return false;
      for (const v of sc.getDeclaredVariables(decl as never)) {
        for (const ref of v.references) {
          const id = ref.identifier as unknown as AstNode;
          const member = id.parent;
          if (member?.type !== "MemberExpression" || member.object !== id || !member.computed) continue;
          if (literalString(member.property) !== null || member.property.type === "Literal") continue;
          if (isCalleeOf(outermostWrapper(member))) return true;
        }
      }
      return false;
    };

    return {
      AssignmentExpression(node: never) {
        const n = node as AstNode;
        if (!["&&=", "||=", "??="].includes(n.operator)) return;
        // `cache ||= compute()` / `x ??= load()` / `this.c ??= await create()`
        // are the memo idiom; a nested write, or a call under `&&=`, turns
        // the assignment into a hidden `if` (ruling D8).
        const memoOp = n.operator !== "&&=";
        const write = hasWrite(n.right) && !(memoOp && isSingleAwaitedCall(n.right));
        if (write || (!memoOp && hasCall(n.right))) {
          context.report({ node, messageId: "logicalAssignment", data: { op: n.operator } });
        } else if (memoOp && hasCall(n.right) && isBooleanLocal(unwrap(n.left), sc)) {
          context.report({ node, messageId: "logicalAssignmentFlag", data: { op: n.operator } });
        }
      },
      SwitchStatement(node: never) {
        const d = unwrap((node as AstNode).discriminant);
        if (d.type === "Literal" && d.value === true) context.report({ node, messageId: "switchTrue" });
      },
      "LogicalExpression, ConditionalExpression"(node: never) {
        const n = node as AstNode;
        // Report the outermost expression only, once.
        if (isLogicalOrConditional(outermostWrapper(n).parent)) return;
        if (inStatementOrTestPosition(n)) return;
        const hidden = (e: AstNode): boolean => {
          const x = unwrap(e);
          if (isLazyInit(x, sc)) return false;
          if (isLogicalOrConditional(x)) return conditionalOperands(x).some(hidden);
          return hasAssignment(x);
        };
        if (isLazyInit(n, sc)) return;
        if (conditionalOperands(n).some(hidden)) context.report({ node, messageId: "assignmentInOperand" });
      },
      VariableDeclarator(node: never) {
        const n = node as AstNode;
        if (n.id.type !== "Identifier" || !n.init) return;
        let init = unwrap(n.init);
        // `const g = f.bind(null)` aliases too.
        if (init.type === "CallExpression" && unwrap(init.callee).type === "MemberExpression" && staticPropertyName(unwrap(init.callee)) === "bind") {
          init = unwrap(unwrap(init.callee).object);
        }
        if (init.type !== "Identifier") return;
        const target = functionBoundTo(findVariable(sc.getScope(init as never) as Scope, init.name));
        if (!target) return;
        for (const alias of sc.getDeclaredVariables(n as never)) {
          for (const ref of alias.references) {
            const id = ref.identifier as unknown as AstNode;
            if (!isCalleeOf(outermostWrapper(id))) continue;
            let inside = false;
            for (let a: AstNode | undefined = id.parent; a; a = a.parent) if (a === target) inside = true;
            if (inside) {
              context.report({ node: id as never, messageId: "aliasRecursion", data: { alias: alias.name, fn: init.name } });
            }
          }
        }
      },
      ExpressionStatement(node: never) {
        const e = unwrap((node as AstNode).expression);
        if (e.type === "LogicalExpression" || e.type === "ConditionalExpression") {
          context.report({ node, messageId: "shortCircuitStatement" });
        }
      },
      CallExpression(node: never) {
        const n = node as AstNode;
        const callee = unwrap(n.callee);
        if (isFunctionLike(callee)) {
          // `(async () => { ... })()` as a statement (optionally `void`ed) is
          // the fire-and-forget idiom of scripts and React effects, and a
          // top-level IIFE is a module entry point; neither hides a branch.
          let stmt = outermostWrapper(n).parent;
          if (stmt?.type === "UnaryExpression" && stmt.operator === "void") stmt = stmt.parent;
          const asStatement = stmt?.type === "ExpressionStatement";
          const topLevel = asStatement && stmt!.parent?.type === "Program";
          if (!topLevel && !(asStatement && callee.async)) context.report({ node, messageId: "iife" });
          return;
        }
        if (callee.type === "MemberExpression" && !callee.computed) {
          const obj = unwrap(callee.object);
          const method = staticPropertyName(callee);
          if (
            obj.type === "ArrayExpression" &&
            obj.elements.length <= 1 &&
            !obj.elements.some((e: AstNode | null) => e?.type === "SpreadElement") &&
            method !== null &&
            ITERATION_METHODS.has(method)
          ) {
            context.report({ node, messageId: "tinyArrayIteration", data: { count: String(obj.elements.length) } });
          }
          return;
        }
        const name = calleeName(n);
        if (name === null) return;
        const inlineFns = n.arguments.filter((a: AstNode) => isFunctionLike(a)).length;
        if (inlineFns >= 2) context.report({ node, messageId: "combinatorCall" });
      },
      MemberExpression(node: never) {
        const n = node as AstNode;
        if (!n.computed) return;
        if (isBooleanCoercion(n.property)) {
          context.report({ node, messageId: "booleanIndex" });
        } else if (unwrap(n.object).type === "ArrayExpression" && unwrap(n.property).type !== "Literal") {
          context.report({ node, messageId: "literalArrayIndex" });
        }
      },
      UnaryExpression(node: never) {
        const n = node as AstNode;
        if (!["+", "-", "~"].includes(n.operator) || !isBooleanish(n.argument)) return;
        const p = outermostWrapper(n).parent;
        if (p?.type === "MemberExpression" && p.computed && unwrap(p.property) === n) return; // reported as booleanIndex
        context.report({ node, messageId: "booleanArithmetic" });
      },
      BinaryExpression(node: never) {
        const n = node as AstNode;
        if (ARITHMETIC_OPS.has(n.operator) && (isBooleanish(n.left) || isBooleanish(n.right))) {
          context.report({ node, messageId: "booleanArithmetic" });
        }
      },
      ObjectExpression(node: never) {
        const n = node as AstNode;
        if (functionValuedProperties(n) < 2) return;
        dispatchCandidates.push(n);
      },
      FunctionDeclaration: (node: never) => checkFunction(node as AstNode),
      FunctionExpression: (node: never) => checkFunction(node as AstNode),
      ArrowFunctionExpression: (node: never) => checkFunction(node as AstNode),
      "Program:exit"() {
        for (const obj of dispatchCandidates) {
          const keys = new Set(obj.properties.map(propertyKeyName));
          const parent = outermostWrapper(obj).parent;
          const indexedInline = parent?.type === "MemberExpression" && parent.computed && unwrap(parent.object) === obj;
          const booleanKeys = keys.has("true") && keys.has("false");
          const combinatorArg =
            parent?.type === "CallExpression" &&
            parent.callee !== obj &&
            (() => {
              const name = calleeName(parent);
              return name !== null && (localCombinators.has(name) || COMBINATOR_NAMES.has(name));
            })();
          if (indexedInline || booleanKeys || combinatorArg || isDispatchedVariable(obj)) {
            context.report({ node: obj as never, messageId: "dispatchTable" });
          }
        }
      },
    } as unknown as Rule.RuleListener;
  },
};
