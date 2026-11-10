'use strict';
// Size and count limits against zip bombs and hostile class files, and the path checks against zip slip.
// checkEntryName and joinInside come from the Zovo ZIP Explorer (archive-explorer-vscode, src/core/limits.js).
const MB = 1024 * 1024;
const LIMITS = Object.freeze({
  maxEntries: 200000, // central directory entries read
  maxEntryBytes: 64 * MB, // one unpacked entry (a class, a resource, a nested JAR)
  maxRatio: 1000, // unpacked size / packed size above this is refused as a zip bomb (for entries over 1 MB)
  maxClassBytes: 16 * MB, // one class file
  maxNestedBytes: 128 * MB, // a nested JAR read into memory
  maxScanClasses: 50000, // classes whose Java version is read for the overview
  scanMs: 6000,
  maxTextBytes: 2 * MB, // resource text shown
});

class LimitError extends Error {
  constructor(message, code) { super(message); this.name = 'LimitError'; this.code = code || 'LIMIT'; }
}

function fmtSize(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
const fmtCount = (n) => Number(n).toLocaleString('en-US');

/**
 * Checks one entry name. Returns { path, unsafe }: path is a clean relative display path with "/" separators,
 * unsafe is a reason string for names that try to leave the target folder (zip slip), or null.
 */
function checkEntryName(raw) {
  const s = String(raw == null ? '' : raw);
  let unsafe = null;
  if (s.includes('\0')) unsafe = 'The name contains a NUL character.';
  const slashed = s.replace(/\\/g, '/');
  if (/^\/|^[a-zA-Z]:/.test(slashed)) unsafe = unsafe || 'The name is an absolute path.';
  const parts = [];
  for (const p of slashed.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { unsafe = unsafe || 'The name contains "..", which would write outside the target folder.'; continue; }
    parts.push(p.replace(/\0/g, ''));
  }
  if (!unsafe && /[\x00-\x1f\x7f]/.test(parts.join('/'))) unsafe = 'The name contains control characters.';
  return { path: parts.join('/'), unsafe };
}

/** Joins a checked relative path onto a folder and proves the result stays inside it; null when it would escape. */
function joinInside(targetDir, rel) {
  const path = require('path');
  const base = path.resolve(targetDir);
  const c = checkEntryName(rel);
  if (c.unsafe || !c.path) return null;
  if (c.path.split('/').some((p) => /[<>:"|?*]/.test(p) || /[. ]$/.test(p))) return null;
  const out = path.resolve(base, ...c.path.split('/'));
  return out.startsWith(base + path.sep) ? out : null;
}

module.exports = { MB, LIMITS, LimitError, fmtSize, fmtCount, checkEntryName, joinInside };
