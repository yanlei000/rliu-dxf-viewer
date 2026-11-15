/* ==========================================================================
 * DXF ASCII parser: group-code stream -> sections, tables, blocks, entities.
 * No DOM dependency; safe to run in Node for tests.
 * ========================================================================== */

function isNumericCode(c) {
  if (c >= 10 && c <= 59) return true;    // doubles / points
  if (c >= 60 && c <= 79) return true;    // int16
  if (c >= 90 && c <= 99) return true;    // int32
  if (c >= 110 && c <= 149) return true;  // UCS / doubles
  if (c >= 160 && c <= 179) return true;  // int64 / int16
  if (c >= 210 && c <= 239) return true;  // extrusion / doubles
  if (c >= 270 && c <= 289) return true;  // int16
  if (c >= 290 && c <= 299) return true;  // boolean
  if (c >= 370 && c <= 389) return true;  // int16
  if (c >= 400 && c <= 409) return true;  // int16
  if (c >= 420 && c <= 429) return true;  // int32 (true color)
  if (c >= 440 && c <= 469) return true;  // int32 / double
  if (c === 999) return false;            // comment
  if (c >= 1000 && c <= 1009) return false; // xdata string
  if (c >= 1010) return true;             // xdata numbers
  return false;                           // 0..9, 100..109, 300..369, 410..419...
}

function convertValue(code, value) {
  var s = String(value);
  if (!isNumericCode(code)) return s;
  if (code >= 290 && code <= 299) return parseInt(s, 10) ? 1 : 0;
  var n = parseFloat(s);
  return isNaN(n) ? s : n;
}

function tokenize(text) {
  var lines = text.split(/\r\n|\r|\n/);
  var pairs = [];
  for (var i = 0; i + 1 < lines.length; i += 2) {
    var cs = lines[i].replace(/^\s+|\s+$/g, '');
    if (cs === '') continue;
    var code = parseInt(cs, 10);
    if (isNaN(code)) continue;
    pairs.push([code, convertValue(code, lines[i + 1])]);
  }
  return pairs;
}

function splitSections(pairs) {
  var sections = [], i = 0;
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && String(pairs[i][1]).replace(/^\s+|\s+$/g, '').toUpperCase() === 'SECTION') {
      var name = '';
      var j = i + 1;
      if (j < pairs.length && pairs[j][0] === 2) {
        name = String(pairs[j][1]).replace(/^\s+|\s+$/g, '').toUpperCase();
        j++;
      }
      var body = [];
      while (j < pairs.length &&
             !(pairs[j][0] === 0 && String(pairs[j][1]).replace(/^\s+|\s+$/g, '').toUpperCase() === 'ENDSEC')) {
        body.push(pairs[j]);
        j++;
      }
      sections.push({ name: name, pairs: body });
      i = j + 1;
    } else {
      i++;
    }
  }
  return sections;
}

/* Every code-0 tag starts a new record; all following tags belong to it. */
function splitRecords(pairs) {
  var recs = [], cur = null;
  for (var i = 0; i < pairs.length; i++) {
    var c = pairs[i][0], v = pairs[i][1];
    if (c === 0) {
      cur = {
        type: String(v).replace(/^\s+|\s+$/g, '').toUpperCase(),
        typeRaw: String(v),
        pairs: []
      };
      recs.push(cur);
    } else if (cur) {
      cur.pairs.push([c, v]);
    }
  }
  return recs;
}

/* ---------- record access helpers (shared with geom.js) ---------- */
function g(rec, code, dflt) {
  if (!rec || !rec.pairs) return dflt;
  for (var i = 0; i < rec.pairs.length; i++) {
    if (rec.pairs[i][0] === code) return rec.pairs[i][1];
  }
  return dflt;
}
function ga(rec, code) {
  var out = [];
  if (!rec || !rec.pairs) return out;
  for (var i = 0; i < rec.pairs.length; i++) {
    if (rec.pairs[i][0] === code) out.push(rec.pairs[i][1]);
  }
  return out;
}
function n(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt === undefined ? 0 : dflt;
  var x = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(x) ? (dflt === undefined ? 0 : dflt) : x;
}
function s(v, dflt) {
  if (v === undefined || v === null) return dflt === undefined ? '' : dflt;
  return String(v).replace(/^\s+|\s+$/g, '');
}

/* Ordered coordinate collector: repeated 10/20/30 tags form points,
 * optional 42 (bulge) or 41 (weight) attaches to the current point. */
function collectPoints(rec, xc, yc, zc, extraCodes) {
  var pts = [], cur = null;
  xc = xc || 10; yc = yc || 20; zc = zc || 30;
  for (var i = 0; i < rec.pairs.length; i++) {
    var c = rec.pairs[i][0], v = rec.pairs[i][1];
    if (c === xc) {
      cur = { x: n(v), y: 0, z: 0 };
      pts.push(cur);
    } else if (cur && c === yc) cur.y = n(v);
    else if (cur && c === zc) cur.z = n(v);
    else if (cur && extraCodes) {
      for (var k = 0; k < extraCodes.length; k++) {
        if (c === extraCodes[k]) cur['e' + c] = n(v);
      }
    }
  }
  return pts;
}

