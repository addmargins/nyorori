// Istanbul `coverage-final.json` reader. Branch locations are required, which
// is why the gate insists on this format (spec 8.4): line-based formats such
// as lcov summaries cannot tell which branch outcome of a changed line ran.

import { z } from "zod";
import type { Inconclusive } from "../../types.js";
import { createPathResolver, type PathResolveOptions } from "../tests/paths.js";

// v8-to-istanbul emits `{}` for implicit else locations and `null` end columns.
const position = z.object({ line: z.number().int().optional(), column: z.number().nullable().optional() }).passthrough();
const range = z.object({ start: position, end: position }).passthrough();

const fileCoverage = z
  .object({
    path: z.string(),
    statementMap: z.record(range),
    fnMap: z.record(
      z.object({ name: z.string(), decl: range.optional(), loc: range, line: z.number().optional() }).passthrough(),
    ),
    branchMap: z.record(
      z.object({ loc: range.optional(), type: z.string(), locations: z.array(range), line: z.number().optional() }).passthrough(),
    ),
    s: z.record(z.number()),
    f: z.record(z.number()),
    b: z.record(z.array(z.number())),
  })
  .passthrough();

export const coverageMetaSchema = z
  .object({
    provider: z.string().min(1),
    provider_version: z.string().default(""),
    vitest_version: z.string().default(""),
  })
  .passthrough();
export type CoverageMeta = z.infer<typeof coverageMetaSchema>;

export interface LineRange {
  start: number;
  end: number;
}

export interface BranchOutcome {
  branchId: string;
  index: number;
  type: string;
  range: LineRange;
  count: number;
}

export interface FunctionCoverage {
  id: string;
  name: string;
  declLine: number;
  range: LineRange;
  count: number;
}

export interface StatementCoverage {
  id: string;
  range: LineRange;
  count: number;
}

export interface FileCoverage {
  path: string;
  statements: StatementCoverage[];
  functions: FunctionCoverage[];
  branches: BranchOutcome[];
}

export type CoverageParse =
  | { ok: true; files: Map<string, FileCoverage>; unmapped: string[] }
  | { ok: false; inconclusive: Inconclusive };

function toRange(r: z.infer<typeof range> | undefined, fallback?: LineRange): LineRange | null {
  const s = r?.start.line;
  const e = r?.end.line ?? s;
  if (s === undefined || e === undefined) return fallback ?? null;
  return { start: s, end: Math.max(s, e) };
}

function bad(reason: Inconclusive["reason"], detail: string): CoverageParse {
  return { ok: false, inconclusive: { reason, detail, authorFixable: false } };
}

/** Untrusted artifact: bounded. Large monorepos produce big reports, hence more headroom than test reports. */
export const MAX_COVERAGE_REPORT_BYTES = 256 * 1024 * 1024;

export function parseIstanbul(text: string | null | undefined, opts: PathResolveOptions = {}): CoverageParse {
  if (!text || text.trim() === "") return bad("REPORT_MISSING", "coverage-final.json is missing or empty");
  if (text.length > MAX_COVERAGE_REPORT_BYTES || Buffer.byteLength(text, "utf8") > MAX_COVERAGE_REPORT_BYTES) {
    return bad("SCHEMA", `coverage report exceeds ${MAX_COVERAGE_REPORT_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return bad("SCHEMA", `coverage report is not JSON: ${(e as Error).message}`);
  }
  const parsed = z.record(fileCoverage).safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return bad("SCHEMA", `coverage report schema at ${i?.path.join(".") ?? "?"}: ${i?.message ?? "invalid"}`);
  }
  const resolve = createPathResolver(opts);
  const files = new Map<string, FileCoverage>();
  const unmapped: string[] = [];
  for (const [key, fc] of Object.entries(parsed.data)) {
    const r = resolve(fc.path || key);
    if (!r.ok) {
      unmapped.push(r.raw);
      continue;
    }
    const statements: StatementCoverage[] = [];
    for (const [id, loc] of Object.entries(fc.statementMap)) {
      const rg = toRange(loc);
      if (!rg) continue;
      if (fc.s[id] === undefined) return bad("SCHEMA", `${r.path}: statement ${id} has no counter`);
      statements.push({ id, range: rg, count: fc.s[id]! });
    }
    const functions: FunctionCoverage[] = [];
    for (const [id, fn] of Object.entries(fc.fnMap)) {
      const rg = toRange(fn.loc);
      if (!rg) continue;
      if (fc.f[id] === undefined) return bad("SCHEMA", `${r.path}: function ${id} has no counter`);
      const declLine = fn.decl?.start.line ?? fn.line ?? rg.start;
      functions.push({ id, name: fn.name, declLine, range: rg, count: fc.f[id]! });
    }
    const branches: BranchOutcome[] = [];
    for (const [id, br] of Object.entries(fc.branchMap)) {
      const counts = fc.b[id];
      if (!counts || counts.length !== br.locations.length) {
        return bad("SCHEMA", `${r.path}: branch ${id} has ${counts?.length ?? 0} counters for ${br.locations.length} locations`);
      }
      const whole = toRange(br.loc) ?? (br.line ? { start: br.line, end: br.line } : null);
      // An implicit outcome (no else) is a decision of the condition line.
      const implicit = whole ? { start: whole.start, end: whole.start } : undefined;
      br.locations.forEach((loc, index) => {
        const rg = toRange(loc, implicit);
        if (rg) branches.push({ branchId: id, index, type: br.type, range: rg, count: counts[index]! });
      });
    }
    files.set(r.path, { path: r.path, statements, functions, branches });
  }
  return { ok: true, files, unmapped };
}

export function parseCoverageMeta(text: string | null | undefined): CoverageMeta | null {
  if (!text) return null;
  try {
    const r = coverageMetaSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
