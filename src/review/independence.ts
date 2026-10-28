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
}

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
  const logins = new Set<string>([norm(ctx.prAuthor), ...ctx.agentInvokers.map(norm)]);
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

/**
 * Returns why `actor` may not approve, or null when they are independent.
 * Roster membership is checked separately by the caller.
 */
export function independenceProblem(actor: Actor, ctx: PrIdentityContext, policy: Policy): string | null {
  const login = norm(actor.login);
  if (isBot(login, policy)) return "bots cannot approve";
  if (login === norm(ctx.prAuthor)) return "the PR author cannot approve";
  if (ctx.agentInvokers.some((i) => norm(i) === login)) return "the AI agent invoker cannot approve";
  const p = participants(ctx);
  if (p.logins.has(login)) return "a commit author, committer or co-author cannot approve";
  if ((actor.emails ?? []).some((e) => p.emails.has(norm(e)))) {
    return "a commit author, committer or co-author cannot approve";
  }
  return null;
}