/* ---------- section parsers ---------- */
function parseHeader(pairs) {
  var h = {}, name = null;
  for (var i = 0; i < pairs.length; i++) {
    var c = pairs[i][0], v = pairs[i][1];
    if (c === 9) { name = s(v).toUpperCase(); continue; }
    if (!name) continue;
    if (c >= 10 && c <= 39) {
      if (!h[name] || typeof h[name] !== 'object') h[name] = {};
      h[name][c] = n(v);
    } else if (!(name in h)) {
      h[name] = v;
    }
  }
  return h;
}

var BUILTIN_LTYPES = {
  'CONTINUOUS': [],
  'DASHED': [0.5, -0.25],
  'HIDDEN': [0.25, -0.125],
  'CENTER': [1.25, -0.25, 0.25, -0.25],
  'CENTER2': [0.75, -0.125, 0.125, -0.125],
  'CENTERX2': [2.5, -0.5, 0.5, -0.5],
  'PHANTOM': [1.25, -0.25, 0.25, -0.25, 0.25, -0.25],
  'PHANTOM2': [0.625, -0.125, 0.125, -0.125, 0.125, -0.125],
  'PHANTOMX2': [2.5, -0.5, 0.5, -0.5, 0.5, -0.5],
  'DASHDOT': [0.5, -0.25, 0.0, -0.25],
  'DASHDOT2': [0.25, -0.125, 0.0, -0.125],
  'DIVIDE': [0.5, -0.25, 0.0, -0.25, 0.0, -0.25],
  'DIVIDE2': [0.25, -0.125, 0.0, -0.125, 0.0, -0.125],
  'DOT': [0.0, -0.25],
  'DOT2': [0.0, -0.125],
  'BORDER': [0.5, -0.25, 0.5, -0.25, 0.0, -0.25],
  'BORDER2': [0.25, -0.125, 0.25, -0.125, 0.0, -0.125],
  'BORDERX2': [1.0, -0.5, 1.0, -0.5, 0.0, -0.5]
};

function parseTables(recs) {
  var tables = { layer: {}, ltype: {}, style: {}, dimstyle: {}, appid: {}, vport: {}, ucs: {}, view: {}, block_record: {} };
  var cur = null;
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (r.type === 'TABLE') { cur = s(g(r, 2)).toUpperCase(); continue; }
    if (r.type === 'ENDTAB') { cur = null; continue; }
    if (!cur) continue;
    var name = s(g(r, 2));
    if (cur === 'LAYER') {
      if (!name) continue;
      var color = n(g(r, 62, 7), 7);
      tables.layer[name] = {
        name: name,
        flags: n(g(r, 70, 0), 0),
        color: color,
        trueColor: g(r, 420) === undefined ? null : (n(g(r, 420)) >>> 0) & 0xFFFFFF,
        ltype: s(g(r, 6, 'CONTINUOUS'), 'CONTINUOUS') || 'CONTINUOUS',
        lineweight: n(g(r, 370, -3), -3),
        frozen: !!(n(g(r, 70, 0), 0) & 1),
        off: color < 0,
        plot: n(g(r, 290, 1), 1)
      };
    } else if (cur === 'LTYPE') {
      if (!name) continue;
      var pattern = ga(r, 49).map(function (v) { return n(v); });
      var length = n(g(r, 40, 0), 0);
      if (!pattern.length) pattern = (BUILTIN_LTYPES[name.toUpperCase()] || []).slice();
      if (!length && pattern.length) {
        length = pattern.reduce(function (a, b) { return a + Math.abs(b); }, 0);
      }
      tables.ltype[name] = {
        name: name,
        desc: s(g(r, 3)),
        length: length,
        count: n(g(r, 73, 0), 0),
        align: n(g(r, 72, 65), 65),
        pattern: pattern
      };
    } else if (cur === 'STYLE') {
      if (!name) continue;
      tables.style[name] = {
        name: name,
        font: s(g(r, 3, 'txt')),
        bigFont: s(g(r, 4)),
        height: n(g(r, 40, 0), 0),
        width: n(g(r, 41, 1), 1) || 1,
        oblique: n(g(r, 50, 0), 0),
        flags: n(g(r, 71, 0), 0)
      };
    } else if (cur === 'DIMSTYLE') {
      tables.dimstyle[name] = { name: name, dimtxt: n(g(r, 140, 2.5), 2.5) };
    } else if (cur === 'BLOCK_RECORD') {
      if (!name) continue;
      /* Handles are needed as owner (330) targets for entities we create. */
      tables.block_record[name] = { name: name, handle: s(g(r, 5, '')) };
    }
  }
  return tables;
}

