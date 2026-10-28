import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStructure, evaluateDependencies } from '../dist/structure.js';

const policy = {
  schema_version: 1,
  revision: 'test',
  phase: 'P2',
  gates: Object.fromEntries(
    [
      'complexity',
      'lint-structure',
      'deps',
      'tests',
      'coverage',
      'simplification-review',
      'mutation',
    ].map((g) => [g, 'enforce']),
  ),
  measurement: {
    binary: '/unused',
    sha256: '0'.repeat(64),
    version: 'cccc 1.8.5',
    timeout_ms: 1000,
    jobs: 1,
    max_file_bytes: 2_000_000,
    jsx_in_js: true,
  },
  scope: {
    source_extensions: ['.ts', '.tsx', '.js', '.jsx'],
    unmeasured_extensions: ['.vue'],
    non_code_extensions: ['.json', '.md'],
    test_globs: ['**/*.test.ts'],
    exclude_globs: [],
    protected_globs: [],
  },
  limits: {
    cognitive: 15,
    max_params: 4,
    max_callbacks: 3,
    max_function_lines: 60,
    coverage_uncovered: 2,
    coverage_fraction: 0.1,
  },
  dependencies: { forbidden: [] },
  identities: {
    simplification_reviewers: [],
    waiver_approvers: [],
    gate_owners: [],
    bots: [],
  },
  coverage: { provider: 'v8', version: '4' },
  waiver: { max_per_pr: 3, max_days: 90 },
};
const file = (path, content, classification = 'source') => ({
  path,
  content,
  classification,
  mode: '100644',
  blob_sha: 'a'.repeat(40),
});
const fn = (name, line = 1, children = []) => ({
  name,
  kind: 'function',
  line,
  cognitive: 0,
  cyclomatic: 1,
  children,
});
const metric = (path, functions = [], cognitive = 0, cyclomatic = functions.length) => ({
  path,
  functions,
  cognitive,
  cyclomatic,
  parse_errors: [],
});
function setup(before, after, bf = [], cf = []) {
  const change = {
    status: before ? 'M' : 'A',
    oldPath: before?.path,
    newPath: after?.path,
    before,
    after,
    hunks: [
      {
        oldStart: 1,
        oldCount: before?.content.split('\n').length ?? 0,
        newStart: 1,
        newCount: after?.content.split('\n').length ?? 0,
      },
    ],
    lineMap: new Map(),
  };
  return [
    {
      base_sha: 'b'.repeat(40),
      candidate_sha: 'c'.repeat(40),
      files: [change],
      manifest: [],
      issues: [],
    },
    {
      base: before ? { [before.path]: metric(before.path, bf) } : {},
      candidate: after ? { [after.path]: metric(after.path, cf) } : {},
      fingerprint: {},
      issues: [],
    },
  ];
}

test('trusted lint never honors existing inline disable for added dynamic code', async () => {
  const [snapshot, m] = setup(
    file('src/a.ts', '/* eslint-disable */\nexport const value=1;'),
    file('src/a.ts', '/* eslint-disable */\nexport const value=new Function("return 1");'),
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'DYNAMIC_CODE'));
});

test('constructor chains, vm, aliased Function, Reflect.construct and nonliteral import are blocked', async () => {
  for (const content of [
    'Object.constructor.constructor("return 1")();',
    'const F=Function; F("return 1")();',
    'Reflect.construct(Function,["return 1"]);',
    'import vm from "node:vm";',
    'const p="data:text/javascript,1"; import(p);',
  ]) {
    const [snapshot, m] = setup(undefined, file('src/a.ts', content));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.equal(result.state, 'FAIL', content);
    assert.ok(
      result.violations.some((v) => v.reason === 'DYNAMIC_CODE'),
      content,
    );
  }
});

test('adding fifth parameter on another line is a new matched-unit violation', async () => {
  const b = 'export function f(a,b,c,d) { return a; }';
  const c = 'export function f(\n a,b,c,d,e\n) { return a; }';
  const [snapshot, m] = setup(file('src/a.ts', b), file('src/a.ts', c), [fn('f')], [fn('f')]);
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'MAX_PARAMS'));
});

