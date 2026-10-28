import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSnapshot } from '../dist/git.js';
import { measureSnapshot } from '../dist/measurer.js';
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nyorori-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  const binary = path.join(root, 'cccc');
  const script = `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv.includes('--version')){console.log('cccc 1.8.5');process.exit(0)}\nconst files=process.argv.slice(process.argv.indexOf('--')+1).map(path=>{const source=fs.readFileSync(path,'utf8'); const n=Number(/cog=(\\d+)/.exec(source)?.[1]??0);return {path,cognitive:n,cyclomatic:1,functions:[{name:'f',kind:'function',line:1,cognitive:n,cyclomatic:1}],...(source.includes('parse_error')?{parse_errors:['fixture parse error']}:{})}});\nconsole.log(JSON.stringify({files,summary:{file_count:files.length}}));\n`;
  await writeFile(binary, script, { mode: 0o700 });
  const policy = {
    schema_version: 1,
    revision: 'fixture',
    phase: 'P2',
    gates: {},
    measurement: {
      binary,
      sha256: createHash('sha256').update(script).digest('hex'),
      version: 'cccc 1.8.5',
      timeout_ms: 5000,
      jobs: 4,
      max_file_bytes: 2 * 1024 * 1024,
      jsx_in_js: false,
    },
    scope: {
      source_extensions: ['.ts', '.js', '.jsx'],
      unmeasured_extensions: ['.vue'],
      non_code_extensions: ['.md', '.json', '.toml'],
      test_globs: ['**/*.test.ts'],
      exclude_globs: ['vendor/**'],
      protected_globs: [],
    },
    limits: { cognitive: 15 },
  };
  return {
    root,
    repo,
    binary,
    policy,
    commit: () => {
      git(repo, 'add', '--all');
      git(repo, 'commit', '-qm', 'fixture');
      return git(repo, 'rev-parse', 'HEAD');
    },
  };
}
test('blob source ignores candidate attributes and literal pathspec magic cannot corrupt hunk maps', async (t) => {
  const f = await fixture(t);
  const name = ':(glob)*.ts';
  await writeFile(path.join(f.repo, name), 'function f(){ // cog=1\nreturn 1;\n}\n');
  await writeFile(path.join(f.repo, 'other.ts'), 'function g(){\nreturn 2;\n}\n');
  const b = f.commit();
  await writeFile(path.join(f.repo, name), 'function f(){ // cog=2\nreturn 1;\n}\n');
  await writeFile(path.join(f.repo, 'other.ts'), 'function g(){\nreturn 3;\n}\n');
  await writeFile(path.join(f.repo, '.gitattributes'), '*.ts working-tree-encoding=UTF-16\n');
  // Stage blobs directly to bypass checkout encoding; attributes must not affect measurement.
  git(f.repo, '-c', 'core.attributesFile=/dev/null', 'add', '--renormalize', '.gitattributes');
  for (const p of [name, 'other.ts', '.gitattributes']) {
    const body = await readFile(path.join(f.repo, p));
    const sha = execFileSync('git', ['-C', f.repo, 'hash-object', '-w', '--stdin'], {
      input: body,
      encoding: 'utf8',
    }).trim();
    git(f.repo, 'update-index', '--add', '--cacheinfo', `100644,${sha},${p}`);
  }
  git(f.repo, 'commit', '-qm', 'candidate');
  const c = git(f.repo, 'rev-parse', 'HEAD');
  const snapshot = await buildSnapshot(f.repo, b, c, f.policy);
  assert.deepEqual(snapshot.issues, []);
  const changed = snapshot.files.find((x) => x.newPath === name);
  assert.equal(changed.hunks.length, 1);
  assert.equal(changed.hunks[0].oldStart, 1);
  assert.equal(changed.lineMap.get(2), 2);
  assert.match(changed.after.content, /cog=2/);
});
test('baseline parse errors stay evidence while candidate parse errors fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'a.ts'), 'function f(){} // cog=0 parse_error\n');
  const b = f.commit();
  await writeFile(path.join(f.repo, 'a.ts'), 'function f(){} // cog=1\n');
  const c = f.commit();
  let snapshot = await buildSnapshot(f.repo, b, c, f.policy);
  let measured = await measureSnapshot(snapshot, f.policy, path.join(f.root, 'out1'), 'runner');
  assert.deepEqual(measured.issues, []);
  assert.equal(measured.base['a.ts'].parse_errors.length, 1);
  assert.equal(measured.candidate['a.ts'].cognitive, 1);
  snapshot = await buildSnapshot(f.repo, c, b, f.policy);
  measured = await measureSnapshot(snapshot, f.policy, path.join(f.root, 'out2'), 'runner');
  assert.ok(measured.issues.some((x) => x.code === 'PARSE_ERROR_CANDIDATE'));
});
test('private hashed measurer copy rejects binary hash drift and retains raw artifact names', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'README.md'), 'base\n');
  const b = f.commit();
  await writeFile(path.join(f.repo, 'a.ts'), 'function f(){} // cog=2\n');
  const c = f.commit();
  const snapshot = await buildSnapshot(f.repo, b, c, f.policy);
  f.policy.measurement.sha256 = '0'.repeat(64);
  const out = path.join(f.root, 'out');
  const measured = await measureSnapshot(snapshot, f.policy, out, 'runner');
  assert.ok(measured.issues.some((x) => x.code === 'MEASURER_MISMATCH'));
  assert.equal(await readFile(path.join(out, 'raw.C.stderr'), 'utf8'), '');
});
test('identical bytes moved from test scope to production are remeasured', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'a.test.ts'), 'function f(){} // cog=18\n');
  const b = f.commit();
  git(f.repo, 'mv', 'a.test.ts', 'a.ts');
  const c = f.commit();
  const snapshot = await buildSnapshot(f.repo, b, c, f.policy);
  assert.equal(snapshot.files[0].before.classification, 'test');
  assert.equal(snapshot.files[0].after.classification, 'source');
  const measured = await measureSnapshot(snapshot, f.policy, path.join(f.root, 'out'), 'runner');
  assert.deepEqual(measured.issues, []);
  assert.equal(measured.candidate['a.ts'].cognitive, 18);
  assert.equal(measured.base['a.test.ts'].cognitive, 18);
});
test('snapshot stops before reading blobs beyond aggregate B/C byte budget', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'README.md'), 'base\n');
  const b = f.commit();
  const content = '//' + 'x'.repeat(1_999_997) + '\n';
  for (let i = 0; i < 34; i++)
    await writeFile(path.join(f.repo, `f${String(i).padStart(2, '0')}.ts`), content);
  const c = f.commit();
  const snapshot = await buildSnapshot(f.repo, b, c, f.policy);
  assert.ok(snapshot.issues.some((x) => x.code === 'RESOURCE_LIMIT'));
  assert.equal(
    snapshot.files.length,
    33,
    'do not materialize and retain the whole 68 MB change before applying its budget',
  );
  assert.ok(
    snapshot.files.reduce(
      (n, f) =>
        n + Buffer.byteLength(f.after?.content ?? '') + Buffer.byteLength(f.before?.content ?? ''),
      0,
    ) <=
      64 * 1024 * 1024,
  );
});
