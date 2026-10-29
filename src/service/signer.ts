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
    this.env = opts.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" };
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
  /** JSON argv array for kind "command". */
  command?: string | readonly string[];
  kid?: string;
  timeoutMs?: number;
}

/** Factory for the CLI: NYORORI_SIGNER=file|command, NYORORI_SIGNER_COMMAND=<argv JSON>. */
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
  return new CommandSigner({ argv: argv as string[], ...(cfg.kid !== undefined ? { kid: cfg.kid } : {}), ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}) });
}
