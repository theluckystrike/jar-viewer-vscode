'use strict';
// Bounded byte sources. Every read checks its range, so a hostile offset can never read outside the file, and a
// file is never loaded whole: FileSource keeps a small cache of 64 KB blocks.
const fs = require('fs');

const BLOCK = 64 * 1024;
const MAX_BLOCKS = 64;

class FileSource {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.cache = new Map();
  }
  block(k) {
    let b = this.cache.get(k);
    if (b) return b;
    const start = k * BLOCK;
    const len = Math.min(BLOCK, this.size - start);
    b = Buffer.alloc(Math.max(0, len));
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, b, got, len - got, start + got);
      if (!n) break;
      got += n;
    }
    if (this.cache.size >= MAX_BLOCKS) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(k, b);
    return b;
  }
  /** Up to `length` bytes at `offset` (fewer at the end of the file). */
  read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size || length <= 0) return Buffer.alloc(0);
    const end = Math.min(this.size, offset + length);
    if (end - offset > BLOCK * 4) {
      const out = Buffer.alloc(end - offset);
      let got = 0;
      while (got < out.length) {
        const n = fs.readSync(this.fd, out, got, out.length - got, offset + got);
        if (!n) break;
        got += n;
      }
      return out.subarray(0, got);
    }
    const k0 = Math.floor(offset / BLOCK), k1 = Math.floor((end - 1) / BLOCK);
    if (k0 === k1) { const b = this.block(k0); return b.subarray(offset - k0 * BLOCK, end - k0 * BLOCK); }
    const parts = [];
    for (let k = k0; k <= k1; k++) {
      const b = this.block(k);
      const s = k === k0 ? offset - k * BLOCK : 0;
      const e = k === k1 ? end - k * BLOCK : b.length;
      parts.push(b.subarray(s, e));
    }
    return Buffer.concat(parts);
  }
  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = null; } }
}

class BufferSource {
  constructor(bytes) {
    this.bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength === undefined ? undefined : bytes.byteLength);
    this.size = this.bytes.length;
  }
  read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size || length <= 0) return Buffer.alloc(0);
    return this.bytes.subarray(offset, Math.min(this.size, offset + length));
  }
  close() {}
}

module.exports = { FileSource, BufferSource, BLOCK };
