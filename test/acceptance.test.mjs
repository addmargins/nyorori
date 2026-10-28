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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

// This is an intentionally synthetic measurer for protocol fault injection.
// It does not validate cccc's scoring semantics; the real-binary suite does that.
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
const shimSource = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('cccc 1.8.5\\n'); process.exit(0); }
const mode = JSON.parse(fs.readFileSync('__SHIM_MODE_PATH__', 'utf8'));
if (mode === 'exit') process.exit(9);
if (mode === 'empty') process.exit(0);
if (mode === 'invalid-json') { process.stdout.write('{'); process.exit(0); }
if (mode === 'stderr') process.stderr.write('fixture: cannot read input\\n');
const paths = process.argv.slice(process.argv.indexOf('--') + 1);
const files = paths.map(p => {
  const content = fs.readFileSync(p, 'utf8');
  const marker = /\\/\\* cccc-fixture (.+?) \\*\\//.exec(content);
  const value = marker ? JSON.parse(marker[1]) : {};
  const functions = value.functions ?? [{ name: 'f', kind: 'function', line: 1, cognitive: value.cognitive ?? 1, cyclomatic: value.cyclomatic ?? 2, children: [] }];
  const total = (units, key) => units.reduce((sum, unit) => sum + unit[key] + total(unit.children ?? [], key), 0);
  return { path: p, cognitive: total(functions, 'cognitive') + (value.residue ?? 0), cyclomatic: total(functions, 'cyclomatic') + (value.residue_cc ?? 0), functions, parse_errors: value.parse_errors ?? [] };
});
if (mode === 'missing') files.pop();
if (mode === 'duplicate') files.push(files[0]);
if (mode === 'negative') files[0].functions[0].cognitive = -1;
if (mode === 'numeric-string') files[0].functions[0].cognitive = '16';
if (mode === 'boolean') files[0].functions[0].cognitive = true;
if (mode === 'wrong-path') files[0].path = '../outside.ts';
const report = { files, summary: { file_count: mode === 'wrong-count' ? files.length + 1 : files.length } };
process.stdout.write(JSON.stringify(report));
`;

function fixture(t, before = {}, after = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nyorori-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Acceptance Fixture');
  git('config', 'commit.gpgsign', 'false');
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  put('README.md', 'Acceptance fixture\n');
  for (const [path, content] of Object.entries(before)) put(path, content);
  git('add', '--all');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const [path, content] of Object.entries(after)) {
    if (path === '.gitattributes') continue;
    if (content === null) rmSync(join(repo, path), { force: true });
    else put(path, content);
  }
  git('add', '--all');
  if (after['.gitattributes'] !== undefined) {
    if (after['.gitattributes'] === null) rmSync(join(repo, '.gitattributes'), { force: true });
    else put('.gitattributes', after['.gitattributes']);
    git('add', '--', '.gitattributes');
  }
  git('commit', '--allow-empty', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const binary = join(root, 'fixture-cccc.mjs');
  const binarySource = shimSource.replace('__SHIM_MODE_PATH__', join(root, 'shim-mode.json'));
  writeFileSync(binary, binarySource);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, 'shim-mode.json'), JSON.stringify('normal'));
  const policy = {
    schema_version: 1,
    revision: 'acceptance-policy-v1',
    phase: 'P2',
    gates: Object.fromEntries(gates.map((g) => [g, g === 'complexity' ? 'enforce' : 'observe'])),
    measurement: {
      binary,
      sha256: createHash('sha256').update(binarySource).digest('hex'),
      version: 'cccc 1.8.5',
      timeout_ms: 2000,
      jobs: 1,
      max_file_bytes: 2_000_000,
      jsx_in_js: false,
    },
    scope: {
      source_extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      unmeasured_extensions: ['.vue', '.svelte', '.astro', '.mdx'],
      non_code_extensions: ['.md', '.json', '.txt', '.toml', '.yml', '.yaml'],
      test_globs: ['**/*.test.ts', '**/*.spec.ts', 'test/**'],
      exclude_globs: ['vendor/**', 'generated/**'],
      protected_globs: [
        '.github/**',
        '**/cccc.toml',
        '**/.cccc.toml',
        '.gitattributes',
        '.gitmodules',
        '**/eslint.config.*',
        '**/vitest.config.*',
        '**/tsconfig*.json',
      ],
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
      simplification_reviewers: ['independent-reviewer'],
      waiver_approvers: ['independent-reviewer'],
      gate_owners: ['gate-owner'],
      bots: ['quality-bot'],
    },
    coverage: { provider: 'istanbul', version: '1.0.0' },
    waiver: { max_per_pr: 2, max_days: 90 },
  };
  const policyPath = join(root, 'trusted-policy.json');
  const run = (changes = {}, extraArgs = []) => {
    Object.assign(policy, changes);
    writeFileSync(policyPath, JSON.stringify(policy));
    const out = join(root, `out-${Math.random().toString(16).slice(2)}`);
    const result = spawnSync(
      process.execPath,
      [
        join(project, 'dist/cli.js'),
        'analyze',
        '--repo',
        repo,
        '--base',
        base,
        '--candidate',
        candidate,
        '--policy',
        policyPath,
        '--out',
        out,
        ...extraArgs,
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(result.signal, null, `CLI terminated unexpectedly: ${result.stderr}`);
    const file = join(out, 'gate-result.json');
    assert.ok(
      existsSync(file),
      `result artifact missing (exit ${result.status}): ${result.stdout}\n${result.stderr}`,
    );
    return { result, report: JSON.parse(readFileSync(file, 'utf8')), out };
  };
  const mode = (value) => writeFileSync(join(root, 'shim-mode.json'), JSON.stringify(value));
  return { root, repo, git, base, candidate, binary, policy, policyPath, put, run, mode };
}

function source(cognitive, extra = {}) {
  return `export function f(value) {\n  return value;\n}\n/* cccc-fixture ${JSON.stringify({ cognitive, ...extra })} */\n`;
}
function gate(report, name) {
  const value = report.gates.find((g) => g.gate === name);
  assert.ok(value, `required ${name} result absent`);
  return value;
}
function codes(report) {
  return [...(report.issues ?? []), ...report.gates.flatMap((g) => g.issues ?? [])].map(
    (i) => i.code,
  );
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function evidenceSigner(f) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  f.policy.evidence = {
    public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issuer: 'acceptance-runner',
    max_age_seconds: 300,
  };
  const context = f.run({}, ['--repository', 'fixture/repo']).report;
  const basePayload = {
    schema_version: 1,
    issuer: 'acceptance-runner',
    repository: 'fixture/repo',
    base_sha: f.base,
    candidate_sha: f.candidate,
    policy_revision: f.policy.revision,
    policy_sha256: digest(f.policy),
    measurement_fingerprint: digest(context.measurement_fingerprint),
    issued_at: new Date().toISOString(),
    actors: { author: 'author', participants: ['author'], agent_initiators: [] },
  };
  return (changes) => {
    const payload = { ...basePayload, ...changes };
    const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64');
    const evidencePath = join(f.root, `evidence-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(evidencePath, JSON.stringify({ payload, signature }));
    return evidencePath;
  };
}
function testReport(status = 'passed') {
  return {
    total: 1,
    passed: status === 'passed' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    skipped: 0,
    tests: [{ id: 'works', status, assertions: 1 }],
  };
}

