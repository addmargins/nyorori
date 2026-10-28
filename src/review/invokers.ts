// Who invoked an AI agent that authored a PR (spec 2.4, 7.6). The invoker is
// effectively the author, so they may not approve; and when nobody can be
// identified the PR needs two approvers (independence.requiredApprovers).

import type { Policy } from "../policy/schema.js";
import { isBot } from "./independence.js";

export interface InvokerSources {
  /** Login of the AI-loop bot that authored the PR. */
  botLogin: string;
  assignees: readonly string[];
  /** PR body written by the bot; `@login` mentions in it name who asked. */
  body: string | null | undefined;
  /** PR conversation; a human addressing `@bot` directs the agent. */
  comments: ReadonlyArray<{ author: string; body: string }>;
  /** Authors of the issues the PR closes (`closes #N`), resolved by the caller. */
  linkedIssueAuthors: readonly string[];
}

const LINK_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
const MENTION_RE = /(?<![\w/])@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\b/gi;

/** Issue numbers a PR body says it closes, in this repository only. */
export function linkedIssueNumbers(body: string | null | undefined, repository: string): number[] {
  const out = new Set<number>();
  for (const m of (body ?? "").matchAll(LINK_RE)) {
    if (m[1] && m[1].toLowerCase() !== repository.toLowerCase()) continue;
    out.add(Number(m[2]));
  }
  return [...out].slice(0, 10);
}

export function mentions(text: string | null | undefined): string[] {
  return [...new Set([...(text ?? "").matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()))];
}

export function collectAgentInvokers(src: InvokerSources, policy: Policy): string[] {
  const bot = src.botLogin.toLowerCase();
  const out = new Set<string>();
  const add = (login: string) => {
    const l = login.toLowerCase();
    if (l && l !== bot && !isBot(l, policy)) out.add(l);
  };
  for (const a of src.assignees) add(a);
  for (const m of mentions(src.body)) add(m);
  for (const c of src.comments) {
    if (mentions(c.body).includes(bot)) add(c.author);
  }
  for (const a of src.linkedIssueAuthors) add(a);
  return [...out].sort();
}
