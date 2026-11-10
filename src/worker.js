'use strict';
// Runs the readers in a worker thread, so a hostile or huge JAR can never block or crash the extension host.
// The host (runner.js) kills this worker when it takes too long or uses too much memory.
const fs = require('fs');
const { parentPort } = require('worker_threads');
const { FileSource, BufferSource } = require('./core/source');
const J = require('./core/jar');
const { parseClass } = require('./core/classfile');
const tools = require('./core/tools');
const { writeZip } = require('./core/zipwrite');
const { LIMITS, checkEntryName, fmtSize } = require('./core/limits');

function sourceOf(job) {
  if (job.buffer) return new BufferSource(Buffer.from(job.buffer));
  return new FileSource(job.file);
}

/** Opens the JAR of a job (and the nested JAR when job.nested is set; one level only). */
function openJob(job) {
  const src = sourceOf(job);
  try {
    const outer = J.openZip(src);
    return job.nested ? J.openNested(outer, job.nested) : outer;
  } catch (e) { src.close(); throw e; }
}

function isClassBytes(src) { const h = src.read(0, 4); return h.length === 4 && h.readUInt32BE(0) === 0xcafebabe; }

async function run(job, progress) {
  if (job.op === 'open') {
    const src = sourceOf(job);
    try {
      if (isClassBytes(src) || /\.class$/i.test(job.name || '')) {
        if (src.size > LIMITS.maxClassBytes) throw new Error(`This class file is ${fmtSize(src.size)}; class files are read up to ${fmtSize(LIMITS.maxClassBytes)}.`);
        const c = parseClass(src.read(0, src.size));
        return { kind: 'classfile', name: job.name, size: src.size, cls: c };
      }
      let j;
      try { j = J.openZip(src); } catch (e) {
        const head = src.read(0, 4);
        const err = new Error(head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b ? e.message : `This file is not a JAR or class file (${e.message})`);
        err.code = 'NOT_JAR';
        throw err;
      }
      if (job.nested) j = J.openNested(j, job.nested);
      const m = J.jarModel(j, { name: job.nested ? job.nested.split('/').pop() : job.name, nestedIn: job.nested ? job.name : '' });
      if (job.nested) m.nestedPath = job.nested;
      return m;
    } finally { src.close(); }
  }
  if (job.op === 'class') {
    const j = openJob(job);
    try { return parseClass(J.entryBytes(j, job.path, LIMITS.maxClassBytes)); } finally { j.src.close(); }
  }
  if (job.op === 'resource') {
    const j = openJob(job);
    try { return J.resourceView(j, job.path); } finally { j.src.close(); }
  }
  if (job.op === 'stage') {
    // Writes a JAR with the checked classes only (into the extension's storage) for CFR.
    // job.paths: entry paths, or null for every class. Names that are unsafe or do not match the class are left out.
    let entries = [];
    const skipped = [];
    const add = (name, data) => {
      const internal = name.replace(/\.class$/, '');
      const c = checkEntryName(`${internal}.class`);
      if (c.unsafe || c.path !== `${internal}.class` || internal.split('/').some((p) => !p || /[<>:"|?*\\]/.test(p) || p.length > 200)) { skipped.push(name); return; }
      entries.push({ name: `${internal}.class`, data });
    };
    if (job.classFile) {
      const src = sourceOf(job);
      try {
        const data = src.read(0, Math.min(src.size, LIMITS.maxClassBytes));
        const c = parseClass(data, { lite: true });
        add(c.name.replace(/\./g, '/'), data);
        for (const f of (job.siblings || []).slice(0, 500)) {
          try { const b = fs.readFileSync(f); const s = parseClass(b, { lite: true }); add(s.name.replace(/\./g, '/'), b); } catch { skipped.push(f); }
        }
      } finally { src.close(); }
    } else {
      const j = openJob(job);
      try {
        const list = job.groupOf ? J.classGroup(j, job.groupOf).list : job.paths || j.zip.entries.filter((e) => !e.dir && /\.class$/i.test(e.path) && !/^META-INF\/versions\//.test(e.path) && !/(^|\/)module-info\.class$/.test(e.path)).map((e) => e.path);
        let i = 0;
        for (const p of list) {
          if (i++ % 200 === 0) progress({ staged: i, total: list.length });
          let data;
          try { data = J.entryBytes(j, p, LIMITS.maxClassBytes); } catch { skipped.push(p); continue; }
          let c;
          try { c = parseClass(data, { lite: true, maxMs: 2000 }); } catch { skipped.push(p); continue; }
          if (J.classNameOf(p) !== c.name) { skipped.push(p); continue; }
          add(c.name.replace(/\./g, '/'), data);
        }
      } finally { j.src.close(); }
    }
    const seen = new Set();
    entries = entries.filter((e) => (seen.has(e.name) ? false : seen.add(e.name)));
    fs.writeFileSync(job.out, writeZip(entries), { mode: 0o600 });
    return { written: entries.length, names: entries.slice(0, 50000).map((e) => e.name), skipped: skipped.slice(0, 1000), skippedCount: skipped.length };
  }
  if (job.op === 'listings') {
    // Export without Java: one javap-style listing per class, written under job.out with checked names.
    const path = require('path');
    const { joinInside } = require('./core/limits');
    const j = openJob(job);
    let written = 0;
    const skipped = [];
    try {
      const list = j.zip.entries.filter((e) => !e.dir && /\.class$/i.test(e.path) && !/^META-INF\/versions\//.test(e.path));
      let i = 0;
      for (const e of list) {
        if (i++ % 100 === 0) progress({ staged: i, total: list.length });
        try {
          const c = parseClass(J.entryBytes(j, e.path, LIMITS.maxClassBytes), { maxMs: 3000 });
          const target = joinInside(job.out, `${c.name.replace(/\./g, '/')}.txt`);
          if (!target) { skipped.push(e.path); continue; }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, c.listing.join('\n') + '\n');
          written++;
        } catch { skipped.push(e.path); }
      }
    } finally { j.src.close(); }
    return { written, skipped: skipped.slice(0, 200), skippedCount: skipped.length };
  }
  if (job.op === 'compare') {
    const a = openJob(job.a);
    try {
      const b = openJob(job.b);
      try { return tools.compareJars(a, b, { onProgress: (i, n) => progress({ i, n }) }); } finally { b.src.close(); }
    } finally { a.src.close(); }
  }
  if (job.op === 'find') {
    const match = tools.matcher(job.query);
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i];
      let hits = [], error = '';
      let j;
      try {
        j = J.openZip(new FileSource(file));
        hits = tools.findInJar(j, match, { max: 1000 }).map((h) => ({ ...h, jar: '' }));
        // one level into nested JARs (Spring Boot BOOT-INF/lib, WEB-INF/lib)
        for (const e of j.zip.entries.filter((x) => !x.dir && J.NESTED_RE.test(x.path)).slice(0, 300)) {
          if (hits.length >= 1000) break;
          try { const n = J.openNested(j, e.path); hits.push(...tools.findInJar(n, match, { max: 1000 - hits.length, maxMs: 5000 }).map((h) => ({ ...h, jar: e.path }))); } catch { /* skip a broken nested JAR */ }
        }
      } catch (e) { error = String(e.message || e).slice(0, 200); } finally { if (j) j.src.close(); }
      progress({ index: i, file, hits, error });
    }
    return { done: true };
  }
  throw new Error(`unknown job ${job.op}`);
}

parentPort.on('message', async (msg) => {
  try {
    const result = await run(msg.job, (p) => parentPort.postMessage({ id: msg.id, progress: p }));
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e), code: e && e.code });
  }
});
