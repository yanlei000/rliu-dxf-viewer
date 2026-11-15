/* ==========================================================================
 * DXF writer.  Rewrites only the ENTITIES section of the original file so
 * HEADER / TABLES / BLOCKS / OBJECTS / CLASSES / XDATA stay byte-identical.
 * ========================================================================== */

function pairLine(code, value) {
  var v = (typeof value === 'number') ? fmtNum(value) : String(value === undefined || value === null ? '' : value);
  v = v.replace(/\r?\n/g, ' ');
  return code + '\n' + v + '\n';
}

function recordText(type, pairs) {
  var out = '0\n' + type + '\n';
  for (var i = 0; i < pairs.length; i++) out += pairLine(pairs[i][0], pairs[i][1]);
  return out;
}

/* SEQEND terminates a POLYLINE vertex list / INSERT attribute list.
 * In R2000+ it is a real entity and MUST carry an owner (330) plus the
 * AcDbEntity subclass marker; AutoCAD rejects the whole file with
 * "DXF input invalid or incomplete" when they are missing. */
function seqendText(ent) {
  var p = [];
  if (__modernDXF) {
    p.push([5, nextHandle()]);
    var owner = s(g(ent, 330, ''));
    p.push([330, owner || (__defaultOwner || '0')]);
    p.push([100, 'AcDbEntity']);
  }
  p.push([8, s(g(ent, 8, '0')) || '0']);
  return recordText('SEQEND', p);
}

function writeEntity(ent) {
  var out = recordText(ent.type, ent.pairs);
  if (ent.vertices && ent.vertices.length) {
    for (var i = 0; i < ent.vertices.length; i++) {
      out += recordText('VERTEX', ent.vertices[i].pairs);
    }
  }
  if (ent.attribs && ent.attribs.length) {
    for (var j = 0; j < ent.attribs.length; j++) {
      out += recordText('ATTRIB', ent.attribs[j].pairs);
    }
  }
  if ((ent.vertices && ent.vertices.length) || (ent.attribs && ent.attribs.length)) {
    out += seqendText(ent);
  }
  return out;
}

function writeEntities(doc) {
  var out = '';
  for (var i = 0; i < doc.entities.length; i++) out += writeEntity(doc.entities[i]);
  return out;
}

function layerRecord(L) {
  return recordText('LAYER', [
    [5, nextHandle()],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbLayerTableRecord'],
    [2, L.name],
    [70, L.flags || 0],
    [62, L.color === undefined ? 7 : L.color],
    [6, L.ltype || 'CONTINUOUS'],
    [370, L.lineweight === undefined ? -3 : L.lineweight]
  ]);
}

/* Map the original text into (code,value) pairs together with their line
 * offsets, so a section body can be spliced without re-rendering the file. */
function indexPairs(text) {
  var lines = text.split(/\r\n|\r|\n/);
  var pairs = [];
  for (var i = 0; i + 1 < lines.length; i += 2) {
    var cs = String(lines[i]).replace(/^\s+|\s+$/g, '');
    if (cs === '') continue;
    var code = parseInt(cs, 10);
    if (isNaN(code)) continue;
    pairs.push({ li: i, code: code, value: String(lines[i + 1]) });
  }
  return { lines: lines, pairs: pairs };
}

function tagName(p) {
  return p ? String(p.value).replace(/^\s+|\s+$/g, '').toUpperCase() : '';
}

function findSections(idx) {
  var P = idx.pairs, out = [], i, j;
  for (i = 0; i < P.length; i++) {
    if (P[i].code !== 0 || tagName(P[i]) !== 'SECTION') continue;
    var name = (P[i + 1] && P[i + 1].code === 2) ? tagName(P[i + 1]) : '';
    var end = -1;
    for (j = i + 1; j < P.length; j++) {
      if (P[j].code === 0 && tagName(P[j]) === 'ENDSEC') { end = j; break; }
    }
    if (end < 0) end = P.length - 1;
    out.push({ name: name, startPair: i, bodyPair: i + 2, endPair: end,
               startLine: P[i + 2] ? P[i + 2].li : idx.lines.length,
               endLine: P[end] ? P[end].li : idx.lines.length,
               sectionLine: P[i].li });
    i = end;
  }
  return out;
}

