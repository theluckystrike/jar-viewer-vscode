'use strict';
// A stand-in for the `java` binary in tests: answers -version, and for `-jar cfr.jar <input> ...` writes what CFR
// would (stdout, or .java files with --outputdir). It logs its argument list to FAKE_JAVA_LOG so tests can check that
// the input is a staged JAR in the extension's storage, -Xmx512m is set, and no shell was used.
const fs = require('fs');
const path = require('path');

/** Writes an executable fake java into dir and returns its path. */
function makeFakeJava(dir, { sleepMs = 0, version = '21.0.9', fail = false } = {}) {
  const p = path.join(dir, `java-${Math.random().toString(36).slice(2)}`);
  const src = `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '-version') { process.stderr.write('openjdk version "${version}" 2026-01-20\\nOpenJDK Runtime Environment (fake)\\n'); process.exit(0); }
if (process.env.FAKE_JAVA_LOG) fs.appendFileSync(process.env.FAKE_JAVA_LOG, JSON.stringify(args) + '\\n');
const go = () => {
  ${fail ? "process.stderr.write('Exception in thread main java.lang.OutOfMemoryError\\n'); process.exit(1);" : ''}
  const J = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'core', 'jar.js'))});
  const { FileSource } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'core', 'source.js'))});
  const i = args.indexOf('-jar');
  const input = args[i + 2];
  const j = J.openZip(new FileSource(input));
  const classes = j.zip.entries.filter((e) => e.path.endsWith('.class')).map((e) => e.path.replace(/\\.class$/, ''));
  const od = args.indexOf('--outputdir');
  if (od >= 0) {
    const out = args[od + 1];
    process.stderr.write('Processing ' + input + ' (use silent to silence)\\n');
    for (const c of classes) {
      if (c.includes('$')) continue;
      process.stderr.write('Processing ' + c.replace(/\\//g, '.') + '\\n');
      const f = path.join(out, c + '.java');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'package ' + path.dirname(c).replace(/\\//g, '.') + ';\\npublic class ' + path.basename(c) + ' {}\\n');
    }
    fs.writeFileSync(path.join(out, 'summary.txt'), 'done');
  } else {
    const top = classes.filter((c) => !c.includes('$'));
    process.stdout.write('/*\\n * Decompiled with CFR 0.152.\\n */\\n' + top.map((c) => 'public class ' + c.replace(/\\//g, '.') + ' { /* inner: ' + classes.filter((x) => x.startsWith(c + '$')).length + ' */ }').join('\\n') + '\\n');
  }
};
${sleepMs ? `setTimeout(go, ${sleepMs});` : 'go();'}
`;
  fs.writeFileSync(p, src, { mode: 0o755 });
  return p;
}

module.exports = { makeFakeJava };
