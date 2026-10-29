// AI fix-loop contract (spec 12.2, 12.3). The forbidden list is enforced
// mechanically on the loop's diff; prompt instructions alone do not stop a
// reward-hacking agent from editing the gate's own inputs.

import ts from "typescript";
import { classifyDirectiveComment, isAllowlisted, type Directive } from "../gates/lint/text.js";
import type { Policy } from "../policy/schema.js";
import { ALWAYS_ROUTING_TRIGGERS, NON_ROUTING_TRIGGERS, type ChangeStatus, type Inconclusive, type TriggerHit, type Violation } from "../types.js";
import { matchesGlob } from "../util/glob.js";

const matchAny = (path: string, patterns: readonly string[]): string | null => patterns.find((p) => matchesGlob(path, p)) ?? null;

/** Spec 12.2, machine-readable, for gate-feedback.json (`forbidden_changes`). */
export const FORBIDDEN_CHANGES = [
  { id: "gate_tool_config", description: "gate and tool configuration: cccc.toml, ESLint, dependency-cruiser, vitest/jest configs, tsconfig strict*, .gitignore, .ignore, .gitattributes, package.json test scripts, CI workflows, the waiver ledger" },
  { id: "test_removed", description: "deleting a test that existed in B" },
  { id: "test_focus_or_skip", description: "adding .only, .skip, xit, todo, fails" },
  { id: "assertions_weakened", description: "fewer assertions, weaker matchers, snapshot updates (-u)" },
  { id: "suppression_added", description: "eslint-disable*, istanbul/v8/c8 ignore, Stryker disable, @ts-ignore, @ts-nocheck, @ts-expect-error outside the policy allowlist" },
  { id: "moved_out_of_measurement", description: "renaming measured files to unmeasured extensions, moving code into excluded or generated paths" },
] as const;

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

/**
 * Suppression directives in one added line, classified by the same rules G2
 * uses (eslint disable/inline config, @ts-*, coverage ignores, Stryker
 * disable). Only real comments count: the line is tokenized, so a directive
 * inside a string literal is not one. A line that continues a block comment
 * (`* eslint-disable …`) is read as comment text.
 */
