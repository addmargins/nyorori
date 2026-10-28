import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, loadPolicy, within, validatePolicy } from '../dist/policy.js';
import { buildSnapshot } from '../dist/git.js';
import { verifyEvidence, independent, validReview, applyWaivers } from '../dist/evidence.js';
import { runGate } from '../dist/runner.js';
import { runAnalysisWorker } from '../dist/worker.js';

function policy(binary) {
  return {
    schema_version: 1,
    revision: 'security-fixture',
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
      binary,
      sha256: 'a'.repeat(64),
      version: 'cccc 1.8.5',
      timeout_ms: 1000,
      jobs: 1,
      max_file_bytes: 2000000,
      jsx_in_js: false,
    },
    scope: {
      source_extensions: ['.ts'],
      unmeasured_extensions: ['.vue'],
      non_code_extensions: ['.md', '.json'],
      test_globs: [],
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
    identities: { simplification_reviewers: [], waiver_approvers: [], gate_owners: [], bots: [] },
    coverage: { provider: 'istanbul', version: '1' },
    waiver: { max_per_pr: 0, max_days: 1 },
  };
}
function git(repo, ...args) {
  return execFileSync('git', ['--literal-pathspecs', '-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'nyorori-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q');
  return { root, repo };
}

test('trusted policy cannot hide in candidate checkout by selecting a repository subdirectory', async (t) => {
  const { root, repo } = await setup(t);
  await mkdir(join(repo, 'src'));
  const file = join(repo, 'policy.json');
  await writeFile(file, JSON.stringify(policy(join(root, 'cccc'))));
  await assert.rejects(loadPolicy(file, join(repo, 'src')), /outside|root|repository/i);
});

test('trusted policy symlink resolving into checkout is rejected', async (t) => {
  const { root, repo } = await setup(t);
  const file = join(repo, 'policy.json');
  await writeFile(file, JSON.stringify(policy(join(root, 'cccc'))));
  const link = join(root, 'policy-link.json');
  await symlink(file, link);
  await assert.rejects(loadPolicy(link, repo), /outside|repository/i);
});

test('external trusted policy supports the bare mirrors required by the App service', async (t) => {
  const { root } = await setup(t);
  const mirror = join(root, 'mirror.git');
  await mkdir(mirror);
  git(mirror, 'init', '--bare', '-q');
  const file = join(root, 'trusted-policy.json');
  await writeFile(file, JSON.stringify(policy(join(root, 'cccc'))));
  const loaded = await loadPolicy(file, mirror);
  assert.equal(loaded.policy.revision, 'security-fixture');
});

test('external binary symlink resolving into candidate checkout is rejected', async (t) => {
  const { root, repo } = await setup(t);
  const binary = join(repo, 'cccc');
  await writeFile(binary, 'not executed');
  const link = join(root, 'cccc-link');
  await symlink(binary, link);
  const file = join(root, 'policy.json');
  await writeFile(file, JSON.stringify(policy(link)));
  await assert.rejects(loadPolicy(file, repo), /outside|repository/i);
});

test('path containment separates a sibling sharing repository prefix', () => {
  assert.equal(within('/checkout/repo', '/checkout/repo-other/policy.json'), false);
  assert.equal(within('/checkout/repo', '/checkout/repo/policy.json'), true);
});

test('a candidate child directory starting with two dots is still inside the repository', () => {
  assert.equal(within('/repo', '/repo/..trusted/policy.json'), true);
});

test('candidate policy under a two-dot-prefixed directory cannot be accepted as external', async (t) => {
  const { root, repo } = await setup(t);
  const directory = join(repo, '..trusted');
  await mkdir(directory);
  const file = join(directory, 'policy.json');
  await writeFile(file, JSON.stringify(policy(join(root, 'cccc'))));
  await assert.rejects(loadPolicy(file, repo), /outside|repository/i);
});

test('policy rejects coercible gate modes that would disappear from enforcement', () => {
  const invalidMode = policy('/external/cccc');
  invalidMode.gates.complexity = ['enforce'];
  assert.throws(() => validatePolicy(invalidMode), /mode|gate/i);
  const invalidPhase = policy('/external/cccc');
  invalidPhase.phase = ['P2'];
  assert.throws(() => validatePolicy(invalidPhase), /phase/i);
});

test('runner rejects output symlinks, checkout output and nonempty output without overwriting files', async (t) => {
  const { root, repo } = await setup(t);
  await writeFile(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'candidate\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'candidate');
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy(join(root, 'cccc'))));
  const target = join(root, 'target');
  await mkdir(target);
  const link = join(root, 'output-link');
  await symlink(target, link);
  const opts = { repo, base, candidate: 'HEAD', policyPath };
  await assert.rejects(runGate({ ...opts, out: link }), /Output|output/i);
  await assert.rejects(runGate({ ...opts, out: join(repo, 'output') }), /outside|repository/i);
  await writeFile(join(target, 'keep.txt'), 'preserved');
  await assert.rejects(runGate({ ...opts, out: target }), /empty|Output|output/i);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'preserved');
});

