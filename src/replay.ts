#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, lstat, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, loadPolicy, readJson, sha256, within } from './policy.js';
import { repositoryRoot, runGate } from './runner.js';
import { GATES } from './types.js';
import type { GateId, GateRun, State, Trigger, Violation } from './types.js';

const MAX_PAIRS = 1_000;
const MAX_DATASET_BYTES = 2_000_000;
const STATES: State[] = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE', 'ACCEPTED_WITH_WAIVER'];
const STATIC_GATES = new Set<GateId>(['complexity', 'lint-structure', 'deps']);
export interface ReplayPair {
  id: string;
  base: string;
  candidate: string;
  evidence?: string;
  compare_evidence?: string;
  rolling_base?: string;
}
export interface ReplayDataset {
  schema_version: 1;
  repository?: string;
  pairs: ReplayPair[];
}
export interface ReplayOptions {
  repo: string;
  pairs: string;
  policy: string;
  out: string;
  comparePolicy?: string;
}
interface Signal extends Trigger {
  gate: GateId;
}
interface Failure extends Violation {
  gate: GateId;
}
interface Difference<T> {
  added: T[];
  removed: T[];
}
export interface ReplayComparison {
  changed: boolean;
  state: {
    before: State;
    after: State;
    before_would_block: boolean;
    after_would_block: boolean;
  } | null;
  gates: {
    gate: GateId;
    before_state: State;
    after_state: State;
    before_mode: string;
    after_mode: string;
    before_reasons: string[];
    after_reasons: string[];
  }[];
  triggers: Difference<Signal>;
  violations: Difference<Failure>;
}
interface RunSummary {
  state: State;
  would_block: boolean;
  exit_code: number;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  policy_sha256: string;
  measurement_fingerprint: GateRun['measurement_fingerprint'];
  gates: { gate: GateId; state: State; mode: string; reasons: string[] }[];
  triggers: Signal[];
  violations: Failure[];
  static_complete: boolean;
  incomplete_gates: GateId[];
  artifact_dir: string;
}
interface PairResult {
  id: string;
  base_sha: string;
  candidate_sha: string;
  current?: RunSummary;
  comparison?: RunSummary;
  difference?: ReplayComparison;
  errors: { variant: 'current' | 'comparison'; message: string }[];
}
interface Counts {
  runs: number;
  states: Record<State, number>;
  gate_states: Record<GateId, Record<State, number>>;
  static_incomplete: number;
  incomplete_observations: number;
  would_block: number;
}
export interface ReplayReport {
  schema_version: 1;
  authority: 'local';
  scope: 'historical-policy-replay';
  state: 'COMPLETE' | 'PARTIAL';
  exit_code: 0 | 1 | 2;
  dataset_sha256: string;
  repository: string;
  pairs_requested: number;
  pairs_completed: number;
  pairs_changed: number;
  pairs_failed: number;
  current: Counts;
  comparison?: Counts;
  results: PairResult[];
  limitations: string[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 1_024): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error(`${name} must be a bounded nonempty string without control characters`);
  return value;
}
function commit(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result))
    throw new Error(`${name} must be a full lowercase immutable Git commit SHA`);
  return result;
}
function allowedKeys(value: Record<string, unknown>, keys: string[], name: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${name} contains an unsupported field`);
}
export function validateReplayDataset(value: unknown): ReplayDataset {
  const data = record(value, 'Replay dataset');
  allowedKeys(data, ['schema_version', 'repository', 'pairs'], 'Replay dataset');
  if (data.schema_version !== 1) throw new Error('Unsupported replay schema_version');
  if (!Array.isArray(data.pairs) || !data.pairs.length || data.pairs.length > MAX_PAIRS)
    throw new Error(`Replay requires 1..${MAX_PAIRS} historical pairs`);
  const repository =
    data.repository === undefined ? undefined : text(data.repository, 'repository', 256);
  const ids = new Set<string>();
  const pairs = data.pairs.map((raw, index): ReplayPair => {
    const pair = record(raw, `Pair ${index + 1}`);
    allowedKeys(
      pair,
      ['id', 'base', 'candidate', 'evidence', 'compare_evidence', 'rolling_base'],
      `Pair ${index + 1}`,
    );
    const id = text(pair.id, `Pair ${index + 1} id`, 128);
    if (ids.has(id)) throw new Error('Historical pair IDs must be unique');
    ids.add(id);
    return {
      id,
      base: commit(pair.base, `Pair ${id} base`),
      candidate: commit(pair.candidate, `Pair ${id} candidate`),
      ...(pair.evidence === undefined
        ? {}
        : { evidence: text(pair.evidence, `Pair ${id} evidence`) }),
      ...(pair.compare_evidence === undefined
        ? {}
        : {
            compare_evidence: text(pair.compare_evidence, `Pair ${id} compare_evidence`),
          }),
      ...(pair.rolling_base === undefined
        ? {}
        : {
            rolling_base: commit(pair.rolling_base, `Pair ${id} rolling_base`),
          }),
    };
  });
  return { schema_version: 1, ...(repository ? { repository } : {}), pairs };
}
function difference<T>(before: T[], after: T[]): Difference<T> {
  // Multiset comparison preserves duplicate signals rather than silently dropping them.
  const old = new Map<string, T[]>(),
    current = new Map<string, T[]>();
  for (const [values, groups] of [
    [before, old],
    [after, current],
  ] as const)
    for (const value of values) {
      const key = canonical(value);
      const group = groups.get(key);
      if (group) group.push(value);
      else groups.set(key, [value]);
    }
  const removed: T[] = [],
    added: T[] = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const b = old.get(key) ?? [],
      c = current.get(key) ?? [];
    removed.push(...b.slice(c.length));
    added.push(...c.slice(b.length));
  }
  return { added, removed };
}
function signalRows(run: GateRun): Signal[] {
  return run.gates
    .flatMap((gate) => gate.triggers.map((trigger) => ({ ...trigger, gate: gate.gate })))
    .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
}
function violationRows(run: GateRun): Failure[] {
  return run.gates
    .flatMap((gate) => gate.violations.map((violation) => ({ ...violation, gate: gate.gate })))
    .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
}
export function compareRuns(before: GateRun, after: GateRun): ReplayComparison {
  if (
    before.repository !== after.repository ||
    before.base_sha !== after.base_sha ||
    before.candidate_sha !== after.candidate_sha
  )
    throw new Error('Replay comparisons require the same repository and immutable B/C');
  const state =
    before.state !== after.state || before.would_block !== after.would_block
      ? {
          before: before.state,
          after: after.state,
          before_would_block: before.would_block,
          after_would_block: after.would_block,
        }
      : null;
  const gates = GATES.flatMap((id) => {
    const b = before.gates.find((gate) => gate.gate === id),
      c = after.gates.find((gate) => gate.gate === id);
    if (!b || !c) throw new Error('Replay cannot compare an omitted expected gate');
    const oldReasons = [...b.reasons].sort(),
      newReasons = [...c.reasons].sort();
    return b.state !== c.state ||
      b.mode !== c.mode ||
      canonical(oldReasons) !== canonical(newReasons)
      ? [
          {
            gate: id,
            before_state: b.state,
            after_state: c.state,
            before_mode: b.mode,
            after_mode: c.mode,
            before_reasons: oldReasons,
            after_reasons: newReasons,
          },
        ]
      : [];
  });
  const triggers = difference(signalRows(before), signalRows(after));
  const violations = difference(violationRows(before), violationRows(after));
  return {
    changed: Boolean(
      state ||
      gates.length ||
      triggers.added.length ||
      triggers.removed.length ||
      violations.added.length ||
      violations.removed.length,
    ),
    state,
    gates,
    triggers,
    violations,
  };
}
function emptyCounts(): Counts {
  const states = (): Record<State, number> =>
    Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  return {
    runs: 0,
    states: states(),
    gate_states: Object.fromEntries(GATES.map((gate) => [gate, states()])) as Counts['gate_states'],
    static_incomplete: 0,
    incomplete_observations: 0,
    would_block: 0,
  };
}
function summarize(run: GateRun, artifactDir: string): RunSummary {
  if (!run.policy_sha256)
    throw new Error('Runner omitted the policy content hash required for replay traceability');
  return {
    state: run.state,
    would_block: run.would_block,
    exit_code: run.exit_code,
    base_sha: run.base_sha,
    candidate_sha: run.candidate_sha,
    policy_revision: run.policy_revision,
    policy_sha256: run.policy_sha256,
    measurement_fingerprint: run.measurement_fingerprint,
    gates: run.gates.map((gate) => ({
      gate: gate.gate,
      state: gate.state,
      mode: gate.mode,
      reasons: [...gate.reasons].sort(),
    })),
    triggers: signalRows(run),
    violations: violationRows(run),
    static_complete: !run.gates.some(
      (gate) => STATIC_GATES.has(gate.gate) && gate.state === 'INCONCLUSIVE',
    ),
    incomplete_gates: run.gates
      .filter((gate) => gate.state === 'INCONCLUSIVE')
      .map((gate) => gate.gate),
    artifact_dir: artifactDir,
  };
}
function count(counts: Counts, run: RunSummary): void {
  counts.runs++;
  counts.states[run.state]++;
  if (run.would_block) counts.would_block++;
  if (!run.static_complete) counts.static_incomplete++;
  counts.incomplete_observations += run.gates.filter(
    (gate) => gate.mode === 'observe' && gate.state === 'INCONCLUSIVE',
  ).length;
  for (const gate of run.gates) counts.gate_states[gate.gate][gate.state]++;
}
async function outsideFile(file: string, repo: string, label: string): Promise<string> {
  const resolved = await realpath(path.resolve(file));
  if (within(repo, resolved)) throw new Error(`${label} must be outside the candidate repository`);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  return resolved;
}
async function prepareOutput(out: string, repo: string): Promise<string> {
  const resolved = path.resolve(out),
    parent = await realpath(path.dirname(resolved));
  if (parent !== path.dirname(resolved))
    throw new Error('Replay output parent must use its real path without symlinks');
  if (within(repo, resolved))
    throw new Error('Replay output must be outside the candidate repository');
  try {
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(resolved)).length)
      throw new Error('Replay output must be a new or empty real directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') await mkdir(resolved, { mode: 0o700 });
    else throw error;
  }
  return resolved;
}
function markdown(report: ReplayReport): string {
  const safe = (value: unknown): string =>
    String(value)
      .replace(/[\r\n|`<>]/gu, ' ')
      .slice(0, 256);
  const rows = [
    '# Historical policy replay',
    '',
    `Authority: local. Replay: ${report.state}. ${report.pairs_completed}/${report.pairs_requested} pairs evaluated; ${report.pairs_changed} changed; ${report.pairs_failed} incomplete or failed.`,
    '',
    '| Pair | Current | Comparison | Changed |',
    '|---|---|---|---|',
  ];
  for (const pair of report.results)
    rows.push(
      `| ${safe(pair.id)} | ${pair.current?.state ?? 'ERROR'} | ${pair.comparison?.state ?? '—'} | ${pair.difference?.changed ? 'yes' : 'no'} |`,
    );
  rows.push(
    '',
    'Counts describe the supplied dataset only. They do not establish production calibration, reviewer agreement, or GitHub deployment readiness.',
    '',
  );
  for (const limitation of report.limitations) rows.push(`- ${limitation}`);
  return rows.join('\n') + '\n';
}
export async function replay(options: ReplayOptions): Promise<ReplayReport> {
  const repo = await realpath(repositoryRoot(options.repo));
  const datasetPath = await outsideFile(options.pairs, repo, 'Replay dataset');
  const data = validateReplayDataset(await readJson(datasetPath, MAX_DATASET_BYTES));
  const currentPolicy = await loadPolicy(options.policy, repo);
  const comparePolicy = options.comparePolicy
    ? await loadPolicy(options.comparePolicy, repo)
    : undefined;
  if (!comparePolicy && data.pairs.some((pair) => pair.compare_evidence))
    throw new Error('compare_evidence requires --compare-policy');
  const evidencePaths = new Map<string, string>();
  for (const pair of data.pairs)
    for (const variant of ['evidence', 'compare_evidence'] as const)
      if (pair[variant])
        evidencePaths.set(
          `${pair.id}\0${variant}`,
          await outsideFile(
            path.resolve(path.dirname(datasetPath), pair[variant]),
            repo,
            'Replay evidence',
          ),
        );
  const out = await prepareOutput(options.out, repo);
  const report: ReplayReport = {
    schema_version: 1,
    authority: 'local',
    scope: 'historical-policy-replay',
    state: 'COMPLETE',
    exit_code: 0,
    dataset_sha256: sha256(canonical(data)),
    repository: data.repository ?? path.basename(repo).replace(/\.git$/u, ''),
    pairs_requested: data.pairs.length,
    pairs_completed: 0,
    pairs_changed: 0,
    pairs_failed: 0,
    current: emptyCounts(),
    ...(comparePolicy ? { comparison: emptyCounts() } : {}),
    results: [],
    limitations: [
      'Only the supplied historical pairs were replayed; no claim of a 200-PR replay is made unless this dataset actually contains 200 distinct PRs.',
      'Historical policy violations are recorded as data. Missing observed test, coverage or mutation evidence remains explicitly INCONCLUSIVE and is counted.',
      'Exit 2 means a run failed, static analysis was incomplete, or an enforced aggregate was INCONCLUSIVE; exit 1 means completed comparison differences need review; exit 0 means no such differences.',
      'Ed25519 evidence is bound to exact policy/fingerprint and freshness. Historical or comparison runs need independently valid evidence; replay never rewrites signatures or invents test/reviewer provenance.',
      'Replay is sequential and local. It publishes no checks, waivers, approvals, issue ledgers or policy changes.',
    ],
  };
  for (let index = 0; index < data.pairs.length; index++) {
    const pair = data.pairs[index]!,
      dir = String(index + 1).padStart(4, '0');
    await mkdir(path.join(out, dir), { mode: 0o700 });
    const item: PairResult = {
      id: pair.id,
      base_sha: pair.base,
      candidate_sha: pair.candidate,
      errors: [],
    };
    let current: GateRun | undefined, comparison: GateRun | undefined;
    for (const variant of ['current', 'comparison'] as const) {
      const selected = variant === 'current' ? currentPolicy : comparePolicy;
      if (!selected) continue;
      try {
        const run = await runGate({
          repo,
          base: pair.base,
          candidate: pair.candidate,
          policyPath: selected.path,
          out: path.join(out, dir, variant),
          repository: report.repository,
          evidencePath: evidencePaths.get(
            `${pair.id}\0${variant === 'current' ? 'evidence' : 'compare_evidence'}`,
          ),
          rollingBase: pair.rolling_base,
        });
        if (
          run.base_sha !== pair.base ||
          run.candidate_sha !== pair.candidate ||
          run.repository !== report.repository
        )
          throw new Error('Runner did not resolve the exact supplied immutable repository/B/C');
        if (run.policy_sha256 !== selected.hash)
          throw new Error(
            'Policy changed during replay; rerun against one immutable trusted policy',
          );
        const summary = summarize(run, `${dir}/${variant}`);
        if (variant === 'current') {
          current = run;
          item.current = summary;
          count(report.current, summary);
        } else {
          comparison = run;
          item.comparison = summary;
          count(report.comparison!, summary);
        }
      } catch (error) {
        item.errors.push({
          variant,
          message: error instanceof Error ? error.message : 'Replay run failed',
        });
      }
    }
    if (current && comparison) {
      item.difference = compareRuns(current, comparison);
      if (item.difference.changed) report.pairs_changed++;
    }
    const summaries = [item.current, item.comparison].filter((value): value is RunSummary =>
      Boolean(value),
    );
    const failed =
      item.errors.length > 0 ||
      summaries.some((run) => !run.static_complete || run.state === 'INCONCLUSIVE');
    if (failed) {
      report.pairs_failed++;
      report.state = 'PARTIAL';
    } else report.pairs_completed++;
    report.results.push(item);
    await writeFile(path.join(out, dir, 'replay-pair.json'), JSON.stringify(item, null, 2) + '\n', {
      flag: 'wx',
    });
  }
  report.exit_code = report.pairs_failed ? 2 : report.pairs_changed ? 1 : 0;
  await writeFile(path.join(out, 'replay-result.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(path.join(out, 'replay-summary.md'), markdown(report), {
    flag: 'wx',
  });
  return report;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    if (!args.length || args.includes('--help')) {
      process.stdout.write(
        'node dist/replay.js --repo PATH --pairs TRUSTED_EXTERNAL_JSON --policy TRUSTED_JSON --out EMPTY_EXTERNAL_DIR [--compare-policy TRUSTED_JSON]\n\nDataset: {schema_version:1,repository?:"owner/repo",pairs:[{id:"PR-123",base:"FULL_SHA",candidate:"FULL_SHA",evidence?:"relative-signed.json",compare_evidence?:"comparison-signed.json",rolling_base?:"FULL_SHA"}]}\nSequential local replay; no automatic publishing. Exit 0 complete, 1 comparison differences, 2 incomplete/error.\n',
      );
      return 0;
    }
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(
        ['repo', 'pairs', 'policy', 'out', 'compare-policy'].map((name) => [
          name,
          { type: 'string' as const },
        ]),
      ),
    });
    for (const key of ['repo', 'pairs', 'policy', 'out'])
      if (!values[key]) throw new Error(`Missing --${key}`);
    const report = await replay({
      repo: values.repo as string,
      pairs: values.pairs as string,
      policy: values.policy as string,
      out: values.out as string,
      comparePolicy: values['compare-policy'] as string | undefined,
    });
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.exit_code;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        schema_version: 1,
        authority: 'local',
        state: 'PARTIAL',
        exit_code: 2,
        issues: [
          {
            code: 'REPLAY_ERROR',
            message: error instanceof Error ? error.message : 'Replay failed',
          },
        ],
      }) + '\n',
    );
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => {
    process.exitCode = code;
  });