test('CLI evaluates new complexity threshold inclusively and reports local authority', async (t) => {
  for (const [score, expected, exit] of [
    [15, 'PASS', 0],
    [16, 'FAIL', 1],
  ]) {
    await t.test(`new CogC ${score} => ${expected}`, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': source(score) });
      const { result, report } = f.run();
      assert.equal(gate(report, 'complexity').state, expected);
      assert.equal(report.authority, 'local');
      assert.equal(report.evidence_verified, false);
      assert.equal(result.status, exit);
      assert.equal(report.check_conclusion, exit ? 'failure' : 'success');
      assert.equal(report.base_sha, f.base);
      assert.equal(report.candidate_sha, f.candidate);
      assert.equal(report.policy_revision, f.policy.revision);
    });
  }
});

test('legacy debt permits maintenance but refuses a one-point increase', async (t) => {
  for (const [score, expected] of [
    [22, 'PASS'],
    [23, 'FAIL'],
  ]) {
    await t.test(`22 to ${score}`, (t) => {
      const f = fixture(
        t,
        { 'src/a.ts': source(22) },
        { 'src/a.ts': source(score).replace('return value;', 'return Number(value);') },
      );
      const { report } = f.run();
      assert.equal(gate(report, 'complexity').state, expected);
      assert.ok(report.triggers.some((trigger) => trigger.id === 'S5'));
    });
  }
});

