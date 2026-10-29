// Durable half of the evaluation queue: every accepted delivery is written to
// `jobs/<owner>/<repo>/<delivery>.json` before and while it runs, so a service
// restart can re-enqueue what was queued or running (the job re-reads all
// state from GitHub; nothing from the journal is trusted beyond the event).
// The delivery dedupe set is persisted next to it.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./lock.js";

export type JobStatus = "queued" | "running" | "waiting" | "done" | "superseded" | "failed";

/** An evaluation parked until the untrusted workflow's evidence for C arrives (or the deadline passes). */
export interface WaitRecord {
  repository: string;
  kind: "pull_request" | "merge_group";
  pr?: number;
  /** Commit the check runs hang on; equals the PR head (pull_request) or C (merge_group). */
  checkSha: string;
  prHeadSha?: string;
  base: string;
  candidate: string;
  policyRevision: string;
  /** Trusted workflow paths still expected to report. */
  workflows: string[];
  /** ISO time after which the wait becomes INCONCLUSIVE(REPORT_MISSING). */
  deadline: string;
  deliveryId?: string;
  startedAt: string;
  /** Deadline passed and INCONCLUSIVE was published; a late matching run still re-evaluates (A3). */
  expired?: boolean;
}

/** Where parked evaluations live; the journal implements it durably, tests may use memory. */
export interface WaitStore {
  /** Replaces any wait with the same key. */
  putWait(key: string, wait: WaitRecord): Promise<void>;
  listWaits(): Promise<Array<{ key: string; wait: WaitRecord }>>;
  clearWait(key: string): Promise<void>;
}

export class MemoryWaitStore implements WaitStore {
  private readonly waits = new Map<string, WaitRecord>();
  async putWait(key: string, wait: WaitRecord): Promise<void> {
    this.waits.set(key, wait);
  }
  async listWaits(): Promise<Array<{ key: string; wait: WaitRecord }>> {
    return [...this.waits].map(([key, wait]) => ({ key, wait }));
  }
  async clearWait(key: string): Promise<void> {
    this.waits.delete(key);
  }
}

export interface JobRecord {
  delivery: string;
  repository: string;
  event: string;
  status: JobStatus;
  generation: number;
  /** ISO times. */
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The webhook payload, kept only while it may need replaying and only when small. */
  payload?: unknown;
  replayable: boolean;
  note?: string;
  /** Set while status is "waiting". */
  wait?: WaitRecord;
}

