'use strict';
// Pro tool cores (compare, find, the regex guard), the staging JAR for CFR, and the worker watchdog.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./build');
const { BufferSource, FileSource } = require('../src/core/source');
const J = require('../src/core/jar');
const tools = require('../src/core/tools');
const { runJob, findInFiles } = require('../src/runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarviewer-tools-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const open = (buf) => J.openZip(new BufferSource(buf));

test('compare: added, removed, changed classes, signatures, Java versions, resources; Markdown', () => {
  const a = open(B.demoJar());
  const b = open(B.jar({
    'com/zovo/demo/Hello.class': B.helloClass({ methods: [{ access: 1, name: 'size', desc: '()I', code: Buffer.from([0x03, 0xac]) }] }),
    'com/zovo/demo/util/Strings.class': B.classFile({ name: 'com/zovo/demo/util/Strings', major: 65, methods: [{ access: 9, name: 'trim', desc: '(Ljava/lang/String;)Ljava/lang/String;', code: Buffer.from([0x2a, 0xb0]) }] }),
    'com/zovo/demo/Added.class': B.classFile({ name: 'com/zovo/demo/Added' }),
    'config/app.properties': 'greeting=bye\n',
    'config/new.xml': '<a/>',
  }));
  const r = tools.compareJars(a, b);
  assert.deepStrictEqual(r.added, ['com.zovo.demo.Added']);
  assert.deepStrictEqual(r.removed, ['com.zovo.demo.Hello$Inner']);
  assert.deepStrictEqual(r.changed.map((c) => c.name), ['com.zovo.demo.Hello', 'com.zovo.demo.util.Strings']);
  assert.deepStrictEqual(r.changed[0].methodsAdded, ['public int size()']);
  assert.deepStrictEqual(r.changed[1].notes, ['Java version Java 17 → Java 21']);
  assert.deepStrictEqual(r.resources, { added: ['config/new.xml'], removed: [], changed: ['config/app.properties'] });
  const md = tools.compareMarkdown(r, 'a_1.jar', 'b<2>.jar');
  assert.match(md, /^# a\\_1\.jar compared with b\\<2\\>\.jar/);
  assert.match(md, /\| Java versions \| Java 8: 2, Java 17: 1 \| Java 8: 2, Java 21: 1 \|/);
  assert.match(md, /- Method added: `public int size\(\)`/);
});

test('find: class names, methods, fields and strings; the regex guard', () => {
  const j = open(B.demoJar());
  const m = (q) => tools.findInJar(j, tools.matcher(q)).map((h) => `${h.kind}:${h.text}`);
  assert.deepStrictEqual(m('Strings'), ['class:com.zovo.demo.util.Strings']);
  assert.deepStrictEqual(m('hello, jar').sort(), ['string:"Hello, JAR"']);
  assert.deepStrictEqual(m('/^GREET/'), ['field:public static final java.lang.String GREETING = "Hello, JAR"']);
  assert.ok(m('trim').includes('method:public static java.lang.String trim(java.lang.String)'));
  assert.throws(() => tools.matcher('/(a+)+$/'), /repeated group inside a repeat/);
  assert.strictEqual(tools.matcher('  '), null);
});

test('stage: the JAR for CFR holds only classes whose name matches their path and is safe', async () => {
  const src = path.join(dir, 'mixed.jar');
  fs.writeFileSync(src, B.jar({
    'ok/A.class': B.classFile({ name: 'ok/A' }),
    'ok/Liar.class': B.classFile({ name: 'other/Name' }),
    '../up/B.class': B.classFile({ name: '../up/B' }),
    'ok/A$1.class': B.classFile({ name: 'ok/A$1' }),
    'META-INF/versions/11/ok/A.class': B.classFile({ name: 'ok/A' }),
    'ok/broken.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0]),
  }));
  const out = path.join(dir, 'staged.jar');
  const r = await runJob({ op: 'stage', file: src, out });
  assert.deepStrictEqual(r.names.sort(), ['ok/A$1.class', 'ok/A.class']);
  assert.strictEqual(r.skippedCount, 3);
  const st = J.openZip(new FileSource(out));
  assert.deepStrictEqual(st.zip.entries.map((e) => e.path).sort(), ['ok/A$1.class', 'ok/A.class']);
  st.src.close();
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  const g = await runJob({ op: 'stage', file: src, groupOf: 'ok/A$1.class', out: path.join(dir, 'g.jar') });
  assert.deepStrictEqual(g.names.sort(), ['ok/A$1.class', 'ok/A.class']);
});

test('worker: open errors carry their code; the watchdog stops a job; find skips a broken JAR', async () => {
  const txt = path.join(dir, 'x.jar');
  fs.writeFileSync(txt, 'not a zip, just text that is long enough to be read');
  await assert.rejects(runJob({ op: 'open', file: txt, name: 'x.jar' }), (e) => e.code === 'NOT_JAR');
  const big = path.join(dir, 'big.jar');
  fs.writeFileSync(big, B.jar(Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`p${i % 50}/C${i}.class`, B.classFile({ name: `p${i % 50}/C${i}`, methods: [{ access: 9, name: 'all', desc: '()V', code: B.allOpcodes().code }] })]))));
  await assert.rejects(runJob({ op: 'open', file: big, name: 'big.jar' }, { idleMs: 5 }), (e) => e.code === 'TIMEOUT');
  assert.strictEqual((await runJob({ op: 'open', file: big, name: 'big.jar' })).classes, 4000);
  const good = path.join(dir, 'good.jar');
  fs.writeFileSync(good, B.demoJar());
  const seen = [];
  await findInFiles([txt, good], 'Strings', { onFile: (p) => seen.push([path.basename(p.file), p.hits.length, !!p.error]) });
  assert.deepStrictEqual(seen, [['x.jar', 0, true], ['good.jar', 1, false]]);
});
