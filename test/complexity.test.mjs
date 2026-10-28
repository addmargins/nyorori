import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateComplexity, matchUnits, changedUnits, unitKey } from '../dist/complexity.js';

const policy = {
  revision: 'policy-test',
  gates: { complexity: 'enforce' },
  measurement: { sha256: 'a'.repeat(64), version: 'cccc 1.8.5' },
  limits: { cognitive: 15 },
};
const fingerprint = {
  cccc_sha256: 'a'.repeat(64),
  cccc_version: 'cccc 1.8.5',
  policy_revision: 'policy-test',
};
const fn = (name, cognitive, line = 1, children = [], cyclomatic = Math.max(1, cognitive + 1)) => ({
  name,
  kind: 'function',
  line,
  cognitive,
  cyclomatic,
  children,
});
const all = (functions) => functions.flatMap((unit) => [unit, ...all(unit.children)]);
function measured(path, functions, residue = 0, parse_errors = []) {
  return {
    path,
    functions,
    cognitive: all(functions).reduce((sum, unit) => sum + unit.cognitive, 0) + residue,
    cyclomatic: all(functions).reduce((sum, unit) => sum + unit.cyclomatic, 0),
    parse_errors,
  };
}
function source(path, classification = 'source', lines = 40) {
  return {
    path,
    classification,
    blob_sha: 'b'.repeat(40),
    mode: '100644',
    content: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n'),
  };
}
function fixture(before, after, options = {}) {
  const oldPath = before?.path,
    newPath = after?.path;
  const beforeSource = before
    ? source(oldPath, options.classification, options.beforeLines)
    : undefined;
  const afterSource = after
    ? source(newPath, options.classification, options.afterLines)
    : undefined;
  const change = {
    status: before && after ? 'M' : after ? 'A' : 'D',
    oldPath,
    newPath,
    before: beforeSource,
    after: afterSource,
    hunks: options.hunks ?? [
      {
        oldStart: 2,
        oldCount: before ? 1 : 0,
        newStart: 2,
        newCount: after ? 1 : 0,
      },
    ],
    lineMap:
      options.lineMap ??
      new Map([
        [1, 1],
        [10, 10],
        [20, 20],
      ]),
  };
  return {
    snapshot: {
      base_sha: '1'.repeat(40),
      candidate_sha: '2'.repeat(40),
      files: [change],
      manifest: [],
      issues: [],
    },
    measurement: {
      base: before ? { [oldPath]: before } : {},
      candidate: after ? { [newPath]: after } : {},
      fingerprint,
      issues: [],
    },
  };
}
function evaluate(f, selectedPolicy = policy) {
  return evaluateComplexity(f.snapshot, f.measurement, selectedPolicy);
}

test('strict CogC boundary is 15, not CC or aggregate improvement', () => {
  assert.equal(
    evaluate(fixture(undefined, measured('src/a.ts', [fn('new', 15, 1, [], 40)]))).state,
    'PASS',
  );
  const result = evaluate(fixture(undefined, measured('src/a.ts', [fn('new', 16)])));
  assert.equal(result.state, 'FAIL');
  assert.equal(result.violations[0].reason, 'OVER_LIMIT_NEW');
  const highCC = evaluate(fixture(undefined, measured('src/a.ts', [fn('dispatch', 1, 1, [], 25)])));
  assert.equal(highCC.state, 'PASS');
  assert.equal(highCC.observe.cc_ge_20.length, 1);
});

test('existing debt is non-worsening and each unit is judged independently', () => {
  const before = measured('src/a.ts', [fn('debt', 22)]);
  assert.equal(evaluate(fixture(before, measured('src/a.ts', [fn('debt', 22)]))).state, 'PASS');
  assert.equal(evaluate(fixture(before, measured('src/a.ts', [fn('debt', 18)]))).state, 'PASS');
  const worse = evaluate(fixture(before, measured('src/a.ts', [fn('debt', 23)])));
  assert.equal(worse.violations[0].reason, 'LEGACY_WORSENED');
  const mixed = fixture(
    measured('src/a.ts', [fn('better', 30), fn('worse', 22, 10)]),
    measured('src/a.ts', [fn('better', 1), fn('worse', 23, 10)]),
  );
  assert.equal(evaluate(mixed).state, 'FAIL');
});

