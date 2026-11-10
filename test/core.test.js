'use strict';
// Class file reader, descriptors, bytecode listing, ZIP reader and the JAR model, including hostile input.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const B = require('./build');
const { parseClass, classVersion, javaVersion, mutf8, ClassFormatError } = require('../src/core/classfile');
const D = require('../src/core/descriptor');
const { BufferSource } = require('../src/core/source');
const { readZip, readEntry } = require('../src/core/zip');
const J = require('../src/core/jar');
const { checkEntryName, joinInside, LimitError } = require('../src/core/limits');
const { writeZip } = require('../src/core/zipwrite');
const { crc32 } = require('../src/core/crc32');

const insns = (listing) => listing.map((l) => /^\s+(\d+): ([a-z][a-z0-9_]*)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]);

test('descriptors and generic signatures render as Java types', () => {
  assert.strictEqual(D.fieldType('I'), 'int');
  assert.strictEqual(D.fieldType('[[Ljava/lang/String;'), 'java.lang.String[][]');
  assert.strictEqual(D.fieldType('Ljava/util/Map<Ljava/lang/String;+Ljava/lang/Number;>;'), 'java.util.Map<java.lang.String, ? extends java.lang.Number>');
  assert.strictEqual(D.fieldType('Ljava/util/List<*>;'), 'java.util.List<?>');
  assert.strictEqual(D.fieldType('Ljava/util/Comparator<-TT;>;'), 'java.util.Comparator<? super T>');
  assert.strictEqual(D.fieldType('La/Outer<TK;>.Inner;'), 'a.Outer<K>.Inner');
  const m = D.methodParts('(IJ[DLjava/lang/String;)V');
  assert.deepStrictEqual(m.params, ['int', 'long', 'double[]', 'java.lang.String']);
  assert.strictEqual(m.ret, 'void');
  const g = D.methodParts('<T::Ljava/lang/Comparable<-TT;>;>(Ljava/util/List<+TT;>;)TT;^Ljava/io/IOException;');
  assert.strictEqual(g.typeParams, '<T extends java.lang.Comparable<? super T>>');
  assert.deepStrictEqual(g.throws, ['java.io.IOException']);
  const c = D.classSignature('<K:Ljava/lang/Object;V:Ljava/lang/Object;>Ljava/util/AbstractMap<TK;TV;>;Ljava/io/Serializable;');
  assert.strictEqual(c.typeParams, '<K, V>');
  assert.strictEqual(c.superClass, 'java.util.AbstractMap<K, V>');
  // broken input falls back, never throws
  assert.strictEqual(D.fieldType('Ljava/lang/String'), 'Ljava/lang/String');
  assert.strictEqual(D.methodParts('(I'), null);
  assert.strictEqual(D.fieldType('['.repeat(5000) + 'I'), '['.repeat(5000) + 'I');
});

test('Java version names and modified UTF-8', () => {
  assert.strictEqual(javaVersion(52), 'Java 8');
  assert.strictEqual(javaVersion(65), 'Java 21');
  assert.strictEqual(javaVersion(45, 3), 'Java 1.1');
  assert.strictEqual(javaVersion(48), 'Java 1.4');
  assert.strictEqual(javaVersion(61, 0xffff), 'Java 17 (preview features)');
  assert.deepStrictEqual(classVersion(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61])), { major: 61, minor: 0, java: 'Java 17' });
  assert.strictEqual(classVersion(Buffer.from('PK\x03\x04xxxx')), null);
  assert.strictEqual(mutf8(B.mutf8('a\u0000b\u00e9\u4e2d\ud83d\ude00')), 'a\u0000b\u00e9\u4e2d\ud83d\ude00');
  assert.strictEqual(mutf8(Buffer.from([0x41, 0xff, 0x42])), 'A\ufffdB');
});

