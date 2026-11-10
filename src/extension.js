'use strict';
// JAR Viewer & Java Decompiler: a read-only custom editor for .jar .war .ear .aar and .class files.
// The readers run in a worker thread (runner.js) with a time and memory cap, so a hostile archive cannot hang or crash
// the extension host. Decompiling runs the bundled CFR in a child process only when a Java runtime is found (java.js).
// No network: the webview gets everything by postMessage. Pro tools (pro.js) ask only when used.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runJob, findInFiles } = require('./runner');
const tools = require('./core/tools');
const { joinInside } = require('./core/limits');
const { classNameOf: J_className } = require('./core/jar');
const { findJava, runCfr } = require('./java');
const { buildHtml } = require('./html');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-jar-viewer';
const PREFIX = 'jarViewer';
const VIEW_TYPE = 'jarViewer.archive';
const MAX_REMOTE_BYTES = 256 * 1024 * 1024;
const JAR_EXT = /\.(jar|war|ear|aar)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.gradle-cache', '__pycache__', '.venv']);

let rating = { success() {}, failure() {} };
let pro;
let ctx;
const viewers = new Set();
let active = null;
let javaPromise = null;
const pendingSelect = new Map();

function setting(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();

/** The Java runtime, looked up once per window (and again after the setting changes). */
function java() {
  if (!javaPromise) javaPromise = findJava(setting('javaPath', ''), process.env).catch((e) => ({ ok: false, error: String(e.message || e) }));
  return javaPromise;
}
function javaState(j) { return j && j.ok ? { ok: true, version: j.version, from: j.from } : { ok: false, error: (j && j.error) || '', explicit: !!(j && j.explicit) }; }

/** A private folder in the extension's storage for CFR input and output; removed after each run. */
function tempDir() {
  const base = path.join((ctx.globalStorageUri && ctx.globalStorageUri.fsPath) || os.tmpdir(), 'tmp');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(base, 'cfr-'));
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

/** Where a job reads its bytes: a local path, or a copy of the bytes for remote and virtual files. */
async function sourceOf(uri) {
  if (uri.scheme === 'file') return { file: uri.fsPath };
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > MAX_REMOTE_BYTES) throw new Error(`This file is ${Math.round(st.size / 1048576)} MB on a remote or virtual file system; files there are read up to 256 MB.`);
  const data = await vscode.workspace.fs.readFile(uri);
  return { buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}
const jobSrc = (s) => (s.file ? { file: s.file } : { buffer: s.buffer.slice(0) });

/**
 * Decompiles one class (with its inner classes) of a JAR or a .class file. Resolves { text } or { error }.
 * A JAR is staged once per viewer (every checked class, in the extension's storage) and CFR decompiles only the
 * wanted outer class from it (--jarfilter), so it can resolve the other classes of the JAR. The staged file is
 * removed when the editor closes.
 */
async function decompile(v, entryPath) {
  const j = await java();
  if (!j.ok) return { error: 'nojava' };
  const outerPath = entryPath.replace(/\.class$/, '').replace(/\$.*$/, '');
  const key = `${v.nested || ''}|${outerPath}`;
  if (v.sources.has(key)) return v.sources.get(key);
  let input, extra = [], once = null;
  if (v.model.kind === 'classfile') {
    once = tempDir();
    input = path.join(once, `in-${crypto.randomBytes(6).toString('hex')}.jar`);
    let siblings = [];
    if (v.uri.scheme === 'file') {
      const d = path.dirname(v.uri.fsPath), base = path.basename(v.uri.fsPath).replace(/\.class$/i, '').replace(/\$.*$/, '');
      try { siblings = fs.readdirSync(d).filter((f) => f.startsWith(`${base}$`) && f.endsWith('.class')).slice(0, 500).map((f) => path.join(d, f)); } catch { siblings = []; }
    }
    const staged = await runJob({ op: 'stage', ...jobSrc(v.src), classFile: true, siblings, out: input });
    if (!staged.written) { rmrf(once); return { error: 'This class has a name that cannot be decompiled safely.' }; }
  } else {
    const sk = v.nested || '';
    if (!v.staged.has(sk)) {
      if (!v.tmp) v.tmp = tempDir();
      const out = path.join(v.tmp, `in-${crypto.randomBytes(6).toString('hex')}.jar`);
      v.staged.set(sk, runJob({ op: 'stage', ...jobSrc(v.src), nested: v.nested || undefined, out }, { idleMs: 60000 }).then((r) => ({ out, names: new Set(r.names), all: r.names.length >= 50000 })));
    }
    let st;
    try { st = await v.staged.get(sk); } catch (e) { v.staged.delete(sk); throw e; }
    const want = J_className(entryPath.replace(/\$.*$/, '').replace(/(\.class)?$/, '.class'));
    if (!st.all && !st.names.has(`${want.replace(/\./g, '/')}.class`)) return { error: 'This class has a name that cannot be decompiled safely (it does not match its path, or it has characters a file name cannot hold).' };
    input = st.out;
    extra = ['--jarfilter', `^${want.replace(/[^A-Za-z0-9_]/g, (c) => `\\${c}`)}$`];
  }
  try {
    const r = await runCfr(j.path, input, [...extra, '--silent', 'true'], { timeoutMs: 45000 });
    let res;
    if (r.timedOut) res = { error: 'CFR did not finish in 45 seconds and was stopped. The Bytecode tab shows this class.' };
    else if (r.code !== 0 || !r.stdout.trim()) res = { error: `CFR could not decompile this class${r.stderr ? `: ${r.stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)}` : '.'}` };
    else res = { text: r.stdout.replace(/\r\n/g, '\n') };
    if (res.text) { v.sources.set(key, res); if (v.sources.size > 200) v.sources.delete(v.sources.keys().next().value); }
    return res;
  } finally { if (once) rmrf(once); }
}

