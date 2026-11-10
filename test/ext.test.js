'use strict';
// The extension host with a stub vscode: activation, opening JARs and classes, decompiling through a fake java (and a
// real one when JAR_VIEWER_TEST_JAVA is set), no network, Pro tries, the panel, the CSP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const B = require('./build');
const { loadExtension, openInViewer } = require('./support/vscode-stub');
const { makeFakeJava } = require('./support/fakejava');
const { buildHtml } = require('../src/html');
const { runCfr, findJava } = require('../src/java');
const { writeZip } = require('../src/core/zipwrite');

process.env.ZOVO_PRO_FILE = path.join(os.tmpdir(), `jarviewer-nopro-${process.pid}.json`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarviewer-ext-'));
const file = (name, buf) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const JAR = file('demo-1.0.jar', B.demoJar());
const JAR2 = file('demo-2.0.jar', B.demoJar({ utilMajor: 65, methods: [{ access: 1, name: 'extra', desc: '(J)Z', code: Buffer.from([0x04, 0xac]) }], files: { 'com/zovo/demo/New.class': B.classFile({ name: 'com/zovo/demo/New' }) } }));
const FAT = file('app.jar', B.jar({ 'BOOT-INF/classes/com/zovo/app/App.class': B.classFile({ name: 'com/zovo/app/App', major: 61 }), 'BOOT-INF/lib/demo-1.0.jar': B.demoJar(), 'BOOT-INF/lib/inner-fat.jar': B.jar({ 'lib/deeper.jar': B.demoJar() }) }));
const CLASS = file('classes/com/zovo/demo/Hello.class', B.helloClass());
file('classes/com/zovo/demo/Hello$Inner.class', B.innerClass());
const TXT = file('notes.jar', Buffer.from('this is text, not a zip archive at all, just text\n'));
const BOMB = file('bomb.jar', writeZip([{ name: 'a/Bomb.class', data: Buffer.alloc(30 << 20), deflate: true }, { name: 'a/Ok.class', data: B.classFile({ name: 'a/Ok' }), deflate: true }]));
const EVIL = file('evil.jar', B.jar({ '../../../tmp/evil/Pwn.class': B.classFile({ name: '../../../tmp/evil/Pwn' }), 'ok/A.class': B.classFile({ name: 'ok/A' }), 'ok/<b>x</b>.properties': 'a=1' }));
const FAKE = makeFakeJava(dir);
const LOG = path.join(dir, 'java.log');
process.env.FAKE_JAVA_LOG = LOG;
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); try { fs.rmSync(process.env.ZOVO_PRO_FILE, { force: true }); } catch { /* none */ } });

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}
const last = (v, type) => v.posted.filter((m) => m.type === type).at(-1);
function boot(javaPath = FAKE) {
  const s = loadExtension();
  s.config.javaPath = javaPath;
  s.ext.activate(s.context);
  return s;
}
const tmpLeft = (s) => { const t = path.join(s.context.globalStorageUri.fsPath, 'tmp'); return fs.existsSync(t) ? fs.readdirSync(t) : []; };

