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

/** Finds every occurrence of `/name` in a comment body. */
export function findCommands(body: string, name: string): ParsedCommand[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: ParsedCommand[] = [];
  let inFence = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const trimmed = line.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith(">")) continue;
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
    out.push({ name, positional, args, bodyLines: lines.slice(idx + 1) });
  }
  return out;
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
