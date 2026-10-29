// Minimal ZIP reader for GitHub Actions artifacts (stored and deflate entries,
// central directory only). Artifacts are produced by PR-executing jobs, so
// the archive is hostile input: every size, count, offset and ratio is
// bounded before anything is inflated, and only whitelisted entries are read.
// No zip64: artifacts larger than 4 GiB are refused.

import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipLimits {
  /** Archive size accepted at all (the download is capped to this too). */
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  /** Sum of inflated sizes of the entries actually read. */
  maxTotalBytes: number;
  /** Inflated/compressed ratio above which an entry is treated as a bomb. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 200,
};

/** Any violation of the archive limits or structure; callers map it to INCONCLUSIVE(UNTRUSTED_ARTIFACT). */
export class ZipError extends Error {}

function u16(buf: Buffer, at: number): number {
  if (at < 0 || at + 2 > buf.length) throw new ZipError("zip structure points outside the archive");
  return buf.readUInt16LE(at);
}

function u32(buf: Buffer, at: number): number {
  if (at < 0 || at + 4 > buf.length) throw new ZipError("zip structure points outside the archive");
  return buf.readUInt32LE(at);
}

/**
 * Reads the entries whose names `want` accepts. Other entries are still
 * range-checked (overlap and bounds) but never inflated.
 */
export function readZip(
  buf: Buffer,
  want: (name: string) => boolean = () => true,
  limits: Partial<ZipLimits> = {},
): Map<string, Buffer> {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  if (buf.length > lim.maxArchiveBytes) throw new ZipError(`artifact archive exceeds ${lim.maxArchiveBytes} bytes`);
  if (buf.length < 22) throw new ZipError("not a zip archive");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const count = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (count > lim.maxEntries) throw new ZipError(`artifact has ${count} entries (limit ${lim.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipError("zip central directory overlaps the end record");

  interface Entry { name: string; method: number; compSize: number; size: number; dataStart: number; dataEnd: number; localStart: number }
  const entries: Entry[] = [];
  const names = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || u32(buf, p) !== CENTRAL) throw new ZipError("corrupt zip central directory");
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localStart = u32(buf, p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipError("zip structure points outside the archive");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ZipError(`zip entry ${name} is encrypted`);
    if (compSize === 0xffffffff || size === 0xffffffff) throw new ZipError("zip64 archives are not accepted");
    if (names.has(name)) throw new ZipError(`duplicate zip entry ${name}`);
    names.add(name);
    if (u32(buf, localStart) !== LOCAL) throw new ZipError("corrupt zip local header");
    const dataStart = localStart + 30 + u16(buf, localStart + 26) + u16(buf, localStart + 28);
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) throw new ZipError(`zip entry ${name} runs into the central directory`);
    entries.push({ name, method, compSize, size, dataStart, dataEnd, localStart });
  }
  // Overlapping entries are how "quines" and many-entry bombs reuse one payload.
  const sorted = [...entries].sort((a, b) => a.localStart - b.localStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.localStart < sorted[i - 1]!.dataEnd) throw new ZipError("overlapping zip entries");
  }

  const out = new Map<string, Buffer>();
  let total = 0;
  for (const e of entries) {
    if (e.name.endsWith("/") || !want(e.name)) continue;
    if (e.size > lim.maxEntryBytes) throw new ZipError(`zip entry ${e.name} is too large`);
    if (e.compSize > 0 && e.size / e.compSize > lim.maxRatio) throw new ZipError(`zip entry ${e.name} has a suspicious compression ratio`);
    total += e.size;
    if (total > lim.maxTotalBytes) throw new ZipError(`artifact inflates beyond ${lim.maxTotalBytes} bytes`);
    const data = buf.subarray(e.dataStart, e.dataEnd);
    let content: Buffer;
    if (e.method === 0) {
      content = Buffer.from(data);
    } else if (e.method === 8) {
      try {
        // The declared size is the hard ceiling: a lying header cannot inflate further.
        content = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
      } catch (err) {
        throw new ZipError(`zip entry ${e.name} does not inflate to its declared size: ${(err as Error).message}`);
      }
    } else {
      throw new ZipError(`unsupported zip compression method ${e.method} for ${e.name}`);
    }
    if (content.length !== e.size) throw new ZipError(`zip entry ${e.name} has the wrong size`);
    out.set(e.name, content);
  }
  return out;
}

/**
 * A stored (uncompressed) archive of the given entries, for re-packing
 * evidence that arrived in several trusted runs into the single archive the
 * analysis worker reads. Entry names must already have passed `readZip`.
 */
export function writeStoredZip(entries: ReadonlyMap<string, Buffer>): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
