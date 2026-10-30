// Waivers: recorded risk acceptance for a FAIL (spec 11.1). A waiver names one
// unit, one metric and a ceiling, and is bound to the blob of the unit's file
// that the approver saw; any code change, expiry or ceiling overrun voids it.

import { createHash } from "node:crypto";
import type { Policy } from "../policy/schema.js";
import { INCONCLUSIVE_REASONS, type GateId, type ReasonCode, type TriggerHit, type Violation, type WaiverApplied } from "../types.js";
import {
  independenceProblem,
  inRoster,
  isAiLoopBot,
  requiredApprovers,
  secondApproverReason,
  type Actor,
  type PrIdentityContext,
  type TeamRosters,
} from "../review/independence.js";
import { CommandError, findCommands, hasGateCommand, requireArgs } from "./command.js";

export interface IssueComment {
  id: number | string;
  author: Actor;
  body: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last edit time (GitHub `updated_at`). */
  updatedAt?: string;
}

export const EDITED_COMMAND_NOTE = "edited command ignored; post a new comment";

/** GitHub sets updated_at a moment after created_at on some writes; anything later is an edit. */
export const EDIT_JITTER_MS = 2000;

/**
 * Anyone with write access can edit another user's comment, so an edited
 * comment proves nothing about its author. Gate commands count only from
 * comments that were never edited; the author posts a new comment instead.
 */
export function isEdited(c: Pick<IssueComment, "createdAt" | "updatedAt">): boolean {
  if (!c.updatedAt) return false;
  const created = Date.parse(c.createdAt);
  const updated = Date.parse(c.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return true;
  return updated - created > EDIT_JITTER_MS;
}

/** Splits comments into those whose commands count and edited command comments (reported, ignored). */
export function screenComments<T extends IssueComment>(comments: readonly T[]): { kept: T[]; ignored: Array<{ id: string; author: string }> } {
  const kept: T[] = [];
  const ignored: Array<{ id: string; author: string }> = [];
  for (const c of comments) {
    if (!isEdited(c)) kept.push(c);
    else if (hasGateCommand(c.body)) ignored.push({ id: String(c.id), author: c.author.login });
  }
  return { kept, ignored };
}

/** `tests` is waivable only for TESTS_FAILED_ON_BASE (ruling D14); every other G4 reason is not. */
export const WAIVABLE_GATES: ReadonlySet<GateId> = new Set(["complexity", "lint-structure", "deps", "coverage", "tests"]);

/**
 * Never waivable (ruling D14): G4 integrity goes through a policy change or a
 * gate-owner test approval, dynamic code and bidi controls are bypass vectors,
 * failing tests and the non-waivable suppressions have their own waivable
 * reason codes (TESTS_FAILED_ON_BASE, SUPPRESSION_ADDED_WAIVABLE).
 */
export const NON_WAIVABLE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "TEST_REMOVED",
  "TEST_FOCUS_OR_SKIP",
  "TEST_CONFIG_WEAKENED",
  "TESTS_FAILED",
  "PROTECTED_PATH_MODIFIED",
  "POLICY_PATH_MODIFIED",
  "DYNAMIC_CODE",
  "BIDI_CONTROL",
  "SUPPRESSION_ADDED",
  "REVIEW_REQUIRED",
  "REVIEW_CHANGES_REQUESTED",
]);

/** Measurement reasons: INCONCLUSIVE is handled by overrides, never by waivers. */
const MEASUREMENT_REASONS: ReadonlySet<string> = new Set(INCONCLUSIVE_REASONS);

/**
 * Whether a violation may be covered by a waiver. Producers may mark the
 * waivable variants either with their own reason code or with a detail flag
 * on the base reason (`base_broken` for failing tests, `waivable` for
 * suppressions); both forms are accepted.
 */
export function isWaivable(v: Violation): boolean {
  const reason = v.reason as string;
  if (reason === "TESTS_FAILED_ON_BASE" || reason === "SUPPRESSION_ADDED_WAIVABLE") return true;
  if (reason === "TESTS_FAILED") return v.details?.["base_broken"] === true;
  if (reason === "SUPPRESSION_ADDED") return v.details?.["waivable"] === true;
  return !NON_WAIVABLE_REASONS.has(v.reason) && !MEASUREMENT_REASONS.has(reason);
}

/** The metric a waiver names: the violation's metric, or its reason code when it has none. */
export function violationMetric(v: Violation): string {
  return normalizeMetric(v.metric ?? v.reason);
}

export interface WaiverRequest {
  id: string;
  commentId: string;
  requester: string;
  gate: GateId;
  unit: string;
  /** Repository path of the unit's file (the part of the unit key before "::"). */
  file: string;
  metric: string;
  ceiling: number;
  reason: string;
  requestedAt: string;
  /** Requested expiry (ISO date); capped at approval + policy.waivers.max_days. */
  expires?: string;
}