test('activation, a JAR, a class, a resource, decompiling with Java: no network, no message, temp files removed', async () => {
  const nw = trapNetwork();
  const s = boot();
  try {
    assert.ok(s.providers.has('jarViewer.archive'));
    for (const c of ['jarViewer.open', 'jarViewer.openSample', 'jarViewer.exportSources', 'jarViewer.compare', 'jarViewer.findInFolder', 'jarViewer.checkJava', 'jarViewer.getPro', 'jarViewer.enterLicenseKey']) assert.ok(s.commands.has(c), c);
    const v = await openInViewer(s, JAR);
    const m = v.posted[0];
    assert.strictEqual(m.type, 'model');
    assert.strictEqual(m.model.kind, 'jar');
    assert.strictEqual(m.model.classes, 3);
    assert.strictEqual(m.model.mainClass, 'com.zovo.demo.Hello');
    assert.deepStrictEqual(m.java, { ok: true, version: '21.0.9', from: 'setting' });
    assert.deepStrictEqual(m.pro.tries, { export: 3, compare: 3, find: 3 });
    fs.writeFileSync(LOG, '');
    await v.send({ type: 'class', path: 'com/zovo/demo/Hello$Inner.class' });
    const c = last(v, 'class');
    assert.strictEqual(c.cls.name, 'com.zovo.demo.Hello$Inner');
    const src = last(v, 'source');
    assert.match(src.text, /Decompiled with CFR 0\.152[\s\S]*public class com\.zovo\.demo\.Hello \{ \/\* inner: 1 \*\/ \}/);
    const args = JSON.parse(fs.readFileSync(LOG, 'utf8').trim());
    assert.strictEqual(args[0], '-Xmx512m');
    const input = args[args.indexOf('-jar') + 2];
    assert.ok(input.startsWith(path.join(s.context.globalStorageUri.fsPath, 'tmp') + path.sep), input);
    assert.match(path.basename(input), /^in-[0-9a-f]{12}\.jar$/);
    assert.deepStrictEqual(args.slice(args.indexOf('-jar') + 3), ['--jarfilter', '^com\\.zovo\\.demo\\.Hello$', '--silent', 'true']);
    assert.strictEqual(tmpLeft(s).length, 1, 'one staged JAR while the editor is open');
    // cached: the outer class does not run CFR again
    await v.send({ type: 'class', path: 'com/zovo/demo/Hello.class' });
    assert.strictEqual(fs.readFileSync(LOG, 'utf8').trim().split('\n').length, 1);
    await v.send({ type: 'resource', path: 'config/app.properties' });
    assert.strictEqual(last(v, 'resource').res.text, 'greeting=hello\nmode=test\n');
    // another class reuses the staged JAR
    await v.send({ type: 'decompile', path: 'com/zovo/demo/util/Strings.class' });
    assert.match(last(v, 'source').text, /public class com\.zovo\.demo\.util\.Strings/);
    assert.ok(!/Hello/.test(last(v, 'source').text));
    assert.strictEqual(tmpLeft(s).length, 1);
    v.panel.dispose();
    assert.deepStrictEqual(tmpLeft(s), [], 'staged JAR removed when the editor closes');
    await v.send({ type: 'rendered' });
    assert.deepStrictEqual(nw.calls, []);
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length], [0, 0, 0], 'no message on open');
    assert.deepStrictEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('quick clicks run one CFR at a time; the newest class wins', async () => {
  const s = boot(makeFakeJava(dir, { sleepMs: 300 }));
  try {
    fs.writeFileSync(LOG, '');
    const v = await openInViewer(s, JAR2);
    const p1 = v.send({ type: 'decompile', path: 'com/zovo/demo/Hello.class' });
    const p2 = v.send({ type: 'decompile', path: 'com/zovo/demo/New.class' });
    const p3 = v.send({ type: 'decompile', path: 'com/zovo/demo/util/Strings.class' });
    await Promise.all([p1, p2, p3]);
    await new Promise((r) => setTimeout(r, 1500));
    const runs = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
    assert.strictEqual(runs, 2, 'the middle request was replaced by the newest');
    assert.deepStrictEqual(v.posted.filter((m) => m.type === 'source').map((m) => m.path), ['com/zovo/demo/Hello.class', 'com/zovo/demo/util/Strings.class']);
  } finally { s.restore(); }
});

test('a .class file opens on its own and is decompiled with its inner class from the same folder', async () => {
  const s = boot();
  try {
    fs.writeFileSync(LOG, '');
    const v = await openInViewer(s, CLASS);
    const m = v.posted[0];
    assert.strictEqual(m.model.kind, 'classfile');
    assert.strictEqual(m.model.cls.decl, 'public class com.zovo.demo.Hello implements java.lang.Comparable<com.zovo.demo.Hello>');
    await v.send({ type: 'decompile', path: '' });
    assert.match(last(v, 'source').text, /inner: 1/);
  } finally { s.restore(); }
});

test('without Java: a model, the bytecode, and source "nojava"; no popup', async () => {
  const s = boot(path.join(dir, 'no-such-java'));
  try {
    const v = await openInViewer(s, JAR);
    assert.strictEqual(v.posted[0].java.ok, false);
    assert.strictEqual(v.posted[0].java.explicit, true);
    await v.send({ type: 'class', path: 'com/zovo/demo/Hello.class' });
    assert.ok(last(v, 'class').cls.listing.length > 10);
    assert.strictEqual(last(v, 'source').error, 'nojava');
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length], [0, 0, 0]);
  } finally { s.restore(); }
});

