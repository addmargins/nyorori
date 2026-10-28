// Durable half of the evaluation queue: every accepted delivery is written to
// `jobs/<owner>/<repo>/<delivery>.json` before and while it runs, so a service
// restart can re-enqueue what was queued or running (the job re-reads all
// state from GitHub; nothing from the journal is trusted beyond the event).
// The delivery dedupe set is persisted next to it.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./lock.js";

export type JobStatus = "queued" | "running" | "done" | "superseded" | "failed";

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
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Payloads above this are not kept; GitHub's own are a few tens of KB. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "superseded", "failed"]);

function safe(seg: string, what: string): string {
  if (!SEGMENT.test(seg) || seg.startsWith(".")) throw new Error(`unsafe ${what} ${seg}`);
  return seg;
}

export class JobJournal {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      if (TERMINAL.has(status)) {
        rec.finishedAt = at;
        delete rec.payload; // nothing left to replay
      }
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
