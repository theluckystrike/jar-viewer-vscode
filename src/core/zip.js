'use strict';
// ZIP central directory reader for JAR, WAR, EAR and AAR files, adapted from the Zovo ZIP Explorer
// (archive-explorer-vscode, src/core/zip.js). It reads the end of the file and the central directory only; an
// entry's data is read when it is needed. Unpacking uses Node's zlib with a hard output cap (zip bombs stop there).
const zlib = require('zlib');
const { checkEntryName, LimitError, LIMITS, fmtSize, fmtCount } = require('./limits');
const { crc32 } = require('./crc32');

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
const METHODS = { 0: 'Stored', 8: 'Deflate', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 99: 'AES' };

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');

function decodeName(bytes, isUtf8) {
  if (isUtf8) return utf8Loose.decode(bytes);
  let ascii = true;
  for (const b of bytes) if (b > 0x7f) { ascii = false; break; }
  if (ascii) return Buffer.from(bytes).toString('latin1');
  try { return utf8.decode(bytes); } catch { /* not UTF-8: the old DOS code page */ }
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  return s;
}

function dosTime(time, date) {
  if (!date) return 0;
  const t = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
  return Number.isFinite(t) ? t : 0;
}

const u16 = (b, o) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
const u32 = (b, o) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

class ZipFormatError extends Error { constructor(m) { super(m); this.code = 'ZIP'; } }

function findEnd(src) {
  const tail = Math.min(src.size, 22 + 65535 + 20);
  const start = src.size - tail;
  const b = src.read(start, tail);
  for (let i = b.length - 22; i >= 0; i--) {
    if (u32(b, i) === SIG_EOCD && i + 22 + u16(b, i + 20) <= b.length) return { pos: start + i, b, i };
  }
  return null;
}