class Viewer {
  constructor(uri, panel) {
    this.uri = uri; this.panel = panel; this.model = null; this.outer = null; this.name = baseName(uri); this.counted = false;
    this.nested = ''; this.sources = new Map(); this.src = null; this.staged = new Map(); this.tmp = null;
  }
  post(msg) { return this.panel.webview.postMessage(msg).then(undefined, () => false); }
  async load() {
    try {
      if (!this.src) this.src = await sourceOf(this.uri);
      this.model = await runJob({ op: 'open', ...jobSrc(this.src), name: this.name });
      this.outer = this.model;
      this.nested = '';
      await this.post({ type: 'model', model: this.model, name: this.name, java: javaState(await java()), pro: proState() });
      const sel = this.uri.scheme === 'file' && pendingSelect.get(this.uri.fsPath);
      if (sel) { pendingSelect.delete(this.uri.fsPath); await this.post({ type: 'select', path: sel }); }
    } catch (e) {
      const notJar = e.code === 'NOT_JAR';
      if (!notJar && e.code !== 'ENOENT') rating.failure();
      await this.post({ type: 'error', message: e.message || String(e), notJar, pro: proState() });
    }
  }
  async openNested(p) {
    if (!p) { this.nested = ''; this.model = this.outer; return this.post({ type: 'model', model: this.outer, name: this.name, java: javaState(await java()), pro: proState() }); }
    if (this.nested) return this.post({ type: 'notice', text: 'Nested archives open one level deep. Open the outer archive to go to another nested JAR.' });
    try {
      const m = await runJob({ op: 'open', ...jobSrc(this.src), name: this.name, nested: p });
      this.nested = p; this.model = m;
      return this.post({ type: 'model', model: m, name: this.name, java: javaState(await java()), pro: proState() });
    } catch (e) { return this.post({ type: 'notice', text: `${p.split('/').pop()}: ${e.message}` }); }
  }
  async onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'ready': return this.load();
      case 'rendered':
        if (!this.counted && this.model) { this.counted = true; rating.success(this.uri); }
        return undefined;
      case 'class': {
        const p = String(msg.path || '');
        try {
          const cls = this.model.kind === 'classfile' ? this.model.cls : await runJob({ op: 'class', ...jobSrc(this.src), nested: this.nested || undefined, path: p });
          await this.post({ type: 'class', path: p, cls });
        } catch (e) { return this.post({ type: 'class', path: p, error: e.message }); }
        if (msg.decompile === false) return undefined;
        return this.sendSource(p);
      }
      case 'decompile': return this.sendSource(String(msg.path || ''));
      case 'resource': {
        const p = String(msg.path || '');
        try { return this.post({ type: 'resource', path: p, res: await runJob({ op: 'resource', ...jobSrc(this.src), nested: this.nested || undefined, path: p }) }); } catch (e) { return this.post({ type: 'resource', path: p, error: e.message }); }
      }
      case 'nested': return this.openNested(String(msg.path || ''));
      case 'tool': return runTool(String(msg.tool), this, msg.arg);
      case 'copy': return vscode.env.clipboard.writeText(String(msg.text || '').slice(0, 20 << 20)).then(() => vscode.window.setStatusBarMessage(msg.what ? `Copied ${msg.what}.` : 'Copied.', 3000));
      case 'openText': {
        const doc = await vscode.workspace.openTextDocument({ language: msg.language === 'java' ? 'java' : 'plaintext', content: String(msg.text || '').slice(0, 20 << 20) });
        return vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
      case 'openFile': {
        const p = String(msg.path || '');
        if (!p || !path.isAbsolute(p)) return undefined;
        if (msg.select) pendingSelect.set(p, String(msg.select));
        return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(p), VIEW_TYPE);
      }
      case 'saveCompare': return saveCompare(this);
      case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', msg.java ? `${PREFIX}.javaPath` : `@ext:${EXT_ID}`);
      default: return undefined;
    }
  }
  /** One CFR run at a time per viewer: a click during a run replaces the waiting request (no pile of JVMs). */
  async sendSource(p) {
    this.wantSource = p;
    if (this.decompiling) return undefined;
    this.decompiling = true;
    try {
      while (this.wantSource !== null && this.wantSource !== undefined) {
        const cur = this.wantSource;
        this.wantSource = null;
        let r;
        try { r = await decompile(this, cur); } catch (e) { r = { error: e.message }; }
        await this.post({ type: 'source', path: cur, ...r });
      }
    } finally { this.decompiling = false; }
    return undefined;
  }
}

