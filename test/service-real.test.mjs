import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { runGate } from '../dist/runner.js';
import { canonical, sha256 } from '../dist/policy.js';
import { runAnalysisWorker } from '../dist/worker.js';
import { createWebhookServer } from '../dist/server.js';

const binary = process.env.NYORORI_REAL_CCCC;
test(
  'real bare mirror + pinned cccc + signed evidence service path fails closed then resumes',
  { skip: !binary, timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nyorori-service-real-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const work = join(root, 'work'),
      mirror = join(root, 'mirror.git');
    await mkdir(work);
    const git = (...args) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', work, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Service Fixture');
    git('config', 'user.email', 'service@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(work, 'README.md'), 'Real service integration fixture\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await mkdir(join(work, 'src'));
    await writeFile(
      join(work, 'src/calculator.ts'),
      'export function abs(value: number): number {\n  if (value < 0) return -value;\n  return value;\n}\n',
    );
    git('add', '.');
    git('commit', '-qm', 'candidate');
    const candidate = git('rev-parse', 'HEAD');
    execFileSync('git', ['clone', '--bare', '--no-hardlinks', work, mirror], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const gates = [
      'complexity',
      'lint-structure',
      'deps',
      'tests',
      'coverage',
      'simplification-review',
      'mutation',
    ];
    const policy = {
      schema_version: 1,
      revision: 'real-service-v1',
      phase: 'P2',
      gates: Object.fromEntries(
        gates.map((g) => [g, ['coverage', 'mutation'].includes(g) ? 'observe' : 'enforce']),
      ),
      measurement: {
        binary,
        sha256: createHash('sha256')
          .update(await readFile(binary))
          .digest('hex'),
        version: 'cccc 1.8.5',
        timeout_ms: 120000,
        jobs: 4,
        max_file_bytes: 2000000,
        jsx_in_js: false,
      },
      scope: {
        source_extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
        unmeasured_extensions: ['.vue', '.svelte', '.astro', '.mdx'],
        non_code_extensions: ['.md', '.json', '.txt', '.yaml', '.yml', '.toml'],
        test_globs: ['**/*.test.ts'],
        exclude_globs: [],
        protected_globs: ['.github/**', 'package.json', '**/tsconfig*.json'],
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
      coverage: { provider: 'istanbul', version: 'fixture-1' },
      waiver: { max_per_pr: 2, max_days: 90 },
      evidence: {
        public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        issuer: 'service-fixture-attestor',
        max_age_seconds: 300,
      },
    };
    const policyPath = join(root, 'policy.json');
    await writeFile(policyPath, JSON.stringify(policy));
    const probe = await runGate({
      repo: mirror,
      base,
      candidate,
      policyPath,
      out: join(root, 'probe'),
      repository: 'acme/app',
    });
    assert.equal(probe.gates.find((g) => g.gate === 'complexity').state, 'PASS');
    assert.equal(probe.gates.find((g) => g.gate === 'tests').state, 'INCONCLUSIVE');
    const evidenceDir = join(root, 'evidence');
    await mkdir(evidenceDir);
    const webhookSecret = Buffer.from('real-service-test-webhook-secret-value'),
      operatorToken = Buffer.from('real-service-test-operator-token-more-than-32-bytes');
    const calls = [];
    const { server, drain } = await createWebhookServer(
      {
        host: '127.0.0.1',
        port: 0,
        data_dir: join(root, 'state'),
        app_id: 123,
        private_key_file: '/run/secrets/app',
        webhook_secret_file: '/run/secrets/webhook',
        operator_token_file: '/run/secrets/operator',
        workers: 1,
        max_queue: 4,
        repositories: [
          {
            name: 'acme/app',
            installation_id: 42,
            repo: mirror,
            policy: policyPath,
            evidence_dir: evidenceDir,
          },
        ],
      },
      {
        webhookSecret,
        operatorToken,
        run: runAnalysisWorker,
        checks: {
          start: async () => 123,
          complete: async (...args) => {
            calls.push(args);
          },
        },
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`,
      id = randomUUID();
    const raw = JSON.stringify({
      action: 'checks_requested',
      repository: { full_name: 'acme/app' },
      installation: { id: 42 },
      merge_group: { base_sha: base, head_sha: candidate },
    });
    const priorNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--require /nonexistent/nyorori-must-not-inherit.cjs';
    t.after(() => {
      if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorNodeOptions;
    });
    const response = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'merge_group',
        'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
    assert.equal(response.status, 202);
    await drain();
    assert.equal(calls.at(-1)[3], 'failure');
    const first = JSON.parse(
      await readFile(join(root, 'state', 'runs', id, '1', 'app-result.json'), 'utf8'),
    );
    assert.equal(first.state, 'INCONCLUSIVE');
    assert.equal(first.evidence_verified, false);
    // This signed test-report fixture exercises signature/provenance binding, not a real Actions workflow.
    const report = {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      tests: [{ id: 'fixture::abs handles sign', status: 'passed', assertions: 1 }],
    };
    const payload = {
      schema_version: 1,
      issuer: policy.evidence.issuer,
      repository: 'acme/app',
      base_sha: base,
      candidate_sha: candidate,
      policy_revision: policy.revision,
      policy_sha256: sha256(canonical(policy)),
      measurement_fingerprint: sha256(canonical(probe.measurement_fingerprint)),
      issued_at: new Date().toISOString(),
      actors: { author: 'fixture-author', participants: ['fixture-author'], agent_initiators: [] },
      tests: { base: report, candidate: report },
    };
    await writeFile(
      join(evidenceDir, `${base}-${candidate}.json`),
      JSON.stringify({
        payload,
        signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64'),
      }),
    );
    const retry = await fetch(`${origin}/jobs/${id}/retry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(retry.status, 202);
    await drain();
    assert.equal(calls.at(-1)[3], 'success');
    const final = JSON.parse(
      await readFile(join(root, 'state', 'runs', id, '2', 'app-result.json'), 'utf8'),
    );
    assert.equal(final.authority, 'github-app');
    assert.equal(final.state, 'PASS');
    assert.equal(final.evidence_verified, true);
    assert.equal(final.base_sha, base);
    assert.equal(final.candidate_sha, candidate);
    assert.equal(final.gates.find((g) => g.gate === 'tests').state, 'PASS');
    assert.equal(final.measurement_fingerprint.cccc_sha256, policy.measurement.sha256);
    const rawMeasured = JSON.parse(
      await readFile(join(root, 'state', 'runs', id, '2', 'raw.C.json'), 'utf8'),
    );
    assert.equal(rawMeasured.files[0].path, 'src/calculator.ts');
    assert.equal(rawMeasured.files[0].cognitive, 1);
  },
);
