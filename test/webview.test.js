'use strict';
// Runs media/main.js in jsdom with real models: the package tree, filter, selecting a class, the class tabs, the
// no-Java line, hostile names as text, styles through the CSSOM (the CSP drops style attributes), the Pro buttons.
// jsdom is not a dependency of this extension: the test uses JSDOM_PATH or the copy in a sibling product.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('./build');
const { BufferSource } = require('../src/core/source');
const J = require('../src/core/jar');
const { parseClass } = require('../src/core/classfile');

const candidates = [process.env.JSDOM_PATH, path.join(__dirname, '..', 'node_modules', 'jsdom'), path.join(__dirname, '..', '..', 'docx-viewer-vscode', 'node_modules', 'jsdom')].filter(Boolean);
let JSDOM = null;
for (const c of candidates) { try { ({ JSDOM } = require(c)); break; } catch { /* next */ } }
const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

function boot(model, { java = { ok: true, version: '21.0.9', from: 'PATH' }, pro = { show: true, licensed: false, tries: { export: 3, compare: 2, find: 1 } }, name = 'demo.jar' } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div><template id="zovo-footer"><div id="zovo-support">Rate</div></template></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) });
  dom.window.eval(script);
  const send = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
  send({ type: 'model', model, name, java, pro });
  return { dom, doc: dom.window.document, sent, send };
}
const jarModel = (buf, name = 'demo.jar') => J.jarModel(J.openZip(new BufferSource(buf)), { name });

test('webview: tree, filter, select a class, tabs, source and bytecode, footer, Pro buttons', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, sent, send } = boot(jarModel(B.demoJar()));
  assert.deepStrictEqual(sent.map((m) => m.type), ['ready', 'rendered']);
  assert.match(doc.querySelector('.desc').textContent, /JAR · .* · 3 classes · up to Java 17/);
  assert.deepStrictEqual([...doc.querySelectorAll('[data-tool]')].map((b) => b.textContent), ['Export sources…', 'Compare…', 'Find in folder…']);
  assert.match(doc.querySelector('[data-tool="find"]').title, /1 free try left/);
  assert.ok(doc.getElementById('zovo-support'), 'footer');
  // 4 folders, 3 or fewer start open... here 4 dirs: none open, rows are folders
  const dirs = [...doc.querySelectorAll('.node.dir .nm')].map((n) => n.textContent);
  assert.deepStrictEqual(dirs, ['com.zovo.demo', 'com.zovo.demo.util', 'config/', 'META-INF/']);
  // the virtual list height is set through the CSSOM
  assert.strictEqual(doc.querySelector('.treebody .spacer').style.getPropertyValue('height'), `${4 * 22}px`);
  // filter shows matching files under their folders
  const f = doc.querySelector('.tree .filter');
  f.value = 'inner';
  f.dispatchEvent(new doc.defaultView.Event('input'));
  return new Promise((resolve) => setTimeout(() => {
    const files = [...doc.querySelectorAll('.node.file')].map((n) => n.getAttribute('data-path'));
    assert.deepStrictEqual(files, ['com/zovo/demo/Hello$Inner.class']);
    doc.querySelector('.node.file').click();
    assert.deepStrictEqual(sent.at(-1), { type: 'class', path: 'com/zovo/demo/Hello$Inner.class' });
    const cls = parseClass(B.helloClass());
    send({ type: 'class', path: 'com/zovo/demo/Hello$Inner.class', cls });
    assert.match(doc.querySelector('.view .pad').textContent, /Decompiling com\.zovo\.demo\.Hello with CFR/);
    send({ type: 'source', path: 'com/zovo/demo/Hello$Inner.class', text: '/*\n * Decompiled with CFR 0.152.\n */\npublic class Hello {\n    String s = "x";\n}\n' });
    const lines = [...doc.querySelectorAll('.ln .lt')].map((l) => l.textContent);
    assert.strictEqual(lines[3], 'public class Hello {');
    assert.ok(doc.querySelector('.ln .t-k'), 'keywords marked');
    assert.match(doc.querySelector('.tools .muted').textContent, /shown with its outer class/);
    const tabs = [...doc.querySelectorAll('.tabs.sub .tab')].map((t) => t.getAttribute('data-tab'));
    assert.deepStrictEqual(tabs, ['source', 'bytecode', 'members', 'pool', 'info']);
    doc.querySelector('[data-tab="bytecode"]').click();
    assert.ok([...doc.querySelectorAll('.ln .lt')].some((l) => /tableswitch/.test(l.textContent)));
    doc.querySelector('[data-tab="members"]').click();
    assert.ok([...doc.querySelectorAll('.grid td')].some((td) => td.textContent === 'public static <T> T firstOf(T...)'));
    doc.querySelector('[data-tab="info"]').click();
    assert.match(doc.querySelector('.kv').textContent, /Java 8 \(class file 52\.0\)/);
    doc.querySelector('[data-tab="pool"]').click();
    assert.ok([...doc.querySelectorAll('.ln .lt')].some((l) => /String +#\d+ +Hello, JAR/.test(l.textContent)));
    resolve();
  }, 200));
});