function proState() {
  return { show: setting('showProTools', true) !== false, licensed: !!(pro && pro.licensed), tries: pro ? pro.tries() : {} };
}

class Provider {
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris(PREFIX), localResourceRoots: [media] };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString(),
      title: baseName(document.uri),
      showSupportLinks: showLinks(vscode, PREFIX),
    });
    const v = new Viewer(document.uri, panel);
    viewers.add(v);
    if (panel.active) active = v;
    panel.onDidChangeViewState(() => { if (panel.active) active = v; else if (active === v && !panel.visible) active = null; });
    panel.onDidDispose(() => { viewers.delete(v); if (active === v) active = null; if (v.tmp) rmrf(v.tmp); v.tmp = null; v.staged.clear(); });
    panel.webview.onDidReceiveMessage((m) => v.onMessage(m).then(undefined, (e) => v.post({ type: 'notice', text: String(e && e.message || e) })));
  }
}

// ---------------- Pro tools ----------------

/** The JAR a tool works on: the viewer it was started from, a file from the Explorer, the active viewer, or a pick. */
async function jarOrPick(arg, title) {
  if (arg instanceof Viewer && arg.model && arg.model.kind === 'jar') return { uri: arg.uri, name: arg.nested ? arg.nested.split('/').pop() : arg.name, src: arg.src, nested: arg.nested, viewer: arg };
  if (arg && arg.fsPath && JAR_EXT.test(arg.fsPath)) return { uri: arg, name: baseName(arg), src: { file: arg.fsPath }, nested: '' };
  if (active && active.model && active.model.kind === 'jar' && !(arg && arg.fsPath)) return { uri: active.uri, name: active.nested ? active.nested.split('/').pop() : active.name, src: active.src, nested: active.nested, viewer: active };
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: title, title: `${title}: pick a JAR, WAR, EAR or AAR file`, filters: { 'Java archives': ['jar', 'war', 'ear', 'aar'] } });
  if (!pick || !pick[0]) return null;
  return { uri: pick[0], name: baseName(pick[0]), src: await sourceOf(pick[0]), nested: '' };
}

