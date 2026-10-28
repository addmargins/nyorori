// Waiver ledger (spec 11.1): append-only waivers.jsonl, also the source of the
// quarterly waiver count. Unreadable lines count as used, so a damaged ledger
// can only shrink the remaining budget.

import { appendFile, readFile } from "node:fs/promises";

export interface LedgerStore {
  /** Waivers recorded for `repository` since the start of the current UTC quarter. */
  quarterCount(repository: string, now: Date): Promise<number>;
  append(line: string): Promise<void>;
  /** Waiver ids already recorded for `repository` (merge-event redeliveries must not double-count). */
  recordedWaiverIds(repository: string): Promise<Set<string>>;
}

export function quarterStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
}

export class FileLedgerStore implements LedgerStore {
  constructor(private readonly file: string) {}

  async quarterCount(repository: string, now: Date): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    const since = quarterStart(now).getTime();
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { repository?: unknown; recorded_at?: unknown };
        const at = typeof entry.recorded_at === "string" ? Date.parse(entry.recorded_at) : NaN;
        if (entry.repository !== repository) continue;
        if (Number.isNaN(at) || at >= since) n++;
      } catch {
        n++;
      }
    }
    return n;
  }

  async recordedWaiverIds(repository: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return ids;
      throw e;
    }
    for (const line of text.split("\n")) {
      try {
        const entry = JSON.parse(line) as { repository?: unknown; waiver_id?: unknown };
        if (entry.repository === repository && typeof entry.waiver_id === "string") ids.add(entry.waiver_id);
      } catch {
        // Damaged lines are counted by quarterCount; they carry no id to dedupe on.
      }
    }
    return ids;
  }

  async append(line: string): Promise<void> {
    if (line.includes("\n") && !line.endsWith("\n")) throw new Error("ledger lines are single JSON lines");
    await appendFile(this.file, line.endsWith("\n") ? line : `${line}\n`);
  }
}