function newlineOf(text) {
  return text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
}

function splitTextLines(block) {
  var a = block.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  for (var i = 0; i < a.length; i++) a[i] = a[i].replace(/\r$/, '');
  return a;
}

/* Insert new LAYER table records into the original TABLES section. */
function layerEdits(idx, sections, doc) {
  var names = doc.__newLayers || [], edits = [], i, j;
  if (!names.length) return edits;
  var text = '';
  for (i = 0; i < names.length; i++) {
    var L = doc.tables.layer[names[i]];
    if (L) text += layerRecord(L);
  }
  if (!text) return edits;

  var tables = null;
  for (i = 0; i < sections.length; i++) if (sections[i].name === 'TABLES') tables = sections[i];
  if (tables) {
    var P = idx.pairs, tabStart = -1, tabEnd = -1;
    for (j = tables.bodyPair; j < tables.endPair; j++) {
      if (P[j].code === 0 && tagName(P[j]) === 'TABLE' && tagName(P[j + 1]) === 'LAYER') {
        tabStart = j;
        for (var k = j + 1; k < tables.endPair; k++) {
          if (P[k].code === 0 && tagName(P[k]) === 'ENDTAB') { tabEnd = k; break; }
        }
        break;
      }
    }
    if (tabStart >= 0 && tabEnd >= 0) {
      edits.push({ li: P[tabEnd].li, lines: splitTextLines(text) });
    } else {
      var full = '0\nTABLE\n2\nLAYER\n5\n2\n100\nAcDbSymbolTable\n70\n' +
                 (Object.keys(doc.tables.layer).length) + '\n' + text + '0\nENDTAB\n';
      edits.push({ li: P[tables.endPair].li, lines: splitTextLines(full) });
    }
  } else {
    var block = '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n' +
                names.length + '\n' + text + '0\nENDTAB\n0\nENDSEC\n';
    var ent = null;
    for (i = 0; i < sections.length; i++) if (sections[i].name === 'ENTITIES') ent = sections[i];
    edits.push({ li: ent ? ent.sectionLine : (idx.pairs.length ? idx.pairs[idx.pairs.length - 1].li : 0),
                 lines: splitTextLines(block) });
  }
  return edits;
}

function minimalDXF(doc) {
  /* A bare ENTITIES section is rejected by AutoCAD ("DXF input invalid or
   * incomplete"): the symbol tables, block records and root dictionary are
   * mandatory. Reuse the full template and rewrite only ENTITIES. */
  if (typeof BLANK_DXF === 'string' && BLANK_DXF) {
    return exportDXF(BLANK_DXF, doc, { version: doc.version });
  }
  var layers = '', names = Object.keys(doc.tables.layer), i;
  for (i = 0; i < names.length; i++) {
    var L = doc.tables.layer[names[i]];
    layers += recordText('LAYER', [
      [5, nextHandle()], [2, L.name], [70, L.flags || 0],
      [62, L.color === undefined ? 7 : L.color],
      [6, L.ltype || 'CONTINUOUS']
    ]);
  }
  return '0\nSECTION\n2\nHEADER\n' +
    '9\n$ACADVER\n1\n' + (doc.version || 'AC1015') + '\n' +
    '9\n$INSUNITS\n70\n' + (doc.insunits || 0) + '\n' +
    '0\nENDSEC\n' +
    '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n' + names.length + '\n' +
    layers + '0\nENDTAB\n0\nENDSEC\n' +
    '0\nSECTION\n2\nBLOCKS\n0\nENDSEC\n' +
    '0\nSECTION\n2\nENTITIES\n' + writeEntities(doc) + '0\nENDSEC\n0\nEOF\n';
}

/* Replace the value line that follows a HEADER variable name.
 * indexPairs() records the line of the group CODE, and the value sits on the
 * following line, hence the +1 offset. */