/** Reads the entry list: { zip64, comment, entries, problems, prefix }. */
function readZip(src, opts = {}) {
  const maxEntries = opts.maxEntries || LIMITS.maxEntries;
  if (src.size < 22) throw new ZipFormatError('This file is too small to be a JAR (ZIP) archive.');
  const end = findEnd(src);
  if (!end) throw new ZipFormatError('This is not a JAR (ZIP) archive: the end-of-archive record is missing. The file may be cut short.');
  const { b, i } = end;
  let count = u16(b, i + 10), cdSize = u32(b, i + 12), cdOffset = u32(b, i + 16);
  const comment = decodeName(b.subarray(i + 22, i + 22 + u16(b, i + 20)), true);
  let zip64 = false;
  if (end.pos >= 20) {
    const loc = src.read(end.pos - 20, 20);
    if (u32(loc, 0) === SIG_Z64_LOC) {
      const rec = src.read(u64(loc, 8), 56);
      if (rec.length === 56 && u32(rec, 0) === SIG_Z64_EOCD) { zip64 = true; count = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48); }
    }
  }
  if (count > maxEntries) throw new LimitError(`This archive lists ${fmtCount(count)} entries. JAR Viewer reads up to ${fmtCount(maxEntries)}.`, 'ENTRIES');
  const cdEnd = zip64 ? end.pos - 20 - 56 : end.pos;
  let prefix = 0;
  if (!zip64 && cdOffset + cdSize < cdEnd && count > 0) prefix = cdEnd - (cdOffset + cdSize);
  if (cdSize > 256 * 1024 * 1024) throw new LimitError(`The central directory is ${fmtSize(cdSize)}, which is too large to read.`, 'ENTRIES');
  if (cdOffset + prefix + cdSize > src.size) throw new ZipFormatError('The central directory runs past the end of the file. The archive is cut short.');
  const cd = src.read(cdOffset + prefix, cdSize);
  const entries = [];
  const problems = [];
  let p = 0;
  for (let n = 0; n < count || (count === 0xffff && p < cd.length); n++) {
    if (p + 46 > cd.length || u32(cd, p) !== SIG_CEN) {
      if (n < count) problems.push(`The central directory ends after ${fmtCount(n)} of ${fmtCount(count)} entries. The archive may be damaged.`);
      break;
    }
    if (entries.length >= maxEntries) throw new LimitError(`This archive has more than ${fmtCount(maxEntries)} entries.`, 'ENTRIES');
    const madeBy = u16(cd, p + 4), flags = u16(cd, p + 8), method = u16(cd, p + 10);
    const time = u16(cd, p + 12), date = u16(cd, p + 14), crc = u32(cd, p + 16);
    let packed = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const extAttr = u32(cd, p + 38);
    let offset = u32(cd, p + 42);
    const raw0 = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    let raw = raw0;
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    let mtime = dosTime(time, date);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = u16(extra, e), len = u16(extra, e + 2), d = extra.subarray(e + 4, e + 4 + len);
      if (id === 0x0001) {
        let q = 0;
        if (size === 0xffffffff && q + 8 <= d.length) { size = u64(d, q); q += 8; }
        if (packed === 0xffffffff && q + 8 <= d.length) { packed = u64(d, q); q += 8; }
        if (offset === 0xffffffff && q + 8 <= d.length) { offset = u64(d, q); q += 8; }
      } else if (id === 0x7075 && len > 5 && d[0] === 1) raw = utf8Loose.decode(d.subarray(5));
      else if (id === 0x5455 && len >= 5 && (d[0] & 1)) mtime = u32(d, 1) * 1000;
      e += 4 + len;
    }
    const mode = (madeBy >> 8) === 3 ? extAttr >>> 16 : 0;
    const dir = raw.endsWith('/') || raw.endsWith('\\') || (mode & 0xf000) === 0x4000;
    const chk = checkEntryName(raw);
    entries.push({
      path: chk.path, raw, unsafe: chk.unsafe, dir, size, packed, method, methodName: METHODS[method] || `method ${method}`, crc, mtime,
      encrypted: (flags & 1) !== 0, offset: offset + prefix, supported: dir || method === 0 || method === 8,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { zip64, comment, entries, problems, prefix };
}

function dataStart(src, entry) {
  const h = src.read(entry.offset, 30);
  if (h.length < 30 || u32(h, 0) !== SIG_LOC) throw new ZipFormatError(`The local header of "${entry.path}" is missing. The archive may be damaged.`);
  const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
  if (start + entry.packed > src.size) throw new ZipFormatError(`"${entry.path}" runs past the end of the file. The archive is cut short.`);
  return start;
}

function checkReadable(entry, limit) {
  if (entry.encrypted) throw new ZipFormatError(`"${entry.path}" is encrypted.`);
  if (!entry.supported) throw new ZipFormatError(`"${entry.path}" uses ${entry.methodName} compression. JAR files use Stored or Deflate.`);
  if (entry.size > limit) throw new LimitError(`"${entry.path}" is ${fmtSize(entry.size)} unpacked; the limit is ${fmtSize(limit)}.`, 'SIZE');
  if (entry.method === 8 && entry.size > 1024 * 1024 && entry.size / Math.max(1, entry.packed) > LIMITS.maxRatio) {
    throw new LimitError(`"${entry.path}" would unpack ${fmtSize(entry.packed)} into ${fmtSize(entry.size)} (ratio over ${LIMITS.maxRatio}:1). It was not unpacked: it looks like a zip bomb.`, 'BOMB');
  }
}

/** Reads and unpacks one entry, at most `limit` bytes. Checks the size and the CRC. */
function readEntry(src, entry, limit = LIMITS.maxEntryBytes) {
  if (entry.dir) return Buffer.alloc(0);
  checkReadable(entry, limit);
  const data = src.read(dataStart(src, entry), entry.packed);
  let out;
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new ZipFormatError(`"${entry.path}" has a stored size that does not match its header.`);
    out = data;
  } else {
    try { out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) }); } catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw new LimitError(`"${entry.path}" unpacks to more than the ${fmtSize(entry.size)} its header says. It was stopped as a possible zip bomb.`, 'BOMB');
      throw new ZipFormatError(`"${entry.path}" could not be unpacked: ${e.message}`);
    }
    if (out.length !== entry.size) throw new ZipFormatError(`"${entry.path}" unpacked to ${out.length} bytes, but its header says ${entry.size}. The entry is damaged.`);
  }
  if (crc32(out) !== entry.crc) throw new ZipFormatError(`"${entry.path}" failed its CRC check. The entry is damaged.`);
  return out;
}

/** The first `n` bytes of an entry without unpacking all of it (for the class version scan). */
function readHead(src, entry, n) {
  if (entry.dir || entry.encrypted || !entry.supported || entry.size === 0) return Buffer.alloc(0);
  const start = dataStart(src, entry);
  if (entry.method === 0) return src.read(start, Math.min(n, entry.packed));
  const data = src.read(start, Math.min(entry.packed, 256));
  try {
    const out = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 1 << 19 });
    return out.subarray(0, n);
  } catch { return Buffer.alloc(0); }
}

module.exports = { readZip, readEntry, readHead, decodeName, ZipFormatError, METHODS };
