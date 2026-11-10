'use strict';
// The cores of the Pro tools, without vscode: compare two JARs, find a class, method or string in many JARs.
const J = require('./jar');
const { parseClass } = require('./classfile');
const { LIMITS } = require('./limits');

function matcher(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const re = /^\/(.{1,200})\/([imsu]*)$/.exec(q);
  if (re) {
    // No nested quantifiers: they can take exponential time on long names.
    if (/\([^)]*[+*}][^)]*\)[+*{]/.test(re[1])) throw new Error('This pattern has a repeated group inside a repeat; please write it without nesting.');
    const rx = new RegExp(re[1], re[2]);
    return { test: (s) => s.length <= 4096 && rx.test(s), label: q, plain: null };
  }
  const low = q.toLowerCase();
  return { test: (s) => s.toLowerCase().includes(low), label: q, plain: q };
}

/** Summary of every class of a JAR for comparing: Map(class name -> { java, decl, fields:Set, methods:Set, crc }). */
function classSummaries(j, { maxMs = 60000, onProgress } = {}) {
  const started = Date.now();
  const out = new Map();
  const problems = [];
  const list = j.zip.entries.filter((e) => !e.dir && /\.class$/i.test(e.path) && !/^META-INF\/versions\//.test(e.path));
  let i = 0;
  for (const e of list) {
    if (Date.now() - started > maxMs) { problems.push(`Stopped after ${i} of ${list.length} classes (time limit).`); break; }
    if (onProgress && i % 200 === 0) onProgress(i, list.length);
    i++;
    const name = J.classNameOf(e.path);
    try {
      const c = parseClass(J.entryBytes(j, e.path, LIMITS.maxClassBytes), { lite: true, maxMs: 3000 });
      out.set(name, {
        java: c.java, major: c.major, decl: c.decl, crc: e.crc,
        fields: new Set(c.fields.map((f) => f.decl.replace(/ = .*$/, ''))),
        methods: new Set(c.methods.map((m) => m.decl)),
      });
    } catch (err) { out.set(name, { java: '?', major: 0, decl: `(not readable: ${err.message})`, crc: e.crc, fields: new Set(), methods: new Set() }); }
  }
  return { map: out, problems, total: list.length };
}

/** Compares two opened JARs. Returns a plain object (sent to the webview and turned into Markdown). */
function compareJars(a, b, opts = {}) {
  const A = classSummaries(a, opts), B = classSummaries(b, opts);
  const names = [...new Set([...A.map.keys(), ...B.map.keys()])].sort();
  const added = [], removed = [], changed = [];
  let same = 0;
  for (const n of names) {
    const x = A.map.get(n), y = B.map.get(n);
    if (!x) { added.push(n); continue; }
    if (!y) { removed.push(n); continue; }
    if (x.crc === y.crc) { same++; continue; }
    const diff = { name: n, notes: [], methodsAdded: [], methodsRemoved: [], fieldsAdded: [], fieldsRemoved: [] };
    if (x.java !== y.java) diff.notes.push(`Java version ${x.java} → ${y.java}`);
    if (x.decl !== y.decl) diff.notes.push(`Declaration: ${x.decl} → ${y.decl}`);
    for (const m of y.methods) if (!x.methods.has(m)) diff.methodsAdded.push(m);
    for (const m of x.methods) if (!y.methods.has(m)) diff.methodsRemoved.push(m);
    for (const f of y.fields) if (!x.fields.has(f)) diff.fieldsAdded.push(f);
    for (const f of x.fields) if (!y.fields.has(f)) diff.fieldsRemoved.push(f);
    if (!diff.notes.length && !diff.methodsAdded.length && !diff.methodsRemoved.length && !diff.fieldsAdded.length && !diff.fieldsRemoved.length) diff.notes.push('Same signatures; the bytecode changed.');
    changed.push(diff);
  }
  const res = (j) => new Map(j.zip.entries.filter((e) => !e.dir && !/\.class$/i.test(e.path)).map((e) => [e.path, e.crc]));
  const ra = res(a), rb = res(b);
  const resources = { added: [], removed: [], changed: [] };
  for (const [p, crc] of rb) { if (!ra.has(p)) resources.added.push(p); else if (ra.get(p) !== crc) resources.changed.push(p); }
  for (const p of ra.keys()) if (!rb.has(p)) resources.removed.push(p);
  const versions = (S) => { const m = new Map(); for (const v of S.map.values()) m.set(v.java, (m.get(v.java) || 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]); };
  const cap = (l) => l.slice(0, 5000);
  return {
    classesA: A.total, classesB: B.total, same, added: cap(added), removed: cap(removed), changed: changed.slice(0, 5000),
    addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
    versionsA: versions(A), versionsB: versions(B), resources: { added: cap(resources.added), removed: cap(resources.removed), changed: cap(resources.changed) },
    problems: [...A.problems.map((p) => `First JAR: ${p}`), ...B.problems.map((p) => `Second JAR: ${p}`)],
  };
}

function compareMarkdown(r, nameA, nameB) {
  const md = (s) => String(s).replace(/([\\`*_[\]<>|])/g, '\\$1');
  const L = [];
  L.push(`# ${md(nameA)} compared with ${md(nameB)}`, '');
  L.push(`| | ${md(nameA)} | ${md(nameB)} |`, '|---|---|---|');
  L.push(`| Classes | ${r.classesA} | ${r.classesB} |`);
  L.push(`| Java versions | ${r.versionsA.map(([v, n]) => `${v}: ${n}`).join(', ') || '-'} | ${r.versionsB.map(([v, n]) => `${v}: ${n}`).join(', ') || '-'} |`, '');
  L.push(`Classes: ${r.addedCount} added, ${r.removedCount} removed, ${r.changedCount} changed, ${r.same} the same.`, '');
  if (r.addedCount) { L.push(`## Classes added in ${md(nameB)} (${r.addedCount})`, ''); for (const n of r.added) L.push(`- \`${n}\``); L.push(''); }
  if (r.removedCount) { L.push(`## Classes removed in ${md(nameB)} (${r.removedCount})`, ''); for (const n of r.removed) L.push(`- \`${n}\``); L.push(''); }
  if (r.changedCount) {
    L.push(`## Classes changed (${r.changedCount})`, '');
    for (const c of r.changed) {
      L.push(`### \`${c.name}\``, '');
      for (const n of c.notes) L.push(`- ${md(n)}`);
      for (const m of c.methodsAdded) L.push(`- Method added: \`${m}\``);
      for (const m of c.methodsRemoved) L.push(`- Method removed: \`${m}\``);
      for (const f of c.fieldsAdded) L.push(`- Field added: \`${f}\``);
      for (const f of c.fieldsRemoved) L.push(`- Field removed: \`${f}\``);
      L.push('');
    }
  }
  const rs = r.resources;
  if (rs.added.length || rs.removed.length || rs.changed.length) {
    L.push('## Resources', '');
    for (const p of rs.added) L.push(`- Added: \`${p}\``);
    for (const p of rs.removed) L.push(`- Removed: \`${p}\``);
    for (const p of rs.changed) L.push(`- Changed: \`${p}\``);
    L.push('');
  }
  if (r.problems.length) { L.push('## Notes', ''); for (const p of r.problems) L.push(`- ${md(p)}`); L.push(''); }
  L.push('Made with JAR Viewer & Java Decompiler (Zovo).');
  return L.join('\n');
}

/** Finds a class, method, field or string constant in one opened JAR. hits: [{ kind, cls, text }]. */
function findInJar(j, match, { max = 2000, maxMs = 20000 } = {}) {
  const started = Date.now();
  const hits = [];
  const plain = match.plain;
  const needles = plain ? [Buffer.from(plain), Buffer.from(plain.replace(/\./g, '/'))] : null;
  for (const e of j.zip.entries) {
    if (hits.length >= max || Date.now() - started > maxMs) break;
    if (e.dir || !/\.class$/i.test(e.path)) continue;
    const cls = J.classNameOf(e.path);
    if (match.test(cls)) hits.push({ kind: 'class', cls, text: cls, path: e.path });
    let bytes;
    try { bytes = J.entryBytes(j, e.path, LIMITS.maxClassBytes); } catch { continue; }
    // Plain text: skip classes whose bytes cannot contain it (case-insensitive check below needs the parse).
    if (needles && !needles.some((n) => bytes.includes(n)) && !bytes.toString('latin1').toLowerCase().includes(plain.toLowerCase())) continue;
    let c;
    try { c = parseClass(bytes, { lite: true, maxMs: 2000 }); } catch { continue; }
    for (const m of c.methods) if (hits.length < max && m.name !== '<clinit>' && match.test(m.name)) hits.push({ kind: 'method', cls, text: m.decl, path: e.path });
    for (const f of c.fields) if (hits.length < max && match.test(f.name)) hits.push({ kind: 'field', cls, text: f.decl, path: e.path });
    for (const s of new Set(c.strings)) if (hits.length < max && match.test(s)) hits.push({ kind: 'string', cls, text: JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}...` : s), path: e.path });
  }
  return hits;
}

module.exports = { matcher, compareJars, compareMarkdown, findInJar, classSummaries };