function headerValueEdits(idx, sections, name, value) {
  var edits = [], hdr = null, i;
  for (i = 0; i < sections.length; i++) if (sections[i].name === 'HEADER') hdr = sections[i];
  if (!hdr) return edits;
  var P = idx.pairs, want = name.toUpperCase();
  for (i = hdr.bodyPair; i < hdr.endPair - 1; i++) {
    if (P[i].code !== 9) continue;
    if (String(P[i].value).replace(/^\s+|\s+$/g, '').toUpperCase() !== want) continue;
    if (P[i + 1]) edits.push({ li: P[i + 1].li + 1, del: 1, lines: [String(value)] });
    break;
  }
  return edits;
}

function versionNumber(v) {
  return parseInt(String(v || '').replace(/^AC/i, ''), 10) || 0;
}

/* Objects whose internal layout changes between releases.  Relabelling a file
 * as another $ACADVER makes the reader apply that release's rules, and it
 * rejects the WHOLE drawing ("DXF input invalid or incomplete") when e.g. a
 * R2010-flavoured VISUALSTYLE appears in a file declared as R2013.  Dropping
 * them is safe: CAD rebuilds the defaults (2dWireframe, ByLayer material...). */
var VERSION_SENSITIVE = {
  VISUALSTYLE: 1, MATERIAL: 1, SCALE: 1, MODELDISPLAYSTYLE: 1
};

/* Rebuild the OBJECTS body without the version-sensitive records, and drop
 * dictionary entries / hard references that would dangle afterwards. */
function objectsForVersion(idx, sections) {
  var obj = null, i;
  for (i = 0; i < sections.length; i++) if (sections[i].name === 'OBJECTS') obj = sections[i];
  if (!obj) return [];

  var P = idx.pairs, recs = [], from = obj.bodyPair;
  for (i = obj.bodyPair; i < obj.endPair; i++) {
    if (P[i].code === 0) { if (i > from) recs.push([from, i]); from = i; }
  }
  if (from < obj.endPair) recs.push([from, obj.endPair]);

  var dropSet = {}, dropped = 0, k, r;
  for (i = 0; i < recs.length; i++) {
    r = recs[i];
    var t = String(P[r[0]].value === undefined ? '' : P[r[0]].value).replace(/^\s+|\s+$/g, '').toUpperCase();
    if (!VERSION_SENSITIVE[t]) continue;
    for (k = r[0]; k < r[1]; k++) {
      if (P[k].code === 5) { dropSet[String(P[k].value).replace(/^\s+|\s+$/g, '').toUpperCase()] = 1; break; }
    }
    dropped++;
  }
  if (!dropped) return [];

  var out = [];
  for (i = 0; i < recs.length; i++) {
    r = recs[i];
    var type = String(P[r[0]].value === undefined ? '' : P[r[0]].value).replace(/^\s+|\s+$/g, '').toUpperCase();
    if (VERSION_SENSITIVE[type]) continue;
    k = r[0];
    while (k < r[1]) {
      var c = P[k].code;
      var v = String(P[k].value === undefined ? '' : P[k].value);
      /* dictionary entry "3 <name>" followed by "350 <handle>" */
      if (c === 3 && k + 1 < r[1] && P[k + 1].code === 350 &&
          dropSet[String(P[k + 1].value).replace(/^\s+|\s+$/g, '').toUpperCase()]) {
        k += 2; continue;
      }
      if ((c === 350 || c === 340 || c === 347) &&
          dropSet[v.replace(/^\s+|\s+$/g, '').toUpperCase()]) { k++; continue; }
      out.push(idx.lines[P[k].li], idx.lines[P[k].li + 1]);
      k++;
    }
  }
  return [{ li: obj.startLine, del: obj.endLine - obj.startLine, lines: out }];
}

/* Target formats offered by the UI. Values are $ACADVER codes. */
var DXF_VERSIONS = [
  { code: 'AC1032', label: 'AutoCAD 2018 (R2018)' },
  { code: 'AC1027', label: 'AutoCAD 2013 (R2013)' },
  { code: 'AC1024', label: 'AutoCAD 2010 (R2010)' },
  { code: 'AC1021', label: 'AutoCAD 2007 (R2007)' },
  { code: 'AC1015', label: 'AutoCAD 2000 (R2000)' }
];

/* Public: return the edited DXF as text. originalText may be empty when the
 * user started drawing on a blank canvas.
 * opts.version  target $ACADVER (e.g. 'AC1027'); omit to keep the source one.
 * opts.strict   throw instead of silently keeping an incompatible version. */
