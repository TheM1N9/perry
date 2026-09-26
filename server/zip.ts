import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * Reads a .zip, as `npx convex export` writes it, with Node's own zlib: the
 * central directory at the end lists every entry, stored or deflated, with
 * zip64 sizes. Enough for importing an export; encrypted zips are not read.
 */

export type ZipEntry = { name: string; read(): Buffer };

export function readZip(path: string): ZipEntry[] {
  const data = readFileSync(path);
  // The end-of-central-directory record: signature 0x06054b50, within the last 64 KB.
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error(`${path} is not a zip file.`);
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("This export is too large to read here.");

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("The zip's directory is damaged.");
    const method = data.readUInt16LE(at + 10);
    let compressed = data.readUInt32LE(at + 20);
    let uncompressed = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    let local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    // Zip64 (Convex writes it even for small exports): a size or offset of 0xFFFFFFFF
    // is in the extra field 0x0001 instead, as 8-byte values, in this order.
    for (let extra = at + 46 + nameLength; extra + 4 <= at + 46 + nameLength + extraLength;) {
      const id = data.readUInt16LE(extra);
      const size = data.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(data.readBigUInt64LE(field)); field += 8; }
        if (compressed === 0xffffffff) { compressed = Number(data.readBigUInt64LE(field)); field += 8; }
        if (local === 0xffffffff) { local = Number(data.readBigUInt64LE(field)); field += 8; }
      }
      extra += 4 + size;
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      read() {
        if (data.readUInt32LE(local) !== 0x04034b50) throw new Error(`The zip entry ${name} is damaged.`);
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const raw = data.subarray(start, start + compressed);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`The zip entry ${name} uses compression method ${method}, which is not supported.`);
      },
    });
  }
  return entries;
}
