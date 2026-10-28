import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateDependencies } from '../dist/structure.js';
import { readTree } from '../dist/git.js';
import { runGate } from '../dist/runner.js';

const example = JSON.parse(
  await readFile(new URL('../examples/policy.json', import.meta.url), 'utf8'),
);
const source = (path, content, classification = 'non-code') => ({
  path,
  content,
  classification,
  mode: '100644',
  blob_sha: 'a'.repeat(40),
});
const app = source('src/a.ts', 'export const a=1;', 'source');
const snapshot = {
  base_sha: 'b'.repeat(40),
  candidate_sha: 'c'.repeat(40),
  manifest: [],
  issues: [],
  files: [
    {
      status: 'M',
      before: app,
      after: app,
      oldPath: app.path,
      newPath: app.path,
      hunks: [],
      lineMap: new Map(),
    },
  ],
};
const policy = { ...example, gates: { ...example.gates, deps: 'enforce' } };
async function graph(metadata) {
  return evaluateDependencies([app], [app, metadata], snapshot, policy);
}

test('resolution-affecting TypeScript options cannot certify a relative-only graph', async () => {
  for (const [name, value] of Object.entries({
    rootDirs: ['src', 'generated'],
    moduleSuffixes: ['.native', ''],
    customConditions: ['development'],
    moduleResolution: 'bundler',
    resolvePackageJsonImports: false,
    preserveSymlinks: true,
    jsxImportSource: './runtime',
  })) {
    const result = await graph(
      source('tsconfig.json', JSON.stringify({ compilerOptions: { [name]: value } })),
    );
    assert.equal(result.state, 'INCONCLUSIVE', name);
    assert.ok(
      result.issues.some(
        (i) => i.code === 'DEPENDENCY_RESOLUTION_UNSUPPORTED' && i.message.includes(name),
      ),
      name,
    );
  }
});

test('JSONC is parsed as data and escaped option names cannot evade the resolver boundary', async () => {
  const unsafe = String.raw`{ // comment
  "compilerOptions": { "root\u0044irs": ["src", "hidden"], },
 }`;
  const bad = await graph(source('nested/tsconfig.base.jsonc', unsafe));
  assert.equal(bad.state, 'INCONCLUSIVE');
  assert.ok(bad.issues.some((i) => i.message.includes('rootDirs')));
  const benign = await graph(
    source(
      'jsconfig.jsonc',
      '{/* paths in comments have no effect */"compilerOptions":{"strict":true,"target":"ES2023",},}',
    ),
  );
  assert.equal(benign.state, 'PASS');
});

test('conventional executable bundler configs are rejected by presence and never executed', async () => {
  globalThis.__nyororiResolverExecuted = false;
  for (const path of [
    'vite.config.ts',
    'webpack.production.config.cjs',
    'build/rollup.config.mjs',
    'esbuild.js',
    '.babelrc.json',
    '.swcrc',
  ]) {
    const result = await graph(
      source(
        path,
        'globalThis.__nyororiResolverExecuted=true; throw new Error("never execute");',
        'source',
      ),
    );
    assert.equal(result.state, 'INCONCLUSIVE', path);
    assert.ok(
      result.issues.some((i) => i.code === 'DEPENDENCY_RESOLUTION_UNSUPPORTED' && i.file === path),
      path,
    );
  }
  assert.equal(globalThis.__nyororiResolverExecuted, false);
  delete globalThis.__nyororiResolverExecuted;
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nyorori-resolver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  await writeFile(join(repo, 'a.ts'), 'export const a=1;\n');
  git('add', '--all');
  git('commit', '-qm', 'base');
  return {
    root,
    repo,
    git,
    base: git('rev-parse', 'HEAD'),
    commit() {
      git('add', '--all');
      git('commit', '-qm', 'candidate');
      return git('rev-parse', 'HEAD');
    },
  };
}

test('JSONC resolver metadata is loaded from blobs and malformed UTF8 fails closed', async (t) => {
  const f = await fixture(t);
  const content = '{"compilerOptions":{"rootDirs":["src","other"]}}';
  await writeFile(join(f.repo, 'tsconfig.base.jsonc'), content);
  const candidate = f.commit();
  const tree = await readTree(f.repo, candidate, policy);
  assert.equal(tree.find((x) => x.path === 'tsconfig.base.jsonc').content, content);
  await writeFile(join(f.repo, 'tsconfig.base.jsonc'), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
  const broken = f.commit();
  await assert.rejects(readTree(f.repo, broken, policy), (e) => e.code === 'MANIFEST_MISMATCH');
});

test('JSONC configuration-only changes run G3 and retain INCONCLUSIVE evidence', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, 'tsconfig.jsonc'),
    '{"compilerOptions":{"moduleSuffixes":[".hidden",""]}}',
  );
  const candidate = f.commit();
  const config = {
    ...policy,
    measurement: { ...policy.measurement, binary: join(f.root, 'unused-external-cccc') },
  };
  const policyPath = join(f.root, 'trusted-policy.json');
  await writeFile(policyPath, JSON.stringify(config));
  const run = await runGate({
    repo: f.repo,
    base: f.base,
    candidate,
    policyPath,
    out: join(f.root, 'result'),
  });
  const deps = run.gates.find((g) => g.gate === 'deps');
  assert.equal(deps.state, 'INCONCLUSIVE');
  assert.ok(
    deps.issues.some(
      (i) => i.code === 'DEPENDENCY_RESOLUTION_UNSUPPORTED' && i.file === 'tsconfig.jsonc',
    ),
  );
});
