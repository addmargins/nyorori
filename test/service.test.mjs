import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID, generateKeyPairSync, verify } from 'node:crypto';
import { createWebhookServer, verifyWebhook, validateConfig } from '../dist/server.js';
import { appJwt, GitHubApp, GitHubApiError, checkOutput } from '../dist/github.js';

const BASE = 'a'.repeat(40),
  CANDIDATE = 'b'.repeat(40);
const secret = Buffer.from('test-webhook-secret-32-byte-value');
const operator = Buffer.from('test-operator-token-more-than-32-bytes');
function result(overrides = {}) {
  return {
    schema_version: 1,
    authority: 'local',
    repository: 'acme/app',
    base_sha: BASE,
    candidate_sha: CANDIDATE,
    policy_revision: 'policy1',
    phase: 'P2',
    measurement_fingerprint: {},
    state: 'PASS',
    exit_code: 0,
    check_conclusion: 'success',
    would_block: false,
    gates: [],
    triggers: [],
    evidence_verified: false,
    issues: [],
    ...overrides,
  };
}
function event(overrides = {}) {
  return {
    action: 'checks_requested',
    repository: { full_name: 'acme/app' },
    installation: { id: 42 },
    merge_group: { base_sha: BASE, head_sha: CANDIDATE },
    ...overrides,
  };
}
function signature(body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
async function setup(t, overrides = {}, configOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nyorori-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [],
    runs = [];
  const config = {
    host: '127.0.0.1',
    port: 0,
    data_dir: join(root, 'state'),
    app_id: 12,
    private_key_file: '/run/secrets/app',
    webhook_secret_file: '/run/secrets/hook',
    operator_token_file: '/run/secrets/operator',
    workers: 1,
    max_queue: 4,
    repositories: [
      {
        name: 'acme/app',
        installation_id: 42,
        repo: '/srv/repos/app.git',
        policy: '/etc/nyorori/app.json',
      },
    ],
    ...configOverrides,
  };
  const dependencies = {
    webhookSecret: secret,
    operatorToken: operator,
    checks: {
      start: async (...args) => {
        calls.push(['start', ...args]);
        return 123;
      },
      complete: async (...args) => {
        calls.push(['complete', ...args]);
      },
    },
    run: async (options) => {
      runs.push(options);
      return result();
    },
    validateRepository: async () => undefined,
    ...overrides,
  };
  const { server, drain } = await createWebhookServer(config, dependencies);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function send(payload = event(), headers = {}, id = randomUUID()) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'merge_group',
        'x-github-delivery': id,
        'x-hub-signature-256': signature(raw),
        ...headers,
      },
      body: raw,
    });
  }
  return { root, config, calls, runs, origin, send, drain, server, dependencies };
}

test('webhook verification binds exact raw bytes and requires sha256', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(verifyWebhook(raw, signature(raw), secret), true);
  assert.equal(verifyWebhook(Buffer.from('{ "a":1}'), signature(raw), secret), false);
  assert.equal(verifyWebhook(raw, 'sha1=00', secret), false);
  assert.equal(verifyWebhook(raw, signature(raw), Buffer.from('short')), false);
});

