/*
 * Minimal ZIP reader — just enough to pull one named entry out of an Office
 * file (.docx / .pptx are ZIP archives of XML). Avoids adding a zip dependency.
 *
 * Walks the central directory from the End-Of-Central-Directory record and
 * inflates the matching entry (method 8 = deflate, 0 = stored). Returns the
 * entry's text or null when absent/unreadable.
 */
import zlib from "node:zlib";

export function zlibSync(buffer, entryName) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    // Find EOCD (signature 0x06054b50) scanning backwards over the comment.
    let eocd = -1;
    const min = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= min; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16); // central directory offset
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) return null; // central dir entry sig
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
      if (name === entryName) {
        // Local header: sizes of name/extra can differ from the central copy.
        if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataStart, dataStart + compSize);
        if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
        if (method === 0) return data.toString("utf8");
        return null; // unsupported compression
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  }
}