test('unrelated edits in the same file leave untouched legacy units out of scope', () => {
  const f = fixture(
    measured('src/a.ts', [fn('debt', 22), fn('healthy', 2, 10)]),
    measured('src/a.ts', [fn('debt', 22), fn('healthy', 3, 10)]),
    { hunks: [{ oldStart: 12, oldCount: 1, newStart: 12, newCount: 1 }] },
  );
  const result = evaluate(f);
  assert.equal(result.state, 'PASS');
  assert.equal(
    result.triggers.some((trigger) => trigger.id === 'S5'),
    false,
  );
  assert.equal(result.observe.units.find((unit) => unit.unit.includes('debt')).changed, false);
});

test('body edits trigger debt review even when the score is unchanged', () => {
  const result = evaluate(
    fixture(measured('src/a.ts', [fn('debt', 22)]), measured('src/a.ts', [fn('debt', 22)])),
  );
  assert.equal(result.state, 'PASS');
  assert.ok(result.triggers.some((trigger) => trigger.id === 'S5'));
  assert.equal(result.observe.units.find((unit) => unit.unit.includes('debt')).legacy_debt, true);
});

test('nested anonymous children and module residue cannot hide complexity', () => {
  const nested = evaluate(
    fixture(undefined, measured('src/a.ts', [fn('outer', 0, 1, [fn('<anonymous>', 16, 3)])])),
  );
  assert.equal(nested.state, 'FAIL');
  assert.equal(nested.violations[0].after, 16);
  assert.ok(nested.triggers.some((trigger) => trigger.id === 'S2'));
  assert.equal(
    evaluate(fixture(undefined, measured('src/a.ts', [], 16))).violations[0].unit,
    'src/a.ts::<module>#module[0]',
  );
});

test('negative residue is INCONCLUSIVE rather than a low score', () => {
  const candidate = measured('src/a.ts', [fn('normal', 4)]);
  candidate.cognitive = 3;
  const result = evaluate(fixture(undefined, candidate));
  assert.equal(result.state, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('INVARIANT_VIOLATION'));
});

test('baseline parse errors discard all debt privileges; candidate errors fail closed', () => {
  const baseline = measured('src/a.ts', [fn('debt', 22)], 0, ['baseline syntax error']);
  assert.equal(
    evaluate(fixture(baseline, measured('src/a.ts', [fn('debt', 22)]))).violations[0].reason,
    'OVER_LIMIT_NEW',
  );
  const candidate = measured('src/a.ts', [], 0, ['candidate syntax error']);
  assert.equal(evaluate(fixture(undefined, candidate)).state, 'INCONCLUSIVE');
});

test('verified violations remain visible when another file cannot be measured', () => {
  const f = fixture(undefined, measured('src/a.ts', [fn('tooLarge', 16)]));
  f.measurement.issues.push({
    code: 'TIMEOUT',
    file: 'src/other.ts',
    message: 'timed out',
  });
  const result = evaluate(f);
  assert.equal(result.state, 'FAIL');
  assert.ok(result.reasons.includes('TIMEOUT'));
  assert.equal(result.violations.length, 1);
});

test('missing measured files and mismatched fingerprints never become N/A', () => {
  const missing = fixture(undefined, measured('src/a.ts', [fn('normal', 1)]));
  missing.measurement.candidate = {};
  assert.equal(evaluate(missing).state, 'INCONCLUSIVE');
  const mismatched = fixture(undefined, measured('src/a.ts', [fn('normal', 1)]));
  mismatched.measurement.fingerprint = {
    ...fingerprint,
    cccc_sha256: 'c'.repeat(64),
  };
  assert.equal(evaluate(mismatched).state, 'INCONCLUSIVE');
});

test('deletions and documentation-only changes are explicitly NOT_APPLICABLE', () => {
  assert.equal(
    evaluate(fixture(measured('src/a.ts', [fn('deleted', 30)]), undefined)).state,
    'NOT_APPLICABLE',
  );
  const f = fixture(undefined, undefined);
  f.snapshot.files = [];
  assert.equal(evaluate(f).state, 'NOT_APPLICABLE');
});

test('test complexity is recorded without a production violation or routing trigger', () => {
  const result = evaluate(
    fixture(undefined, measured('test/a.test.ts', [fn('test', 25)]), {
      classification: 'test',
    }),
  );
  assert.equal(result.state, 'PASS');
  assert.equal(result.violations.length, 0);
  assert.equal(result.observe.test_over_budget.length, 1);
  assert.ok(result.triggers.every((trigger) => trigger.observe_only));
});

test('same-hunk unique rename inherits debt and receives identity-changed review', () => {
  const f = fixture(
    measured('src/a.ts', [fn('oldName', 22)]),
    measured('src/a.ts', [fn('newName', 21)]),
    {
      hunks: [{ oldStart: 1, oldCount: 10, newStart: 1, newCount: 10 }],
      lineMap: new Map(),
    },
  );
  const matched = matchUnits(f.snapshot, f.measurement).find((match) => match.method !== 'module');
  assert.equal(matched.method, 'hunk');
  const result = evaluate(f);
  assert.equal(result.state, 'PASS');
  assert.match(result.triggers.find((trigger) => trigger.id === 'S5').evidence, /identity-changed/);
});

