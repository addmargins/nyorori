import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
  opendir,
  lstat,
  realpath,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubApp, GitHubApiError, checkOutput, type GitHubChecks } from './github.js';
import type { GateRun } from './types.js';
import { runAnalysisWorker } from './worker.js';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DELIVERY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BODY = 1024 * 1024;
export interface RepositoryConfig {
  name: string;
  installation_id: number;
  repo: string;
  policy: string;
  evidence_dir?: string;
}
export interface ServiceConfig {
  host: string;
  port: number;
  data_dir: string;
  app_id: number;
  private_key_file: string;
  webhook_secret_file: string;
  operator_token_file: string;
  repositories: RepositoryConfig[];
  workers: number;
  max_queue: number;
  max_receipts?: number;
  retention_days?: number;
  max_attempt_history?: number;
}
export interface ServiceRunOptions {
  repo: string;
  base: string;
  candidate: string;
  policyPath: string;
  out: string;
  evidencePath?: string;
  repository: string;
}
export interface ServiceDependencies {
  checks: GitHubChecks;
  run: (options: ServiceRunOptions) => Promise<GateRun>;
  webhookSecret: Buffer;
  operatorToken: Buffer;
  validateRepository?: (
    repository: RepositoryConfig,
    base: string,
    candidate: string,
  ) => Promise<void>;
}
interface Job {
  id: string;
  repository: string;
  base_sha: string;
  candidate_sha: string;
  body_sha256: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  attempt: number;
  created_at: string;
  updated_at: string;
  check_run_id?: number;
  state?: string;
  error_code?: string;
}

