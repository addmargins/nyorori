// dynamic-code: building or loading code the gate never sees (spec 7.2 i,
// V17, audit F7). Every way to reach the Function constructor, eval, the vm
// module, the CommonJS compiler or native bindings from a string.

import { posix, relative, sep } from "node:path";
import type { Rule } from "eslint";
import { matchesAny } from "../../../util/glob.js";
import {
  constInit,
  findVariable,
  foldString,
  isCalleeOf,
  isFunctionLike,
  isShadowed,
  literalString,
  outermostWrapper,
  propertyName,
  staticPropertyName,
  unwrap,
  type AstNode,
  type Scope,
  type SourceCode,
} from "./ast.js";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global", "frames"]);
// Every function's `.constructor` is Function; these globals are functions.
const GLOBAL_CONSTRUCTORS = new Set([
  "Function", "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Promise", "Date", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet", "Proxy",
]);
const VM_MODULES = new Set(["vm", "node:vm"]);
const REMOTE_IMPORT_RE = /^(data|blob|https?):/i;
/** CommonJS loader internals: compiling a string or registering an extension handler. */
const MODULE_INTERNALS = new Set(["_compile", "_extensions"]);
const NATIVE_BINDINGS = new Set(["binding", "_linkedBinding", "dlopen"]);
const DESCRIPTOR_READERS = new Set(["get", "getOwnPropertyDescriptor"]);
/** Timers that evaluate a string first argument (core no-implied-eval sees literals only). */
const STRING_TIMERS = new Set(["setTimeout", "setInterval", "setImmediate", "execScript"]);

/** A parameter declared `: string`, i.e. `function f(code: string) { setTimeout(code) }`. */
function isStringTypedParam(node: AstNode, sc: SourceCode): boolean {
  const n = unwrap(node);
  if (n.type !== "Identifier") return false;
  const v = findVariable(sc.getScope(n as never) as Scope, n.name);
  const def = v?.defs[0];
  if (!v || v.defs.length !== 1 || def?.type !== "Parameter") return false;
  const name = def.name as unknown as AstNode;
  return name.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword";
}
const CODE_SUFFIX_RE = /\.(?:[cm]?[jt]sx?)$/;
const UNTRUSTED_DIR_SEGMENTS = new Set(["node_modules", "vendor", "generated", "__generated__"]);

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

/** `globalThis`, `window`... or a never-reassigned local alias of one. */
function isGlobalObject(node: AstNode, sc: SourceCode, depth = 0): boolean {
  const n = unwrap(node);
  if (n.type !== "Identifier" || depth > 4) return false;
  const scope = sc.getScope(n as never) as Scope;
  if (GLOBAL_OBJECTS.has(n.name) && !isShadowed(scope, n.name)) return true;
  const init = constInit(findVariable(scope, n.name));
  return !!init && isGlobalObject(init, sc, depth + 1);
}