test('duplicate method names and ambiguous hunks never choose the most generous baseline', () => {
  const f = fixture(
    measured('src/a.ts', [fn('run', 22), fn('run', 25, 10)]),
    measured('src/a.ts', [fn('run', 22), fn('run', 24, 10)]),
    {
      hunks: [{ oldStart: 1, oldCount: 20, newStart: 1, newCount: 20 }],
      lineMap: new Map(),
    },
  );
  assert.equal(
    matchUnits(f.snapshot, f.measurement).filter((match) => match.method !== 'module').length,
    0,
  );
  const result = evaluate(f);
  assert.equal(result.violations.length, 2);
  assert.ok(result.violations.every((item) => item.reason === 'UNMATCHED_OVER_BUDGET'));
});

test('a copied debt function never shares an existing allowance', () => {
  const f = fixture(
    measured('src/a.ts', [fn('debt', 22)]),
    measured('src/a.ts', [fn('debt', 22), fn('copy', 22, 10)]),
  );
  const matches = matchUnits(f.snapshot, f.measurement).filter(
    (match) => match.method !== 'module',
  );
  assert.equal(matches.length, 1);
  const result = evaluate(f);
  assert.equal(result.violations.length, 1);
  assert.ok(result.violations[0].unit.includes('copy'));
  assert.equal(result.violations[0].reason, 'OVER_LIMIT_NEW');
});

test('a homoglyph rename in a unique hunk is new and warns', () => {
  const f = fixture(
    measured('src/a.ts', [fn('execute', 22)]),
    measured('src/a.ts', [fn('еxecute', 21)]),
    {
      hunks: [{ oldStart: 1, oldCount: 10, newStart: 1, newCount: 10 }],
      lineMap: new Map(),
    },
  );
  assert.equal(
    matchUnits(f.snapshot, f.measurement).filter((match) => match.method !== 'module').length,
    0,
  );
  const result = evaluate(f);
  assert.equal(result.state, 'FAIL');
  assert.equal(result.observe.identifier_warnings.length, 1);
});

test('unmatched parents do not launder nested debt by child name', () => {
  const f = fixture(
    measured('src/a.ts', [fn('<anonymous>', 0, 1, [fn('child', 22, 2)]), fn('<anonymous>', 0, 10)]),
    measured('src/a.ts', [fn('<anonymous>', 0, 1, [fn('child', 22, 2)]), fn('<anonymous>', 0, 10)]),
    {
      hunks: [{ oldStart: 1, oldCount: 20, newStart: 1, newCount: 20 }],
      lineMap: new Map(),
    },
  );
  assert.equal(
    matchUnits(f.snapshot, f.measurement).filter((match) => match.method !== 'module').length,
    0,
  );
  assert.equal(evaluate(f).state, 'FAIL');
});

test('whole file moves retain unique named units and nested children one-to-one', () => {
  const before = measured('src/old.ts', [fn('moved', 1, 1, [fn('<anonymous>', 22, 2)])]);
  const after = measured('src/new.ts', [fn('moved', 1, 1, [fn('<anonymous>', 22, 2)])]);
  const f = fixture(before, after);
  const original = f.snapshot.files[0];
  f.snapshot.files = [
    { ...original, status: 'D', newPath: undefined, after: undefined },
    { ...original, status: 'A', oldPath: undefined, before: undefined },
  ];
  const matches = matchUnits(f.snapshot, f.measurement);
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.method === 'move'));
  assert.equal(matches[1].after, after.functions[0].children[0]);
  assert.equal(evaluate(f).state, 'PASS');
});

test('unit keys distinguish same-name siblings and retain original identity without line numbers', () => {
  const first = fn('same', 1),
    second = fn('same', 1, 10),
    nested = fn('nested', 1, 20, [fn('same', 1, 21)]);
  assert.notEqual(
    unitKey('src/a.ts', first, [first, second, nested]),
    unitKey('src/a.ts', second, [first, second, nested]),
  );
  assert.equal(unitKey('src/a.ts', second, [first, second, nested]), 'src/a.ts::same#function[1]');
  const original = unitKey('src/a.ts', nested.children[0], [first, second, nested]);
  nested.children[0].line = 30;
  assert.equal(unitKey('src/a.ts', nested.children[0], [first, second, nested]), original);
});