test('service denies unsigned, wrong repository/installation, invalid event and invalid IDs', async (t) => {
  const app = await setup(t);
  assert.equal(
    (await app.send(event(), { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status,
    401,
  );
  assert.equal((await app.send(event({ repository: { full_name: 'evil/app' } }))).status, 403);
  assert.equal((await app.send(event({ installation: { id: 99 } }))).status, 403);
  assert.equal((await app.send(event({ action: 'destroyed' }))).status, 400);
  assert.equal(
    (await app.send(event({ merge_group: { base_sha: 'main', head_sha: CANDIDATE } }))).status,
    400,
  );
  assert.equal((await app.send(event(), {}, '../../bad')).status, 400);
  assert.equal(app.calls.length, 0);
});

test('mapped signed event runs exact B/C and publishes App-owned result with persistent idempotency', async (t) => {
  const app = await setup(t);
  const id = randomUUID();
  assert.equal((await app.send(event(), {}, id)).status, 202);
  await app.drain();
  assert.equal(app.runs.length, 1);
  assert.equal(app.runs[0].base, BASE);
  assert.equal(app.runs[0].candidate, CANDIDATE);
  assert.equal(app.runs[0].repo, '/srv/repos/app.git');
  assert.equal(app.runs[0].policyPath, '/etc/nyorori/app.json');
  assert.equal(app.calls[0][0], 'start');
  assert.equal(app.calls[1][0], 'complete');
  assert.equal(app.calls[1][4], 'success');
  const saved = JSON.parse(
    await readFile(join(app.config.data_dir, 'runs', id, '1', 'app-result.json'), 'utf8'),
  );
  assert.equal(saved.authority, 'github-app');
  assert.equal(saved.service_provenance.event, 'merge_group');
  const duplicate = await app.send(event(), {}, id);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(app.runs.length, 1);
  assert.equal((await app.send(event({ extra: 'different' }), {}, id)).status, 409);
  assert.equal((await fetch(`${app.origin}/jobs/${id}`)).status, 401);
  const job = await fetch(`${app.origin}/jobs/${id}`, {
    headers: { authorization: `Bearer ${operator}` },
  });
  assert.equal(job.status, 200);
  assert.equal((await job.json()).status, 'completed');
});

test('only authenticated operator retry reevaluates same event and never accepts paths', async (t) => {
  const app = await setup(t);
  const id = randomUUID();
  await app.send(event(), {}, id);
  await app.drain();
  assert.equal((await fetch(`${app.origin}/jobs/${id}/retry`, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(`${app.origin}/jobs/${id}/retry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${operator}` },
        body: JSON.stringify({ repo: '/evil', evidence: '/evil' }),
      })
    ).status,
    202,
  );
  // drain() can have completed previously; poll the authenticated job until attempt 2 finishes.
  for (let i = 0; i < 100; i++) {
    const job = await (
      await fetch(`${app.origin}/jobs/${id}`, { headers: { authorization: `Bearer ${operator}` } })
    ).json();
    if (job.status === 'completed' && job.attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(app.runs.length, 2);
  assert.equal(app.runs[1].repo, '/srv/repos/app.git');
  assert.equal(app.runs[1].candidate, CANDIDATE);
});

test('mismatched runner result and errors publish failure, never neutral or skipped', async (t) => {
  const app = await setup(t, { run: async () => result({ candidate_sha: 'c'.repeat(40) }) });
  await app.send();
  await app.drain();
  assert.equal(app.calls.at(-1)[4], 'failure');
  assert.match(app.calls.at(-1)[5].title, /INCONCLUSIVE/);
  const second = await setup(t, {
    validateRepository: async () => {
      throw new Error('sensitive-token-do-not-print');
    },
  });
  await second.send();
  await second.drain();
  assert.equal(second.runs.length, 0);
  assert.equal(second.calls.at(-1)[4], 'failure');
  assert.doesNotMatch(JSON.stringify(second.calls), /sensitive-token/);
});

test('enforced invalid result conclusion is refused', async (t) => {
  const app = await setup(t, {
    run: async () => result({ state: 'INCONCLUSIVE', check_conclusion: 'success' }),
  });
  await app.send();
  await app.drain();
  assert.equal(app.calls.at(-1)[4], 'failure');
});

test('queue admission bound prevents excess active work', async (t) => {
  let finish;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  const app = await setup(
    t,
    {
      run: async () => {
        await blocked;
        return result();
      },
    },
    { max_queue: 1 },
  );
  assert.equal((await app.send()).status, 202);
  assert.equal((await app.send()).status, 503);
  finish();
  await app.drain();
});

test('body limits, content type and ignored event are explicit', async (t) => {
  const app = await setup(t);
  assert.equal((await app.send(event(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await app.send('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await app.send(event(), { 'x-github-event': 'pull_request_target' })).status, 202);
  assert.equal(app.calls.length, 0);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
});

test('config rejects duplicate repositories and trusted paths inside mirror', () => {
  const base = {
    host: '127.0.0.1',
    port: 8787,
    data_dir: '/srv/state',
    app_id: 1,
    private_key_file: '/run/app',
    webhook_secret_file: '/run/webhook',
    operator_token_file: '/run/operator',
    workers: 1,
    max_queue: 4,
    repositories: [
      { name: 'acme/app', installation_id: 2, repo: '/srv/mirror.git', policy: '/etc/policy.json' },
    ],
  };
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig({ ...base, data_dir: '/srv/mirror.git/state' }));
  assert.throws(() =>
    validateConfig({
      ...base,
      repositories: [base.repositories[0], { ...base.repositories[0], name: 'ACME/APP' }],
    }),
  );
});

test('GitHub App JWT is RSA signed and short lived', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = 1700000000000;
  const jwt = appJwt(123, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now);
  const parts = jwt.split('.');
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(parts.slice(0, 2).join('.')),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    ),
    true,
  );
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(payload.iss, '123');
  assert.equal(payload.exp, now / 1000 + 540);
  assert.equal(payload.iat, now / 1000 - 60);
});

test('GitHub API uses fixed TLS origin, repository scoped token and check failure contract', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const app = new GitHubApp({
    appId: 1,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.includes('/access_tokens'))
        return Response.json({
          token: 'ephemeral-test-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      return Response.json({ id: 321 });
    },
  });
  assert.equal(await app.start('acme/app', 42, CANDIDATE, 'delivery:1'), 321);
  await app.complete('acme/app', 42, 321, 'failure', {
    title: 'INCONCLUSIVE',
    summary: 'Missing evidence',
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body.repositories, ['app']);
  assert.deepEqual(calls[0].body.permissions, { checks: 'write', contents: 'read' });
  assert.equal(calls[1].body.name, 'quality-gate');
  assert.equal(calls[1].body.head_sha, CANDIDATE);
  assert.equal(calls[2].body.conclusion, 'failure');
  assert.ok(
    calls.every(
      (call) => call.url.startsWith('https://api.github.com/') && call.options.redirect === 'error',
    ),
  );
  await assert.rejects(app.start('../evil', 42, CANDIDATE, 'delivery'));
});

test('remote errors never expose credential-bearing response body', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = new GitHubApp({
    appId: 1,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fetch: async () => new Response('super-sensitive-secret', { status: 403 }),
  });
  await assert.rejects(
    app.start('acme/app', 42, CANDIDATE, 'delivery'),
    (error) =>
      error instanceof GitHubApiError &&
      error.status === 403 &&
      !error.message.includes('sensitive'),
  );
  assert.match(checkOutput(result({ state: 'INCONCLUSIVE' })).title, /INCONCLUSIVE/);
});

test('delivery receipts survive a listener restart', async (t) => {
  const app = await setup(t);
  const id = randomUUID();
  await app.send(event(), {}, id);
  await app.drain();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  const reopened = await createWebhookServer(app.config, app.dependencies);
  await new Promise((resolve) => reopened.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    reopened.server.closeAllConnections();
    await new Promise((resolve) => reopened.server.close(resolve));
  });
  const raw = JSON.stringify(event());
  const response = await fetch(`http://127.0.0.1:${reopened.server.address().port}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'merge_group',
      'x-github-delivery': id,
      'x-hub-signature-256': signature(raw),
    },
    body: raw,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  await reopened.drain();
  assert.equal(app.runs.length, 1);
});

test('startup restores a previously queued signed-event job', async (t) => {
  const app = await setup(t);
  await app.drain();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  const id = randomUUID();
  const now = new Date().toISOString();
  await writeFile(
    join(app.config.data_dir, 'jobs', `${id}.json`),
    JSON.stringify({
      id,
      repository: 'acme/app',
      base_sha: BASE,
      candidate_sha: CANDIDATE,
      body_sha256: 'd'.repeat(64),
      status: 'queued',
      attempt: 0,
      created_at: now,
      updated_at: now,
    }),
  );
  const reopened = await createWebhookServer(app.config, app.dependencies);
  await new Promise((resolve) => reopened.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    reopened.server.closeAllConnections();
    await new Promise((resolve) => reopened.server.close(resolve));
  });
  await reopened.drain();
  assert.equal(app.runs.length, 1);
  assert.equal(app.runs[0].candidate, CANDIDATE);
  const receipt = JSON.parse(
    await readFile(join(app.config.data_dir, 'jobs', `${id}.json`), 'utf8'),
  );
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.attempt, 1);
});

test('terminal receipt count and artifact history are bounded while active jobs are retained', async (t) => {
  const app = await setup(t, {}, { max_queue: 1, max_receipts: 2, max_attempt_history: 1 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) {
    assert.equal((await app.send(event(), {}, id)).status, 202);
    await app.drain();
  }
  const receipts = await readdir(join(app.config.data_dir, 'jobs'));
  assert.equal(receipts.filter((name) => name.endsWith('.json')).length, 2);
  assert.equal(
    (
      await fetch(`${app.origin}/jobs/${ids[0]}`, {
        headers: { authorization: `Bearer ${operator}` },
      })
    ).status,
    404,
  );
  await assert.rejects(readFile(join(app.config.data_dir, 'runs', ids[0], '1', 'app-result.json')));
  const retry = await fetch(`${app.origin}/jobs/${ids[2]}/retry`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operator}` },
  });
  assert.equal(retry.status, 202);
  await app.drain();
  assert.deepEqual(await readdir(join(app.config.data_dir, 'runs', ids[2])), ['2']);
});

test('expired terminal receipts and their artifacts are pruned during streaming startup', async (t) => {
  const app = await setup(t);
  await app.drain();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  const id = randomUUID(),
    old = '2000-01-01T00:00:00.000Z';
  await writeFile(
    join(app.config.data_dir, 'jobs', `${id}.json`),
    JSON.stringify({
      id,
      repository: 'acme/app',
      base_sha: BASE,
      candidate_sha: CANDIDATE,
      body_sha256: 'd'.repeat(64),
      status: 'completed',
      attempt: 1,
      created_at: old,
      updated_at: old,
      state: 'PASS',
    }),
  );
  await mkdir(join(app.config.data_dir, 'runs', id, '1'), { recursive: true });
  await writeFile(join(app.config.data_dir, 'runs', id, '1', 'app-result.json'), '{}');
  const reopened = await createWebhookServer(app.config, app.dependencies);
  await new Promise((resolve) => reopened.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    reopened.server.closeAllConnections();
    await new Promise((resolve) => reopened.server.close(resolve));
  });
  await reopened.drain();
  assert.equal(app.runs.length, 0);
  await assert.rejects(readFile(join(app.config.data_dir, 'jobs', `${id}.json`)));
  await assert.rejects(readFile(join(app.config.data_dir, 'runs', id, '1', 'app-result.json')));
});