test('complexity does not allow improvement in one unit to offset another', (t) => {
  const units = (cognitive) => [
    { name: 'f', kind: 'function', line: 1, cognitive, cyclomatic: 2, children: [] },
    { name: 'g', kind: 'function', line: 5, cognitive: 17, cyclomatic: 3, children: [] },
  ];
  const f = fixture(
    t,
    {
      'src/a.ts': source(22, {
        functions: units(22).map((u, i) => ({ ...u, cognitive: i ? 1 : 22 })),
      }),
    },
    { 'src/a.ts': source(1, { functions: units(1) }) },
  );
  const { report } = f.run();
  assert.equal(gate(report, 'complexity').state, 'FAIL');
  assert.ok(gate(report, 'complexity').violations.some((v) => v.after === 17));
});

test('nested children and module residue are each independently enforced', async (t) => {
  for (const [name, extra] of [
    [
      'child',
      {
        functions: [
          {
            name: 'f',
            kind: 'function',
            line: 1,
            cognitive: 0,
            cyclomatic: 1,
            children: [
              {
                name: '<anonymous>',
                kind: 'arrow',
                line: 2,
                cognitive: 16,
                cyclomatic: 2,
                children: [],
              },
            ],
          },
        ],
      },
    ],
    ['residue', { functions: [], residue: 16, residue_cc: 3 }],
  ])
    await t.test(name, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': source(0, extra) });
      const { report } = f.run();
      assert.equal(gate(report, 'complexity').state, 'FAIL');
      assert.ok(gate(report, 'complexity').violations.some((v) => v.after === 16));
    });
});

test('CC is observation, not a second blocking complexity metric', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(8, { cyclomatic: 31 }) });
  const { result, report } = f.run();
  assert.equal(gate(report, 'complexity').state, 'PASS');
  assert.equal(result.status, 0);
  assert.match(JSON.stringify(gate(report, 'complexity').observe), /31/);
});

test('docs-only change is explicit N/A and emits all declared gate results', (t) => {
  const f = fixture(t, {}, { 'README.md': 'Documentation only\n' });
  const { result, report, out } = f.run();
  assert.equal(result.status, 0);
  assert.equal(report.state, 'NOT_APPLICABLE');
  assert.equal(gate(report, 'complexity').state, 'NOT_APPLICABLE');
  assert.deepEqual(report.gates.map((g) => g.gate).sort(), [...gates].sort());
  for (const name of ['manifest.json', 'gate-summary.md', 'gate-feedback.json'])
    assert.ok(existsSync(join(out, name)), `missing ${name}`);
});

test('same immutable B/C/P/M produces deterministic report content', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(4) });
  const first = f.run();
  const second = f.run();
  assert.deepEqual(first.report, second.report);
  assert.equal(
    readFileSync(join(first.out, 'gate-summary.md'), 'utf8'),
    readFileSync(join(second.out, 'gate-summary.md'), 'utf8'),
  );
});

