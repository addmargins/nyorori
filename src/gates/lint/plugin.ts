// The gate's own ESLint rules. They encode the bypass shapes measured in
// spec 7.2 / 10.2 that no core rule catches:
// - dynamic-code: building functions from strings (V17), which makes units
//   vanish from the cccc report
// - branch-hiding: syntax that moves decisions where cccc assigns no cost (S9)
// - suppression-directive: every suppression comment, so B→C surplus can be found

import type { ESLint, Rule } from "eslint";
import { classifyDirectiveComment } from "./text.js";

// The AST mixes ESTree and typescript-estree node types; the rules only read
// a handful of fields, so a structural type keeps them honest without
// depending on @typescript-eslint/types directly.
interface AstNode {
  type: string;
  parent?: AstNode;
  [key: string]: any;
}

const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

function unwrap(node: AstNode): AstNode {
  let n = node;
  while (WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

/** Name of a member's property when it is statically known. */
export function staticPropertyName(member: AstNode): string | null {
  const p = member.property;
  if (!member.computed) return p.type === "Identifier" || p.type === "PrivateIdentifier" ? p.name : null;
  if (p.type === "Literal" && typeof p.value === "string") return p.value;
  if (p.type === "TemplateLiteral" && p.expressions.length === 0) return p.quasis[0].value.cooked;
  return null;
}

function isFunctionLike(n: AstNode): boolean {
  return n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
}

function isCalleeOf(node: AstNode): boolean {
  const p = node.parent;
  return !!p && (p.type === "CallExpression" || p.type === "NewExpression") && unwrap(p.callee) === node;
}

/** Walks up through wrappers so `(x as any)()` still counts as a call of x. */
function outermostWrapper(node: AstNode): AstNode {
  let n = node;
  while (n.parent && WRAPPERS.has(n.parent.type)) n = n.parent;
  return n;
}

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global", "frames"]);
// Every function's `.constructor` is Function; these globals are functions.
const GLOBAL_CONSTRUCTORS = new Set([
  "Function", "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Promise", "Date", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet", "Proxy",
]);

function isGetPrototypeOfCall(n: AstNode): boolean {
  if (n.type !== "CallExpression") return false;
  const c = unwrap(n.callee);
  return (
    c.type === "MemberExpression" &&
    staticPropertyName(c) === "getPrototypeOf" &&
    c.object.type === "Identifier" &&
    (c.object.name === "Object" || c.object.name === "Reflect")
  );
}

/** `obj.constructor` whose value is (or may be) the Function constructor. */
function constructorAccessIsDynamicCode(member: AstNode): boolean {
  const obj = unwrap(member.object);
  if (obj.type === "MemberExpression" && staticPropertyName(obj) === "constructor") return true;
  if (isFunctionLike(obj) || obj.type === "ClassExpression" || isGetPrototypeOfCall(obj)) return true;
  if (obj.type === "Identifier" && GLOBAL_CONSTRUCTORS.has(obj.name)) return true;
  if (obj.type === "ThisExpression" || obj.type === "Super") return false;
  // `new x.constructor(...)` / `x.constructor(...)`: invoking an unknown
  // value's constructor with arguments is how a string becomes code.
  return isCalleeOf(outermostWrapper(member));
}

type Scope = Rule.RuleContext["sourceCode"]["scopeManager"]["globalScope"];

function isShadowed(scope: Scope | null, name: string): boolean {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v && v.defs.length > 0) return true;
  }
  return false;
}

const VALUE_WRAPPER_TS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);

/** True when the identifier is evaluated as a runtime value. */
function isValueReference(id: AstNode): boolean {
  const p = id.parent;
  if (!p) return false;
  if (p.type.startsWith("TS") && !VALUE_WRAPPER_TS.has(p.type)) return false;
  if (p.type === "MemberExpression" && p.property === id && !p.computed) return false;
  if ((p.type === "Property" || p.type === "MethodDefinition" || p.type === "PropertyDefinition") && p.key === id && !p.computed) {
    return p.type === "Property" && p.shorthand && p.value === id;
  }
  if (p.type === "ImportSpecifier" || p.type === "ExportSpecifier" || p.type === "LabeledStatement") return false;
  if (p.type === "BinaryExpression" && p.operator === "instanceof" && p.right === id) return false;
  return true;
}

/** `new Function()`, `Function()`, `Function.call/apply/bind()` are reported by core `no-new-func`. */
function isCoveredByNoNewFunc(id: AstNode): boolean {
  const outer = outermostWrapper(id);
  if (isCalleeOf(outer)) return true;
  const p = outer.parent;
  if (p?.type !== "MemberExpression" || unwrap(p.object) !== id) return false;
  const method = staticPropertyName(p);
  return (method === "call" || method === "apply" || method === "bind") && isCalleeOf(outermostWrapper(p));
}

const VM_MODULES = new Set(["vm", "node:vm"]);
const REMOTE_IMPORT_RE = /^(data|blob|https?):/i;

function literalString(n: AstNode | undefined): string | null {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}

