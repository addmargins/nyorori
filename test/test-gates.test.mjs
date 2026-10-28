import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTests, evaluateCoverage, evaluateMutation } from '../dist/test-gates.js';
import { applyWaivers } from '../dist/evidence.js';

const HEAD = 'c'.repeat(40);
const BLOB = 'b'.repeat(40);
function policy() {
  return {
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
    scope: { protected_globs: ['vitest.config.ts', '.github/**'] },
    identities: {
      bots: ['quality-bot'],
      gate_owners: ['gate-owner'],
      waiver_approvers: ['reviewer'],
      simplification_reviewers: ['reviewer'],
    },
    coverage: { provider: 'istanbul', version: '1.0.0' },
    limits: { coverage_uncovered: 2, coverage_fraction: 0.1 },
    waiver: { max_per_pr: 2, max_days: 90 },
  };
}
function source(path, content, classification = 'source') {
  return { path, content, classification, mode: '100644', blob_sha: BLOB };
}
function snapshot(before, after, path = 'src/a.ts', classification = 'source') {
  const b = before === undefined ? undefined : source(path, before, classification);
  const c = after === undefined ? undefined : source(path, after, classification);
  return {
    base_sha: 'a'.repeat(40),
    candidate_sha: HEAD,
    manifest: [],
    issues: [],
    files: [
      {
        status: b && c ? 'M' : c ? 'A' : 'D',
        oldPath: b?.path,
        newPath: c?.path,
        before: b,
        after: c,
        hunks: [
          {
            oldStart: 1,
            oldCount: b ? b.content.split('\n').length : 0,
            newStart: 1,
            newCount: c ? c.content.split('\n').length : 0,
          },
        ],
        lineMap: new Map(),
      },
    ],
  };
}
function report(status = 'passed', assertions = 1) {
  return {
    total: 1,
    passed: status === 'passed' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    skipped: status === 'skipped' || status === 'todo' ? 1 : 0,
    tests: [{ id: 'works', status, assertions }],
  };
}
function evidence(changes = {}) {
  return {
    candidate_sha: HEAD,
    actors: { author: 'author', participants: ['author'], agent_initiators: [] },
    tests: { base: report(), candidate: report() },
    ...changes,
  };
}
const baseTest = "test('works', () => { expect(1).toEqual(1); });\n";
const app = snapshot('export const a = 1;', 'export const a = 2;');

test('G4 requires real executed tests and coherent counts/statuses', async (t) => {
  await t.test('failed test blocks even when the rest passes', () => {
    const r = evaluateTests(
      app,
      evidence({ tests: { base: report(), candidate: report('failed') } }),
      policy(),
    );
    assert.equal(r.state, 'FAIL');
    assert.ok(r.reasons.includes('TEST_FAILURE'));
  });
  await t.test('zero executed tests and a deleted baseline test report both problems', () => {
    const empty = { total: 0, passed: 0, failed: 0, skipped: 0, tests: [] };
    const r = evaluateTests(
      app,
      evidence({ tests: { base: report(), candidate: empty } }),
      policy(),
    );
    assert.equal(r.state, 'FAIL'); // Removing the existing baseline test is a known violation too.
    assert.ok(r.reasons.includes('ZERO_TESTS'));
    assert.ok(r.reasons.includes('TEST_IDS_REMOVED'));
  });
  for (const bad of [
    { ...report(), total: 2 },
    { ...report(), passed: 0, failed: 1 },
    { ...report(), tests: [{ id: 'works', status: 'passed', assertions: -1 }] },
    { total: 2, passed: 2, failed: 0, skipped: 0, tests: [report().tests[0], report().tests[0]] },
  ])
    await t.test('malformed report does not pass', () => {
      const r = evaluateTests(
        app,
        evidence({ tests: { base: report(), candidate: bad } }),
        policy(),
      );
      assert.equal(r.state, 'INCONCLUSIVE');
      assert.ok(r.reasons.includes('TEST_REPORT_SCHEMA'));
    });
  await t.test('null nested test entry is inconclusive rather than an exception', () => {
    let r;
    assert.doesNotThrow(() => {
      r = evaluateTests(
        app,
        evidence({ tests: { base: report(), candidate: { ...report(), tests: [null] } } }),
        policy(),
      );
    });
    assert.equal(r.state, 'INCONCLUSIVE');
    assert.ok(r.reasons.includes('TEST_REPORT_SCHEMA'));
  });
});