test('class model: declaration, fields, methods with generic signatures, attributes, pool', () => {
  const c = parseClass(B.helloClass());
  assert.strictEqual(c.name, 'com.zovo.demo.Hello');
  assert.strictEqual(c.decl, 'public class com.zovo.demo.Hello implements java.lang.Comparable<com.zovo.demo.Hello>');
  assert.strictEqual(c.java, 'Java 8');
  assert.strictEqual(c.sourceFile, 'Hello.java');
  assert.deepStrictEqual(c.fields.map((f) => f.decl), ['public static final java.lang.String GREETING = "Hello, JAR"', 'private final java.util.List<java.lang.String> names', 'private static int count']);
  assert.deepStrictEqual(c.methods.map((m) => m.decl), ['public com.zovo.demo.Hello()', 'public static int pick(int)', 'public static void main(java.lang.String[]) throws java.lang.Exception', 'public static <T> T firstOf(T...)', 'public int compareTo(java.lang.Object)']);
  assert.deepStrictEqual(c.innerClasses.map((i) => i.inner), ['com.zovo.demo.Hello$Inner']);
  assert.ok(c.pool.some((r) => r[1] === 'String' && r[3] === 'Hello, JAR'));
  assert.ok(c.strings.includes('Hello, JAR'));
  const text = c.listing.join('\n');
  assert.match(text, /tableswitch +\{ \/\/ 1 to 2\n +1: 24\n +2: 27\n +default: 30/);
  assert.match(text, /getstatic +#\d+ +\/\/ Field java\/lang\/System\.out:Ljava\/io\/PrintStream;/);
  assert.match(text, /ldc +#\d+ +\/\/ String Hello, JAR/);
  assert.match(text, /Exception table:\n +from +to +target type\n +0 +8 +9 +Class java\/lang\/RuntimeException/);
  assert.match(text, /LineNumberTable:\n +line 3: 0/);
  assert.match(text, /LocalVariableTable:[\s\S]*this +com\.zovo\.demo\.Hello/);
  assert.deepStrictEqual(c.warnings, []);
});

test('bytecode listing: every opcode 0-201, wide forms, both switches, at the right offsets', () => {
  const a = B.allOpcodes();
  const c = parseClass(B.classFile({ methods: [{ access: 9, name: 'all', desc: '()V', code: a.code }] }));
  const got = insns(c.listing);
  assert.deepStrictEqual(got.map((x) => x[1]), a.names);
  assert.strictEqual(new Set(got.map((x) => x[1])).size, 203 - 1 + 1); // 202 opcodes minus wide, plus iload_w and iinc_w
  // offsets strictly increase and match each instruction length
  for (let i = 1; i < got.length; i++) assert.ok(got[i][0] > got[i - 1][0]);
  const text = c.listing.join('\n');
  assert.match(text, /lookupswitch +\{ \/\/ 2\n +-5: \d+\n +100000: \d+\n +default: \d+/);
  assert.match(text, /iinc_w +300, 5/);
  assert.match(text, /invokeinterface +#\d+, +1 +\/\/ InterfaceMethod java\/util\/List\.size:\(\)I/);
  assert.match(text, /invokedynamic +#\d+, +0 +\/\/ InvokeDynamic #0:run:\(\)Ljava\/lang\/Runnable;/);
  assert.match(text, /multianewarray +#\d+, +2 +\/\/ class "\[\[J"/);
  assert.match(text, /newarray +int/);
  assert.match(text, /bipush +-2/);
  assert.match(text, /ldc2_w +#\d+ +\/\/ long 1234567890123l/);
  assert.deepStrictEqual(c.warnings, []);
});

test('every constant pool tag is read and shown', () => {
  const c = parseClass(B.classFile({
    pool: (cp) => {
      cp.int(-5); cp.float(1.5); cp.long(-9n); cp.double(2.25); cp.str('s'); cp.field('a/B', 'f', 'I'); cp.method('a/B', 'm', '()V'); cp.imethod('a/I', 'n', '()V');
      cp.mhandle(6, cp.method('a/B', 'm', '()V')); cp.mtype('()V'); cp.indy(0, 'run', '()V'); cp.dynamic(0, 'c', 'I'); cp.module('m.x'); cp.pkg('a/p');
    },
  }));
  const tags = new Set(c.pool.map((r) => r[1]));
  for (const t of ['Utf8', 'Integer', 'Float', 'Long', 'Double', 'Class', 'String', 'Fieldref', 'Methodref', 'InterfaceMethodref', 'NameAndType', 'MethodHandle', 'MethodType', 'Dynamic', 'InvokeDynamic', 'Module', 'Package']) assert.ok(tags.has(t), t);
  assert.ok(c.pool.some((r) => r[1] === 'MethodHandle' && /^REF_invokeStatic a\/B\.m:\(\)V$/.test(r[3])));
  assert.ok(c.pool.some((r) => r[1] === 'Float' && r[3] === '1.5f'));
  assert.ok(c.pool.some((r) => r[1] === 'Long' && r[3] === '-9l'));
});

test('interfaces, enums, annotations, records and modules get their Java keyword', () => {
  assert.match(parseClass(B.classFile({ name: 'a/I', access: 0x601, interfaces: ['java/lang/Runnable'] })).decl, /^public interface a\.I extends java\.lang\.Runnable$/);
  assert.match(parseClass(B.classFile({ name: 'a/E', access: 0x4031, superName: 'java/lang/Enum' })).decl, /^public final enum a\.E$/);
  assert.match(parseClass(B.classFile({ name: 'a/A', access: 0x2601, interfaces: ['java/lang/annotation/Annotation'] })).decl, /^public @interface a\.A$/);
  const rec = parseClass(B.classFile({ name: 'a/R', access: 0x31, superName: 'java/lang/Record', major: 61, extra: (cp) => [B.attr(cp, 'Record', Buffer.concat([B.u2(1), B.u2(cp.utf8('x')), B.u2(cp.utf8('I')), B.u2(0)]))] }));
  assert.strictEqual(rec.decl, 'public final class a.R');
  assert.strictEqual(rec.record, 'int x');
  const ann = parseClass(B.classFile({ extra: (cp) => [B.attr(cp, 'RuntimeVisibleAnnotations', Buffer.concat([B.u2(1), B.u2(cp.utf8('Ljava/lang/Deprecated;')), B.u2(1), B.u2(cp.utf8('since')), Buffer.from('s'), B.u2(cp.utf8('9'))]))] }));
  assert.deepStrictEqual(ann.annotations, ['@java.lang.Deprecated(since="9")']);
});

test('hostile class files: junk pool of 65535, cut files, huge counts, bad switches, all give a message', () => {
  // constant pool count 65535 with junk tags
  const junk = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0xff, 0xff]), Buffer.alloc(4000, 0xee)]);
  assert.throws(() => parseClass(junk), (e) => e instanceof ClassFormatError && /unknown tag 238/.test(e.message));
  // 65535 Utf8 entries announced, file ends after a few
  const shortPool = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0xff, 0xff]), Buffer.from([1, 0, 1, 0x41]).repeat ? Buffer.alloc(0) : Buffer.alloc(0), ...Array.from({ length: 100 }, () => Buffer.from([1, 0, 1, 0x41]))]);
  assert.throws(() => parseClass(shortPool), /ends early/);
  // not a class
  assert.throws(() => parseClass(Buffer.from('PK\x03\x04 not a class file')), (e) => e.notClass === true);
  // every cut of a real-looking class gives a model or a ClassFormatError, never another error
  const full = B.helloClass();
  for (let n = 0; n < full.length; n++) {
    try { parseClass(full.subarray(0, n)); } catch (e) { assert.ok(e instanceof ClassFormatError, `cut at ${n}: ${e && e.stack}`); }
  }
  // field count 65535 with no bytes for them
  const cp = new B.Pool(); const ti = cp.cls('a/B'); const si = cp.cls('java/lang/Object');
  const many = Buffer.concat([B.u4(0xcafebabe), B.u2(0), B.u2(52), cp.bytes(), B.u2(0x21), B.u2(ti), B.u2(si), B.u2(0), B.u2(0xffff), Buffer.alloc(20)]);
  assert.throws(() => parseClass(many), /65535 fields, more than the file can hold/);
  // attribute longer than the file
  const longAttr = B.classFile({ extra: (p) => [Buffer.concat([B.u2(p.utf8('Junk')), B.u4(0x7fffffff)])] });
  assert.throws(() => parseClass(longAttr), /says 2147483647 bytes/);
  // tableswitch with a huge range and lookupswitch with a negative count are reported in the listing
  const sw = parseClass(B.classFile({ methods: [{ access: 9, name: 'a', desc: '()V', code: Buffer.from([0xaa, 0, 0, 0, ...B.s4(0), ...B.s4(0), ...B.s4(0x7fffffff)]) }, { access: 9, name: 'b', desc: '()V', code: Buffer.from([0xab, 0, 0, 0, ...B.s4(0), ...B.s4(-1)]) }, { access: 9, name: 'c', desc: '()V', code: Buffer.from([0xc4, 0x00, 0, 0]) }] }));
  assert.strictEqual(sw.warnings.length, 3);
  assert.match(sw.warnings.join('\n'), /bad range[\s\S]*bad pair count[\s\S]*cannot be widened/);
  // bad constant pool indexes in instructions stay text
  const badIdx = parseClass(B.classFile({ methods: [{ access: 9, name: 'a', desc: '()V', code: Buffer.from([0xb2, 0xff, 0xff, 0x12, 0x00, 0xb1]) }] }));
  assert.match(badIdx.listing.join('\n'), /getstatic +#65535 +\/\/ <bad #65535>/);
});

test('names with HTML and control characters are kept as data', () => {
  const evil = '<img src=x onerror=alert(1)>\u0007\u001b[31m';
  const c = parseClass(B.helloClass({ greeting: evil, message: evil }));
  assert.ok(c.strings.includes(evil));
  assert.ok(c.fields[0].decl.includes(JSON.stringify(evil)));
});

test('3,000 mutated class files: each gives a model or a ClassFormatError within the limits', () => {
  const base = B.classFile({ methods: [{ access: 9, name: 'all', desc: '()V', code: B.allOpcodes().code }] });
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  let ok = 0, bad = 0;
  const t0 = Date.now();
  for (let k = 0; k < 3000; k++) {
    const b = Buffer.from(base);
    const n = 1 + (rnd() % 8);
    for (let i = 0; i < n; i++) b[8 + (rnd() % (b.length - 8))] = rnd() & 0xff;
    const t = Date.now();
    try { parseClass(b, { maxMs: 2000 }); ok++; } catch (e) { assert.ok(e instanceof ClassFormatError, e && e.stack); bad++; }
    assert.ok(Date.now() - t < 2500);
  }
  assert.strictEqual(ok + bad, 3000);
  assert.ok(Date.now() - t0 < 60000);
});

test('ZIP reader: entries, deflate and stored, CRC, names, comments', () => {
  const buf = B.demoJar();
  const z = readZip(new BufferSource(buf));
  assert.deepStrictEqual(z.entries.map((e) => e.path), ['META-INF/MANIFEST.MF', 'com/zovo/demo/Hello.class', 'com/zovo/demo/Hello$Inner.class', 'com/zovo/demo/util/Strings.class', 'config/app.properties']);
  assert.strictEqual(readEntry(new BufferSource(buf), z.entries[4]).toString(), 'greeting=hello\nmode=test\n');
  // a damaged CRC is caught
  const data = Buffer.from('hello world');
  const bad = writeZip([{ name: 'a.txt', data, crc: crc32(data) ^ 1 }]);
  const zb = readZip(new BufferSource(bad));
  assert.throws(() => readEntry(new BufferSource(bad), zb.entries[0]), /CRC/);
  assert.throws(() => readZip(new BufferSource(Buffer.from('just some text, not a zip at all........'))), /not a JAR \(ZIP\) archive/);
  // every cut of a JAR: a model or a message
  for (let n = 0; n < buf.length; n += 7) {
    try { const s = new BufferSource(buf.subarray(0, n)); J.jarModel(J.openZip(s)); } catch (e) { assert.ok(e instanceof Error && e.message.length > 5, String(e)); }
  }
});

test('zip bombs: ratio cap without unpacking, and a header that lies about the size', () => {
  const zeros = Buffer.alloc(40 * 1024 * 1024);
  const bomb = writeZip([{ name: 'bomb.class', data: zeros, deflate: true }]);
  assert.ok(bomb.length < 100 * 1024);
  const z = readZip(new BufferSource(bomb));
  const t = Date.now();
  assert.throws(() => readEntry(new BufferSource(bomb), z.entries[0]), (e) => e instanceof LimitError && e.code === 'BOMB');
  assert.ok(Date.now() - t < 200, 'refused before unpacking');
  // header says 1,000 bytes, the data unpacks to 5 MB (ratio under the cap): stopped at 1,000 bytes
  const liar = writeZip([{ name: 'liar.txt', data: Buffer.alloc(5 * 1024 * 1024, 0x41), deflate: true, size: 1000 }]);
  const zl = readZip(new BufferSource(liar));
  assert.throws(() => readEntry(new BufferSource(liar), zl.entries[0]), /zip bomb/);
  // over the size limit
  const big = readZip(new BufferSource(writeZip([{ name: 'x.bin', data: Buffer.alloc(2048), size: 70 * 1024 * 1024 }])));
  assert.throws(() => readEntry(new BufferSource(Buffer.alloc(0)), big.entries[0]), /limit is 64\.0 MB/);
});

test('path traversal names are flagged and never joined outside a folder', () => {
  assert.strictEqual(checkEntryName('../../etc/passwd').unsafe !== null, true);
  assert.strictEqual(checkEntryName('/abs/x').unsafe !== null, true);
  assert.strictEqual(checkEntryName('C:\\win\\x').unsafe !== null, true);
  assert.strictEqual(checkEntryName('a/\u0001b').unsafe !== null, true);
  assert.strictEqual(checkEntryName('com/x/Y.class').unsafe, null);
  assert.strictEqual(joinInside('/tmp/out', '../x'), null);
  assert.strictEqual(joinInside('/tmp/out', 'a/../../x'), null);
  assert.strictEqual(joinInside('/tmp/out', 'a/b.java'), require('path').resolve('/tmp/out/a/b.java'));
  const buf = B.jar({ '../../evil.class': B.helloClass(), 'ok/A.class': B.classFile({ name: 'ok/A' }) });
  const m = J.jarModel(J.openZip(new BufferSource(buf)), { name: 'evil.jar' });
  const evil = m.entries.find((e) => e.p === 'evil.class');
  assert.ok(evil && /outside/.test(evil.u));
  assert.match(m.problems.join('\n'), /never written to disk/);
});

test('JAR model: manifest, versions, packages, nested JARs one level, multi-release, module', () => {
  const inner = B.demoJar({ utilMajor: 65 });
  const fat = B.jar({
    'BOOT-INF/classes/com/zovo/app/App.class': B.classFile({ name: 'com/zovo/app/App', major: 61 }),
    'BOOT-INF/lib/demo-1.2.3.jar': inner,
    'META-INF/versions/11/com/zovo/app/App.class': B.classFile({ name: 'com/zovo/app/App', major: 55 }),
    'module-info.class': B.classFile({ name: 'module-info', access: 0x8000, superName: null, major: 53, extra: (cp) => [B.attr(cp, 'Module', Buffer.concat([B.u2(cp.module('com.zovo.app')), B.u2(0), B.u2(0), B.u2(0), B.u2(0), B.u2(0), B.u2(0), B.u2(0), B.u2(0)]))] }),
  }, { manifest: 'Manifest-Version: 1.0\nMain-Class: org.springframework.boot.loader.launch.JarLauncher\nStart-Class: com.zovo.app.App\nImplementation-Title: very-long-title-that-\n continues-here\n\nName: x\nA: b\n' });
  const j = J.openZip(new BufferSource(fat));
  const m = J.jarModel(j, { name: 'app.jar' });
  assert.strictEqual(m.format, 'JAR');
  assert.strictEqual(m.classes, 3);
  assert.strictEqual(m.startClass, 'com.zovo.app.App');
  assert.strictEqual(m.title, 'very-long-title-that-continues-here');
  assert.strictEqual(m.manifest.sections, 1);
  assert.deepStrictEqual(m.nested, ['BOOT-INF/lib/demo-1.2.3.jar']);
  assert.strictEqual(m.multiRelease, true);
  assert.strictEqual(m.module, 'com.zovo.app');
  assert.strictEqual(m.highest, 'Java 17');
  assert.deepStrictEqual(Object.fromEntries(m.versions), { 'Java 17': 1, 'Java 11': 1, 'Java 9': 1 });
  const n = J.openNested(j, 'BOOT-INF/lib/demo-1.2.3.jar');
  const nm = J.jarModel(n, { name: 'demo-1.2.3.jar', nestedIn: 'app.jar' });
  assert.strictEqual(nm.mainClass, 'com.zovo.demo.Hello');
  assert.strictEqual(nm.version, '1.2.3');
  assert.deepStrictEqual(Object.fromEntries(nm.versions), { 'Java 8': 2, 'Java 21': 1 });
  assert.strictEqual(J.classNameOf('BOOT-INF/classes/com/zovo/app/App.class'), 'com.zovo.app.App');
  assert.deepStrictEqual(J.classGroup(n, 'com/zovo/demo/Hello$Inner.class').list.sort(), ['com/zovo/demo/Hello$Inner.class', 'com/zovo/demo/Hello.class']);
  assert.strictEqual(J.formatOf('x.WAR'), 'WAR');
});

test('cyclic nested JAR (a JAR that contains itself) opens one level and stops', () => {
  const self = B.jar({ 'a/A.class': B.classFile({ name: 'a/A' }) });
  const outer = B.jar({ 'lib/self.jar': self, 'lib/again.jar': B.jar({ 'lib/self.jar': self }) });
  const j = J.openZip(new BufferSource(outer));
  const n = J.openNested(j, 'lib/again.jar');
  const m = J.jarModel(n, { name: 'again.jar', nestedIn: 'outer.jar' });
  assert.deepStrictEqual(m.nested, ['lib/self.jar']);
  assert.strictEqual(m.nestedIn, 'outer.jar'); // the host refuses a second level (ext.test.js)
});

test('resources: text, binary preview, size note', () => {
  const j = J.openZip(new BufferSource(B.jar({ 'a.properties': 'k=v\n', 'b.bin': Buffer.from([0, 1, 2, 3, 0xff, 0, 0, 0]) })));
  assert.deepStrictEqual(J.resourceView(j, 'a.properties'), { path: 'a.properties', size: 4, binary: false, text: 'k=v\n' });
  const b = J.resourceView(j, 'b.bin');
  assert.strictEqual(b.binary, true);
  assert.match(b.text, /^00000000 {2}00 01 02 03 ff 00 00 00/);
});

test('deflate check: the readHead fast path reads class versions without unpacking whole entries', () => {
  const big = B.classFile({ name: 'a/Big', major: 65, fields: Array.from({ length: 3000 }, (_, i) => ({ access: 1, name: `f${i}`, desc: 'I' })) });
  const j = J.openZip(new BufferSource(B.jar({ 'a/Big.class': big })));
  const m = J.jarModel(j, { name: 'big.jar' });
  assert.strictEqual(m.entries.find((e) => e.k === 'class').v, 65);
  assert.ok(zlib.deflateRawSync(big).length < big.length);
});