export function verifyWebhook(raw: Buffer, signature: string | undefined, secret: Buffer): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature) || secret.length < 16) return false;
  const supplied = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(supplied, expected);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isInside(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(rel))
  );
}
function bearerMatches(header: string | undefined, token: Buffer): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
async function defaultValidate(
  repository: RepositoryConfig,
  base: string,
  candidate: string,
): Promise<void> {
  const options = {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
  const { stdout } = await execute(
    'git',
    ['-C', repository.repo, '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--is-bare-repository'],
    options,
  );
  if (stdout.trim() !== 'true') throw new Error('MIRROR_NOT_BARE');
  for (const sha of [base, candidate]) {
    const result = await execute(
      'git',
      [
        '-C',
        repository.repo,
        '-c',
        'core.hooksPath=/dev/null',
        'rev-parse',
        '--verify',
        `${sha}^{commit}`,
      ],
      options,
    );
    if (result.stdout.trim() !== sha) throw new Error('MIRROR_OBJECT_MISSING');
  }
}

/** Creates an authenticated webhook service; starting it performs no remote requests. */
export async function createWebhookServer(
  config: ServiceConfig,
  dependencies: ServiceDependencies,
): Promise<{ server: Server; drain: () => Promise<void> }> {
  if (dependencies.webhookSecret.length < 16 || dependencies.operatorToken.length < 32)
    throw new Error('Service secrets are too short');
  validateConfig(config);
  await mkdir(join(config.data_dir, 'jobs'), { recursive: true, mode: 0o700 });
  await mkdir(join(config.data_dir, 'runs'), { recursive: true, mode: 0o700 });
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  const repositories = new Map(config.repositories.map((repo) => [repo.name.toLowerCase(), repo]));
  let active = 0;
  const processing = new Set<string>();
  const cleanups = new Set<Promise<unknown>>();
  const retiring = new Set<string>();
  const queueFull = (): boolean =>
    [...jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running')
      .length >= config.max_queue;
  const persist = async (job: Job): Promise<void> => {
    job.updated_at = new Date().toISOString();
    await atomicJson(join(config.data_dir, 'jobs', `${job.id}.json`), job);
  };
  const maxReceipts = config.max_receipts ?? 1000;
  const retentionMs = (config.retention_days ?? 30) * 86400_000;
  const maxHistory = config.max_attempt_history ?? 3;
  const removeReceipt = async (id: string): Promise<void> => {
    retiring.add(id);
    jobs.delete(id);
    try {
      await Promise.all([
        rm(join(config.data_dir, 'jobs', `${id}.json`), { force: true }),
        rm(join(config.data_dir, 'runs', id), { recursive: true, force: true }),
      ]);
    } finally {
      retiring.delete(id);
    }
  };
  const pruneReceipts = async (target: number): Promise<boolean> => {
    const terminal = [...jobs.values()]
      .filter(
        (job) => !processing.has(job.id) && (job.status === 'completed' || job.status === 'failed'),
      )
      .sort(
        (a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id.localeCompare(b.id),
      );
    for (const job of terminal) {
      if (
        !jobs.has(job.id) ||
        processing.has(job.id) ||
        (job.status !== 'completed' && job.status !== 'failed')
      )
        continue;
      if (jobs.size <= target && Date.now() - Date.parse(job.updated_at) <= retentionMs) break;
      await removeReceipt(job.id);
    }
    return jobs.size <= target;
  };
  const pruneAttempts = async (job: Job): Promise<void> => {
    const directory = join(config.data_dir, 'runs', job.id);
    let attempts: string[];
    try {
      attempts = (await readdir(directory))
        .filter((name) => /^[1-9][0-9]*$/.test(name))
        .sort((a, b) => Number(b) - Number(a));
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      attempts
        .slice(maxHistory)
        .map((name) => rm(join(directory, name), { recursive: true, force: true })),
    );
  };
  // Read receipts as a stream and prune terminal entries while loading, bounding memory across restarts.
  for await (const entry of await opendir(join(config.data_dir, 'jobs'))) {
    const file = entry.name;
    const id = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !DELIVERY.test(id)) continue;
    const path = join(config.data_dir, 'jobs', file);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid persisted job file');
    const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !isRecord(stored) ||
      stored.id !== id ||
      !repositories.has(String(stored.repository).toLowerCase()) ||
      !SHA.test(String(stored.base_sha)) ||
      !SHA.test(String(stored.candidate_sha)) ||
      !['queued', 'running', 'completed', 'failed'].includes(String(stored.status)) ||
      !Number.isSafeInteger(stored.attempt) ||
      (stored.attempt as number) < 0 ||
      typeof stored.body_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(stored.body_sha256) ||
      !Number.isFinite(Date.parse(String(stored.created_at))) ||
      !Number.isFinite(Date.parse(String(stored.updated_at)))
    )
      throw new Error('Invalid persisted job');
    const job = stored as unknown as Job;
    jobs.set(id, job);
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'queued';
      queue.push(id);
    }
    if (!(await pruneReceipts(maxReceipts)))
      throw new Error('Persisted active jobs exceed receipt capacity');
  }
  const processJob = async (job: Job): Promise<void> => {
    const repository = repositories.get(job.repository.toLowerCase())!;
    job.status = 'running';
    job.attempt += 1;
    delete job.error_code;
    await persist(job);
    try {
      // Every attempt gets its own App check. If an API response was lost, an older check remains pending (fail closed).
      job.check_run_id = await dependencies.checks.start(
        repository.name,
        repository.installation_id,
        job.candidate_sha,
        `${job.id}:${job.attempt}`,
      );
      await persist(job);
      await (dependencies.validateRepository ?? defaultValidate)(
        repository,
        job.base_sha,
        job.candidate_sha,
      );
      const out = join(config.data_dir, 'runs', job.id, String(job.attempt));
      await mkdir(out, { recursive: true, mode: 0o700 });
      let evidencePath: string | undefined;
      if (repository.evidence_dir) {
        const path = join(repository.evidence_dir, `${job.base_sha}-${job.candidate_sha}.json`);
        try {
          if ((await lstat(path)).isFile()) evidencePath = path;
        } catch (error) {
          if (!isRecord(error) || error.code !== 'ENOENT') throw error;
        }
      }
      const result = await dependencies.run({
        repo: repository.repo,
        base: job.base_sha,
        candidate: job.candidate_sha,
        policyPath: repository.policy,
        out,
        evidencePath,
        repository: repository.name,
      });
      if (
        result.schema_version !== 1 ||
        result.base_sha !== job.base_sha ||
        result.candidate_sha !== job.candidate_sha ||
        result.repository.toLowerCase() !== repository.name.toLowerCase() ||
        !['success', 'failure'].includes(result.check_conclusion) ||
        !['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE', 'ACCEPTED_WITH_WAIVER'].includes(
          result.state,
        )
      )
        throw new Error('RESULT_BINDING_MISMATCH');
      if (['FAIL', 'INCONCLUSIVE'].includes(result.state) && result.check_conclusion !== 'failure')
        throw new Error('INVALID_CONCLUSION');
      const appResult = { ...result, authority: 'github-app' as const };
      await atomicJson(join(out, 'app-result.json'), {
        ...appResult,
        service_provenance: {
          delivery: job.id,
          installation_id: repository.installation_id,
          check_run_id: job.check_run_id,
          event: 'merge_group',
          action: 'checks_requested',
        },
      });
      await dependencies.checks.complete(
        repository.name,
        repository.installation_id,
        job.check_run_id,
        appResult.check_conclusion,
        checkOutput(appResult),
      );
      job.state = appResult.state;
      job.status = 'completed';
      await persist(job);
    } catch (error) {
      const code =
        error instanceof GitHubApiError
          ? `GITHUB_API_${error.status}`
          : 'SERVICE_EVALUATION_FAILED';
      job.status = 'failed';
      job.error_code = code;
      job.state = 'INCONCLUSIVE';
      if (job.check_run_id) {
        try {
          await dependencies.checks.complete(
            repository.name,
            repository.installation_id,
            job.check_run_id,
            'failure',
            {
              title: 'INCONCLUSIVE: trusted service could not complete evaluation',
              summary: `Reason: ${code}. No success was issued. Operators must repair the prerequisite and retry this exact candidate.`,
            },
          );
        } catch {
          /* A pending required check blocks merging when API publication is unavailable. */
        }
      }
      await persist(job);
    }
  };
  const pump = (): void => {
    while (active < config.workers && queue.length > 0) {
      const job = jobs.get(queue.shift()!)!;
      active++;
      processing.add(job.id);
      void processJob(job)
        .catch(() => {
          job.status = 'failed';
          job.error_code = 'STATE_PERSISTENCE_FAILED';
        })
        .finally(() => {
          active--;
          processing.delete(job.id);
          const cleanup = pruneAttempts(job)
            .then(() => pruneReceipts(maxReceipts))
            .catch(() => {
              console.error(
                'Nyorori state retention cleanup failed; inspect the private state volume.',
              );
            })
            .finally(() => {
              cleanups.delete(cleanup);
            });
          cleanups.add(cleanup);
          pump();
        });
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const path = request.url?.split('?')[0] ?? '/';
      if (request.method === 'GET' && path === '/healthz') {
        json(response, 200, { status: 'ok' });
        return;
      }
      const match = /^\/jobs\/([a-f0-9-]{36})(\/retry)?$/i.exec(path);
      if (match) {
        if (!bearerMatches(request.headers.authorization, dependencies.operatorToken)) {
          json(response, 401, { error: 'UNAUTHORIZED' });
          return;
        }
        const job = jobs.get(match[1]!.toLowerCase());
        if (!job) {
          json(response, 404, { error: 'NOT_FOUND' });
          return;
        }
        if (request.method === 'GET' && !match[2]) {
          json(response, 200, job);
          return;
        }
        if (request.method === 'POST' && match[2]) {
          if (job.status === 'queued' || job.status === 'running' || processing.has(job.id)) {
            json(response, 409, { error: 'ALREADY_ACTIVE' });
            return;
          }
          if (queueFull()) {
            json(response, 503, { error: 'QUEUE_FULL' });
            return;
          }
          job.status = 'queued';
          await persist(job);
          queue.push(job.id);
          json(response, 202, { id: job.id, status: job.status });
          pump();
          return;
        }
        json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      if (path !== '/webhook' || request.method !== 'POST') {
        json(response, 404, { error: 'NOT_FOUND' });
        return;
      }
      if (
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      ) {
        json(response, 415, { error: 'JSON_REQUIRED' });
        return;
      }
      const raw = await body(request);
      if (
        !verifyWebhook(
          raw,
          typeof request.headers['x-hub-signature-256'] === 'string'
            ? request.headers['x-hub-signature-256']
            : undefined,
          dependencies.webhookSecret,
        )
      ) {
        json(response, 401, { error: 'INVALID_SIGNATURE' });
        return;
      }
      const event = request.headers['x-github-event'];
      if (event === 'ping') {
        json(response, 200, { status: 'pong' });
        return;
      }
      if (event !== 'merge_group') {
        json(response, 202, { status: 'ignored', reason: 'MERGE_GROUP_ONLY' });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(response, 400, { error: 'INVALID_JSON' });
        return;
      }
      if (
        !isRecord(payload) ||
        payload.action !== 'checks_requested' ||
        !isRecord(payload.repository) ||
        !isRecord(payload.installation) ||
        !isRecord(payload.merge_group)
      ) {
        json(response, 400, { error: 'INVALID_EVENT' });
        return;
      }
      const repository = repositories.get(String(payload.repository.full_name).toLowerCase());
      if (!repository || payload.installation.id !== repository.installation_id) {
        json(response, 403, { error: 'REPOSITORY_NOT_ALLOWED' });
        return;
      }
      const base = payload.merge_group.base_sha;
      const candidate = payload.merge_group.head_sha;
      const delivery = request.headers['x-github-delivery'];
      if (
        typeof base !== 'string' ||
        !SHA.test(base) ||
        typeof candidate !== 'string' ||
        !SHA.test(candidate) ||
        typeof delivery !== 'string' ||
        !DELIVERY.test(delivery)
      ) {
        json(response, 400, { error: 'INVALID_IDENTITY' });
        return;
      }
      const id = delivery.toLowerCase();
      const hash = createHash('sha256').update(raw).digest('hex');
      if (retiring.has(id)) {
        json(response, 503, { error: 'RECEIPT_RETIRING' });
        return;
      }
      const previous = jobs.get(id);
      if (previous) {
        if (previous.body_sha256 !== hash) {
          json(response, 409, { error: 'DELIVERY_CONFLICT' });
          return;
        }
        json(response, 200, { id, status: previous.status, duplicate: true });
        return;
      }
      if (queueFull()) {
        json(response, 503, { error: 'QUEUE_FULL' });
        return;
      }
      if (!(await pruneReceipts(maxReceipts - 1))) {
        json(response, 503, { error: 'RECEIPT_CAPACITY' });
        return;
      }
      // Recheck after asynchronous cleanup; another authenticated request may have reserved capacity.
      if (retiring.has(id)) {
        json(response, 503, { error: 'RECEIPT_RETIRING' });
        return;
      }
      const raced = jobs.get(id);
      if (raced) {
        json(
          response,
          raced.body_sha256 === hash ? 200 : 409,
          raced.body_sha256 === hash
            ? { id, status: raced.status, duplicate: true }
            : { error: 'DELIVERY_CONFLICT' },
        );
        return;
      }
      if (jobs.size >= maxReceipts || queueFull()) {
        json(response, 503, { error: 'QUEUE_FULL' });
        return;
      }
      const now = new Date().toISOString();
      const job: Job = {
        id,
        repository: repository.name,
        base_sha: base,
        candidate_sha: candidate,
        body_sha256: hash,
        status: 'queued',
        attempt: 0,
        created_at: now,
        updated_at: now,
      };
      // Reservation precedes await, preventing concurrent identical deliveries from enqueueing twice.
      jobs.set(id, job);
      try {
        await persist(job);
      } catch (error) {
        jobs.delete(id);
        throw error;
      }
      queue.push(id);
      json(response, 202, { id, status: 'queued' });
      pump();
    } catch (error) {
      if (!response.headersSent)
        json(response, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 500, {
          error:
            error instanceof Error && error.message === 'BODY_TOO_LARGE'
              ? 'BODY_TOO_LARGE'
              : 'SERVICE_ERROR',
        });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  pump();
  return {
    server,
    drain: () =>
      new Promise<void>((resolveDrain) => {
        const poll = (): void => {
          if (active === 0 && queue.length === 0 && cleanups.size === 0) resolveDrain();
          else setTimeout(poll, 20).unref();
        };
        poll();
      }),
  };
}

export function validateConfig(value: unknown): asserts value is ServiceConfig {
  if (!isRecord(value)) throw new Error('Service configuration must be an object');
  for (const key of ['data_dir', 'private_key_file', 'webhook_secret_file', 'operator_token_file'])
    if (typeof value[key] !== 'string' || !isAbsolute(value[key] as string))
      throw new Error(`Configuration requires absolute ${key}`);
  if (
    typeof value.host !== 'string' ||
    !value.host ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 0 ||
    (value.port as number) > 65535 ||
    !Number.isSafeInteger(value.app_id) ||
    (value.app_id as number) < 1
  )
    throw new Error('Invalid listener or App identity');
  if (
    !Number.isSafeInteger(value.workers) ||
    (value.workers as number) < 1 ||
    (value.workers as number) > 8 ||
    !Number.isSafeInteger(value.max_queue) ||
    (value.max_queue as number) < (value.workers as number) ||
    (value.max_queue as number) > 1000
  )
    throw new Error('Invalid worker/queue limits');
  for (const [key, min, max] of [
    ['max_receipts', value.max_queue as number, 100000],
    ['retention_days', 1, 365],
    ['max_attempt_history', 1, 20],
  ] as const)
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) ||
        (value[key] as number) < min ||
        (value[key] as number) > max)
    )
      throw new Error('Invalid retention limits');
  if (
    !Array.isArray(value.repositories) ||
    value.repositories.length < 1 ||
    value.repositories.length > 100
  )
    throw new Error('At least one repository mapping is required');
  const names = new Set<string>();
  for (const repo of value.repositories) {
    if (
      !isRecord(repo) ||
      typeof repo.name !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.name) ||
      repo.name.split('/').some((part) => part === '.' || part === '..') ||
      names.has(repo.name.toLowerCase()) ||
      !Number.isSafeInteger(repo.installation_id) ||
      (repo.installation_id as number) < 1 ||
      typeof repo.repo !== 'string' ||
      !isAbsolute(repo.repo) ||
      typeof repo.policy !== 'string' ||
      !isAbsolute(repo.policy) ||
      (repo.evidence_dir !== undefined &&
        (typeof repo.evidence_dir !== 'string' || !isAbsolute(repo.evidence_dir)))
    )
      throw new Error('Invalid repository mapping');
    names.add(repo.name.toLowerCase());
    for (const trusted of [
      repo.policy,
      value.data_dir,
      value.private_key_file,
      value.webhook_secret_file,
      value.operator_token_file,
      repo.evidence_dir,
    ].filter((v): v is string => typeof v === 'string'))
      if (isInside(repo.repo, trusted))
        throw new Error('Trusted state/configuration must be outside candidate repositories');
  }
}

