// JAR Viewer & Java Decompiler webview. Every value is put on the page with textContent (never as HTML), so names
// from a hostile archive stay text. Data comes from the extension host by postMessage; nothing here uses the network.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ROW_H = 22, LINE_H = 18;
  const S = {
    model: null, name: '', java: { ok: false }, pro: { show: true, tries: {} },
    open: new Set(), filter: '', sel: null, cls: null, clsErr: '', src: new Map(), res: null, tab: 'source', main: 'overview',
    scroll: {}, compare: null, find: null, notices: [], poolFilter: '',
  };

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    // Styles go through the CSSOM (style.setProperty): the CSP has no 'unsafe-inline', so a style attribute would be dropped.
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const fmtInt = (n) => Number(n).toLocaleString('en-US');
  const fmtSize = (n) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const post = (m) => vscode.postMessage(m);
  const javaName = (major) => (major >= 49 ? `Java ${major - 44}` : major >= 46 ? `Java 1.${major - 44}` : major === 45 ? 'Java 1.1' : '');
  const isClassModel = () => S.model && S.model.kind === 'classfile';

  // ---------- tree (packages and files), virtual list ----------

  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function buildTree() {
    const m = S.model;
    const groups = new Map();
    for (const e of m.entries) {
      const d = dirOf(e.p);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(e);
    }
    const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    for (const d of dirs) groups.get(d).sort((a, b) => (a.k === 'class') - (b.k === 'class') || a.p.localeCompare(b.p));
    S.tree = { dirs, groups };
  }
  const label = (d, files) => {
    if (d === '') return '(root)';
    const classes = files.some((f) => f.k === 'class');
    const m = /^(BOOT-INF\/classes|WEB-INF\/classes|META-INF\/versions\/\d+)\/(.*)$/.exec(d);
    if (classes && m) return `${m[1]}/ ${m[2].replace(/\//g, '.')}`;
    return classes ? d.replace(/\//g, '.') : `${d}/`;
  };
  function visibleRows() {
    const q = S.filter.trim().toLowerCase();
    const rows = [];
    for (const d of S.tree.dirs) {
      const files = S.tree.groups.get(d);
      const shown = q ? files.filter((f) => f.p.toLowerCase().includes(q)) : files;
      if (!shown.length) continue;
      const open = q ? true : S.open.has(d);
      rows.push({ dir: d, n: shown.length, open, text: label(d, files) });
      if (open) for (const f of shown) rows.push({ file: f });
    }
    return rows;
  }
  function treePane() {
    const rows = visibleRows();
    const filter = h('input', { type: 'search', class: 'filter', placeholder: `Filter ${fmtInt(S.model.entries.length)} entries`, 'aria-label': 'Filter entries', value: S.filter });
    let timer;
    filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.filter = filter.value; S.scroll.tree = 0; S.afterRender = () => { const f = document.querySelector('.tree .filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }; render(); }, 150); });
    const body = h('div', { class: 'tbody treebody', tabindex: '0', role: 'tree', 'aria-label': 'Entries' });
    const spacer = h('div', { class: 'spacer', style: `height:${rows.length * ROW_H}px` });
    const layer = h('div', { class: 'layer' });
    body.append(spacer, layer);
    const draw = () => {
      const top = body.scrollTop, hgt = body.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / ROW_H) - 5), last = Math.min(rows.length, Math.ceil((top + hgt) / ROW_H) + 5);
      layer.textContent = '';
      layer.style.transform = `translateY(${first * ROW_H}px)`;
      for (let k = first; k < last; k++) {
        const r = rows[k];
        if (r.dir !== undefined) {
          layer.append(h('div', { class: 'node dir', role: 'treeitem', 'aria-expanded': r.open ? 'true' : 'false', title: r.dir || '(root)', onclick: () => { if (S.open.has(r.dir)) S.open.delete(r.dir); else S.open.add(r.dir); render(); } },
            h('span', { class: 'twist', text: r.open ? '▾' : '▸' }), h('span', { class: 'nm', text: r.text }), h('span', { class: 'count', text: fmtInt(r.n) })));
        } else {
          const f = r.file;
          const nm = f.p.slice(f.p.lastIndexOf('/') + 1);
          const inner = f.k === 'class' && nm.includes('$');
          layer.append(h('div', { class: `node file k-${f.k}${S.sel === f.p ? ' sel' : ''}${inner ? ' inner' : ''}${f.u ? ' unsafe' : ''}`, role: 'treeitem', title: `${f.p}\n${fmtSize(f.s)}${f.v ? `, ${javaName(f.v)}` : ''}${f.u ? `\n${f.u}` : ''}`, 'data-path': f.p, onclick: () => select(f.p) },
            h('span', { class: 'icon', text: f.k === 'class' ? 'C' : f.k === 'jar' ? 'J' : f.k === 'manifest' ? 'M' : '·' }), h('span', { class: 'nm', text: nm }), f.v ? h('span', { class: 'ver', text: javaName(f.v).replace('Java ', 'J') }) : null));
        }
      }
    };
    body.addEventListener('scroll', () => { S.scroll.tree = body.scrollTop; draw(); });
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); body.scrollTop = S.scroll.tree || 0; draw(); };
    return h('aside', { class: 'tree' }, h('div', { class: 'tools' }, filter), body);
  }

  function entryOf(p) { return S.model.entries.find((e) => e.p === p); }
  function select(p) {
    const e = entryOf(p);
    if (!e) return;
    S.sel = p; S.main = 'entry'; S.res = null; S.cls = null; S.clsErr = '';
    const d = dirOf(p); S.open.add(d);
    if (e.k === 'class') { S.tab = S.java.ok ? (S.tab === 'source' || !S.tab ? 'source' : S.tab) : (S.tab === 'source' ? 'bytecode' : S.tab); post({ type: 'class', path: p }); }
    else if (e.k !== 'jar') post({ type: 'resource', path: p });
    render();
  }

  // ---------- frame ----------

  function render() {
    if (!S.model) return;
    app.textContent = '';
    const m = S.model;
    const desc = isClassModel() ? `${m.cls.java} class · ${fmtSize(m.size)}` : `${m.format}${m.nestedIn ? ` inside ${m.nestedIn}` : ''} · ${fmtSize(m.size)} · ${fmtInt(m.classes)} classes${m.highest ? ` · up to ${m.highest}` : ''}`;
    const head = h('header', { class: 'top' },
      h('div', { class: 'title' }, m.nestedIn ? h('button', { class: 'btn small', 'data-act': 'back', onclick: () => post({ type: 'nested', path: '' }) }, `‹ ${S.name}`) : null,
        h('span', { class: 'fname', text: m.nestedIn ? m.name : S.name }), h('span', { class: 'desc', text: desc })),
      h('div', { class: 'actions' }, S.pro.show && m.kind === 'jar' ? proButtons() : null));
    const notices = S.notices.length ? h('div', { class: 'notices' }, ...S.notices.map((t, i) => h('div', { class: 'notice' }, h('span', { text: t }), h('button', { class: 'x', title: 'Close', 'aria-label': 'Close', onclick: () => { S.notices.splice(i, 1); render(); } }, '×')))) : null;
    let body;
    if (isClassModel()) body = h('main', { class: 'detail full' }, classDetail(m.cls, ''));
    else {
      const right = S.main === 'compare' && S.compare ? compareView() : S.main === 'find' && S.find ? findView() : S.main === 'entry' && S.sel ? entryDetail() : overview();
      const nav = [];
      nav.push(h('button', { class: 'tab' + (S.main === 'overview' ? ' on' : ''), 'data-main': 'overview', onclick: () => { S.main = 'overview'; render(); } }, 'Overview'));
      if (S.sel) nav.push(h('button', { class: 'tab' + (S.main === 'entry' ? ' on' : ''), 'data-main': 'entry', onclick: () => { S.main = 'entry'; render(); } }, S.sel.slice(S.sel.lastIndexOf('/') + 1)));
      if (S.compare) nav.push(h('button', { class: 'tab' + (S.main === 'compare' ? ' on' : ''), 'data-main': 'compare', onclick: () => { S.main = 'compare'; render(); } }, 'Compare'));
      if (S.find) nav.push(h('button', { class: 'tab' + (S.main === 'find' ? ' on' : ''), 'data-main': 'find', onclick: () => { S.main = 'find'; render(); } }, 'Find'));
      body = h('div', { class: 'split' }, treePane(), h('main', { class: 'detail' }, h('nav', { class: 'tabs', role: 'tablist' }, ...nav), h('div', { class: 'view', id: 'view' }, right)));
    }
    const foot = document.getElementById('zovo-footer');
    app.append(head, notices || '', body, foot ? foot.content.cloneNode(true) : '');
    if (S.afterRender) { const f = S.afterRender; S.afterRender = null; f(); }
  }

  function proButtons() {
    const tries = (f) => (S.pro.licensed ? 'Zovo Pro' : `Zovo Pro tool, ${S.pro.tries[f] ?? 3} free tr${(S.pro.tries[f] ?? 3) === 1 ? 'y' : 'ies'} left`);
    return [
      h('button', { class: 'btn', 'data-tool': 'export', title: `Decompile every class into a folder of .java files (${tries('export')})`, onclick: () => post({ type: 'tool', tool: 'export' }) }, 'Export sources…'),
      h('button', { class: 'btn', 'data-tool': 'compare', title: `Compare with another JAR (${tries('compare')})`, onclick: () => post({ type: 'tool', tool: 'compare' }) }, 'Compare…'),
      h('button', { class: 'btn', 'data-tool': 'find', title: `Find a class, method or string in every JAR of a folder (${tries('find')})`, onclick: () => post({ type: 'tool', tool: 'find' }) }, 'Find in folder…'),
    ];
  }

  function kv(pairs) {
    return h('table', { class: 'kv' }, h('tbody', {}, ...pairs.filter((p) => p && p[1] !== '' && p[1] !== undefined && p[1] !== null).map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', {}, v instanceof Node ? v : h('span', { class: 'val', text: String(v) }))))));
  }
  function notes(list, title) {
    if (!list || !list.length) return null;
    return h('div', { class: 'notice', role: 'note' }, h('b', { text: title || `${list.length} note${list.length === 1 ? '' : 's'} about this file` }), h('ul', {}, ...list.slice(0, 50).map((w) => h('li', { text: w }))));
  }

  function overview() {
    const m = S.model;
    const mf = m.manifest;
    const vers = m.versions.length ? h('div', { class: 'bars' }, ...m.versions.map(([v, n]) => h('div', { class: 'bar' }, h('span', { class: 'bl', text: v }), h('span', { class: 'bv', style: `width:${Math.max(2, Math.round((n / Math.max(1, m.scanned)) * 220))}px` }), h('span', { class: 'bn', text: fmtInt(n) })))) : '';
    return h('div', { class: 'pad' },
      notes(m.problems),
      h('h2', { text: m.title ? `${m.title}${m.version ? ` ${m.version}` : ''}` : `${m.format} archive` }),
      kv([
        ['Format', `${m.format}${m.zip64 ? ' (ZIP64)' : ''}${m.nestedIn ? `, nested in ${m.nestedIn}` : ''}`], ['Size', fmtSize(m.size)],
        ['Entries', fmtInt(m.entries.length)], ['Classes', fmtInt(m.classes)], ['Packages', fmtInt(m.packages)], ['Resources', fmtInt(m.resources)],
        ['Main-Class', m.mainClass], ['Start-Class', m.startClass], ['Created by', m.createdBy], ['Module', m.module],
        ['Multi-release', m.multiRelease ? 'yes (META-INF/versions)' : ''], ['Highest Java version', m.highest],
        m.versions.length ? ['Java versions', vers] : null,
        m.comment ? ['Comment', m.comment] : null,
      ]),
      m.nested.length ? h('section', {}, h('h3', { text: `Nested archives (${m.nested.length})` }), m.nestedIn ? h('p', { class: 'muted', text: 'Nested archives open one level deep.' }) : null,
        h('ul', { class: 'nested' }, ...m.nested.slice(0, 500).map((p) => h('li', {}, h('span', { class: 'mono', text: p }), m.nestedIn ? null : h('button', { class: 'btn small', 'data-nested': p, onclick: () => post({ type: 'nested', path: p }) }, 'Open'))))) : null,
      mf ? h('section', {}, h('h3', { text: 'META-INF/MANIFEST.MF' }), mf.error ? h('p', { class: 'err', text: mf.error }) : kv(mf.main.slice(0, 60))) : h('p', { class: 'muted', text: 'This archive has no META-INF/MANIFEST.MF.' }),
      javaLine());
  }

  function javaLine() {
    if (S.java.ok) return h('p', { class: 'muted small', text: `Decompiling with CFR 0.152 on Java ${S.java.version} (${S.java.from}).` });
    return h('p', { class: 'muted small javaline' }, 'Decompiled Java source needs a Java runtime (8 or newer): set jarViewer.javaPath, or JAVA_HOME, or put java on PATH. The bytecode view works without it. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'settings', java: true }); } }, 'Open the setting'));
  }

  // ---------- entry views ----------

  function entryDetail() {
    const e = entryOf(S.sel);
    if (!e) return h('p', { class: 'pad muted', text: 'Nothing selected.' });
    if (e.k === 'class') {
      if (S.clsErr) return h('div', { class: 'pad' }, h('h2', { text: e.p }), h('p', { class: 'err', text: S.clsErr }));
      if (!S.cls) return h('p', { class: 'pad muted', text: 'Reading the class...' });
      return classDetail(S.cls, e.p);
    }
    if (e.k === 'jar') {
      return h('div', { class: 'pad' }, h('h2', { text: e.p }), kv([['Size', fmtSize(e.s)], ['Packed', fmtSize(e.c)]]),
        S.model.nestedIn ? h('p', { class: 'muted', text: 'Nested archives open one level deep. Go back to the outer archive to open another one.' }) : h('button', { class: 'btn', 'data-nested': e.p, onclick: () => post({ type: 'nested', path: e.p }) }, 'Open nested archive'));
    }
    if (!S.res) return h('p', { class: 'pad muted', text: 'Reading...' });
    if (S.res.error) return h('div', { class: 'pad' }, h('h2', { text: e.p }), h('p', { class: 'err', text: S.res.error }));
    const r = S.res.res;
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, h('b', { text: e.p }), h('span', { class: 'muted', text: r.note || fmtSize(r.size) }),
      r.binary ? null : h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the text', text: r.text }) }, 'Copy'),
      r.binary ? null : h('button', { class: 'btn small', onclick: () => post({ type: 'openText', text: r.text }) }, 'Open in editor')),
    textView(r.text.split('\n'), 'res', null));
  }

  const CLASS_TABS = [['source', 'Java source'], ['bytecode', 'Bytecode'], ['members', 'Members'], ['pool', 'Constant pool'], ['info', 'Class info']];
  function classDetail(c, path) {
    const tabs = h('nav', { class: 'tabs sub', role: 'tablist' }, ...CLASS_TABS.map(([id, lbl]) => h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'data-tab': id, onclick: () => { S.tab = id; render(); } }, lbl,
      id === 'members' ? h('span', { class: 'count', text: fmtInt(c.fields.length + c.methods.length) }) : id === 'pool' ? h('span', { class: 'count', text: fmtInt(c.pool.length) }) : null)));
    let v;
    if (S.tab === 'source') v = sourceView(c, path);
    else if (S.tab === 'bytecode') v = h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, h('span', { class: 'muted', text: `${fmtInt(c.listing.length)} lines, javap -c style${c.listingComplete ? '' : ' (stopped early)'}` }),
      h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the listing', text: c.listing.join('\n') }) }, 'Copy'),
      h('button', { class: 'btn small', onclick: () => post({ type: 'openText', text: c.listing.join('\n') }) }, 'Open in editor')), textView(c.listing, `bc:${path}`, 'bytecode'));
    else if (S.tab === 'members') v = membersView(c);
    else if (S.tab === 'pool') v = poolView(c, path);
    else v = infoView(c);
    return h('div', { class: 'classview' }, h('div', { class: 'clshead' }, h('span', { class: 'decl mono', text: c.decl }), h('span', { class: 'jv', title: `class file version ${c.major}.${c.minor}`, text: c.java })), tabs, h('div', { class: 'view' }, v));
  }

  function sourceView(c, path) {
    const key = path || '';
    const s = S.src.get(key);
    if (!S.java.ok) return h('div', { class: 'pad' }, javaLine(), h('button', { class: 'btn', onclick: () => { S.tab = 'bytecode'; render(); } }, 'Show the bytecode'));
    if (!s) return h('div', { class: 'pad' }, h('p', { class: 'muted', text: `Decompiling ${c.name} with CFR...` }));
    if (s.error) return h('div', { class: 'pad' }, h('p', { class: 'err', text: s.error === 'nojava' ? 'No Java runtime.' : s.error }), h('button', { class: 'btn', onclick: () => { S.tab = 'bytecode'; render(); } }, 'Show the bytecode'));
    const lines = s.text.split('\n');
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, h('span', { class: 'muted', text: `${fmtInt(lines.length)} lines${path.includes('$') ? ', shown with its outer class' : ''}` }),
      h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the source', text: s.text }) }, 'Copy'),
      h('button', { class: 'btn small', onclick: () => post({ type: 'openText', text: s.text, language: 'java' }) }, 'Open in editor')), textView(lines, `src:${path}`, 'java'));
  }

  function membersView(c) {
    const row = (kind, m) => h('tr', {}, h('td', { class: 'mk', text: kind }), h('td', { class: 'mono', text: m.decl }), h('td', { class: 'mono muted', text: m.descriptor }), h('td', { class: 'mono muted', text: m.access }), h('td', { class: 'num', text: m.code ? `${fmtInt(m.code.length)} bytes` : '' }));
    return h('div', { class: 'pad' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Kind', 'Declaration', 'Descriptor', 'Flags', 'Code'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...c.fields.slice(0, 5000).map((f) => row('field', f)), ...c.methods.slice(0, 5000).map((m) => row(m.name === '<init>' ? 'constructor' : m.name === '<clinit>' ? 'static init' : 'method', m)))));
  }

  function poolView(c, path) {
    const q = S.poolFilter.trim().toLowerCase();
    const rows = q ? c.pool.filter((r) => r.some((v) => String(v).toLowerCase().includes(q))) : c.pool;
    const filter = h('input', { type: 'search', class: 'filter', placeholder: `Filter ${fmtInt(c.pool.length)} constants`, 'aria-label': 'Filter constants', value: S.poolFilter });
    let timer;
    filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.poolFilter = filter.value; S.scroll[`pool:${path}`] = 0; S.afterRender = () => { const f = document.querySelector('.view .filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }; render(); }, 150); });
    const lines = rows.map((r) => `${String(`#${r[0]}`).padStart(6)} = ${String(r[1]).padEnd(18)} ${String(r[2]).padEnd(14)} ${r[3]}`);
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' }, filter, h('span', { class: 'muted', text: `${fmtInt(rows.length)} of ${fmtInt(c.pool.length)}` }),
      h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the constants', text: lines.join('\n') }) }, 'Copy')), textView(lines, `pool:${path}`, null));
  }

  function infoView(c) {
    return h('div', { class: 'pad' }, notes(c.warnings),
      kv([['Class', c.name], ['Java version', `${c.java} (class file ${c.major}.${c.minor})`], ['Access flags', `${c.access} ${c.flags}`], ['Super class', c.superName], ['Interfaces', c.interfaces.join(', ')],
        ['Source file', c.sourceFile], ['Generic signature', c.signature], ['Nest host', c.nestHost], ['Permitted subclasses', c.permitted], ['Record components', c.record], ['Module', c.module],
        ['Annotations', c.annotations.join(' ')], ['Size', fmtSize(c.size)]]),
      c.innerClasses.length ? h('section', {}, h('h3', { text: `Inner classes (${c.innerClasses.length})` }), h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Inner class', 'Outer class', 'Name', 'Flags'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...c.innerClasses.slice(0, 2000).map((x) => h('tr', {}, h('td', { class: 'mono', text: x.inner }), h('td', { class: 'mono', text: x.outer }), h('td', { class: 'mono', text: x.name }), h('td', { class: 'muted', text: x.flags })))))) : null,
      h('section', {}, h('h3', { text: `Attributes (${c.attributes.length})` }), h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Name', 'Bytes', 'Value'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...c.attributes.map((a) => h('tr', {}, h('td', { class: 'mono', text: a.name }), h('td', { class: 'num', text: fmtInt(a.length) }), h('td', { class: 'mono', text: a.error ? `error: ${a.error}` : a.value })))))));
  }

  // ---------- virtual text view with light highlighting ----------

  const JAVA_KW = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null'.split(' '));
  function javaTokens(line, state) {
    // returns [nodes, inComment]
    const out = [];
    let i = 0, buf = '', inC = state;
    const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
    while (i < line.length) {
      if (inC) { const j = line.indexOf('*/', i); const end = j < 0 ? line.length : j + 2; flush(); out.push(h('span', { class: 't-c', text: line.slice(i, end) })); i = end; inC = j < 0; continue; }
      const ch = line[i];
      if (ch === '/' && line[i + 1] === '/') { flush(); out.push(h('span', { class: 't-c', text: line.slice(i) })); break; }
      if (ch === '/' && line[i + 1] === '*') { inC = true; continue; }
      if (ch === '"' || ch === "'") { let j = i + 1; while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1; flush(); out.push(h('span', { class: 't-s', text: line.slice(i, j + 1) })); i = j + 1; continue; }
      if (/[A-Za-z_$]/.test(ch)) { let j = i; while (j < line.length && /[\w$]/.test(line[j])) j++; const w = line.slice(i, j); if (JAVA_KW.has(w)) { flush(); out.push(h('span', { class: 't-k', text: w })); } else if (/^[A-Z]/.test(w)) { flush(); out.push(h('span', { class: 't-t', text: w })); } else buf += w; i = j; continue; }
      if (ch === '@' && /[A-Za-z]/.test(line[i + 1] || '')) { let j = i + 1; while (j < line.length && /[\w.]/.test(line[j])) j++; flush(); out.push(h('span', { class: 't-a', text: line.slice(i, j) })); i = j; continue; }
      if (/[0-9]/.test(ch)) { let j = i; while (j < line.length && /[\w.]/.test(line[j])) j++; flush(); out.push(h('span', { class: 't-n', text: line.slice(i, j) })); i = j; continue; }
      buf += ch; i++;
    }
    flush();
    return [out, inC];
  }
  function bytecodeTokens(line) {
    const m = /^(\s*\d+: )([a-z_0-9]+)(.*?)(\/\/.*)?$/.exec(line);
    if (!m) return [document.createTextNode(line)];
    return [h('span', { class: 't-off', text: m[1] }), h('span', { class: 't-k', text: m[2] }), document.createTextNode(m[3] || ''), m[4] ? h('span', { class: 't-c', text: m[4] }) : null].filter(Boolean);
  }
  function textView(lines, key, mode) {
    let states = null;
    if (mode === 'java') { states = new Uint8Array(lines.length + 1); let st = false; for (let i = 0; i < lines.length; i++) { states[i] = st ? 1 : 0; const l = lines[i]; let k = 0; while (k < l.length) { if (st) { const j = l.indexOf('*/', k); if (j < 0) { k = l.length; } else { st = false; k = j + 2; } } else { const a = l.indexOf('/*', k), b = l.indexOf('//', k), q = l.search(/["']/); if (a < 0) break; if ((b >= 0 && b < a) || (q >= 0 && q < a)) break; st = true; k = a + 2; } } } }
    const box = h('div', { class: 'tbody code', tabindex: '0' });
    const gutter = String(lines.length).length;
    box.append(h('div', { class: 'spacer', style: `height:${lines.length * LINE_H + 8}px` }));
    const layer = h('div', { class: 'layer codelayer' });
    box.append(layer);
    const draw = () => {
      const top = box.scrollTop, hgt = box.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / LINE_H) - 10), last = Math.min(lines.length, Math.ceil((top + hgt) / LINE_H) + 10);
      layer.textContent = '';
      layer.style.transform = `translateY(${first * LINE_H}px)`;
      for (let k = first; k < last; k++) {
        const l = lines[k];
        const parts = mode === 'java' ? javaTokens(l, states[k] === 1)[0] : mode === 'bytecode' ? bytecodeTokens(l) : [document.createTextNode(l)];
        layer.append(h('div', { class: 'ln' }, h('span', { class: 'gut', text: String(k + 1).padStart(gutter) }), h('span', { class: 'lt' }, ...parts)));
      }
    };
    box.addEventListener('scroll', () => { S.scroll[key] = box.scrollTop; draw(); });
    const prev = S.afterRender;
    S.afterRender = () => { if (prev) prev(); box.scrollTop = S.scroll[key] || 0; draw(); };
    return box;
  }

  // ---------- compare / find ----------

  function compareView() {
    const { result: r, nameA, nameB } = S.compare;
    const list = (title, items, cls) => (items.length ? h('details', { open: items.length < 200 }, h('summary', { text: `${title} (${fmtInt(items.length)})` }), h('ul', { class: `diff ${cls}` }, ...items.slice(0, 3000).map((k) => h('li', { text: k })))) : null);
    return h('div', { class: 'pad' },
      h('div', { class: 'tools' }, h('b', { text: `${nameA} compared with ${nameB}` }), h('button', { class: 'btn small', onclick: () => post({ type: 'saveCompare' }) }, 'Open as Markdown')),
      notes(r.problems, 'Notes'),
      kv([['Classes', `${fmtInt(r.classesA)} → ${fmtInt(r.classesB)}`], ['Java versions', `${r.versionsA.map(([v, n]) => `${v}: ${n}`).join(', ') || '-'} → ${r.versionsB.map(([v, n]) => `${v}: ${n}`).join(', ') || '-'}`],
        ['Summary', `${fmtInt(r.addedCount)} added, ${fmtInt(r.removedCount)} removed, ${fmtInt(r.changedCount)} changed, ${fmtInt(r.same)} the same`]]),
      list(`Classes added in ${nameB}`, r.added, 'add'), list(`Classes removed in ${nameB}`, r.removed, 'del'),
      r.changed.length ? h('details', { open: r.changed.length < 100 }, h('summary', { text: `Classes changed (${fmtInt(r.changedCount)})` }),
        ...r.changed.slice(0, 2000).map((c) => h('div', { class: 'chg' }, h('div', { class: 'mono b', text: c.name }),
          h('ul', { class: 'diff' }, ...c.notes.map((n) => h('li', { text: n }))),
          c.methodsAdded.length || c.fieldsAdded.length ? h('ul', { class: 'diff add' }, ...[...c.methodsAdded, ...c.fieldsAdded].map((n) => h('li', { text: n }))) : null,
          c.methodsRemoved.length || c.fieldsRemoved.length ? h('ul', { class: 'diff del' }, ...[...c.methodsRemoved, ...c.fieldsRemoved].map((n) => h('li', { text: n }))) : null))) : null,
      list('Resources added', r.resources.added, 'add'), list('Resources removed', r.resources.removed, 'del'), list('Resources changed', r.resources.changed, ''));
  }

  function findView() {
    const { results, summary } = S.find;
    const list = h('div', { class: 'tbody plain' }, ...results.slice(0, 5000).map((r) => h('div', { class: 'tr link findrow', title: `Open ${r.file}${r.jar ? ` › ${r.jar}` : ''}`, onclick: () => post({ type: 'openFile', path: r.file, select: r.jar ? '' : r.path }) },
      h('span', { class: 'td', text: r.kind }), h('span', { class: 'td mono', text: r.text }), h('span', { class: 'td mono', text: r.cls }), h('span', { class: 'td', text: `${r.rel}${r.jar ? ` › ${r.jar}` : ''}` }))));
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tools' },
      h('b', { text: `${fmtInt(summary.matches)} match${summary.matches === 1 ? '' : 'es'} for "${summary.query}"` }),
      h('span', { class: 'muted', text: `in ${fmtInt(summary.archives)} of ${fmtInt(summary.files)} archives under ${summary.root}${summary.stopped ? ' (stopped)' : ''}` }),
      h('button', { class: 'btn small', onclick: () => post({ type: 'copy', what: 'the matches', text: results.map((r) => [r.kind, r.text, r.cls, r.rel, r.jar].join('\t')).join('\n') }) }, 'Copy')), list);
  }

  // ---------- messages ----------

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.pro) S.pro = m.pro;
    if (m.java) S.java = m.java;
    if (m.type === 'model') {
      const keepTools = { compare: S.compare, find: S.find };
      S.model = m.model; S.name = m.name; S.sel = null; S.cls = null; S.res = null; S.src = new Map(); S.filter = ''; S.scroll = {}; S.open = new Set();
      S.compare = keepTools.compare; S.find = keepTools.find; S.main = 'overview';
      if (m.model.kind === 'jar') {
        buildTree();
        if (S.tree.dirs.length <= 3) for (const d of S.tree.dirs) S.open.add(d);
      } else { S.tab = S.java.ok ? 'source' : 'bytecode'; S.cls = m.model.cls; post({ type: 'decompile', path: '' }); }
      render();
      post({ type: 'rendered' });
    } else if (m.type === 'error') {
      app.textContent = '';
      app.append(h('div', { class: 'pad' }, h('h2', { text: m.notJar ? 'Not a JAR or class file' : 'This file could not be read' }), h('p', { text: m.message }),
        m.notJar ? h('p', { class: 'muted', text: 'JAR Viewer reads Java archives (.jar, .war, .ear, .aar) and class files (.class).' }) : null));
      const foot = document.getElementById('zovo-footer'); if (foot) app.append(foot.content.cloneNode(true));
    } else if (m.type === 'class') {
      if (m.path !== S.sel) return;
      if (m.error) S.clsErr = m.error; else S.cls = m.cls;
      render();
    } else if (m.type === 'source') {
      S.src.set(m.path, m.error ? { error: m.error } : { text: m.text });
      if ((isClassModel() && m.path === '') || m.path === S.sel) render();
    } else if (m.type === 'resource') {
      if (m.path !== S.sel) return;
      S.res = m; render();
    } else if (m.type === 'select') {
      if (S.model && S.model.kind === 'jar' && entryOf(m.path)) select(m.path);
    } else if (m.type === 'compare') {
      S.compare = m; S.main = 'compare'; render();
    } else if (m.type === 'find') {
      S.find = m; S.main = 'find'; render();
    } else if (m.type === 'exported') {
      S.notices.push(m.text); render();
    } else if (m.type === 'java') {
      S.src = new Map();
      if (S.model) { if (S.sel && S.cls && S.java.ok) post({ type: 'decompile', path: S.sel }); else if (isClassModel() && S.java.ok) post({ type: 'decompile', path: '' }); render(); }
    } else if (m.type === 'pro') {
      if (S.model) render();
    } else if (m.type === 'notice') {
      S.notices.push(m.text); if (S.model) render();
    }
  });
  window.addEventListener('resize', () => { if (S.model) render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.model) render(); });
  post({ type: 'ready' });
}());
