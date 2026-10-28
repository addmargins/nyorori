// Slash-command tokenizer shared by /gate-waive, /gate-waive-approve,
// /gate-override and /simplification-review. Commands only count at the start
// of a line outside fenced code and quotes, so quoting someone else's approval
// in a reply never re-issues it.

export interface ParsedCommand {
  name: string;
  positional: string[];
  args: Record<string, string>;
  /** Lines after the command line, up to the end of the comment. */
  bodyLines: string[];
}

export class CommandError extends Error {}

function tokenize(rest: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (i >= rest.length) break;
    // An unquoted word starting with "#" begins a trailing comment, as in the
    // gate's own copyable commands (`/gate-waive-approve W1 blob=… # unit`).
    if (rest[i] === "#") break;
    let tok = "";
    while (i < rest.length && !/\s/.test(rest[i]!)) {
      const ch = rest[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        let closed = false;
        while (i < rest.length) {
          const c = rest[i]!;
          if (c === "\\" && quote === '"' && i + 1 < rest.length) {
            tok += rest[i + 1]!;
            i += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            i++;
            break;
          }
          tok += c;
          i++;
        }
        if (!closed) throw new CommandError("unterminated quote");
      } else {
        tok += ch;
        i++;
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

/**
 * Lines a reader actually sees as plain paragraph text, per CommonMark as
 * GitHub renders it; hidden or literal lines become null. Hidden: HTML
 * comments (`<!-- … -->`, unterminated ones run to the end). Literal or
 * quoted: fenced code (``` or ~~~, any info string, closed only by the same
 * character repeated at least as often), indented code (4+ columns after a
 * blank line or at the start), blockquotes and their lazy continuation lines.
 */
export function visibleLines(body: string): Array<string | null> {
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, " ").replace(/^ /, "\u0000"));
  const lines = text.split("\n");
  const out: Array<string | null> = [];
  let fence: { ch: string; len: number } | null = null;
  let quote = false;
  let prevBlank = true;
  for (const raw of lines) {
    // A line that was (part of) an HTML comment is hidden even if the comment
    // left other characters on it, so `x <!-- -->/cmd` tricks gain nothing.
    const hiddenByComment = raw.includes("\u0000");
    const line = raw.replaceAll("\u0000", " ");
    const expanded = line.replace(/\t/g, "    ");
    const indent = expanded.length - expanded.trimStart().length;
    const trimmed = expanded.trimStart();
    const blank = trimmed.length === 0;
    if (fence) {
      const close = new RegExp(`^${fence.ch === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
      if (indent < 4 && close.test(trimmed)) fence = null;
      out.push(null);
      prevBlank = false;
      continue;
    }
    const open = indent < 4 ? /^(`{3,}|~{3,})(.*)$/.exec(trimmed) : null;
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      quote = false;
      out.push(null);
      prevBlank = false;
      continue;
    }
    if (blank) {
      quote = false;
      out.push(hiddenByComment ? null : "");
      prevBlank = !hiddenByComment;
      continue;
    }
    if (indent < 4 && trimmed.startsWith(">")) {
      quote = true;
      out.push(null);
      prevBlank = false;
      continue;
    }
    if (quote) {
      out.push(null); // lazy continuation of the blockquote paragraph
      prevBlank = false;
      continue;
    }
    if (indent >= 4 && prevBlank) {
      out.push(null); // indented code block
      continue;
    }
    out.push(hiddenByComment ? null : line);
    prevBlank = false;
  }
  return out;
}

/** Finds every occurrence of `/name` in a comment body. */
export function findCommands(body: string, name: string): ParsedCommand[] {
  const lines = visibleLines(body);
  const out: ParsedCommand[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line === null || line === undefined) continue;
    const expanded = line.replace(/\t/g, "    ");
    if (expanded.length - expanded.trimStart().length >= 4) continue;
    const trimmed = expanded.trimStart();
    const prefix = `/${name}`;
    if (!trimmed.startsWith(prefix)) continue;
    const after = trimmed.slice(prefix.length);
    if (after.length > 0 && !/^\s/.test(after)) continue; // e.g. /gate-waive-approve vs /gate-waive
    const tokens = tokenize(after);
    const positional: string[] = [];
    const args: Record<string, string> = {};
    for (const t of tokens) {
      const eq = t.indexOf("=");
      if (eq > 0 && /^[a-z_][a-z0-9_-]*$/i.test(t.slice(0, eq))) {
        const key = t.slice(0, eq).toLowerCase();
        if (key in args) throw new CommandError(`duplicate argument "${key}"`);
        args[key] = t.slice(eq + 1);
      } else {
        positional.push(t);
      }
    }
    out.push({ name, positional, args, bodyLines: lines.slice(idx + 1).map((l) => l ?? "") });
  }
  return out;
}

/** Any gate command, for routing events and the edited-comment rule. */
export const GATE_COMMAND_NAMES = ["gate-waive", "gate-waive-approve", "gate-override", "gate-approve-tests", "simplification-review"] as const;

export function hasGateCommand(body: string): boolean {
  try {
    return GATE_COMMAND_NAMES.some((n) => findCommands(body, n).length > 0);
  } catch {
    return true; // a malformed command is still a command attempt
  }
}

export function requireArgs(cmd: ParsedCommand, required: string[], optional: string[] = []): void {
  for (const r of required) {
    if (!(r in cmd.args) || cmd.args[r] === "") throw new CommandError(`missing argument "${r}"`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(cmd.args)) {
    if (!allowed.has(k)) throw new CommandError(`unknown argument "${k}"`);
  }
}