test('G4 rejects focused/skipped suites and assertion-free new tests statically', async (t) => {
  const cases = [
    ['describe.only', `describe.only('suite', () => { ${baseTest} });`],
    ['describe.skip', `describe.skip('suite', () => { ${baseTest} });`],
    ['test.only', "test.only('works', () => { expect(1).toEqual(1); });"],
    ['test.skip', "test.skip('works', () => { expect(1).toEqual(1); });"],
    ['test.todo', "test.todo('works');"],
    ['xit', "xit('works', () => { expect(1).toEqual(1); });"],
  ];
  for (const [name, candidate] of cases)
    await t.test(name, () => {
      const r = evaluateTests(
        snapshot(baseTest, candidate, 'test/a.test.ts', 'test'),
        evidence(),
        policy(),
      );
      assert.equal(r.state, 'FAIL');
      assert.ok(r.reasons.includes('TEST_DISABLED_OR_FOCUSED'));
    });
  for (const body of ['', 'expect.assertions(1);', 'expect.hasAssertions();'])
    await t.test(`new test without matcher: ${body}`, () => {
      const r = evaluateTests(
        snapshot(undefined, `test('new', () => { ${body} });`, 'test/a.test.ts', 'test'),
        evidence(),
        policy(),
      );
      assert.equal(r.state, 'FAIL');
      assert.ok(r.reasons.includes('ASSERTION_FREE_NEW_TEST'));
    });
});

test('G4 routes human assertion weakening but forbids it for an AI repair bot', () => {
  const s = snapshot(
    baseTest,
    "test('works', () => { expect(1).toBeDefined(); });",
    'test/a.test.ts',
    'test',
  );
  const human = evaluateTests(s, evidence(), policy());
  assert.equal(human.state, 'PASS');
  assert.ok(human.triggers.some((x) => x.id === 'S7'));
  const bot = evaluateTests(
    s,
    evidence({ actors: { author: 'QUALITY-BOT', participants: [], agent_initiators: [] } }),
    policy(),
  );
  assert.equal(bot.state, 'FAIL');
  assert.ok(bot.reasons.includes('AI_FORBIDDEN_CHANGE'));
});

test('G4 test removal needs exact independent approval and bots cannot use it', () => {
  const s = snapshot(baseTest, '', 'test/a.test.ts', 'test');
  const approval = { actor: 'gate-owner', head_sha: HEAD, paths: ['test/a.test.ts'] };
  assert.equal(evaluateTests(s, evidence(), policy()).state, 'FAIL');
  assert.equal(
    evaluateTests(s, evidence({ protected_change_approvals: [approval] }), policy()).state,
    'PASS',
  );
  const bot = evidence({
    actors: { author: 'quality-bot', participants: [], agent_initiators: [] },
    protected_change_approvals: [approval],
  });
  assert.equal(evaluateTests(s, bot, policy()).state, 'FAIL');
  const stale = evaluateTests(
    s,
    evidence({ protected_change_approvals: [{ ...approval, head_sha: 'd'.repeat(40) }] }),
    policy(),
  );
  assert.equal(stale.state, 'FAIL');
});

test('G4 protected configuration approval is independent and scoped', () => {
  const s = snapshot(
    'export default {};',
    'export default { coverage: false };',
    'vitest.config.ts',
  );
  const approval = { actor: 'gate-owner', head_sha: HEAD, paths: ['vitest.config.ts'] };
  assert.equal(evaluateTests(s, evidence(), policy()).state, 'FAIL');
  assert.equal(
    evaluateTests(s, evidence({ protected_change_approvals: [approval] }), policy()).state,
    'PASS',
  );
  const self = evidence({
    actors: { author: 'gate-owner', participants: [], agent_initiators: [] },
    protected_change_approvals: [approval],
  });
  assert.equal(evaluateTests(s, self, policy()).state, 'FAIL');
  const bot = evidence({
    actors: { author: 'quality-bot', participants: [], agent_initiators: [] },
    protected_change_approvals: [approval],
  });
  assert.equal(evaluateTests(s, bot, policy()).state, 'FAIL');
});