test('nested JARs open one level deep; a second level is refused; back returns to the outer JAR', async () => {
  const s = boot();
  try {
    const v = await openInViewer(s, FAT);
    assert.deepStrictEqual(v.posted[0].model.nested, ['BOOT-INF/lib/demo-1.0.jar', 'BOOT-INF/lib/inner-fat.jar']);
    await v.send({ type: 'nested', path: 'BOOT-INF/lib/inner-fat.jar' });
    const n = last(v, 'model');
    assert.strictEqual(n.model.nestedIn, 'app.jar');
    assert.deepStrictEqual(n.model.nested, ['lib/deeper.jar']);
    await v.send({ type: 'nested', path: 'lib/deeper.jar' });
    assert.match(last(v, 'notice').text, /one level deep/);
    await v.send({ type: 'nested', path: '' });
    await v.send({ type: 'nested', path: 'BOOT-INF/lib/demo-1.0.jar' });
    await v.send({ type: 'class', path: 'com/zovo/demo/Hello.class' });
    assert.strictEqual(last(v, 'class').cls.name, 'com.zovo.demo.Hello');
    assert.match(last(v, 'source').text, /com\.zovo\.demo\.Hello/);
  } finally { s.restore(); }
});

test('hostile archives: a text file, a zip bomb entry, traversal names; the host keeps working', async () => {
  const s = boot();
  try {
    const t = await openInViewer(s, TXT);
    assert.strictEqual(t.posted[0].type, 'error');
    assert.strictEqual(t.posted[0].notJar, true);
    const b = await openInViewer(s, BOMB);
    assert.strictEqual(b.posted[0].type, 'model');
    await b.send({ type: 'class', path: 'a/Bomb.class' });
    assert.match(last(b, 'class').error, /zip bomb|the limit is/);
    await b.send({ type: 'class', path: 'a/Ok.class' });
    assert.strictEqual(last(b, 'class').cls.name, 'a.Ok');
    const e = await openInViewer(s, EVIL);
    const evil = e.posted[0].model.entries.find((x) => x.p === 'tmp/evil/Pwn.class');
    assert.ok(evil.u);
    await e.send({ type: 'class', path: 'tmp/evil/Pwn.class' });
    assert.match(last(e, 'source').error || '', /cannot be decompiled safely/);
    assert.ok(!fs.existsSync('/tmp/evil/Pwn.java'));
    const ok = await openInViewer(s, JAR);
    assert.strictEqual(ok.posted[0].type, 'model');
  } finally { s.restore(); }
});

