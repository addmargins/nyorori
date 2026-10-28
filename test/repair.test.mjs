import test from 'node:test';
import assert from 'node:assert/strict';
import { planRepair } from '../dist/repair.js';

function run(changes = {}) {
  return {
    base_sha: 'base',
    candidate_sha: 'candidate',
    policy_revision: 'P',
    policy_sha256: 'policy-hash',
    measurement_fingerprint: { cccc_sha256: 'M', runner_commit: 'R' },
    state: 'FAIL',
    would_block: true,
    triggers: [],
    gates: [{ gate: 'complexity', violations: [{ unit: 'f', reason: 'OVER_LIMIT_NEW' }] }],
    ...changes,
  };
}

test('repair requires baseline evidence and allows no more than two attempts', () => {
  assert.equal(planRepair([]).action, 'human');
  const first = run();
  const second = run({
    candidate_sha: 'candidate-2',
    gates: [{ gate: 'complexity', violations: [{ unit: 'g', reason: 'OVER_LIMIT_NEW' }] }],
  });
  assert.deepEqual(planRepair([first]), {
    action: 'retry',
    reason: 'Repair named violations while preserving behavior and tests',
    attempts_remaining: 2,
  });
  assert.equal(planRepair([first, second]).action, 'retry');
  assert.equal(planRepair([first, second]).attempts_remaining, 1);
  assert.equal(planRepair([first, second, run()]).action, 'human');
  assert.equal(planRepair([first, second, run()]).attempts_remaining, 0);
});

test('repair stops without progress and when a new routing trigger appears', () => {
  assert.match(planRepair([run(), run({ candidate_sha: 'new-head' })]).reason, /No progress/);
  const improved = run({
    gates: [{ gate: 'complexity', violations: [{ unit: 'g', reason: 'OVER_LIMIT_NEW' }] }],
    triggers: [{ id: 'S9', file: 'src/a.ts', evidence: 'new hidden branch' }],
  });
  assert.equal(planRepair([run(), improved]).action, 'human');
  assert.match(planRepair([run(), improved]).reason, /trigger/);
  for (const trigger of [
    { id: 'S8', file: 'a', evidence: 'near budget' },
    { id: 'S9', file: 'a', evidence: 'shadow only', observe_only: true },
  ]) {
    assert.equal(planRepair([run(), { ...improved, triggers: [trigger] }]).action, 'retry');
  }
});

test('repair fixes B/P/M across retries while allowing a new candidate', () => {
  const prior = run();
  const improving = {
    candidate_sha: 'new-head',
    gates: [{ gate: 'complexity', violations: [{ unit: 'g', reason: 'OVER_LIMIT_NEW' }] }],
  };
  for (const change of [
    { base_sha: 'other' },
    { policy_revision: 'new-P' },
    { policy_sha256: 'new-policy-hash' },
    { measurement_fingerprint: { cccc_sha256: 'new-M', runner_commit: 'R' } },
  ]) {
    const decision = planRepair([prior, run({ ...improving, ...change })]);
    assert.equal(decision.action, 'human');
    assert.match(decision.reason, /B\/P\/M changed/);
  }
  assert.equal(planRepair([prior, run(improving)]).action, 'retry');
  assert.equal(
    planRepair([
      prior,
      run({ ...improving, measurement_fingerprint: { runner_commit: 'R', cccc_sha256: 'M' } }),
    ]).action,
    'retry',
  );
});

test('repair sends integrity failures and inconclusive measurement to a human', () => {
  assert.equal(planRepair([run({ state: 'INCONCLUSIVE' })]).action, 'human');
  for (const reason of [
    'PROTECTED_CONFIGURATION_CHANGED',
    'TEST_REMOVED',
    'TEST_IDS_REMOVED',
    'TEST_DISABLED_OR_FOCUSED',
    'ASSERTION_FREE_NEW_TEST',
    'AI_FORBIDDEN_CHANGE',
  ]) {
    const decision = planRepair([
      run({ gates: [{ gate: 'tests', violations: [{ unit: 'test', reason }] }] }),
    ]);
    assert.equal(decision.action, 'human');
    assert.match(decision.reason, /forbidden/);
  }
});

test('repair completion requires real acceptance, not shadow-only success', () => {
  for (const state of ['PASS', 'NOT_APPLICABLE', 'ACCEPTED_WITH_WAIVER']) {
    assert.equal(planRepair([run({ state, would_block: false, gates: [] })]).action, 'complete');
    const shadow = planRepair([run({ state, would_block: true, gates: [] })]);
    assert.equal(shadow.action, 'human');
    assert.match(shadow.reason, /Shadow/);
  }
});
