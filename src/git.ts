import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type {
  Policy,
  SourceFile,
  Snapshot,
  FileChange,
  Hunk,
  Issue,
  Classification,
} from './types.js';

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_TREE_ENTRIES = 100_000;
const MAX_CHANGED_FILES = 10_000;
const MAX_TREE_CONTENT_BYTES = 64 * 1024 * 1024;
export class GitInputError extends Error {
  constructor(
    public code: string,
    message: string,
    public file?: string,
  ) {
    super(message);
    this.name = 'GitInputError';
  }
}
interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}
async function git(repo: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<Buffer> {
  try {
    const result = await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-C',
        repo,
        ...args,
      ],
      {
        encoding: 'buffer',
        timeout: 30_000,
        maxBuffer,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_LITERAL_PATHSPECS: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
    );
    return result.stdout;
  } catch (e) {
    throw new GitInputError(
      'GIT_INPUT',
      `Git operation failed: ${args[0]} (${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'})`,
    );
  }
}
function utf8(bytes: Buffer, file?: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new GitInputError(
      'MANIFEST_MISMATCH',
      'Git input is not valid UTF-8; convert source to UTF-8.',
      file,
    );
  }
}
function safePath(file: string): void {
  const parts = file.split('/');
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    parts.some((p) => p === '..' || p === '.' || !p || p.toLowerCase() === '.git')
  ) {
    throw new GitInputError('UNSAFE_PATH', 'Unsafe repository path cannot be materialized.', file);
  }
}
function validateTree(entries: TreeEntry[]): void {
  if (entries.length > MAX_TREE_ENTRIES)
    throw new GitInputError('RESOURCE_LIMIT', 'Repository exceeds 100,000 tree entries.');
  const seen = new Map<string, string>();
  for (const entry of entries) {
    safePath(entry.path);
    const key = entry.path.normalize('NFC').toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined && prior !== entry.path)
      throw new GitInputError(
        'CASE_COLLISION',
        `Case-insensitive path collision: ${prior} and ${entry.path}`,
        entry.path,
      );
    seen.set(key, entry.path);
    if (!['100644', '100755', '120000', '160000'].includes(entry.mode))
      throw new GitInputError(
        'UNSUPPORTED_MODE',
        `Unsupported git tree mode ${entry.mode}`,
        entry.path,
      );
  }
}
async function tree(repo: string, sha: string): Promise<Map<string, TreeEntry>> {
  const bytes = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha]);
  const entries: TreeEntry[] = [];
  for (const row of utf8(bytes).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
    if (!match) throw new GitInputError('GIT_INPUT', 'Malformed git tree entry.');
    entries.push({ mode: match[1]!, type: match[2]!, sha: match[3]!, path: match[4]! });
  }
  validateTree(entries);
  return new Map(entries.map((e) => [e.path, e]));
}
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  // --end-of-options prevents a caller-supplied ref from becoming an option.
  const sha = utf8(
    await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
  ).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha))
    throw new GitInputError('INVALID_COMMIT', 'Commit did not resolve to a full object ID.');
  return sha;
}
function classify(
  entry: TreeEntry,
  policy: Policy,
): { classification: Classification; reason?: string } {
  if (entry.mode === '120000' || entry.mode === '160000')
    return {
      classification: 'unmeasured',
      reason: entry.mode === '120000' ? 'SYMLINK' : 'SUBMODULE',
    };
  if (policy.scope.exclude_globs.some((g) => minimatch(entry.path, g, { dot: true })))
    return { classification: 'excluded', reason: 'POLICY_EXCLUDED' };
  if (
    entry.path.endsWith('.d.ts') ||
    entry.path.endsWith('.d.mts') ||
    entry.path.endsWith('.d.cts')
  )
    return { classification: 'excluded', reason: 'DECLARATION_ONLY' };
  const ext = path.posix.extname(entry.path).toLowerCase();
  if (policy.scope.source_extensions.includes(ext))
    return {
      classification: policy.scope.test_globs.some((g) => minimatch(entry.path, g, { dot: true }))
        ? 'test'
        : 'source',
    };
  if (policy.scope.unmeasured_extensions.includes(ext))
    return { classification: 'unmeasured', reason: 'UNSUPPORTED_CODE_FORMAT' };
  if (
    policy.scope.non_code_extensions.includes(ext) ||
    [
      'LICENSE',
      'LICENCE',
      'COPYING',
      'NOTICE',
      'README',
      'CHANGELOG',
      'CODEOWNERS',
      '.gitignore',
      '.gitattributes',
      '.gitmodules',
      '.ignore',
      'Dockerfile',
      'Makefile',
    ].includes(path.posix.basename(entry.path))
  )
    return { classification: 'non-code' };
  return { classification: 'unmeasured', reason: 'UNKNOWN_EXTENSION' };
}
/** Conventional resolver configs are outside the certified relative-file profile. */
export function unsupportedResolverConfig(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    /^(?:vite|vitest|webpack|rollup|rolldown|esbuild|rspack|rsbuild|snowpack|next|nuxt|astro|svelte|vue|babel|tsup|unbuild)(?:\.[^/]+)?\.config(?:\.[^/]+)?$/u.test(
      base,
    ) ||
    /^(?:webpack|esbuild)(?:\.[^/]+)*\.[cm]?[jt]sx?$/u.test(base) ||
    /^\.(?:babelrc|swcrc|parcelrc)(?:\.[^/]+)?$/u.test(base) ||
    base === 'angular.json'
  );
}
export function resolutionMetadata(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    base === 'package.json' ||
    /^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.jsonc?$/u.test(base) ||
    unsupportedResolverConfig(file)
  );
}
async function readEntry(
  repo: string,
  entry: TreeEntry,
  policy: Policy,
  budget?: { remaining: number },
): Promise<SourceFile> {
  const scope = classify(entry, policy);
  const strictContent = scope.reason === 'DECLARATION_ONLY' || resolutionMetadata(entry.path);
  const base: SourceFile = {
    path: entry.path,
    blob_sha: entry.sha,
    mode: entry.mode,
    content: '',
    ...scope,
  };
  if (entry.mode !== '100644' && entry.mode !== '100755') return base;
  const size = Number(utf8(await git(repo, ['cat-file', '-s', entry.sha])).trim());
  if (!Number.isSafeInteger(size) || size < 0)
    throw new GitInputError('GIT_INPUT', 'Invalid blob size.', entry.path);
  if (size > policy.measurement.max_file_bytes) {
    if (
      !strictContent &&
      (scope.classification === 'non-code' || scope.classification === 'excluded')
    )
      return base;
    throw new GitInputError(
      'FILE_TOO_LARGE',
      `Source blob exceeds ${policy.measurement.max_file_bytes} bytes.`,
      entry.path,
    );
  }
  if (budget) {
    if (size > budget.remaining)
      throw new GitInputError(
        'RESOURCE_LIMIT',
        'Changed blob content exceeds the aggregate 64 MiB B/C input budget.',
        entry.path,
      );
    budget.remaining -= size;
  }
  const bytes = await git(
    repo,
    ['cat-file', 'blob', entry.sha],
    Math.max(size + 1024, 1024 * 1024),
  );
  if (
    !strictContent &&
    (scope.classification === 'non-code' || scope.classification === 'excluded')
  ) {
    try {
      base.content = bytes.includes(0) ? '' : decoder.decode(bytes);
    } catch {
      /* Binary non-code is intentionally not parsed. */
    }
    return base;
  }
  const content = utf8(bytes, entry.path);
  if (
    content.startsWith('version https://git-lfs.github.com/spec/v1\n') ||
    content.startsWith('version https://git-lfs.github.com/spec/v1\r\n')
  )
    throw new GitInputError(
      'LFS_POINTER',
      'Code is an LFS pointer rather than source bytes.',
      entry.path,
    );
  if (content.includes('\0'))
    throw new GitInputError(
      'MANIFEST_MISMATCH',
      'Code blob contains NUL bytes; source must be UTF-8 text.',
      entry.path,
    );
  base.content = content;
  return base;
}
function issue(e: unknown): Issue {
  if (e instanceof GitInputError)
    return { code: e.code, message: e.message, ...(e.file ? { file: e.file } : {}) };
  return {
    code: 'GIT_INPUT',
    message: e instanceof Error ? e.message : 'Unknown git input failure.',
  };
}
function parseHunks(text: string): Hunk[] {
  return [...text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }));
}
function lineCount(content: string): number {
  return content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}