function parseBlocks(recs) {
  var blocks = {}, cur = null;
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (r.type === 'BLOCK') {
      cur = {
        name: s(g(r, 2)),
        xref: s(g(r, 1)),
        flags: n(g(r, 70, 0), 0),
        base: [n(g(r, 10, 0), 0), n(g(r, 20, 0), 0), n(g(r, 30, 0), 0)],
        raw: []
      };
    } else if (r.type === 'ENDBLK') {
      if (cur) {
        cur.entities = normalizeEntities(cur.raw);
        delete cur.raw;
        blocks[cur.name.toUpperCase()] = cur;
        cur = null;
      }
    } else if (cur) {
      cur.raw.push(r);
    }
  }
  return blocks;
}

/* Merge POLYLINE + VERTEX + SEQEND and INSERT + ATTRIB + SEQEND. */
function normalizeEntities(recs) {
  var out = [], poly = null, ins = null;
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (r.type === 'POLYLINE') {
      poly = { type: 'POLYLINE', pairs: r.pairs.slice(), vertices: [] };
      out.push(poly);
      ins = null;
    } else if (r.type === 'VERTEX' && poly) {
      poly.vertices.push(r);
    } else if (r.type === 'ATTRIB' && ins) {
      ins.attribs.push(r);
    } else if (r.type === 'SEQEND') {
      poly = null; ins = null;
    } else if (r.type === 'INSERT') {
      ins = { type: 'INSERT', pairs: r.pairs.slice(), attribs: [] };
      out.push(ins);
      poly = null;
    } else {
      out.push(r);
      poly = null; ins = null;
    }
  }
  return out;
}

/* Public entry point. */
function parse(text) {
  if (typeof text !== 'string') throw new Error('DXF 内容必须是文本');
  var pairs = tokenize(text);
  var sections = splitSections(pairs);
  var doc = {
    header: {},
    tables: { layer: {}, ltype: {}, style: {}, dimstyle: {} },
    blocks: {},
    entities: [],
    sectionNames: [],
    warnings: [],
    pairCount: pairs.length,
    version: '',
    insunits: 0,
    ltscale: 1
  };
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    doc.sectionNames.push(sec.name);
    if (sec.name === 'HEADER') {
      doc.header = parseHeader(sec.pairs);
    } else if (sec.name === 'TABLES') {
      doc.tables = parseTables(splitRecords(sec.pairs));
    } else if (sec.name === 'BLOCKS') {
      doc.blocks = parseBlocks(splitRecords(sec.pairs));
    } else if (sec.name === 'ENTITIES') {
      doc.entities = normalizeEntities(splitRecords(sec.pairs));
    } else if (sec.name === 'CLASSES' || sec.name === 'OBJECTS') {
      /* kept out of the drawing, but noted as present */
    }
  }
  doc.version = s(doc.header.$ACADVER, '');
  doc.insunits = n(doc.header.$INSUNITS, 0);
  doc.ltscale = n(doc.header.$LTSCALE, 1) || 1;
  doc.extmin = doc.header.$EXTMIN || null;
  doc.extmax = doc.header.$EXTMAX || null;
  if (!doc.entities.length && !doc.sectionNames.length) {
    doc.warnings.push('未找到任何 SECTION 段，文件可能不是 ASCII DXF。');
  }
  if (!doc.tables.layer['0']) {
    doc.tables.layer['0'] = {
      name: '0', flags: 0, color: 7, trueColor: null,
      ltype: 'CONTINUOUS', lineweight: -3, frozen: false, off: false, plot: 1
    };
  }
  for (var key in BUILTIN_LTYPES) {
    if (!doc.tables.ltype[key]) {
      var p = BUILTIN_LTYPES[key];
      doc.tables.ltype[key] = { name: key, desc: key, length: p.reduce(function (a, b) { return a + Math.abs(b); }, 0), count: p.length, align: 65, pattern: p };
    }
  }

  /* ---- handle bookkeeping -------------------------------------------------
   * Handles must be unique across the WHOLE file, not just ENTITIES: OBJECTS
   * (dictionaries, SORTENTSTABLE, ...) and BLOCKS carry their own.  Seeding
   * the counter from ENTITIES alone made freshly created SEQEND/entity
   * handles collide, and AutoCAD rejects a DXF with duplicate handles. */
  if (typeof noteHandle === 'function') {
    for (var q = 0; q < pairs.length; q++) {
      var hc = pairs[q][0];
      if (hc === 5 || hc === 105) noteHandle(pairs[q][1]);
    }
  }
  /* Entities we create need an owner pointing at the model-space block record. */
  if (typeof setDefaultOwner === 'function') {
    var recs = doc.tables.block_record || {}, ms = recs['*Model_Space'] || recs['*model_space'] || null;
    setDefaultOwner(ms && ms.handle ? ms.handle : '');
  }
  if (typeof setDXFModern === 'function') {
    var v = parseInt(String(doc.version || '').replace(/^AC/i, ''), 10);
    setDXFModern(!v || v >= 1015);
  }
  return doc;
}

API.parse = parse;
API.tokenize = tokenize;
API.splitRecords = splitRecords;
API.g = g;
API.ga = ga;
API.n = n;
API.s = s;
API.BUILTIN_LTYPES = BUILTIN_LTYPES;
