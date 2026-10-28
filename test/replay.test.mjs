import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateReplayDataset, compareRuns } from '../dist/replay.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gates = [
  'complexity',
  'lint-structure',
  'deps',
  'tests',
  'coverage',
  'simplification-review',
  'mutation',
];
function fixture(t, code = false) {
  const root = mkdtempSync(join(tmpdir(), 'nyorori-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Replay Fixture');
  git('config', 'user.email', 'replay@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(
    join(repo, code ? 'a.ts' : 'README.md'),
    code
      ? 'export function f(value:number) { return value; }\n// replay-score:16\n'
      : 'candidate\n',
  );
  git('add', '.');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  // Controlled measurement protocol shim for testing replay orchestration, not cccc semantics.
  const shim = `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')){process.stdout.write('cccc 1.8.5\\n');process.exit(0);}
const files=process.argv.slice(process.argv.indexOf('--')+1).map(path=>{const content=fs.readFileSync(path,'utf8');const cognitive=Number(/replay-score:(\\d+)/.exec(content)?.[1]??1);return {path,cognitive,cyclomatic:1,functions:[{name:'f',kind:'function',line:1,cognitive,cyclomatic:1,children:[]}],parse_errors:[]};});
process.stdout.write(JSON.stringify({files,summary:{file_count:files.length}}));
`;
  const binary = join(root, 'fixture-cccc.mjs');
  writeFileSync(binary, shim);
  chmodSync(binary, 0o755);
  const policy = JSON.parse(readFileSync(join(project, 'examples/policy.json'), 'utf8'));
  policy.phase = 'P2';
  policy.revision = 'replay-policy-v1';
  policy.gates.complexity = 'enforce';
  policy.measurement = {
    ...policy.measurement,
    binary,
    sha256: createHash('sha256').update(shim).digest('hex'),
    jobs: 1,
    timeout_ms: 2000,
  };
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  const pairsPath = join(root, 'pairs.json');
  const dataset = {
    schema_version: 1,
    repository: 'fixture/replay',
    pairs: [{ id: 'PR-1', base, candidate }],
  };
  const run = (data = dataset, extra = []) => {
    writeFileSync(pairsPath, JSON.stringify(data));
    const out = join(root, `out-${Math.random().toString(16).slice(2)}`);
    const processResult = spawnSync(
      process.execPath,
      [
        join(project, 'dist/replay.js'),
        '--repo',
        repo,
        '--pairs',
        pairsPath,
        '--policy',
        policyPath,
        '--out',
        out,
        ...extra,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(processResult.signal, null, processResult.stderr);
    assert.ok(processResult.stdout, processResult.stderr);
    return {
      result: processResult,
      report: JSON.parse(processResult.stdout),
      out,
    };
  };
  return {
    root,
    repo,
    git,
    base,
    candidate,
    policy,
    policyPath,
    pairsPath,
    dataset,
    run,
  };
}

test('replay dataset requires explicit bounded immutable historical pairs', () => {
  const valid = {
    schema_version: 1,
    repository: 'example/repo',
    pairs: [{ id: 'PR-1', base: 'a'.repeat(40), candidate: 'b'.repeat(40) }],
  };
  assert.deepEqual(validateReplayDataset(valid), valid);
  for (const invalid of [
    { ...valid, schema_version: 2 },
    { ...valid, pairs: [] },
    { ...valid, pairs: [...valid.pairs, ...valid.pairs] },
    { ...valid, pairs: [{ ...valid.pairs[0], base: 'main' }] },
    { ...valid, pairs: [{ ...valid.pairs[0], candidate: '--help' }] },
    { ...valid, pairs: [{ ...valid.pairs[0], id: 'bad\nidentity' }] },
    { ...valid, pairs: [{ ...valid.pairs[0], command: 'arbitrary' }] },
    {
      ...valid,
      pairs: Array.from({ length: 1001 }, (_, id) => ({
        ...valid.pairs[0],
        id: String(id),
      })),
    },
  ])
    assert.throws(() => validateReplayDataset(invalid));
});

test('historical docs pairs run through the actual runner and retain per-pair artifacts', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'README.md'), 'second candidate\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'second candidate');
  const second = f.git('rev-parse', 'HEAD');
  const data = {
    ...f.dataset,
    pairs: [...f.dataset.pairs, { id: 'PR-2', base: f.candidate, candidate: second }],
  };
  const { result, report, out } = f.run(data);
  assert.equal(result.status, 0);
  assert.equal(report.authority, 'local');
  assert.equal(report.state, 'COMPLETE');
  assert.equal(report.pairs_requested, 2);
  assert.equal(report.pairs_completed, 2);
  assert.equal(report.current.states.NOT_APPLICABLE, 2);
  assert.ok(existsSync(join(out, '0001/current/gate-result.json')));
  assert.ok(existsSync(join(out, '0002/current/manifest.json')));
  assert.ok(existsSync(join(out, 'replay-summary.md')));
  assert.equal(
    JSON.parse(readFileSync(join(out, 'replay-result.json'), 'utf8')).results[1].id,
    'PR-2',
  );
  assert.equal(report.results[0].current.base_sha, f.base);
  assert.equal(report.results[0].current.candidate_sha, f.candidate);
  assert.ok(report.limitations.some((text) => text.includes('200')));
});

test('comparison reruns the same B/C and reports state and violation differences', (t) => {
  const f = fixture(t, true);
  const comparison = join(f.root, 'comparison-policy.json');
  writeFileSync(
    comparison,
    JSON.stringify({
      ...f.policy,
      revision: 'replay-policy-v2',
      limits: { ...f.policy.limits, cognitive: 20 },
    }),
  );
  const { result, report, out } = f.run(f.dataset, ['--compare-policy', comparison]);
  assert.equal(result.status, 1);
  assert.equal(report.pairs_changed, 1);
  assert.equal(report.current.states.FAIL, 1);
  assert.equal(report.comparison.states.PASS, 1);
  assert.equal(report.results[0].difference.state.before, 'FAIL');
  assert.equal(report.results[0].difference.state.after, 'PASS');
  assert.equal(report.results[0].difference.violations.removed[0].after, 16);
  assert.equal(report.results[0].difference.violations.added.length, 0);
  assert.ok(report.results[0].current.incomplete_gates.includes('tests'));
  assert.ok(report.current.incomplete_observations > 0);
  assert.equal(report.current.static_incomplete, 0);
  assert.ok(existsSync(join(out, '0001/comparison/gate-result.json')));
});

test('metadata-only policy changes do not create fabricated decision changes', (t) => {
  const f = fixture(t);
  const comparison = join(f.root, 'comparison-policy.json');
  writeFileSync(comparison, JSON.stringify({ ...f.policy, revision: 'approved-new-revision' }));
  const { result, report } = f.run(f.dataset, ['--compare-policy', comparison]);
  assert.equal(result.status, 0);
  assert.equal(report.pairs_changed, 0);
  assert.equal(report.results[0].difference.changed, false);
  assert.notEqual(
    report.results[0].current.policy_sha256,
    report.results[0].comparison.policy_sha256,
  );
});

test('an invalid historical commit stays incomplete and does not prevent later pairs', (t) => {
  const f = fixture(t);
  const data = {
    ...f.dataset,
    pairs: [
      { id: 'missing-objects', base: 'f'.repeat(40), candidate: f.candidate },
      ...f.dataset.pairs,
    ],
  };
  const { result, report, out } = f.run(data);
  assert.equal(result.status, 2);
  assert.equal(report.state, 'PARTIAL');
  assert.equal(report.pairs_failed, 1);
  assert.equal(report.pairs_completed, 1);
  assert.equal(report.results[0].errors.length, 1);
  assert.equal(report.results[1].current.state, 'NOT_APPLICABLE');
  assert.ok(existsSync(join(out, '0002/current/gate-result.json')));
});

test('replay rejects candidate-controlled datasets and never overwrites occupied output', (t) => {
  const f = fixture(t);
  const inside = join(f.repo, 'pairs.json');
  writeFileSync(inside, JSON.stringify(f.dataset));
  const out = join(f.root, 'occupied');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'user data');
  writeFileSync(f.pairsPath, JSON.stringify(f.dataset));
  for (const [pairs, destination] of [
    [inside, join(f.root, 'outside-output')],
    [f.pairsPath, out],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        join(project, 'dist/replay.js'),
        '--repo',
        f.repo,
        '--pairs',
        pairs,
        '--policy',
        f.policyPath,
        '--out',
        destination,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).issues[0].code, 'REPLAY_ERROR');
  }
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'user data');
  const linked = join(f.root, 'linked-pairs.json');
  symlinkSync(inside, linked);
  const result = spawnSync(
    process.execPath,
    [
      join(project, 'dist/replay.js'),
      '--repo',
      f.repo,
      '--pairs',
      linked,
      '--policy',
      f.policyPath,
      '--out',
      join(f.root, 'linked-out'),
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /outside the candidate repository/u);
});

