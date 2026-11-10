'use strict';
// Builds Java class files and JAR files byte by byte for the tests (no fixture files, no javac).
const { writeZip } = require('../src/core/zipwrite');
const { OPS } = require('../src/core/opcodes');

const u1 = (n) => Buffer.from([n & 0xff]);
const u2 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const s4 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0); return b; };

/** Modified UTF-8 (NUL as C0 80, supplementary characters as two 3-byte surrogates). */
function mutf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

class Pool {
  constructor() { this.parts = []; this.keys = new Map(); this.next = 1; }
  add(key, bytes, slots = 1) {
    if (this.keys.has(key)) return this.keys.get(key);
    const i = this.next;
    this.parts.push(bytes); this.keys.set(key, i); this.next += slots;
    return i;
  }
  utf8(s) { const b = mutf8(s); return this.add(`U:${s}`, Buffer.concat([u1(1), u2(b.length), b])); }
  int(v) { return this.add(`I:${v}`, Buffer.concat([u1(3), s4(v)])); }
  float(v) { const b = Buffer.alloc(5); b[0] = 4; b.writeFloatBE(v, 1); return this.add(`F:${v}`, b); }
  long(v) { const b = Buffer.alloc(9); b[0] = 5; b.writeBigInt64BE(BigInt(v), 1); return this.add(`J:${v}`, b, 2); }
  double(v) { const b = Buffer.alloc(9); b[0] = 6; b.writeDoubleBE(v, 1); return this.add(`D:${v}`, b, 2); }
  cls(n) { return this.add(`C:${n}`, Buffer.concat([u1(7), u2(this.utf8(n))])); }
  str(s) { return this.add(`S:${s}`, Buffer.concat([u1(8), u2(this.utf8(s))])); }
  nat(n, d) { return this.add(`N:${n}:${d}`, Buffer.concat([u1(12), u2(this.utf8(n)), u2(this.utf8(d))])); }
  field(c, n, d) { return this.add(`Fr:${c}.${n}:${d}`, Buffer.concat([u1(9), u2(this.cls(c)), u2(this.nat(n, d))])); }
  method(c, n, d) { return this.add(`Mr:${c}.${n}:${d}`, Buffer.concat([u1(10), u2(this.cls(c)), u2(this.nat(n, d))])); }
  imethod(c, n, d) { return this.add(`IMr:${c}.${n}:${d}`, Buffer.concat([u1(11), u2(this.cls(c)), u2(this.nat(n, d))])); }
  mhandle(kind, ref) { return this.add(`MH:${kind}:${ref}`, Buffer.concat([u1(15), u1(kind), u2(ref)])); }
  mtype(d) { return this.add(`MT:${d}`, Buffer.concat([u1(16), u2(this.utf8(d))])); }
  indy(bsm, n, d) { return this.add(`ID:${bsm}:${n}:${d}`, Buffer.concat([u1(18), u2(bsm), u2(this.nat(n, d))])); }
  dynamic(bsm, n, d) { return this.add(`DY:${bsm}:${n}:${d}`, Buffer.concat([u1(17), u2(bsm), u2(this.nat(n, d))])); }
  module(n) { return this.add(`MO:${n}`, Buffer.concat([u1(19), u2(this.utf8(n))])); }
  pkg(n) { return this.add(`PK:${n}`, Buffer.concat([u1(20), u2(this.utf8(n))])); }
  bytes() { return Buffer.concat([u2(this.next), ...this.parts]); }
}

const attr = (cp, name, body) => Buffer.concat([u2(cp.utf8(name)), u4(body.length), body]);
const attrs = (list) => Buffer.concat([u2(list.length), ...list]);

