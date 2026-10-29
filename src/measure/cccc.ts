// The cccc invocation contract (spec 6.3). cccc exits 0 when it skips
// unreadable files, scores syntax errors as 0/0, and prints nothing when no
// file matches, so the raw exit code says little. Every run is checked against
// the manifest by validateCcccRun before any number is believed.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Policy } from "../policy/schema.js";
import type { CcccFile, CcccFunction, Inconclusive, Side } from "../types.js";
import { ccccArgsTemplate } from "./fingerprint.js";

const fnSchema: z.ZodType<CcccFunction> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      kind: z.string(),
      line: z.number().int().nonnegative(),
      cognitive: z.number().int().nonnegative(),
      cyclomatic: z.number().int().nonnegative(),
      children: z.array(fnSchema).optional(),
    })
    .passthrough(),
);

const fileSchema = z
  .object({
    path: z.string(),
    cognitive: z.number().int().nonnegative(),
    cyclomatic: z.number().int().nonnegative(),
    functions: z.array(fnSchema),
    parse_errors: z.array(z.string()).optional(),
  })
  .passthrough();

const reportSchema = z
  .object({
    files: z.array(fileSchema),
    summary: z.object({ file_count: z.number().int().nonnegative() }).passthrough(),
  })
  .passthrough();

export interface CcccRun {
  side: Side;
  args: string[];
  rc: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  /** Paths (relative to the tree root) handed to cccc in this run. */
  expectedPaths: string[];
}

export interface ValidatedRun {
  /** Parsed file reports; empty when the output could not be trusted at all. */
  files: CcccFile[];
  inconclusive: Inconclusive[];
  /** B-side files with parse errors: they have no usable baseline (C units become new). */
  baselineParseErrors: string[];
}

function sumFns(fns: CcccFunction[], pick: "cognitive" | "cyclomatic"): number {
  let s = 0;
  for (const f of fns) s += f[pick] + sumFns(f.children ?? [], pick);
  return s;
}

/** Normalizes the path form cccc echoes back (it prints paths as given). */
export function normalizeReportedPath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

const ENCODING_HINT = /utf-?8|invalid (byte|data|character)|stream did not contain valid/i;
const CANNOT_READ = /^cccc: cannot read (.+): (.+)$/;
const AMBIENT_IMPL = /implementation cannot be declared in ambient contexts/i;

export interface ValidateOptions {
  /** policy.parser_lag_allowlist: parse errors containing one of these are for a gate owner, not the author. */
  parserLagAllowlist?: readonly string[];
}

/** Files the measurer skipped because they are not valid UTF-8, read from its stderr. */
export function encodingSkips(stderr: string, expected: ReadonlySet<string>): { files: Set<string>; otherLines: string[] } {
  const files = new Set<string>();
  const otherLines: string[] = [];
  for (const line of stderr.split("\n")) {
    if (line.trim() === "") continue;
    const m = CANNOT_READ.exec(line.trimEnd());
    if (m && expected.has(normalizeReportedPath(m[1]!)) && ENCODING_HINT.test(m[2]!)) files.add(normalizeReportedPath(m[1]!));
    else otherLines.push(line);
  }
  return { files, otherLines };
}

/**
 * All nine checks of the spec 6.3 table, as a pure function of one run. The
 * MEASURER_MISMATCH check needs the binary itself and lives in fingerprint.ts.
 */