export interface ValidWaiver extends WaiverRequest {
  approver: string;
  /** Every independent approver, in approval order (two are needed when identities are unresolved). */
  approvers?: string[];
  approvedAt: string;
  expiresAt: string;
  /** Blob the approver saw. */
  blob: string;
  /** Set when the waiver carried over to a newer blob whose diff does not touch the unit (ruling D15). */
  currentBlob?: string;
}

export interface WaiverRejection {
  commentId: string;
  waiverId?: string;
  problem: string;
}

export interface WaiverContext {
  policy: Policy;
  identity: PrIdentityContext;
  teams?: TeamRosters;
  now: Date;
  /** Blob SHA of a path in the current candidate C, or null when absent. */
  candidateBlob: (path: string) => string | null;
  /**
   * Ruling D15 carry-over. Computed by the caller: true when
   * diff(approvedBlob → currentBlob) has a hunk inside the unit's range in
   * currentBlob, or when that cannot be decided (unit missing, unreadable
   * blob). Absent means no carry-over: any change voids the waiver.
   */
  unitTouchedSince?: (q: { file: string; unit: string; approvedBlob: string; currentBlob: string }) => boolean;
}

const METRIC_ALIASES: Record<string, string> = {
  cogc: "cognitive",
  cognitive: "cognitive",
  cc: "cyclomatic",
  cyclomatic: "cyclomatic",
};

export function normalizeMetric(metric: string): string {
  const m = metric.trim().toLowerCase();
  return METRIC_ALIASES[m] ?? m;
}

export function waiverId(commentId: string, gate: string, unit: string, metric: string, ceiling: number): string {
  const h = createHash("sha256").update(`${commentId}|${gate}|${unit}|${metric}|${ceiling}`).digest("hex");
  return `W${h.slice(0, 10)}`;
}

function unitFile(unit: string): string | null {
  const idx = unit.indexOf("::");
  if (idx <= 0) return null;
  const rest = unit.slice(idx + 2);
  if (!rest) return null;
  return unit.slice(0, idx);
}

export function parseWaiverRequest(comment: IssueComment, policy: Policy): WaiverRequest[] | WaiverRejection {
  const commentId = String(comment.id);
  let cmds;
  try {
    cmds = findCommands(comment.body, "gate-waive");
  } catch (e) {
    return { commentId, problem: (e as Error).message };
  }
  if (cmds.length === 0) return [];
  if (isAiLoopBot(comment.author.login, policy)) {
    return { commentId, problem: "the AI fix loop cannot request waivers" };
  }
  const out: WaiverRequest[] = [];
  for (const cmd of cmds) {
    try {
      requireArgs(cmd, ["gate", "unit", "metric", "ceiling", "reason"], ["expires"]);
      const a = cmd.args as Record<string, string>;
      const gate = a.gate as GateId;
      if (!WAIVABLE_GATES.has(gate)) throw new CommandError(`gate "${a.gate}" is not waivable`);
      const unit = a.unit!;
      if (/[*?]/.test(unit)) throw new CommandError("wildcards are not allowed in waiver units");
      const file = unitFile(unit);
      if (!file) throw new CommandError(`"${unit}" is not a unit key (expected <path>::<unit>)`);
      if (!/^\d+$/.test(a.ceiling!)) throw new CommandError("ceiling must be a non-negative integer");
      if (a.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.expires)) {
        throw new CommandError("expires must be YYYY-MM-DD");
      }
      if (!a.reason!.trim()) throw new CommandError("reason must not be empty");
      const metric = normalizeMetric(a.metric!);
      const ceiling = Number(a.ceiling);
      out.push({
        id: waiverId(commentId, gate, unit, metric, ceiling),
        commentId,
        requester: comment.author.login,
        gate,
        unit,
        file,
        metric,
        ceiling,
        reason: a.reason!,
        requestedAt: comment.createdAt,
        ...(a.expires ? { expires: a.expires } : {}),
      });
    } catch (e) {
      return { commentId, problem: (e as Error).message };
    }
  }
  return out;
}

interface Approval {
  commentId: string;
  waiverId: string;
  approver: Actor;
  approvedAt: string;
  blob: string;
}