test('existing parameter debt is not reported again when matched and unchanged', async () => {
  const [snapshot, m] = setup(
    file('src/a.ts', 'export function f(a,b,c,d,e) { return a; }'),
    file('src/a.ts', 'export function f(a,b,c,d,e) { return b; }'),
    [fn('f')],
    [fn('f')],
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'PASS');
  assert.equal(result.violations.length, 0);
});

test('bidi controls and actual suppression comments fail; strings mentioning suppressions do not', async () => {
  for (const code of ['// @ts-ignore\nconst n=1;', '// hidden \u202e\nconst n=1;']) {
    const [snapshot, m] = setup(undefined, file('a.ts', code));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.equal(result.state, 'FAIL');
  }
  const [snapshot, m] = setup(
    undefined,
    file('a.ts', 'export const text="@ts-ignore eslint-disable";'),
  );
  assert.equal((await evaluateStructure(snapshot, m, policy)).state, 'PASS');
});

test('branch-hiding selectors route S9 rather than mechanically failing G2', async () => {
  for (const code of [
    'let x=true;x &&= compute();',
    'const x=[1,2][+flag];',
    '[flag].forEach(x=>work(x));',
    'const table={yes:()=>work()};',
  ]) {
    const [snapshot, m] = setup(undefined, file('a.ts', code));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.equal(result.state, 'PASS', code);
    assert.ok(
      result.triggers.some((t) => t.id === 'S9'),
      code,
    );
  }
});

test('declaration files cannot hide executable implementation', async () => {
  const [snapshot, m] = setup(
    undefined,
    file('a.d.ts', 'export function hidden() { return 1; }', 'excluded'),
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'DECLARATION_IMPLEMENTATION'));
});

test('new helper mutating context routes S10', async () => {
  const [snapshot, m] = setup(
    undefined,
    file('a.ts', 'export function apply(ctx) { ctx.value=1; }'),
    [],
    [fn('apply')],
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.ok(result.triggers.some((t) => t.id === 'S10'));
});

test('SFC and newly excluded changes route S11', async () => {
  for (const classification of ['unmeasured', 'excluded']) {
    const [snapshot, m] = setup(undefined, file('component.vue', '<template/>', classification));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.ok(result.triggers.some((t) => t.id === 'S11'));
  }
});

test('new dependency cycle fails and existing cycle remains accepted debt', async () => {
  const a = file('a.ts', 'import {b} from "./b.js"; export const a=1;');
  const b = file('b.ts', 'export const b=1;');
  const cyclic = file('b.ts', 'import {a} from "./a.js";export const b=a;');
  const [snapshot] = setup(b, cyclic);
  const result = await evaluateDependencies([a, b], [a, cyclic], snapshot, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'NEW_DEPENDENCY_CYCLE'));
  const existing = await evaluateDependencies([a, cyclic], [a, cyclic], snapshot, policy);
  assert.equal(existing.state, 'PASS');
});

test('new forbidden layer edges fail independently of complexity', async () => {
  const b = file('ui/a.ts', 'export const a=1;'),
    c = file('ui/a.ts', 'import {b} from "../storage/b.js";export const a=b;'),
    d = file('storage/b.ts', 'export const b=1;');
  const [snapshot] = setup(b, c);
  const result = await evaluateDependencies([b, d], [c, d], snapshot, {
    ...policy,
    dependencies: { forbidden: [{ from: 'ui/**', to: 'storage/**' }] },
  });
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'NEW_FORBIDDEN_DEPENDENCY'));
});

test('unresolved and dynamic module references fail closed', async () => {
  for (const code of ['import "./missing.js";', 'const key="x";require(key);']) {
    const c = file('a.ts', code);
    const [snapshot] = setup(undefined, c);
    const result = await evaluateDependencies([], [c], snapshot, policy);
    assert.equal(result.state, 'INCONCLUSIVE');
    assert.ok(result.issues.length);
  }
});