test('G4 cannot silently evaluate unresolved dynamic test IDs', () => {
  const r = evaluateTests(
    snapshot(undefined, 'test(getName(), () => { expect(1).toBe(1); });', 'test/a.test.ts', 'test'),
    evidence(),
    policy(),
  );
  assert.equal(r.state, 'INCONCLUSIVE');
  assert.ok(r.reasons.includes('TEST_AST_UNRESOLVED'));
});

test('G4 preexisting xit is not a newly disabled test after an unrelated edit', () => {
  const before = "xit('legacy skipped', () => { expect(1).toBe(1); });\n";
  const r = evaluateTests(
    snapshot(before, before + '// unrelated documentation\n', 'test/a.test.ts', 'test'),
    evidence(),
    policy(),
  );
  assert.equal(r.state, 'PASS');
  assert.ok(!r.reasons.includes('TEST_DISABLED_OR_FOCUSED'));
});

function loc(start = 1, end = 3) {
  return { start: { line: start, column: 0 }, end: { line: end, column: 1 } };
}
function coverage(counts = [1, 1, 1, 1]) {
  return {
    branchMap: { 0: { type: 'if', line: 1, loc: loc(), locations: counts.map(() => loc()) } },
    b: { 0: counts },
    statementMap: { 0: loc() },
    s: { 0: 1 },
    fnMap: { 0: { name: 'f', decl: loc(1, 1), loc: loc() } },
    f: { 0: 1 },
  };
}
function covered(data, extra = {}) {
  return evidence({
    coverage: { provider: 'istanbul', version: '1.0.0', files: { 'src/a.ts': data }, ...extra },
  });
}

test('G5 applies absolute uncovered branch budget at its exact boundary', () => {
  const within = evaluateCoverage(app, covered(coverage([0, 0, 1, 1])), policy());
  assert.equal(within.state, 'PASS');
  assert.equal(within.observe.uncovered_branch_outcomes, 2);
  const over = evaluateCoverage(app, covered(coverage([0, 0, 0, 1])), policy());
  assert.equal(over.state, 'FAIL');
  assert.ok(over.reasons.includes('UNCOVERED_CHANGED_BRANCHES'));
  assert.equal(over.observe.changed_branch_outcomes, 4);
  assert.equal(over.observe.uncovered_budget, 2);
});

test('G5 scales branch allowance by count rather than repository-wide percentage', () => {
  const p = policy();
  p.limits.coverage_fraction = 0.25;
  const within = evaluateCoverage(app, covered(coverage([0, 0, 0, ...Array(9).fill(1)])), p);
  assert.equal(within.state, 'PASS');
  assert.equal(within.observe.uncovered_budget, 3);
  const over = evaluateCoverage(app, covered(coverage([0, 0, 0, 0, ...Array(8).fill(1)])), p);
  assert.equal(over.state, 'FAIL');
});

test('G5 missing files/provider or malformed maps are inconclusive', async (t) => {
  for (const [name, e, reason] of [
    ['no report', evidence(), 'COVERAGE_MISSING'],
    ['provider mismatch', covered(coverage(), { provider: 'other' }), 'COVERAGE_PROVIDER_MISMATCH'],
    ['missing changed file', covered(undefined), 'COVERAGE_FILE_MISSING'],
    ['negative count', covered(coverage([-1, 1])), 'COVERAGE_SCHEMA'],
    [
      'inconsistent branch outcome count',
      covered({ ...coverage(), b: { 0: [1] } }),
      'COVERAGE_SCHEMA',
    ],
    ['inconsistent map keys', covered({ ...coverage(), s: { 1: 1 } }), 'COVERAGE_SCHEMA'],
  ])
    await t.test(name, () => {
      const r = evaluateCoverage(app, e, policy());
      assert.equal(r.state, 'INCONCLUSIVE');
      assert.ok(r.reasons.includes(reason));
    });
});

