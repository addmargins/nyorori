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
import { independenceProblem, inRoster, requiredApprovers, secondApproverReason, type PrIdentityContext, type TeamRosters } from "../review/independence.js";
import { CommandError, findCommands, requireArgs } from "../waivers/command.js";
import { EDITED_COMMAND_NOTE, screenComments, type IssueComment } from "../waivers/index.js";

/**
 * Reasons a gate owner may override for one file. PARSE_ERROR_CANDIDATE only
 * for listed parser-lag syntax. MEASURER_MISMATCH and SCHEMA are never
 * reported per file (they describe the measurer run), so they are fixed in P,
 * not overridden.
 */
export const OWNER_OVERRIDABLE: ReadonlySet<InconclusiveReason> = new Set<InconclusiveReason>([
  "INVARIANT_VIOLATION",
  "NONDETERMINISM",
  "PARSE_ERROR_CANDIDATE",
]);

export interface OverrideRequest {
  commentId: string;
  owner: string;
  gate: GateId;
  reason: InconclusiveReason;
  /** File-scoped override: bound to (file, C blob). */
  file?: string;
  blob?: string;
  /** Run-scoped override (NONDETERMINISM only): bound to (B, C) of this run. */
  base?: string;
  candidate?: string;
  note: string;
  createdAt: string;
}

/** The only reason a gate owner may override without a file: the run is bound by (B, C) instead. */
export const RUN_SCOPED_OVERRIDABLE: ReadonlySet<InconclusiveReason> = new Set<InconclusiveReason>(["NONDETERMINISM"]);

export interface OverrideContext {
  policy: Policy;
  identity: PrIdentityContext;
  teams?: TeamRosters;
  candidateBlob: (path: string) => string | null;
  /** This run's B and C; required for run-scoped overrides. */
  base?: string;
  candidate?: string;
}

export interface OverrideOutcome {
  /** INCONCLUSIVE entries that remain after overrides. */
  inconclusive: Inconclusive[];
  unmeasured: UnmeasuredRecord[];
  triggers: TriggerHit[];
  applied: OverrideRequest[];
  rejected: Array<{ commentId: string; problem: string }>;
  /** Notes for run-scoped overrides: the measurement must be re-run before the next decision. */
  rerunRequired: string[];
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Formats:
 *   /gate-override gate=complexity reason=PARSE_ERROR_CANDIDATE file="src/a.ts" blob=<sha> note="…"
 *   /gate-override gate=complexity reason=NONDETERMINISM base=<B> candidate=<C> note="…"
 */
export function parseOverrides(comment: IssueComment): OverrideRequest[] | { commentId: string; problem: string } {
  const commentId = String(comment.id);
  try {
    return findCommands(comment.body, "gate-override").map((cmd) => {
      const a = cmd.args;
      if (!("file" in a) && ("base" in a || "candidate" in a)) {
        requireArgs(cmd, ["gate", "reason", "base", "candidate", "note"]);
        const base = a.base!.toLowerCase();
        const candidate = a.candidate!.toLowerCase();
        if (!OID.test(base) || !OID.test(candidate)) throw new CommandError("base and candidate must be commit ids");
        return {
          commentId,
          owner: comment.author.login,
          gate: a.gate as GateId,
          reason: a.reason as InconclusiveReason,
          base,
          candidate,
          note: a.note!,
          createdAt: comment.createdAt,
        };
      }
      requireArgs(cmd, ["gate", "reason", "file", "blob", "note"]);
      if (/[*?]/.test(a.file!)) throw new CommandError("wildcards are not allowed in override files");
      const blob = a.blob!.toLowerCase();
      if (!OID.test(blob)) throw new CommandError("blob must be a git object id");
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
  const screened = screenComments(comments);
  for (const i of screened.ignored) rejected.push({ commentId: i.id, problem: EDITED_COMMAND_NOTE });
  for (const c of screened.kept) {
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
    if (r.file === undefined) {
      if (!RUN_SCOPED_OVERRIDABLE.has(r.reason)) {
        reject(`${r.reason} cannot be overridden without a file`);
        continue;
      }
      if (!ctx.base || !ctx.candidate || r.base !== ctx.base.toLowerCase() || r.candidate !== ctx.candidate.toLowerCase()) {
        reject("the override was given for another base/candidate");
        continue;
      }
      valid.push(r);
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

  // Unlinked commit identities: require two independent gate owners per override.
  const needed = requiredApprovers(ctx.identity);
  if (needed > 1) {
    const owners = new Map<string, Set<string>>();
    for (const r of valid) {
      const k = `${r.file ?? "*"}\u0000${r.reason}`;
      owners.set(k, (owners.get(k) ?? new Set()).add(r.owner.toLowerCase()));
    }
    for (let i = valid.length - 1; i >= 0; i--) {
      const r = valid[i]!;
      if (owners.get(`${r.file ?? "*"}\u0000${r.reason}`)!.size < needed) {
        rejected.push({ commentId: r.commentId, problem: `needs ${needed} independent gate owners (${secondApproverReason(ctx.identity)})` });
        valid.splice(i, 1);
      }
    }
  }

  const remaining: Inconclusive[] = [];
  const applied = new Map<string, OverrideRequest>();
  for (const item of inconclusive) {
    // A parser-lag parse error is reported as author-fixable by the measurer
    // (it cannot tell lag from a real syntax error); the allowlist decides.
    const lag = item.reason === "PARSE_ERROR_CANDIDATE" && parserLagListed(item, ctx.policy);
    const match = valid.find((r) =>
      r.file === undefined
        ? item.reason === r.reason
        : item.file === r.file &&
          item.reason === r.reason &&
          (item.reason === "PARSE_ERROR_CANDIDATE" ? lag : !item.authorFixable),
    );
    if (match) applied.set(`${match.file ?? "*"}\u0000${match.reason}`, match);
    else remaining.push(item);
  }

  const appliedList = [...applied.values()];
  const files = [...new Set(appliedList.flatMap((r) => (r.file ? [r.file] : [])))];
  const runScoped = appliedList.filter((r) => r.file === undefined);
  return {
    inconclusive: remaining,
    unmeasured: files.map((path) => ({ path, side: "C" as const, reason: "MEASUREMENT_OVERRIDE" as const })),
    triggers: appliedList.map((r) => ({
      id: "S6" as const,
      gate,
      ...(r.file ? { file: r.file } : {}),
      evidence: r.file
        ? `measurement override of ${r.reason} by ${r.owner}: ${r.note}`
        : `measurement override of ${r.reason} for this run by ${r.owner} (rerun required): ${r.note}`,
      routing: true,
    })),
    applied: appliedList,
    rejected,
    rerunRequired: runScoped.map((r) => `${r.reason} overridden by ${r.owner} for ${r.base}..${r.candidate}; re-run the measurement before relying on it`),
  };
}
