// Approver independence (spec 7.6, 11.1). In an AI-authored PR the person who
// invoked the agent is effectively the author, so "independent of the author"
// has to cover every commit participant, co-author and agent invoker.

import type { Policy } from "../policy/schema.js";

export interface CommitIdentity {
  sha: string;
  authorLogin?: string | null;
  authorEmail?: string | null;
  committerLogin?: string | null;
  committerEmail?: string | null;
  /** Full commit message; Co-authored-by trailers are read from it. */
  message?: string;
}

export interface PrIdentityContext {
  prAuthor: string;
  commits: CommitIdentity[];
  /** People who invoked or assigned the AI agent that produced the PR. */
  agentInvokers: string[];
  /** Authors of the other PRs in the same merge group; excluded like the PR author. */
  additionalAuthors?: string[];
  /** True when the commit list may be incomplete (GitHub lists at most 250 PR commits). */
  commitsTruncated?: boolean;
}

/** GitHub's "list commits on a pull request" stops at 250 commits. */
export const MAX_ENUMERABLE_COMMITS = 250;

export interface Actor {
  login: string;
  /** Verified emails of the actor when the caller can resolve them. */
  emails?: string[];
}

/** Resolved team rosters, keyed by "org/team". Unresolved teams grant nobody. */
export type TeamRosters = Record<string, string[]>;

const norm = (s: string) => s.trim().toLowerCase();

/** GitHub's committer identity for web-UI commits; it is the platform, not a person. */
const PLATFORM_COMMITTERS = new Set(["web-flow"]);

export function isBot(login: string, policy: Policy): boolean {
  const l = norm(login);
  if (l.endsWith("[bot]")) return true;
  return [...policy.review.bots, ...policy.ai_loop.bot_accounts].some((b) => norm(b) === l);
}

export function isAiLoopBot(login: string, policy: Policy): boolean {
  const l = norm(login);
  return policy.ai_loop.bot_accounts.some((b) => norm(b) === l);
}

/** Roster entries are logins or "@org/team" references. */
export function inRoster(login: string, roster: readonly string[], teams: TeamRosters = {}): boolean {
  const l = norm(login);
  for (const entry of roster) {
    if (entry.startsWith("@")) {
      const members = teams[entry.slice(1)] ?? teams[norm(entry.slice(1))];
      if (members?.some((m) => norm(m) === l)) return true;
    } else if (norm(entry) === l) {
      return true;
    }
  }
  return false;
}

const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

function loginFromEmail(email: string): string | null {
  const m = NOREPLY.exec(email.trim());
  return m ? norm(m[1]!) : null;
}

export function coAuthorEmails(message: string | undefined): string[] {
  if (!message) return [];
  const out: string[] = [];
  const re = /^co-authored-by:\s*.*?<([^>]+)>\s*$/gim;
  for (let m = re.exec(message); m; m = re.exec(message)) out.push(norm(m[1]!));
  return out;
}

export interface Participants {
  logins: Set<string>;
  emails: Set<string>;
}

export function participants(ctx: PrIdentityContext): Participants {
  const logins = new Set<string>([norm(ctx.prAuthor), ...ctx.agentInvokers.map(norm), ...(ctx.additionalAuthors ?? []).map(norm)]);
  const emails = new Set<string>();
  const addEmail = (e?: string | null) => {
    if (!e) return;
    emails.add(norm(e));
    const l = loginFromEmail(e);
    if (l) logins.add(l);
  };
  for (const c of ctx.commits) {
    if (c.authorLogin) logins.add(norm(c.authorLogin));
    if (c.committerLogin && !PLATFORM_COMMITTERS.has(norm(c.committerLogin))) {
      logins.add(norm(c.committerLogin));
    }
    addEmail(c.authorEmail);
    if (!c.committerLogin || !PLATFORM_COMMITTERS.has(norm(c.committerLogin))) addEmail(c.committerEmail);
    for (const e of coAuthorEmails(c.message)) addEmail(e);
  }
  return { logins, emails };
}

/** Why independence cannot be judged at all for this PR, or null. */
export function identityProblem(ctx: PrIdentityContext): string | null {
  if (ctx.commitsTruncated || ctx.commits.length >= MAX_ENUMERABLE_COMMITS) {
    return `independence unknown: the PR has ${MAX_ENUMERABLE_COMMITS} or more commits and GitHub does not list them all; split the PR or squash`;
  }
  return null;
}

const PLATFORM_EMAILS = new Set(["noreply@github.com"]);

/**
 * Commit identities known only by an email that maps to no login: an
 * unlinked commit author/committer, or a Co-authored-by trailer that is not a
 * GitHub noreply address and not the email of a linked commit author. The
 * service cannot tell whether a reviewer is behind such an email.
 */
export function unresolvedIdentities(ctx: PrIdentityContext): string[] {
  const linked = new Set<string>();
  for (const c of ctx.commits) {
    if (c.authorLogin && c.authorEmail) linked.add(norm(c.authorEmail));
    if (c.committerLogin && c.committerEmail) linked.add(norm(c.committerEmail));
  }
  const out = new Set<string>();
  const check = (email: string | null | undefined, login: string | null | undefined) => {
    if (!email || login) return;
    const e = norm(email);
    if (PLATFORM_EMAILS.has(e) || loginFromEmail(e) || linked.has(e)) return;
    out.add(e);
  };
  for (const c of ctx.commits) {
    check(c.authorEmail, c.authorLogin);
    if (!c.committerLogin || !PLATFORM_COMMITTERS.has(norm(c.committerLogin))) check(c.committerEmail, c.committerLogin);
    for (const e of coAuthorEmails(c.message)) check(e, null);
  }
  return [...out].sort();
}

/**
 * Fail-closed rule for unresolved identities: when any participant is known
 * only by an unmapped email, one approval could come from that person, so
 * two independent approvers are required.
 */
export function requiredApprovers(ctx: PrIdentityContext): 1 | 2 {
  return unresolvedIdentities(ctx).length > 0 ? 2 : 1;
}

/**
 * Returns why `actor` may not approve, or null when they are independent.
 * Roster membership is checked separately by the caller.
 */
export function independenceProblem(actor: Actor, ctx: PrIdentityContext, policy: Policy): string | null {
  const login = norm(actor.login);
  if (isBot(login, policy)) return "bots cannot approve";
  const unknown = identityProblem(ctx);
  if (unknown) return unknown;
  if (login === norm(ctx.prAuthor)) return "the PR author cannot approve";
  if (ctx.agentInvokers.some((i) => norm(i) === login)) return "the AI agent invoker cannot approve";
  const p = participants(ctx);
  if (p.logins.has(login)) return "a commit author, committer or co-author cannot approve";
  if ((actor.emails ?? []).some((e) => p.emails.has(norm(e)))) {
    return "a commit author, committer or co-author cannot approve";
  }
  return null;
}
