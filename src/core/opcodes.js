'use strict';
// The JVM instruction set (JVMS chapter 6): mnemonic and operand layout of each opcode.
// Operand kinds: b = signed byte, s = signed short, l = local index (u1, u2 after wide), c1/c2 = constant pool index,
// br2/br4 = branch offset, inc = iinc (local, const), iface = invokeinterface (cp, count, 0), indy = invokedynamic
// (cp, 0, 0), atype = newarray type, multi = multianewarray (cp, dims), table/lookup = switches, wide = prefix.
const NAMES = [
  'nop', 'aconst_null', 'iconst_m1', 'iconst_0', 'iconst_1', 'iconst_2', 'iconst_3', 'iconst_4', 'iconst_5', 'lconst_0', 'lconst_1',
  'fconst_0', 'fconst_1', 'fconst_2', 'dconst_0', 'dconst_1', 'bipush', 'sipush', 'ldc', 'ldc_w', 'ldc2_w', 'iload', 'lload', 'fload',
  'dload', 'aload', 'iload_0', 'iload_1', 'iload_2', 'iload_3', 'lload_0', 'lload_1', 'lload_2', 'lload_3', 'fload_0', 'fload_1',
  'fload_2', 'fload_3', 'dload_0', 'dload_1', 'dload_2', 'dload_3', 'aload_0', 'aload_1', 'aload_2', 'aload_3', 'iaload', 'laload',
  'faload', 'daload', 'aaload', 'baload', 'caload', 'saload', 'istore', 'lstore', 'fstore', 'dstore', 'astore', 'istore_0', 'istore_1',
  'istore_2', 'istore_3', 'lstore_0', 'lstore_1', 'lstore_2', 'lstore_3', 'fstore_0', 'fstore_1', 'fstore_2', 'fstore_3', 'dstore_0',
  'dstore_1', 'dstore_2', 'dstore_3', 'astore_0', 'astore_1', 'astore_2', 'astore_3', 'iastore', 'lastore', 'fastore', 'dastore',
  'aastore', 'bastore', 'castore', 'sastore', 'pop', 'pop2', 'dup', 'dup_x1', 'dup_x2', 'dup2', 'dup2_x1', 'dup2_x2', 'swap', 'iadd',
  'ladd', 'fadd', 'dadd', 'isub', 'lsub', 'fsub', 'dsub', 'imul', 'lmul', 'fmul', 'dmul', 'idiv', 'ldiv', 'fdiv', 'ddiv', 'irem', 'lrem',
  'frem', 'drem', 'ineg', 'lneg', 'fneg', 'dneg', 'ishl', 'lshl', 'ishr', 'lshr', 'iushr', 'lushr', 'iand', 'land', 'ior', 'lor', 'ixor',
  'lxor', 'iinc', 'i2l', 'i2f', 'i2d', 'l2i', 'l2f', 'l2d', 'f2i', 'f2l', 'f2d', 'd2i', 'd2l', 'd2f', 'i2b', 'i2c', 'i2s', 'lcmp', 'fcmpl',
  'fcmpg', 'dcmpl', 'dcmpg', 'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle', 'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge',
  'if_icmpgt', 'if_icmple', 'if_acmpeq', 'if_acmpne', 'goto', 'jsr', 'ret', 'tableswitch', 'lookupswitch', 'ireturn', 'lreturn',
  'freturn', 'dreturn', 'areturn', 'return', 'getstatic', 'putstatic', 'getfield', 'putfield', 'invokevirtual', 'invokespecial',
  'invokestatic', 'invokeinterface', 'invokedynamic', 'new', 'newarray', 'anewarray', 'arraylength', 'athrow', 'checkcast',
  'instanceof', 'monitorenter', 'monitorexit', 'wide', 'multianewarray', 'ifnull', 'ifnonnull', 'goto_w', 'jsr_w',
];
const OPS = new Array(256).fill(null);
NAMES.forEach((n, i) => { OPS[i] = { name: n, kind: '' }; });
OPS[202] = { name: 'breakpoint', kind: '' };
OPS[254] = { name: 'impdep1', kind: '' };
OPS[255] = { name: 'impdep2', kind: '' };
const set = (kind, ...codes) => { for (const c of codes) OPS[c].kind = kind; };
set('b', 16); set('s', 17); set('c1', 18); set('c2', 19, 20, 178, 179, 180, 181, 182, 183, 184, 187, 189, 192, 193);
set('l', 21, 22, 23, 24, 25, 54, 55, 56, 57, 58, 169);
set('inc', 132);
for (let c = 153; c <= 168; c++) set('br2', c);
set('br2', 198, 199); set('br4', 200, 201);
set('table', 170); set('lookup', 171); set('iface', 185); set('indy', 186); set('atype', 188); set('multi', 197); set('wide', 196);
const ATYPES = { 4: 'boolean', 5: 'char', 6: 'float', 7: 'double', 8: 'byte', 9: 'short', 10: 'int', 11: 'long' };
const WIDE_OK = new Set([21, 22, 23, 24, 25, 54, 55, 56, 57, 58, 169, 132]);

module.exports = { OPS, ATYPES, WIDE_OK, NAMES };