const dynamicCode: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      constructor: "Reaching the Function constructor through `.constructor` builds code from strings, which the complexity gate cannot measure.",
      functionValue: "Using `Function` as a value lets code be built from strings, which the complexity gate cannot measure.",
      dynamicImport: "`import()` with a non-literal or remote specifier can load code the gate never sees.",
      vm: "The `vm` module evaluates strings as code, which the complexity gate cannot measure.",
      workerEval: "`new Worker(code, { eval: true })` evaluates a string as code.",
      destructure: "Destructuring `constructor` can extract the Function constructor.",
    },
  },
  create(context) {
    const sc = context.sourceCode;
    const reportVm = (node: AstNode, src: AstNode | undefined) => {
      const s = literalString(src);
      if (s !== null && VM_MODULES.has(s)) context.report({ node: node as never, messageId: "vm" });
    };
    return {
      MemberExpression(node: never) {
        const n = node as AstNode;
        const name = staticPropertyName(n);
        if (name === "constructor" && constructorAccessIsDynamicCode(n)) {
          context.report({ node, messageId: "constructor" });
        } else if (name === "Function" && n.object.type === "Identifier" && GLOBAL_OBJECTS.has(n.object.name)) {
          context.report({ node, messageId: "functionValue" });
        }
      },
      Identifier(node: never) {
        const n = node as AstNode;
        if (n.name !== "Function" || !isValueReference(n)) return;
        if (isCoveredByNoNewFunc(n)) return;
        if (isShadowed(sc.getScope(node) as Scope, "Function")) return;
        context.report({ node, messageId: "functionValue" });
      },
      ImportExpression(node: never) {
        const n = node as AstNode;
        const s = literalString(n.source);
        if (s === null || REMOTE_IMPORT_RE.test(s)) context.report({ node, messageId: "dynamicImport" });
        else if (VM_MODULES.has(s)) context.report({ node, messageId: "vm" });
      },
      ImportDeclaration(node: never) {
        reportVm(node, (node as AstNode).source);
      },
      ExportAllDeclaration(node: never) {
        reportVm(node, (node as AstNode).source);
      },
      ExportNamedDeclaration(node: never) {
        const n = node as AstNode;
        if (n.source) reportVm(n, n.source);
      },
      TSImportEqualsDeclaration(node: never) {
        const ref = (node as AstNode).moduleReference;
        if (ref?.type === "TSExternalModuleReference") reportVm(node, ref.expression);
      },
      CallExpression(node: never) {
        const n = node as AstNode;
        const callee = unwrap(n.callee);
        if (callee.type === "Identifier" && callee.name === "require") reportVm(n, n.arguments[0]);
      },
      NewExpression(node: never) {
        const n = node as AstNode;
        const callee = unwrap(n.callee);
        const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? staticPropertyName(callee) : null;
        if (name !== "Worker") return;
        const opts = n.arguments[1];
        if (opts?.type !== "ObjectExpression") return;
        const evalProp = opts.properties.find(
          (p: AstNode) => p.type === "Property" && !p.computed && (p.key.name === "eval" || p.key.value === "eval"),
        );
        if (evalProp && !(evalProp.value.type === "Literal" && evalProp.value.value === false)) {
          context.report({ node, messageId: "workerEval" });
        }
      },
      Property(node: never) {
        const n = node as AstNode;
        if (n.parent?.type !== "ObjectPattern") return;
        const key = n.computed ? literalString(n.key) : n.key.type === "Identifier" ? n.key.name : literalString(n.key);
        if (key === "constructor") context.report({ node, messageId: "destructure" });
      },
    } as unknown as Rule.RuleListener;
  },
};

// ---------------------------------------------------------------------------
// S9 branch hiding
// ---------------------------------------------------------------------------

const COMPARISON_OPS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"]);
const ARITHMETIC_OPS = new Set(["*", "-", "/", "%", "**", "|", "&", "^", "<<", ">>", ">>>"]);
const ITERATION_METHODS = new Set(["forEach", "map", "filter", "some", "every", "reduce", "flatMap", "find", "findIndex"]);
/** Combinator names from fp libraries and the 7.2 (f″) experiment. */
const COMBINATOR_NAMES = new Set(["when", "unless", "ifElse", "cond", "match", "caseOf", "switchCase", "branch", "choose"]);

function isBooleanish(node: AstNode): boolean {
  const n = unwrap(node);
  if (n.type === "BinaryExpression") return COMPARISON_OPS.has(n.operator);
  if (n.type === "LogicalExpression") return true;
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

function contains(node: AstNode, pred: (n: AstNode) => boolean): boolean {
  if (pred(node)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.some((v) => v && typeof v.type === "string" && contains(v, pred))) return true;
    } else if (typeof value.type === "string" && contains(value as AstNode, pred)) {
      return true;
    }
  }
  return false;
}

function hasWrite(n: AstNode): boolean {
  return contains(n, (x) => SIDE_EFFECT_TYPES.has(x.type) || (x.type === "UnaryExpression" && x.operator === "delete"));
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

const branchHiding: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      logicalAssignment: "Logical assignment `{{op}}` with a side effect hides a branch from the complexity measurement.",
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
        // `cache ||= compute()` / `x ??= load()` is the memo idiom; only a
        // nested write, or a call under `&&=`, turns it into a hidden `if`.
        const hidden = hasWrite(n.right) || (n.operator === "&&=" && hasCall(n.right));
        if (hidden) context.report({ node, messageId: "logicalAssignment", data: { op: n.operator } });
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
          // A top-level `(async () => { ... })()` is the script entry idiom.
          const stmt = outermostWrapper(n).parent;
          const topLevel = stmt?.type === "ExpressionStatement" && stmt.parent?.type === "Program";
          if (!topLevel) context.report({ node, messageId: "iife" });
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

const suppressionDirective: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: { directive: "{{directive}}" },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Line" && comment.type !== "Block") continue;
          const d = classifyDirectiveComment(comment.value, comment.type);
          if (!d || !comment.loc) continue;
          context.report({ loc: comment.loc, messageId: "directive", data: { directive: d.normalized } });
        }
      },
    };
  },
};

export const PLUGIN_NAME = "nyorori";

export const nyororiPlugin: ESLint.Plugin = {
  meta: { name: "nyorori-gate" },
  rules: {
    "dynamic-code": dynamicCode,
    "branch-hiding": branchHiding,
    "suppression-directive": suppressionDirective,
  },
};