test('unsupported alias configuration is explicit INCONCLUSIVE', async () => {
  const c = file('src/a.ts', 'export const x=1;'),
    config = file('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}', 'non-code');
  const [snapshot] = setup(undefined, c);
  const result = await evaluateDependencies([], [c, config], snapshot, policy);
  assert.equal(result.state, 'INCONCLUSIVE');
  assert.ok(result.issues.some((i) => i.code === 'DEPENDENCY_RESOLUTION_UNSUPPORTED'));
});

test('new modules with a sole common importer route S3', async () => {
  const a = file('a.ts', 'import "./b.js";import "./c.js";');
  const b = file('b.ts', 'export const b=1;'),
    c = file('c.ts', 'export const c=1;');
  const [snapshot] = setup(undefined, a);
  const result = await evaluateDependencies([], [a, b, c], snapshot, policy);
  assert.equal(result.state, 'PASS');
  assert.ok(result.triggers.some((t) => t.id === 'S3'));
});

test('same-blob product source moved into test scope always routes S11', async () => {
  const b = file('src/complex.ts', 'export function calculate() { return 1; }');
  const c = {
    ...file('tests/complex.test.ts', b.content, 'test'),
    blob_sha: b.blob_sha,
  };
  const [snapshot, m] = setup(b, c, [fn('calculate')], [fn('calculate')]);
  snapshot.files[0].status = 'R';
  snapshot.files[0].hunks = [];
  snapshot.files[0].lineMap = new Map([[1, 1]]);
  const result = await evaluateStructure(snapshot, m, policy);
  assert.ok(result.triggers.some((t) => t.id === 'S11'));
});

test('different suppression directives cannot inherit an old exemption', async () => {
  const [snapshot, m] = setup(
    file('a.ts', '// eslint-disable\nexport const n=1;'),
    file('a.ts', '// @ts-nocheck\nexport const n=1;'),
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'SUPPRESSION_ADDED'));
});

test('new long function triggers S4', async () => {
  const code = `export function long() {\n${Array.from({ length: 65 }, (_, i) => ` console.log(${i});`).join('\n')}\n}`;
  const [snapshot, m] = setup(undefined, file('a.ts', code), [], [fn('long')]);
  const result = await evaluateStructure(snapshot, m, policy);
  assert.ok(result.triggers.some((t) => t.id === 'S4'));
});

test('branch drop with retained normalized code rows routes S9', async () => {
  const b = file(
    'a.ts',
    'export function f(x) { if (x) return 1; if (x.a) return 2; if (x.b) return 3; return 4; }',
  );
  const c = file(
    'a.ts',
    'export function f(x) { const a=x.a; const b=x.b; const c=x.c; const d=x.d; console.log(a,b,c,d); return a; }',
  );
  const [snapshot, m] = setup(b, c, [fn('f')], [fn('f')]);
  m.base['a.ts'].cyclomatic = 5;
  m.candidate['a.ts'].cyclomatic = 1;
  const result = await evaluateStructure(snapshot, m, policy);
  assert.ok(result.triggers.some((t) => t.id === 'S9'));
});

test('binding remains after named function disappears from measurement routes S11', async () => {
  const [snapshot, m] = setup(
    file('a.ts', 'export function f() { return 1; }'),
    file('a.ts', 'export const f=Object.constructor("return 1");'),
    [fn('f')],
    [],
  );
  const result = await evaluateStructure(snapshot, m, policy);
  assert.ok(result.triggers.some((t) => t.id === 'S11'));
});

test('bare self-import, undeclared aliases and workspace manifests are explicit resolver blockers', async () => {
  for (const [manifest, code] of [
    ['{"name":"my-library"}', 'import "my-library/internal";'],
    ['{"name":"app"}', 'import "@/internal";'],
    ['{"name":"app","workspaces":["packages/*"]}', 'export const a=1;'],
    ['{"dependencies":{"x":"file:../x"}}', 'export const a=1;'],
  ]) {
    const c = file('src/a.ts', code),
      p = file('package.json', manifest, 'non-code');
    const [snapshot] = setup(undefined, c);
    const result = await evaluateDependencies([], [c, p], snapshot, policy);
    assert.equal(result.state, 'INCONCLUSIVE');
    assert.ok(result.issues.some((i) => i.code === 'DEPENDENCY_RESOLUTION_UNSUPPORTED'));
  }
});

