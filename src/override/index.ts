// Measurement override (spec 11.2): a gate owner turns "cannot measure" into
// "a human measures" for one file at one blob. It never turns FAIL into PASS:
// it only removes INCONCLUSIVE entries, marks the file unmeasured and routes
// the PR to the simplification review (S6).

import type { Policy } from "../policy/schema.js";
import type {
  GateId,
  Inconclusive,
  InconclusiveReason,
  TriggerHit,
  UnmeasuredRecord,
} from "../types.js";
import { independenceProblem, inRoster, type PrIdentityContext, type TeamRosters } from "../review/independence.js";
import { CommandError, findCommands, requireArgs } from "../waivers/command.js";
import type { IssueComment } from "../waivers/index.js";

/** Reasons a gate owner may override. PARSE_ERROR_CANDIDATE only for listed parser-lag syntax. */
export const OWNER_OVERRIDABLE: ReadonlySet<InconclusiveReason> = new Set<InconclusiveReason>([
  "MEASURER_MISMATCH",
  "SCHEMA",
  "INVARIANT_VIOLATION",
  "NONDETERMINISM",
  "PARSE_ERROR_CANDIDATE",
]);

export interface OverrideRequest {
  commentId: string;
  owner: string;
  gate: GateId;
  reason: InconclusiveReason;
  file: string;
  blob: string;
  note: string;
  createdAt: string;
}

export interface OverrideContext {
  policy: Policy;
  identity: PrIdentityContext;
  teams?: TeamRosters;
  candidateBlob: (path: string) => string | null;
}

export interface OverrideOutcome {
  /** INCONCLUSIVE entries that remain after overrides. */
  inconclusive: Inconclusive[];
  unmeasured: UnmeasuredRecord[];
  triggers: TriggerHit[];
  applied: OverrideRequest[];
  rejected: Array<{ commentId: string; problem: string }>;
  /** Files to re-measure with the observe-only fallback (ESLint complexity). */
  fallbackMeasure: string[];
}

/**
 * Format: /gate-override gate=complexity reason=PARSE_ERROR_CANDIDATE file="src/a.ts" blob=<sha> note="…"
 */
export function parseOverrides(comment: IssueComment): OverrideRequest[] | { commentId: string; problem: string } {
  const commentId = String(comment.id);
  try {
    return findCommands(comment.body, "gate-override").map((cmd) => {
      requireArgs(cmd, ["gate", "reason", "file", "blob", "note"]);
      const a = cmd.args;
      if (/[*?]/.test(a.file!)) throw new CommandError("wildcards are not allowed in override files");
      const blob = a.blob!.toLowerCase();
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(blob)) throw new CommandError("blob must be a git object id");
      return {
        commentId,
        owner: comment.author.login,
        gate: a.gate as GateId,
        reason: a.reason as InconclusiveReason,
        file: a.file!,
        blob,
        note: a.note!,
        createdAt: comment.createdAt,
      };
    });
  } catch (e) {
    return { commentId, problem: (e as Error).message };
  }
}

function parserLagListed(item: Inconclusive, policy: Policy): boolean {
  return policy.parser_lag_allowlist.some((entry) => entry.length > 0 && item.detail.includes(entry));
}

export function applyOverrides(
  gate: GateId,
  inconclusive: readonly Inconclusive[],
  comments: readonly IssueComment[],
  ctx: OverrideContext,
): OverrideOutcome {
  const rejected: OverrideOutcome["rejected"] = [];
  const requests: OverrideRequest[] = [];
  for (const c of comments) {
    const parsed = parseOverrides(c);
    if (Array.isArray(parsed)) requests.push(...parsed);
    else rejected.push(parsed);
  }

  const valid: OverrideRequest[] = [];
  for (const r of requests) {
    if (r.gate !== gate) continue;
    const reject = (problem: string) => rejected.push({ commentId: r.commentId, problem });
    if (!inRoster(r.owner, ctx.policy.review.gate_owners, ctx.teams)) {
      reject(`${r.owner} is not a gate owner`);
      continue;
    }
    const indep = independenceProblem({ login: r.owner }, ctx.identity, ctx.policy);
    if (indep) {
      reject(indep);
      continue;
    }
    if (!OWNER_OVERRIDABLE.has(r.reason)) {
      reject(`${r.reason} cannot be overridden`);
      continue;
    }
    const current = ctx.candidateBlob(r.file);
    if (current === null || current.toLowerCase() !== r.blob) {
      reject("the file changed since the override");
      continue;
    }
    valid.push(r);
  }

  const remaining: Inconclusive[] = [];
  const applied = new Map<string, OverrideRequest>();
  for (const item of inconclusive) {
    const match = valid.find(
      (r) =>
        item.file === r.file &&
        item.reason === r.reason &&
        !item.authorFixable &&
        (item.reason !== "PARSE_ERROR_CANDIDATE" || parserLagListed(item, ctx.policy)),
    );
    if (match) applied.set(`${match.file}\u0000${match.reason}`, match);
    else remaining.push(item);
  }

  const appliedList = [...applied.values()];
  const files = [...new Set(appliedList.map((r) => r.file))];
  return {
    inconclusive: remaining,
    unmeasured: files.map((path) => ({ path, side: "C" as const, reason: "MEASUREMENT_OVERRIDE" as const })),
    triggers: appliedList.map((r) => ({
      id: "S6" as const,
      gate,
      file: r.file,
      evidence: `measurement override of ${r.reason} by ${r.owner}: ${r.note}`,
      routing: true,
    })),
    applied: appliedList,
    rejected,
    fallbackMeasure: files,
  };
}