test('G5 all-empty maps cannot hide executable source', () => {
  const empty = { branchMap: {}, b: {}, statementMap: {}, s: {}, fnMap: {}, f: {} };
  const executable = evaluateCoverage(app, covered(empty), policy());
  assert.equal(executable.state, 'INCONCLUSIVE');
  assert.ok(executable.reasons.includes('COVERAGE_SCHEMA'));
  const declaration = snapshot('export type A = string;', 'export type A = number;');
  assert.equal(evaluateCoverage(declaration, covered(empty), policy()).state, 'NOT_APPLICABLE');
});

test('G5 an unexecuted changed function fails even within branch budget', () => {
  const data = coverage([1, 1]);
  data.f[0] = 0;
  const r = evaluateCoverage(app, covered(data), policy());
  assert.equal(r.state, 'FAIL');
  assert.ok(r.reasons.includes('CHANGED_FUNCTION_UNEXECUTED'));
});

test('G7 remains an explicit observation when mutation evidence is missing or empty', () => {
  const p = policy();
  p.gates.mutation = 'observe';
  assert.equal(evaluateMutation(app, evidence(), p).state, 'INCONCLUSIVE');
  assert.equal(
    evaluateMutation(
      app,
      evidence({ mutation: { killed: 0, survived: 0, timeout: 0, no_coverage: 0 } }),
      p,
    ).state,
    'INCONCLUSIVE',
  );
  const r = evaluateMutation(
    app,
    evidence({ mutation: { killed: 2, survived: 1, timeout: 0, no_coverage: 0 } }),
    p,
  );
  assert.equal(r.state, 'PASS');
  assert.equal(r.mode, 'observe');
  assert.equal(r.observe.survived, 1);
});

function complexityFailure() {
  return {
    gate: 'complexity',
    state: 'FAIL',
    mode: 'enforce',
    reasons: ['OVER_LIMIT_NEW'],
    violations: [
      {
        unit: 'src/a.ts::f#function[0]',
        file: 'src/a.ts',
        line: 1,
        reason: 'OVER_LIMIT_NEW',
        metric: 'cognitive',
        after: 20,
        limit: 15,
        blob_sha: BLOB,
      },
      {
        unit: 'src/a.ts::g#function[0]',
        file: 'src/a.ts',
        line: 5,
        reason: 'OVER_LIMIT_NEW',
        metric: 'cognitive',
        after: 21,
        limit: 15,
        blob_sha: BLOB,
      },
    ],
    triggers: [],
    issues: [],
    observe: {},
  };
}
function waiver(unit, changes = {}) {
  return {
    id: unit,
    actor: 'reviewer',
    head_sha: HEAD,
    unit,
    blob_sha: BLOB,
    gate: 'complexity',
    metric: 'cognitive',
    ceiling: 22,
    reason: 'Explicit dispatcher tradeoff',
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    ...changes,
  };
}

test('waivers require exact blob/ceiling and must cover every independent failure', () => {
  const partial = complexityFailure();
  applyWaivers(partial, evidence({ waivers: [waiver(partial.violations[0].unit)] }), policy());
  assert.equal(partial.state, 'FAIL');
  assert.equal(partial.violations.length, 1);
  assert.match(partial.violations[0].unit, /::g#/);
  const complete = complexityFailure();
  applyWaivers(
    complete,
    evidence({ waivers: complete.violations.map((v) => waiver(v.unit)) }),
    policy(),
  );
  assert.equal(complete.state, 'ACCEPTED_WITH_WAIVER');
  assert.equal(complete.violations.length, 0);
  assert.equal(complete.waivers_applied.length, 2);
  for (const change of [
    { blob_sha: 'd'.repeat(40) },
    { ceiling: 19 },
    { expires_at: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const r = complexityFailure();
    applyWaivers(r, evidence({ waivers: [waiver(r.violations[0].unit, change)] }), policy());
    assert.equal(r.state, 'FAIL');
    assert.equal(r.violations.length, 2);
  }
});