test('repeated failed measurements also produce stable judgment and evidence', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(4) });
  f.mode('exit');
  const first = f.run();
  const second = f.run();
  assert.equal(first.result.status, 2);
  assert.equal(second.result.status, 2);
  assert.deepEqual(first.report, second.report);
});

test('missing test evidence never becomes implicit passing tests', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(2) });
  f.policy.gates.tests = 'enforce';
  const { result, report } = f.run();
  assert.equal(gate(report, 'tests').state, 'INCONCLUSIVE');
  assert.equal(report.state, 'INCONCLUSIVE');
  assert.equal(result.status, 2);
  assert.equal(report.check_conclusion, 'failure');
});

test('shadow retains analysis failures and exposes would_block', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(16) });
  const { report } = f.run({
    phase: 'P0',
    gates: Object.fromEntries(gates.map((g) => [g, 'observe'])),
  });
  assert.equal(gate(report, 'complexity').state, 'FAIL');
  assert.equal(report.authority, 'local');
  assert.equal(report.would_block, true);
});

test('cccc subprocess and schema faults cannot pass', async (t) => {
  const modes = {
    exit: 'MEASURER_EXIT',
    empty: 'EMPTY_OUTPUT',
    'invalid-json': 'SCHEMA',
    stderr: 'MEASURER_STDERR',
    missing: 'MANIFEST_MISMATCH',
    duplicate: 'MANIFEST_MISMATCH',
    'wrong-count': 'MANIFEST_MISMATCH',
    negative: 'SCHEMA',
    'numeric-string': 'SCHEMA',
    boolean: 'SCHEMA',
    'wrong-path': 'MANIFEST_MISMATCH',
  };
  for (const [mode, reason] of Object.entries(modes))
    await t.test(mode, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': source(2) });
      f.mode(mode);
      const { result, report } = f.run();
      assert.equal(gate(report, 'complexity').state, 'INCONCLUSIVE');
      assert.equal(result.status, 2);
      assert.equal(report.check_conclusion, 'failure');
      assert.ok(
        codes(report).includes(reason),
        `expected ${reason}; received ${codes(report).join(', ')}`,
      );
    });
});

test('candidate parse errors fail closed even when cccc exits zero', (t) => {
  const f = fixture(
    t,
    {},
    { 'src/a.ts': source(0, { functions: [], parse_errors: ['Unexpected token'] }) },
  );
  const { result, report } = f.run();
  assert.equal(gate(report, 'complexity').state, 'INCONCLUSIVE');
  assert.equal(result.status, 2);
  assert.ok(codes(report).includes('PARSE_ERROR_CANDIDATE'));
});

test('invalid baseline parse cannot supply a legacy debt allowance', (t) => {
  const f = fixture(
    t,
    { 'src/a.ts': source(22, { parse_errors: ['Baseline invalid'] }) },
    { 'src/a.ts': source(20) },
  );
  const { report } = f.run();
  assert.equal(gate(report, 'complexity').state, 'FAIL');
  assert.ok(gate(report, 'complexity').violations.some((v) => v.limit === 15));
});

test('pinned binary hash mismatch is an analysis failure', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(2) });
  f.policy.measurement.sha256 = '0'.repeat(64);
  const { result, report } = f.run();
  assert.equal(result.status, 2);
  assert.ok(codes(report).includes('MEASURER_MISMATCH'));
});

test('candidate config and .gitattributes cannot alter blob measurement or execute code', (t) => {
  const f = fixture(
    t,
    {},
    {
      'src/a.ts': source(16),
      '.gitattributes': '*.ts working-tree-encoding=UTF-16\n',
      'cccc.toml': 'exclude=["src/**"]\n',
      'eslint.config.js': 'throw new Error("CANDIDATE_CONFIG_EXECUTED");\n',
    },
  );
  // Deliberately replace working-tree bytes after committing. Analysis must use C blobs.
  f.put('src/a.ts', source(0));
  const { result, report } = f.run();
  assert.equal(result.status, 1);
  assert.equal(gate(report, 'complexity').state, 'FAIL');
  assert.ok(gate(report, 'complexity').violations.some((v) => v.after === 16));
  assert.ok(report.triggers.some((trigger) => trigger.id === 'S11'));
});