test('production analysis worker strips inherited Node preload execution', async (t) => {
  const { root, repo } = await setup(t);
  await writeFile(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'candidate\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'candidate');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy(join(root, 'cccc'))));
  const marker = join(root, 'preload-executed');
  const preload = join(root, 'preload.cjs');
  await writeFile(
    preload,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`,
  );
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  t.after(() => {
    if (old === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = old;
  });
  const result = await runAnalysisWorker(
    { repo, base, candidate, policyPath, out: join(root, 'out'), repository: 'fixture/repo' },
    30000,
  );
  assert.equal(result.state, 'NOT_APPLICABLE');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Git pathspec-like source filename cannot include another file in unit line mapping', async (t) => {
  const { root, repo } = await setup(t);
  const magic = ':(glob)*.ts';
  await writeFile(join(repo, magic), 'export function magic() { return 1; }\n');
  await writeFile(join(repo, 'other.ts'), 'export function other() { return 1; }\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, magic), 'export function magic() { return 2; }\n');
  await writeFile(join(repo, 'other.ts'), '// added\nexport function other() { return 1; }\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'candidate');
  const snapshot = await buildSnapshot(repo, base, 'HEAD', policy(join(root, 'cccc')));
  assert.deepEqual(snapshot.issues, []);
  const change = snapshot.files.find((f) => f.newPath === magic);
  assert.ok(change);
  assert.deepEqual(change.hunks, [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
});

test('declaration-only paths cannot bypass implementation inspection through size or encoding', async (t) => {
  for (const invalid of ['oversized', 'encoding'])
    await t.test(invalid, async (t) => {
      const { root, repo } = await setup(t);
      await writeFile(join(repo, 'types.d.ts'), 'declare const value: string;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'base');
      const base = git(repo, 'rev-parse', 'HEAD');
      await writeFile(
        join(repo, 'types.d.ts'),
        invalid === 'oversized'
          ? '//' + 'x'.repeat(2000) + '\nconst runtime = (() => { return true; })();\n'
          : Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      );
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'candidate');
      const p = policy(join(root, 'cccc'));
      p.measurement.max_file_bytes = 1000;
      const snapshot = await buildSnapshot(repo, base, 'HEAD', p);
      assert.ok(
        snapshot.issues.some(
          (i) => i.code === (invalid === 'oversized' ? 'FILE_TOO_LARGE' : 'MANIFEST_MISMATCH'),
        ),
      );
    });
});

test('signed evidence is rejected after payload tampering or context replay', async (t) => {
  const { root } = await setup(t);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const p = policy(join(root, 'cccc'));
  p.evidence = {
    public_key: publicKey.export({ type: 'spki', format: 'pem' }),
    issuer: 'security-issuer',
    max_age_seconds: 60,
  };
  const context = {
    repository: 'owner/repo',
    base_sha: 'a'.repeat(40),
    candidate_sha: 'b'.repeat(40),
    policy_revision: p.revision,
    policy_sha256: 'c'.repeat(64),
    measurement_fingerprint: 'd'.repeat(64),
  };
  const payload = {
    schema_version: 1,
    issuer: 'security-issuer',
    ...context,
    issued_at: new Date().toISOString(),
    actors: { author: 'Author', participants: [], agent_initiators: [] },
  };
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64');
  const file = join(root, 'evidence.json');
  await writeFile(file, JSON.stringify({ payload, signature }));
  assert.equal((await verifyEvidence(file, context, p)).verified, true);
  assert.equal(
    (await verifyEvidence(file, { ...context, candidate_sha: 'e'.repeat(40) }, p)).verified,
    false,
  );
  assert.equal(
    (await verifyEvidence(file, { ...context, policy_sha256: 'e'.repeat(64) }, p)).verified,
    false,
  );
  assert.equal(
    (await verifyEvidence(file, { ...context, measurement_fingerprint: 'e'.repeat(64) }, p))
      .verified,
    false,
  );
  await writeFile(
    file,
    JSON.stringify({
      payload: {
        ...payload,
        actors: { author: 'different', participants: [], agent_initiators: [] },
      },
      signature,
    }),
  );
  assert.equal((await verifyEvidence(file, context, p)).verified, false);
});

test('approver independence uses case-insensitive identities and excludes participants, initiators and bots', () => {
  const p = policy('/external/cccc');
  const e = {
    actors: { author: 'Author', participants: ['Committer'], agent_initiators: ['Initiator'] },
  };
  p.identities.simplification_reviewers = [
    'author',
    'committer',
    'initiator',
    'Helper[bot]',
    'Reviewer',
    'ConfiguredBot',
  ];
  p.identities.bots = ['configuredBOT'];
  for (const actor of ['AUTHOR', 'COMMITTER', 'INITIATOR', 'helper[bot]', 'configuredBot'])
    assert.equal(independent(actor, e, p, 'simplification_reviewers'), false);
  assert.equal(independent('reviewer', e, p, 'simplification_reviewers'), true);
});

test('review approval binds current candidate and complete independent rubric', () => {
  const p = policy('/external/cccc');
  p.identities.simplification_reviewers = ['Reviewer'];
  const e = {
    candidate_sha: 'b'.repeat(40),
    actors: { author: 'Author', participants: [], agent_initiators: [] },
  };
  const review = {
    id: 'r1',
    actor: 'reviewer',
    head_sha: e.candidate_sha,
    decision: 'NO_SIMPLIFICATION_NEEDED',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    rubric: Array.from({ length: 5 }, (_, i) => ({
      question: i + 1,
      answer: true,
      evidence: 'src/file.ts:1 assessed',
    })),
  };
  assert.equal(validReview(review, e, p), true);
  assert.equal(validReview({ ...review, head_sha: 'c'.repeat(40) }, e, p), false);
  assert.equal(validReview({ ...review, actor: 'author' }, e, p), false);
  assert.equal(validReview({ ...review, rubric: review.rubric.slice(0, 4) }, e, p), false);
});

test('waiver cannot clear an inconclusive result or transfer to a different blob', () => {
  const p = policy('/external/cccc');
  p.waiver.max_per_pr = 2;
  p.identities.waiver_approvers = ['Reviewer'];
  const e = {
    candidate_sha: 'b'.repeat(40),
    actors: { author: 'Author', participants: [], agent_initiators: [] },
    waivers: [
      {
        id: 'w1',
        actor: 'Reviewer',
        head_sha: 'b'.repeat(40),
        unit: 'src/file.ts::unit',
        blob_sha: 'a'.repeat(40),
        gate: 'complexity',
        metric: 'cognitive',
        ceiling: 22,
        reason: 'Temporary bounded debt',
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    ],
  };
  const result = {
    gate: 'complexity',
    state: 'INCONCLUSIVE',
    mode: 'enforce',
    reasons: [],
    violations: [
      {
        unit: 'src/file.ts::unit',
        file: 'src/file.ts',
        line: 1,
        blob_sha: 'a'.repeat(40),
        after: 22,
      },
    ],
    triggers: [],
    issues: [{ code: 'SCHEMA', message: 'incomplete measurement' }],
    observe: {},
  };
  assert.equal(applyWaivers(structuredClone(result), e, p).state, 'INCONCLUSIVE');
  const wrongBlob = {
    ...result,
    state: 'FAIL',
    issues: [],
    violations: [{ ...result.violations[0], blob_sha: 'c'.repeat(40) }],
  };
  assert.equal(applyWaivers(wrongBlob, e, p).state, 'FAIL');
});