test('webview: without Java the source tab shows one plain line and the bytecode tab opens first', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, sent, send } = boot(jarModel(B.demoJar()), { java: { ok: false, error: 'none' } });
  assert.match(doc.querySelector('.javaline').textContent, /needs a Java runtime \(8 or newer\): set jarViewer\.javaPath, or JAVA_HOME, or put java on PATH/);
  [...doc.querySelectorAll('.node.dir')].find((n) => n.textContent.startsWith('▸com.zovo.demo2')).click();
  doc.querySelector('[data-path="com/zovo/demo/Hello.class"]').click();
  send({ type: 'class', path: 'com/zovo/demo/Hello.class', cls: parseClass(B.helloClass()) });
  assert.strictEqual(doc.querySelector('.tabs.sub .tab.on').getAttribute('data-tab'), 'bytecode');
  doc.querySelector('[data-tab="source"]').click();
  assert.ok(doc.querySelector('.view .javaline'));
  doc.querySelector('.javaline a').click();
  assert.deepStrictEqual(sent.at(-1), { type: 'settings', java: true });
});

test('webview: hostile names and strings stay text; nested JARs and the back button', { skip: !JSDOM && 'jsdom not found' }, () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const buf = B.jar({ [`${evil}/a.class`]: B.classFile({ name: 'a' }), 'BOOT-INF/lib/x.jar': B.demoJar(), 'n/<b>bold</b>.txt': 'x' });
  const { doc, sent, send, dom } = boot(jarModel(buf, 'fat.jar'));
  assert.strictEqual(doc.querySelectorAll('img').length, 0);
  assert.strictEqual(doc.querySelectorAll('b b').length, 0);
  assert.ok([...doc.querySelectorAll('.node.dir .nm')].some((n) => n.textContent === evil));
  doc.querySelector('[data-nested="BOOT-INF/lib/x.jar"]').click();
  assert.deepStrictEqual(sent.at(-1), { type: 'nested', path: 'BOOT-INF/lib/x.jar' });
  const nested = jarModel(B.demoJar(), 'x.jar'); nested.nestedIn = 'fat.jar';
  send({ type: 'model', model: nested, name: 'fat.jar' });
  assert.strictEqual(doc.querySelector('.fname').textContent, 'x.jar');
  doc.querySelector('[data-act="back"]').click();
  assert.deepStrictEqual(sent.at(-1), { type: 'nested', path: '' });
  // a class with a hostile string constant
  const cls = parseClass(B.helloClass({ greeting: evil, message: evil }));
  const c = boot({ kind: 'classfile', name: 'Hello.class', size: 100, cls }, { name: 'Hello.class' });
  c.doc.querySelector('[data-tab="pool"]').click();
  assert.ok([...c.doc.querySelectorAll('.ln .lt')].some((l) => l.textContent.includes(evil)));
  assert.strictEqual(c.doc.querySelectorAll('img').length, 0);
  assert.strictEqual(dom.window.pwned, undefined);
});

test('webview: showProTools false hides the Pro buttons; compare and find views', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, send, sent } = boot(jarModel(B.demoJar()), { pro: { show: false, tries: {} } });
  assert.strictEqual(doc.querySelectorAll('[data-tool]').length, 0);
  send({ type: 'compare', nameA: 'a.jar', nameB: 'b.jar', result: { classesA: 3, classesB: 4, same: 1, added: ['x.New'], removed: [], changed: [{ name: 'x.Hello', notes: ['Java version Java 8 → Java 17'], methodsAdded: ['public void m()'], methodsRemoved: [], fieldsAdded: [], fieldsRemoved: [] }], addedCount: 1, removedCount: 0, changedCount: 1, versionsA: [['Java 8', 3]], versionsB: [['Java 17', 4]], resources: { added: [], removed: [], changed: [] }, problems: [] } });
  assert.match(doc.querySelector('.view').textContent, /1 added, 0 removed, 1 changed, 1 the same/);
  assert.ok([...doc.querySelectorAll('.diff.add li')].some((l) => l.textContent === 'public void m()'));
  send({ type: 'find', results: [{ kind: 'method', text: 'public static int pick(int)', cls: 'a.B', file: '/w/a.jar', rel: 'a.jar', path: 'a/B.class', jar: '' }], summary: { query: 'pick', root: '/w', files: 2, archives: 2, matches: 1 } });
  doc.querySelector('.findrow').click();
  assert.deepStrictEqual(sent.at(-1), { type: 'openFile', path: '/w/a.jar', select: 'a/B.class' });
});

test('css: every virtual list scrolls in its own box (the absolute row layer needs a positioned, scrolling .tbody)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.css'), 'utf8');
  const rule = (sel) => { const m = new RegExp(`(^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css); return m ? m[2] : ''; };
  const tb = rule('.tbody');
  assert.match(tb, /position:\s*relative/);
  assert.match(tb, /overflow:\s*auto/);
  assert.match(tb, /min-height:\s*0/);
  assert.match(tb, /flex:\s*1/);
  assert.match(rule('.layer'), /position:\s*absolute/);
  // every element that holds a .layer is a .tbody
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  assert.ok((js.match(/class: 'tbody[ '][^']*'/g) || []).length >= 2);
});
