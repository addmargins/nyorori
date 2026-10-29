// App JWT signing behind an interface, so the private key can live outside
// the process that parses hostile git objects and artifacts. `FileKeySigner`
// is today's in-process RS256; `CommandSigner` hands the signing input to an
// operator-configured command (a KMS/HSM CLI) and reads the signature back.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";

export interface AppJwtSigner {
  /** RS256 signature over `<header>.<payload>`, base64url without padding. */
  sign(signingInput: string): Promise<string>;
  /** Key id to put in the JWT header when the key store names one. */
  readonly kid?: string;
}

export class SignerError extends Error {}

const B64URL = /^[A-Za-z0-9_-]+$/;

export class FileKeySigner implements AppJwtSigner {
  constructor(private readonly privateKeyPem: string) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKeyPem)) throw new SignerError("not a PEM private key");
  }

  async sign(signingInput: string): Promise<string> {
    const s = createSign("RSA-SHA256");
    s.update(signingInput);
    return s.sign(this.privateKeyPem).toString("base64url");
  }
}

export interface CommandSignerOptions {
  /** argv; executed directly (no shell). The signing input arrives on stdin. */
  argv: readonly string[];
  timeoutMs?: number;
  kid?: string;
  /** Environment for the command; default is a minimal PATH only. */
  env?: Record<string, string>;
  /**
   * Names of variables from this process's environment to pass through
   * (e.g. AWS_PROFILE, AWS_REGION, GOOGLE_APPLICATION_CREDENTIALS). Allowlist
   * semantics: anything not named stays out, and NYORORI_* / GITHUB_TOKEN /
   * *_SECRET are never passed even when named.
   */
  envPassthrough?: readonly string[];
}

const NEVER_PASSED = /^(NYORORI_|GITHUB_TOKEN$|GH_TOKEN$|.*_SECRET$|.*WEBHOOK.*)/;

export function signerEnvironment(names: readonly string[], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: source.PATH ?? "/usr/bin:/bin" };
  for (const n of names) {
    if (typeof n !== "string" || NEVER_PASSED.test(n) || !/^[A-Z_][A-Z0-9_]*$/.test(n)) continue;
    const v = source[n];
    if (v !== undefined) env[n] = v;
  }
  return env;
}

/**
 * The command must print the base64url (or standard base64) RS256 signature
 * of its stdin and exit 0. Anything else is an error: a wrong signature only
 * yields 401s from GitHub, never a silently different identity.
 */
export class CommandSigner implements AppJwtSigner {
  readonly kid?: string;
  private readonly argv: string[];
  private readonly timeoutMs: number;
  private readonly env: Record<string, string>;

  constructor(opts: CommandSignerOptions) {
    if (opts.argv.length === 0 || opts.argv.some((a) => typeof a !== "string")) throw new SignerError("signer command argv must be a non-empty string array");
    this.argv = [...opts.argv];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.env = opts.env ?? signerEnvironment(opts.envPassthrough ?? []);
    if (opts.kid !== undefined) this.kid = opts.kid;
  }

  sign(signingInput: string): Promise<string> {
    const [cmd, ...args] = this.argv as [string, ...string[]];
    return new Promise((resolve, reject) => {
      const child = execFile(
        cmd,
        args,
        { env: this.env, timeout: this.timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const why = (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? `timed out after ${this.timeoutMs} ms` : err.message;
            reject(new SignerError(`signer command failed: ${why}${stderr ? ` (${String(stderr).trim().slice(0, 200)})` : ""}`));
            return;
          }
          const text = String(stdout).trim();
          const sig = text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          if (!sig || !B64URL.test(sig)) {
            reject(new SignerError("signer command printed no base64url signature"));
            return;
          }
          resolve(sig);
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(signingInput);
    });
  }
}

export interface SignerConfig {
  kind: "file" | "command";
  privateKeyPem?: string;
  /** JSON argv array for kind "command" (NYORORI_SIGNER_COMMAND). */
  command?: string | readonly string[];
  kid?: string;
  /** NYORORI_SIGNER_TIMEOUT_MS. */
  timeoutMs?: number | string;
  /** JSON array of env var names to pass through (NYORORI_SIGNER_ENV). */
  envPassthrough?: string | readonly string[];
}

function parseJsonStringArray(value: string | readonly string[] | undefined, what: string): string[] {
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new SignerError(`${what} must be a JSON array of strings`);
    }
  }
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new SignerError(`${what} must be a JSON array of strings`);
  return v as string[];
}

/**
 * Factory for the CLI: NYORORI_SIGNER=file|command, NYORORI_SIGNER_COMMAND=<argv JSON>,
 * NYORORI_SIGNER_ENV=<env names JSON>, NYORORI_SIGNER_TIMEOUT_MS, NYORORI_SIGNER_KID.
 */
export function createSigner(cfg: SignerConfig): AppJwtSigner {
  if (cfg.kind === "file") {
    if (!cfg.privateKeyPem) throw new SignerError("file signer needs the private key PEM");
    return new FileKeySigner(cfg.privateKeyPem);
  }
  let argv: unknown = cfg.command;
  if (typeof argv === "string") {
    try {
      argv = JSON.parse(argv);
    } catch {
      throw new SignerError("NYORORI_SIGNER_COMMAND must be a JSON array of argv strings");
    }
  }
  if (!Array.isArray(argv)) throw new SignerError("NYORORI_SIGNER_COMMAND must be a JSON array of argv strings");
  const timeoutMs = cfg.timeoutMs === undefined ? undefined : Number(cfg.timeoutMs);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new SignerError("NYORORI_SIGNER_TIMEOUT_MS must be a positive integer");
  return new CommandSigner({
    argv: argv as string[],
    envPassthrough: parseJsonStringArray(cfg.envPassthrough, "NYORORI_SIGNER_ENV"),
    ...(cfg.kid !== undefined ? { kid: cfg.kid } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