async function runTool(tool, from, arg) {
  if (tool === 'export') return exportSources(from);
  if (tool === 'compare') return compare(from);
  if (tool === 'find') return findInFolder(from, arg);
  return undefined;
}

function tell(from, text) {
  if (from instanceof Viewer) return from.post({ type: 'notice', text });
  return vscode.window.showInformationMessage(text);
}

/** Copies CFR's .java output from a temp folder into the target, with checked names only. */
function copyTree(srcRoot, destRoot) {
  let n = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let list;
    try { list = fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { stack.push(r); continue; }
      if (!e.isFile() || !e.name.endsWith('.java')) continue;
      const target = joinInside(destRoot, r);
      if (!target) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, r), target);
      n++;
    }
  }
  return n;
}

async function exportSources(from) {
  if (!(await pro.allowed('export'))) return;
  const j = await jarOrPick(from, 'Export sources');
  if (!j) return;
  const base = j.name.replace(/\.(jar|war|ear|aar)$/i, '');
  const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Export here', title: `Export the decompiled sources of ${j.name} into a folder`, defaultUri: j.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(j.uri.fsPath)) : undefined });
  if (!pick || !pick[0]) return; // cancelled: no try used
  let dest = path.join(pick[0].fsPath, `${base}-src`);
  for (let k = 2; fs.existsSync(dest) && k < 100; k++) dest = path.join(pick[0].fsPath, `${base}-src-${k}`);
  const jv = await java();
  const dir = tempDir();
  let result = { written: 0, stopped: false, error: '', kind: jv.ok ? 'java' : 'listing' };
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${j.name}`, cancellable: true }, async (progress, token) => {
      if (!jv.ok) {
        progress.report({ message: 'No Java runtime: writing bytecode listings' });
        const r = await runJob({ op: 'listings', ...jobSrc(j.src), nested: j.nested || undefined, out: dest }, { idleMs: 60000, onProgress: (p) => { progress.report({ message: `${p.staged} of ${p.total} classes` }); return token.isCancellationRequested ? 'stop' : undefined; } });
        if (r.stopped || token.isCancellationRequested) { result.stopped = true; rmrf(dest); return; }
        result.written = r.written;
        return;
      }
      const input = path.join(dir, `in-${crypto.randomBytes(6).toString('hex')}.jar`);
      const staged = await runJob({ op: 'stage', ...jobSrc(j.src), nested: j.nested || undefined, out: input }, { idleMs: 60000, onProgress: (p) => { progress.report({ message: `Reading classes: ${p.staged} of ${p.total}` }); return token.isCancellationRequested ? 'stop' : undefined; } });
      if (staged.stopped || token.isCancellationRequested) { result.stopped = true; return; }
      const total = staged.names.filter((n) => !n.includes('$')).length || staged.written; // CFR reports top-level classes
      let done = 0;
      const out = path.join(dir, 'out');
      const r = await runCfr(jv.path, input, ['--outputdir', out, '--silent', 'false'], {
        timeoutMs: 30 * 60000, idleMs: 120000,
        onLine: (l) => { if (/^Processing [^ ]+$/.test(l.trim()) && !/\.jar$/.test(l.trim())) { done++; if (done % 10 === 0 || done === total) progress.report({ message: `${done} of ${total} classes`, increment: 1000 / Math.max(1, total) }); } },
        cancel: { onCancel: (fn) => token.onCancellationRequested(fn) },
      });
      if (r.cancelled || token.isCancellationRequested) { result.stopped = true; return; }
      if (r.timedOut) { result.error = 'CFR stopped answering and was stopped.'; return; }
      result.written = copyTree(out, dest);
      if (!result.written) result.error = `CFR wrote no Java files${r.stderr ? `: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}` : '.'}`;
    });
  } catch (e) { result.error = e.message; } finally { rmrf(dir); }
  if (result.stopped) { tell(from, 'Export stopped. No try was used.'); return; }
  if (!result.written) { vscode.window.showWarningMessage(`Export of ${j.name} failed: ${result.error || 'nothing was written.'}`); return; }
  await pro.produced('export');
  const what = result.kind === 'java' ? `${result.written} Java source files` : `${result.written} bytecode listings (no Java runtime found, so no Java source)`;
  if (from instanceof Viewer) await from.post({ type: 'exported', text: `Wrote ${what} to ${dest}`, dest });
  else vscode.window.showInformationMessage(`Wrote ${what} to ${dest}`);
  refreshPro();
}

async function compare(from) {
  if (!(await pro.allowed('compare'))) return;
  const a = await jarOrPick(from, 'Compare');
  if (!a) return;
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: `Compare ${a.name} with...`, filters: { 'Java archives': ['jar', 'war', 'ear', 'aar'] }, defaultUri: a.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(a.uri.fsPath)) : undefined });
  if (!pick || !pick[0]) return; // cancelled: no try used
  const nameB = baseName(pick[0]);
  let result;
  try {
    const srcB = await sourceOf(pick[0]);
    result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Comparing ${a.name} with ${nameB}` }, () => runJob({ op: 'compare', a: { ...jobSrc(a.src), nested: a.nested || undefined }, b: jobSrc(srcB) }, { idleMs: 90000 }));
  } catch (e) { vscode.window.showWarningMessage(`Could not compare: ${e.message}`); return; }
  const v = a.viewer || (from instanceof Viewer ? from : null);
  if (v) {
    v.lastCompare = { result, nameA: a.name, nameB };
    await v.post({ type: 'compare', result, nameA: a.name, nameB });
    v.panel.reveal();
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: tools.compareMarkdown(result, a.name, nameB) });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  await pro.produced('compare');
  refreshPro();
}

