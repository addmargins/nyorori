#!/usr/bin/env node
// Isolated analysis worker (spec 10.1). Everything that parses PR-derived
// bytes (cccc, ESLint, Prettier, TypeScript, artifact zips) runs here, in a
// child that never holds the App key: it reads one JSON request on stdin and
// writes one JSON response on stdout. Exit 0 with a response, 1 otherwise.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CcccRun } from "../measure/cccc.js";
import { runGates } from "./run.js";
import type { RunGatesOptions, RunGatesOutput } from "./types.js";

/** RunGatesOptions with the fields that cannot cross a process boundary replaced. */
export type WireOptions = Omit<RunGatesOptions, "rng" | "now"> & { now?: string };

export type WireRun = Omit<CcccRun, "stdout" | "stderr"> & { stdout: string; stderr: string };

export type WireOutput = Omit<RunGatesOutput, "ccccRuns"> & { ccccRuns: WireRun[] };

export function toWireOptions(opts: RunGatesOptions): WireOptions {
  const { rng: _rng, now, ...rest } = opts;
  return { ...rest, ...(now ? { now: now.toISOString() } : {}) };
}

export function fromWireOptions(w: WireOptions): RunGatesOptions {
  const { now, ...rest } = w;
  return { ...rest, ...(now ? { now: new Date(now) } : {}) };
}

export function toWireOutput(out: RunGatesOutput): WireOutput {
  return {
    ...out,
    ccccRuns: out.ccccRuns.map((r) => ({ ...r, stdout: r.stdout.toString("base64"), stderr: r.stderr.toString("base64") })),
  };
}

export function fromWireOutput(w: WireOutput): RunGatesOutput {
  return {
    ...w,
    ccccRuns: w.ccccRuns.map((r) => ({ ...r, stdout: Buffer.from(r.stdout, "base64"), stderr: Buffer.from(r.stderr, "base64") })),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function workerMain(): Promise<number> {
  const wire = JSON.parse(await readStdin()) as WireOptions;
  const out = await runGates(fromWireOptions(wire));
  await new Promise<void>((done, fail) => process.stdout.write(JSON.stringify(toWireOutput(out)), (e) => (e ? fail(e) : done())));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  workerMain().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
