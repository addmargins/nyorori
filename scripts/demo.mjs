import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGate } from '../dist/runner.js';
const binary = process.argv[process.argv.indexOf('--cccc') + 1];
if (!process.argv.includes('--cccc') || !binary) {
  console.error('Usage: npm run demo -- --cccc /absolute/path/to/verified/cccc');
  process.exit(2);
}
const root = await mkdtemp(join(tmpdir(), 'nyorori-demo-'));
const repo = join(root, 'application');
await mkdir(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'demo@example.invalid');
git('config', 'user.name', 'Nyorori demo');
git('config', 'commit.gpgsign', 'false');
await writeFile(join(repo, 'README.md'), 'Demonstration application\n');
git('add', '.');
git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
const source =
  'export function price(order) {\n' +
  Array.from({ length: 6 }, (_, i) => '  '.repeat(i + 1) + `if (order.flag${i}) {`).join('\n') +
  '\n' +
  '  '.repeat(7) +
  'return 1;\n' +
  Array.from({ length: 6 }, (_, i) => '  '.repeat(6 - i) + '}').join('\n') +
  '\nreturn 0;\n}\n';
await writeFile(join(repo, 'price.ts'), source);
git('add', '.');
git('commit', '-qm', 'candidate');
const candidate = git('rev-parse', 'HEAD');
const policy = JSON.parse(
  await readFile(new URL('../examples/policy.json', import.meta.url), 'utf8'),
);
policy.measurement.binary = resolve(binary);
const policyPath = join(root, 'trusted-policy.json');
await writeFile(policyPath, JSON.stringify(policy));
const out = join(root, 'report');
const result = await runGate({
  repo,
  base,
  candidate,
  policyPath,
  out,
  repository: 'demo/application',
});
console.log(await readFile(join(out, 'gate-summary.md'), 'utf8'));
console.log(`Artifacts: ${out}`);
console.log(
  `Shadow aggregate=${result.state}; G1=${result.gates.find((g) => g.gate === 'complexity').state}; would_block=${result.would_block}`,
);