test('export: Escape keeps the try; 3 exports write .java files; the 4th click shows the panel; unsafe names stay inside', async () => {
  const s = boot();
  try {
    const v = await openInViewer(s, EVIL);
    s.ui.open.push(undefined);
    await v.send({ type: 'tool', tool: 'export' });
    assert.strictEqual((s.state.get('jarViewer.proTrial') || {}).export, undefined, 'cancel uses no try');
    const outRoot = fs.mkdtempSync(path.join(dir, 'export-'));
    for (let i = 1; i <= 3; i++) {
      s.ui.open.push([s.vscode.Uri.file(outRoot)]);
      await v.send({ type: 'tool', tool: 'export' });
      assert.strictEqual(s.state.get('jarViewer.proTrial').export, i);
    }
    assert.deepStrictEqual(fs.readdirSync(outRoot).sort(), ['evil-src', 'evil-src-2', 'evil-src-3']);
    assert.ok(fs.existsSync(path.join(outRoot, 'evil-src', 'ok', 'A.java')));
    assert.ok(!fs.existsSync(path.join(outRoot, 'tmp')) && !fs.existsSync('/tmp/evil'));
    assert.match(last(v, 'exported').text, /^Wrote 1 Java source files to /);
    assert.ok(s.log.status.some((t) => /free try 3 of 3/.test(t)));
    assert.deepStrictEqual(tmpLeft(s), []);
    s.ui.info.push(undefined); // Cancel
    await v.send({ type: 'tool', tool: 'export' });
    assert.strictEqual(s.log.info.length, 1);
    const panel = s.log.info[0];
    assert.match(panel.text, /Export decompiled sources is part of Zovo Pro/);
    assert.strictEqual(panel.opts.modal, true);
    assert.deepStrictEqual(panel.buttons.slice(0, 4), ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key']);
    assert.match(panel.opts.detail, /You used the 3 free tries/);
    assert.match(panel.opts.detail, /Compare two JARs/);
    assert.ok(!/refund/i.test(panel.opts.detail));
    assert.strictEqual(fs.readdirSync(outRoot).length, 3, 'nothing written after the tries');
    assert.deepStrictEqual(last(v, 'pro').pro.tries, { export: 0, compare: 3, find: 3 });
  } finally { s.restore(); }
});

test('export without Java writes bytecode listings and says so', async () => {
  const s = boot(path.join(dir, 'missing-java'));
  try {
    const v = await openInViewer(s, JAR);
    const outRoot = fs.mkdtempSync(path.join(dir, 'export-nojava-'));
    s.ui.open.push([s.vscode.Uri.file(outRoot)]);
    await v.send({ type: 'tool', tool: 'export' });
    assert.match(last(v, 'exported').text, /3 bytecode listings \(no Java runtime found/);
    assert.match(fs.readFileSync(path.join(outRoot, 'demo-1.0-src', 'com', 'zovo', 'demo', 'Hello.txt'), 'utf8'), /tableswitch/);
    assert.strictEqual(s.state.get('jarViewer.proTrial').export, 1);
  } finally { s.restore(); }
});

test('Pay by card opens the card checkout with an install id (module card1)', async () => {
  const s = boot();
  try {
    s.state.set('jarViewer.proTrial', { find: 3 });
    const v = await openInViewer(s, JAR);
    s.ui.info.push('Pay by card (USD 19)');
    await v.send({ type: 'tool', tool: 'find' });
    assert.match(s.log.external.map(String).join(' '), /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[\w-]+$/);
    assert.ok(!v.posted.some((m) => m.type === 'find'));
  } finally { s.restore(); }
});

test('Get Zovo Pro with GitHub Sponsors opens the USD 19 tier, never the generic Sponsors page', async () => {
  const s = boot();
  try {
    s.state.set('jarViewer.proTrial', { compare: 3 });
    const v = await openInViewer(s, JAR);
    s.ui.info.push('Get Zovo Pro with GitHub Sponsors');
    await v.send({ type: 'tool', tool: 'compare' });
    assert.deepStrictEqual(s.log.external.map(String).filter((u) => /github\.com\/sponsors/.test(u)), ['https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878']);
    assert.ok(!v.posted.some((m) => m.type === 'compare'));
  } finally { s.restore(); }
});

test('compare: cancel keeps the try; a comparison on screen uses one; Markdown report', async () => {
  const s = boot();
  try {
    const v = await openInViewer(s, JAR);
    s.ui.open.push(undefined);
    await v.send({ type: 'tool', tool: 'compare' });
    assert.strictEqual((s.state.get('jarViewer.proTrial') || {}).compare, undefined);
    s.ui.open.push([s.vscode.Uri.file(JAR2)]);
    await v.send({ type: 'tool', tool: 'compare' });
    const c = last(v, 'compare');
    assert.deepStrictEqual(c.result.added, ['com.zovo.demo.New']);
    const hello = c.result.changed.find((x) => x.name === 'com.zovo.demo.Hello');
    assert.deepStrictEqual(hello.methodsAdded, ['public boolean extra(long)']);
    const strings = c.result.changed.find((x) => x.name === 'com.zovo.demo.util.Strings');
    assert.deepStrictEqual(strings.notes, ['Java version Java 17 → Java 21']);
    assert.strictEqual(s.state.get('jarViewer.proTrial').compare, 1);
    await v.send({ type: 'saveCompare' });
    const doc = s.log.opened.at(-1);
    assert.match(doc.getText(), /# demo-1\.0\.jar compared with demo-2\.0\.jar[\s\S]*Classes added in demo-2\.0\.jar \(1\)[\s\S]*Method added: `public boolean extra\(long\)`/);
  } finally { s.restore(); }
});

test('find in folder: no match uses no try; matches (also in nested JARs) are listed and use one', async () => {
  const s = boot();
  try {
    s.vscode.workspace.workspaceFolders = [{ name: 'w', uri: s.vscode.Uri.file(dir) }];
    const v = await openInViewer(s, JAR);
    s.ui.input.push('NoSuchName_xyz');
    await v.send({ type: 'tool', tool: 'find' });
    assert.strictEqual(last(v, 'find').results.length, 0);
    assert.strictEqual((s.state.get('jarViewer.proTrial') || {}).find, undefined);
    s.ui.input.push('Hello, JAR');
    await v.send({ type: 'tool', tool: 'find' });
    const r = last(v, 'find');
    assert.ok(r.results.every((x) => x.kind === 'string'));
    const where = [...new Set(r.results.map((x) => `${path.basename(x.file)}${x.jar ? `!${x.jar}` : ''}`))].sort();
    assert.ok(where.includes('demo-1.0.jar') && where.includes('app.jar!BOOT-INF/lib/demo-1.0.jar'), where.join());
    assert.strictEqual(s.state.get('jarViewer.proTrial').find, 1);
    s.ui.input.push('/^pick$/');
    await v.send({ type: 'tool', tool: 'find' });
    assert.ok(last(v, 'find').results.some((x) => x.kind === 'method' && x.text === 'public static int pick(int)'));
    s.ui.input.push('(a+)+');
    await v.send({ type: 'tool', tool: 'find' }); // plain text, not a regex: no match, no try
    assert.strictEqual(s.state.get('jarViewer.proTrial').find, 2);
  } finally { s.restore(); }
});

test('showProTools false hides the buttons (pro.show false); nothing about Pro on open', async () => {
  const s = boot();
  try {
    s.config.showProTools = false;
    const v = await openInViewer(s, JAR);
    assert.strictEqual(v.posted[0].pro.show, false);
    assert.strictEqual(s.log.info.length + s.log.warn.length, 0);
  } finally { s.restore(); }
});

test('CSP: nonce script, no unsafe-inline, no remote origin', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/main.js', styleUri: 'vscode-webview://x/main.css', title: '<b>x</b>', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp), csp);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.match(html, /<title>&lt;b&gt;x&lt;\/b&gt;<\/title>/);
});

test('CFR runner: timeout kills the process, cancel kills it, a failing java gives its message', async () => {
  const slow = makeFakeJava(dir, { sleepMs: 5000 });
  const input = file('in.jar', B.demoJar());
  const t = Date.now();
  const r = await runCfr(slow, input, [], { timeoutMs: 300 });
  assert.strictEqual(r.timedOut, true);
  assert.ok(Date.now() - t < 3000);
  let cancelFn;
  const p = runCfr(slow, input, [], { timeoutMs: 10000, cancel: { onCancel: (f) => { cancelFn = f; } } });
  setTimeout(() => cancelFn(), 100);
  assert.strictEqual((await p).cancelled, true);
  const bad = makeFakeJava(dir, { fail: true });
  const rb = await runCfr(bad, input, []);
  assert.strictEqual(rb.code, 1);
  assert.match(rb.stderr, /OutOfMemoryError/);
  const old = await findJava(makeFakeJava(dir, { version: '1.7.0_80' }));
  assert.strictEqual(old.ok, false);
  assert.match(old.error, /too old/);
  const j8 = await findJava(makeFakeJava(dir, { version: '1.8.0_402' }));
  assert.strictEqual(j8.major, 8);
});

test('real CFR on a real Java (runs when JAR_VIEWER_TEST_JAVA is set)', { skip: !process.env.JAR_VIEWER_TEST_JAVA && 'JAR_VIEWER_TEST_JAVA not set' }, async () => {
  const s = boot(process.env.JAR_VIEWER_TEST_JAVA);
  try {
    const v = await openInViewer(s, JAR);
    assert.strictEqual(v.posted[0].java.ok, true);
    await v.send({ type: 'class', path: 'com/zovo/demo/Hello.class' });
    const src = last(v, 'source');
    assert.ok(src.text, src.error);
    assert.match(src.text, /Decompiled with CFR 0\.152/);
    assert.match(src.text, /public class Hello\s+implements Comparable<Hello>/);
    assert.match(src.text, /public static final String GREETING = "Hello, JAR";/);
    assert.match(src.text, /case 1:/);
    assert.ok(!/Could not load/.test(src.text), 'the other classes of the JAR resolve');
    v.panel.dispose();
    assert.deepStrictEqual(tmpLeft(s), []);
  } finally { s.restore(); }
});