test('unregistered source extension cannot disappear from scope', (t) => {
  const f = fixture(t, {}, { 'src/hidden.evil': 'export function hidden() { return true; }\n' });
  const { result, report } = f.run();
  assert.equal(result.status, 2);
  assert.equal(report.state, 'INCONCLUSIVE');
  assert.ok(codes(report).length > 0);
});

test('case-colliding Git paths fail closed on Linux', (t) => {
  const f = fixture(t, {}, { 'src/A.ts': source(1), 'src/a.ts': source(1) });
  const { result, report } = f.run();
  assert.equal(result.status, 2);
  assert.equal(report.state, 'INCONCLUSIVE');
});

test('non-UTF8 code and LFS pointers are not interpreted as zero complexity', async (t) => {
  for (const [name, content] of [
    ['encoding', Buffer.from([0xff, 0xfe, 0x61, 0])],
    [
      'lfs',
      'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n',
    ],
  ]) {
    await t.test(name, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': content });
      const { result, report } = f.run();
      assert.equal(result.status, 2);
      assert.equal(report.state, 'INCONCLUSIVE');
    });
  }
});

test('validly signed evidence with zero executed tests is inconclusive', (t) => {
  const f = fixture(t, {}, { 'src/a.ts': source(2) });
  f.policy.gates.tests = 'enforce';
  const signEvidence = evidenceSigner(f);
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0, tests: [] };
  const evidencePath = signEvidence({ tests: { base: tests, candidate: tests } });
  const { result, report } = f.run({}, [
    '--evidence',
    evidencePath,
    '--repository',
    'fixture/repo',
  ]);
  assert.equal(report.evidence_verified, true);
  assert.equal(gate(report, 'tests').state, 'INCONCLUSIVE');
  assert.equal(result.status, 2);
});

test('signed test evidence remains independent of passing complexity', async (t) => {
  for (const [status, expected, exit] of [
    ['passed', 'PASS', 0],
    ['failed', 'FAIL', 1],
  ])
    await t.test(status, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': source(2) });
      f.policy.gates.tests = 'enforce';
      const signEvidence = evidenceSigner(f);
      const evidencePath = signEvidence({
        tests: { base: testReport(), candidate: testReport(status) },
      });
      const { result, report } = f.run({}, [
        '--evidence',
        evidencePath,
        '--repository',
        'fixture/repo',
      ]);
      assert.equal(report.evidence_verified, true);
      assert.equal(gate(report, 'complexity').state, 'PASS');
      assert.equal(gate(report, 'tests').state, expected);
      assert.equal(result.status, exit);
    });
});

test('signed evidence from the wrong immutable context cannot be replayed', async (t) => {
  const staleFields = {
    base_sha: 'a'.repeat(40),
    candidate_sha: 'b'.repeat(40),
    policy_revision: 'old-policy',
    policy_sha256: '0'.repeat(64),
    measurement_fingerprint: '1'.repeat(64),
    repository: 'other/repo',
    issued_at: new Date(Date.now() - 600_000).toISOString(),
  };
  for (const [field, value] of Object.entries(staleFields))
    await t.test(field, (t) => {
      const f = fixture(t, {}, { 'src/a.ts': source(2) });
      f.policy.gates.tests = 'enforce';
      const signEvidence = evidenceSigner(f);
      const evidencePath = signEvidence({
        [field]: value,
        tests: { base: testReport(), candidate: testReport() },
      });
      const { result, report } = f.run({}, [
        '--evidence',
        evidencePath,
        '--repository',
        'fixture/repo',
      ]);
      assert.equal(report.evidence_verified, false);
      assert.equal(result.status, 2);
      assert.ok(codes(report).includes('EVIDENCE_REJECTED'));
    });
});
