import { createPrivateKey, sign } from 'node:crypto';
import type { GateRun } from './types.js';

const API = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CheckOutput {
  title: string;
  summary: string;
}
export interface GitHubChecks {
  start(
    repository: string,
    installationId: number,
    head: string,
    delivery: string,
  ): Promise<number>;
  complete(
    repository: string,
    installationId: number,
    id: number,
    conclusion: 'success' | 'failure',
    output: CheckOutput,
  ): Promise<void>;
}
export interface GitHubAppOptions {
  appId: number;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** API errors deliberately omit response bodies and request headers (which carry credentials). */
export class GitHubApiError extends Error {
  constructor(public readonly status: number) {
    super(`GitHub API request failed with HTTP ${status}`);
    this.name = 'GitHubApiError';
  }
}

export function appJwt(appId: number, privateKey: string, now = Date.now()): string {
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error('Invalid App ID');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App key must be RSA');
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

function repositoryPath(repository: string): string {
  if (
    !REPOSITORY.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Invalid repository identity');
  return `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
}

/** Uses a fixed API origin and repository-scoped, least-privilege installation tokens. */
export class GitHubApp implements GitHubChecks {
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly options: GitHubAppOptions) {
    appJwt(options.appId, options.privateKey);
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private async request(
    path: string,
    token: string,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${API}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nyorori-quality-gate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GitHubApiError(0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubApiError(response.status);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 1024 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubApiError(502);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            throw new GitHubApiError(502);
          }
          chunks.push(item.value);
        }
      } catch {
        throw new GitHubApiError(502);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new GitHubApiError(502);
    }
  }
  private async installationToken(repository: string, installationId: number): Promise<string> {
    repositoryPath(repository);
    if (!Number.isSafeInteger(installationId) || installationId < 1)
      throw new Error('Invalid installation ID');
    const cacheKey = `${installationId}:${repository}`;
    const saved = this.tokens.get(cacheKey);
    if (saved && saved.expiresAt - this.now() > 60_000) return saved.token;
    const response = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      appJwt(this.options.appId, this.options.privateKey, this.now()),
      'POST',
      {
        repositories: [repository.split('/')[1]],
        permissions: { checks: 'write', contents: 'read' },
      },
    );
    if (
      !isRecord(response) ||
      typeof response.token !== 'string' ||
      response.token.length < 1 ||
      typeof response.expires_at !== 'string'
    )
      throw new GitHubApiError(502);
    const expiresAt = Date.parse(response.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt - this.now() <= 60_000)
      throw new GitHubApiError(502);
    this.tokens.set(cacheKey, { token: response.token, expiresAt });
    return response.token;
  }
  async start(
    repository: string,
    installationId: number,
    head: string,
    delivery: string,
  ): Promise<number> {
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid candidate SHA');
    const token = await this.installationToken(repository, installationId);
    const response = await this.request(`${repositoryPath(repository)}/check-runs`, token, 'POST', {
      name: 'quality-gate',
      head_sha: head,
      external_id: delivery,
      status: 'in_progress',
      started_at: new Date(this.now()).toISOString(),
      output: {
        title: 'Quality gate analysis in progress',
        summary:
          'Trusted service is evaluating the exact merge candidate. No candidate code is executed here.',
      },
    });
    if (!isRecord(response) || !Number.isSafeInteger(response.id) || (response.id as number) < 1)
      throw new GitHubApiError(502);
    return response.id as number;
  }
  async complete(
    repository: string,
    installationId: number,
    id: number,
    conclusion: 'success' | 'failure',
    output: CheckOutput,
  ): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1 || !['success', 'failure'].includes(conclusion))
      throw new Error('Invalid check update');
    const token = await this.installationToken(repository, installationId);
    await this.request(`${repositoryPath(repository)}/check-runs/${id}`, token, 'PATCH', {
      status: 'completed',
      conclusion,
      completed_at: new Date(this.now()).toISOString(),
      output: { title: output.title.slice(0, 255), summary: output.summary.slice(0, 60_000) },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>&|]/g, (char) => `\\${char}`);
}

export function checkOutput(result: GateRun): CheckOutput {
  const shadow = result.phase === 'P0' ? ' (P0 shadow)' : '';
  const title = `${result.state}${shadow}: quality-gate`;
  const rows = result.gates.map(
    (g) =>
      `| ${escapeMarkdown(g.gate)} | ${g.mode} | ${g.state} | ${escapeMarkdown(g.reasons.join(', '))} |`,
  );
  const summary = [
    `Candidate: \`${result.candidate_sha}\``,
    `Base: \`${result.base_sha}\``,
    `Policy: ${escapeMarkdown(result.policy_revision)} (${result.phase}). Evidence signature verified: ${result.evidence_verified ? 'yes' : 'no'}.`,
    `Would block with all analysis findings enforced: **${result.would_block ? 'yes' : 'no'}**.`,
    '',
    '| Gate | Mode | Analysis | Reasons |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'Observation findings retain their original states. A shadow success is not approval to enable enforcement.',
  ].join('\n');
  return { title, summary };
}
