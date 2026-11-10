'use strict';
// The JAR model: entries grouped by package, classes with their Java version, resources, MANIFEST.MF, nested JARs
// (Spring Boot BOOT-INF/lib, WAR WEB-INF/lib, AAR classes.jar), multi-release versions and module-info.
const { readZip, readEntry, readHead } = require('./zip');
const { classVersion, javaVersion, parseClass } = require('./classfile');
const { BufferSource } = require('./source');
const { LIMITS, LimitError, fmtSize } = require('./limits');

const NESTED_RE = /\.(jar|war|ear|aar|zip)$/i;
const CLASS_ROOTS = /^(BOOT-INF\/classes\/|WEB-INF\/classes\/|META-INF\/versions\/\d+\/)/;

function formatOf(name) {
  const m = /\.(jar|war|ear|aar|jmod|zip)$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'JAR';
}

/** MANIFEST.MF text -> { main: [[key, value]], sections: n, text }. Continuation lines start with one space. */
function parseManifest(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const sections = [[]];
  for (const line of lines) {
    if (line === '') { if (sections[sections.length - 1].length) sections.push([]); continue; }
    const cur = sections[sections.length - 1];
    if (line.startsWith(' ') && cur.length) { cur[cur.length - 1][1] += line.slice(1); continue; }
    const i = line.indexOf(':');
    if (i > 0) cur.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  const main = sections[0] || [];
  return { main: main.slice(0, 500), sections: sections.filter((s) => s.length).length - 1, text: String(text).slice(0, LIMITS.maxTextBytes) };
}

/** Class name of a class entry: com/x/Y.class -> com.x.Y, with BOOT-INF/classes and versions prefixes removed. */
function classNameOf(p) {
  return p.replace(CLASS_ROOTS, '').replace(/\.class$/, '').replace(/\//g, '.');
}

function openZip(src) {
  const zip = readZip(src);
  const byPath = new Map();
  for (const e of zip.entries) if (!byPath.has(e.path)) byPath.set(e.path, e);
  return { src, zip, byPath };
}

/** Opens a nested JAR (one level) as an in-memory source. */
function openNested(outer, path) {
  const e = outer.byPath.get(path);
  if (!e || e.dir) throw new Error(`"${path}" is not in this archive.`);
  if (e.size > LIMITS.maxNestedBytes) throw new LimitError(`The nested archive "${path}" is ${fmtSize(e.size)}; nested archives are read up to ${fmtSize(LIMITS.maxNestedBytes)}.`, 'SIZE');
  const data = readEntry(outer.src, e, LIMITS.maxNestedBytes);
  return openZip(new BufferSource(data));
}

/** Builds the model the viewer shows. opts: { name, nestedIn } */
function jarModel(j, opts = {}) {
  const started = Date.now();
  const { zip } = j;
  const entries = [];
  const versions = new Map();
  let classes = 0, resources = 0, scanned = 0, scanStopped = false, unsafe = 0, multiRelease = false, moduleName = '';
  const nested = [];
  const pkgs = new Set();
  let manifest = null;
  for (const e of zip.entries) {
    if (e.dir) continue;
    const row = { p: e.path, s: e.size, c: e.packed, k: 'res' };
    if (e.unsafe) { row.u = e.unsafe; unsafe++; }
    if (e.encrypted) row.x = 'encrypted';
    else if (!e.supported) row.x = e.methodName;
    if (/\.class$/i.test(e.path)) {
      row.k = 'class'; classes++;
      const name = classNameOf(e.path);
      const dot = name.lastIndexOf('.');
      pkgs.add(dot > 0 ? name.slice(0, dot) : '');
      if (/^META-INF\/versions\/\d+\//.test(e.path)) multiRelease = true;
      if (scanned < LIMITS.maxScanClasses && !scanStopped && !row.x) {
        if (Date.now() - started > LIMITS.scanMs) scanStopped = true;
        else {
          scanned++;
          let v = null;
          try { v = classVersion(readHead(j.src, e, 8)); } catch { v = null; }
          if (v) { row.v = v.major; const k = javaVersion(v.major, v.minor); versions.set(k, (versions.get(k) || 0) + 1); }
        }
      }
    } else if (NESTED_RE.test(e.path) && e.size > 0) { row.k = 'jar'; nested.push(e.path); resources++; } else resources++;
    if (e.path.toUpperCase() === 'META-INF/MANIFEST.MF') {
      row.k = 'manifest';
      try { manifest = parseManifest(readEntry(j.src, e, LIMITS.maxTextBytes).toString('utf8')); } catch (err) { manifest = { main: [], sections: 0, text: '', error: err.message }; }
    }
    entries.push(row);
  }
  const mi = j.byPath.get('module-info.class') || [...j.byPath.keys()].map((k) => (/^META-INF\/versions\/\d+\/module-info\.class$/.test(k) ? j.byPath.get(k) : null)).find(Boolean);
  if (mi) {
    try { const c = parseClass(readEntry(j.src, mi, LIMITS.maxClassBytes), { maxMs: 2000 }); moduleName = c.module || ''; } catch { moduleName = ''; }
  }
  const sortedVersions = [...versions.entries()].sort((a, b) => b[1] - a[1]);
  let highest = 0;
  for (const r of entries) if (r.v && r.v > highest && r.v <= 120) highest = r.v;
  const mainAttr = (k) => (manifest && manifest.main.find(([x]) => x.toLowerCase() === k.toLowerCase()) || [])[1] || '';
  const problems = zip.problems.slice();
  if (unsafe) problems.push(`${unsafe} entr${unsafe === 1 ? 'y has a name' : 'ies have names'} that would write outside a folder (".." or an absolute path). They are listed but never written to disk.`);
  if (scanStopped) problems.push(`The Java version was read for ${scanned.toLocaleString('en-US')} of ${classes.toLocaleString('en-US')} classes (time limit). Open a class to see its version.`);
  return {
    kind: 'jar', name: opts.name || '', format: formatOf(opts.name), nestedIn: opts.nestedIn || '', size: j.src.size, comment: zip.comment.slice(0, 2000),
    entries, classes, resources, packages: pkgs.size, manifest, versions: sortedVersions, highest: highest ? javaVersion(highest) : '',
    mainClass: mainAttr('Main-Class'), startClass: mainAttr('Start-Class'), createdBy: mainAttr('Created-By') || mainAttr('Build-Jdk-Spec') || mainAttr('Build-Jdk'),
    title: mainAttr('Implementation-Title') || mainAttr('Bundle-Name') || mainAttr('Specification-Title'), version: mainAttr('Implementation-Version') || mainAttr('Bundle-Version'),
    multiRelease: multiRelease || /true/i.test(mainAttr('Multi-Release')), module: moduleName || mainAttr('Automatic-Module-Name'),
    nested, zip64: zip.zip64, problems, scanned,
  };
}

/** Reads one entry (class or resource) of a JAR. */
function entryBytes(j, path, limit) {
  const e = j.byPath.get(path);
  if (!e || e.dir) throw new Error(`"${path}" is not in this archive.`);
  return readEntry(j.src, e, limit);
}

/** Text of a resource, or a short hex preview for binary data. */
function resourceView(j, path) {
  const e = j.byPath.get(path);
  if (!e || e.dir) throw new Error(`"${path}" is not in this archive.`);
  const limit = Math.min(e.size, LIMITS.maxTextBytes);
  const data = e.size > LIMITS.maxTextBytes ? null : readEntry(j.src, e, LIMITS.maxTextBytes);
  if (!data) return { path, size: e.size, binary: true, text: '', note: `This entry is ${fmtSize(e.size)}; text is shown up to ${fmtSize(LIMITS.maxTextBytes)}.` };
  let ctrl = 0;
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) { const b = data[i]; if (b === 0) { ctrl = n; break; } if (b < 9 || (b > 13 && b < 32)) ctrl++; }
  if (ctrl > n / 20) {
    const lines = [];
    for (let o = 0; o < Math.min(data.length, 4096); o += 16) {
      const row = data.subarray(o, o + 16);
      lines.push(`${o.toString(16).padStart(8, '0')}  ${Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
    }
    return { path, size: e.size, binary: true, text: lines.join('\n'), note: `Binary data, ${fmtSize(e.size)}. The first ${fmtSize(Math.min(data.length, 4096))} are shown.` };
  }
  return { path, size: e.size, binary: false, text: data.subarray(0, limit).toString('utf8') };
}

/** The outer class of an entry and its inner classes (Outer$*.class next to it), for decompiling. */
function classGroup(j, path) {
  const base = path.replace(/\.class$/, '');
  const outer = base.replace(/\$.*$/, '');
  const list = [];
  for (const p of j.byPath.keys()) {
    if (p === `${outer}.class` || (p.startsWith(`${outer}$`) && p.endsWith('.class'))) list.push(p);
    if (list.length > 2000) break;
  }
  return { outer: `${outer}.class`, list };
}

module.exports = { openZip, openNested, jarModel, entryBytes, resourceView, classGroup, classNameOf, parseManifest, formatOf, NESTED_RE };