function exportDXF(originalText, doc, opts) {
  opts = opts || {};
  var target = String(opts.version || '').toUpperCase();
  if (target && !/^AC10\d\d$/.test(target)) target = '';

  if (!originalText || !originalText.trim()) {
    if (target) doc.version = target;
    return minimalDXF(doc);
  }
  var idx = indexPairs(originalText);
  var sections = findSections(idx);
  var edits = [], i;

  /* ENTITIES body replacement */
  var ent = null;
  for (i = 0; i < sections.length; i++) if (sections[i].name === 'ENTITIES') ent = sections[i];
  var body = writeEntities(doc);
  if (ent) {
    edits.push({ li: ent.startLine, del: ent.endLine - ent.startLine,
                 lines: splitTextLines(body) });
  } else {
    var eofLine = idx.lines.length;
    for (i = 0; i < idx.pairs.length; i++) {
      if (idx.pairs[i].code === 0 && tagName(idx.pairs[i]) === 'EOF') { eofLine = idx.pairs[i].li; break; }
    }
    edits.push({ li: eofLine, del: 0, lines: splitTextLines(
      '0\nSECTION\n2\nENTITIES\n' + body + '0\nENDSEC\n') });
  }

  /* Version conversion. Only the $ACADVER declaration changes: R2000..R2018
   * share the same section layout, so a R2010 file relabelled as R2013 opens
   * natively in AutoCAD 2013+. R12/R13/R14 have no handles or subclass
   * markers at all, so they cannot be promoted without a full rewrite. */
  var srcVer = String(doc.version || '').toUpperCase();
  if (target && target !== srcVer) {
    var srcNum = versionNumber(srcVer), tgtNum = versionNumber(target);
    if (srcNum && srcNum < 1015 && tgtNum >= 1015) {
      if (opts.strict) throw new Error('源图纸是 R12/R14 格式（' + srcVer +
        '），缺少句柄与子类标记，无法直接升级为 ' + target + '。请先用 CAD 另存为 2000 及以上版本。');
      target = '';
    } else {
      edits = edits.concat(headerValueEdits(idx, sections, '$ACADVER', target));
      edits = edits.concat(headerValueEdits(idx, sections, '$ACADMAINTVER', 0));
      /* Newer versions record the required object version here; 0 means "none". */
      edits = edits.concat(headerValueEdits(idx, sections, '$REQUIREDVERSIONS', 0));
      /* Strip objects whose layout differs between releases so the target
       * reader does not reject the file outright. */
      edits = edits.concat(objectsForVersion(idx, sections));
    }
  }

  /* $HANDSEED must exceed every handle in the file, otherwise AutoCAD
   * reuses handles and reports conflicts on the next save. */
  var seed = (typeof __handleSeed === 'number' ? __handleSeed : 0);
  if (seed > 0) {
    edits = edits.concat(headerValueEdits(idx, sections, '$HANDSEED', seed.toString(16).toUpperCase()));
  }

  edits = edits.concat(layerEdits(idx, sections, doc));
  edits.sort(function (a, b) { return b.li - a.li; });

  /* Splice from the bottom up, but never through Function.apply: a large
   * ENTITIES body is hundreds of thousands of lines and spreading it as
   * arguments overflows the call stack (RangeError: Maximum call stack size
   * exceeded), which silently killed "save DXF" on real-world drawings. */
  var src = idx.lines, cur;
  for (i = 0; i < edits.length; i++) {
    var e = edits[i];
    var at = e.li, del = e.del || 0, add = e.lines;
    cur = [];
    var k;
    for (k = 0; k < at; k++) cur.push(src[k]);
    for (k = 0; k < add.length; k++) cur.push(add[k]);
    for (k = at + del; k < src.length; k++) cur.push(src[k]);
    src = cur;
  }
  var nl = newlineOf(originalText);
  return src.join(nl).replace(/\s*$/, '') + nl;
}

API.writeEntity = writeEntity;
API.exportDXF = exportDXF;
API.DXF_VERSIONS = DXF_VERSIONS;
API.BLANK_DXF = BLANK_DXF;
