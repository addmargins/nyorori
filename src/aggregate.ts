import { GATES, type GateResult, type State } from './types.js';
const priority: Record<State, number> = {
  FAIL: 5,
  INCONCLUSIVE: 4,
  ACCEPTED_WITH_WAIVER: 3,
  PASS: 2,
  NOT_APPLICABLE: 1,
};
export function aggregate(gates: GateResult[]): {
  state: State;
  exit_code: 0 | 1 | 2;
  check_conclusion: 'success' | 'failure';
  would_block: boolean;
} {
  const ids = gates.map((x) => x.gate);
  if (
    gates.some(
      (g) => !['observe', 'enforce'].includes(g.mode) || !Object.hasOwn(priority, g.state),
    ) ||
    ids.length !== GATES.length ||
    new Set(ids).size !== GATES.length ||
    GATES.some((id) => !ids.includes(id))
  )
    return { state: 'INCONCLUSIVE', exit_code: 2, check_conclusion: 'failure', would_block: true };
  const enforced = gates.filter((x) => x.mode === 'enforce');
  const relevant = enforced.length
    ? enforced
    : gates.every((x) => x.state === 'NOT_APPLICABLE')
      ? gates
      : [];
  const state: State = relevant.reduce<State>(
    (state, g) => (priority[g.state] > priority[state] ? g.state : state),
    relevant.length ? 'NOT_APPLICABLE' : 'PASS',
  );
  return {
    state,
    exit_code: state === 'FAIL' ? 1 : state === 'INCONCLUSIVE' ? 2 : 0,
    check_conclusion: state === 'FAIL' || state === 'INCONCLUSIVE' ? 'failure' : 'success',
    would_block: gates.some((g) => g.state === 'FAIL' || g.state === 'INCONCLUSIVE'),
  };
}
