// Minimal ZIP reader for GitHub Actions artifacts (stored and deflate entries,
// central directory only). No zip64: artifacts larger than 4 GiB are refused.

import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buf: Buffer, maxEntryBytes = 64 * 1024 * 1024): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (size > maxEntryBytes || compSize === 0xffffffff) throw new Error(`zip entry ${name} is too large`);
    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error("corrupt zip local header");
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (content.length !== size) throw new Error(`zip entry ${name} has the wrong size`);
    out.set(name, content);
  }
  return out;
}