/** One wait per (repo, kind, subject): a newer push for the same PR replaces the older wait. */
export function waitKey(w: Pick<WaitRecord, "repository" | "kind" | "pr" | "checkSha">): string {
  const subject = w.kind === "pull_request" && w.pr !== undefined ? `pr${w.pr}` : w.checkSha;
  return `${w.repository}|${w.kind}|${subject}`;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Payloads above this are not kept; GitHub's own are a few tens of KB. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "superseded", "failed"]);

function safe(seg: string, what: string): string {
  if (!SEGMENT.test(seg) || seg.startsWith(".")) throw new Error(`unsafe ${what} ${seg}`);
  return seg;
}

export class JobJournal implements WaitStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // --- WaitStore: a wait is a job file in status "waiting" under `<repo>/wait-<hash>.json` ---

  private waitFile(key: string): string {
    const [repository] = key.split("|", 1);
    const h = createHash("sha256").update(key).digest("hex").slice(0, 24);
    return this.file(repository ?? "", `wait-${h}`);
  }

  async putWait(key: string, wait: WaitRecord): Promise<void> {
    const file = this.waitFile(key);
    const rec: JobRecord = {
      delivery: `wait-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
      repository: wait.repository,
      event: wait.kind,
      status: "waiting",
      generation: 0,
      receivedAt: wait.startedAt,
      replayable: false,
      wait,
    };
    await withFileLock(file, () => this.write(file, rec));
  }

  async listWaits(): Promise<Array<{ key: string; wait: WaitRecord }>> {
    const out: Array<{ key: string; wait: WaitRecord }> = [];
    for (const file of await this.files()) {
      try {
        const rec = JSON.parse(await readFile(file, "utf8")) as JobRecord;
        if (rec.status === "waiting" && rec.wait) out.push({ key: waitKey(rec.wait), wait: rec.wait });
      } catch {
        // torn write; ignore
      }
    }
    return out.sort((a, b) => a.wait.startedAt.localeCompare(b.wait.startedAt));
  }

  async clearWait(key: string): Promise<void> {
    const file = this.waitFile(key);
    await withFileLock(file, async () => {
      let rec: JobRecord;
      try {
        rec = JSON.parse(await readFile(file, "utf8")) as JobRecord;
      } catch {
        return;
      }
      rec.status = "done";
      rec.finishedAt = this.now().toISOString();
      delete rec.wait;
      await this.write(file, rec);
    });
  }

  private file(repository: string, delivery: string): string {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`unsafe repository ${repository}`);
    return join(this.dir, safe(owner, "owner"), safe(repo, "repo"), `${safe(delivery, "delivery")}.json`);
  }

  private async write(file: string, rec: JobRecord): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(rec));
    await rename(tmp, file);
  }

  /** Records a delivery as queued; the payload is kept when it is small enough to replay. */
  async enqueue(repository: string, delivery: string, event: string, payload: unknown, generation: number): Promise<JobRecord> {
    const text = JSON.stringify(payload);
    const replayable = Buffer.byteLength(text) <= MAX_PAYLOAD_BYTES;
    const rec: JobRecord = {
      delivery,
      repository,
      event,
      status: "queued",
      generation,
      receivedAt: this.now().toISOString(),
      ...(replayable ? { payload } : {}),
      replayable,
    };
    const file = this.file(repository, delivery);
    await withFileLock(file, () => this.write(file, rec));
    return rec;
  }

  async update(repository: string, delivery: string, status: JobStatus, note?: string): Promise<void> {
    const file = this.file(repository, delivery);
    await withFileLock(file, async () => {
      let rec: JobRecord;
      try {
        rec = JSON.parse(await readFile(file, "utf8")) as JobRecord;
      } catch {
        return; // never journaled (no delivery id) or already pruned
      }
      const at = this.now().toISOString();
      rec.status = status;
      if (status === "running") rec.startedAt = at;
      if (TERMINAL.has(status)) rec.finishedAt = at;
      // A finished job has nothing to replay; a parked one is re-armed from its wait record, not its payload.
      if (TERMINAL.has(status) || status === "waiting") delete rec.payload;
      if (note) rec.note = note;
      await this.write(file, rec);
    });
  }

  /** Jobs that were queued or running when the process last stopped. */
  async pending(): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    for (const file of await this.files()) {
      try {
        const rec = JSON.parse(await readFile(file, "utf8")) as JobRecord;
        if (rec.status === "queued" || rec.status === "running") out.push(rec);
      } catch {
        // a torn write of a job file: ignore it rather than crash startup
      }
    }
    return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** Removes terminal records older than `maxAgeMs`, keeping at most `keep` per repository. */
  async prune(maxAgeMs: number, keep = 1000): Promise<number> {
    let removed = 0;
    const cutoff = this.now().getTime() - maxAgeMs;
    const byRepo = new Map<string, Array<{ file: string; at: number }>>();
    for (const file of await this.files()) {
      try {
        const rec = JSON.parse(await readFile(file, "utf8")) as JobRecord;
        if (!TERMINAL.has(rec.status)) continue;
        const at = Date.parse(rec.finishedAt ?? rec.receivedAt);
        byRepo.set(rec.repository, [...(byRepo.get(rec.repository) ?? []), { file, at }]);
      } catch {
        const s = await stat(file).catch(() => null);
        if (s && s.mtimeMs < cutoff) {
          await rm(file, { force: true });
          removed++;
        }
      }
    }
    for (const list of byRepo.values()) {
      list.sort((a, b) => b.at - a.at);
      for (const [i, e] of list.entries()) {
        if (i >= keep || e.at < cutoff) {
          await rm(e.file, { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private async files(): Promise<string[]> {
    const out: string[] = [];
    const owners = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const o of owners) {
      if (!o.isDirectory()) continue;
      const repos = await readdir(join(this.dir, o.name), { withFileTypes: true }).catch(() => []);
      for (const r of repos) {
        if (!r.isDirectory()) continue;
        const files = await readdir(join(this.dir, o.name, r.name)).catch(() => []);
        for (const f of files) if (f.endsWith(".json")) out.push(join(this.dir, o.name, r.name, f));
      }
    }
    return out;
  }
}

/** Seen-delivery keys (delivery id and sha256 of the signed body), bounded and persisted. */
export interface DeliveryStore {
  has(key: string): Promise<boolean>;
  add(keys: readonly string[]): Promise<void>;
}

export class MemoryDeliveryStore implements DeliveryStore {
  private readonly seen: string[] = [];
  constructor(private readonly limit = 10_000) {}
  async has(key: string): Promise<boolean> {
    return this.seen.includes(key);
  }
  async add(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      this.seen.push(k);
      if (this.seen.length > this.limit) this.seen.shift();
    }
  }
}

/** Append-only `deliveries.log`, one key per line, compacted to the newest `limit` keys when it doubles. */
export class FileDeliveryStore implements DeliveryStore {
  private keys: string[] | null = null;
  private readonly set = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly limit = 10_000,
  ) {}

  private async load(): Promise<void> {
    if (this.keys) return;
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.keys = text.split("\n").filter(Boolean).slice(-this.limit);
    for (const k of this.keys) this.set.add(k);
  }

  async has(key: string): Promise<boolean> {
    await this.load();
    return this.set.has(key);
  }

  async add(keys: readonly string[]): Promise<void> {
    await withFileLock(this.file, async () => {
      await this.load();
      const fresh = keys.filter((k) => !this.set.has(k) && !k.includes("\n"));
      if (fresh.length === 0) return;
      for (const k of fresh) {
        this.keys!.push(k);
        this.set.add(k);
      }
      await mkdir(join(this.file, ".."), { recursive: true });
      if (this.keys!.length > this.limit * 2) {
        this.keys = this.keys!.slice(-this.limit);
        this.set.clear();
        for (const k of this.keys) this.set.add(k);
        const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${this.keys.join("\n")}\n`);
        await rename(tmp, this.file);
      } else {
        await writeFile(this.file, `${fresh.join("\n")}\n`, { flag: "a" });
      }
    });
  }
}
