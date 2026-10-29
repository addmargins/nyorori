// G7 `gate/mutation` (spec 8.5, observe only): survivors of StrykerJS runs
// restricted to changed lines, shown in a PR comment, never blocking.

import { z } from "zod";
import type { FileLineMap, Inconclusive } from "../../types.js";
import { changedLinesFromHunks } from "../coverage/changed.js";
import { createPathResolver, type PathResolveOptions } from "../tests/paths.js";

const status = z.enum(["Killed", "Survived", "NoCoverage", "CompileError", "RuntimeError", "Timeout", "Ignored", "Pending"]);
const loc = z.object({ line: z.number().int(), column: z.number().int() });

const reportSchema = z
  .object({
    schemaVersion: z.string(),
    files: z.record(
      z
        .object({
          mutants: z.array(
            z
              .object({
                id: z.string(),
                mutatorName: z.string(),
                replacement: z.string().optional(),
                location: z.object({ start: loc, end: loc }),
                status,
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const MAX_MUTATION_REPORT_BYTES = 128 * 1024 * 1024;

export type MutantStatus = z.infer<typeof status>;

export interface ChangedMutant {
  file: string;
  line: number;
  mutator: string;
  replacement?: string;
  status: MutantStatus;
}

export interface MutationSummary {
  survived: ChangedMutant[];
  noCoverage: ChangedMutant[];
  killed: number;
  timeout: number;
  /** Killed+Timeout over all valid mutants on changed lines; null when there are none. */
  score: number | null;
}

export type MutationParse =
  | { ok: true; summary: MutationSummary }
  | { ok: false; inconclusive: Inconclusive };

/** `--mutate` arguments covering only changed C lines (Stryker accepts `file:start-end`). */
export function strykerMutateArgs(lineMaps: readonly FileLineMap[], addedFiles: readonly string[] = []): string[] {
  const out = [...addedFiles];
  for (const m of lineMaps) {
    if (addedFiles.includes(m.pathC)) continue;
    for (const h of m.hunks) {
      if (h.cCount === 0) continue;
      out.push(`${m.pathC}:${h.cStart}-${h.cStart + h.cCount - 1}`);
    }
  }
  return out;
}

export function summarizeMutation(
  text: string | null | undefined,
  lineMaps: readonly FileLineMap[],
  addedFiles: readonly string[] = [],
  opts: PathResolveOptions = {},
): MutationParse {
  if (!text) return { ok: false, inconclusive: { reason: "REPORT_MISSING", detail: "mutation.json is missing", authorFixable: false } };
  if (text.length > MAX_MUTATION_REPORT_BYTES || Buffer.byteLength(text, "utf8") > MAX_MUTATION_REPORT_BYTES) {
    return { ok: false, inconclusive: { reason: "SCHEMA", detail: `mutation report exceeds ${MAX_MUTATION_REPORT_BYTES} bytes`, authorFixable: false } };
  }
  let parsed;
  try {
    parsed = reportSchema.safeParse(JSON.parse(text));
  } catch (e) {
    return { ok: false, inconclusive: { reason: "SCHEMA", detail: `mutation report is not JSON: ${(e as Error).message}`, authorFixable: false } };
  }
  if (!parsed.success) {
    return { ok: false, inconclusive: { reason: "SCHEMA", detail: "mutation report does not match mutation-testing-report-schema", authorFixable: false } };
  }
  const changed = new Map(lineMaps.map((m) => [m.pathC, changedLinesFromHunks(m.hunks)]));
  const added = new Set(addedFiles);
  const resolve = createPathResolver({ ...opts, knownFiles: opts.knownFiles ?? [...changed.keys(), ...added] });
  const summary: MutationSummary = { survived: [], noCoverage: [], killed: 0, timeout: 0, score: null };
  let valid = 0;
  for (const [rawPath, file] of Object.entries(parsed.data.files)) {
    const r = resolve(rawPath);
    if (!r.ok) continue;
    const lines = changed.get(r.path);
    for (const m of file.mutants) {
      const onChanged = added.has(r.path) || (lines !== undefined && lines.has(m.location.start.line));
      if (!onChanged) continue;
      const cm: ChangedMutant = { file: r.path, line: m.location.start.line, mutator: m.mutatorName, replacement: m.replacement, status: m.status };
      if (m.status === "Survived") summary.survived.push(cm);
      else if (m.status === "NoCoverage") summary.noCoverage.push(cm);
      else if (m.status === "Killed") summary.killed++;
      else if (m.status === "Timeout") summary.timeout++;
      if (["Killed", "Timeout", "Survived", "NoCoverage"].includes(m.status)) valid++;
    }
  }
  summary.score = valid === 0 ? null : (summary.killed + summary.timeout) / valid;
  const order = (a: ChangedMutant, b: ChangedMutant) => a.file.localeCompare(b.file) || a.line - b.line;
  summary.survived.sort(order);
  summary.noCoverage.sort(order);
  return { ok: true, summary };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/`/g, "'").slice(0, 80);
}

export function formatMutationComment(s: MutationSummary, limit = 30): string {
  const lines = [
    "### gate/mutation (observe only)",
    "",
    s.score === null
      ? "No mutants on changed lines."
      : `Mutation score on changed lines: ${(s.score * 100).toFixed(1)}% — ${s.survived.length} survived, ${s.noCoverage.length} without coverage.`,
  ];
  const rows = [...s.survived, ...s.noCoverage];
  if (rows.length > 0) {
    lines.push("", "| file:line | mutator | replacement | status |", "|---|---|---|---|");
    for (const m of rows.slice(0, limit)) {
      lines.push(`| \`${m.file}:${m.line}\` | ${escapeCell(m.mutator)} | ${m.replacement ? `\`${escapeCell(m.replacement)}\`` : ""} | ${m.status} |`);
    }
    if (rows.length > limit) lines.push("", `…and ${rows.length - limit} more.`);
  }
  return lines.join("\n");
}