test('source-row anchors preserve ordinal while touched same-row functions remain ambiguous', () => {
  const before = measured('src/a.ts', [fn('<anonymous>', 22), fn('<anonymous>', 23)]);
  const after = measured('src/a.ts', [fn('<anonymous>', 22), fn('<anonymous>', 23)]);
  const f = fixture(before, after, { hunks: [], lineMap: new Map([[1, 1]]) });
  assert.equal(
    matchUnits(f.snapshot, f.measurement).filter((match) => match.method === 'anchor').length,
    2,
  );
  f.snapshot.files[0].hunks = [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }];
  f.snapshot.files[0].lineMap = new Map();
  assert.equal(
    matchUnits(f.snapshot, f.measurement).filter((match) => match.method !== 'module').length,
    0,
  );
});

test('S1 identifies branch-preserving redistribution and S10 identifies helper density', () => {
  const before = measured('src/a.ts', [fn('calculate', 24, 1, [], 17)]);
  const helpers = Array.from({ length: 6 }, (_, i) =>
    fn(`helper${i}`, 1, i * 3 + 1, [], i === 0 ? 7 : 3),
  );
  const result = evaluate(
    fixture(before, measured('src/a.ts', helpers), {
      hunks: [{ oldStart: 1, oldCount: 40, newStart: 1, newCount: 40 }],
      lineMap: new Map(),
    }),
  );
  assert.ok(result.triggers.some((trigger) => trigger.id === 'S1'));
  assert.ok(result.triggers.some((trigger) => trigger.id === 'S10'));
});

test('trivial declaration signatures do not inflate S1/S10 unit count', () => {
  const result = evaluate(
    fixture(
      undefined,
      measured(
        'src/a.ts',
        Array.from({ length: 20 }, (_, i) => fn(`signature${i}`, 0, i + 1, [], 1)),
      ),
    ),
  );
  assert.equal(
    result.triggers.some((trigger) => trigger.id === 'S10'),
    false,
  );
  assert.equal(result.observe.statistics.after.count, 0);
});

test('vanished units are INCONCLUSIVE without treating a normal zero-function file as failure', () => {
  const baseline = measured(
    'src/a.ts',
    Array.from({ length: 4 }, (_, i) => fn(`f${i}`, 0, i + 1)),
  );
  assert.equal(evaluate(fixture(baseline, measured('src/a.ts', []))).state, 'INCONCLUSIVE');
  assert.equal(evaluate(fixture(undefined, measured('src/types.ts', []))).state, 'PASS');
});

test('shadow mode preserves real failure, deterministic output, and input immutability', () => {
  const f = fixture(undefined, measured('src/a.ts', [fn('new', 16)]));
  const before = structuredClone(f);
  const result = evaluate(f, { ...policy, gates: { complexity: 'observe' } });
  assert.equal(result.state, 'FAIL');
  assert.equal(result.mode, 'observe');
  assert.deepEqual(result, evaluate(f, { ...policy, gates: { complexity: 'observe' } }));
  assert.deepEqual(f, before);
});

test('range touching uses nested parent scopes but respects a following unrelated sibling', () => {
  const candidate = measured('src/a.ts', [
    fn('outer', 20, 1, [fn('child', 1, 4)]),
    fn('separate', 1, 20),
  ]);
  const f = fixture(candidate, structuredClone(candidate), {
    hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }],
  });
  const touched = changedUnits(f.snapshot.files[0], f.measurement.candidate['src/a.ts'], 'C');
  assert.equal(touched.size, 2);
  assert.ok(!touched.has(f.measurement.candidate['src/a.ts'].functions[1]));
});

test('an unchanged-byte rename omitted by the adapter needs no duplicate measurement', () => {
  const f = fixture(
    measured('src/old.ts', [fn('normal', 1)]),
    measured('src/new.ts', [fn('normal', 1)]),
    { hunks: [] },
  );
  f.measurement.base = {};
  f.measurement.candidate = {};
  const result = evaluate(f);
  assert.equal(result.state, 'NOT_APPLICABLE');
  assert.equal(result.issues.length, 0);
});

test('test-only debt cannot be promoted into a production source allowance', () => {
  const before = measured('test/a.test.ts', [fn('debt', 22)]),
    after = measured('src/a.ts', [fn('debt', 22)]);
  const f = fixture(before, after);
  f.snapshot.files[0].before.classification = 'test';
  assert.equal(matchUnits(f.snapshot, f.measurement).length, 0);
  const result = evaluate(f);
  assert.equal(result.state, 'FAIL');
  assert.equal(result.violations[0].limit, 15);
});