/** A Code attribute. m: { code (Buffer), maxStack, maxLocals, handlers: [[s,e,h,type|0]], lines: [[pc,line]], vars: [[s,l,name,desc,slot]] } */
function codeAttr(cp, m) {
  const sub = [];
  if (m.lines) sub.push(attr(cp, 'LineNumberTable', Buffer.concat([u2(m.lines.length), ...m.lines.map(([pc, ln]) => Buffer.concat([u2(pc), u2(ln)]))])));
  if (m.vars) sub.push(attr(cp, 'LocalVariableTable', Buffer.concat([u2(m.vars.length), ...m.vars.map(([s, l, n, d, slot]) => Buffer.concat([u2(s), u2(l), u2(cp.utf8(n)), u2(cp.utf8(d)), u2(slot)]))])));
  const handlers = m.handlers || [];
  return attr(cp, 'Code', Buffer.concat([u2(m.maxStack || 4), u2(m.maxLocals || 4), u4(m.code.length), m.code, u2(handlers.length),
    ...handlers.map(([s, e, hd, t]) => Buffer.concat([u2(s), u2(e), u2(hd), u2(t ? cp.cls(t) : 0)])), attrs(sub)]));
}

/**
 * A class file. o: { name, superName, interfaces, access, major, minor, signature, sourceFile, fields: [{access,name,desc,constant,signature}],
 * methods: [{access,name,desc,code?,signature,exceptions,...}], extra(cp) -> [attribute buffers], pool(cp) to add entries first }
 */
function classFile(o = {}) {
  const cp = new Pool();
  if (o.pool) o.pool(cp);
  const name = o.name || 'com/zovo/demo/Hello';
  const thisIdx = cp.cls(name);
  const superIdx = o.superName === null ? 0 : cp.cls(o.superName || 'java/lang/Object');
  const ifs = (o.interfaces || []).map((i) => cp.cls(i));
  const fields = (o.fields || []).map((f) => {
    const a = [];
    if (f.constant !== undefined) a.push(attr(cp, 'ConstantValue', u2(typeof f.constant === 'string' ? cp.str(f.constant) : Number.isInteger(f.constant) ? cp.int(f.constant) : cp.double(f.constant))));
    if (f.signature) a.push(attr(cp, 'Signature', u2(cp.utf8(f.signature))));
    return Buffer.concat([u2(f.access || 0), u2(cp.utf8(f.name)), u2(cp.utf8(f.desc)), attrs(a)]);
  });
  const methods = (o.methods || []).map((m) => {
    const a = [];
    if (m.code) a.push(codeAttr(cp, { ...m, code: typeof m.code === 'function' ? m.code(cp) : m.code }));
    if (m.signature) a.push(attr(cp, 'Signature', u2(cp.utf8(m.signature))));
    if (m.exceptions) a.push(attr(cp, 'Exceptions', Buffer.concat([u2(m.exceptions.length), ...m.exceptions.map((e) => u2(cp.cls(e)))])));
    if (m.deprecated) a.push(attr(cp, 'Deprecated', Buffer.alloc(0)));
    return Buffer.concat([u2(m.access === undefined ? 1 : m.access), u2(cp.utf8(m.name)), u2(cp.utf8(m.desc)), attrs(a)]);
  });
  const ca = [];
  if (o.sourceFile !== false) ca.push(attr(cp, 'SourceFile', u2(cp.utf8(o.sourceFile || `${name.split('/').pop().replace(/\$.*/, '')}.java`))));
  if (o.signature) ca.push(attr(cp, 'Signature', u2(cp.utf8(o.signature))));
  if (o.inner) ca.push(attr(cp, 'InnerClasses', Buffer.concat([u2(o.inner.length), ...o.inner.map(([i, out, n, fl]) => Buffer.concat([u2(cp.cls(i)), u2(out ? cp.cls(out) : 0), u2(n ? cp.utf8(n) : 0), u2(fl)]))])));
  if (o.extra) ca.push(...o.extra(cp));
  const body = Buffer.concat([u2(o.access === undefined ? 0x21 : o.access), u2(thisIdx), u2(superIdx), u2(ifs.length), ...ifs.map(u2),
    u2(fields.length), ...fields, u2(methods.length), ...methods, attrs(ca)]);
  return Buffer.concat([u4(0xcafebabe), u2(o.minor || 0), u2(o.major || 52), cp.bytes(), body]);
}