export function validateCcccRun(run: Omit<CcccRun, "args">, timeoutMs: number, opts: ValidateOptions = {}): ValidatedRun {
  const inc: Inconclusive[] = [];
  const add = (reason: Inconclusive["reason"], detail: string, authorFixable = false, file?: string) =>
    inc.push({ reason, detail, authorFixable, ...(file !== undefined ? { file } : {}) });
  const side = run.side;
  const stderr = run.stderr.toString("utf8");

  if (run.timedOut || run.durationMs >= timeoutMs) {
    add("TIMEOUT", `${side}: cccc did not finish within ${timeoutMs} ms`);
    return { files: [], inconclusive: inc, baselineParseErrors: [] };
  }
  if (run.rc !== 0) {
    add("MEASURER_EXIT", `${side}: cccc exited with ${run.rc ?? `signal ${run.signal}`}: ${stderr.trim().slice(0, 500)}`);
  }

  const expectedSet = new Set(run.expectedPaths);
  const skipped = encodingSkips(stderr, expectedSet);
  // An unreadable baseline is just a missing baseline (audit F15): its C units are new.
  const baselineUnreadable = side === "B" ? skipped.files : new Set<string>();
  const unexplained = side === "B" ? skipped.otherLines.join("\n") : stderr;
  if (unexplained.trim() !== "") {
    const encodingOnly = skipped.otherLines.length === 0;
    add("MEASURER_STDERR", `${side}: cccc wrote to stderr: ${unexplained.trim().slice(0, 1000)}`, encodingOnly);
  }

  if (run.expectedPaths.length > 0 && run.stdout.length === 0) {
    add("EMPTY_OUTPUT", `${side}: cccc produced no output for ${run.expectedPaths.length} file(s)`);
    return { files: [], inconclusive: inc, baselineParseErrors: [] };
  }
  if (run.expectedPaths.length === 0) {
    return { files: [], inconclusive: inc, baselineParseErrors: [] };
  }

  let parsed: z.infer<typeof reportSchema>;
  try {
    const json: unknown = JSON.parse(run.stdout.toString("utf8"));
    const res = reportSchema.safeParse(json);
    if (!res.success) {
      add("SCHEMA", `${side}: unexpected cccc output shape: ${res.error.issues[0]?.message ?? "invalid"}`);
      return { files: [], inconclusive: inc, baselineParseErrors: [] };
    }
    parsed = res.data;
  } catch (e) {
    add("SCHEMA", `${side}: cccc output is not JSON: ${(e as Error).message}`);
    return { files: [], inconclusive: inc, baselineParseErrors: [] };
  }

  const files = parsed.files.map((f) => ({ ...f, path: normalizeReportedPath(f.path) })) as CcccFile[];
  const expected = expectedSet;
  const seen = new Set<string>();
  for (const f of files) {
    if (!expected.has(f.path)) add("MANIFEST_MISMATCH", `${side}: cccc reported a file outside the manifest: ${f.path}`, false, f.path);
    if (seen.has(f.path)) add("MANIFEST_MISMATCH", `${side}: cccc reported ${f.path} twice`, false, f.path);
    seen.add(f.path);
  }
  for (const p of run.expectedPaths) {
    if (!seen.has(p) && !baselineUnreadable.has(p)) {
      const enc = skipped.files.has(p);
      add(
        "MANIFEST_MISMATCH",
        enc
          ? `${side}: ${p} was skipped by cccc (not valid UTF-8); re-encode the file as UTF-8`
          : `${side}: ${p} is missing from cccc output`,
        enc,
        p,
      );
    }
  }
  const expectedCount = run.expectedPaths.length - baselineUnreadable.size;
  if (parsed.summary.file_count !== expectedCount) {
    add("MANIFEST_MISMATCH", `${side}: summary.file_count ${parsed.summary.file_count} ≠ manifest ${expectedCount}`);
  }

  const baselineParseErrors: string[] = [...baselineUnreadable];
  const lag = (opts.parserLagAllowlist ?? []).filter((e) => e.length > 0);
  for (const f of files) {
    const errs = f.parse_errors ?? [];
    if (errs.length > 0) {
      if (side === "C") {
        // Syntax the parser does not support yet (policy list) is a gate-owner matter (audit F5).
        const parserLag = errs.every((e) => lag.some((l) => e.includes(l)));
        const ambient = errs.some((e) => AMBIENT_IMPL.test(e));
        add(
          "PARSE_ERROR_CANDIDATE",
          parserLag
            ? `${f.path}: cccc does not support this syntax yet (${errs.slice(0, 3).join("; ")}); a gate owner may override`
            : ambient
              ? `${f.path} has an implementation in an ambient (declare) context (${errs.slice(0, 3).join("; ")}); a declaration file or \`declare\` block may not contain code, move it to a .ts file`
              : `${f.path}: cccc could not parse the file (${errs.slice(0, 3).join("; ")}); fix the syntax error`,
          !parserLag,
          f.path,
        );
      } else baselineParseErrors.push(f.path);
    }
    const resCog = f.cognitive - sumFns(f.functions, "cognitive");
    const resCyc = f.cyclomatic - sumFns(f.functions, "cyclomatic");
    if (resCog < 0 || resCyc < 0) {
      add("INVARIANT_VIOLATION", `${side}: ${f.path} residue is negative (cognitive ${resCog}, cyclomatic ${resCyc})`, false, f.path);
    }
  }
  return { files, inconclusive: inc, baselineParseErrors };
}

export interface RunCcccOptions {
  binary: string;
  treeRoot: string;
  files: string[];
  policy: Policy;
  side: Side;
  /** Overrides policy.measurer.jobs (the determinism check uses 1). */
  jobs?: number;
}

function runOnce(binary: string, args: string[], cwd: string, home: string, timeoutMs: number) {
  return new Promise<Omit<CcccRun, "side" | "expectedPaths" | "args">>((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(binary, args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        rc: code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        timedOut,
      });
    });
  });
}

/** Runs cccc over `files` in chunks of policy.measurer.chunk_size. */
export async function runCccc(opts: RunCcccOptions): Promise<CcccRun[]> {
  const { policy } = opts;
  const jobs = opts.jobs ?? policy.measurer.jobs;
  const size = policy.measurer.chunk_size;
  const home = await mkdtemp(join(tmpdir(), "nyorori-cccc-home-"));
  try {
    const runs: CcccRun[] = [];
    for (let i = 0; i < opts.files.length; i += size) {
      const chunk = opts.files.slice(i, i + size);
      const args = [...ccccArgsTemplate(jobs), ...chunk];
      const r = await runOnce(opts.binary, args, opts.treeRoot, home, policy.measurer.timeout_ms);
      runs.push({ ...r, side: opts.side, args, expectedPaths: chunk });
    }
    return runs;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Validates every chunk and merges the trusted file reports. */
export function validateRuns(runs: CcccRun[], policy: Policy): ValidatedRun {
  const merged: ValidatedRun = { files: [], inconclusive: [], baselineParseErrors: [] };
  for (const r of runs) {
    const v = validateCcccRun(r, policy.measurer.timeout_ms, { parserLagAllowlist: policy.parser_lag_allowlist });
    merged.files.push(...v.files);
    merged.inconclusive.push(...v.inconclusive);
    merged.baselineParseErrors.push(...v.baselineParseErrors);
  }
  return merged;
}
