import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { zipSync } from 'fflate';
import { attestEvidence, extractReport, validateAttestorConfig } from '../dist/attestor.js';
import { verifyEvidence, independent } from '../dist/evidence.js';
import { canonical, sha256 } from '../dist/policy.js';
const B = 'a'.repeat(40),
  C = 'b'.repeat(40),
  PIN = 'c'.repeat(40),
  NOW = Date.now();
const report = (head) => ({
  schema_version: 1,
  head_sha: head,
  tests: {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    tests: [{ id: 'src/a.test.ts::works', status: 'passed', assertions: 1 }],
  },
  coverage: { provider: 'istanbul', version: '1', files: {} },
  mutation: { killed: 1, survived: 0, timeout: 0, no_coverage: 0 },
});
async function fixture(t, mutation = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nyorori-attestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const keys = generateKeyPairSync('ed25519');
  const keyPath = path.join(root, 'signing.pem');
  await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  const policy = JSON.parse(
    await readFile(new URL('../examples/policy.json', import.meta.url), 'utf8'),
  );
  policy.measurement.binary = path.join(root, 'cccc');
  policy.measurement.sha256 = 'd'.repeat(64);
  policy.evidence = {
    issuer: 'fixture-attestor',
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    max_age_seconds: 86400,
  };
  policy.identities = {
    simplification_reviewers: ['reviewer'],
    waiver_approvers: ['waiver'],
    gate_owners: ['owner'],
    bots: ['agent[bot]'],
  };
  const policyPath = path.join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  const hash = sha256(canonical(policy));
  const config = {
    schema_version: 1,
    repository: 'acme/app',
    issuer: 'fixture-attestor',
    workflow: {
      id: 42,
      path: '.github/workflows/tests.yml',
      sha256: sha256('name: trusted fixture\n'),
      reusable: { path: 'acme/trusted/.github/workflows/evidence.yml', sha: PIN },
    },
    base_event: 'push',
    candidate_event: 'merge_group',
    artifact_name: 'nyorori-evidence',
    report_file: 'report.json',
    max_age_seconds: 86400,
  };
  const configPath = path.join(root, 'attestor.json');
  await writeFile(configPath, JSON.stringify(config));
  const fingerprint = {
    cccc_version: 'cccc 1.8.5',
    cccc_sha256: policy.measurement.sha256,
    runner_commit: 'e'.repeat(64),
    policy_revision: policy.revision,
    arguments: ['--no-config', '--no-cache'],
    toolchain_sha256: 'f'.repeat(64),
  };
  const context = {
    schema_version: 1,
    authority: 'local',
    repository: 'acme/app',
    base_sha: B,
    candidate_sha: C,
    policy_revision: policy.revision,
    policy_sha256: hash,
    measurement_fingerprint: fingerprint,
  };
  const contextPath = path.join(root, 'gate-result.json');
  await writeFile(contextPath, JSON.stringify(context));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    let side = u.searchParams.get('ref') === B || u.pathname.includes('101') ? 'B' : 'C';
    let value;
    if (u.hostname === 'artifacts.githubusercontent.com') {
      assert.equal(init.headers.Authorization, undefined, 'GitHub token must not follow redirect');
      side = u.pathname.includes('101') ? 'B' : 'C';
      const body = report(side === 'B' ? B : C);
      mutation('report', side, body);
      return new Response(
        zipSync(
          { 'report.json': Buffer.from(JSON.stringify(body)) },
          { mtime: new Date('2026-01-01T00:00:00Z') },
        ),
      );
    }
    assert.equal(u.origin, 'https://api.github.com');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(init.redirect, 'manual');
    const run = side === 'B' ? 101 : 102,
      sha = side === 'B' ? B : C;
    if (u.pathname.includes('/contents/'))
      value = {
        type: 'file',
        path: config.workflow.path,
        encoding: 'base64',
        size: Buffer.byteLength('name: trusted fixture\n'),
        content: Buffer.from('name: trusted fixture\n').toString('base64'),
      };
    else if (/\/attempts\//.test(u.pathname))
      value = {
        id: run,
        run_attempt: 1,
        head_sha: sha,
        event: side === 'B' ? 'push' : 'merge_group',
        status: 'completed',
        conclusion: 'success',
        workflow_id: 42,
        path: config.workflow.path,
        repository: { full_name: 'acme/app' },
        head_repository: { full_name: 'acme/app' },
        referenced_workflows: [{ path: config.workflow.reusable.path + '@' + PIN, sha: PIN }],
        updated_at: new Date(NOW - 1000).toISOString(),
        run_started_at: new Date(NOW - 5000).toISOString(),
      };
    else if (u.pathname.endsWith('/artifacts')) {
      const body = report(sha);
      mutation('report', side, body);
      const zip = zipSync(
        { 'report.json': Buffer.from(JSON.stringify(body)) },
        { mtime: new Date('2026-01-01T00:00:00Z') },
      );
      value = {
        total_count: 1,
        artifacts: [
          {
            id: run + 1000,
            name: config.artifact_name,
            expired: false,
            size_in_bytes: zip.length,
            digest: 'sha256:' + sha256(zip),
            workflow_run: { id: run, head_sha: sha },
            created_at: new Date(NOW - 2000).toISOString(),
          },
        ],
      };
    } else if (u.pathname.endsWith('/zip'))
      return new Response(null, {
        status: 302,
        headers: { location: `https://artifacts.githubusercontent.com/${run}.zip` },
      });
    else throw new Error('Unexpected test API route ' + u.pathname);
    mutation(
      u.pathname.endsWith('/artifacts')
        ? 'artifacts'
        : u.pathname.includes('/contents/')
          ? 'workflow'
          : 'run',
      side,
      value,
    );
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const options = {
    repo,
    configPath,
    policyPath,
    contextPath,
    keyPath,
    baseRun: 101,
    baseAttempt: 1,
    candidateRun: 102,
    candidateAttempt: 1,
    out: path.join(root, 'signed.json'),
    token: 'fixture-token',
    fetch,
    now: () => NOW,
  };
  return { root, repo, policy, hash, config, context, options, calls };
}
test('attestor verifies B/C workflow attempts, pinned reusable SHA and artifact digest before signing', async (t) => {
  const f = await fixture(t);
  const envelope = await attestEvidence(f.options);
  assert.equal(envelope.payload.tests.candidate.passed, 1);
  assert.equal(envelope.payload.candidate_sha, C);
  assert.equal(envelope.payload.reviews, undefined);
  assert.equal(envelope.payload.provenance.approval_authority, 'none');
  assert.equal(
    independent('reviewer', envelope.payload, f.policy, 'simplification_reviewers'),
    false,
  );
  assert.equal(independent('waiver', envelope.payload, f.policy, 'waiver_approvers'), false);
  const result = await verifyEvidence(
    f.options.out,
    {
      repository: 'acme/app',
      base_sha: B,
      candidate_sha: C,
      policy_revision: f.policy.revision,
      policy_sha256: f.hash,
      measurement_fingerprint: sha256(canonical(f.context.measurement_fingerprint)),
    },
    f.policy,
  );
  assert.equal(result.verified, true);
  const signatureResult = await import('node:crypto').then(({ verify }) =>
    verify(
      null,
      Buffer.from(canonical(envelope.payload)),
      f.policy.evidence.public_key,
      Buffer.from(envelope.signature, 'base64'),
    ),
  );
  assert.equal(signatureResult, true);
  assert.equal(f.calls.length, 10);
});
test('attestor preserves failed tests when GitHub workflow also failed', async (t) => {
  const f = await fixture(t, (kind, side, v) => {
    if (side !== 'C') return;
    if (kind === 'run') v.conclusion = 'failure';
    if (kind === 'report') {
      v.tests.passed = 0;
      v.tests.failed = 1;
      v.tests.tests[0].status = 'failed';
    }
  });
  const envelope = await attestEvidence(f.options);
  assert.equal(envelope.payload.tests.candidate.failed, 1);
});
test('run repository, head, attempt, event, workflow source and lifecycle are independently rejected', async (t) => {
  const cases = [
    ['repository', (v) => (v.repository.full_name = 'evil/app')],
    ['head', (v) => (v.head_sha = B)],
    ['attempt', (v) => (v.run_attempt = 2)],
    ['event', (v) => (v.event = 'pull_request_target')],
    ['workflow', (v) => (v.workflow_id = 43)],
    ['reusable', (v) => (v.referenced_workflows[0].sha = B)],
    ['missing reusable', (v) => delete v.referenced_workflows],
    ['status', (v) => (v.status = 'in_progress')],
    ['age', (v) => (v.updated_at = new Date(NOW - 2 * 86400000).toISOString())],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async (st) => {
      const f = await fixture(st, (kind, side, v) => {
        if (kind === 'run' && side === 'C') mutate(v);
      });
      await assert.rejects(attestEvidence(f.options), /Workflow|workflow|provenance/i);
    });
});
test('artifact missing, duplicated, expired, replayed, digest drift and wrong head never sign', async (t) => {
  const cases = [
    [
      'missing',
      (v) => {
        v.artifacts = [];
        v.total_count = 0;
      },
    ],
    [
      'duplicate',
      (v) => {
        v.artifacts.push(v.artifacts[0]);
        v.total_count = 2;
      },
    ],
    ['expired', (v) => (v.artifacts[0].expired = true)],
    ['wrong head', (v) => (v.artifacts[0].workflow_run.head_sha = B)],
    ['old attempt', (v) => (v.artifacts[0].created_at = new Date(NOW - 10000).toISOString())],
    ['digest', (v) => (v.artifacts[0].digest = 'sha256:' + '0'.repeat(64))],
    ['no digest', (v) => delete v.artifacts[0].digest],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async (st) => {
      const f = await fixture(st, (kind, side, v) => {
        if (kind === 'artifacts' && side === 'C') mutate(v);
      });
      await assert.rejects(attestEvidence(f.options), /artifact|Artifact|named/i);
    });
});
test('candidate artifact can never inject approval authority or replay its report head', async (t) => {
  for (const [name, mutate] of [
    ['authority', (v) => (v.actors = { author: 'forged' })],
    ['review', (v) => (v.reviews = [])],
    ['wrong head', (v) => (v.head_sha = B)],
    ['counts', (v) => (v.tests.total = 2)],
  ])
    await t.test(name, async (st) => {
      const f = await fixture(st, (kind, side, v) => {
        if (kind === 'report' && side === 'C') mutate(v);
      });
      await assert.rejects(attestEvidence(f.options), /Artifact|authority/i);
    });
});
test('artifact redirect is allowlisted and credentials never reach untrusted host', async (t) => {
  const f = await fixture(t);
  const original = f.options.fetch;
  f.options.fetch = async (url, init) =>
    url.endsWith('/zip')
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/report.zip' },
        })
      : original(url, init);
  await assert.rejects(attestEvidence(f.options), /destination rejected/);
  assert.ok(f.calls.every((x) => !x.url.includes('evil.example')));
});
test('ZIP reader rejects traversal, extras, oversized headers and CRC drift without extracting files', () => {
  const good = Buffer.from(zipSync({ 'report.json': Buffer.from('{}') }));
  assert.equal(extractReport(good).toString(), '{}');
  assert.throws(
    () => extractReport(Buffer.from(zipSync({ '../report.json': Buffer.from('{}') }))),
    /entry name/,
  );
  assert.throws(
    () =>
      extractReport(
        Buffer.from(zipSync({ 'report.json': Buffer.from('{}'), 'extra.txt': Buffer.from('x') })),
      ),
    /exactly one/,
  );
  const offset = good.readUInt32LE(good.length - 6);
  const large = Buffer.from(good);
  large.writeUInt32LE(8000001, offset + 24);
  assert.throws(() => extractReport(large), /oversized/);
  const crc = Buffer.from(good);
  crc.writeUInt32LE(1, 14);
  crc.writeUInt32LE(1, offset + 16);
  assert.throws(() => extractReport(crc), /CRC/);
  const bomb = Buffer.from(zipSync({ 'report.json': Buffer.from('x'.repeat(100000)) }));
  const off = bomb.readUInt32LE(bomb.length - 6);
  bomb.writeUInt32LE(1, 22);
  bomb.writeUInt32LE(1, off + 24);
  assert.throws(() => extractReport(bomb), /decompression|limit/);
});
test('trusted context, policy issuer, key privacy and output protection are required', async (t) => {
  await t.test('context', async (st) => {
    const f = await fixture(st);
    f.context.policy_sha256 = '0'.repeat(64);
    await writeFile(f.options.contextPath, JSON.stringify(f.context));
    await assert.rejects(attestEvidence(f.options), /context/);
  });
  await t.test('key', async (st) => {
    const f = await fixture(st);
    await chmod(f.options.keyPath, 0o644);
    await assert.rejects(attestEvidence(f.options), /private regular file/);
  });
  await t.test('candidate config', async (st) => {
    const f = await fixture(st);
    f.options.configPath = path.join(f.repo, 'attestor.json');
    await writeFile(f.options.configPath, JSON.stringify(f.config));
    await assert.rejects(attestEvidence(f.options), /outside/);
  });
  await t.test('output', async (st) => {
    const f = await fixture(st);
    await writeFile(f.options.out, 'keep');
    await assert.rejects(attestEvidence(f.options), /EEXIST/);
    assert.equal(await readFile(f.options.out, 'utf8'), 'keep');
  });
});
test('operator control-plane authority is separate from artifacts, context-bound and independently checked', async (t) => {
  const f = await fixture(t);
  const authority = {
    schema_version: 1,
    repository: 'acme/app',
    base_sha: B,
    candidate_sha: C,
    policy_revision: f.policy.revision,
    policy_sha256: f.hash,
    measurement_fingerprint: sha256(canonical(f.context.measurement_fingerprint)),
    issued_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 10000).toISOString(),
    actors: { author: 'alice', participants: ['bob'], agent_initiators: ['initiator'] },
  };
  f.options.authorityPath = path.join(f.root, 'authority.json');
  await writeFile(f.options.authorityPath, JSON.stringify(authority));
  const envelope = await attestEvidence(f.options);
  assert.equal(envelope.payload.actors.author, 'alice');
  assert.equal(envelope.payload.provenance.approval_authority, 'operator-file');
});
test('attestor config refuses unpinned or attacker-controlled API/repository paths', () => {
  const config = {
    schema_version: 1,
    repository: '../app',
    issuer: 'x',
    workflow: {
      id: 1,
      path: '.github/workflows/a.yml',
      sha256: 'f'.repeat(64),
      reusable: { path: 'acme/gates/.github/workflows/a.yml', sha: PIN },
    },
    base_event: 'push',
    candidate_event: 'merge_group',
    artifact_name: 'x',
    report_file: 'report.json',
    max_age_seconds: 1,
  };
  assert.throws(() => validateAttestorConfig(config), /repository/);
  config.repository = 'acme/app';
  config.workflow.reusable.sha = 'main';
  assert.throws(() => validateAttestorConfig(config), /pinned/);
});

test('same workflow id/path and pinned reusable cannot hide modified caller workflow content', async (t) => {
  const f = await fixture(t, (kind, side, v) => {
    if (kind === 'workflow' && side === 'C') {
      const body = 'name: attacker caller\njobs:\n  forge-artifact: {}\n';
      v.content = Buffer.from(body).toString('base64');
      v.size = Buffer.byteLength(body);
    }
  });
  await assert.rejects(attestEvidence(f.options), /caller workflow SHA256 mismatch/);
});
