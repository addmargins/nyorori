/** Trusted static gates. Candidate JavaScript/configuration is parsed, never imported. */
import { Linter, type Rule } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import { minimatch } from 'minimatch';
import { format } from 'prettier';
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import { unsupportedResolverConfig } from './git.js';
import { matchUnits, flattenUnits, unitKey } from './complexity.js';
import {
  gateResult,
  type FileChange,
  type FunctionUnit,
  type GateResult,
  type Issue,
  type MeasuredFile,
  type Measurement,
  type Policy,
  type Snapshot,
  type SourceFile,
} from './types.js';

type Node = {
  type: string;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  range?: [number, number];
  [key: string]: unknown;
};
type Diagnostic = {
  ruleId: string | null;
  messageId?: string;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fatal?: boolean;
  severity: number;
};
interface FunctionRange {
  start: number;
  end: number;
  startColumn: number;
  endColumn: number;
  unit?: FunctionUnit;
}
interface Analysis {
  diagnostics: Diagnostic[];
  ranges: FunctionRange[];
  ast?: Node;
  issues: Issue[];
}
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
]);
const SOURCE_KINDS = new Set(['source', 'test']);
const BIDI = /[\u202a-\u202e\u2066-\u2069]/gu;
const SUPPRESSION =
  /(?:\beslint-disable(?:-next-line|-line)?\b|@ts-(?:ignore|nocheck)\b|\b(?:istanbul|v8|c8)\s+ignore\b)/u;