function lineMap(
  before: SourceFile | undefined,
  after: SourceFile | undefined,
  hunks: Hunk[],
): Map<number, number> {
  const result = new Map<number, number>();
  if (!before || !after) return result;
  let old = 1,
    next = 1;
  for (const h of hunks) {
    const unchangedEnd = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (old <= unchangedEnd) result.set(old++, next++);
    old = h.oldStart + h.oldCount;
    next = h.newStart + h.newCount;
    if (h.oldCount === 0) old = h.oldStart + 1;
    if (h.newCount === 0) next = h.newStart + 1;
  }
  while (old <= lineCount(before.content) && next <= lineCount(after.content))
    result.set(old++, next++);
  return result;
}
export async function buildSnapshot(
  repo: string,
  base: string,
  candidate: string,
  policy: Policy,
): Promise<Snapshot> {
  const result: Snapshot = { base_sha: '', candidate_sha: '', files: [], manifest: [], issues: [] };
  try {
    repo = await realpath(repo);
    result.base_sha = await resolveCommit(repo, base);
    result.candidate_sha = await resolveCommit(repo, candidate);
    const [b, c] = await Promise.all([
      tree(repo, result.base_sha),
      tree(repo, result.candidate_sha),
    ]);
    const contentBudget = { remaining: MAX_TREE_CONTENT_BYTES };
    const tokens = utf8(
      await git(repo, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '-M70%',
        '-C70%',
        '-z',
        result.base_sha,
        result.candidate_sha,
        '--',
      ]),
    ).split('\0');
    for (let i = 0; i < tokens.length && tokens[i];) {
      if (result.files.length >= MAX_CHANGED_FILES)
        throw new GitInputError('RESOURCE_LIMIT', 'Change exceeds 10,000 files.');
      const rawStatus = tokens[i++]!;
      const status = rawStatus[0]!;
      if (!['A', 'M', 'R', 'C', 'D', 'T'].includes(status))
        throw new GitInputError('UNSUPPORTED_CHANGE', `Unsupported git change ${rawStatus}.`);
      const first = tokens[i++];
      if (!first) throw new GitInputError('GIT_INPUT', 'Truncated name-status output.');
      const second = status === 'R' || status === 'C' ? tokens[i++] : undefined;
      if ((status === 'R' || status === 'C') && !second)
        throw new GitInputError('GIT_INPUT', 'Truncated rename/copy output.');
      const oldPath = status === 'A' ? undefined : first;
      const newPath = status === 'D' ? undefined : (second ?? first);
      const change: FileChange = {
        status,
        ...(oldPath ? { oldPath } : {}),
        ...(newPath ? { newPath } : {}),
        hunks: [],
        lineMap: new Map(),
      };
      for (const side of ['B', 'C'] as const) {
        if (side === 'B' && status === 'C') continue; // Copies never inherit a source unit's budget.
        const file = side === 'B' ? oldPath : newPath;
        if (!file) continue;
        const entry = (side === 'B' ? b : c).get(file);
        if (!entry)
          throw new GitInputError(
            'MANIFEST_MISMATCH',
            'Changed path absent from resolved tree.',
            file,
          );
        let source: SourceFile;
        try {
          source = await readEntry(repo, entry, policy, contentBudget);
        } catch (e) {
          if (e instanceof GitInputError && e.code === 'RESOURCE_LIMIT') throw e;
          result.issues.push(issue(e));
          source = {
            path: file,
            blob_sha: entry.sha,
            mode: entry.mode,
            content: '',
            classification: 'unmeasured',
            reason: issue(e).code,
          };
        }
        if (status === 'T')
          source = { ...source, classification: 'unmeasured', reason: 'TYPE_CHANGED' };
        if (source.reason === 'UNKNOWN_EXTENSION')
          result.issues.push({
            code: 'UNKNOWN_EXTENSION',
            message: 'Path extension is not registered in trusted policy.',
            file,
          });
        if (side === 'B') change.before = source;
        else change.after = source;
        result.manifest.push({
          path: file,
          side,
          mode: entry.mode,
          blob_sha: entry.sha,
          status,
          classification: source.classification,
          ...(source.reason ? { reason: source.reason } : {}),
        });
      }
      if (change.before && change.after && change.before.blob_sha !== change.after.blob_sha) {
        const diff = await git(repo, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=0',
          '-M70%',
          result.base_sha,
          result.candidate_sha,
          '--',
          ...new Set([oldPath, newPath].filter((p): p is string => !!p)),
        ]);
        change.hunks = parseHunks(utf8(diff));
      } else if (!change.before && change.after)
        change.hunks = [
          { oldStart: 0, oldCount: 0, newStart: 1, newCount: lineCount(change.after.content) },
        ];
      else if (change.before && !change.after)
        change.hunks = [
          { oldStart: 1, oldCount: lineCount(change.before.content), newStart: 0, newCount: 0 },
        ];
      change.lineMap = lineMap(change.before, change.after, change.hunks);
      result.files.push(change);
    }
  } catch (e) {
    result.issues.push(issue(e));
  }
  result.manifest.sort((a, b) => a.side.localeCompare(b.side) || a.path.localeCompare(b.path));
  return result;
}
export async function readTree(repo: string, ref: string, policy: Policy): Promise<SourceFile[]> {
  const sha = await resolveCommit(repo, ref);
  const entries = await tree(repo, sha);
  const result: SourceFile[] = [];
  let bytes = 0;
  for (const entry of entries.values()) {
    const scope = classify(entry, policy);
    if (scope.reason === 'UNKNOWN_EXTENSION')
      throw new GitInputError(
        'UNKNOWN_EXTENSION',
        'Path extension is not registered in trusted policy.',
        entry.path,
      );
    // Dependency inspection needs source files and path metadata only, never binary docs/vendor content.
    if (
      scope.classification !== 'source' &&
      scope.classification !== 'test' &&
      !resolutionMetadata(entry.path)
    ) {
      result.push({
        path: entry.path,
        blob_sha: entry.sha,
        mode: entry.mode,
        content: '',
        ...scope,
      });
      continue;
    }
    const source = await readEntry(repo, entry, policy);
    bytes += Buffer.byteLength(source.content);
    if (bytes > MAX_TREE_CONTENT_BYTES)
      throw new GitInputError(
        'RESOURCE_LIMIT',
        'Repository source content exceeds 64 MiB dependency-analysis budget.',
      );
    result.push(source);
  }
  return result;
}
