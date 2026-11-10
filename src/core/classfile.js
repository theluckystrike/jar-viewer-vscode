'use strict';
// Java class file reader (JVMS chapter 4), in plain JavaScript: constant pool, access flags, fields, methods,
// attributes, and a javap -c style bytecode listing. Every read is bounds-checked; counts and lengths from the file
// are checked against the bytes that are left, and the work per class is capped, so a hostile class gives a message.
const D = require('./descriptor');
const { OPS, ATYPES, WIDE_OK } = require('./opcodes');

const MAX_LISTING_LINES = 200000;
const MAX_ANNOTATION_DEPTH = 24;

class ClassFormatError extends Error { constructor(m) { super(m); this.code = 'CLASS'; } }

const TAGS = { 1: 'Utf8', 3: 'Integer', 4: 'Float', 5: 'Long', 6: 'Double', 7: 'Class', 8: 'String', 9: 'Fieldref', 10: 'Methodref', 11: 'InterfaceMethodref', 12: 'NameAndType', 15: 'MethodHandle', 16: 'MethodType', 17: 'Dynamic', 18: 'InvokeDynamic', 19: 'Module', 20: 'Package' };
const REF_KINDS = { 1: 'REF_getField', 2: 'REF_getStatic', 3: 'REF_putField', 4: 'REF_putStatic', 5: 'REF_invokeVirtual', 6: 'REF_invokeStatic', 7: 'REF_invokeSpecial', 8: 'REF_newInvokeSpecial', 9: 'REF_invokeInterface' };

const CLASS_FLAGS = [[0x0001, 'public'], [0x0010, 'final'], [0x0020, 'super'], [0x0200, 'interface'], [0x0400, 'abstract'], [0x1000, 'synthetic'], [0x2000, 'annotation'], [0x4000, 'enum'], [0x8000, 'module']];
const FIELD_FLAGS = [[0x0001, 'public'], [0x0002, 'private'], [0x0004, 'protected'], [0x0008, 'static'], [0x0010, 'final'], [0x0040, 'volatile'], [0x0080, 'transient'], [0x1000, 'synthetic'], [0x4000, 'enum']];
const METHOD_FLAGS = [[0x0001, 'public'], [0x0002, 'private'], [0x0004, 'protected'], [0x0008, 'static'], [0x0010, 'final'], [0x0020, 'synchronized'], [0x0040, 'bridge'], [0x0080, 'varargs'], [0x0100, 'native'], [0x0400, 'abstract'], [0x0800, 'strictfp'], [0x1000, 'synthetic']];
const INNER_FLAGS = [[0x0001, 'public'], [0x0002, 'private'], [0x0004, 'protected'], [0x0008, 'static'], [0x0010, 'final'], [0x0200, 'interface'], [0x0400, 'abstract'], [0x1000, 'synthetic'], [0x2000, 'annotation'], [0x4000, 'enum']];
const flagNames = (v, table) => table.filter(([b]) => v & b).map(([, n]) => n);
const hex4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** Class file major version -> Java release name. */
function javaVersion(major, minor = 0) {
  if (!Number.isInteger(major)) return 'unknown';
  if (major === 45) return minor >= 3 ? 'Java 1.1' : 'Java 1.0';
  if (major >= 46 && major <= 48) return `Java 1.${major - 44}`;
  if (major >= 49 && major <= 120) return `Java ${major - 44}${major >= 56 && minor === 0xffff ? ' (preview features)' : ''}`;
  return `unknown (${major})`;
}

