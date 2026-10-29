// Git plumbing runner. Everything the gate learns about B and C goes through
// here, so it must not be steerable by the repository under test: no shell, no
// user/system config, no external diff or textconv drivers, raw bytes out.

import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  input?: Buffer | string;
  maxBuffer?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024;

/** Environment for every git call: config and hooks from outside the repo are ignored. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

/** Options placed before the subcommand on every invocation. */
export const GIT_GLOBAL_ARGS = [
  "-c", "core.quotePath=false",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.renameLimit=0",
];

export function git(repoDir: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  const fullArgs = ["-C", repoDir, ...GIT_GLOBAL_ARGS, ...args];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      {
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? 120_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
          reject(new GitError(`git ${args[0] ?? ""} failed: ${stderr.toString("utf8").trim() || err.message}`, args, code, stderr.toString("utf8")));
          return;
        }
        resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export async function gitText(repoDir: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return (await git(repoDir, args, opts)).toString("utf8");
}

/** Resolve a revision to a full commit SHA; throws on unknown revisions. */
export async function resolveCommit(repoDir: string, rev: string): Promise<string> {
  const out = await gitText(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
  return out.trim();
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Prefix of the stand-in for a path that is not valid UTF-8. NUL never occurs in a real git path. */
export const INVALID_PATH_PREFIX = "\0invalid-utf8:";

/**
 * Decodes a raw path. Invalid UTF-8 must not be decoded lossily: two distinct
 * byte paths would collapse to the same U+FFFD string and swap blobs. Such
 * paths get a unique stand-in that every consumer treats as unmeasurable.
 */
export function decodePath(raw: Buffer): string {
  try {
    return strictUtf8.decode(raw);
  } catch {
    return INVALID_PATH_PREFIX + raw.toString("hex");
  }
}

export function isInvalidPath(path: string): boolean {
  return path.startsWith(INVALID_PATH_PREFIX);
}

/** Split NUL-terminated output, dropping the trailing empty field. Buffers are decoded per field. */
export function splitNul(buf: Buffer | string): string[] {
  if (typeof buf === "string") {
    const parts = buf.split("\0");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(decodePath(buf.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(decodePath(buf.subarray(start)));
  return out;
}