function simpleRun() {
  return {
    repository: 'example/repo',
    base_sha: 'a'.repeat(40),
    candidate_sha: 'b'.repeat(40),
    state: 'PASS',
    would_block: false,
    measurement_fingerprint: { cccc_sha256: 'old' },
    gates: gates.map((gate) => ({
      gate,
      state: 'PASS',
      mode: 'observe',
      reasons: [],
      triggers: [],
      violations: [],
    })),
  };
}
test('comparison exposes changed trigger evidence, gate modes, and duplicate violations', () => {
  const before = simpleRun(),
    after = structuredClone(before);
  before.gates[0].triggers = [{ id: 'S5', file: 'a.ts', evidence: 'CogC 22→22' }];
  after.gates[0].triggers = [{ id: 'S5', file: 'a.ts', evidence: 'CogC 22→23' }];
  before.gates[0].violations = [
    { unit: 'a.ts::f', file: 'a.ts', line: 1, reason: 'OVER_LIMIT', after: 16 },
    { unit: 'a.ts::f', file: 'a.ts', line: 1, reason: 'OVER_LIMIT', after: 16 },
  ];
  after.gates[0].violations = [before.gates[0].violations[0]];
  after.gates[0].mode = 'enforce';
  const difference = compareRuns(before, after);
  assert.equal(difference.changed, true);
  assert.equal(difference.triggers.added.length, 1);
  assert.equal(difference.triggers.removed.length, 1);
  assert.equal(difference.violations.removed.length, 1);
  assert.equal(difference.gates[0].after_mode, 'enforce');
  const metadata = structuredClone(before);
  metadata.measurement_fingerprint.cccc_sha256 = 'new';
  assert.equal(compareRuns(before, metadata).changed, false);
  assert.throws(() => compareRuns(before, { ...after, candidate_sha: 'c'.repeat(40) }));
  const omitted = structuredClone(after);
  omitted.gates.pop();
  assert.throws(() => compareRuns(before, omitted));
});

test('standalone replay CLI returns machine-readable errors for bad options', () => {
  const result = spawnSync(process.execPath, [join(project, 'dist/replay.js'), '--unknown'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).issues[0].code, 'REPLAY_ERROR');
});
