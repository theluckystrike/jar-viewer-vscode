'use strict';
// Field and method descriptors and generic signatures, rendered as Java source types.
// Descriptor: (ILjava/lang/String;[J)V -> (int, java.lang.String, long[]) void
// Signature:  <T:Ljava/lang/Object;>(Ljava/util/List<TT;>;)TT; -> <T> (java.util.List<T>) T
const PRIM = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' };
const MAX_DEPTH = 64;

class SigError extends Error {}

const dotted = (internal) => String(internal).replace(/\//g, '.');

/** Parses one type at s[i]; returns [text, next index]. Handles descriptors and signatures (generics). */
function parseType(s, i, depth = 0) {
  if (depth > MAX_DEPTH) throw new SigError('nested too deep');
  const c = s[i];
  if (c === undefined) throw new SigError('ends early');
  if (PRIM[c]) return [PRIM[c], i + 1];
  if (c === '[') { const [t, j] = parseType(s, i + 1, depth + 1); return [`${t}[]`, j]; }
  if (c === 'T') { const j = s.indexOf(';', i); if (j < 0) throw new SigError('type variable without ;'); return [s.slice(i + 1, j), j + 1]; }
  if (c === 'L') {
    let j = i + 1, out = '';
    while (j < s.length && s[j] !== ';') {
      const ch = s[j];
      if (ch === '<') {
        const args = [];
        j++;
        while (s[j] !== '>') {
          if (j >= s.length) throw new SigError('type arguments without >');
          if (s[j] === '*') { args.push('?'); j++; continue; }
          let prefix = '';
          if (s[j] === '+') { prefix = '? extends '; j++; } else if (s[j] === '-') { prefix = '? super '; j++; }
          const [t, k] = parseType(s, j, depth + 1);
          args.push(prefix + t); j = k;
        }
        out += `<${args.join(', ')}>`;
        j++;
      } else if (ch === '.') { out += '.'; j++; } // inner class of a generic outer class
      else if (ch === '/') { out += '.'; j++; } else { out += ch; j++; }
    }
    if (s[j] !== ';') throw new SigError('class type without ;');
    return [out, j + 1];
  }
  throw new SigError(`unexpected "${c}"`);
}

function fieldType(desc) {
  try { const [t, j] = parseType(desc, 0); return j === desc.length ? t : desc; } catch { return desc; }
}

/** Method descriptor or signature -> { typeParams, params: [..], ret, throws: [..] }; null when it does not parse. */
function methodParts(desc) {
  try {
    let i = 0;
    let typeParams = '';
    if (desc[0] === '<') { const r = typeParameters(desc, 0); typeParams = r[0]; i = r[1]; }
    if (desc[i] !== '(') return null;
    i++;
    const params = [];
    let guard = 0;
    while (desc[i] !== ')') { if (i >= desc.length || ++guard > 300) return null; const [t, j] = parseType(desc, i); params.push(t); i = j; }
    i++;
    const [ret, j] = parseType(desc, i);
    i = j;
    const throws = [];
    while (desc[i] === '^') { const [t, k] = parseType(desc, i + 1); throws.push(t); i = k; }
    if (i !== desc.length) return null;
    return { typeParams, params, ret, throws };
  } catch { return null; }
}

/** <T:Ljava/lang/Object;U::Ljava/lang/Comparable<TU;>;> -> ['<T, U extends java.lang.Comparable<U>>', next]. */
function typeParameters(s, i) {
  if (s[i] !== '<') return ['', i];
  i++;
  const out = [];
  let guard = 0;
  while (s[i] !== '>') {
    if (i >= s.length || ++guard > 300) throw new SigError('type parameters without >');
    const colon = s.indexOf(':', i);
    if (colon < 0) throw new SigError('type parameter without :');
    const name = s.slice(i, colon);
    i = colon + 1;
    const bounds = [];
    if (s[i] !== ':' && s[i] !== '>') { const [t, j] = parseType(s, i); bounds.push(t); i = j; }
    while (s[i] === ':') { const [t, j] = parseType(s, i + 1); bounds.push(t); i = j; }
    const shown = bounds.filter((b) => b !== 'java.lang.Object');
    out.push(shown.length ? `${name} extends ${shown.join(' & ')}` : name);
  }
  return [`<${out.join(', ')}>`, i + 1];
}

/** Class signature -> { typeParams, superClass, interfaces } or null. */
function classSignature(sig) {
  try {
    const [typeParams, i0] = typeParameters(sig, 0);
    let [superClass, i] = parseType(sig, i0);
    const interfaces = [];
    let guard = 0;
    while (i < sig.length) { if (++guard > 1000) return null; const [t, j] = parseType(sig, i); interfaces.push(t); i = j; }
    return { typeParams, superClass, interfaces };
  } catch { return null; }
}

module.exports = { PRIM, dotted, parseType, fieldType, methodParts, typeParameters, classSignature, SigError };