function parseApprovals(comment: IssueComment): Approval[] | WaiverRejection {
  const commentId = String(comment.id);
  try {
    return findCommands(comment.body, "gate-waive-approve").map((cmd) => {
      requireArgs(cmd, ["blob"]);
      if (cmd.positional.length !== 1) throw new CommandError("expected exactly one waiver id");
      const blob = cmd.args.blob!.toLowerCase();
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(blob)) throw new CommandError("blob must be a git object id");
      return { commentId, waiverId: cmd.positional[0]!, approver: comment.author, approvedAt: comment.createdAt, blob };
    });
  } catch (e) {
    return { commentId, problem: (e as Error).message };
  }
}

const DAY_MS = 86_400_000;

/** Reads every waiver request and approval in the PR conversation and keeps the valid ones. */
export function evaluateWaivers(
  comments: readonly IssueComment[],
  ctx: WaiverContext,
): { valid: ValidWaiver[]; rejected: WaiverRejection[] } {
  const requests = new Map<string, WaiverRequest>();
  const rejected: WaiverRejection[] = [];
  const approvals: Approval[] = [];
  const screened = screenComments(comments);
  for (const i of screened.ignored) rejected.push({ commentId: i.id, problem: EDITED_COMMAND_NOTE });
  const ordered = screened.kept.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of ordered) {
    const req = parseWaiverRequest(c, ctx.policy);
    if (Array.isArray(req)) for (const r of req) requests.set(r.id, r);
    else rejected.push(req);
    const app = parseApprovals(c);
    if (Array.isArray(app)) approvals.push(...app);
    else rejected.push(app);
  }

  const valid = new Map<string, ValidWaiver>();
  for (const ap of approvals) {
    const reject = (problem: string) => rejected.push({ commentId: ap.commentId, waiverId: ap.waiverId, problem });
    const req = requests.get(ap.waiverId);
    if (!req) {
      reject("no such waiver request");
      continue;
    }
    if (ap.approvedAt < req.requestedAt) {
      reject("approval predates the request");
      continue;
    }
    if (!inRoster(ap.approver.login, ctx.policy.review.waiver_approvers, ctx.teams)) {
      reject(`${ap.approver.login} is not a waiver approver`);
      continue;
    }
    if (ap.approver.login.toLowerCase() === req.requester.toLowerCase()) {
      reject("the requester cannot approve their own waiver");
      continue;
    }
    const indep = independenceProblem(ap.approver, ctx.identity, ctx.policy);
    if (indep) {
      reject(indep);
      continue;
    }
    const current = ctx.candidateBlob(req.file)?.toLowerCase() ?? null;
    let carried: string | undefined;
    if (current === null) {
      reject("the unit's file no longer exists");
      continue;
    }
    if (current !== ap.blob) {
      const touched = ctx.unitTouchedSince?.({ file: req.file, unit: req.unit, approvedBlob: ap.blob, currentBlob: current }) ?? true;
      if (touched) {
        reject("the unit changed since approval");
        continue;
      }
      carried = current;
    }
    const cap = new Date(Date.parse(ap.approvedAt) + ctx.policy.waivers.max_days * DAY_MS);
    const requested = req.expires ? new Date(`${req.expires}T23:59:59Z`) : cap;
    const expiresAt = requested < cap ? requested : cap;
    if (ctx.now > expiresAt) {
      reject("waiver expired");
      continue;
    }
    const prior = valid.get(req.id);
    if (!prior) {
      valid.set(req.id, {
        ...req,
        approver: ap.approver.login,
        approvers: [ap.approver.login],
        approvedAt: ap.approvedAt,
        expiresAt: expiresAt.toISOString(),
        blob: ap.blob,
        ...(carried ? { currentBlob: carried } : {}),
      });
    } else if (!prior.approvers!.some((a) => a.toLowerCase() === ap.approver.login.toLowerCase())) {
      prior.approvers!.push(ap.approver.login);
      if (expiresAt.toISOString() < prior.expiresAt) prior.expiresAt = expiresAt.toISOString();
    }
  }
  // Unlinked commit identities: one approval could come from that person (independence.requiredApprovers).
  const needed = requiredApprovers(ctx.identity);
  const out: ValidWaiver[] = [];
  for (const w of valid.values()) {
    if (w.approvers!.length >= needed) out.push(w);
    else rejected.push({ commentId: w.commentId, waiverId: w.id, problem: `needs ${needed} independent approvers (${secondApproverReason(ctx.identity)})` });
  }
  return { valid: out, rejected };
}

export interface WaiverApplication {
  violations: Violation[];
  applied: WaiverApplied[];
  /** Valid waivers that did not apply (no matching violation, ceiling exceeded, budget). */
  unused: Array<{ id: string; problem: string }>;
}

