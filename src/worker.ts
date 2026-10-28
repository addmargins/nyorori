import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RunOptions } from './runner.js';
import type { GateRun } from './types.js';

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

export class AnalysisWorkerError extends Error {
  constructor(public readonly code: string) {
    super(`Isolated analysis worker failed: ${code}`);
    this.name = 'AnalysisWorkerError';
  }
}

/** Runs parsers and cccc outside the webhook/App credential process. This is a resource boundary, not an OS sandbox. */
export async function runAnalysisWorker(
  options: RunOptions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GateRun> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new AnalysisWorkerError('INVALID_TIMEOUT');
  const request = JSON.stringify(options);
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES)
    throw new AnalysisWorkerError('REQUEST_LIMIT');
  const modulePath = fileURLToPath(import.meta.url);
  return new Promise<GateRun>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--max-old-space-size=768', modulePath, '--child'], {
      cwd: dirname(modulePath),
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      // No App/GitHub/proxy/cloud credentials, NODE_OPTIONS, preload hooks, or candidate environment enters analysis.
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    let settled = false;
    let length = 0;
    const chunks: Buffer[] = [];
    const killGroup = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Process already exited. */
          }
        }
      }
    };
    const fail = (code: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      rejectRun(new AnalysisWorkerError(code));
    };
    const timer = setTimeout(() => fail('WALL_TIMEOUT'), timeoutMs);
    timer.unref();
    child.once('error', () => fail('SPAWN_ERROR'));
    child.stdin.on('error', () => fail('INPUT_ERROR'));
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_RESULT_BYTES) fail('RESULT_LIMIT');
      else chunks.push(chunk);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      killGroup();
      if (signal || code !== 0) {
        fail(signal ? 'PROCESS_SIGNAL' : 'PROCESS_EXIT');
        return;
      }
      try {
        const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          !('result' in envelope) ||
          !('ok' in envelope) ||
          envelope.ok !== true
        )
          throw new Error('Invalid worker output');
        settled = true;
        resolveRun(envelope.result as GateRun);
      } catch {
        fail('PROTOCOL');
      }
    });
    child.stdin.end(request);
  });
}

function validOptions(value: unknown): value is RunOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  for (const name of ['repo', 'policyPath', 'out'])
    if (typeof options[name] !== 'string' || !isAbsolute(options[name])) return false;
  for (const name of ['base', 'candidate'])
    if (typeof options[name] !== 'string' || !/^[a-f0-9]{40,64}$/.test(options[name])) return false;
  return true;
}
async function childMain(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new AnalysisWorkerError('REQUEST_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  const options: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!validOptions(options)) throw new AnalysisWorkerError('INVALID_OPTIONS');
  const { runGate } = await import('./runner.js');
  const result = await runGate(options);
  const output = JSON.stringify({ ok: true, result });
  if (Buffer.byteLength(output) > MAX_RESULT_BYTES) throw new AnalysisWorkerError('RESULT_LIMIT');
  process.stdout.write(output);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
  process.argv[2] === '--child'
) {
  void childMain().catch(() => {
    process.exitCode = 1;
  });
}
