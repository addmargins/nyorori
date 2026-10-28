#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runGate } from './runner.js';
export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === 'attest') return (await import('./attestor.js')).mainAttestor(rest);
    if (command === 'replay') return (await import('./replay.js')).main(rest);
    if (command === '--version') {
      process.stdout.write('nyorori 0.1.0\n');
      return 0;
    }
    if (!command || command === '--help' || command === 'help') {
      process.stdout.write(
        'nyorori analyze --repo PATH --base REF --candidate REF --policy TRUSTED_JSON --out EMPTY_EXTERNAL_DIR [--repository owner/repo] [--evidence SIGNED_JSON] [--rolling-base REF]\n\nCommands: analyze, attest, replay. Use <command> --help for options.\nNode 24+. Local analysis never publishes merge approval. Policy and measurer must be outside the target repository. Exit: 0 accepted/shadow, 1 violation, 2 incomplete/error.\n',
      );
      return 0;
    }
    if (command !== 'analyze') throw new Error('Unknown command; use --help');
    const { values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(
        [
          'repo',
          'base',
          'candidate',
          'policy',
          'out',
          'repository',
          'evidence',
          'rolling-base',
        ].map((k) => [k, { type: 'string' as const }]),
      ),
    });
    for (const name of ['repo', 'base', 'candidate', 'policy', 'out'])
      if (typeof values[name] !== 'string' || !values[name]) throw new Error(`Missing --${name}`);
    const run = await runGate({
      repo: values.repo as string,
      base: values.base as string,
      candidate: values.candidate as string,
      policyPath: values.policy as string,
      out: values.out as string,
      repository: values.repository as string | undefined,
      evidencePath: values.evidence as string | undefined,
      rollingBase: values['rolling-base'] as string | undefined,
    });
    process.stdout.write(JSON.stringify(run) + '\n');
    return run.exit_code;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        schema_version: 1,
        authority: 'local',
        state: 'INCONCLUSIVE',
        exit_code: 2,
        check_conclusion: 'failure',
        issues: [
          {
            code: 'RUNNER_ERROR',
            message: error instanceof Error ? error.message : 'Analysis failed',
          },
        ],
      }) + '\n',
    );
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => {
    process.exitCode = code;
  });