async function saveCompare(v) {
  if (!v.lastCompare) return;
  const { result, nameA, nameB } = v.lastCompare;
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: tools.compareMarkdown(result, nameA, nameB) });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

/** JAR, WAR, EAR and AAR files under a folder; at most 30,000 entries looked at and 5,000 archives. */
async function listJars(root, cancelled) {
  const out = [];
  let seen = 0;
  const stack = [[root, 0]];
  while (stack.length && seen < 30000 && out.length < 5000 && !cancelled()) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > 30000) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < 24) stack.push([p, depth + 1]); continue; }
      if (e.isFile() && JAR_EXT.test(e.name)) out.push(p);
    }
  }
  return out.sort();
}

async function findInFolder(from, preset) {
  if (!(await pro.allowed('find'))) return;
  const query = typeof preset === 'string' && preset.trim() ? preset : await vscode.window.showInputBox({
    title: 'Find in every JAR of a folder',
    prompt: 'A class, method, field or string constant. Plain text matches any part; /regex/ works too.',
    placeHolder: 'for example StringUtils, toJson, jdbc:mysql or /Log4j.*Lookup/',
    validateInput: (s) => { try { tools.matcher(s); return null; } catch (e) { return e.message; } },
  });
  if (!query || !query.trim()) return; // cancelled: no try used
  const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file');
  let root;
  if (from instanceof Viewer && from.uri.scheme === 'file' && !folders.some((f) => from.uri.fsPath.startsWith(f.uri.fsPath + path.sep))) root = path.dirname(from.uri.fsPath);
  else if (folders.length === 1) root = folders[0].uri.fsPath;
  else if (folders.length > 1) {
    const p = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { title: 'Search which folder?' });
    if (!p) return;
    root = p.f.uri.fsPath;
  }
  if (!root) {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Search here', title: 'Folder to search' });
    if (!p || !p[0]) return;
    root = p[0].fsPath;
  }
  const results = [];
  let files = 0, read = 0, failed = 0;
  const stopped = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Finding "${query}"`, cancellable: true }, async (progress, token) => {
    const cancelled = () => token.isCancellationRequested;
    const list = await listJars(root, cancelled);
    files = list.length;
    await findInFiles(list, query, {
      cancelled,
      onFile: (p) => {
        if (p.error) failed++; else read++;
        for (const h of p.hits) if (results.length < 5000) results.push({ ...h, file: p.file, rel: path.relative(root, p.file) });
        progress.report({ message: `${p.index + 1} of ${files} archives, ${results.length} match${results.length === 1 ? '' : 'es'}` });
      },
    });
    return cancelled();
  });
  const summary = { query, root, files, archives: read, failed, matches: results.length, stopped };
  if (from instanceof Viewer) {
    await from.post({ type: 'find', results, summary });
    from.panel.reveal();
  } else if (results.length) {
    const pick = await vscode.window.showQuickPick(results.map((r) => ({ label: r.text, description: `${r.kind} in ${r.cls}`, detail: `${r.rel}${r.jar ? ` › ${r.jar}` : ''}`, r })), { title: `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}" in ${read} archives`, matchOnDescription: true, matchOnDetail: true });
    if (pick) { if (!pick.r.jar) pendingSelect.set(pick.r.file, pick.r.path); await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(pick.r.file), VIEW_TYPE); }
  } else {
    vscode.window.showInformationMessage(`No match for "${query}" in ${read} archives under ${root}.`);
  }
  if (results.length) { await pro.produced('find'); refreshPro(); } // a search with no match does not use a try
}

