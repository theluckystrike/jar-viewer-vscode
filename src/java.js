'use strict';
// Finds a Java runtime and runs the bundled CFR decompiler (cfr/cfr-0.152.jar, MIT) in a child process.
// Order: the setting jarViewer.javaPath (a java binary or a JDK/JRE folder), then JAVA_HOME, then `java` on PATH.
// Every call uses execFile/spawn with an argument list (no shell), a timeout and -Xmx512m. The input is always a JAR
// that the worker wrote into the extension's storage with checked class names, never a path built from entry names.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CFR_JAR = path.join(__dirname, '..', 'cfr', 'cfr-0.152.jar');
const MEMORY = '-Xmx512m';
const VERSION_TIMEOUT_MS = 8000;

function candidatesFor(p) {
  if (!p) return [];
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  return [p, path.join(p, 'bin', exe), path.join(p, 'Contents', 'Home', 'bin', exe)];
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** Paths to try, with where each came from. explicit: the setting (when set, nothing else is tried). */
function javaCandidates(explicit, env = process.env) {
  const want = explicit ? String(explicit).trim() : '';
  if (want) { const found = candidatesFor(want).find(isFile); return [found ? { path: found, from: 'setting' } : { path: want, from: 'setting', missing: true }]; }
  const out = [];
  if (env.JAVA_HOME) for (const p of candidatesFor(env.JAVA_HOME).slice(1)) if (isFile(p)) { out.push({ path: p, from: 'JAVA_HOME' }); break; }
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (isFile(p) && !out.some((o) => o.path === p)) { out.push({ path: p, from: 'PATH' }); if (out.length >= 4) break; }
  }
  return out;
}

/** Runs `java -version` with a timeout. Resolves { ok, path, version, major, from, error }. */
function checkJava(cand) {
  return new Promise((resolve) => {
    if (cand.missing) { resolve({ ok: false, path: cand.path, from: cand.from, error: `${cand.path} was not found.` }); return; }
    execFile(cand.path, ['-version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 16, env: { ...process.env, JAVA_TOOL_OPTIONS: '' } }, (err, stdout, stderr) => {
      const text = `${stderr || ''}${stdout || ''}`;
      const m = /version "([^"]+)"/.exec(text);
      if (err || !m) { resolve({ ok: false, path: cand.path, from: cand.from, error: (err && err.killed) ? 'java -version did not answer in time.' : (text.split('\n')[0] || (err && err.message) || 'not a Java runtime').slice(0, 200) }); return; }
      const v = m[1];
      const major = v.startsWith('1.') ? Number(v.split('.')[1]) : parseInt(v, 10);
      resolve({ ok: major >= 8, path: cand.path, from: cand.from, version: v, major, error: major >= 8 ? '' : `Java ${v} is too old; CFR needs Java 8 or newer.` });
    });
  });
}

/** The first working Java: { ok, path, version, from } or { ok: false, error, tried }. */
async function findJava(explicit, env) {
  const list = javaCandidates(explicit, env);
  const tried = [];
  for (const c of list) {
    const r = await checkJava(c);
    if (r.ok) return r;
    tried.push(r);
  }
  return { ok: false, error: tried.length ? tried.map((t) => `${t.path}: ${t.error}`).join('; ') : 'No Java runtime found (setting jarViewer.javaPath, JAVA_HOME or java on PATH).', tried, explicit: !!(explicit && String(explicit).trim()) };
}

/**
 * Runs CFR. args: extra CFR options after the input. Returns { code, stdout, stderr, timedOut, cancelled }.
 * onLine(line) gets stderr/stdout lines when given (progress for exports); cancel: { onCancel(fn) }.
 */
function runCfr(java, input, extra = [], { timeoutMs = 60000, idleMs = 0, onLine, maxOutput = 32 << 20, cancel } = {}) {
  return new Promise((resolve) => {
    const args = [MEMORY, '-Xss16m', '-Djava.awt.headless=true', '-XX:+UseSerialGC', '-jar', CFR_JAR, input, ...extra];
    let child;
    try { child = spawn(java, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JAVA_TOOL_OPTIONS: '' } }); } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e.message), error: true }); return; }
    let out = [], outLen = 0, err = '', done = false, timedOut = false, cancelled = false, truncated = false, idleTimer;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const arm = () => { if (!idleMs) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; kill(); }, idleMs); };
    arm();
    if (cancel && cancel.onCancel) cancel.onCancel(() => { cancelled = true; kill(); });
    let partial = '';
    const lines = (chunk) => {
      if (!onLine) return;
      partial += chunk.toString('utf8');
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const l of parts) { try { onLine(l); } catch { /* ignore */ } }
    };
    child.stdout.on('data', (c) => { arm(); if (outLen < maxOutput) { out.push(c); outLen += c.length; } else { truncated = true; kill(); } lines(c); });
    child.stderr.on('data', (c) => { arm(); if (err.length < 1 << 20) err += c.toString('utf8'); lines(c); });
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(idleTimer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, timedOut, cancelled, truncated });
    };
    child.on('error', (e) => { err += String(e.message); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

module.exports = { findJava, checkJava, javaCandidates, runCfr, CFR_JAR, MEMORY };