/** A method body with every opcode (valid operands), wide forms and both switches. Returns { code(cp), names }. */
function allOpcodes() {
  const names = [];
  const code = (cp) => {
    const parts = [];
    let pc = 0;
    const emit = (b, name) => { parts.push(Buffer.from(b)); names.push(name); pc += b.length; };
    const i2 = (n) => [(n >> 8) & 0xff, n & 0xff];
    for (let op = 0; op <= 201; op++) {
      const info = OPS[op];
      switch (info.kind) {
        case '': emit([op], info.name); break;
        case 'b': emit([op, 0xfe], info.name); break;
        case 's': emit([op, 0x01, 0x00], info.name); break;
        case 'l': emit([op, 3], info.name); break;
        case 'c1': emit([op, cp.int(7)], info.name); break;
        case 'c2': {
          let idx;
          if (op === 19) idx = cp.str('wide constant'); else if (op === 20) idx = cp.long(1234567890123n);
          else if (op >= 178 && op <= 181) idx = cp.field('com/zovo/demo/Hello', 'count', 'I');
          else if (op >= 182 && op <= 184) idx = cp.method('java/io/PrintStream', 'println', '(Ljava/lang/String;)V');
          else idx = cp.cls('java/util/ArrayList');
          emit([op, ...i2(idx)], info.name); break;
        }
        case 'inc': emit([op, 2, 0xff], info.name); break;
        case 'br2': emit([op, 0, 3], info.name); break;
        case 'br4': emit([op, 0, 0, 0, 5], info.name); break;
        case 'iface': emit([op, ...i2(cp.imethod('java/util/List', 'size', '()I')), 1, 0], info.name); break;
        case 'indy': emit([op, ...i2(cp.indy(0, 'run', '()Ljava/lang/Runnable;')), 0, 0], info.name); break;
        case 'atype': emit([op, 10], info.name); break;
        case 'multi': emit([op, ...i2(cp.cls('[[J')), 2], info.name); break;
        case 'table': {
          const pad = (4 - ((pc + 1) % 4)) % 4;
          const b = [op, ...new Array(pad).fill(0)];
          const words = [20, 1, 3, 8, 12, 16];
          for (const w of words) b.push(...s4(w));
          emit(b, info.name); break;
        }
        case 'lookup': {
          const pad = (4 - ((pc + 1) % 4)) % 4;
          const b = [op, ...new Array(pad).fill(0)];
          for (const w of [24, 2, -5, 8, 100000, 16]) b.push(...s4(w));
          emit(b, info.name); break;
        }
        case 'wide':
          emit([196, 21, 0x01, 0x2c], 'iload_w');
          emit([196, 132, 0x01, 0x2c, 0x00, 0x05], 'iinc_w');
          break;
        default: throw new Error(`no case for ${info.name}`);
      }
    }
    return Buffer.concat(parts);
  };
  return { code, names };
}

