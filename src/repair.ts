import { canonical } from './policy.js';
import type { GateRun } from './types.js';
export interface RepairDecision {
  action: 'complete' | 'retry' | 'human';
  reason: string;
  attempts_remaining: number;
}
/** Plan only. An untrusted isolated executor applies changes; this service never executes them. */
export function planRepair(history: GateRun[]): RepairDecision {
  if (!history.length)
    return { action: 'human', reason: 'A baseline evaluation is required', attempts_remaining: 2 };
  const last = history.at(-1)!;
  const attempts = history.length - 1;
  const violationSet = (r: GateRun) =>
    JSON.stringify(
      r.gates.flatMap((g) => g.violations.map((v) => [g.gate, v.unit, v.reason])).sort(),
    );
  if (
    history.some(
      (r) =>
        r.base_sha !== history[0]!.base_sha ||
        r.policy_revision !== history[0]!.policy_revision ||
        canonical(r.measurement_fingerprint) !== canonical(history[0]!.measurement_fingerprint) ||
        r.policy_sha256 !== history[0]!.policy_sha256,
    )
  )
    return { action: 'human', reason: 'B/P/M changed during repair loop', attempts_remaining: 0 };
  if (
    last.state === 'PASS' ||
    last.state === 'NOT_APPLICABLE' ||
    last.state === 'ACCEPTED_WITH_WAIVER'
  ) {
    if (last.would_block)
      return {
        action: 'human',
        reason: 'Shadow acceptance is not evidence that the repair is complete',
        attempts_remaining: 0,
      };
    return {
      action: 'complete',
      reason: 'All applicable gates accepted',
      attempts_remaining: Math.max(0, 2 - attempts),
    };
  }
  if (last.state === 'INCONCLUSIVE')
    return {
      action: 'human',
      reason: 'Measurement or trusted evidence must be repaired by an operator',
      attempts_remaining: 0,
    };
  const forbidden = [
    'PROTECTED_CONFIGURATION_CHANGED',
    'TEST_REMOVED',
    'TEST_IDS_REMOVED',
    'TEST_DISABLED_OR_FOCUSED',
    'ASSERTION_FREE_NEW_TEST',
    'AI_FORBIDDEN_CHANGE',
  ];
  if (last.gates.some((g) => g.violations.some((v) => forbidden.includes(v.reason))))
    return {
      action: 'human',
      reason: 'Test, scope or policy weakening is forbidden',
      attempts_remaining: 0,
    };
  if (attempts >= 2)
    return { action: 'human', reason: 'Automatic retry limit reached', attempts_remaining: 0 };
  if (history.length > 1) {
    const prior = history.at(-2)!;
    if (violationSet(prior) === violationSet(last))
      return { action: 'human', reason: 'No progress on violations', attempts_remaining: 0 };
    const previous = new Set(
      prior.triggers
        .filter((x) => !x.observe_only && x.id !== 'S8')
        .map((x) => x.id + '\0' + x.file),
    );
    if (
      last.triggers.some(
        (x) => x.id !== 'S8' && !x.observe_only && !previous.has(x.id + '\0' + x.file),
      )
    )
      return {
        action: 'human',
        reason: 'Repair introduced a review trigger',
        attempts_remaining: 0,
      };
  }
  return {
    action: 'retry',
    reason: 'Repair named violations while preserving behavior and tests',
    attempts_remaining: 2 - attempts,
  };
}
