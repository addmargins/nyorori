import { execFileSync } from 'node:child_process';
import { readdir, realpath, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, canonical, sha256, within } from './policy.js';
import { buildSnapshot, readTree, resolutionMetadata } from './git.js';
import { measureSnapshot } from './measurer.js';
import { evaluateComplexity } from './complexity.js';
import { evaluateStructure, evaluateDependencies } from './structure.js';
import { verifyEvidence, evaluateReview, applyWaivers } from './evidence.js';
import { evaluateTests, evaluateCoverage, evaluateMutation } from './test-gates.js';
import { aggregate } from './aggregate.js';
import { writeReports } from './reports.js';
import { gateResult, type GateResult, type GateRun, type Issue, type Snapshot } from './types.js';
export interface RunOptions {
  repo: string;
  base: string;
  candidate: string;
  policyPath: string;
  out: string;
  evidencePath?: string;
  rollingBase?: string;
  repository?: string;
}
export function repositoryRoot(repo: string): string {
  const opts = {
    encoding: 'utf8' as const,
    timeout: 10000,
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  };
  const bare =
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-bare-repository'], opts).trim() === 'true';
  return execFileSync(
    'git',
    ['-C', repo, 'rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'],
    opts,
  ).trim();
}
async function outputDirectory(out: string, repo: string): Promise<string> {
  const resolved = path.resolve(out);
  const parent = await realpath(path.dirname(resolved));
  // Resolve existing ancestors before creating anything; symlink components cannot redirect output.
  if (parent !== path.resolve(path.dirname(resolved)))
    throw new Error('Output parent must use its real path without symlinks');
  const root = await realpath(repo);
  if (within(root, path.join(parent, path.basename(resolved))))
    throw new Error('Output must be outside candidate repository');
  try {
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(resolved)).length)
      throw new Error('Output must be a new or empty real directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') await mkdir(resolved, { mode: 0o700 });
    else throw error;
  }
  return resolved;
}
async function runnerDigest(): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const names = (await readdir(dir)).filter((x) => x.endsWith('.js')).sort();
  const files = await Promise.all(
    names.map(async (n) => n + '\0' + (await readFile(path.join(dir, n), 'utf8'))),
  );
  return sha256(files.join('\0'));
}
function safeFailure(gate: GateResult, error: unknown, code: string): GateResult {
  gate.state = 'INCONCLUSIVE';
  gate.reasons = [code];
  gate.issues = [{ code, message: error instanceof Error ? error.message : 'Analysis failed' }];
  return gate;
}
export async function runGate(options: RunOptions): Promise<GateRun> {
  const repo = await realpath(repositoryRoot(options.repo));
  const { policy, hash } = await loadPolicy(options.policyPath, repo);
  const out = await outputDirectory(options.out, repo);
  const repository = options.repository ?? path.basename(repo).replace(/\.git$/, '');
  let snapshot: Snapshot;
  try {
    snapshot = await buildSnapshot(repo, options.base, options.candidate, policy);
  } catch (error) {
    snapshot = {
      base_sha: options.base,
      candidate_sha: options.candidate,
      files: [],
      manifest: [],
      issues: [
        { code: 'GIT_INPUT', message: error instanceof Error ? error.message : 'Git input failed' },
      ],
    };
  }
  const measurement = await measureSnapshot(snapshot, policy, out, await runnerDigest());
  const context = {
    repository,
    base_sha: snapshot.base_sha,
    candidate_sha: snapshot.candidate_sha,
    policy_revision: policy.revision,
    policy_sha256: hash,
    measurement_fingerprint: sha256(canonical(measurement.fingerprint)),
  };
  const verified = await verifyEvidence(options.evidencePath, context, policy);
  const e = verified.evidence;
  let complexity = evaluateComplexity(snapshot, measurement, policy);
  const structural = await evaluateStructure(snapshot, measurement, policy);
  if (snapshot.issues.length) {
    complexity.issues.push(...snapshot.issues);
    if (complexity.state !== 'FAIL') complexity.state = 'INCONCLUSIVE';
    complexity.reasons = [
      ...new Set([...complexity.reasons, ...snapshot.issues.map((x) => x.code)]),
    ];
  }
  let deps: GateResult = gateResult('deps', policy, 'NOT_APPLICABLE');
  if (
    snapshot.files.some(
      (x) =>
        [x.before, x.after].some((f) => f && ['source', 'test'].includes(f.classification)) ||
        resolutionMetadata(x.newPath ?? x.oldPath ?? ''),
    )
  ) {
    try {
      const [base, candidate] = await Promise.all([
        readTree(repo, snapshot.base_sha, policy),
        readTree(repo, snapshot.candidate_sha, policy),
      ]);
      deps = await evaluateDependencies(base, candidate, snapshot, policy);
    } catch (error) {
      deps = safeFailure(gateResult('deps', policy), error, 'DEPENDENCY_INPUT');
    }
  }
  const scopeTriggers = snapshot.files.flatMap((c) => {
    const f = c.after;
    const file = c.newPath ?? c.oldPath ?? '';
    const items: GateResult['triggers'] = [];
    if (
      f?.classification === 'unmeasured' ||
      (f?.classification === 'excluded' && (!c.before || c.before.classification !== 'excluded')) ||
      ['.gitattributes', '.gitmodules'].includes(path.posix.basename(file))
    )
      items.push({
        id: 'S11',
        file,
        evidence: f?.reason ?? 'Measurement scope or git attributes changed',
      });
    return items;
  });
  complexity.triggers.push(...scopeTriggers);
  let rolling = options.rollingBase;
  if (!rolling) {
    try {
      const refs = execFileSync(
        'git',
        ['-C', repo, 'rev-list', '--first-parent', '--max-count=6', snapshot.base_sha],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } },
      )
        .trim()
        .split('\n');
      if (refs.length > 1) rolling = refs.at(-1);
    } catch {
      /* Baseline issues are already reported. */
    }
  }
  if (rolling && rolling !== snapshot.base_sha) {
    try {
      const rs = await buildSnapshot(repo, rolling, snapshot.candidate_sha, policy);
      const ro = path.join(out, 'rolling');
      await mkdir(ro);
      const rm = await measureSnapshot(rs, policy, ro, measurement.fingerprint.runner_commit);
      const rg = evaluateComplexity(rs, rm, policy);
      const rst = await evaluateStructure(rs, rm, policy);
      complexity.observe.rolling_base = rs.base_sha;
      complexity.triggers.push(
        ...[...rg.triggers, ...rst.triggers]
          .filter((x) => ['S1', 'S9', 'S10'].includes(x.id))
          .map((x) => ({
            ...x,
            evidence: `Rolling baseline ${rs.base_sha}: ${x.evidence}`,
            observe_only: ['P0', 'P1'].includes(policy.phase),
          })),
      );
      if (rs.issues.length || rm.issues.length || rst.issues.length) {
        complexity.issues.push(...rs.issues, ...rm.issues, ...rst.issues);
        if (complexity.state !== 'FAIL') complexity.state = 'INCONCLUSIVE';
        complexity.reasons.push('ROLLING_BASELINE_INCOMPLETE');
      }
    } catch (error) {
      complexity.issues.push({ code: 'ROLLING_BASELINE_INCOMPLETE', message: String(error) });
      if (complexity.state !== 'FAIL') complexity.state = 'INCONCLUSIVE';
      complexity.reasons.push('ROLLING_BASELINE_INCOMPLETE');
    }
  }
  complexity = applyWaivers(complexity, e, policy);
  const tests = evaluateTests(snapshot, e, policy),
    coverage = evaluateCoverage(snapshot, e, policy),
    mutation = evaluateMutation(snapshot, e, policy);
  if (verified.issues.length) {
    for (const g of [tests, coverage, mutation]) {
      g.issues.push(...verified.issues);
      if (g.state !== 'FAIL') g.state = 'INCONCLUSIVE';
      g.reasons = [...new Set([...g.reasons, ...verified.issues.map((x) => x.code)])];
    }
  }
  const pre = [complexity, structural, deps, tests, coverage, mutation];
  const seen = new Set<string>();
  const triggers = pre
    .flatMap((g) => g.triggers)
    .filter((t) => {
      const key = canonical(t);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        a.file.localeCompare(b.file) ||
        a.evidence.localeCompare(b.evidence),
    );
  const review = evaluateReview(triggers, e, policy);
  const gates = [complexity, structural, deps, tests, coverage, review, mutation];
  const run: GateRun = {
    schema_version: 1,
    authority: 'local',
    repository,
    base_sha: snapshot.base_sha,
    candidate_sha: snapshot.candidate_sha,
    policy_revision: policy.revision,
    phase: policy.phase,
    policy_sha256: hash,
    measurement_fingerprint: measurement.fingerprint,
    ...aggregate(gates),
    gates,
    triggers,
    evidence_verified: verified.verified,
    issues: snapshot.issues,
  };
  await writeReports(out, run, snapshot);
  return run;
}