const DYNAMIC_GLOBALS = new Set([
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'eval',
]);
function node(value: unknown): Node | undefined {
  return value && typeof value === 'object' && typeof (value as Node).type === 'string'
    ? (value as Node)
    : undefined;
}
function memberName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Identifier') return String(n.name);
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const left = memberName(node(n.left)),
      right = memberName(node(n.right));
    if (
      node(n.left)?.type === 'Literal' &&
      node(n.right)?.type === 'Literal' &&
      left !== undefined &&
      right !== undefined
    )
      return left + right;
  }
  return undefined;
}
function propertyName(n: Node): string | undefined {
  return n.computed
    ? memberName(node(n.property))
    : node(n.property)?.type === 'Identifier'
      ? String(node(n.property)?.name)
      : undefined;
}
function unwrap(n: Node | undefined): Node | undefined {
  while (
    n &&
    [
      'ChainExpression',
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'ParenthesizedExpression',
    ].includes(n.type)
  )
    n = node(n.expression);
  return n;
}
function referenceIdentifier(n: Node): boolean {
  const p = node(n.parent);
  if (!p) return true;
  if (
    (p.type === 'MemberExpression' ||
      p.type === 'Property' ||
      p.type === 'MethodDefinition' ||
      p.type === 'PropertyDefinition') &&
    p.property === n &&
    !p.computed
  )
    return false;
  if (
    (p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') &&
    p.key === n &&
    !p.computed &&
    !p.shorthand
  )
    return false;
  if (p.type === 'VariableDeclarator' && p.id === n) return false;
  if (
    FUNCTION_TYPES.has(p.type) &&
    (p.id === n || (Array.isArray(p.params) && p.params.includes(n)))
  )
    return false;
  if (
    p.type.startsWith('TS') &&
    !['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(p.type)
  )
    return false;
  return true;
}
const securityRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      dynamic: 'Dynamic code construction/evaluation is prohibited ({{detail}}).',
      suppression: 'Gate suppression directives are prohibited ({{detail}}).',
      bidi: 'Bidirectional control characters are prohibited.',
    },
  },
  create(context) {
    const report = (n: Node, detail: string) =>
      context.report({
        node: n as never,
        messageId: 'dynamic',
        data: { detail },
      });
    return {
      Identifier(raw) {
        const n = raw as unknown as Node;
        if (DYNAMIC_GLOBALS.has(String(n.name)) && referenceIdentifier(n))
          report(n, String(n.name));
      },
      MemberExpression(raw) {
        const n = raw as unknown as Node;
        const p = propertyName(n);
        if (p === 'constructor') report(n, '.constructor');
        if (
          p &&
          DYNAMIC_GLOBALS.has(p) &&
          ['globalThis', 'global', 'window', 'self'].includes(
            memberName(unwrap(node(n.object))) ?? '',
          )
        )
          report(n, `global dynamic constructor/evaluator ${p}`);
        if (p === 'construct' && memberName(unwrap(node(n.object))) === 'Reflect')
          report(n, 'Reflect.construct');
      },
      ImportDeclaration(raw) {
        const n = raw as unknown as Node;
        const spec = node(n.source)?.value;
        if (spec === 'vm' || spec === 'node:vm') report(n, 'vm module');
      },
      ExportNamedDeclaration(raw) {
        const n = raw as unknown as Node;
        const spec = node(n.source)?.value;
        if (spec === 'vm' || spec === 'node:vm') report(n, 'vm module');
      },
      ImportExpression(raw) {
        const n = raw as unknown as Node;
        const source = unwrap(node(n.source));
        if (source?.type !== 'Literal' || typeof source.value !== 'string')
          report(n, 'nonliteral import()');
        else if (/^(?:data:|https?:|node:vm$|vm$)/u.test(source.value))
          report(n, 'dynamic executable import');
      },
      CallExpression(raw) {
        const n = raw as unknown as Node;
        const callee = unwrap(node(n.callee));
        const args = Array.isArray(n.arguments) ? n.arguments : [];
        if (
          callee?.type === 'Identifier' &&
          callee.name === 'require' &&
          ['vm', 'node:vm'].includes(String(node(args[0])?.value))
        )
          report(n, 'vm module');
      },
      Program(raw) {
        for (const comment of context.sourceCode.getAllComments())
          if (SUPPRESSION.test(comment.value))
            context.report({
              loc: comment.loc as never,
              messageId: 'suppression',
              data: { detail: comment.value.trim() },
            });
        const source = context.sourceCode.text;
        for (const match of source.matchAll(BIDI)) {
          const pos = context.sourceCode.getLocFromIndex(match.index);
          context.report({
            loc: {
              start: pos,
              end: { line: pos.line, column: pos.column + 1 },
            },
            messageId: 'bidi',
          });
        }
      },
    };
  },
};
function sideEffect(n: Node | undefined): boolean {
  if (!n) return false;
  if (
    [
      'CallExpression',
      'NewExpression',
      'AssignmentExpression',
      'UpdateExpression',
      'AwaitExpression',
      'YieldExpression',
    ].includes(n.type)
  )
    return true;
  for (const [k, v] of Object.entries(n)) {
    if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(k)) continue;
    if (Array.isArray(v)) {
      if (v.some((x) => sideEffect(node(x)))) return true;
    } else if (sideEffect(node(v))) return true;
  }
  return false;
}
const hidingRule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { hidden: 'Potential branch hiding: {{detail}}.' },
  },
  create(context) {
    const report = (n: Node, detail: string) =>
      context.report({
        node: n as never,
        messageId: 'hidden',
        data: { detail },
      });
    return {
      AssignmentExpression(raw) {
        const n = raw as unknown as Node;
        if (['&&=', '||=', '??='].includes(String(n.operator)) && sideEffect(node(n.right)))
          report(n, 'side-effectful logical assignment');
      },
      CallExpression(raw) {
        const n = raw as unknown as Node;
        const callee = unwrap(node(n.callee));
        if (callee && ['FunctionExpression', 'ArrowFunctionExpression'].includes(callee.type))
          report(n, 'IIFE');
        if (
          callee?.type === 'MemberExpression' &&
          ['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'flatMap'].includes(
            propertyName(callee) ?? '',
          )
        ) {
          const receiver = unwrap(node(callee.object));
          if (
            receiver?.type === 'ArrayExpression' &&
            Array.isArray(receiver.elements) &&
            receiver.elements.length <= 1
          )
            report(n, 'single-element array combinator');
        }
      },
      MemberExpression(raw) {
        const n = raw as unknown as Node;
        const o = unwrap(node(n.object));
        const p = unwrap(node(n.property));
        if (
          n.computed &&
          o?.type === 'ArrayExpression' &&
          ((p?.type === 'UnaryExpression' && p.operator === '+') ||
            (p?.type === 'CallExpression' && memberName(unwrap(node(p.callee))) === 'Number'))
        )
          report(n, 'boolean array indexing');
      },
      UnaryExpression(raw) {
        const n = raw as unknown as Node;
        const a = unwrap(node(n.argument));
        if (
          n.operator === '+' &&
          a &&
          ['BinaryExpression', 'LogicalExpression', 'UnaryExpression'].includes(a.type)
        )
          report(n, 'numeric coercion of condition');
      },
      Property(raw) {
        const n = raw as unknown as Node;
        if (unwrap(node(n.value))?.type === 'ArrowFunctionExpression')
          report(n, 'closure dispatch table');
      },
    };
  },
};
function parse(content: string): Node {
  return parser.parse(content, {
    loc: true,
    range: true,
    comment: true,
    tokens: true,
    jsx: true,
    sourceType: 'module',
    ecmaVersion: 'latest',
  }) as unknown as Node;
}
function walk(n: Node, visit: (n: Node, parent?: Node) => void, parent?: Node): void {
  visit(n, parent);
  for (const [key, value] of Object.entries(n)) {
    if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = node(item);
        if (child) walk(child, visit, n);
      }
    } else {
      const child = node(value);
      if (child) walk(child, visit, n);
    }
  }
}
function ranges(ast: Node, measured?: MeasuredFile): FunctionRange[] {
  const byLine = new Map<number, FunctionUnit[]>();
  for (const u of measured ? flattenUnits(measured) : []) {
    const bucket = byLine.get(u.line) ?? [];
    bucket.push(u);
    byLine.set(u.line, bucket);
  }
  const seen = new Map<number, number>();
  const result: FunctionRange[] = [];
  walk(ast, (n, parent) => {
    if (!FUNCTION_TYPES.has(n.type) || !n.loc) return;
    const line = n.loc.start.line;
    const i = seen.get(line) ?? 0;
    seen.set(line, i + 1);
    const owner =
      parent &&
      ['MethodDefinition', 'PropertyDefinition', 'Property'].includes(parent.type) &&
      parent.value === n &&
      parent.loc
        ? parent
        : n;
    result.push({
      start: owner.loc!.start.line,
      end: owner.loc!.end.line,
      startColumn: owner.loc!.start.column,
      endColumn: owner.loc!.end.column,
      unit: byLine.get(line)?.[i],
    });
  });
  return result;
}
function diagnosticRange(d: Diagnostic, a: Analysis): FunctionRange | undefined {
  const contains = (r: FunctionRange) =>
    d.line >= r.start &&
    d.line <= r.end &&
    (d.line !== r.start || d.column - 1 >= r.startColumn) &&
    (d.line !== r.end || d.column - 1 < r.endColumn);
  return a.ranges
    .filter(contains)
    .sort((x, y) => x.end - x.start - (y.end - y.start) || y.startColumn - x.startColumn)[0];
}
function diagnosticUnit(d: Diagnostic, a: Analysis): FunctionUnit | undefined {
  return diagnosticRange(d, a)?.unit;
}
function makeLinter(file: SourceFile, policy: Policy): Linter.FlatConfig[] {
  return [
    {
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      languageOptions: {
        parser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: 'off',
      },
      plugins: {
        '@typescript-eslint': tsPlugin as never,
        nyorori: {
          rules: { security: securityRule, 'branch-hiding': hidingRule },
        },
      },
      rules: {
        'no-eval': 'error',
        'no-new-func': 'error',
        'no-implied-eval': 'error',
        '@typescript-eslint/max-params': [
          'error',
          { max: policy.limits.max_params, countVoidThis: false },
        ],
        'max-nested-callbacks':
          file.classification === 'test' ? 'off' : ['error', policy.limits.max_callbacks],
        'nyorori/security': 'error',
        'nyorori/branch-hiding': 'warn',
        'max-lines-per-function': [
          'warn',
          {
            max: policy.limits.max_function_lines,
            skipBlankLines: true,
            skipComments: true,
          },
        ],
        'no-param-reassign': ['warn', { props: true }],
        'max-depth': ['warn', 4],
        'max-statements': ['warn', 30],
        'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      },
    },
  ];
}
function analyze(file: SourceFile, measured: MeasuredFile | undefined, policy: Policy): Analysis {
  const result: Analysis = { diagnostics: [], ranges: [], issues: [] };
  try {
    const linter = new Linter();
    result.diagnostics = linter.verify(file.content, makeLinter(file, policy), {
      filename: `snapshot/${file.path}`,
    }) as Diagnostic[];
    result.ast = parse(file.content);
    result.ranges = ranges(result.ast, measured);
  } catch (e) {
    result.issues.push({
      code: 'STRUCTURE_PARSE_ERROR',
      file: file.path,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const fatals = result.diagnostics.filter((x) => x.fatal);
  for (const d of fatals)
    result.issues.push({
      code: 'STRUCTURE_PARSE_ERROR',
      file: file.path,
      line: d.line,
      message: d.message,
    });
  return result;
}
async function normalizedRows(file: SourceFile): Promise<number> {
  const formatted = await format(file.content, {
    filepath: file.path,
    parser: /\.(?:[cm]?ts|tsx)$/u.test(file.path) ? 'typescript' : 'babel',
  });
  const ast = parse(formatted);
  const lines = new Set<number>();
  for (const token of Array.isArray(ast.tokens) ? ast.tokens : []) {
    const t = node(token);
    if (t?.loc) for (let line = t.loc.start.line; line <= t.loc.end.line; line++) lines.add(line);
  }
  return lines.size;
}
function category(d: Diagnostic): string {
  return d.ruleId === 'nyorori/security'
    ? `security/${d.messageId ?? 'unknown'}/${d.message}`
    : d.ruleId === 'nyorori/branch-hiding'
      ? `${d.ruleId}/${d.message}`
      : (d.ruleId ?? 'parse');
}
function reason(d: Diagnostic): string {
  if (d.ruleId === 'nyorori/security')
    return d.messageId === 'suppression'
      ? 'SUPPRESSION_ADDED'
      : d.messageId === 'bidi'
        ? 'BIDI_CONTROL'
        : 'DYNAMIC_CODE';
  if (['no-eval', 'no-new-func', 'no-implied-eval'].includes(d.ruleId ?? '')) return 'DYNAMIC_CODE';
  if (d.ruleId === '@typescript-eslint/max-params') return 'MAX_PARAMS';
  if (d.ruleId === 'max-nested-callbacks') return 'MAX_NESTED_CALLBACKS';
  return 'STRUCTURE_VIOLATION';
}
function settle(result: GateResult): GateResult {
  result.violations = [...new Map(result.violations.map((v) => [JSON.stringify(v), v])).values()];
  if (result.violations.length) result.state = 'FAIL';
  else if (result.issues.length) result.state = 'INCONCLUSIVE';
  result.reasons = [
    ...new Set([...result.violations.map((v) => v.reason), ...result.issues.map((i) => i.code)]),
  ].sort();
  result.violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason),
  );
  result.triggers.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.id.localeCompare(b.id) ||
      a.evidence.localeCompare(b.evidence),
  );
  return result;
}
/** G2 compares rules at matched unit granularity, not just the diagnostic's start line. */
export async function evaluateStructure(
  snapshot: Snapshot,
  measurement: Measurement,
  policy: Policy,
): Promise<GateResult> {
  const result = gateResult('lint-structure', policy);
  const matches = matchUnits(snapshot, measurement);
  const matched = new Map(
    matches.filter((m) => m.method !== 'module').map((m) => [m.after, m.before]),
  );
  const byBefore = new Map<string, Analysis>();
  for (const change of snapshot.files)
    if (change.before && SOURCE_KINDS.has(change.before.classification))
      byBefore.set(
        change.before.path,
        analyze(change.before, measurement.base[change.before.path], policy),
      );
  const observed: Record<string, unknown>[] = [];
  let codeCount = 0;
  const matchedBefore = new Set(matches.map((m) => m.before));
  for (const change of snapshot.files) {
    const file = change.after;
    if (
      (change.before?.classification === 'source' && file && file.classification !== 'source') ||
      file?.classification === 'unmeasured' ||
      (file?.classification === 'excluded' &&
        (!change.before || change.before.classification !== 'excluded')) ||
      change.status[0] === 'T' ||
      ['.gitattributes', '.gitmodules'].includes(file?.path ?? change.before?.path ?? '')
    )
      result.triggers.push({
        id: 'S11',
        file: file?.path ?? change.before?.path ?? '',
        evidence:
          file?.reason ?? 'Unmeasured or scope-affecting change requires independent review.',
      });
    if (file && /\.d\.(?:ts|mts|cts)$/u.test(file.path)) {
      try {
        let implemented = false;
        walk(parse(file.content), (n) => {
          if (
            (FUNCTION_TYPES.has(n.type) && node(n.body)) ||
            (n.type === 'VariableDeclarator' && node(n.init)) ||
            (n.type === 'PropertyDefinition' && node(n.value)) ||
            n.type === 'StaticBlock' ||
            n.type === 'ExpressionStatement'
          )
            implemented = true;
        });
        if (implemented)
          result.violations.push({
            unit: `${file.path}::<module>#module[0]`,
            file: file.path,
            line: 1,
            reason: 'DECLARATION_IMPLEMENTATION',
            blob_sha: file.blob_sha,
          });
      } catch (e) {
        result.issues.push({
          code: 'STRUCTURE_PARSE_ERROR',
          file: file.path,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!file || !SOURCE_KINDS.has(file.classification)) continue;
    codeCount++;
    const current = analyze(file, measurement.candidate[file.path], policy);
    result.issues.push(...current.issues);
    const base = change.before ? byBefore.get(change.before.path) : undefined;
    const priorDiagnostics = base?.issues.length ? [] : (base?.diagnostics ?? []);
    if (current.ast && change.before) {
      const bindings = new Set<string>();
      walk(current.ast, (n) => {
        if (
          [
            'VariableDeclarator',
            'FunctionDeclaration',
            'ClassDeclaration',
            'ImportSpecifier',
            'ImportDefaultSpecifier',
            'ImportNamespaceSpecifier',
          ].includes(n.type)
        ) {
          const id = node(n.id ?? n.local);
          if (id?.type === 'Identifier') bindings.add(String(id.name));
        }
        if (
          ['MethodDefinition', 'PropertyDefinition', 'Property'].includes(n.type) &&
          !n.computed
        ) {
          const name = memberName(node(n.key));
          if (name) bindings.add(name);
        }
      });
      for (const u of measurement.base[change.before.path]
        ? flattenUnits(measurement.base[change.before.path]!)
        : [])
        if (u.name !== '<anonymous>' && !matchedBefore.has(u) && bindings.has(u.name))
          result.triggers.push({
            id: 'S11',
            file: file.path,
            evidence: `Named unit ${JSON.stringify(u.name)} disappeared from measurement while its binding remains in the candidate AST.`,
          });
      const bm = measurement.base[change.before.path],
        cm = measurement.candidate[file.path];
      if (bm && cm && !bm.parse_errors.length && !cm.parse_errors.length) {
        const bv = bm.cyclomatic - flattenUnits(bm).length,
          cv = cm.cyclomatic - flattenUnits(cm).length;
        try {
          const [br, cr] = await Promise.all([normalizedRows(change.before), normalizedRows(file)]);
          if (
            bv > 0 &&
            br > 0 &&
            cr > 0 &&
            ((cv < 0.7 * bv && cr > 0.7 * br) || (bv - cv >= 3 && cv / cr <= (0.7 * bv) / br))
          )
            result.triggers.push({
              id: 'S9',
              file: file.path,
              evidence: `Visible branches ${bv} → ${cv}; pinned-Prettier code rows ${br} → ${cr}; branch decrease/density warrants simplification review.`,
            });
        } catch (e) {
          result.issues.push({
            code: 'NORMALIZATION_ERROR',
            file: file.path,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    const usedByAnalysis = new Map<Analysis, Set<number>>();
    for (const d of current.diagnostics) {
      if (d.fatal || !d.ruleId) continue;
      const currentRange = diagnosticRange(d, current);
      const unit = currentRange?.unit;
      const previous = unit ? matched.get(unit) : undefined;
      const previousAnalysis = previous
        ? byBefore.get(matches.find((m) => m.after === unit)?.beforeFile ?? '')
        : base;
      const pool = previousAnalysis?.issues.length
        ? []
        : (previousAnalysis?.diagnostics ?? priorDiagnostics);
      const used = previousAnalysis
        ? (usedByAnalysis.get(previousAnalysis) ?? new Set<number>())
        : new Set<number>();
      if (previousAnalysis) usedByAnalysis.set(previousAnalysis, used);
      const redeclaredLong =
        d.ruleId === 'max-lines-per-function' &&
        matches.find((m) => m.after === unit)?.method !== 'anchor';
      const prevIndex =
        redeclaredLong || (currentRange && !unit)
          ? -1
          : pool.findIndex(
              (p, i) =>
                !used.has(i) &&
                category(p) === category(d) &&
                (unit
                  ? previous !== undefined &&
                    diagnosticUnit(
                      p,
                      previousAnalysis ?? {
                        diagnostics: [],
                        ranges: [],
                        issues: [],
                      },
                    ) === previous
                  : !diagnosticRange(
                      p,
                      previousAnalysis ?? {
                        diagnostics: [],
                        ranges: [],
                        issues: [],
                      },
                    )),
            );
      if (prevIndex >= 0) {
        used.add(prevIndex);
        continue;
      }
      const key = unit
        ? unitKey(file.path, unit, measurement.candidate[file.path]?.functions ?? [])
        : `${file.path}::<module>#module[0]`;
      if (d.severity === 2) {
        observed.push({
          file: file.path,
          line: d.line,
          rule: d.ruleId,
          message: d.message,
          severity: 'error',
        });
        result.violations.push({
          unit: key,
          file: file.path,
          line: d.line,
          reason: reason(d),
          blob_sha: file.blob_sha,
        });
      } else if (d.ruleId === 'nyorori/branch-hiding')
        result.triggers.push({
          id: 'S9',
          file: file.path,
          evidence: `${file.path}:${d.line}: ${d.message}`,
        });
      else if (d.ruleId === 'max-lines-per-function')
        result.triggers.push({
          id: 'S4',
          file: file.path,
          evidence: `${file.path}:${d.line}: ${d.message}`,
        });
      else if (d.ruleId === 'no-param-reassign' && unit && !previous)
        result.triggers.push({
          id: 'S10',
          file: file.path,
          evidence: `${file.path}:${d.line}: new helper mutates parameter state: ${d.message}`,
        });
      else
        observed.push({
          file: file.path,
          line: d.line,
          rule: d.ruleId,
          message: d.message,
        });
    }
  }
  result.observe = {
    lint: observed,
    configuration:
      'trusted ESLint flat config; noInlineConfig=true; no candidate config or plugins',
  };
  if (!codeCount && !result.triggers.length) result.state = 'NOT_APPLICABLE';
  return settle(result);
}

interface ImportRef {
  value?: string;
  line: number;
  dynamic: boolean;
}
interface Graph {
  edges: Map<string, Set<string>>;
  issues: Issue[];
}
function imports(ast: Node): ImportRef[] {
  const refs: ImportRef[] = [];
  walk(ast, (n) => {
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) &&
      node(n.source)
    ) {
      const s = node(n.source);
      refs.push({
        value: typeof s?.value === 'string' ? s.value : undefined,
        line: n.loc?.start.line ?? 1,
        dynamic: false,
      });
    }
    if (n.type === 'ImportExpression') {
      const s = unwrap(node(n.source));
      refs.push({
        value: s?.type === 'Literal' && typeof s.value === 'string' ? s.value : undefined,
        line: n.loc?.start.line ?? 1,
        dynamic: true,
      });
    }
    if (n.type === 'CallExpression' && memberName(unwrap(node(n.callee))) === 'require') {
      const args = Array.isArray(n.arguments) ? n.arguments : [];
      const s = unwrap(node(args[0]));
      refs.push({
        value: s?.type === 'Literal' && typeof s.value === 'string' ? s.value : undefined,
        line: n.loc?.start.line ?? 1,
        dynamic: true,
      });
    }
    if (n.type === 'TSImportEqualsDeclaration') {
      const ref = node(n.moduleReference);
      const s = node(ref?.expression);
      if (ref?.type === 'TSExternalModuleReference')
        refs.push({
          value: typeof s?.value === 'string' ? s.value : undefined,
          line: n.loc?.start.line ?? 1,
          dynamic: false,
        });
    }
  });
  return refs;
}
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
function resolveImport(from: string, specifier: string, paths: Set<string>): string | undefined {
  if (!specifier.startsWith('.'))
    return specifier.startsWith('/') ||
      specifier.startsWith('#') ||
      /^(?:data|https?|file):/u.test(specifier)
      ? undefined
      : `external:${specifier}`;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target === '..' || target.startsWith('../')) return undefined;
  const choices = [
    target,
    ...EXTENSIONS.map((e) => target + e),
    ...EXTENSIONS.map((e) => posix.join(target, 'index' + e)),
  ];
  const extension = posix.extname(target);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const stem = target.slice(0, -extension.length);
    choices.push(...EXTENSIONS.map((e) => stem + e));
  }
  const found = [...new Set(choices.filter((p) => paths.has(p)))];
  // Explicit JS can resolve to actual JS, while TS fallback is only used when JS is absent.
  if (paths.has(target)) return target;
  return found.length === 1 ? found[0] : undefined;
}
/** Parse JSONC as data, including escaped keys; never evaluate candidate configuration. */
function configObject(content: string): Record<string, unknown> {
  let clean = '',
    quoted = false,
    escaped = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === '/' && content[i + 1] === '/') {
      while (i + 1 < content.length && content[i + 1] !== '\n' && content[i + 1] !== '\r') i++;
    } else if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated JSONC comment');
      clean += ' ';
      i = end + 1;
    } else clean += c;
  }
  let json = '';
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      json += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      json += c;
    } else if (c === ',') {
      let next = i + 1;
      while (next < clean.length && /\s/u.test(clean[next]!)) next++;
      if (clean[next] !== '}' && clean[next] !== ']') json += c;
    } else json += c;
  }
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected configuration object');
  return value as Record<string, unknown>;
}
const UNSUPPORTED_RESOLUTION_OPTIONS = new Set([
  'paths',
  'baseUrl',
  'rootDirs',
  'moduleSuffixes',
  'customConditions',
  'moduleResolution',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
  'resolveJsonModule',
  'noResolve',
  'preserveSymlinks',
  'allowArbitraryExtensions',
  'allowImportingTsExtensions',
  'rewriteRelativeImportExtensions',
  'typeRoots',
  'types',
  'plugins',
  'jsxImportSource',
]);
function unsupportedTypeScriptConfig(file: SourceFile): string | undefined {
  if (file.mode !== '100644' && file.mode !== '100755') return 'Nonregular resolver metadata';
  try {
    const config = configObject(file.content);
    if (Object.hasOwn(config, 'extends') || Object.hasOwn(config, 'references'))
      return 'Config inheritance/project references';
    const options = config.compilerOptions;
    if (
      options !== undefined &&
      (!options || typeof options !== 'object' || Array.isArray(options))
    )
      return 'Malformed compilerOptions';
    const denied = Object.keys((options ?? {}) as Record<string, unknown>).filter((key) =>
      UNSUPPORTED_RESOLUTION_OPTIONS.has(key),
    );
    if (denied.length) return `Resolution options: ${denied.sort().join(', ')}`;
  } catch {
    return 'Unreadable or malformed JSON/JSONC resolver metadata';
  }
  return undefined;
}
function graph(files: SourceFile[]): Graph {
  const g: Graph = { edges: new Map(), issues: [] };
  const paths = new Set(files.map((f) => f.path));
  const packageNames = new Set<string>(),
    declared = new Set<string>();
  for (const f of files)
    if (/(?:^|\/)package\.json$/u.test(f.path)) {
      try {
        const p = JSON.parse(f.content) as Record<string, unknown>;
        if (typeof p.name === 'string') packageNames.add(p.name);
        if (p.imports || p.workspaces)
          g.issues.push({
            code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
            file: f.path,
            message: 'Package import maps/workspaces require a trusted resolver profile.',
          });
        for (const key of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ])
          if (p[key] && typeof p[key] === 'object' && !Array.isArray(p[key]))
            for (const [name, version] of Object.entries(p[key] as Record<string, unknown>)) {
              declared.add(name);
              if (typeof version === 'string' && /^(?:workspace:|file:|link:)/u.test(version))
                g.issues.push({
                  code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
                  file: f.path,
                  message: `Local package dependency ${JSON.stringify(name)} requires a trusted resolver profile.`,
                });
            }
      } catch {
        g.issues.push({
          code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
          file: f.path,
          message: 'Package resolver metadata is unreadable or malformed.',
        });
      }
    }
  const builtins = new Set(
    builtinModules.flatMap((name) => [
      name,
      name.replace(/^node:/u, ''),
      `node:${name.replace(/^node:/u, '')}`,
    ]),
  );
  const barePackage = (specifier: string): string =>
    specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]!;

  for (const f of files) {
    // Resolution rules are an explicit supported subset, never executed project config.
    if (unsupportedResolverConfig(f.path)) {
      g.issues.push({
        code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
        file: f.path,
        message:
          'Bundler/resolver configuration is outside the certified relative-file profile; no candidate configuration is executed.',
      });
    }
    if (/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.jsonc?$/u.test(f.path)) {
      const unsupported = unsupportedTypeScriptConfig(f);
      if (unsupported)
        g.issues.push({
          code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
          file: f.path,
          message: `${unsupported} requires a trusted resolver profile; dependency graph cannot be certified.`,
        });
    }

    if (!SOURCE_KINDS.has(f.classification)) continue;
    const edges = new Set<string>();
    g.edges.set(f.path, edges);
    try {
      for (const ref of imports(parse(f.content))) {
        if (!ref.value) {
          g.issues.push({
            code: 'DEPENDENCY_DYNAMIC_IMPORT',
            file: f.path,
            line: ref.line,
            message: 'Nonliteral module reference prevents complete static dependency analysis.',
          });
          continue;
        }
        const packageName = barePackage(ref.value);
        if (
          !ref.value.startsWith('.') &&
          !builtins.has(ref.value) &&
          (packageNames.has(packageName) || !declared.has(packageName))
        ) {
          g.issues.push({
            code: 'DEPENDENCY_RESOLUTION_UNSUPPORTED',
            file: f.path,
            line: ref.line,
            message: `Bare module ${JSON.stringify(ref.value)} is local/self-referential or undeclared; a trusted resolver profile is required.`,
          });
          continue;
        }
        const resolved = resolveImport(f.path, ref.value, paths);
        if (!resolved)
          g.issues.push({
            code: 'DEPENDENCY_UNRESOLVED',
            file: f.path,
            line: ref.line,
            message: `Cannot resolve module ${JSON.stringify(ref.value)} without executing project configuration.`,
          });
        else edges.add(resolved);
      }
    } catch (e) {
      g.issues.push({
        code: 'DEPENDENCY_PARSE_ERROR',
        file: f.path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return g;
}
function remapGraph(g: Graph, rename: Map<string, string>): Graph {
  const edges = new Map<string, Set<string>>();
  for (const [f, targets] of g.edges)
    edges.set(rename.get(f) ?? f, new Set([...targets].map((t) => rename.get(t) ?? t)));
  return { edges, issues: g.issues };
}
/** Iterative Kosaraju avoids recursive DFS stack overflow on large repository graphs. */
function cyclicEdges(g: Graph): Set<string> {
  const visited = new Set<string>(),
    order: string[] = [];
  const reverse = new Map<string, Set<string>>();
  for (const [f, targets] of g.edges) {
    if (!reverse.has(f)) reverse.set(f, new Set());
    for (const t of targets)
      if (g.edges.has(t)) {
        const bucket = reverse.get(t) ?? new Set<string>();
        bucket.add(f);
        reverse.set(t, bucket);
      }
  }
  for (const start of g.edges.keys()) {
    if (visited.has(start)) continue;
    const stack: [string, boolean][] = [[start, false]];
    while (stack.length) {
      const [f, done] = stack.pop()!;
      if (done) {
        order.push(f);
        continue;
      }
      if (visited.has(f)) continue;
      visited.add(f);
      stack.push([f, true]);
      for (const t of g.edges.get(f) ?? [])
        if (g.edges.has(t) && !visited.has(t)) stack.push([t, false]);
    }
  }
  const component = new Map<string, number>();
  const sizes = new Map<number, number>();
  let id = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i]!;
    if (component.has(start)) continue;
    const stack = [start];
    let size = 0;
    while (stack.length) {
      const f = stack.pop()!;
      if (component.has(f)) continue;
      component.set(f, id);
      size++;
      for (const t of reverse.get(f) ?? []) if (!component.has(t)) stack.push(t);
    }
    sizes.set(id, size);
    id++;
  }
  const cyclic = new Set<string>();
  for (const [f, targets] of g.edges)
    for (const t of targets) {
      const c = component.get(f);
      if (c !== undefined && component.get(t) === c && ((sizes.get(c) ?? 0) > 1 || f === t))
        cyclic.add(`${f}\0${t}`);
    }
  return cyclic;
}
function matching(path: string, pattern: string): boolean {
  return minimatch(path, pattern, { dot: true, nonegate: true });
}
/** G3 uses a pinned static parser graph. No tsconfig/plugin/bundler code is executed. */
export async function evaluateDependencies(
  base: SourceFile[],
  candidate: SourceFile[],
  snapshot: Snapshot,
  policy: Policy,
): Promise<GateResult> {
  const result = gateResult('deps', policy);
  const rename = new Map(
    snapshot.files
      .filter((c) => c.status.startsWith('R') && c.oldPath && c.newPath)
      .map((c) => [c.oldPath!, c.newPath!]),
  );
  const before = remapGraph(graph(base), rename),
    after = graph(candidate);
  result.issues.push(...after.issues);
  // Incomplete B cannot safely establish that a C cycle or forbidden edge is old debt.
  result.issues.push(...before.issues.map((i) => ({ ...i, code: `BASE_${i.code}` })));
  const oldCycles = cyclicEdges(before),
    newCycles = cyclicEdges(after);
  const excluded = new Set(
    candidate.filter((f) => f.classification === 'excluded').map((f) => f.path),
  );
  const byPath = new Map(candidate.map((f) => [f.path, f]));
  for (const edge of [...newCycles].sort())
    if (!oldCycles.has(edge)) {
      const [from, to] = edge.split('\0') as [string, string];
      result.violations.push({
        unit: `${from}::import(${to})`,
        file: from,
        line: 1,
        reason: 'NEW_DEPENDENCY_CYCLE',
      });
    }
  for (const [from, targets] of after.edges)
    for (const to of targets) {
      if (before.edges.get(from)?.has(to)) continue;
      if (
        excluded.has(to) ||
        (byPath.get(from)?.classification === 'source' && byPath.get(to)?.classification === 'test')
      )
        result.violations.push({
          unit: `${from}::import(${to})`,
          file: from,
          line: 1,
          reason: 'EXCLUDED_CODE_DEPENDENCY',
        });
      if (byPath.get(to)?.classification === 'unmeasured')
        result.triggers.push({
          id: 'S11',
          file: from,
          evidence: `New dependency on unmeasured code: ${to}`,
        });
      for (const rule of policy.dependencies.forbidden)
        if (matching(from, rule.from) && matching(to, rule.to))
          result.violations.push({
            unit: `${from}::import(${to})`,
            file: from,
            line: 1,
            reason: 'NEW_FORBIDDEN_DEPENDENCY',
          });
    }
  const incoming = new Map<string, Set<string>>();
  for (const [f, targets] of after.edges)
    for (const t of targets)
      if (after.edges.has(t)) {
        const bucket = incoming.get(t) ?? new Set<string>();
        bucket.add(f);
        incoming.set(t, bucket);
      }
  const modulesByImporter = new Map<string, string[]>();
  for (const file of after.edges.keys())
    if (!before.edges.has(file)) {
      const users = incoming.get(file);
      if (users?.size === 1) {
        const importer = [...users][0]!;
        const bucket = modulesByImporter.get(importer) ?? [];
        bucket.push(file);
        modulesByImporter.set(importer, bucket);
      }
    }
  for (const [importer, modules] of modulesByImporter)
    if (modules.length >= 2)
      result.triggers.push({
        id: 'S3',
        file: importer,
        evidence: `${modules.length} new modules have only this importer: ${modules.sort().join(', ')}`,
      });
  for (const c of snapshot.files)
    if (c.after && after.edges.has(c.after.path)) {
      const prior = before.edges.get(c.after.path)?.size ?? 0;
      const now = after.edges.get(c.after.path)?.size ?? 0;
      if (now - prior >= 5)
        result.triggers.push({
          id: 'S3',
          file: c.after.path,
          evidence: `Efferent imports increased ${prior} → ${now}.`,
        });
    }
  result.observe = {
    resolver:
      'trusted static @typescript-eslint AST; relative module resolution; bare imports external',
    base_edges: [...before.edges].reduce((n, [, v]) => n + v.size, 0),
    candidate_edges: [...after.edges].reduce((n, [, v]) => n + v.size, 0),
    existing_cyclic_edges: oldCycles.size,
  };
  if (
    !snapshot.files.some(
      (c) =>
        (c.after && SOURCE_KINDS.has(c.after.classification)) ||
        (c.before && SOURCE_KINDS.has(c.before.classification)),
    ) &&
    !result.issues.length
  )
    result.state = 'NOT_APPLICABLE';
  return settle(result);
}