/** The object whose `.constructor` is (or may be) the Function constructor. */
function constructorOfIsFunction(obj: AstNode, member: AstNode | null, sc: SourceCode): boolean {
  const o = unwrap(obj);
  if (o.type === "MemberExpression" && propertyName(o, sc) === "constructor") return true;
  if (isFunctionLike(o) || o.type === "ClassExpression" || isGetPrototypeOfCall(o)) return true;
  if (o.type === "Identifier" && GLOBAL_CONSTRUCTORS.has(o.name)) return true;
  // `Function.prototype.constructor`; `Foo.prototype.constructor` is just Foo.
  if (o.type === "MemberExpression" && staticPropertyName(o) === "prototype") {
    const holder = unwrap(o.object);
    return holder.type === "Identifier" && holder.name === "Function";
  }
  if (o.type === "ThisExpression" || o.type === "Super") return false;
  // `new x.constructor(...)` / `x.constructor(...)`: invoking an unknown
  // value's constructor with arguments is how a string becomes code.
  return member !== null && isCalleeOf(outermostWrapper(member));
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

function isCreateRequireCall(n: AstNode): boolean {
  if (n.type !== "CallExpression") return false;
  const c = unwrap(n.callee);
  if (c.type === "Identifier") return c.name === "createRequire";
  return c.type === "MemberExpression" && staticPropertyName(c) === "createRequire";
}

/** `require`, `module.require`, `createRequire(...)`, or a local bound to one of them. */
function isRequireFunction(node: AstNode, sc: SourceCode, depth = 0): boolean {
  const n = unwrap(node);
  if (depth > 4) return false;
  if (isCreateRequireCall(n)) return true;
  if (n.type === "MemberExpression") {
    return staticPropertyName(n) === "require" && unwrap(n.object).type === "Identifier" && unwrap(n.object).name === "module";
  }
  if (n.type !== "Identifier") return false;
  if (n.name === "require") return true;
  const init = constInit(findVariable(sc.getScope(n as never) as Scope, n.name));
  return !!init && isRequireFunction(init, sc, depth + 1);
}

/** The module-specifier argument of a require-like call, if this is one. */
function requireSpecifier(call: AstNode, sc: SourceCode): { arg: AstNode | undefined } | null {
  const callee = unwrap(call.callee);
  if (isRequireFunction(callee, sc)) return { arg: call.arguments[0] };
  // require.call(thisArg, spec) / require.apply(thisArg, [spec])
  if (callee.type === "MemberExpression" && isRequireFunction(callee.object, sc)) {
    const m = staticPropertyName(callee);
    if (m === "call") return { arg: call.arguments[1] };
    if (m === "apply") {
      const arr = call.arguments[1];
      return { arg: arr?.type === "ArrayExpression" ? arr.elements[0] : undefined };
    }
  }
  return null;
}

interface TemplateImportVerdict {
  kind: "data" | "code" | "block";
  dir: string;
}

/**
 * Ruling D10: `import(`./dir/${x}.json`)` loads from a fixed in-repo
 * directory. A non-code suffix is data (observe), a code suffix goes to a
 * human (S11); anything else stays DYNAMIC_CODE.
 */
function templateImport(tpl: AstNode, fileRel: string, excludedDirs: readonly string[]): TemplateImportVerdict {
  const head: string = tpl.quasis[0].value.cooked ?? "";
  const tail: string = tpl.quasis[tpl.quasis.length - 1].value.cooked ?? "";
  const m = /^\.\/((?:[^/]+\/)+)/.exec(head);
  if (!m) return { kind: "block", dir: head };
  const dirPart = m[1]!.slice(0, -1);
  if (dirPart.split("/").some((s) => s === ".." || s === "." || s === "")) return { kind: "block", dir: dirPart };
  const dir = posix.normalize(posix.join(posix.dirname(fileRel), dirPart));
  if (dir.startsWith("..") || dir.split("/").some((s) => UNTRUSTED_DIR_SEGMENTS.has(s))) return { kind: "block", dir };
  if (matchesAny(`${dir}/__probe__.js`, excludedDirs) || matchesAny(dir, excludedDirs)) return { kind: "block", dir };
  const suffix = tail.split("?")[0]!;
  const ext = /\.[A-Za-z0-9]+$/.exec(suffix)?.[0];
  return { kind: ext && !CODE_SUFFIX_RE.test(ext) ? "data" : "code", dir };
}

export const dynamicCode: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { excludedDirs: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      constructor: "Reaching the Function constructor through `constructor` builds code from strings, which the complexity gate cannot measure.",
      functionValue: "Using `Function` as a value lets code be built from strings, which the complexity gate cannot measure.",
      evalAccess: "Reaching `eval` through a computed or aliased name evaluates strings as code.",
      globalComputedCall: "Calling a global by a computed name can reach eval or Function.",
      dynamicImport: "`import()` with a non-literal or remote specifier can load code the gate never sees.",
      templateImportData: "`import()` of data from `{{dir}}` with a computed name.",
      templateImportCode: "`import()` of code from `{{dir}}` with a computed name loads modules a reviewer must check.",
      dynamicRequire: "`require()` with a non-literal specifier can load code the gate never sees.",
      vm: "The `vm` module evaluates strings as code, which the complexity gate cannot measure.",
      moduleInternals: "`{{name}}` drives the CommonJS compiler directly and can run strings as code.",
      nativeBinding: "`process.{{name}}` reaches native internals that can evaluate code.",
      workerEval: "`new Worker(code, { eval: true })` evaluates a string as code.",
      impliedEval: "`{{name}}` with a string evaluates it as code.",
      destructure: "Destructuring `constructor` can extract the Function constructor.",
    },
  },
  create(context) {
    const sc = context.sourceCode;
    const excludedDirs: string[] = (context.options[0] as { excludedDirs?: string[] } | undefined)?.excludedDirs ?? [];
    const fileRel = relative(context.cwd, context.filename).split(sep).join("/");
    const report = (node: AstNode, messageId: string, data?: Record<string, string>) =>
      context.report({ node: node as never, messageId, ...(data ? { data } : {}) });

    const checkSpecifier = (node: AstNode, src: AstNode | undefined) => {
      const s = foldString(src, sc);
      if (s !== null && VM_MODULES.has(s)) report(node, "vm");
    };

    return {
      MemberExpression(node: never) {
        const n = node as AstNode;
        const name = propertyName(n, sc);
        if (name === "constructor") {
          if (constructorOfIsFunction(n.object, n, sc)) report(n, "constructor");
          return;
        }
        if (name !== null && MODULE_INTERNALS.has(name)) {
          report(n, "moduleInternals", { name });
          return;
        }
        const obj = unwrap(n.object);
        if (name !== null && NATIVE_BINDINGS.has(name) && obj.type === "Identifier" && obj.name === "process") {
          if (!isShadowed(sc.getScope(node) as Scope, "process")) report(n, "nativeBinding", { name });
          return;
        }
        if (!isGlobalObject(n.object, sc)) return;
        // Core no-eval already reports `globalThis.eval` / `window["eval"]`
        // spelled literally; aliases and folded keys are ours.
        const literalGlobal = obj.type === "Identifier" && GLOBAL_OBJECTS.has(obj.name) && staticPropertyName(n) !== null;
        if (name === "Function") report(n, "functionValue");
        else if (name === "eval" && !literalGlobal) report(n, "evalAccess");
        else if (name === null && isCalleeOf(outermostWrapper(n))) report(n, "globalComputedCall");
      },
      Identifier(node: never) {
        const n = node as AstNode;
        if (n.name !== "Function" || !isValueReference(n)) return;
        if (isCoveredByNoNewFunc(n)) return;
        if (isShadowed(sc.getScope(node) as Scope, "Function")) return;
        report(n, "functionValue");
      },
      ImportExpression(node: never) {
        const n = node as AstNode;
        const s = foldString(n.source, sc);
        if (s !== null) {
          if (REMOTE_IMPORT_RE.test(s)) report(n, "dynamicImport");
          else if (VM_MODULES.has(s)) report(n, "vm");
          return;
        }
        const src = unwrap(n.source);
        if (src.type === "TemplateLiteral" && src.expressions.length > 0) {
          const v = templateImport(src, fileRel, excludedDirs);
          if (v.kind === "data") return report(n, "templateImportData", { dir: v.dir });
          if (v.kind === "code") return report(n, "templateImportCode", { dir: v.dir });
        }
        report(n, "dynamicImport");
      },
      ImportDeclaration(node: never) {
        checkSpecifier(node, (node as AstNode).source);
      },
      ExportAllDeclaration(node: never) {
        checkSpecifier(node, (node as AstNode).source);
      },
      ExportNamedDeclaration(node: never) {
        const n = node as AstNode;
        if (n.source) checkSpecifier(n, n.source);
      },
      TSImportEqualsDeclaration(node: never) {
        const ref = (node as AstNode).moduleReference;
        if (ref?.type === "TSExternalModuleReference") checkSpecifier(node, ref.expression);
      },
      CallExpression(node: never) {
        const n = node as AstNode;
        const req = requireSpecifier(n, sc);
        if (req) {
          if (!req.arg) return;
          const s = foldString(req.arg, sc);
          if (s === null) report(n, "dynamicRequire");
          else if (VM_MODULES.has(s)) report(n, "vm");
          return;
        }
        const callee = unwrap(n.callee);
        const timer = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && isGlobalObject(callee.object, sc) ? staticPropertyName(callee) : null;
        if (timer !== null && STRING_TIMERS.has(timer) && n.arguments[0]) {
          const first = n.arguments[0];
          const folded = unwrap(first).type === "Identifier" && foldString(first, sc) !== null;
          if (folded || isStringTypedParam(first, sc)) report(n, "impliedEval", { name: timer });
          return;
        }
        // Reflect.get(fn, "constructor"), Object.getOwnPropertyDescriptor(F.prototype, "constructor")
        if (callee.type !== "MemberExpression" || unwrap(callee.object).type !== "Identifier") return;
        const holder = unwrap(callee.object).name;
        const method = staticPropertyName(callee);
        if ((holder !== "Reflect" && holder !== "Object") || method === null || !DESCRIPTOR_READERS.has(method)) return;
        const [target, key] = n.arguments;
        if (!target) return;
        const k = foldString(key, sc);
        if (k === "constructor" && constructorOfIsFunction(target, null, sc)) report(n, "constructor");
        else if (isGlobalObject(target, sc) && (k === null || k === "eval" || k === "Function")) report(n, "globalComputedCall");
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
        if (evalProp && !(evalProp.value.type === "Literal" && evalProp.value.value === false)) report(n, "workerEval");
      },
      Property(node: never) {
        const n = node as AstNode;
        if (n.parent?.type !== "ObjectPattern") return;
        const key = n.computed ? foldString(n.key, sc) : n.key.type === "Identifier" ? n.key.name : literalString(n.key);
        if (key === "constructor") report(n, "destructure");
      },
    } as unknown as Rule.RuleListener;
  },
};