/** Modified UTF-8 (JVMS 4.4.7) to a JS string. Bad bytes become U+FFFD. */
function mutf8(b) {
  let s = '';
  const units = [];
  for (let i = 0; i < b.length;) {
    const x = b[i];
    if (x < 0x80 && x !== 0) { units.push(x); i++; } else if ((x & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1] & 0xc0) === 0x80) { units.push(((x & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; } else if ((x & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) { units.push(((x & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; } else { units.push(0xfffd); i++; }
    if (units.length >= 8192) { s += String.fromCharCode(...units); units.length = 0; }
  }
  return s + String.fromCharCode(...units);
}

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  need(n, what) { if (this.p + n > this.b.length) throw new ClassFormatError(`The class file ends early, inside ${what} (offset ${this.p}, ${this.b.length} bytes).`); }
  u1(w = 'a value') { this.need(1, w); return this.b[this.p++]; }
  u2(w = 'a value') { this.need(2, w); const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; }
  u4(w = 'a value') { this.need(4, w); const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  bytes(n, w) { this.need(n, w); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
}

function fmtFloat(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Reads the constant pool. Returns { cp, rows } where cp[i] = { tag, ... }. */
function readPool(r, warnings) {
  const count = r.u2('the constant pool count');
  const cp = new Array(count).fill(null);
  for (let i = 1; i < count; i++) {
    const tag = r.u1(`constant pool entry #${i}`);
    const w = `constant pool entry #${i}`;
    switch (tag) {
      case 1: { const len = r.u2(w); cp[i] = { tag, text: mutf8(r.bytes(len, w)) }; break; }
      case 3: cp[i] = { tag, value: r.b.readInt32BE((r.need(4, w), r.p)) }; r.p += 4; break;
      case 4: cp[i] = { tag, value: r.b.readFloatBE((r.need(4, w), r.p)) }; r.p += 4; break;
      case 5: cp[i] = { tag, value: r.b.readBigInt64BE((r.need(8, w), r.p)) }; r.p += 8; i++; break;
      case 6: cp[i] = { tag, value: r.b.readDoubleBE((r.need(8, w), r.p)) }; r.p += 8; i++; break;
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, a: r.u2(w) }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: r.u2(w), b: r.u2(w) }; break;
      case 15: cp[i] = { tag, kind: r.u1(w), a: r.u2(w) }; break;
      default: throw new ClassFormatError(`Constant pool entry #${i} of ${count - 1} has the unknown tag ${tag} (offset ${r.p - 1}). The class file is damaged or not a class file.`);
    }
  }
  if (count === 0) warnings.push('The constant pool count is 0, which no compiler writes.');
  return cp;
}

/** Text helpers over the pool; each tolerates a bad index (hostile files) and loops (depth cap). */
function poolApi(cp) {
  const get = (i) => (Number.isInteger(i) && i > 0 && i < cp.length ? cp[i] : null);
  const utf = (i) => { const e = get(i); return e && e.tag === 1 ? e.text : `<bad #${i}>`; };
  const cls = (i) => { const e = get(i); return e && e.tag === 7 ? utf(e.a) : `<bad #${i}>`; };
  const nat = (i) => { const e = get(i); return e && e.tag === 12 ? [utf(e.a), utf(e.b)] : [`<bad #${i}>`, '']; };
  function text(i, depth = 0) {
    const e = get(i);
    if (!e) return `<bad #${i}>`;
    if (depth > 4) return '...';
    switch (e.tag) {
      case 1: return e.text;
      case 3: return String(e.value);
      case 4: return `${fmtFloat(e.value)}f`;
      case 5: return `${e.value}l`;
      case 6: return `${fmtFloat(e.value)}d`;
      case 7: return utf(e.a);
      case 8: return utf(e.a);
      case 9: case 10: case 11: { const [n, d] = nat(e.b); return `${cls(e.a)}.${n}:${d}`; }
      case 12: { const [n, d] = nat(i); return `${n}:${d}`; }
      case 15: return `${REF_KINDS[e.kind] || `kind ${e.kind}`} ${text(e.a, depth + 1)}`;
      case 16: return utf(e.a);
      case 17: case 18: { const [n, d] = nat(e.b); return `#${e.a}:${n}:${d}`; }
      case 19: case 20: return utf(e.a);
      default: return '?';
    }
  }
  /** javap-style comment for an instruction operand: "String Hello", "Method java/io/PrintStream.println:(I)V". */
  function comment(i) {
    const e = get(i);
    if (!e) return `<bad #${i}>`;
    const kind = { 1: 'Utf8', 3: 'int', 4: 'float', 5: 'long', 6: 'double', 7: 'class', 8: 'String', 9: 'Field', 10: 'Method', 11: 'InterfaceMethod', 12: 'NameAndType', 15: 'MethodHandle', 16: 'MethodType', 17: 'Dynamic', 18: 'InvokeDynamic', 19: 'Module', 20: 'Package' }[e.tag];
    let t = text(i);
    if (e.tag === 8) t = JSON.stringify(t).slice(1, -1).replace(/\\"/g, '"');
    if (e.tag === 7 && t.startsWith('[')) t = `"${t}"`;
    return `${kind} ${t}`;
  }
  return { get, utf, cls, nat, text, comment };
}

function readAnnotation(r, P, depth) {
  if (depth > MAX_ANNOTATION_DEPTH) throw new ClassFormatError('Annotations are nested too deep.');
  const type = P.utf(r.u2('an annotation'));
  const n = r.u2('an annotation');
  const vals = [];
  for (let k = 0; k < n; k++) { const name = P.utf(r.u2('an annotation value')); vals.push(`${name}=${readElement(r, P, depth + 1)}`); }
  return `@${D.fieldType(type)}${vals.length ? `(${vals.join(', ')})` : ''}`;
}
function readElement(r, P, depth) {
  if (depth > MAX_ANNOTATION_DEPTH) throw new ClassFormatError('Annotation values are nested too deep.');
  const tag = String.fromCharCode(r.u1('an annotation value'));
  if ('BCDFIJSZ'.includes(tag)) return P.text(r.u2());
  if (tag === 's') return JSON.stringify(P.utf(r.u2()));
  if (tag === 'e') { const t = P.utf(r.u2()); const c = P.utf(r.u2()); return `${D.fieldType(t)}.${c}`; }
  if (tag === 'c') return `${D.fieldType(P.utf(r.u2()))}.class`;
  if (tag === '@') return readAnnotation(r, P, depth + 1);
  if (tag === '[') { const n = r.u2(); const out = []; for (let k = 0; k < n; k++) out.push(readElement(r, P, depth + 1)); return `{${out.slice(0, 20).join(', ')}${n > 20 ? ', ...' : ''}}`; }
  throw new ClassFormatError(`Unknown annotation value tag "${tag}".`);
}

/** Reads an attribute list; known attributes are decoded, others listed with their size. */
function readAttributes(r, P, where, warnings) {
  const count = r.u2(`the attribute count of ${where}`);
  const out = [];
  for (let k = 0; k < count; k++) {
    const nameIdx = r.u2(`an attribute of ${where}`);
    const len = r.u4(`an attribute of ${where}`);
    const name = P.utf(nameIdx);
    if (r.p + len > r.b.length) throw new ClassFormatError(`The attribute "${name}" of ${where} says ${len} bytes, but only ${r.b.length - r.p} are left.`);
    const body = new Reader(r.b.subarray(r.p, r.p + len));
    r.p += len;
    const a = { name, length: len };
    try { decodeAttribute(a, body, P, where, warnings); } catch (e) {
      if (!(e instanceof ClassFormatError)) throw e;
      a.error = e.message;
      warnings.push(`${where}: attribute ${name}: ${e.message}`);
    }
    out.push(a);
  }
  return out;
}

function decodeAttribute(a, r, P, where, warnings) {
  switch (a.name) {
    case 'ConstantValue': { const i = r.u2(); const e = P.get(i); a.value = e && e.tag === 8 ? JSON.stringify(P.text(i)) : P.text(i); break; }
    case 'SourceFile': a.value = P.utf(r.u2()); break;
    case 'Signature': a.value = P.utf(r.u2()); break;
    case 'Deprecated': case 'Synthetic': break;
    case 'Exceptions': { const n = r.u2(); a.list = []; for (let i = 0; i < n; i++) a.list.push(D.dotted(P.cls(r.u2()))); break; }
    case 'NestHost': a.value = D.dotted(P.cls(r.u2())); break;
    case 'ModuleMainClass': a.value = D.dotted(P.cls(r.u2())); break;
    case 'NestMembers': case 'PermittedSubclasses': { const n = r.u2(); a.list = []; for (let i = 0; i < n; i++) a.list.push(D.dotted(P.cls(r.u2()))); break; }
    case 'ModulePackages': { const n = r.u2(); a.list = []; for (let i = 0; i < n; i++) a.list.push(D.dotted(P.text(r.u2()))); break; }
    case 'EnclosingMethod': { const c = D.dotted(P.cls(r.u2())); const m = r.u2(); a.value = m ? `${c}.${P.nat(m)[0]}` : c; break; }
    case 'SourceDebugExtension': a.value = Buffer.from(r.b).toString('utf8').slice(0, 4000); break;
    case 'InnerClasses': {
      const n = r.u2(); a.list = [];
      for (let i = 0; i < n; i++) {
        const inner = r.u2(), outer = r.u2(), name = r.u2(), flags = r.u2();
        a.list.push({ inner: inner ? D.dotted(P.cls(inner)) : '', outer: outer ? D.dotted(P.cls(outer)) : '', name: name ? P.utf(name) : '(anonymous)', flags: flagNames(flags, INNER_FLAGS).join(' '), raw: flags });
      }
      break;
    }
    case 'BootstrapMethods': {
      const n = r.u2(); a.list = [];
      for (let i = 0; i < n; i++) { const ref = r.u2(); const k = r.u2(); const args = []; for (let j = 0; j < k; j++) args.push(`#${r.u2()}`); a.list.push(`${i}: #${ref} ${P.text(ref)}${args.length ? `, arguments ${args.join(' ')}` : ''}`); }
      break;
    }
    case 'MethodParameters': { const n = r.u1(); a.list = []; for (let i = 0; i < n; i++) { const nm = r.u2(); const fl = r.u2(); a.list.push(`${nm ? P.utf(nm) : '<no name>'}${fl & 0x10 ? ' final' : ''}${fl & 0x1000 ? ' synthetic' : ''}${fl & 0x8000 ? ' mandated' : ''}`); } break; }
    case 'Record': {
      const n = r.u2(); a.list = [];
      for (let i = 0; i < n; i++) { const nm = P.utf(r.u2()); const ds = P.utf(r.u2()); readAttributes(r, P, `record component ${nm}`, warnings); a.list.push(`${D.fieldType(ds)} ${nm}`); }
      break;
    }
    case 'RuntimeVisibleAnnotations': case 'RuntimeInvisibleAnnotations': {
      const n = r.u2(); a.list = [];
      for (let i = 0; i < n; i++) a.list.push(readAnnotation(r, P, 0));
      break;
    }
    case 'Module': {
      a.value = P.text(r.u2()); r.u2(); const ver = r.u2(); if (ver) a.value += `@${P.utf(ver)}`;
      const n = r.u2(); a.list = [];
      for (let i = 0; i < n; i++) { const m = P.text(r.u2()); r.u2(); r.u2(); a.list.push(`requires ${m}`); }
      const ne = r.u2();
      for (let i = 0; i < ne; i++) { const pk = P.text(r.u2()); r.u2(); const to = r.u2(); for (let j = 0; j < to; j++) r.u2(); a.list.push(`exports ${D.dotted(pk)}`); }
      break;
    }
    case 'Code': {
      a.maxStack = r.u2('Code'); a.maxLocals = r.u2('Code');
      const len = r.u4('Code');
      if (len > r.b.length - r.p) throw new ClassFormatError(`The code says ${len} bytes, but only ${r.b.length - r.p} are left.`);
      a.code = r.bytes(len, 'Code');
      const n = r.u2('the exception table');
      a.exceptions = [];
      for (let i = 0; i < n; i++) { const s = r.u2(), e = r.u2(), h = r.u2(), t = r.u2(); a.exceptions.push({ start: s, end: e, handler: h, type: t ? D.dotted(P.cls(t)) : 'any' }); }
      a.attributes = readAttributes(r, P, `${where} Code`, warnings);
      const lnt = a.attributes.find((x) => x.name === 'LineNumberTable');
      if (lnt && lnt.lines) a.lines = lnt.lines;
      const lvt = a.attributes.find((x) => x.name === 'LocalVariableTable');
      if (lvt && lvt.vars) a.vars = lvt.vars;
      break;
    }
    case 'LineNumberTable': { const n = r.u2(); a.lines = []; for (let i = 0; i < n; i++) a.lines.push([r.u2(), r.u2()]); break; }
    case 'LocalVariableTable': case 'LocalVariableTypeTable': {
      const n = r.u2(); a.vars = [];
      for (let i = 0; i < n; i++) { const s = r.u2(), l = r.u2(), nm = P.utf(r.u2()), ds = P.utf(r.u2()), slot = r.u2(); a.vars.push({ start: s, length: l, slot, name: nm, type: D.fieldType(ds) }); }
      break;
    }
    case 'StackMapTable': a.value = `${r.u2()} frames`; break;
    case 'AnnotationDefault': a.value = readElement(r, P, 0); break;
    default: break;
  }
}

/** One disassembled method body as javap -c style lines. */
function disassemble(code, P, out, indent = '      ') {
  const b = code;
  const s1 = (o) => ((b[o] << 24) >> 24);
  const s2 = (o) => (((b[o] << 8) | b[o + 1]) << 16) >> 16;
  const u2 = (o) => (b[o] << 8) | b[o + 1];
  const s4 = (o) => b.readInt32BE(o);
  const pad = (s, n) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));
  const push = (line) => { if (out.length < MAX_LISTING_LINES) out.push(line); };
  let pc = 0, count = 0;
  while (pc < b.length) {
    if (++count > 70000 || out.length >= MAX_LISTING_LINES) { push(`${indent}... listing stopped after ${out.length} lines`); return false; }
    const op = b[pc];
    const info = OPS[op];
    const at = `${indent}${String(pc).padStart(4)}: `;
    const need = (n) => { if (pc + n > b.length) throw new ClassFormatError(`The instruction ${info ? info.name : op} at ${pc} runs past the end of the code.`); };
    if (!info) { push(`${at}<unknown opcode 0x${op.toString(16)}>`); pc++; continue; }
    const name = info.name;
    switch (info.kind) {
      case '': push(`${at}${name}`); pc += 1; break;
      case 'b': need(2); push(`${at}${pad(name, 13)} ${s1(pc + 1)}`); pc += 2; break;
      case 's': need(3); push(`${at}${pad(name, 13)} ${s2(pc + 1)}`); pc += 3; break;
      case 'l': need(2); push(`${at}${pad(name, 13)} ${b[pc + 1]}`); pc += 2; break;
      case 'c1': { need(2); const i = b[pc + 1]; push(`${at}${pad(name, 13)} ${pad(`#${i}`, 18)} // ${P.comment(i)}`); pc += 2; break; }
      case 'c2': { need(3); const i = u2(pc + 1); push(`${at}${pad(name, 13)} ${pad(`#${i}`, 18)} // ${P.comment(i)}`); pc += 3; break; }
      case 'inc': need(3); push(`${at}${pad(name, 13)} ${b[pc + 1]}, ${s1(pc + 2)}`); pc += 3; break;
      case 'br2': need(3); push(`${at}${pad(name, 13)} ${pc + s2(pc + 1)}`); pc += 3; break;
      case 'br4': need(5); push(`${at}${pad(name, 13)} ${pc + s4(pc + 1)}`); pc += 5; break;
      case 'iface': { need(5); const i = u2(pc + 1); push(`${at}${pad(name, 13)} ${pad(`#${i},  ${b[pc + 3]}`, 18)} // ${P.comment(i)}`); pc += 5; break; }
      case 'indy': { need(5); const i = u2(pc + 1); push(`${at}${pad(name, 13)} ${pad(`#${i},  0`, 18)} // ${P.comment(i)}`); pc += 5; break; }
      case 'atype': need(2); push(`${at}${pad(name, 13)} ${ATYPES[b[pc + 1]] || `<bad type ${b[pc + 1]}>`}`); pc += 2; break;
      case 'multi': { need(4); const i = u2(pc + 1); push(`${at}${pad(name, 13)} ${pad(`#${i},  ${b[pc + 3]}`, 18)} // ${P.comment(i)}`); pc += 4; break; }
      case 'wide': {
        need(2);
        const op2 = b[pc + 1];
        if (!WIDE_OK.has(op2)) throw new ClassFormatError(`wide at ${pc} is followed by ${OPS[op2] ? OPS[op2].name : op2}, which cannot be widened.`);
        if (op2 === 132) { need(6); push(`${at}${pad('iinc_w', 13)} ${u2(pc + 2)}, ${s2(pc + 4)}`); pc += 6; } else { need(4); push(`${at}${pad(`${OPS[op2].name}_w`, 13)} ${u2(pc + 2)}`); pc += 4; }
        break;
      }
      case 'table': {
        let q = (pc + 4) & ~3;
        need(q - pc + 12);
        const dflt = s4(q), lo = s4(q + 4), hi = s4(q + 8);
        const n = hi - lo + 1;
        if (hi < lo || n > 65536 || q + 12 + n * 4 > b.length) throw new ClassFormatError(`tableswitch at ${pc} has a bad range ${lo} to ${hi}.`);
        push(`${at}${pad(name, 13)} { // ${lo} to ${hi}`);
        for (let k = 0; k < n; k++) push(`${indent}${String(lo + k).padStart(24)}: ${pc + s4(q + 12 + k * 4)}`);
        push(`${indent}${'default'.padStart(24)}: ${pc + dflt}`);
        push(`${indent}     }`);
        pc = q + 12 + n * 4;
        break;
      }
      case 'lookup': {
        let q = (pc + 4) & ~3;
        need(q - pc + 8);
        const dflt = s4(q), n = s4(q + 4);
        if (n < 0 || n > 65536 || q + 8 + n * 8 > b.length) throw new ClassFormatError(`lookupswitch at ${pc} has a bad pair count ${n}.`);
        push(`${at}${pad(name, 13)} { // ${n}`);
        for (let k = 0; k < n; k++) push(`${indent}${String(s4(q + 8 + k * 8)).padStart(24)}: ${pc + s4(q + 12 + k * 8)}`);
        push(`${indent}${'default'.padStart(24)}: ${pc + dflt}`);
        push(`${indent}     }`);
        pc = q + 8 + n * 8;
        break;
      }
      default: push(`${at}${name}`); pc++;
    }
  }
  return true;
}

function modifiers(flags, table, skip) { return flagNames(flags, table).filter((n) => !skip.includes(n)); }

/** Parses a class file. Returns the model the viewer shows. */
function parseClass(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const started = Date.now();
  const maxMs = opts.maxMs || 8000;
  const r = new Reader(buf);
  const warnings = [];
  if (buf.length < 10) throw new ClassFormatError(`This file has ${buf.length} bytes; a class file has at least 10 before its constant pool.`);
  const magic = r.u4('the magic number');
  if (magic !== 0xcafebabe) { const e = new ClassFormatError(`Not a Java class file: it starts with 0x${magic.toString(16).toUpperCase().padStart(8, '0')}, not 0xCAFEBABE.`); e.notClass = true; throw e; }
  const minor = r.u2(), major = r.u2();
  if (major < 45 || major > 120) warnings.push(`The major version ${major} is outside the known range (45 to ${44 + 26} and later releases).`);
  const cp = readPool(r, warnings);
  const P = poolApi(cp);
  const access = r.u2('the access flags');
  const thisIdx = r.u2('the class name'), superIdx = r.u2('the super class');
  const name = D.dotted(P.cls(thisIdx));
  const superName = superIdx ? D.dotted(P.cls(superIdx)) : '';
  const ni = r.u2('the interface count');
  if (ni * 2 > buf.length - r.p) throw new ClassFormatError(`The class lists ${ni} interfaces, more than the file can hold.`);
  const interfaces = [];
  for (let i = 0; i < ni; i++) interfaces.push(D.dotted(P.cls(r.u2())));
  const members = (kind) => {
    const n = r.u2(`the ${kind} count`);
    if (n * 8 > buf.length - r.p) throw new ClassFormatError(`The class lists ${n} ${kind}s, more than the file can hold.`);
    const list = [];
    for (let i = 0; i < n; i++) {
      if (Date.now() - started > maxMs) throw new ClassFormatError(`Reading this class took longer than ${maxMs / 1000} seconds and was stopped.`);
      const fl = r.u2(), nm = P.utf(r.u2()), ds = P.utf(r.u2());
      const attributes = readAttributes(r, P, `${kind} ${nm}`, warnings);
      list.push({ access: fl, name: nm, descriptor: ds, attributes });
    }
    return list;
  };
  const fields = members('field');
  const methods = members('method');
  const attributes = readAttributes(r, P, 'the class', warnings);
  if (r.p !== buf.length) warnings.push(`${buf.length - r.p} extra bytes after the end of the class.`);
  const attr = (list, n) => list.find((a) => a.name === n);

  const isInterface = (access & 0x200) !== 0, isAnnotation = (access & 0x2000) !== 0, isEnum = (access & 0x4000) !== 0, isModule = (access & 0x8000) !== 0;
  const simple = name.slice(name.lastIndexOf('.') + 1);
  const sigAttr = attr(attributes, 'Signature');
  const csig = sigAttr ? D.classSignature(sigAttr.value) : null;
  const kindWord = isModule ? 'module' : isAnnotation ? '@interface' : isInterface ? 'interface' : isEnum ? 'enum' : 'class';
  const mods = modifiers(access, CLASS_FLAGS, ['super', 'interface', 'annotation', 'enum', 'module', 'synthetic', ...(isInterface ? ['abstract'] : [])]);
  let decl = `${mods.length ? `${mods.join(' ')} ` : ''}${kindWord} ${name}${csig ? csig.typeParams : ''}`;
  const sup = csig ? csig.superClass : superName;
  const ifs = csig ? csig.interfaces : interfaces;
  if (!isInterface && sup && sup !== 'java.lang.Object' && !(isEnum && /^java\.lang\.Enum/.test(sup)) && !/^java\.lang\.Record$/.test(sup)) decl += ` extends ${sup}`;
  if (ifs.length && !isAnnotation) decl += `${isInterface ? ' extends ' : ' implements '}${ifs.join(', ')}`;

  const fieldModels = fields.map((f) => {
    const sig = attr(f.attributes, 'Signature');
    const type = D.fieldType(sig ? sig.value : f.descriptor);
    const cv = attr(f.attributes, 'ConstantValue');
    const m = modifiers(f.access, FIELD_FLAGS, ['synthetic', 'enum']);
    return { name: f.name, descriptor: f.descriptor, access: hex4(f.access), flags: flagNames(f.access, FIELD_FLAGS).join(' '), decl: `${m.length ? `${m.join(' ')} ` : ''}${type} ${f.name}${cv ? ` = ${cv.value}` : ''}`, type, signature: sig ? sig.value : '', constant: cv ? cv.value : '', attributes: f.attributes.map((a) => a.name), deprecated: !!attr(f.attributes, 'Deprecated') };
  });
  const methodModels = methods.map((m) => {
    const sig = attr(m.attributes, 'Signature');
    const parts = (sig && D.methodParts(sig.value)) || D.methodParts(m.descriptor);
    const exc = attr(m.attributes, 'Exceptions');
    const code = attr(m.attributes, 'Code');
    const params = attr(m.attributes, 'MethodParameters');
    const mods = modifiers(m.access, METHOD_FLAGS, ['bridge', 'varargs', 'synthetic', ...(isInterface && !(m.access & 0x8) && !(m.access & 0x2) ? ['public', 'abstract'] : [])]);
    if (isInterface && code && !(m.access & 0x8) && !(m.access & 0x2) && !(m.access & 0x400)) mods.push('default');
    let decl;
    const shownName = m.name === '<init>' ? name : m.name === '<clinit>' ? null : m.name;
    if (!parts) decl = `${mods.join(' ')} ${m.name}${m.descriptor}`.trim();
    else if (shownName === null) decl = 'static {}';
    else {
      const ps = parts.params.slice();
      if ((m.access & 0x80) && ps.length && ps[ps.length - 1].endsWith('[]')) ps[ps.length - 1] = `${ps[ps.length - 1].slice(0, -2)}...`;
      const thr = parts.throws.length ? parts.throws : exc && exc.list ? exc.list : [];
      decl = `${mods.length ? `${mods.join(' ')} ` : ''}${parts.typeParams ? `${parts.typeParams} ` : ''}${m.name === '<init>' ? '' : `${parts.ret} `}${shownName}(${ps.join(', ')})${thr.length ? ` throws ${thr.join(', ')}` : ''}`;
    }
    return {
      name: m.name, descriptor: m.descriptor, access: hex4(m.access), flags: flagNames(m.access, METHOD_FLAGS).join(' '), decl, signature: sig ? sig.value : '',
      exceptions: exc && exc.list ? exc.list : [], params: params && params.list ? params.list : [], attributes: m.attributes.map((a) => a.name),
      code: code && code.code ? { maxStack: code.maxStack, maxLocals: code.maxLocals, length: code.code.length, handlers: code.exceptions.length, lines: code.lines ? code.lines.length : 0 } : null,
      deprecated: !!attr(m.attributes, 'Deprecated'), _code: code,
    };
  });

  if (opts.lite) {
    for (const m of methodModels) delete m._code;
    return { kind: 'class', name, superName, interfaces, decl, major, minor, java: javaVersion(major, minor), access: hex4(access), fields: fieldModels, methods: methodModels, strings: cp.filter((e) => e && e.tag === 8).map((e) => P.utf(e.a)).slice(0, 20000), warnings };
  }
  // The listing: a javap -c -p style text of the whole class.
  const listing = [];
  const src = attr(attributes, 'SourceFile');
  if (src) listing.push(`Compiled from "${src.value}"`);
  listing.push(`${decl} {`);
  listing.push(`  // ${javaVersion(major, minor)}, class file version ${major}.${minor}, flags ${hex4(access)} (${flagNames(access, CLASS_FLAGS).join(', ') || 'none'})`);
  for (const f of fieldModels) listing.push(`  ${f.decl};`, `    descriptor: ${f.descriptor}`, `    flags: ${f.access} (${f.flags || 'none'})`, '');
  let complete = true;
  for (const m of methodModels) {
    if (Date.now() - started > maxMs) { listing.push('  ... listing stopped: the time limit was reached'); complete = false; break; }
    listing.push(`  ${m.decl};`, `    descriptor: ${m.descriptor}`, `    flags: ${m.access} (${m.flags || 'none'})`);
    const c = m._code;
    if (c && c.code) {
      listing.push('    Code:', `      stack=${c.maxStack}, locals=${c.maxLocals}, length=${c.code.length}`);
      try { if (!disassemble(c.code, P, listing)) complete = false; } catch (e) {
        if (!(e instanceof ClassFormatError)) throw e;
        listing.push(`      <${e.message}>`); warnings.push(`${m.name}: ${e.message}`);
      }
      if (c.exceptions.length) {
        listing.push('    Exception table:', '       from    to  target type');
        for (const x of c.exceptions) listing.push(`      ${String(x.start).padStart(5)} ${String(x.end).padStart(5)} ${String(x.handler).padStart(5)}   ${x.type === 'any' ? 'any' : `Class ${x.type.replace(/\./g, '/')}`}`);
      }
      if (c.lines && c.lines.length) { listing.push('    LineNumberTable:'); for (const [pc, ln] of c.lines.slice(0, 5000)) listing.push(`      line ${ln}: ${pc}`); }
      if (c.vars && c.vars.length) {
        listing.push('    LocalVariableTable:', '      Start  Length  Slot  Name   Signature');
        for (const v of c.vars.slice(0, 5000)) listing.push(`      ${String(v.start).padStart(5)} ${String(v.length).padStart(7)} ${String(v.slot).padStart(5)} ${v.name.padStart(5)}   ${v.type}`);
      }
    }
    if (m.exceptions.length) listing.push(`    Exceptions:`, `      throws ${m.exceptions.join(', ')}`);
    listing.push('');
    delete m._code;
  }
  for (const m of methodModels) delete m._code;
  listing.push('}');
  const inner = attr(attributes, 'InnerClasses');
  const anyAttr = (n) => { const a = attr(attributes, n); return a ? a.value || (a.list ? a.list.join(', ') : '') : ''; };
  if (inner && inner.list) { listing.push('InnerClasses:'); for (const ic of inner.list.slice(0, 2000)) listing.push(`  ${ic.flags ? `${ic.flags} ` : ''}${ic.name === '(anonymous)' ? '' : `${ic.name} = `}${ic.inner}${ic.outer ? ` of ${ic.outer}` : ''}`); }
  const bsm = attr(attributes, 'BootstrapMethods');
  if (bsm && bsm.list) { listing.push('BootstrapMethods:'); for (const x of bsm.list.slice(0, 2000)) listing.push(`  ${x}`); }

  const pool = [];
  for (let i = 1; i < cp.length && pool.length < 70000; i++) {
    const e = cp[i];
    if (!e) continue;
    let refs = '';
    if ([7, 8, 16, 19, 20].includes(e.tag)) refs = `#${e.a}`;
    else if ([9, 10, 11, 12].includes(e.tag)) refs = `#${e.a}.#${e.b}`;
    else if (e.tag === 15) refs = `${e.kind}:#${e.a}`;
    else if (e.tag === 17 || e.tag === 18) refs = `#${e.a}:#${e.b}`;
    pool.push([i, TAGS[e.tag], refs, P.text(i)]);
  }

  return {
    kind: 'class', name, simpleName: simple, superName, interfaces, decl, kindWord,
    major, minor, java: javaVersion(major, minor), access: hex4(access), flags: flagNames(access, CLASS_FLAGS).join(' '),
    sourceFile: src ? src.value : '', signature: sigAttr ? sigAttr.value : '',
    fields: fieldModels, methods: methodModels,
    attributes: attributes.map((a) => ({ name: a.name, length: a.length, value: a.value || (a.list ? a.list.map((x) => (typeof x === 'string' ? x : `${x.flags ? `${x.flags} ` : ''}${x.inner}${x.outer ? ` of ${x.outer}` : ''}`)).slice(0, 200).join('; ') : ''), error: a.error || '' })),
    innerClasses: inner && inner.list ? inner.list.slice(0, 5000) : [],
    nestHost: anyAttr('NestHost'), permitted: anyAttr('PermittedSubclasses'), record: anyAttr('Record'), module: anyAttr('Module'),
    annotations: (attr(attributes, 'RuntimeVisibleAnnotations') || { list: [] }).list || [],
    pool, listing, listingComplete: complete, size: buf.length, warnings,
    strings: cp.filter((e) => e && e.tag === 8).map((e) => P.utf(e.a)).slice(0, 20000),
  };
}

/** Only the header: { major, minor, java } from the first 8 bytes, or null. */
function classVersion(head) {
  if (!head || head.length < 8 || head.readUInt32BE(0) !== 0xcafebabe) return null;
  const minor = head.readUInt16BE(4), major = head.readUInt16BE(6);
  return { major, minor, java: javaVersion(major, minor) };
}

module.exports = { parseClass, classVersion, javaVersion, mutf8, disassemble, ClassFormatError, TAGS, poolApi };