/** Validates real filesystem boundaries, so symlinks cannot move trusted files into a mirror. */
export async function loadServiceConfig(path: string): Promise<ServiceConfig> {
  const config: unknown = JSON.parse(await readFile(path, 'utf8'));
  validateConfig(config);
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  const trusted = [
    await realpath(path),
    await realpath(config.data_dir),
    await realpath(config.private_key_file),
    await realpath(config.webhook_secret_file),
    await realpath(config.operator_token_file),
  ];
  for (const repo of config.repositories) {
    const root = await realpath(repo.repo);
    const additions = [await realpath(repo.policy)];
    if (repo.evidence_dir) additions.push(await realpath(repo.evidence_dir));
    if ([...trusted, ...additions].some((file) => isInside(root, file)))
      throw new Error('Trusted filesystem boundary violation');
  }
  return config;
}

async function main(): Promise<void> {
  const configPath = process.env.NYORORI_SERVICE_CONFIG;
  if (!configPath || !isAbsolute(configPath))
    throw new Error('Set NYORORI_SERVICE_CONFIG to an external absolute JSON path');
  const config = await loadServiceConfig(configPath);
  const privateKey = await readFile(config.private_key_file, 'utf8');
  const webhookSecret = Buffer.from(
    (await readFile(config.webhook_secret_file, 'utf8')).replace(/\r?\n$/, ''),
  );
  const operatorToken = Buffer.from(
    (await readFile(config.operator_token_file, 'utf8')).replace(/\r?\n$/, ''),
  );
  const { server, drain } = await createWebhookServer(config, {
    checks: new GitHubApp({ appId: config.app_id, privateKey }),
    webhookSecret,
    operatorToken,
    run: runAnalysisWorker,
  });
  server.listen(config.port, config.host, () => {
    console.log('Nyorori webhook listener started');
  });
  const shutdown = (): void => {
    server.close(() => {
      void drain().then(() => {
        process.exitCode = 0;
      });
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error(
      'Nyorori service startup failed; check protected configuration and secret bindings.',
    );
    process.exitCode = 1;
  });
}