function refreshPro() { for (const v of viewers) v.post({ type: 'pro', pro: proState() }); }

// ---------------- activation ----------------

function activate(context) {
  ctx = context;
  // Staged JARs left by a crashed window (older than a day) are removed; open editors remove their own on close.
  try {
    const base = path.join(context.globalStorageUri.fsPath, 'tmp');
    for (const d of fs.readdirSync(base)) { const p = path.join(base, d); if (/^cfr-/.test(d) && Date.now() - fs.statSync(p).mtimeMs > 86400000) rmrf(p); }
  } catch { /* no tmp folder yet */ }
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'JAR Viewer' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }));
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.open`, async (uri) => {
    let target = uri && uri.scheme ? uri : null;
    if (!target) {
      const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open', title: 'Open a JAR, WAR, EAR, AAR or class file', filters: { 'Java archives and classes': ['jar', 'war', 'ear', 'aar', 'class'], 'All files': ['*'] } });
      if (!p || !p[0]) return;
      target = p[0];
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  });
  reg(`${PREFIX}.openSample`, async (which) => {
    const name = which === 'class' ? 'Inventory.class' : 'sample-inventory.jar';
    const uri = vscode.Uri.joinPath(context.extensionUri, 'samples', name);
    if (which === 'class' || which === 'jar' || !which) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#jarViewer.start`, false));
  reg(`${PREFIX}.exportSources`, (uri) => exportSources(uri && uri.fsPath ? uri : active));
  reg(`${PREFIX}.compare`, (uri) => compare(uri && uri.fsPath ? uri : active));
  reg(`${PREFIX}.findInFolder`, () => findInFolder(active));
  reg(`${PREFIX}.checkJava`, async () => {
    javaPromise = null;
    const j = await java();
    for (const v of viewers) v.post({ type: 'java', java: javaState(j) });
    if (j.ok) vscode.window.showInformationMessage(`JAR Viewer decompiles with Java ${j.version} (${j.from}: ${j.path}).`);
    else vscode.window.showInformationMessage(`No Java runtime found, so the viewer shows bytecode only. ${j.error} Set ${PREFIX}.javaPath to a java binary or a JDK folder.`);
  });
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro();
    if (e.affectsConfiguration(`${PREFIX}.javaPath`)) {
      javaPromise = null;
      const j = await java();
      for (const v of viewers) { v.sources.clear(); v.post({ type: 'java', java: javaState(j) }); }
    }
  }));
}

function deactivate() { for (const v of viewers) if (v.tmp) rmrf(v.tmp); }

module.exports = { activate, deactivate, listJars, copyTree, decompile, JAR_EXT };
