(function () {
  var root = document.getElementById('mint-pack-checker');
  if (!root || root.getAttribute('data-ready')) return;
  root.setAttribute('data-ready', '1');

  var INK = '#e5e7eb', MUTE = '#9ca3af', BLUE = '#60a5fa', GREEN = '#10b981', LIME = '#a3e635', RED = '#ef4444', AMBER = '#f59e0b';

  function el(tag, css, text, kids) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== null && text !== undefined) e.textContent = text;
    (kids || []).forEach(function (k) { if (k) e.appendChild(k); });
    return e;
  }

  /* ---------- zip reading (runs entirely in the browser) ---------- */

  function fail(code) { var e = new Error(code); e.code = code; return e; }

  async function openZip(blob) {
    var size = blob.size;
    if (size < 22) throw fail('notzip');
    var tailLen = Math.min(size, 65557);
    var tail = new DataView(await blob.slice(size - tailLen, size).arrayBuffer());
    var p = -1;
    for (var i = tailLen - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
    }
    if (p < 0) throw fail('notzip');
    var count = tail.getUint16(p + 10, true);
    var cdSize = tail.getUint32(p + 12, true);
    var cdOff = tail.getUint32(p + 16, true);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      if (p < 20 || tail.getUint32(p - 20, true) !== 0x07064b50) throw fail('notzip');
      var z64 = Number(tail.getBigUint64(p - 12, true));
      var rec = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
      if (rec.getUint32(0, true) !== 0x06064b50) throw fail('notzip');
      count = Number(rec.getBigUint64(32, true));
      cdSize = Number(rec.getBigUint64(40, true));
      cdOff = Number(rec.getBigUint64(48, true));
    }
    var cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    var dec = new TextDecoder('utf-8');
    var entries = [];
    var o = 0;
    for (var n = 0; n < count && o + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(o, true) !== 0x02014b50) break;
      var flags = cd.getUint16(o + 8, true);
      var method = cd.getUint16(o + 10, true);
      var csize = cd.getUint32(o + 20, true);
      var usize = cd.getUint32(o + 24, true);
      var nl = cd.getUint16(o + 28, true);
      var xl = cd.getUint16(o + 30, true);
      var cl = cd.getUint16(o + 32, true);
      var lho = cd.getUint32(o + 42, true);
      var name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + o + 46, nl));
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
        var xo = o + 46 + nl;
        var xe = xo + xl;
        while (xo + 4 <= xe) {
          var id = cd.getUint16(xo, true);
          var sz = cd.getUint16(xo + 2, true);
          if (id === 1) {
            var q = xo + 4;
            if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (lho === 0xFFFFFFFF) { lho = Number(cd.getBigUint64(q, true)); }
          }
          xo += 4 + sz;
        }
      }
      entries.push({ name: name.replace(/\\/g, '/'), method: method, csize: csize, usize: usize, lho: lho, enc: (flags & 1) === 1 });
      o += 46 + nl + xl + cl;
    }
    if (!entries.length) throw fail('notzip');
    return entries;
  }

  async function readEntry(blob, e, limit) {
    if (e.enc) throw fail('enc');
    if (e.usize > limit) throw fail('big');
    var h = new DataView(await blob.slice(e.lho, e.lho + 30).arrayBuffer());
    if (h.getUint32(0, true) !== 0x04034b50) throw fail('bad');
    var start = e.lho + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    var data = blob.slice(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw fail('nodecomp');
      return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    }
    throw fail('method');
  }

  function parseLoose(t) {
    t = t.replace(/^﻿/, '');
    try { return JSON.parse(t); } catch (err) { /* try again without comments */ }
    var out = '', i = 0, inStr = false;
    while (i < t.length) {
      var c = t[i], d = t[i + 1];
      if (inStr) {
        out += c;
        if (c === '\\') { out += (d || ''); i += 2; continue; }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && d === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i += 2; continue; }
      out += c;
      i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  }

  /* ---------- analysis ---------- */

  var MOD_FILES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info'];
  var PLUGIN_FILES = ['plugin.yml', 'paper-plugin.yml', 'bungee.yml', 'velocity-plugin.json'];

  function depthOf(path) { return path.split('/').length - 1; }
  function dirOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i + 1); }
  function safeName(s) { return (s || 'MyPack').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'MyPack'; }

  function toVersion(v) {
    if (Array.isArray(v)) return v.map(function (x) { return Number(x) || 0; });
    if (typeof v === 'string') {
      var m = v.match(/\d+/g);
      if (m) return m.slice(0, 3).map(Number);
    }
    return null;
  }

  async function scan(blob, label, level) {
    var res = { bedrock: [], java: [], worlds: [], warnings: [], notes: [] };
    var entries = await openZip(blob);
    var files = entries.filter(function (e) {
      return !/\/$/.test(e.name) && !/^__MACOSX\//.test(e.name) && !/(^|\/)\.DS_Store$/.test(e.name);
    });
    var byName = {};
    files.forEach(function (e) { byName[e.name] = e; });
    var names = files.map(function (e) { return e.name; });
    function has(prefix) { return names.some(function (n) { return n.indexOf(prefix) === 0; }); }

    // Worlds
    names.forEach(function (n) {
      if (!/(^|\/)level\.dat$/i.test(n) || depthOf(n) > 1) return;
      var base = dirOf(n);
      if (has(base + 'db/') || byName[base + 'levelname.txt']) {
        res.worlds.push({ edition: 'bedrock', source: label });
      } else if (has(base + 'region/') || has(base + 'playerdata/') || has(base + 'DIM-1/')) {
        res.worlds.push({ edition: 'java', source: label });
      }
    });
    if (res.worlds.length) {
      res.worlds = res.worlds.slice(0, 1);
      return res;
    }

    // Java mods and plugins
    var modFile = MOD_FILES.filter(function (f) { return byName[f]; })[0];
    var plugFile = PLUGIN_FILES.filter(function (f) { return byName[f]; })[0];
    var hasClasses = names.some(function (n) { return /\.class$/.test(n); });
    if (modFile) {
      var loader = /fabric/.test(modFile) ? 'Fabric' : /quilt/.test(modFile) ? 'Quilt' : /neoforge/.test(modFile) ? 'NeoForge' : 'Forge';
      res.java.push({ kind: 'mod', label: loader + ' mod', source: label });
    } else if (plugFile) {
      res.java.push({ kind: 'plugin', label: 'Java server plugin (Spigot, Paper or similar)', source: label });
    } else if (hasClasses && byName['META-INF/MANIFEST.MF']) {
      res.java.push({ kind: 'jar', label: 'Java program, mod or plugin', source: label });
    }

    // Bedrock packs
    var manifestPaths = names.filter(function (n) { return /(^|\/)manifest\.json$/i.test(n) && depthOf(n) <= 2; });
    var seen = {};
    for (var i = 0; i < manifestPaths.length; i++) {
      var path = manifestPaths[i];
      var m;
      try {
        m = parseLoose(await (await readEntry(blob, byName[path], 2000000)).text());
      } catch (err) {
        res.warnings.push('Found ' + path + ' but could not read it (' + (err.code || 'invalid JSON') + '). If the pack still fails after uploading, the manifest may be damaged.');
        continue;
      }
      if (!m || !m.header || !m.header.uuid) continue;
      var uuid = String(m.header.uuid).toLowerCase();
      if (seen[uuid]) continue;
      seen[uuid] = true;
      var types = (m.modules || []).map(function (x) { return String(x.type || '').toLowerCase(); });
      var kind = 'unknown';
      if (types.indexOf('resources') >= 0) kind = 'resource';
      else if (types.some(function (t) { return ['data', 'script', 'client_data', 'interface'].indexOf(t) >= 0; })) kind = 'behavior';
      else if (types.indexOf('skin_pack') >= 0) kind = 'skins';
      else if (types.indexOf('world_template') >= 0) kind = 'template';
      var parts = dirOf(path).split('/').filter(Boolean);
      var folder = parts.length ? parts[parts.length - 1] : null;
      var parent = parts.length > 1 ? parts[parts.length - 2] : null;
      var name = m.header.name ? String(m.header.name) : '';
      if (!name || /^pack\.name$/i.test(name)) name = folder || label;
      var deps = (m.dependencies || []).filter(function (d) { return d && d.uuid; }).map(function (d) {
        return { uuid: String(d.uuid).toLowerCase(), version: toVersion(d.version) };
      });
      var version = toVersion(m.header.version);
      var vWarn = !version;
      res.bedrock.push({
        kind: kind, name: name, uuid: uuid, version: version || [1, 0, 0], versionMissing: vWarn,
        folder: folder, parent: parent, wrapper: folder ? null : safeName(label),
        deps: deps,
        script: types.indexOf('script') >= 0,
        source: label, nested: level > 0
      });
    }

    // Java resource / data packs (only if nothing more specific was found)
    if (!res.java.length) {
      names.forEach(function (n) {
        if (!/(^|\/)pack\.mcmeta$/i.test(n) || depthOf(n) > 1) return;
        var base = dirOf(n);
        var kind = has(base + 'assets/') ? 'resource' : has(base + 'data/') ? 'data' : 'resource';
        res.java.push({ kind: kind, label: kind === 'data' ? 'Java data pack' : 'Java resource pack', source: label });
      });
    }

    // Archives inside archives (very common on download sites)
    if (!res.bedrock.length && !res.java.length && level === 0) {
      var inner = files.filter(function (e) { return /\.(mcpack|mcaddon|mcworld|mctemplate|zip)$/i.test(e.name); }).slice(0, 8);
      for (var k = 0; k < inner.length; k++) {
        var ie = inner[k];
        try {
          var innerBlob = await readEntry(blob, ie, 400000000);
          var sub = await scan(innerBlob, ie.name.split('/').pop(), 1);
          res.bedrock = res.bedrock.concat(sub.bedrock);
          res.java = res.java.concat(sub.java);
          res.worlds = res.worlds.concat(sub.worlds);
          res.warnings = res.warnings.concat(sub.warnings);
        } catch (err2) { /* ignore archives we cannot open */ }
      }
    }
    return res;
  }

  /* ---------- UI pieces ---------- */

  var KIND = {
    behavior: { label: 'Behavior pack', dir: 'behavior_packs', file: 'world_behavior_packs.json' },
    resource: { label: 'Resource (texture) pack', dir: 'resource_packs', file: 'world_resource_packs.json' }
  };

  function tree(rows) {
    var box = el('div', 'background-color:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.1);padding:12px 15px;border-radius:8px;font-family:Consolas,Monaco,monospace;font-size:14px;line-height:1.7;margin:10px 0;max-width:100%;overflow-x:auto;color:#d4d4d4;');
    rows.forEach(function (r, i) {
      var row = el('div', 'margin-left:' + (i * 20) + 'px;white-space:nowrap;');
      row.appendChild(el('span', r.file ? 'color:' + LIME + ';' : '', (r.file ? '📄 ' : '📁 ') + r.text));
      if (r.note) row.appendChild(el('em', 'color:#888;', '  ' + r.note));
      box.appendChild(row);
    });
    return box;
  }

  function copyText(text, btn) {
    function done() { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy'; }, 1800); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacy(); });
    } else { legacy(); }
    function legacy() {
      var ta = el('textarea', 'position:fixed;opacity:0;');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { btn.textContent = 'Press Ctrl+C'; }
      document.body.removeChild(ta);
    }
  }

  function codeBox(title, text) {
    var wrap = el('div', 'background-color:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.15);border-radius:8px;margin:12px 0;overflow:hidden;');
    var head = el('div', 'background-color:rgba(16,185,129,0.1);padding:8px 15px;font-family:sans-serif;font-size:12px;color:' + GREEN + ';border-bottom:1px solid rgba(16,185,129,0.1);display:flex;justify-content:space-between;align-items:center;gap:10px;');
    head.appendChild(el('span', '', '📄 ' + title));
    var btn = el('button', 'cursor:pointer;background:rgba(16,185,129,0.15);color:' + GREEN + ';border:1px solid rgba(16,185,129,0.3);border-radius:6px;padding:3px 12px;font-size:12px;', 'Copy');
    btn.type = 'button';
    btn.onclick = function () { copyText(text, btn); };
    head.appendChild(btn);
    wrap.appendChild(head);
    wrap.appendChild(el('pre', 'margin:0;padding:15px;color:#d4d4d4;font-family:Consolas,Monaco,monospace;font-size:14px;line-height:1.6;overflow-x:auto;white-space:pre;', text));
    return wrap;
  }

  function stepTitle(n, text) {
    return el('div', 'color:' + BLUE + ';margin:18px 0 6px;font-size:1.05em;', (n === '!' ? '⚠️ ' : n + '. ') + text);
  }

  function para(text, color) { return el('p', 'margin:6px 0;line-height:1.6;font-size:15px;color:' + (color || INK) + ';', text); }

  function banner(color, icon, title, sub) {
    var rgb = color === GREEN ? '16,185,129' : color === RED ? '239,68,68' : '245,158,11';
    var b = el('div', 'background-color:rgba(' + rgb + ',0.07);border-left:4px solid ' + color + ';padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 14px;');
    b.appendChild(el('div', 'color:' + color + ';font-size:1.1em;', icon + ' ' + title));
    if (sub) b.appendChild(el('div', 'color:' + INK + ';margin-top:4px;line-height:1.6;font-size:15px;', sub));
    return b;
  }

  function jsonFor(list) {
    return '[\n' + list.map(function (p) {
      return '  {\n    "pack_id": "' + p.uuid + '",\n    "version": [ ' + p.version.join(', ') + ' ]\n  }';
    }).join(',\n') + '\n]';
  }

  function render(res, fileName) {
    var box = el('div', '');
    var packs = res.bedrock;

    if (packs.length) {
      var beh = packs.filter(function (p) { return p.kind === 'behavior'; });
      var resr = packs.filter(function (p) { return p.kind === 'resource'; });
      var other = packs.filter(function (p) { return p.kind !== 'behavior' && p.kind !== 'resource'; });
      var what = [];
      if (beh.length) what.push(beh.length + ' behavior pack' + (beh.length > 1 ? 's' : ''));
      if (resr.length) what.push(resr.length + ' resource pack' + (resr.length > 1 ? 's' : ''));
      if (beh.length || resr.length) box.appendChild(banner(GREEN, '✅', 'Bedrock Edition: this works on your server', 'Found ' + what.join(' and ') + ' in ' + fileName + '. Follow the steps below.'));
      else box.appendChild(banner(AMBER, '⚠️', 'Bedrock Edition, but not a behavior or resource pack', fileName + ' is a Bedrock file, but it is a type of pack this guide does not cover.'));

      var n = 1;
      box.appendChild(stepTitle(n++, 'Prepare the files on your computer'));
      packs.forEach(function (p) {
        var info = KIND[p.kind];
        var title = (info ? info.label : 'Pack') + ': ' + p.name;
        var line;
        if (p.nested) line = 'This is inside ' + p.source + ', which is also a zip file. Rename ' + p.source + ' to end in .zip if needed, extract it, then ';
        else if (/\.zip$/i.test(fileName)) line = 'Extract ' + fileName + ', then ';
        else line = 'Rename ' + fileName + ' so it ends in .zip, extract it, then ';
        if (p.folder && p.parent) line += 'open the folder ' + p.parent + ' and take the folder named ' + p.folder + ' (it has manifest.json directly inside).';
        else if (p.folder) line += 'take the folder named ' + p.folder + ' (it has manifest.json directly inside).';
        else line += 'put the extracted contents into a new folder called ' + p.wrapper + ' (this pack has no folder of its own, and manifest.json must sit directly inside one).';
        box.appendChild(el('div', 'margin:8px 0 2px;color:' + LIME + ';', title));
        box.appendChild(para(line));
      });

      box.appendChild(stepTitle(n++, 'Upload to the correct folder in the Files tab'));
      packs.forEach(function (p) {
        var info = KIND[p.kind];
        if (!info) {
          box.appendChild(para(p.name + ': this looks like a ' + (p.kind === 'skins' ? 'skin pack' : p.kind === 'template' ? 'world template' : 'pack we could not classify') + ', which does not follow this guide. Open a support ticket and our team will help.', AMBER));
          return;
        }
        box.appendChild(para(p.name + ' goes here:'));
        box.appendChild(tree([
          { text: info.dir },
          { text: p.folder || p.wrapper, note: '(upload this whole folder)' },
          { text: 'manifest.json', file: true }
        ]));
      });

      var tracked = packs.filter(function (p) { return KIND[p.kind]; });
      if (tracked.length) {
        box.appendChild(stepTitle(n++, 'Activate it in your world'));
        box.appendChild(para('Open the worlds folder, then your world folder (usually named Bedrock level), and edit the file shown below. If the file already contains packs, add the new entries inside the existing square brackets separated by commas instead of replacing what is there. If the file does not exist, create it with that exact name.'));
        ['behavior', 'resource'].forEach(function (k) {
          var list = tracked.filter(function (p) { return p.kind === k; });
          if (!list.length) return;
          box.appendChild(tree([
            { text: 'worlds' },
            { text: 'Bedrock level' },
            { text: KIND[k].file, file: true, note: '(edit this file)' }
          ]));
          box.appendChild(codeBox(KIND[k].file, jsonFor(list)));
        });
        box.appendChild(para('Save the file, then go back to the Console tab and click Start.'));
      }

      var notes = [];
      packs.forEach(function (p) {
        if (p.versionMissing) notes.push(p.name + ': no readable version was found in its manifest, so 1, 0, 0 was used. Open the pack\'s manifest.json and copy the version from the header section to be safe.');
        if (p.script) notes.push(p.name + ' uses scripting. If it does not load, check the pack\'s download page for required experimental features and enable them under Bedrock Settings > Experiments in your panel.');
        p.deps.forEach(function (d) {
          var found = packs.some(function (x) { return x.uuid === d.uuid; });
          if (found) notes.push(p.name + ' depends on another pack in this same file. Install both, or it will not work.');
          else notes.push(p.name + ' depends on another pack (ID ' + d.uuid + ') that is NOT in this file. Download that pack as well and install it the same way.');
        });
      });
      if (res.java.length) notes.push('This file also contains Java Edition files. Ignore those, they do nothing on a Bedrock server.');
      res.warnings.forEach(function (w) { notes.push(w); });
      if (notes.length) {
        box.appendChild(stepTitle('!', 'Things to double-check'));
        var ul = el('ul', 'margin:6px 0 0;padding-left:22px;line-height:1.6;font-size:15px;color:' + INK + ';');
        notes.forEach(function (t) { ul.appendChild(el('li', 'margin-bottom:6px;', t)); });
        box.appendChild(ul);
      }
      return box;
    }

    if (res.java.length) {
      var j = res.java[0];
      var why = {
        resource: 'It has a pack.mcmeta file, which is how Java packs are built. Bedrock servers cannot load it. Search for a Bedrock version of the same pack (usually a .mcpack file) and check that one instead.',
        data: 'Bedrock does not use data packs, it uses behavior packs and addons. Search for a Bedrock addon with the same features, or look in the Bedrock Addons tab.',
        mod: 'Mods only run on Java Edition servers. Bedrock servers use addons (behavior and resource packs) instead. Look in the Bedrock Addons tab for something similar.',
        plugin: 'Server plugins only run on Java Edition servers. Bedrock servers use addons (behavior and resource packs) instead. Look in the Bedrock Addons tab for something similar.',
        jar: 'Files like this only run on Java Edition. Bedrock servers use addons (behavior and resource packs) instead.'
      };
      box.appendChild(banner(RED, '❌', 'Java Edition: this will not work on your Bedrock server', fileName + ' is a ' + j.label + '. ' + why[j.kind]));
      box.appendChild(para('Not sure which edition your server is? Your server type is shown on your MintServers panel, and this guide is only for Minecraft Bedrock servers.', MUTE));
      return box;
    }

    if (res.worlds.length) {
      var w = res.worlds[0];
      if (w.edition === 'bedrock') {
        box.appendChild(banner(AMBER, '🗺️', 'This is a Bedrock world, not a pack', fileName + ' contains a full world (map), so it does not follow the steps in this guide. Try the Maps filter in the Bedrock Addons tab, or open a support ticket and our team will help you load it.'));
      } else {
        box.appendChild(banner(RED, '❌', 'This is a Java Edition world', fileName + ' is a Java world. Bedrock servers cannot load Java worlds directly, it has to be converted to Bedrock first. Open a support ticket if you need a hand.'));
      }
      return box;
    }

    box.appendChild(banner(AMBER, '❓', 'We could not recognize a Minecraft pack in this file', 'No Bedrock manifest.json and no Java pack.mcmeta was found. Make sure you picked the file you downloaded (.mcpack, .mcaddon or .zip) and that the download finished. If it is a pack and still is not recognized, open a support ticket and attach it.'));
    res.warnings.forEach(function (t) { box.appendChild(para(t, AMBER)); });
    return box;
  }

  /* ---------- widget shell ---------- */

  var ERR = {
    notzip: 'This does not look like a zip-based pack file. Pack files (.mcpack, .mcaddon, .zip) are zip archives. If you downloaded a .rar or .7z file, extract it on your computer first and check the file inside.',
    nodecomp: 'Your browser is too old to read compressed files. Please update Chrome, Edge, Firefox or Safari and try again.',
    enc: 'This archive is password protected, so it cannot be checked.',
    bad: 'This archive looks damaged. Try downloading it again.',
    method: 'This archive uses a compression type that cannot be checked here.',
    big: 'A file inside is too large to check.'
  };

  async function sniff(file) {
    var h = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21) return 'This is a .rar archive. Extract it on your computer first, then check the pack file or zip the folder and check that.';
    if (h[0] === 0x37 && h[1] === 0x7A && h[2] === 0xBC && h[3] === 0xAF) return 'This is a .7z archive. Extract it on your computer first, then check the pack file or zip the folder and check that.';
    return null;
  }

  var token = 0;
  var out = el('div', 'margin-top:16px;');
  out.setAttribute('aria-live', 'polite');
  var input = el('input', 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;');
  input.type = 'file';
  input.accept = '.zip,.mcpack,.mcaddon,.mcworld,.mctemplate,.jar';
  input.setAttribute('data-mpc', 'input');

  var zone = el('label', 'position:relative;display:block;cursor:pointer;text-align:center;border:2px dashed rgba(96,165,250,0.45);border-radius:10px;padding:26px 16px;background-color:rgba(96,165,250,0.05);');
  zone.appendChild(el('div', 'font-size:2em;', '📦'));
  zone.appendChild(el('div', 'color:' + BLUE + ';font-size:1.05em;margin-top:4px;', 'Drop your pack file here, or click to choose it'));
  zone.appendChild(el('div', 'color:' + MUTE + ';font-size:13px;margin-top:6px;', '.mcpack, .mcaddon, .zip'));
  zone.appendChild(input);

  async function handle(file) {
    var mine = ++token;
    out.innerHTML = '';
    out.appendChild(el('p', 'color:' + MUTE + ';', 'Checking ' + file.name + '...'));
    var view;
    try {
      var res = await scan(file, file.name.replace(/\.[^.]+$/, ''), 0);
      view = render(res, file.name);
    } catch (err) {
      var msg = ERR[err && err.code] || 'Something went wrong while reading this file.';
      if (err && err.code === 'notzip') {
        try { msg = (await sniff(file)) || msg; } catch (e2) { /* keep default message */ }
      }
      view = banner(AMBER, '⚠️', 'We could not read this file', msg);
    }
    if (mine !== token) return;
    out.innerHTML = '';
    view.setAttribute('data-mpc', 'result');
    out.appendChild(view);
  }

  input.addEventListener('change', function () {
    if (input.files && input.files[0]) handle(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.style.backgroundColor = 'rgba(96,165,250,0.14)'; });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.style.backgroundColor = 'rgba(96,165,250,0.05)'; });
  });
  zone.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handle(f);
  });

  root.innerHTML = '';
  root.appendChild(el('div', 'color:' + BLUE + ';font-size:1.15em;margin-bottom:4px;', '🔎 Pack Checker'));
  root.appendChild(el('div', 'color:' + INK + ';line-height:1.6;font-size:15px;margin-bottom:12px;', 'Choose the pack you downloaded and we will tell you if it is Bedrock or Java, which folder to upload it to, and exactly what to paste into your world file.'));
  root.appendChild(zone);
  root.appendChild(el('div', 'color:' + MUTE + ';font-size:13px;margin-top:8px;', '🔒 Your file is checked inside your browser. It is never uploaded anywhere.'));
  root.appendChild(out);
})();