test('declared npm dependencies and node builtins are external edges', async () => {
  const c = file('src/a.ts', 'import {readFile} from "node:fs/promises";import {z} from "zod";');
  const p = file('package.json', '{"name":"app","dependencies":{"zod":"1.0.0"}}', 'non-code');
  const [snapshot] = setup(undefined, c);
  assert.equal((await evaluateDependencies([], [c, p], snapshot, policy)).state, 'PASS');
});

test('malformed or symlinked resolver metadata cannot silently become a complete graph', async () => {
  const c = file('a.ts', 'export const a=1;');
  for (const metadata of [
    file('package.json', '', 'unmeasured'),
    { ...file('tsconfig.json', '', 'unmeasured'), mode: '120000' },
  ]) {
    const [snapshot] = setup(undefined, c);
    const result = await evaluateDependencies([], [c, metadata], snapshot, policy);
    assert.equal(result.state, 'INCONCLUSIVE');
  }
});

test('importing newly excluded implementation fails structure boundary', async () => {
  const b = file('a.ts', 'export const a=1;'),
    c = file('a.ts', 'import {hidden} from "./generated/hidden.js";export const a=hidden;'),
    generated = file('generated/hidden.ts', 'export const hidden=1;', 'excluded');
  const [snapshot] = setup(b, c);
  const result = await evaluateDependencies([b, generated], [c, generated], snapshot, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'EXCLUDED_CODE_DEPENDENCY'));
});

test('global-object Function and eval aliases cannot evade dynamic-code lint', async () => {
  for (const code of [
    'const F=globalThis.Function;F("return 1");',
    'globalThis["Fun"+"ction"]("return 1");',
    'window.eval("1");',
  ]) {
    const [snapshot, m] = setup(undefined, file('a.ts', code));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.equal(result.state, 'FAIL');
    assert.ok(result.violations.some((v) => v.reason === 'DYNAMIC_CODE'));
  }
});

test('same-row class methods cannot transfer a max-params exemption', async () => {
  const b = file('a.ts', 'class A { old(a,b,c,d,e) {return a;} other(a,b,c,d) {return a;} }');
  const c = file('a.ts', 'class A { old(a,b,c,d) {return a;} other(a,b,c,d,e) {return a;} }');
  const bf = [
      { ...fn('old'), kind: 'method' },
      { ...fn('other'), kind: 'method' },
    ],
    cf = [
      { ...fn('old'), kind: 'method' },
      { ...fn('other'), kind: 'method' },
    ];
  const [snapshot, m] = setup(b, c, bf, cf);
  const result = await evaluateStructure(snapshot, m, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'MAX_PARAMS' && v.unit.includes('other')));
});

test('product imports cannot hide implementation under test-only complexity scope', async () => {
  const b = file('src/a.ts', 'export const a=1;'),
    c = file('src/a.ts', 'import {hidden} from "../tests/hidden.test.js";export const a=hidden;'),
    hidden = file('tests/hidden.test.ts', 'export const hidden=1;', 'test');
  const [snapshot] = setup(b, c);
  const result = await evaluateDependencies([b, hidden], [c, hidden], snapshot, policy);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.violations.some((v) => v.reason === 'EXCLUDED_CODE_DEPENDENCY'));
});

test('void this does not count as a parameter but nonvoid this does', async () => {
  for (const [thisType, expected] of [
    ['void', 'PASS'],
    ['object', 'FAIL'],
  ]) {
    const c = file('a.ts', `export function f(this:${thisType},a,b,c,d) {return a;}`);
    const [snapshot, m] = setup(undefined, c, [], [fn('f')]);
    assert.equal((await evaluateStructure(snapshot, m, policy)).state, expected);
  }
});

test('callback depth is blocked in product source and observed via test workflow for tests', async () => {
  const code = 'a(()=>b(()=>c(()=>d(()=>e(()=>1)))));';
  for (const [classification, expected] of [
    ['source', 'FAIL'],
    ['test', 'PASS'],
  ]) {
    const [snapshot, m] = setup(undefined, file('a.ts', code, classification));
    const result = await evaluateStructure(snapshot, m, policy);
    assert.equal(result.state, expected);
  }
});