export function addedLineDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith("*") && !trimmed.startsWith("*/")) {
    const d = classifyDirectiveComment(trimmed.replace(/\*\/\s*$/, ""), "Block");
    if (d) out.push(d);
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const tok = scanner.getTokenText();
    let d: Directive | null = null;
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia) d = classifyDirectiveComment(tok.slice(2), "Line");
    else if (kind === ts.SyntaxKind.MultiLineCommentTrivia) d = classifyDirectiveComment(tok.slice(2).replace(/\*\/$/, ""), "Block");
    if (d) out.push(d);
  }
  return out;
}

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
    if (c.pathC && policy.scope.exclude.some((g) => matchesGlob(c.pathC!, g))) {
      const wasExcluded = c.pathB ? policy.scope.exclude.some((g) => matchesGlob(c.pathB!, g)) : false;
      if (!wasExcluded) out.push(v(c.pathC, `AI fix loop moved code into excluded path ${c.pathC}`));
    }
    for (const added of c.addedLines ?? []) {
      for (const d of addedLineDirectives(added.text)) {
        if (isAllowlisted(d, policy.lint.suppression_allowlist)) continue;
        out.push(v(c.pathC ?? c.pathB ?? "", `AI fix loop added a suppression directive (${d.normalized})`, { directive: d.kind }, added.line));
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

/** What identifies "the same measurement" across attempts (spec 12.3 "같은 B"). */
export interface AttemptBinding {
  base: string;
  policyRevision: string;
  /** cccc sha256 + runner commit, or any stable fingerprint string the caller derives. */
  fingerprint: string;
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
  /** INCONCLUSIVE entries of this attempt; any of them ends the loop (a human must look). */
  inconclusive?: readonly Inconclusive[];
  /** Binding of the first attempt and of this one; drift between them ends the loop. */
  first?: AttemptBinding;
  current?: AttemptBinding;
}

export type RetryDecision = { attemptsRemaining: number } & (
  | { action: "done"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "handoff"; reason: string }
);

/** Machine-readable stop conditions, mirrored into gate-feedback.json. */
export const STOP_IF = [
  { id: "forbidden_change", description: "the diff touched a protected path, test, config or suppression (spec 12.2)" },
  { id: "inconclusive", description: "any gate is INCONCLUSIVE; measurement problems are for a human" },
  { id: "measurement_drift", description: "base, policy revision or measurer fingerprint differ from the first attempt" },
  { id: "new_routing_trigger", description: "the fix fired a review trigger the original PR did not" },
  { id: "no_progress", description: "the violation set is unchanged since the previous attempt" },
  { id: "retry_limit", description: "ai_loop.max_retries attempts were used" },
] as const;

export type StopReason = (typeof STOP_IF)[number]["id"];

function bindingDrift(a: AttemptBinding, b: AttemptBinding): string | null {
  if (a.base !== b.base) return `base ${a.base} → ${b.base}`;
  if (a.policyRevision !== b.policyRevision) return `policy ${a.policyRevision} → ${b.policyRevision}`;
  if (a.fingerprint !== b.fingerprint) return `measurer fingerprint ${a.fingerprint} → ${b.fingerprint}`;
  return null;
}

/**
 * Library decision for an AI fix-loop runner (spec 12.3); nyorori does not
 * drive the loop itself. Hands off on a forbidden change, on any new routing
 * trigger, on no progress, and at the retry limit.
 */
export function decideRetry(state: RetryState, policy: Policy): RetryDecision {
  const attemptsRemaining = Math.max(0, policy.ai_loop.max_retries - state.attempt);
  const handoff = (id: StopReason, detail: string): RetryDecision => ({ action: "handoff", reason: `${id}: ${detail}`, attemptsRemaining });
  if (state.forbidden.length > 0) return handoff("forbidden_change", "forbidden change (spec 12.2)");
  if (state.inconclusive && state.inconclusive.length > 0) {
    return handoff("inconclusive", [...new Set(state.inconclusive.map((i) => i.reason))].join(", "));
  }
  if (state.first && state.current) {
    const drift = bindingDrift(state.first, state.current);
    if (drift) return handoff("measurement_drift", drift);
  }
  // Any new routing trigger means the fix needs a human (S1/S9: redistributing or hiding branches).
  const fresh = state.newTriggers.filter(
    (t) => (t.routing || ALWAYS_ROUTING_TRIGGERS.has(t.id)) && !NON_ROUTING_TRIGGERS.has(t.id),
  );
  if (fresh.length > 0) {
    return handoff("new_routing_trigger", `the fix fired new review triggers (${[...new Set(fresh.map((t) => t.id))].join(", ")})`);
  }
  if (state.currentViolations.length === 0) return { action: "done", reason: "no violations left", attemptsRemaining };
  if (state.attempt > 0 && state.previousViolations.length > 0) {
    const prev = new Set(state.previousViolations);
    const same = state.currentViolations.length === prev.size && state.currentViolations.every((k) => prev.has(k));
    if (same) return handoff("no_progress", "violation set unchanged");
  }
  if (attemptsRemaining === 0) return handoff("retry_limit", `retry limit ${policy.ai_loop.max_retries} reached`);
  return { action: "retry", reason: `fix attempt ${state.attempt + 1} of ${policy.ai_loop.max_retries}`, attemptsRemaining };
}

/** Shape triggers that are also computed against the previous attempt C_{n-1} (ruling D17). */
export const PREVIOUS_ATTEMPT_TRIGGERS: ReadonlySet<TriggerHit["id"]> = new Set<TriggerHit["id"]>(["S1", "S9", "S10"]);

/**
 * Ruling D17: on retry n the caller additionally runs G1 with B = C_{n-1} and
 * C = C_n. Its S1/S9/S10 for files that had a G1 violation in C_{n-1} route to
 * the simplification review (the B ratchet itself is unchanged), so a loop
 * cannot launder a redistribution across attempts.
 */
export function previousAttemptTriggers(vsPrevious: readonly TriggerHit[], violatingFiles: Iterable<string>): TriggerHit[] {
  const files = new Set(violatingFiles);
  return vsPrevious
    .filter((t) => PREVIOUS_ATTEMPT_TRIGGERS.has(t.id) && t.file !== undefined && files.has(t.file))
    .map((t) => ({ ...t, routing: true, evidence: `${t.evidence} (vs previous attempt)` }));
}

/** Current triggers plus the previous-attempt ones, without duplicates. */
export function mergePreviousAttemptTriggers(
  current: readonly TriggerHit[],
  vsPrevious: readonly TriggerHit[],
  violatingFiles: Iterable<string>,
): TriggerHit[] {
  const out = [...current];
  const seen = new Set(out.map((t) => `${t.id}|${t.file ?? ""}|${t.unit ?? ""}|${t.evidence}`));
  for (const t of previousAttemptTriggers(vsPrevious, violatingFiles)) {
    const k = `${t.id}|${t.file ?? ""}|${t.unit ?? ""}|${t.evidence}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}
