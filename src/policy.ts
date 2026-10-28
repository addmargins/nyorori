import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GATES, type Policy } from './types.js';

// Do not use textual prefix checks: /repo-other is outside /repo.
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
export async function readJson(path: string, maxBytes = 2_000_000): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes)
    throw new Error('JSON input is not a regular bounded file');
  return JSON.parse(await readFile(path, 'utf8'));
}
function object(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
}
function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 16384)
    throw new Error(`${name} must be a nonempty string`);
  return v;
}
function strings(v: unknown, name: string): string[] {
  if (
    !Array.isArray(v) ||
    v.length > 1000 ||
    !v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 1000)
  )
    throw new Error(`${name} must be a bounded string array`);
  return v;
}
function integer(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error(`${name} must be ${min}..${max}`);
  return v;
}
export function validatePolicy(value: unknown): Policy {
  const p = object(value, 'policy');
  if (p.schema_version !== 1) throw new Error('Unsupported policy schema_version');
  str(p.revision, 'revision');
  if (typeof p.phase !== 'string' || !['P0', 'P1', 'P2', 'P3'].includes(p.phase))
    throw new Error('Invalid rollout phase');
  const g = object(p.gates, 'gates');
  for (const id of GATES)
    if (typeof g[id] !== 'string' || !['observe', 'enforce'].includes(g[id] as string))
      throw new Error(`Missing/invalid gate mode: ${id}`);
  if (Object.keys(g).some((id) => !GATES.includes(id as (typeof GATES)[number])))
    throw new Error('Unknown gate');
  const m = object(p.measurement, 'measurement');
  str(m.binary, 'binary');
  if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256))
    throw new Error('Expected pinned cccc SHA256');
  if (m.version !== 'cccc 1.8.5')
    throw new Error(
      'This contract supports exactly cccc 1.8.5; upgrades require fixtures and policy review',
    );
  integer(m.timeout_ms, 'timeout_ms', 1, 120000);
  integer(m.jobs, 'jobs', 1, 8);
  integer(m.max_file_bytes, 'max_file_bytes', 1, 2_000_000);
  if (typeof m.jsx_in_js !== 'boolean') throw new Error('jsx_in_js must be boolean');
  const s = object(p.scope, 'scope');
  for (const k of [
    'source_extensions',
    'unmeasured_extensions',
    'non_code_extensions',
    'test_globs',
    'exclude_globs',
    'protected_globs',
  ])
    strings(s[k], k);
  const allExt = [
    ...(s.source_extensions as string[]),
    ...(s.unmeasured_extensions as string[]),
    ...(s.non_code_extensions as string[]),
  ];
  if (allExt.some((x) => !/^\.[a-zA-Z0-9.]+$/.test(x)) || new Set(allExt).size !== allExt.length)
    throw new Error('Extensions must be explicit, unique and disjoint');
  const supported = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
  if ((s.source_extensions as string[]).some((x) => !supported.has(x)))
    throw new Error('Unsupported measured extension');
  const l = object(p.limits, 'limits');
  for (const [k, min, max] of [
    ['cognitive', 1, 100],
    ['max_params', 1, 20],
    ['max_callbacks', 1, 10],
    ['max_function_lines', 1, 1000],
    ['coverage_uncovered', 0, 1000],
  ] as const)
    integer(l[k], k, min, max);
  if (
    typeof l.coverage_fraction !== 'number' ||
    !Number.isFinite(l.coverage_fraction) ||
    l.coverage_fraction < 0 ||
    l.coverage_fraction > 1
  )
    throw new Error('Invalid coverage_fraction');
  const d = object(p.dependencies, 'dependencies');
  if (!Array.isArray(d.forbidden) || d.forbidden.length > 1000)
    throw new Error('Invalid dependency policy');
  for (const e of d.forbidden) {
    const edge = object(e, 'edge');
    str(edge.from, 'from');
    str(edge.to, 'to');
  }
  const ids = object(p.identities, 'identities');
  for (const k of ['simplification_reviewers', 'waiver_approvers', 'gate_owners', 'bots'])
    strings(ids[k], k);
  const c = object(p.coverage, 'coverage');
  str(c.provider, 'provider');
  str(c.version, 'coverage version');
  const w = object(p.waiver, 'waiver');
  integer(w.max_per_pr, 'max_per_pr', 0, 100);
  integer(w.max_days, 'max_days', 1, 90);
  if (p.evidence !== undefined) {
    const e = object(p.evidence, 'evidence');
    str(e.public_key, 'evidence public key');
    str(e.issuer, 'issuer');
    integer(e.max_age_seconds, 'max_age_seconds', 1, 86400);
  }
  return value as Policy;
}
export async function loadPolicy(
  path: string,
  repo: string,
): Promise<{ policy: Policy; hash: string; path: string }> {
  const bare =
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim() === 'true';
  const gitRoot = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'],
    { encoding: 'utf8', timeout: 10000 },
  ).trim();
  const [root, file] = await Promise.all([realpath(gitRoot), realpath(resolve(path))]);
  if (within(root, file))
    throw new Error('Trusted policy must be outside the candidate repository');
  const policy = validatePolicy(await readJson(file));
  if (!isAbsolute(policy.measurement.binary))
    throw new Error('Measurer binary must be an absolute external path');
  let binary: string;
  try {
    binary = await realpath(policy.measurement.binary);
  } catch {
    binary = resolve(policy.measurement.binary);
  }
  if (within(root, binary))
    throw new Error('Measurer binary must be outside the candidate repository');
  return { policy, hash: sha256(canonical(policy)), path: file };
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