/** A realistic small class: fields, constructor, a switch, a generic method, an inner class entry, a lambda bootstrap. */
function helloClass(o = {}) {
  return classFile({
    name: o.name || 'com/zovo/demo/Hello',
    interfaces: ['java/lang/Comparable'],
    signature: 'Ljava/lang/Object;Ljava/lang/Comparable<Lcom/zovo/demo/Hello;>;',
    major: o.major || 52,
    fields: [
      { access: 0x19, name: 'GREETING', desc: 'Ljava/lang/String;', constant: o.greeting || 'Hello, JAR' },
      { access: 0x12, name: 'names', desc: 'Ljava/util/List;', signature: 'Ljava/util/List<Ljava/lang/String;>;' },
      { access: 0x0a, name: 'count', desc: 'I' },
      ...(o.fields || []),
    ],
    methods: [
      { access: 1, name: '<init>', desc: '()V', code: (cp) => Buffer.from([0x2a, 0xb7, 0, cp.method('java/lang/Object', '<init>', '()V'), 0xb1]), lines: [[0, 3]], vars: [[0, 5, 'this', 'Lcom/zovo/demo/Hello;', 0]] },
      { access: 9, name: 'pick', desc: '(I)I', code: Buffer.from([0x1a, 0xaa, 0, 0, ...s4(29), ...s4(1), ...s4(2), ...s4(23), ...s4(26), 0x10, 10, 0xac, 0x10, 20, 0xac, 0x02, 0xac]) },
      { access: 9, name: 'main', desc: '([Ljava/lang/String;)V', exceptions: ['java/lang/Exception'], code: (cp) => Buffer.concat([Buffer.from([0xb2]), u2(cp.field('java/lang/System', 'out', 'Ljava/io/PrintStream;')), Buffer.from([0x12, cp.str(o.message || 'Hello, JAR')]), Buffer.from([0xb6]), u2(cp.method('java/io/PrintStream', 'println', '(Ljava/lang/String;)V')), Buffer.from([0xb1, 0x4c, 0xb1])]), handlers: [[0, 8, 9, 'java/lang/RuntimeException']] },
      { access: 0x89, name: 'firstOf', desc: '([Ljava/lang/Object;)Ljava/lang/Object;', signature: '<T:Ljava/lang/Object;>([TT;)TT;', code: Buffer.from([0x2a, 0x03, 0x32, 0xb0]) },
      { access: 0x1041, name: 'compareTo', desc: '(Ljava/lang/Object;)I', code: Buffer.from([0x03, 0xac]) },
      ...(o.methods || []),
    ],
    inner: [['com/zovo/demo/Hello$Inner', 'com/zovo/demo/Hello', 'Inner', 0]],
    extra: o.extra,
  });
}

function innerClass() {
  return classFile({ name: 'com/zovo/demo/Hello$Inner', access: 0x20, fields: [{ access: 0x10, name: 'this$0', desc: 'Lcom/zovo/demo/Hello;' }], methods: [{ access: 0, name: 'twice', desc: '()I', code: Buffer.from([0x05, 0xac]) }], inner: [['com/zovo/demo/Hello$Inner', 'com/zovo/demo/Hello', 'Inner', 0]] });
}

/** A JAR: entries { name: data }, with a manifest unless manifest === false. */
function jar(files = {}, { manifest = 'Manifest-Version: 1.0\r\nMain-Class: com.zovo.demo.Hello\r\nCreated-By: zovo test\r\nImplementation-Title: demo\r\nImplementation-Version: 1.2.3\r\n\r\n', deflate = true } = {}) {
  const entries = [];
  if (manifest !== false) entries.push({ name: 'META-INF/MANIFEST.MF', data: Buffer.from(manifest), deflate });
  for (const [name, data] of Object.entries(files)) entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data)), deflate });
  return writeZip(entries);
}

function demoJar(o = {}) {
  return jar({
    'com/zovo/demo/Hello.class': helloClass(o),
    'com/zovo/demo/Hello$Inner.class': innerClass(),
    'com/zovo/demo/util/Strings.class': classFile({ name: 'com/zovo/demo/util/Strings', major: o.utilMajor || 61, methods: [{ access: 9, name: 'trim', desc: '(Ljava/lang/String;)Ljava/lang/String;', code: Buffer.from([0x2a, 0xb0]) }] }),
    'config/app.properties': 'greeting=hello\nmode=test\n',
    ...(o.files || {}),
  });
}

module.exports = { Pool, classFile, codeAttr, attr, attrs, allOpcodes, helloClass, innerClass, jar, demoJar, mutf8, u1, u2, u4, s4 };
