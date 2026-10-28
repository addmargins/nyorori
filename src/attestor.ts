#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Unzip, UnzipInflate } from 'fflate';
import { canonical, loadPolicy, readJson, sha256, within } from './policy.js';
import { independent, validReview } from './evidence.js';
import { repositoryRoot } from './runner.js';
import type { Evidence, EvidenceEnvelope, GateRun, Policy, TestReport } from './types.js';

const API = 'https://api.github.com';
const MAX_JSON = 10_000_000;
const MAX_ZIP = 16_000_000;
const MAX_REPORT = 8_000_000;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
export interface AttestorConfig {
  schema_version: 1;
  repository: string;
  issuer: string;
  workflow: { id: number; path: string; sha256: string; reusable: { path: string; sha: string } };
  base_event: 'push' | 'workflow_dispatch' | 'merge_group';
  candidate_event: 'merge_group' | 'pull_request' | 'workflow_dispatch';
  artifact_name: string;
  report_file: 'report.json';
  max_age_seconds: number;
}
export interface AttestOptions {
  repo: string;
  configPath: string;
  policyPath: string;
  contextPath: string;
  keyPath: string;
  baseRun: number;
  baseAttempt: number;
  candidateRun: number;
  candidateAttempt: number;
  out: string;
  authorityPath?: string;
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
interface RunSpec {
  id: number;
  attempt: number;
  sha: string;
  event: string;
}
interface VerifiedArtifact {
  report: NormalizedReport;
  provenance: {
    run_id: number;
    run_attempt: number;
    head_sha: string;
    event: string;
    conclusion: string;
    workflow_id: number;
    workflow_path: string;
    workflow_sha256: string;
    reusable_sha: string;
    artifact_id: number;
    artifact_sha256: string;
  };
}
interface NormalizedReport {
  schema_version: 1;
  head_sha: string;
  tests: TestReport;
  coverage?: Evidence['coverage'];
  mutation?: Evidence['mutation'];
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function int(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}
function fail(message: string): never {
  throw new Error(message);
}
function string(v: unknown, max = 4096): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function id(value: unknown): boolean {
  return string(value, 100) && /^[A-Za-z0-9_][A-Za-z0-9_.\[\]-]*$/.test(value);
}
function date(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
function matchesRepository(value: unknown, repo: string): boolean {
  return (
    record(value) &&
    typeof value.full_name === 'string' &&
    value.full_name.toLowerCase() === repo.toLowerCase()
  );
}
export function validateAttestorConfig(v: unknown): AttestorConfig {
  if (
    !record(v) ||
    v.schema_version !== 1 ||
    !string(v.repository, 200) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) ||
    v.repository.split('/').some((x) => x === '.' || x === '..') ||
    !string(v.issuer, 200)
  )
    fail('Invalid attestor repository or issuer');
  const w = v.workflow;
  if (
    !record(w) ||
    !int(w.id, 1) ||
    !string(w.path, 300) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(w.path) ||
    typeof w.sha256 !== 'string' ||
    !HASH.test(w.sha256) ||
    !record(w.reusable) ||
    !string(w.reusable.path, 500) ||
    !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+\/\.github\/workflows\/[-A-Za-z0-9_.]+\.ya?ml$/.test(
      w.reusable.path,
    ) ||
    typeof w.reusable.sha !== 'string' ||
    !SHA.test(w.reusable.sha)
  )
    fail('Invalid pinned workflow identity');
  if (
    typeof v.base_event !== 'string' ||
    typeof v.candidate_event !== 'string' ||
    !['push', 'workflow_dispatch', 'merge_group'].includes(v.base_event) ||
    !['merge_group', 'pull_request', 'workflow_dispatch'].includes(v.candidate_event)
  )
    fail('Unsupported workflow event contract');
  if (
    !string(v.artifact_name, 200) ||
    !/^[A-Za-z0-9_.-]+$/.test(v.artifact_name) ||
    v.report_file !== 'report.json' ||
    !int(v.max_age_seconds, 1) ||
    v.max_age_seconds > 86400
  )
    fail('Invalid artifact or retention contract');
  return v as unknown as AttestorConfig;
}
async function bounded(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => {});
    fail('GitHub response exceeds size bound');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('GitHub response body missing');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) {
        await reader.cancel();
        fail('GitHub response exceeds size bound');
      }
      chunks.push(item.value);
    }
  } catch {
    fail('GitHub response stream failed or exceeded size bound');
  }
  return Buffer.concat(chunks);
}
function allowedDownload(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    (host === 'github.com' ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com') ||
      host.endsWith('.blob.core.windows.net') ||
      host.endsWith('.actions.githubusercontent.com'))
  );
}
class GitHubEvidenceApi {
  constructor(
    private token: string,
    private request: typeof fetch,
  ) {}
  private async get(url: string, authorized: boolean): Promise<Response> {
    try {
      return await this.request(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nyorori-evidence-attestor',
          ...(authorized ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail('GitHub API transport failed');
    }
  }
  async json(route: string): Promise<unknown> {
    const response = await this.get(`${API}${route}`, true);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`GitHub API rejected evidence request (HTTP ${response.status})`);
    }
    const bytes = await bounded(response, 2_000_000);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      fail('GitHub API returned invalid JSON');
    }
  }
  async artifact(route: string): Promise<Buffer> {
    let response = await this.get(`${API}${route}`, true);
    for (
      let redirects = 0;
      redirects < 3 && [301, 302, 303, 307, 308].includes(response.status);
      redirects++
    ) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location ?? '');
      } catch {
        fail('Invalid artifact redirect');
      }
      if (!allowedDownload(next)) fail('Artifact redirect destination rejected');
      // Installation/PAT credentials never follow an artifact redirect to object storage.
      response = await this.get(next.href, false);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`Artifact download rejected (HTTP ${response.status})`);
    }
    return bounded(response, MAX_ZIP);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const n of bytes) crc = crcTable[(crc ^ n) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** No extraction to disk. Reject extra entries, duplicates, traversal, links, encryption and ZIP64. */
export function extractReport(zip: Buffer): Buffer {
  if (zip.length < 22 || zip.length > MAX_ZIP) fail('Invalid ZIP size');
  let eocd = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--)
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) {
      eocd = p;
      break;
    }
  if (eocd < 0) fail('ZIP central directory missing');
  if (
    zip.readUInt16LE(eocd + 4) !== 0 ||
    zip.readUInt16LE(eocd + 6) !== 0 ||
    zip.readUInt16LE(eocd + 8) !== 1 ||
    zip.readUInt16LE(eocd + 10) !== 1
  )
    fail('ZIP must contain exactly one report');
  const offset = zip.readUInt32LE(eocd + 16),
    centralSize = zip.readUInt32LE(eocd + 12);
  if (
    offset + centralSize !== eocd ||
    centralSize < 46 ||
    offset + 46 > eocd ||
    zip.readUInt32LE(offset) !== 0x02014b50
  )
    fail('Invalid ZIP central directory');
  const flags = zip.readUInt16LE(offset + 8),
    compression = zip.readUInt16LE(offset + 10),
    crc = zip.readUInt32LE(offset + 16),
    compressed = zip.readUInt32LE(offset + 20),
    original = zip.readUInt32LE(offset + 24);
  const nameLen = zip.readUInt16LE(offset + 28),
    extraLen = zip.readUInt16LE(offset + 30),
    commentLen = zip.readUInt16LE(offset + 32),
    disk = zip.readUInt16LE(offset + 34),
    attributes = zip.readUInt32LE(offset + 38),
    localOffset = zip.readUInt32LE(offset + 42);
  const fileType = (attributes >>> 16) & 0xf000;
  if (
    flags & 1 ||
    ![0, 8].includes(compression) ||
    original > MAX_REPORT ||
    compressed > MAX_ZIP ||
    disk !== 0 ||
    localOffset !== 0 ||
    (fileType !== 0 && fileType !== 0x8000) ||
    46 + nameLen + extraLen + commentLen !== centralSize
  )
    fail('Unsupported or oversized ZIP entry');
  const name = zip.subarray(offset + 46, offset + 46 + nameLen);
  if (name.toString('utf8') !== 'report.json' || !name.equals(Buffer.from('report.json')))
    fail('ZIP entry name must be report.json');
  if (
    zip.readUInt32LE(0) !== 0x04034b50 ||
    zip.readUInt16LE(6) !== flags ||
    zip.readUInt16LE(8) !== compression
  )
    fail('ZIP local and central headers disagree');
  const localName = zip.readUInt16LE(26),
    localExtra = zip.readUInt16LE(28),
    dataOffset = 30 + localName + localExtra;
  if (
    localName !== name.length ||
    !zip.subarray(30, 30 + localName).equals(name) ||
    dataOffset + compressed > offset
  )
    fail('Invalid ZIP local entry');
  if (
    !(flags & 8) &&
    (zip.readUInt32LE(14) !== crc ||
      zip.readUInt32LE(18) !== compressed ||
      zip.readUInt32LE(22) !== original)
  )
    fail('ZIP local sizes disagree');
  const descriptor = offset - (dataOffset + compressed);
  if (flags & 8) {
    if (descriptor !== 12 && descriptor !== 16) fail('Invalid ZIP data descriptor');
    const d = dataOffset + compressed + (descriptor === 16 ? 4 : 0);
    if (
      (descriptor === 16 && zip.readUInt32LE(d - 4) !== 0x08074b50) ||
      zip.readUInt32LE(d) !== crc ||
      zip.readUInt32LE(d + 4) !== compressed ||
      zip.readUInt32LE(d + 8) !== original
    )
      fail('ZIP descriptor disagrees');
  } else if (descriptor !== 0) fail('Unexpected ZIP entry bytes');
  let count = 0,
    total = 0,
    done = false;
  const chunks: Uint8Array[] = [];
  const stream = new Unzip((file) => {
    if (
      ++count !== 1 ||
      file.name !== 'report.json' ||
      (file.originalSize !== undefined && file.originalSize > MAX_REPORT)
    )
      fail('Invalid streamed ZIP entry');
    file.ondata = (error, data, final) => {
      if (error) fail('ZIP decompression failed');
      total += data.length;
      if (total > MAX_REPORT || total > original) {
        file.terminate();
        fail('ZIP expansion limit exceeded');
      }
      chunks.push(data);
      if (final) done = true;
    };
    file.start();
  });
  stream.register(UnzipInflate);
  try {
    for (let p = 0; p < zip.length; p += 1024)
      stream.push(zip.subarray(p, Math.min(p + 1024, zip.length)), p + 1024 >= zip.length);
  } catch {
    fail('ZIP decompression rejected');
  }
  if (count !== 1 || !done || total !== original) fail('ZIP report length mismatch');
  const output = Buffer.concat(chunks);
  if (crc32(output) !== crc) fail('ZIP report CRC mismatch');
  return output;
}
function testReport(value: unknown): value is TestReport {
  if (
    !record(value) ||
    !Array.isArray(value.tests) ||
    value.tests.length > 100000 ||
    ![value.total, value.passed, value.failed, value.skipped].every((x) => int(x))
  )
    return false;
  const tests = value.tests;
  if (
    tests.some(
      (x) =>
        !record(x) ||
        !string(x.id, 4096) ||
        !['passed', 'failed', 'skipped', 'todo'].includes(String(x.status)) ||
        !int(x.assertions),
    )
  )
    return false;
  return (
    value.total === tests.length &&
    new Set(tests.map((x) => x.id)).size === tests.length &&
    value.passed === tests.filter((x) => x.status === 'passed').length &&
    value.failed === tests.filter((x) => x.status === 'failed').length &&
    value.skipped === tests.filter((x) => x.status === 'skipped' || x.status === 'todo').length &&
    value.total === (value.passed as number) + (value.failed as number) + (value.skipped as number)
  );
}
function normalized(bytes: Buffer, sha: string, conclusion: string): NormalizedReport {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('Artifact report is not valid UTF-8 JSON');
  }
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) => !['schema_version', 'head_sha', 'tests', 'coverage', 'mutation'].includes(k),
    )
  )
    fail('Artifact contains unsupported fields; authority is never accepted from artifacts');
  if (value.schema_version !== 1 || value.head_sha !== sha || !testReport(value.tests))
    fail('Artifact test report schema or head SHA mismatch');
  if (
    (conclusion === 'success' && value.tests.failed !== 0) ||
    (conclusion === 'failure' && value.tests.failed === 0)
  )
    fail('Workflow conclusion and test failure evidence disagree');
  if (
    value.coverage !== undefined &&
    (!record(value.coverage) ||
      !string(value.coverage.provider, 200) ||
      !string(value.coverage.version, 200) ||
      !record(value.coverage.files))
  )
    fail('Invalid coverage report envelope');
  if (
    value.mutation !== undefined &&
    (!record(value.mutation) ||
      !['killed', 'survived', 'timeout', 'no_coverage'].every((k) =>
        int((value.mutation as Record<string, unknown>)[k]),
      ))
  )
    fail('Invalid mutation report envelope');
  return value as unknown as NormalizedReport;
}
async function collect(
  api: GitHubEvidenceApi,
  config: AttestorConfig,
  spec: RunSpec,
  now: number,
): Promise<VerifiedArtifact> {
  const repo = `/repos/${config.repository}`;
  const raw = await api.json(`${repo}/actions/runs/${spec.id}/attempts/${spec.attempt}`);
  if (
    !record(raw) ||
    raw.id !== spec.id ||
    raw.run_attempt !== spec.attempt ||
    raw.head_sha !== spec.sha ||
    raw.event !== spec.event ||
    raw.status !== 'completed' ||
    typeof raw.conclusion !== 'string' ||
    !['success', 'failure'].includes(raw.conclusion) ||
    raw.workflow_id !== config.workflow.id ||
    raw.path !== config.workflow.path ||
    !matchesRepository(raw.repository, config.repository) ||
    !matchesRepository(raw.head_repository, config.repository)
  )
    fail('Workflow run identity, attempt, event or completion rejected');
  if (
    !Array.isArray(raw.referenced_workflows) ||
    !raw.referenced_workflows.some(
      (w) =>
        record(w) &&
        typeof w.path === 'string' &&
        w.path.split('@')[0] === config.workflow.reusable.path &&
        w.sha === config.workflow.reusable.sha,
    )
  )
    fail('Pinned reusable workflow provenance missing');
  const workflow = await api.json(`${repo}/contents/${config.workflow.path}?ref=${spec.sha}`);
  if (
    !record(workflow) ||
    workflow.type !== 'file' ||
    workflow.path !== config.workflow.path ||
    workflow.encoding !== 'base64' ||
    !int(workflow.size) ||
    workflow.size > 1_000_000 ||
    typeof workflow.content !== 'string'
  )
    fail('Pinned caller workflow content missing');
  const encoded = workflow.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    fail('Invalid caller workflow base64');
  const workflowBytes = Buffer.from(encoded, 'base64');
  if (workflowBytes.length !== workflow.size || sha256(workflowBytes) !== config.workflow.sha256)
    fail('Pinned caller workflow SHA256 mismatch');
  const completed = date(raw.updated_at),
    age = now - completed;
  if (!Number.isFinite(age) || age < -30000 || age > config.max_age_seconds * 1000)
    fail('Workflow evidence is stale or future dated');
  const artifacts: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const rawList = await api.json(
      `${repo}/actions/runs/${spec.id}/artifacts?per_page=100&page=${page}`,
    );
    if (
      !record(rawList) ||
      !int(rawList.total_count) ||
      !Array.isArray(rawList.artifacts) ||
      rawList.artifacts.some((a) => !record(a)) ||
      rawList.total_count > 1000
    )
      fail('Artifact listing is incomplete or malformed');
    if (total !== undefined && total !== rawList.total_count)
      fail('Artifact list changed during attestation');
    total = rawList.total_count;
    artifacts.push(...(rawList.artifacts as Record<string, unknown>[]));
    if (artifacts.length >= total) break;
    if (rawList.artifacts.length !== 100) fail('Artifact pagination is incomplete');
  }
  if (total === undefined || artifacts.length !== total) fail('Artifact listing exceeded bounds');
  const attemptStarted = date(raw.run_started_at);
  if (!Number.isFinite(attemptStarted)) fail('Workflow attempt start time missing');
  const matching = artifacts.filter(
    (a) =>
      a.name === config.artifact_name &&
      date(a.created_at) >= attemptStarted &&
      date(a.created_at) <= completed + 30000,
  );
  if (matching.length !== 1) fail('Expected exactly one named evidence artifact');
  const a = matching[0]!;
  if (
    !int(a.id, 1) ||
    a.expired !== false ||
    !int(a.size_in_bytes, 1) ||
    a.size_in_bytes > MAX_ZIP ||
    typeof a.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(a.digest) ||
    !record(a.workflow_run) ||
    a.workflow_run.id !== spec.id ||
    a.workflow_run.head_sha !== spec.sha
  )
    fail('Artifact identity, expiry, digest or size rejected');
  // Run attempt is not part of artifact metadata. Creation time binds the artifact to this attempt.
  const created = date(a.created_at),
    started = date(raw.run_started_at);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(started) ||
    created < started ||
    created > completed + 30000
  )
    fail('Artifact does not belong to the requested run attempt');
  const zip = await api.artifact(`${repo}/actions/artifacts/${a.id}/zip`);
  if (zip.length !== a.size_in_bytes || sha256(zip) !== a.digest.slice(7))
    fail('Downloaded artifact size or SHA256 differs from GitHub metadata');
  return {
    report: normalized(extractReport(zip), spec.sha, String(raw.conclusion)),
    provenance: {
      run_id: spec.id,
      run_attempt: spec.attempt,
      head_sha: spec.sha,
      event: spec.event,
      conclusion: String(raw.conclusion),
      workflow_id: config.workflow.id,
      workflow_path: config.workflow.path,
      workflow_sha256: config.workflow.sha256,
      reusable_sha: config.workflow.reusable.sha,
      artifact_id: a.id,
      artifact_sha256: a.digest.slice(7),
    },
  };
}
async function external(file: string, root: string): Promise<string> {
  const resolved = await realpath(file);
  if (within(root, resolved))
    fail(
      'Attestor configuration, context, authority and keys must be outside candidate repository',
    );
  return resolved;
}
function contextFrom(v: unknown, config: AttestorConfig, policy: Policy, hash: string): GateRun {
  if (
    !record(v) ||
    v.schema_version !== 1 ||
    v.repository !== config.repository ||
    typeof v.base_sha !== 'string' ||
    !SHA.test(v.base_sha) ||
    typeof v.candidate_sha !== 'string' ||
    !SHA.test(v.candidate_sha) ||
    v.policy_revision !== policy.revision ||
    v.policy_sha256 !== hash ||
    !record(v.measurement_fingerprint)
  )
    fail('Trusted gate context is missing or mismatched');
  const m = v.measurement_fingerprint;
  if (
    m.cccc_version !== policy.measurement.version ||
    m.cccc_sha256 !== policy.measurement.sha256 ||
    m.policy_revision !== policy.revision ||
    typeof m.runner_commit !== 'string' ||
    !HASH.test(m.runner_commit) ||
    typeof m.toolchain_sha256 !== 'string' ||
    !HASH.test(m.toolchain_sha256) ||
    !Array.isArray(m.arguments) ||
    m.arguments.some((x) => typeof x !== 'string')
  )
    fail('Gate measurement fingerprint mismatch');
  return v as unknown as GateRun;
}
function defaultActors(policy: Policy): Evidence['actors'] {
  // No claim to know PR participants. Excluding the entire authority roster disables all approvals.
  return {
    author: 'nyorori-authority-unavailable',
    participants: [...new Set(Object.values(policy.identities).flat())],
    agent_initiators: [],
  };
}
async function operatorAuthority(
  file: string,
  root: string,
  payload: Evidence,
  policy: Policy,
  now: number,
): Promise<void> {
  const input = await readJson(await external(file, root), MAX_JSON);
  if (!record(input) || input.schema_version !== 1) fail('Invalid operator authority registry');
  for (const key of [
    'repository',
    'base_sha',
    'candidate_sha',
    'policy_revision',
    'policy_sha256',
    'measurement_fingerprint',
  ] as const)
    if (input[key] !== payload[key]) fail('Operator authority registry context mismatch');
  const expiry = date(input.expires_at),
    issued = date(input.issued_at);
  if (
    !Number.isFinite(expiry) ||
    !Number.isFinite(issued) ||
    issued > now + 30000 ||
    expiry <= now ||
    expiry - issued > 86400000 ||
    now - issued > 86400000
  )
    fail('Operator authority registry expired');
  const actors = input.actors;
  if (
    !record(actors) ||
    !id(actors.author) ||
    !Array.isArray(actors.participants) ||
    !Array.isArray(actors.agent_initiators) ||
    actors.participants.length > 10000 ||
    actors.agent_initiators.length > 10000 ||
    [...actors.participants, ...actors.agent_initiators].some((x) => !id(x))
  )
    fail('Operator actor registry malformed');
  payload.actors = {
    author: actors.author as string,
    participants: actors.participants as string[],
    agent_initiators: actors.agent_initiators as string[],
  };
  for (const key of ['reviews', 'waivers', 'protected_change_approvals'] as const)
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 1000))
      fail('Operator approval list malformed');
  if (input.reviews) {
    payload.reviews = input.reviews as Evidence['reviews'];
    if (!payload.reviews!.every((r) => validReview(r, payload, policy)))
      fail('Operator review violates current policy or actor independence');
  }
  if (input.waivers) {
    payload.waivers = input.waivers as Evidence['waivers'];
    for (const w of payload.waivers!) {
      if (
        !w ||
        !independent(w.actor, payload, policy, 'waiver_approvers') ||
        w.head_sha !== payload.candidate_sha ||
        w.gate !== 'complexity' ||
        w.metric !== 'cognitive' ||
        !string(w.id) ||
        !string(w.unit) ||
        w.unit.includes('*') ||
        !SHA.test(w.blob_sha) ||
        !int(w.ceiling) ||
        !string(w.reason) ||
        !Number.isFinite(date(w.expires_at)) ||
        !Number.isFinite(date(w.issued_at)) ||
        date(w.expires_at) <= now ||
        date(w.issued_at) > now + 30000 ||
        date(w.expires_at) <= date(w.issued_at) ||
        date(w.expires_at) - date(w.issued_at) > policy.waiver.max_days * 86400000
      )
        fail('Operator waiver violates current policy');
    }
  }
  if (input.protected_change_approvals) {
    payload.protected_change_approvals =
      input.protected_change_approvals as Evidence['protected_change_approvals'];
    for (const a of payload.protected_change_approvals!) {
      if (
        !a ||
        !independent(a.actor, payload, policy, 'gate_owners') ||
        a.head_sha !== payload.candidate_sha ||
        !Array.isArray(a.paths) ||
        a.paths.length > 10000 ||
        a.paths.some((x) => !string(x, 4096) || x.includes('\0'))
      )
        fail('Operator protected approval violates current policy');
    }
  }
}
export async function attestEvidence(options: AttestOptions): Promise<EvidenceEnvelope> {
  const now = (options.now ?? Date.now)();
  const root = await realpath(repositoryRoot(options.repo));
  const { policy, hash } = await loadPolicy(options.policyPath, root);
  const config = validateAttestorConfig(await readJson(await external(options.configPath, root)));
  if (!policy.evidence || config.issuer !== policy.evidence.issuer)
    fail('Attestor issuer is not trusted by policy');
  const context = contextFrom(
    await readJson(await external(options.contextPath, root), MAX_JSON),
    config,
    policy,
    hash,
  );
  if (
    ![options.baseRun, options.baseAttempt, options.candidateRun, options.candidateAttempt].every(
      (x) => int(x, 1),
    )
  )
    fail('Run IDs and attempts must be positive integers');
  const keyFile = await external(options.keyPath, root),
    info = await stat(keyFile);
  if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0)
    fail('Signing key must be a private regular file with mode 0600 or stricter');
  let key;
  try {
    key = createPrivateKey(await readFile(keyFile));
  } catch {
    fail('Cannot load evidence signing key');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('Evidence signing key must be Ed25519');
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' }),
    expected = createPublicKey(policy.evidence.public_key).export({ type: 'spki', format: 'der' });
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail('Signing key does not match trusted policy public key');
  const token = options.token ?? process.env.NYORORI_ATTESTOR_TOKEN;
  if (!token)
    fail('NYORORI_ATTESTOR_TOKEN is required for read-only GitHub Actions evidence access');
  const api = new GitHubEvidenceApi(token, options.fetch ?? fetch);
  const [base, candidate] = await Promise.all([
    collect(
      api,
      config,
      {
        id: options.baseRun,
        attempt: options.baseAttempt,
        sha: context.base_sha,
        event: config.base_event,
      },
      now,
    ),
    collect(
      api,
      config,
      {
        id: options.candidateRun,
        attempt: options.candidateAttempt,
        sha: context.candidate_sha,
        event: config.candidate_event,
      },
      now,
    ),
  ]);
  const payload: Evidence & { provenance: unknown } = {
    schema_version: 1,
    issuer: config.issuer,
    repository: config.repository,
    base_sha: context.base_sha,
    candidate_sha: context.candidate_sha,
    policy_revision: policy.revision,
    policy_sha256: hash,
    measurement_fingerprint: sha256(canonical(context.measurement_fingerprint)),
    issued_at: new Date(now).toISOString(),
    actors: defaultActors(policy),
    tests: { base: base.report.tests, candidate: candidate.report.tests },
    ...(candidate.report.coverage ? { coverage: candidate.report.coverage } : {}),
    ...(candidate.report.mutation ? { mutation: candidate.report.mutation } : {}),
    provenance: {
      schema_version: 1,
      kind: 'github-actions-artifacts',
      base: base.provenance,
      candidate: candidate.provenance,
      approval_authority: options.authorityPath ? 'operator-file' : 'none',
    },
  };
  if (options.authorityPath)
    await operatorAuthority(options.authorityPath, root, payload, policy, now);
  const envelope: EvidenceEnvelope = {
    payload,
    signature: sign(null, Buffer.from(canonical(payload)), key).toString('base64'),
  };
  const output = path.resolve(options.out),
    parent = await realpath(path.dirname(output));
  if (
    parent !== path.resolve(path.dirname(output)) ||
    within(root, path.join(parent, path.basename(output)))
  )
    fail('Attestation output must use an external real directory');
  await writeFile(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return envelope;
}
export async function mainAttestor(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.includes('--help')) {
      process.stdout.write(
        'nyorori attest --repo PATH --config TRUSTED_JSON --policy TRUSTED_JSON --context GATE_RESULT --key EXTERNAL_ED25519_PEM --base-run ID --base-attempt N --candidate-run ID --candidate-attempt N --out NEW_SIGNED_JSON [--authority TRUSTED_CONTROL_PLANE_JSON]\n',
      );
      return 0;
    }
    const names = [
      'repo',
      'config',
      'policy',
      'context',
      'key',
      'base-run',
      'base-attempt',
      'candidate-run',
      'candidate-attempt',
      'out',
      'authority',
    ];
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(names.map((n) => [n, { type: 'string' as const }])),
    });
    for (const name of names.filter((x) => x !== 'authority'))
      if (!values[name]) fail(`Missing --${name}`);
    const envelope = await attestEvidence({
      repo: values.repo!,
      configPath: values.config!,
      policyPath: values.policy!,
      contextPath: values.context!,
      keyPath: values.key!,
      baseRun: Number(values['base-run']),
      baseAttempt: Number(values['base-attempt']),
      candidateRun: Number(values['candidate-run']),
      candidateAttempt: Number(values['candidate-attempt']),
      out: values.out!,
      authorityPath: values.authority,
    });
    process.stdout.write(
      JSON.stringify({
        state: 'ATTESTED',
        repository: envelope.payload.repository,
        base_sha: envelope.payload.base_sha,
        candidate_sha: envelope.payload.candidate_sha,
        approval_authority: values.authority ? 'operator-file' : 'none',
      }) + '\n',
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        state: 'INCONCLUSIVE',
        reason: 'ATTESTATION_REJECTED',
        message: error instanceof Error ? error.message : 'Attestation failed',
      }) + '\n',
    );
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  mainAttestor().then((code) => {
    process.exitCode = code;
  });
