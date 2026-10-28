import * as parser from '@typescript-eslint/parser';
import { minimatch } from 'minimatch';
import { independent } from './evidence.js';
import {
  gateResult,
  type Evidence,
  type GateResult,
  type Policy,
  type Snapshot,
  type SourceFile,
  type TestReport,
} from './types.js';
type Node = Record<string, any>;
function walk(n: unknown, visit: (n: Node) => void): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, visit);
    return;
  }
  const o = n as Node;
  if (typeof o.type === 'string') visit(o);
  for (const [k, x] of Object.entries(o))
    if (!['parent', 'loc', 'range', 'tokens', 'comments'].includes(k)) walk(x, visit);
}
function ast(f: SourceFile): Node {
  return parser.parse(f.content, {
    loc: true,
    range: true,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  }) as unknown as Node;
}
function text(n: Node | undefined): string {
  if (!n) return '';
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'Literal') return String(n.value);
  if (n.type === 'MemberExpression') return text(n.object) + '.' + text(n.property);
  if (n.type === 'CallExpression') return text(n.callee);
  return '';
}
interface StaticTest {
  id: string;
  assertions: number;
  modifiers: string[];
  line: number;
  matchers: string[];
}
function tests(f: SourceFile): StaticTest[] {
  const output: StaticTest[] = [];
  const tree = ast(f);
  walk(tree, (n) => {
    if (n.type !== 'CallExpression') return;
    const name = text(n.callee);
    if (!/^(?:it|test)(?:\.|$)/.test(name)) return;
    const label = n.arguments?.[0];
    if (label?.type !== 'Literal' || typeof label.value !== 'string')
      throw new Error(`Unresolved dynamic/parameterized test ID in ${f.path}`);
    const callback = n.arguments.find(
      (x: Node) => x.type === 'ArrowFunctionExpression' || x.type === 'FunctionExpression',
    );
    let assertions = 0;
    const matchers: string[] = [];
    if (callback)
      walk(callback.body, (x) => {
        if (
          x.type === 'CallExpression' &&
          x.callee?.type === 'MemberExpression' &&
          text(x.callee.object).startsWith('expect') &&
          !['assertions', 'hasAssertions', 'extend'].includes(text(x.callee.property))
        ) {
          assertions++;
          matchers.push(text(x.callee.property));
        }
      });
    output.push({
      id: label.value,
      assertions,
      modifiers: name.split('.').slice(1),
      line: n.loc.start.line,
      matchers,
    });
  });
  return output;
}
function validReport(r: TestReport): boolean {
  if (!r || !Array.isArray(r.tests) || r.tests.length > 100000) return false;
  if (![r.total, r.passed, r.failed, r.skipped].every((x) => Number.isSafeInteger(x) && x >= 0))
    return false;
  if (r.total !== r.tests.length || r.total !== r.passed + r.failed + r.skipped) return false;
  if (r.tests.some((x) => !x || typeof x !== 'object')) return false;
  if (new Set(r.tests.map((x) => x.id)).size !== r.tests.length) return false;
  return (
    r.tests.every(
      (x) =>
        typeof x.id === 'string' &&
        x.id.length > 0 &&
        ['passed', 'failed', 'skipped', 'todo'].includes(x.status) &&
        Number.isSafeInteger(x.assertions) &&
        x.assertions >= 0,
    ) &&
    r.passed === r.tests.filter((x) => x.status === 'passed').length &&
    r.failed === r.tests.filter((x) => x.status === 'failed').length &&
    r.skipped === r.tests.filter((x) => x.status === 'skipped' || x.status === 'todo').length
  );
}
function fail(result: GateResult, reason: string, file: string, line = 1): void {
  result.violations.push({ unit: file, file, line, reason });
}
function applicable(s: Snapshot): boolean {
  return s.files.some(
    (x) =>
      [x.before, x.after].some(
        (f) => f && ['source', 'test', 'unmeasured'].includes(f.classification),
      ) || /\.(json|ya?ml|toml|snap)$/.test(x.newPath ?? x.oldPath ?? ''),
  );
}
export function evaluateTests(s: Snapshot, e: Evidence | undefined, p: Policy): GateResult {
  const r = gateResult('tests', p);
  const ai =
    !!e && p.identities.bots.some((x) => x.toLowerCase() === e.actors.author.toLowerCase());
  if (!applicable(s)) {
    r.state = 'NOT_APPLICABLE';
    r.reasons = ['NO_EXECUTABLE_OR_TEST_CHANGES'];
    return r;
  }
  for (const change of s.files) {
    const path = change.newPath ?? change.oldPath ?? '';
    if (p.scope.protected_globs.some((g) => minimatch(path, g, { dot: true }))) {
      const approved = e?.protected_change_approvals?.some(
        (a) =>
          a &&
          independent(a.actor, e, p, 'gate_owners') &&
          a.head_sha === e.candidate_sha &&
          Array.isArray(a.paths) &&
          a.paths.includes(path),
      );
      if (!approved || ai)
        fail(r, ai ? 'AI_FORBIDDEN_CHANGE' : 'PROTECTED_CONFIGURATION_CHANGED', path);
    }
    if (path.endsWith('.snap'))
      r.triggers.push({
        id: 'S7',
        file: path,
        evidence: 'Snapshot changed; independent behavior review required',
      });
    if (change.before?.classification !== 'test' && change.after?.classification !== 'test')
      continue;
    try {
      const b = change.before ? tests(change.before) : [],
        c = change.after ? tests(change.after) : [];
      const modifiers = (f: SourceFile | undefined) => {
        const found: string[] = [];
        if (f)
          walk(ast(f), (n) => {
            if (n.type === 'CallExpression') {
              const name = text(n.callee);
              if (
                (/^(?:describe|it|test)(?:\.|$)/.test(name) &&
                  /\.(?:only|skip|todo|fails)(?:\.|$)/.test(name)) ||
                /^(?:xit|xtest|xdescribe)$/.test(name)
              )
                found.push(name);
            }
          });
        return found;
      };
      const oldModifiers = modifiers(change.before);
      for (const name of modifiers(change.after)) {
        const i = oldModifiers.indexOf(name);
        if (i < 0) fail(r, 'TEST_DISABLED_OR_FOCUSED', path);
        else oldModifiers.splice(i, 1);
      }
      for (const t of c) {
        const old = b.find((x) => x.id === t.id);
        const forbidden = ['only', 'skip', 'todo', 'fails', 'concurrent.only'];
        if (t.modifiers.some((x) => forbidden.includes(x) && !old?.modifiers.includes(x)))
          fail(r, 'TEST_DISABLED_OR_FOCUSED', path, t.line);
        if (!old && t.assertions === 0) fail(r, 'ASSERTION_FREE_NEW_TEST', path, t.line);
        if (
          old &&
          (t.assertions < old.assertions ||
            (old.matchers.some((x) => ['toEqual', 'toStrictEqual', 'toBe'].includes(x)) &&
              t.matchers.some((x) => ['toBeDefined', 'toBeTruthy', 'toBeFalsy'].includes(x))))
        )
          r.triggers.push({
            id: 'S7',
            file: path,
            evidence: `Test ${t.id}: assertion count or matcher weakened`,
          });
      }
      for (const t of b)
        if (!c.some((x) => x.id === t.id)) {
          const approved = e?.protected_change_approvals?.some(
            (a) =>
              a &&
              independent(a.actor, e, p, 'gate_owners') &&
              a.head_sha === e.candidate_sha &&
              Array.isArray(a.paths) &&
              a.paths.includes(path),
          );
          if (!approved || ai) fail(r, ai ? 'AI_FORBIDDEN_CHANGE' : 'TEST_REMOVED', path, t.line);
        }
    } catch (error) {
      r.issues.push({ code: 'TEST_AST_UNRESOLVED', message: String(error), file: path });
    }
  }
  if (!e?.tests)
    r.issues.push({
      code: 'TEST_EVIDENCE_MISSING',
      message: 'A trusted signed baseline and candidate test run is required',
    });
  else if (!validReport(e.tests.base) || !validReport(e.tests.candidate))
    r.issues.push({
      code: 'TEST_REPORT_SCHEMA',
      message: 'Counts, statuses and unique IDs must agree',
    });
  else {
    const { base: b, candidate: c } = e.tests;
    r.observe.executed = c.passed + c.failed;
    r.observe.total = c.total;
    if (c.passed + c.failed === 0)
      r.issues.push({ code: 'ZERO_TESTS', message: 'No tests executed' });
    if (c.failed > 0) fail(r, 'TEST_FAILURE', '');
    const removed = b.tests.filter((x) => !c.tests.some((y) => y.id === x.id));
    const approved = e.protected_change_approvals?.some(
      (a) =>
        a &&
        independent(a.actor, e, p, 'gate_owners') &&
        a.head_sha === e.candidate_sha &&
        Array.isArray(a.paths) &&
        a.paths.includes('@test-ids'),
    );
    if (removed.length && (!approved || ai))
      fail(r, ai ? 'AI_FORBIDDEN_CHANGE' : 'TEST_IDS_REMOVED', '');
    for (const test of c.tests) {
      const old = b.tests.find((x) => x.id === test.id);
      if (['skipped', 'todo'].includes(test.status) && old?.status !== test.status)
        fail(r, 'TEST_DISABLED_OR_FOCUSED', test.id);
      if (!old && test.assertions === 0) fail(r, 'ASSERTION_FREE_NEW_TEST', test.id);
      if (old && test.assertions < old.assertions)
        r.triggers.push({
          id: 'S7',
          file: test.id,
          evidence: `Assertion count ${old.assertions} → ${test.assertions}`,
        });
    }
  }
  if (ai && r.triggers.some((x) => x.id === 'S7')) fail(r, 'AI_FORBIDDEN_CHANGE', '');
  if (
    ai &&
    s.files.some(
      (c) =>
        c.after &&
        ['unmeasured', 'excluded'].includes(c.after.classification) &&
        c.before?.classification === 'source',
    )
  )
    fail(r, 'AI_FORBIDDEN_CHANGE', '');
  r.state = r.violations.length ? 'FAIL' : r.issues.length ? 'INCONCLUSIVE' : 'PASS';
  r.reasons = [...new Set([...r.violations.map((x) => x.reason), ...r.issues.map((x) => x.code)])];
  return r;
}
function changed(line: number, change: Snapshot['files'][number]): boolean {
  return change.hunks.some(
    (h) => h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount,
  );
}
function touched(loc: Node, change: Snapshot['files'][number]): boolean {
  if (
    !loc ||
    !Number.isSafeInteger(loc.start?.line) ||
    !Number.isSafeInteger(loc.end?.line) ||
    loc.start.line < 1 ||
    loc.end.line < loc.start.line
  )
    throw new Error('Invalid Istanbul location');
  return change.hunks.some(
    (h) => h.newCount > 0 && loc.start.line < h.newStart + h.newCount && loc.end.line >= h.newStart,
  );
}
export function evaluateCoverage(s: Snapshot, e: Evidence | undefined, p: Policy): GateResult {
  const r = gateResult('coverage', p);
  const files = s.files.filter(
    (x) => x.after?.classification === 'source' && x.hunks.some((h) => h.newCount > 0),
  );
  if (!files.length) {
    r.state = 'NOT_APPLICABLE';
    r.reasons = ['NO_CHANGED_EXECUTABLE_SOURCE'];
    return r;
  }
  if (!e?.coverage) {
    r.state = 'INCONCLUSIVE';
    r.reasons = ['COVERAGE_MISSING'];
    return r;
  }
  if (e.coverage.provider !== p.coverage.provider || e.coverage.version !== p.coverage.version) {
    r.state = 'INCONCLUSIVE';
    r.reasons = ['COVERAGE_PROVIDER_MISMATCH'];
    return r;
  }
  let outcomes = 0,
    uncovered = 0,
    uncoveredLines = 0,
    zeroFunctions = 0;
  for (const change of files) {
    const file = change.after!;
    const data = e.coverage.files?.[file.path] as Node | undefined;
    if (!data) {
      r.issues.push({
        code: 'COVERAGE_FILE_MISSING',
        message: 'Changed source absent from coverage include',
        file: file.path,
      });
      continue;
    }
    try {
      for (const key of ['branchMap', 'b', 'statementMap', 's', 'fnMap', 'f'])
        if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))
          throw new Error(`Missing Istanbul ${key}`);
      if (
        Object.keys(data.branchMap).length === 0 &&
        Object.keys(data.statementMap).length === 0 &&
        Object.keys(data.fnMap).length === 0
      ) {
        const tree = ast(file);
        let executable = false;
        walk(tree, (n) => {
          if (
            [
              'FunctionDeclaration',
              'FunctionExpression',
              'ArrowFunctionExpression',
              'CallExpression',
              'AssignmentExpression',
              'IfStatement',
              'ForStatement',
              'WhileStatement',
              'ThrowStatement',
              'VariableDeclarator',
            ].includes(n.type) &&
            !(n.type === 'VariableDeclarator' && !n.init)
          )
            executable = true;
        });
        if (executable) throw new Error('Empty coverage maps for executable source');
      }
      if (
        Object.keys(data.branchMap).sort().join('\0') !== Object.keys(data.b).sort().join('\0') ||
        Object.keys(data.statementMap).sort().join('\0') !==
          Object.keys(data.s).sort().join('\0') ||
        Object.keys(data.fnMap).sort().join('\0') !== Object.keys(data.f).sort().join('\0')
      )
        throw new Error('Istanbul map/counter keys disagree');
      for (const [id, b] of Object.entries(data.branchMap) as [string, Node][]) {
        const counts = data.b[id];
        if (
          !Array.isArray(b.locations) ||
          !b.locations.length ||
          !Array.isArray(counts) ||
          counts.length !== b.locations.length ||
          !counts.every((x) => Number.isSafeInteger(x) && x >= 0)
        )
          throw new Error('Invalid branch counters');
        for (let i = 0; i < counts.length; i++)
          if (touched(b.locations[i], change) || touched(b.loc, change)) {
            outcomes++;
            if (counts[i] === 0) uncovered++;
          }
      }
      for (const [id, loc] of Object.entries(data.statementMap) as [string, Node][]) {
        if (!Number.isSafeInteger(data.s[id]) || data.s[id] < 0)
          throw new Error('Invalid statement count');
        if (touched(loc, change) && data.s[id] === 0) uncoveredLines++;
      }
      for (const [id, fn] of Object.entries(data.fnMap) as [string, Node][]) {
        if (!Number.isSafeInteger(data.f[id]) || data.f[id] < 0)
          throw new Error('Invalid function count');
        if (touched(fn.loc, change) && data.f[id] === 0) {
          zeroFunctions++;
          fail(r, 'CHANGED_FUNCTION_UNEXECUTED', file.path, fn.loc.start.line);
        }
      }
    } catch (error) {
      r.issues.push({ code: 'COVERAGE_SCHEMA', message: String(error), file: file.path });
    }
  }
  const budget = Math.max(
    p.limits.coverage_uncovered,
    Math.floor(outcomes * p.limits.coverage_fraction),
  );
  if (uncovered > budget) fail(r, 'UNCOVERED_CHANGED_BRANCHES', '');
  r.observe = {
    changed_branch_outcomes: outcomes,
    uncovered_branch_outcomes: uncovered,
    uncovered_changed_statements: uncoveredLines,
    unexecuted_changed_functions: zeroFunctions,
    uncovered_budget: budget,
  };
  r.state = r.violations.length
    ? 'FAIL'
    : r.issues.length
      ? 'INCONCLUSIVE'
      : outcomes === 0 && uncoveredLines === 0 && zeroFunctions === 0
        ? 'NOT_APPLICABLE'
        : 'PASS';
  r.reasons = [...new Set([...r.violations.map((x) => x.reason), ...r.issues.map((x) => x.code)])];
  return r;
}
export function evaluateMutation(s: Snapshot, e: Evidence | undefined, p: Policy): GateResult {
  const r = gateResult('mutation', p);
  if (!s.files.some((x) => x.after?.classification === 'source')) {
    r.state = 'NOT_APPLICABLE';
    return r;
  }
  const m = e?.mutation;
  if (
    !m ||
    ![m.killed, m.survived, m.timeout, m.no_coverage].every(
      (x) => Number.isSafeInteger(x) && x >= 0,
    ) ||
    m.killed + m.survived + m.timeout + m.no_coverage === 0
  ) {
    r.state = 'INCONCLUSIVE';
    r.reasons = ['MUTATION_EVIDENCE_MISSING_OR_EMPTY'];
    return r;
  }
  r.observe = { ...m };
  return r;
}
