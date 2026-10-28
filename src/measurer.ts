import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  Snapshot,
  Policy,
  Measurement,
  MeasuredFile,
  FunctionUnit,
  Issue,
  SourceFile,
} from './types.js';

const exec = promisify(execFile);
const TEMPLATE = ['--no-config', '--no-cache', '--lang', 'es', '-j'];
const MAX_OUTPUT = 64 * 1024 * 1024;
function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function integer(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}
class ContractError extends Error {
  constructor(
    public code: string,
    message: string,
    public file?: string,
  ) {
    super(message);
  }
}
function schema(message: string): never {
  throw new ContractError('SCHEMA', message);
}
interface Command {
  stdout: string;
  stderr: string;
  exit: number | null;
  timedOut: boolean;
  elapsed: number;
  error?: string;
}
async function invoke(
  binary: string,
  args: string[],
  cwd: string,
  home: string,
  timeout: number,
): Promise<Command> {
  const started = performance.now();
  try {
    const result = await exec(binary, args, {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, LC_ALL: 'C' },
      timeout,
      maxBuffer: MAX_OUTPUT,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit: 0,
      timedOut: false,
      elapsed: performance.now() - started,
    };
  } catch (e) {
    const error = e as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exit: typeof error.code === 'number' ? error.code : null,
      timedOut: !!error.killed && error.signal === 'SIGKILL',
      elapsed: performance.now() - started,
      error: error.message.split('\n')[0],
    };
  }
}
function units(value: unknown, lines: number, depth = 0, counter = { n: 0 }): FunctionUnit[] {
  if (!Array.isArray(value)) schema('functions/children must be arrays.');
  if (depth > 1024) schema('Reported function tree exceeds nesting bound.');
  return value.map((raw) => {
    if (++counter.n > 1_000_000) schema('Reported function count exceeds bound.');
    if (
      !object(raw) ||
      typeof raw.name !== 'string' ||
      typeof raw.kind !== 'string' ||
      !raw.kind ||
      !integer(raw.line, 1) ||
      raw.line > Math.max(1, lines) ||
      !integer(raw.cognitive) ||
      !integer(raw.cyclomatic)
    )
      schema('Invalid function metric/name/kind/line.');
    return {
      name: raw.name,
      kind: raw.kind,
      line: raw.line,
      cognitive: raw.cognitive,
      cyclomatic: raw.cyclomatic,
      children: units(raw.children ?? [], lines, depth + 1, counter),
    };
  });
}
function total(functions: FunctionUnit[], metric: 'cognitive' | 'cyclomatic'): number {
  return functions.reduce((sum, f) => sum + f[metric] + total(f.children, metric), 0);
}
function validate(raw: string, files: Map<string, SourceFile>, side: 'B' | 'C'): MeasuredFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    schema('Measurement stdout is not valid JSON.');
  }
  if (
    !object(parsed) ||
    !Array.isArray(parsed.files) ||
    !object(parsed.summary) ||
    !integer(parsed.summary.file_count)
  )
    schema('Report must contain files[] and summary.file_count.');
  if (parsed.summary.file_count !== files.size || parsed.files.length !== files.size)
    throw new ContractError(
      'MANIFEST_MISMATCH',
      'Report file count does not equal requested manifest.',
    );
  const seen = new Set<string>();
  const result: MeasuredFile[] = [];
  for (const rawFile of parsed.files) {
    if (
      !object(rawFile) ||
      typeof rawFile.path !== 'string' ||
      !integer(rawFile.cognitive) ||
      !integer(rawFile.cyclomatic)
    )
      schema('Invalid file path or file metrics.');
    const source = files.get(rawFile.path);
    if (!source || seen.has(rawFile.path))
      throw new ContractError(
        'MANIFEST_MISMATCH',
        'Report contains unexpected or duplicate path.',
        rawFile.path,
      );
    seen.add(rawFile.path);
    if (
      rawFile.parse_errors !== undefined &&
      (!Array.isArray(rawFile.parse_errors) ||
        rawFile.parse_errors.some((e) => typeof e !== 'string'))
    )
      schema('parse_errors must be an array of strings.');
    const functions = units(rawFile.functions, source.content.split('\n').length);
    if (
      rawFile.cognitive < total(functions, 'cognitive') ||
      rawFile.cyclomatic < total(functions, 'cyclomatic')
    )
      throw new ContractError(
        'INVARIANT_VIOLATION',
        'File metric is less than the sum of all function metrics.',
        rawFile.path,
      );
    const parseErrors = (rawFile.parse_errors ?? []) as string[];
    // Candidate errors always invalidate measurement; baseline errors only remove its debt allowance.
    // Parse errors are retained per file so verified siblings can still report confirmed violations.
    result.push({
      path: source.path,
      cognitive: rawFile.cognitive,
      cyclomatic: rawFile.cyclomatic,
      functions,
      parse_errors: parseErrors,
    });
  }
  if (seen.size !== files.size)
    throw new ContractError('MANIFEST_MISMATCH', 'Measurement omitted requested files.');
  return result;
}
function errorIssue(error: unknown): Issue {
  return error instanceof ContractError
    ? { code: error.code, message: error.message, ...(error.file ? { file: error.file } : {}) }
    : {
        code: 'MEASURER_IO',
        message: error instanceof Error ? error.message : 'Measurement I/O failed.',
      };
}
async function lockHash(): Promise<string> {
  try {
    return sha(
      Buffer.concat([
        await readFile(new URL('../package-lock.json', import.meta.url)),
        Buffer.from(`\0${process.version}\0${process.platform}\0${process.arch}`),
      ]),
    );
  } catch {
    return sha('lockfile-unavailable');
  }
}
function measuredFiles(snapshot: Snapshot, side: 'B' | 'C'): SourceFile[] {
  const files = new Map<string, SourceFile>();
  for (const change of snapshot.files) {
    // Identical bytes need not be remeasured (including pure renames and mode changes).
    if (
      change.before &&
      change.after &&
      change.before.blob_sha === change.after.blob_sha &&
      change.before.classification === change.after.classification
    )
      continue;
    const file = side === 'B' ? change.before : change.after;
    if (file && (file.classification === 'source' || file.classification === 'test'))
      files.set(file.path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
async function measureSide(
  side: 'B' | 'C',
  files: SourceFile[],
  policy: Policy,
  root: string,
  binary: string,
  out: string,
  issues: Issue[],
): Promise<Record<string, MeasuredFile>> {
  const result: Record<string, MeasuredFile> = Object.create(null);
  if (!files.length) {
    await writeFile(
      path.join(out, `raw.${side}.json`),
      JSON.stringify({ files: [], summary: { file_count: 0 } }) + '\n',
    );
    await writeFile(path.join(out, `raw.${side}.stderr`), '');
    return result;
  }
  const treeRoot = path.join(root, side);
  const home = path.join(root, `home-${side}`);
  await mkdir(treeRoot);
  await mkdir(home);
  const mapped = new Map<string, SourceFile>();
  for (const file of files) {
    const measurementPath =
      policy.measurement.jsx_in_js && file.path.endsWith('.js') ? `${file.path}.jsx` : file.path;
    if (mapped.has(measurementPath)) {
      issues.push({
        code: 'MANIFEST_MISMATCH',
        message: 'Measurement suffix transformation caused a path collision.',
        file: file.path,
      });
      return result;
    }
    if (
      path.isAbsolute(measurementPath) ||
      measurementPath
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
      measurementPath.includes('\\')
    ) {
      issues.push({
        code: 'UNSAFE_PATH',
        message: 'Unsafe materialization path.',
        file: file.path,
      });
      return result;
    }
    const destination = path.join(treeRoot, measurementPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: 'wx', mode: 0o400 });
    mapped.set(measurementPath, file);
  }
  const keys = [...mapped.keys()];
  const rawReports: unknown[] = [];
  const stderrParts: string[] = [];
  // Repeat every candidate invocation serially, stronger than the spec's 5% sample and deterministic for replay.
  for (let start = 0, batch = 0; start < keys.length; start += 1000, batch++) {
    const names = keys.slice(start, start + 1000);
    const expected = new Map(names.map((name) => [name, mapped.get(name)!]));
    const command = await invoke(
      binary,
      [...TEMPLATE, String(policy.measurement.jobs), '--', ...names],
      treeRoot,
      home,
      policy.measurement.timeout_ms,
    );
    await writeFile(path.join(out, `raw.${side}.batch-${batch}.json`), command.stdout);
    await writeFile(path.join(out, `raw.${side}.batch-${batch}.stderr`), command.stderr);
    stderrParts.push(command.stderr);
    try {
      if (command.timedOut || command.elapsed >= policy.measurement.timeout_ms)
        throw new ContractError('TIMEOUT', 'cccc invocation exceeded its timeout.');
      if (command.exit !== 0)
        throw new ContractError(
          'MEASURER_EXIT',
          `cccc exited with ${command.exit ?? 'an invocation error'}.`,
        );
      if (!command.stdout.trim())
        throw new ContractError(
          'EMPTY_OUTPUT',
          'Nonempty manifest produced empty measurement stdout.',
        );
      if (command.stderr.length)
        throw new ContractError(
          'MEASURER_STDERR',
          'cccc emitted diagnostic stderr; see retained raw stderr.',
        );
      const parsed = validate(command.stdout, expected, side);
      if (side === 'C')
        for (const file of parsed)
          if (file.parse_errors.length)
            issues.push({
              code: 'PARSE_ERROR_CANDIDATE',
              message: file.parse_errors.join('; '),
              file: file.path,
            });
      if (side === 'C') {
        const serial = await invoke(
          binary,
          [...TEMPLATE, '1', '--', ...names],
          treeRoot,
          home,
          policy.measurement.timeout_ms,
        );
        await writeFile(path.join(out, `raw.${side}.batch-${batch}.serial.json`), serial.stdout);
        await writeFile(path.join(out, `raw.${side}.batch-${batch}.serial.stderr`), serial.stderr);
        if (
          serial.timedOut ||
          serial.exit !== 0 ||
          serial.stderr ||
          serial.stdout !== command.stdout
        )
          throw new ContractError(
            'NONDETERMINISM',
            'Candidate -j1 replay differs from the primary invocation or failed.',
          );
      }
      for (const file of parsed) result[file.path] = file;
      rawReports.push(JSON.parse(command.stdout));
    } catch (error) {
      issues.push(errorIssue(error));
      rawReports.push({ unvalidated_stdout: command.stdout });
    }
  }
  await writeFile(path.join(out, `raw.${side}.stderr`), stderrParts.join(''));
  // Retain byte-identical primary stdout for one-batch reports; batches retain their individual originals.
  if (keys.length <= 1000)
    await writeFile(
      path.join(out, `raw.${side}.json`),
      await readFile(path.join(out, `raw.${side}.batch-0.json`)),
    );
  else
    await writeFile(
      path.join(out, `raw.${side}.json`),
      JSON.stringify({ batches: rawReports }) + '\n',
    );
  return result;
}
export async function measureSnapshot(
  snapshot: Snapshot,
  policy: Policy,
  out: string,
  runnerCommit: string,
): Promise<Measurement> {
  const measurement: Measurement = {
    base: Object.create(null),
    candidate: Object.create(null),
    fingerprint: {
      runtime: `${process.version} ${process.platform}/${process.arch}`,
      cccc_version: policy.measurement.version,
      cccc_sha256: policy.measurement.sha256,
      runner_commit: runnerCommit,
      policy_revision: policy.revision,
      arguments: [...TEMPLATE, String(policy.measurement.jobs), '--', '<manifest-files>'],
      toolchain_sha256: await lockHash(),
    },
    issues: [],
  };
  let root: string | undefined;
  try {
    await mkdir(out, { recursive: true });
    for (const side of ['B', 'C']) {
      await writeFile(path.join(out, `raw.${side}.json`), '');
      await writeFile(path.join(out, `raw.${side}.stderr`), '');
    }
    const b = measuredFiles(snapshot, 'B'),
      c = measuredFiles(snapshot, 'C');
    if (!b.length && !c.length) {
      for (const side of ['B', 'C']) {
        await writeFile(
          path.join(out, `raw.${side}.json`),
          JSON.stringify({ files: [], summary: { file_count: 0 } }) + '\n',
        );
        await writeFile(path.join(out, `raw.${side}.stderr`), '');
      }
      return measurement;
    }
    const binaryPath = await realpath(policy.measurement.binary);
    const info = await stat(binaryPath);
    if (!info.isFile() || info.size > 128 * 1024 * 1024)
      throw new ContractError(
        'MEASURER_MISMATCH',
        'cccc binary must be a regular file below 128 MiB.',
      );
    const binaryBytes = await readFile(binaryPath);
    const hash = sha(binaryBytes);
    measurement.fingerprint.cccc_sha256 = hash;
    if (hash !== policy.measurement.sha256)
      throw new ContractError('MEASURER_MISMATCH', 'cccc SHA256 does not equal trusted policy.');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nyorori-measure-'));
    root = tempRoot;
    // Execute an immutable private copy of the exact hashed bytes to close a path replacement race.
    const binary = path.join(tempRoot, 'cccc');
    await writeFile(binary, binaryBytes, { mode: 0o500, flag: 'wx' });
    const home = path.join(tempRoot, 'version-home');
    await mkdir(home);
    const version = await invoke(
      binary,
      ['--version'],
      tempRoot,
      home,
      policy.measurement.timeout_ms,
    );
    await writeFile(path.join(out, 'raw.version.stdout'), version.stdout);
    await writeFile(path.join(out, 'raw.version.stderr'), version.stderr);
    measurement.fingerprint.cccc_version = version.stdout.trim();
    if (
      version.exit !== 0 ||
      version.timedOut ||
      version.stderr ||
      version.stdout.trim() !== policy.measurement.version
    )
      throw new ContractError(
        'MEASURER_MISMATCH',
        'cccc --version, exit status or stderr does not match trusted policy.',
      );
    measurement.base = await measureSide('B', b, policy, tempRoot, binary, out, measurement.issues);
    measurement.candidate = await measureSide(
      'C',
      c,
      policy,
      tempRoot,
      binary,
      out,
      measurement.issues,
    );
  } catch (error) {
    measurement.issues.push(errorIssue(error));
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
  return measurement;
}
