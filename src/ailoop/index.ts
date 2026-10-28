// AI fix-loop contract (spec 12.2, 12.3). The forbidden list is enforced
// mechanically on the loop's diff; prompt instructions alone do not stop a
// reward-hacking agent from editing the gate's own inputs.

import type { Policy } from "../policy/schema.js";
import type { ChangeStatus, TriggerHit, Violation } from "../types.js";
import { matchAny, matchGlob } from "./glob.js";

/** Spec 12.2 paths on top of policy.tests.protected_paths. */
export const AI_LOOP_FORBIDDEN_PATHS: readonly string[] = [
  "cccc.toml",
  ".cccc.toml",
  "eslint.config.*",
  ".eslintrc*",
  ".dependency-cruiser.*",
  "vitest.config.*",
  "vitest.workspace.*",
  "jest.config.*",
  "tsconfig*.json",
  ".gitignore",
  ".ignore",
  ".gitattributes",
  ".github/**",
  "waivers.jsonl",
  "**/__snapshots__/**",
  "*.snap",
];

/** Suppression directives the loop may not add (allowlist exempt). */
export const SUPPRESSION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "eslint-disable", re: /eslint-disable(?:-next-line|-line)?\b/ },
  { id: "istanbul ignore", re: /istanbul\s+ignore\b/ },
  { id: "v8 ignore", re: /\bv8\s+ignore\b/ },
  { id: "c8 ignore", re: /\bc8\s+ignore\b/ },
  { id: "@ts-ignore", re: /@ts-ignore\b/ },
  { id: "@ts-nocheck", re: /@ts-nocheck\b/ },
  { id: "@ts-expect-error", re: /@ts-expect-error\b/ },
];

export interface LoopChange {
  status: ChangeStatus;
  pathB: string | null;
  pathC: string | null;
  /** Lines added on the C side (from `git diff -U0`), for directive detection. */
  addedLines?: Array<{ line: number; text: string }>;
}

export interface PackageJsonPair {
  path: string;
  before: string | null;
  after: string | null;
}

function v(file: string, message: string, details?: Record<string, unknown>, line?: number): Violation {
  return { gate: "tests", reason: "POLICY_PATH_MODIFIED", file, message, ...(line ? { line } : {}), ...(details ? { details } : {}) };
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

function testConfigOf(json: string | null): unknown {
  if (json === null) return null;
  try {
    const pkg = JSON.parse(json) as Record<string, unknown>;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const testScripts = Object.fromEntries(
      Object.entries(scripts).filter(([k]) => k === "test" || k.startsWith("test:") || k.startsWith("pretest") || k.startsWith("posttest")),
    );
    return { scripts: testScripts, jest: pkg.jest ?? null, vitest: pkg.vitest ?? null, c8: pkg.c8 ?? null, nyc: pkg.nyc ?? null };
  } catch {
    return { unparseable: json };
  }
}

/** Returns FAIL(POLICY_PATH_MODIFIED) violations for an AI-loop diff. */
export function detectForbiddenChanges(
  changes: readonly LoopChange[],
  policy: Policy,
  packageJsons: readonly PackageJsonPair[] = [],
): Violation[] {
  const out: Violation[] = [];
  const forbidden = [...policy.tests.protected_paths, ...AI_LOOP_FORBIDDEN_PATHS];
  const measured = new Set(policy.scope.extensions);
  for (const c of changes) {
    for (const p of [c.pathB, c.pathC]) {
      if (!p) continue;
      const hit = matchAny(p, forbidden);
      if (hit) {
        out.push(v(p, `AI fix loop modified protected path ${p} (matches ${hit})`, { pattern: hit }));
        break;
      }
    }
    if (c.pathB && c.pathC && c.pathB !== c.pathC) {
      if (measured.has(extOf(c.pathB)) && !measured.has(extOf(c.pathC))) {
        out.push(v(c.pathC, `AI fix loop moved ${c.pathB} out of the measured extensions`));
      }
    }
    if (c.pathC && policy.scope.exclude.some((g) => matchGlob(c.pathC!, g))) {
      const wasExcluded = c.pathB ? policy.scope.exclude.some((g) => matchGlob(c.pathB!, g)) : false;
      if (!wasExcluded) out.push(v(c.pathC, `AI fix loop moved code into excluded path ${c.pathC}`));
    }
    for (const added of c.addedLines ?? []) {
      for (const s of SUPPRESSION_PATTERNS) {
        if (!s.re.test(added.text)) continue;
        if (policy.lint.suppression_allowlist.some((a) => added.text.includes(a))) continue;
        out.push(v(c.pathC ?? c.pathB ?? "", `AI fix loop added a suppression directive (${s.id})`, { directive: s.id }, added.line));
      }
    }
  }
  for (const pj of packageJsons) {
    if (JSON.stringify(testConfigOf(pj.before)) !== JSON.stringify(testConfigOf(pj.after))) {
      out.push(v(pj.path, `AI fix loop changed test scripts or test configuration in ${pj.path}`));
    }
  }
  return out;
}

export interface RetryState {
  /** Fix attempts already made by the loop (0 = the original PR was just measured). */
  attempt: number;
  /** Stable violation keys of the previous attempt (empty on the first). */
  previousViolations: readonly string[];
  currentViolations: readonly string[];
  /** Triggers that fired on this attempt but not on the original PR. */
  newTriggers: readonly TriggerHit[];
  forbidden: readonly Violation[];
}

export type RetryDecision =
  | { action: "done"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "handoff"; reason: string };

export function violationKey(v: Violation): string {
  return `${v.gate}|${v.reason}|${v.unit ?? v.file}|${v.metric ?? ""}`;
}

export function decideRetry(state: RetryState, policy: Policy): RetryDecision {
  if (state.forbidden.length > 0) return { action: "handoff", reason: "forbidden change (spec 12.2)" };
  const hiding = state.newTriggers.filter((t) => t.id === "S1" || t.id === "S9");
  if (hiding.length > 0) {
    return { action: "handoff", reason: `fix redistributed or hid branches (${[...new Set(hiding.map((t) => t.id))].join(", ")})` };
  }
  if (state.currentViolations.length === 0) return { action: "done", reason: "no violations left" };
  if (state.attempt > 0 && state.previousViolations.length > 0) {
    const prev = new Set(state.previousViolations);
    const same = state.currentViolations.length === prev.size && state.currentViolations.every((k) => prev.has(k));
    if (same) return { action: "handoff", reason: "no progress: violation set unchanged" };
  }
  if (state.attempt >= policy.ai_loop.max_retries) {
    return { action: "handoff", reason: `retry limit ${policy.ai_loop.max_retries} reached` };
  }
  return { action: "retry", reason: `fix attempt ${state.attempt + 1} of ${policy.ai_loop.max_retries}` };
}