/** Marks covered violations with `waivedBy`; the per-PR budget caps how many waivers can apply. */
export function applyWaivers(violations: readonly Violation[], waivers: readonly ValidWaiver[], policy: Policy): WaiverApplication {
  const out = violations.map((v) => ({ ...v }));
  const applied: WaiverApplied[] = [];
  const unused: Array<{ id: string; problem: string }> = [];
  const ordered = [...waivers].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.id.localeCompare(b.id));
  for (const w of ordered) {
    // G4 emits `${file}::${name}` for test units; an older form carries the bare name.
    const sameUnit = (v: Violation) => v.unit === w.unit || (!!v.unit && !v.unit.includes("::") && `${v.file}::${v.unit}` === w.unit);
    const targets = out.filter((v) => !v.waivedBy && v.gate === w.gate && sameUnit(v) && violationMetric(v) === w.metric);
    if (targets.length === 0) {
      unused.push({ id: w.id, problem: "no matching violation" });
      continue;
    }
    if (targets.some((v) => !isWaivable(v))) {
      unused.push({ id: w.id, problem: "violation reason is not waivable" });
      continue;
    }
    // A violation without a numeric value (failing test, suppression) is waived with ceiling=0.
    if (targets.some((v) => (typeof v.after === "number" ? v.after > w.ceiling : w.ceiling !== 0))) {
      unused.push({ id: w.id, problem: "value exceeds the waiver ceiling" });
      continue;
    }
    if (applied.length >= policy.waivers.per_pr_budget) {
      unused.push({ id: w.id, problem: "per-PR waiver budget exhausted" });
      continue;
    }
    for (const v of targets) v.waivedBy = w.id;
    applied.push({ id: w.id, unit: w.unit, metric: w.metric, ceiling: w.ceiling, approver: w.approver });
  }
  return { violations: out, applied, unused };
}

/** Command an approver can copy, pinned to the blob they are looking at. */
export function approveCommand(waiverIdValue: string, blob: string): string {
  return `/gate-waive-approve ${waiverIdValue} blob=${blob}`;
}

export interface LedgerEntry {
  schema_version: 1;
  waiver_id: string;
  repository: string;
  pr: number;
  merge_commit: string;
  gate: GateId;
  unit: string;
  metric: string;
  value: number | null;
  ceiling: number;
  requester: string;
  approver: string;
  reason: string;
  approved_at: string;
  recorded_at: string;
}

/** One line of the append-only waivers.jsonl ledger, written after merge. */
export function ledgerLine(
  w: ValidWaiver,
  meta: { repository: string; pr: number; mergeCommit: string; value: number | null; recordedAt: string },
): string {
  const entry: LedgerEntry = {
    schema_version: 1,
    waiver_id: w.id,
    repository: meta.repository,
    pr: meta.pr,
    merge_commit: meta.mergeCommit,
    gate: w.gate,
    unit: w.unit,
    metric: w.metric,
    value: meta.value,
    ceiling: w.ceiling,
    requester: w.requester,
    approver: w.approver,
    reason: w.reason,
    approved_at: w.approvedAt,
    recorded_at: meta.recordedAt,
  };
  return `${JSON.stringify(entry)}\n`;
}

export interface DebtIssue {
  title: string;
  body: string;
  labels: string[];
  dueDate: string;
}

export function debtIssue(entry: LedgerEntry, maxDays: number): DebtIssue {
  const due = new Date(Date.parse(entry.recorded_at) + maxDays * DAY_MS).toISOString().slice(0, 10);
  return {
    title: `complexity-debt: ${entry.unit} (${entry.metric} ${entry.value ?? "?"}, waiver ${entry.waiver_id})`,
    body: [
      `Waiver \`${entry.waiver_id}\` accepted \`${entry.unit}\` at ${entry.metric} ${entry.value ?? "?"} (ceiling ${entry.ceiling}) in ${entry.repository}#${entry.pr} (${entry.merge_commit}).`,
      "",
      `- requester: ${entry.requester}`,
      `- approver: ${entry.approver}`,
      `- reason: ${entry.reason}`,
      `- due: ${due}`,
      "",
      "The merged value becomes the unit's baseline for later PRs (max(T, B)); reduce it before the due date or record why it must stay.",
    ].join("\n"),
    labels: ["complexity-debt"],
    dueDate: due,
  };
}

/** S6: every applied waiver routes to the simplification review (spec 7.5). */
export function waiverTriggers(applied: readonly WaiverApplied[], waivers: readonly ValidWaiver[]): TriggerHit[] {
  return applied.map((a) => {
    const w = waivers.find((x) => x.id === a.id);
    return {
      id: "S6" as const,
      gate: w?.gate ?? "complexity",
      file: w?.file,
      unit: a.unit,
      evidence: `waiver ${a.id}: ${a.metric} ≤ ${a.ceiling}, approved by ${a.approver}`,
      routing: true,
    };
  });
}
