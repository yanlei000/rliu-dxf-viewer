/* ==========================================================================
 * Editing kernel — pure data, no DOM.
 *
 * Everything is expressed as ASCII DXF entity records so that edits can be
 * written straight back into the original file's ENTITIES section.  The
 * renderer keeps working on the same records, so colours, layers, blocks,
 * linetypes and statistics stay authoritative.
 * ========================================================================== */

var __entityId = 1;
var __handleSeed = 0x100;
/* Handle of the *Model_Space BLOCK_RECORD, used as owner (330) for new
 * entities. Empty for R12 sources, where ownership is not part of the format. */
var __defaultOwner = '';
/* R2000 (AC1015) and later require handles, owners and subclass markers.
 * R12 sources must keep the legacy layout. */
var __modernDXF = true;

function setDXFModern(v) { __modernDXF = !!v; }

function noteHandle(h) {
  var v = parseInt(String(h === undefined || h === null ? '' : h).trim(), 16);
  if (isFinite(v) && v + 1 > __handleSeed) __handleSeed = v + 1;
}

function setDefaultOwner(h) {
  __defaultOwner = String(h || '');
}

function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (!isFinite(v)) return '0.0';
  if (v === 0) return '0.0';
  var s = v.toFixed(10);
  s = s.replace(/\.?0+$/, '');
  if (s === '' || s === '-') s = '0';
  return s;
}

function cloneRecord(r) {
  if (!r) return r;
  var o = { type: r.type, pairs: [] };
  for (var i = 0; i < r.pairs.length; i++) o.pairs.push(r.pairs[i].slice());
  if (r.typeRaw !== undefined) o.typeRaw = r.typeRaw;
  return o;
}

function cloneEntity(e) {
  var o = cloneRecord(e);
  o.__id = e.__id;
  if (e.vertices) o.vertices = e.vertices.map(cloneRecord);
  if (e.attribs) o.attribs = e.attribs.map(cloneRecord);
  return o;
}

function cloneEntities(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(cloneEntity(list[i]));
  return out;
}

function cloneBlocks(blocks) {
  var out = {}, k;
  for (k in blocks) {
    if (!Object.prototype.hasOwnProperty.call(blocks, k)) continue;
    var b = blocks[k];
    out[k] = {
      name: b.name, xref: b.xref, flags: b.flags,
      base: (b.base || [0, 0, 0]).slice(), entities: cloneEntities(b.entities || [])
    };
  }
  return out;
}

function assignEntityIds(doc) {
  var max = 0;
  for (var i = 0; i < doc.entities.length; i++) {
    var e = doc.entities[i];
    e.__id = ++__entityId;
    var h = s(g(e, 5, ''));
    if (/^[0-9a-f]+$/i.test(h)) max = Math.max(max, parseInt(h, 16));
  }
  __handleSeed = Math.max(__handleSeed, max + 1);
}

function nextHandle() {
  var h = __handleSeed++;
  return h.toString(16).toUpperCase();
}

/* ---------- entity construction ---------- */
/* Subclass markers emitted right after the layer. ARC derives from CIRCLE, so
 * the circle marker comes here and AcDbArc is appended after the radius —
 * geometry group codes must sit inside the AcDbCircle subclass. */
var SUBCLASS = {
  LINE: ['AcDbLine'], LWPOLYLINE: ['AcDbPolyline'], CIRCLE: ['AcDbCircle'],
  ARC: ['AcDbCircle'], POINT: ['AcDbPoint'], TEXT: ['AcDbText'],
  POLYLINE: ['AcDb2dPolyline']
};

function commonPairs(style, type) {
  style = style || {};
  var p = [];
  /* R12 (AC1009) predates handles, owners and subclass markers: writing them
   * would make the file unreadable for R12 consumers. */
  if (__modernDXF) {
    p.push([5, nextHandle()]);
    if (__defaultOwner) p.push([330, __defaultOwner]);
    p.push([100, 'AcDbEntity']);
  }
  p.push([8, style.layer || '0']);
  if (style.linetype && style.linetype.toUpperCase() !== 'CONTINUOUS') p.push([6, style.linetype]);
  if (style.trueColor !== undefined && style.trueColor !== null) {
    p.push([420, style.trueColor >>> 0]);
  } else if (style.aci !== undefined && style.aci !== null && style.aci !== 256) {
    p.push([62, style.aci]);
  }
  if (style.lw !== undefined && style.lw !== null) p.push([370, style.lw]);
  var sc = SUBCLASS[type];
  if (sc && __modernDXF) {
    for (var q = 0; q < sc.length; q++) p.push([100, sc[q]]);
  }
  return p;
}

function makeEntity(type, pairs) {
  return { type: type, pairs: pairs, __id: ++__entityId };
}

/* Build a brand-new DXF entity from a tool gesture.
 * geom shapes: {pts:[[x,y]...], closed, center, radius, a0, a1, text, height, rot} */
function newShape(kind, geom, style) {
  var p = commonPairs(style, kind), i, q;
  switch (kind) {
    case 'LINE':
      q = geom.pts;
      p.push([10, q[0][0]], [20, q[0][1]], [30, 0]);
      p.push([11, q[1][0]], [21, q[1][1]], [31, 0]);
      break;
    case 'LWPOLYLINE':
      p.push([90, geom.pts.length], [70, geom.closed ? 1 : 0]);
      for (i = 0; i < geom.pts.length; i++) {
        p.push([10, geom.pts[i][0]], [20, geom.pts[i][1]]);
      }
      break;
    case 'CIRCLE':
      p.push([10, geom.center[0]], [20, geom.center[1]], [30, 0]);
      p.push([40, geom.radius]);
      break;
    case 'ARC':
      p.push([10, geom.center[0]], [20, geom.center[1]], [30, 0]);
      p.push([40, geom.radius]);
      if (__modernDXF) p.push([100, 'AcDbArc']);
      p.push([50, geom.a0], [51, geom.a1]);
      break;
    case 'POINT':
      p.push([10, geom.pts[0][0]], [20, geom.pts[0][1]], [30, 0]);
      break;
    case 'TEXT':
      p.push([10, geom.pts[0][0]], [20, geom.pts[0][1]], [30, 0]);
      p.push([40, geom.height || 2.5]);
      p.push([1, geom.text || '']);
      p.push([50, geom.rot || 0]);
      p.push([41, 1.0]);
      p.push([51, 0.0]);
      p.push([7, 'Standard']);
      p.push([71, 0]);
      p.push([72, 0]);
      p.push([11, geom.pts[0][0]], [21, geom.pts[0][1]], [31, 0]);
      /* AutoCAD 2013+ writes the AcDbText marker a second time at the end of
       * the record; without it the reader rejects the whole file. */
      if (__modernDXF) p.push([100, 'AcDbText']);
      break;
    default:
      return null;
  }
  return makeEntity(kind, p);
}

/* ---------- property editing ---------- */
var COMMON_CODES = { 5: 1, 8: 1, 6: 1, 62: 1, 370: 1, 420: 1, 100: 1 };

function replaceCode(rec, code, value) {
  var drop = (value === null || value === undefined);
  var out = [], inserted = false, i;
  for (i = 0; i < rec.pairs.length; i++) {
    if (rec.pairs[i][0] !== code) { out.push(rec.pairs[i]); continue; }
    if (drop || inserted) continue;
    out.push([code, value]);
    inserted = true;
  }
  if (!drop && !inserted) {
    var at = 0;
    while (at < out.length && COMMON_CODES[out[at][0]]) at++;
    out.splice(at, 0, [code, value]);
  }
  rec.pairs = out;
}

function setEntityProps(rec, props) {
  var o = cloneEntity(rec);
  if (props.layer !== undefined) replaceCode(o, 8, props.layer);
  if (props.linetype !== undefined) replaceCode(o, 6, props.linetype);
  if (props.lw !== undefined) replaceCode(o, 370, props.lw);
  if (props.color !== undefined) {
    if (props.color === null || props.color === 'BYLAYER') {
      replaceCode(o, 62, null); replaceCode(o, 420, null);
    } else if (typeof props.color === 'number') {
      replaceCode(o, 420, null); replaceCode(o, 62, props.color);
    } else if (props.color && typeof props.color.rgb === 'number') {
      replaceCode(o, 62, null); replaceCode(o, 420, props.color.rgb >>> 0);
    }
  }
  if (o.attribs) {
    for (var i = 0; i < o.attribs.length; i++) {
      replaceCode(o.attribs[i], 8, s(g(o, 8, '0')));
    }
  }
  return o;
}

/* ---------- affine transformation of raw entity records ---------- */
/* M: { a,b,c,d, tx,ty, scale, angleDelta, reflect, axisAngle } */
function XFmove(dx, dy) {
  return { a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy, scale: 1, angleDelta: 0, reflect: false };
}
function XFrotate(o, deg) {
  var t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
  return { a: cs, b: -sn, c: sn, d: cs,
           tx: o[0] - (cs * o[0] - sn * o[1]), ty: o[1] - (sn * o[0] + cs * o[1]),
           scale: 1, angleDelta: deg, reflect: false };
}
function XFscale(o, k) {
  if (!isFinite(k) || Math.abs(k) < 1e-12) k = 1;
  k = Math.abs(k);
  return { a: k, b: 0, c: 0, d: k, tx: o[0] * (1 - k), ty: o[1] * (1 - k),
           scale: k, angleDelta: 0, reflect: false };
}
function XFmirror(a, b) {
  var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.sqrt(dx * dx + dy * dy);
  if (L < 1e-12) return XFmove(0, 0);
  var ux = dx / L, uy = dy / L;
  var m = { a: 2 * ux * ux - 1, b: 2 * ux * uy, c: 2 * ux * uy, d: 2 * uy * uy - 1 };
  m.tx = a[0] - (m.a * a[0] + m.b * a[1]);
  m.ty = a[1] - (m.c * a[0] + m.d * a[1]);
  m.scale = 1; m.angleDelta = 0;
  m.reflect = true;
  m.axisAngle = Math.atan2(dy, dx) * 180 / Math.PI;
  return m;
}

/* Point X codes per entity type; Y = X+10, Z = X+20.
 * vec = relative vectors (no translation), len = lengths to scale,
 * ang = angle group codes, mul = dimensionless scale factors to scale. */
var XF_RULES = {
  POINT:       { pts: [10], len: [], ang: [] },
  LINE:        { pts: [10, 11] },
  LWPOLYLINE:  { pts: [10], len: [40, 41, 43] },
  POLYLINE:    { pts: [10], len: [40, 41] },
  CIRCLE:      { pts: [10], len: [40] },
  ARC:         { pts: [10], len: [40], ang: [50, 51] },
  ELLIPSE:     { pts: [10], vec: [11] },
  SPLINE:      { pts: [10, 11], vec: [12, 13] },
  TEXT:        { pts: [10, 11], len: [40], ang: [50] },
  ATTRIB:      { pts: [10, 11], len: [40], ang: [50] },
  ATTDEF:      { pts: [10, 11], len: [40], ang: [50] },
  MTEXT:       { pts: [10, 11], len: [40, 41], ang: [50] },
  INSERT:      { pts: [10], len: [44, 45], ang: [50], mul: [41, 42, 43] },
  DIMENSION:   { pts: [10, 11, 12, 13, 14, 15, 16], ang: [50] },
  ARC_DIMENSION: { pts: [10, 11, 12, 13, 14, 15, 16], ang: [50] },
  HATCH:       { pts: [10, 11], len: [41], ang: [52] },
  SOLID:       { pts: [10, 11, 12, 13] },
  TRACE:       { pts: [10, 11, 12, 13] },
  '3DFACE':    { pts: [10, 11, 12, 13] },
  LEADER:      { pts: [10], len: [40, 41] },
  MLEADER:     { pts: [10], len: [40, 41] },
  MLINE:       { pts: [10], vec: [11], len: [49] },
  XLINE:       { pts: [10], vec: [11] },
  RAY:         { pts: [10], vec: [11] },
  VIEWPORT:    { pts: [10], len: [40, 41] },
  WIPEOUT:     { pts: [10] },
  IMAGE:       { pts: [10], vec: [11, 12] }
};
var XF_DEFAULT = { pts: [10, 11, 12, 13, 14, 15, 16, 17, 18], len: [], ang: [] };

function inList(list, code) {
  return !!list && list.indexOf(code) >= 0;
}

function xformPairs(pairs, rule, M) {
  var i, c, j, x, y, nx, ny;
  /* point / vector pairs: X code followed by its Y code */
  for (i = 0; i < pairs.length; i++) {
    c = pairs[i][0];
    if (!((c >= 10 && c <= 18) || (c >= 110 && c <= 118))) continue;
    var xc = c, yc = c + 10;
    var yIndex = -1;
    for (j = i + 1; j < Math.min(i + 4, pairs.length); j++) {
      if (pairs[j][0] === yc) { yIndex = j; break; }
      if (pairs[j][0] >= 10 && pairs[j][0] <= 18) break;
    }
    var isPt = inList(rule.pts, xc), isVec = inList(rule.vec, xc);
    if (!isPt && !isVec) continue;
    x = n(pairs[i][1], 0);
    y = yIndex >= 0 ? n(pairs[yIndex][1], 0) : 0;
    if (isVec) {
      nx = M.a * x + M.b * y;
      ny = M.c * x + M.d * y;
    } else {
      nx = M.a * x + M.b * y + M.tx;
      ny = M.c * x + M.d * y + M.ty;
    }
    pairs[i][1] = nx;
    if (yIndex >= 0) pairs[yIndex][1] = ny;
  }
  /* scalar lengths / heights / widths (only codes explicitly allowed) */
  var lens = rule.len || [];
  for (i = 0; i < pairs.length; i++) {
    c = pairs[i][0];
    if (!inList(lens, c) || typeof pairs[i][1] !== 'number') continue;
    pairs[i][1] = pairs[i][1] * M.scale;
  }
  /* dimensionless scale factors on INSERT */
  for (i = 0; i < pairs.length; i++) {
    if (inList(rule.mul, pairs[i][0]) && typeof pairs[i][1] === 'number') {
      pairs[i][1] = (pairs[i][1] || 1) * M.scale;
    }
  }
  /* angles */
  for (i = 0; i < pairs.length; i++) {
    if (!inList(rule.ang, pairs[i][0])) continue;
    var a = n(pairs[i][1], 0);
    pairs[i][1] = M.reflect ? (2 * M.axisAngle - a) : (a + M.angleDelta);
  }
}

/* After xformPairs() has reflected both angles, a mirrored arc runs the
 * other way round: swap start/end so the sweep stays counter-clockwise.
 * (Do NOT reflect again here — that would undo the mirror.) */
function fixArcReflection(pairs, M) {
  if (!M.reflect) return;
  var i0 = -1, i1 = -1, i;
  for (i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 50) i0 = i;
    else if (pairs[i][0] === 51) i1 = i;
  }
  if (i0 < 0 || i1 < 0) return;
  var a0 = n(pairs[i1][1], 0), a1 = n(pairs[i0][1], 0);
  while (a0 < 0) { a0 += 360; a1 += 360; }
  while (a1 <= a0) a1 += 360;
  while (a1 - a0 > 360) a1 -= 360;
  pairs[i0][1] = a0;
  pairs[i1][1] = a1;
}

function transformEntity(rec, M) {
  var o = cloneEntity(rec);
  var rule = XF_RULES[o.type] || XF_DEFAULT;
  xformPairs(o.pairs, rule, M);
  if (o.type === 'ARC' || o.type === 'ARC_DIMENSION') fixArcReflection(o.pairs, M);
  /* A mirrored INSERT needs a negative X scale to actually mirror its children. */
  if (o.type === 'INSERT' && M.reflect) {
    var found = false;
    for (var k = 0; k < o.pairs.length; k++) {
      if (o.pairs[k][0] === 41) { o.pairs[k][1] = -(n(o.pairs[k][1], 1) || 1); found = true; }
    }
    if (!found) o.pairs.push([41, -1]);
  }
  if (o.vertices) {
    for (var i = 0; i < o.vertices.length; i++) {
      xformPairs(o.vertices[i].pairs, XF_RULES.POINT, M);
    }
  }
  if (o.attribs) {
    for (var j = 0; j < o.attribs.length; j++) {
      xformPairs(o.attribs[j].pairs, XF_RULES.TEXT, M);
    }
  }
  return o;
}

/* DIMENSIONs draw from an anonymous block; transform that too so the
 * visible dimension follows its parent record. */
function transformDimensionBlocks(doc, rec, M) {
  var name = s(g(rec, 2, '')).toUpperCase();
  if (!name || !doc.blocks[name]) return;
  var b = doc.blocks[name];
  for (var i = 0; i < b.entities.length; i++) {
    b.entities[i] = transformEntity(b.entities[i], M);
  }
}

/* ---------- layers ---------- */
function ensureLayer(doc, name, color) {
  name = s(name, '0') || '0';
  if (!doc.tables.layer[name]) {
    doc.tables.layer[name] = {
      name: name, flags: 0, color: color === undefined ? 7 : color,
      trueColor: null, ltype: 'CONTINUOUS', lineweight: -3,
      frozen: false, off: false, plot: 1
    };
    if (!doc.__newLayers) doc.__newLayers = [];
    if (doc.__newLayers.indexOf(name) < 0) doc.__newLayers.push(name);
  }
  return name;
}

/* ---------- undo / redo ---------- */
function History(limit) {
  this.limit = limit || 40;
  this.stack = [];
  this.index = -1;
}
History.prototype.reset = function (doc) {
  this.stack = [this.snap(doc)];
  this.index = 0;
};
History.prototype.snap = function (doc) {
  return {
    entities: cloneEntities(doc.entities),
    blocks: cloneBlocks(doc.blocks || {}),
    newLayers: (doc.__newLayers || []).slice(),
    handleSeed: __handleSeed
  };
};
History.prototype.push = function (doc) {
  this.stack.length = this.index + 1;
  this.stack.push(this.snap(doc));
  if (this.stack.length > this.limit) this.stack.shift();
  this.index = this.stack.length - 1;
};
History.prototype.at = function (i) {
  if (i < 0 || i >= this.stack.length) return null;
  return this.stack[i];
};
History.prototype.canUndo = function () { return this.index > 0; };
History.prototype.canRedo = function () { return this.index < this.stack.length - 1; };
History.prototype.restore = function (doc, i) {
  var st = this.at(i);
  if (!st) return false;
  doc.entities = cloneEntities(st.entities);
  doc.blocks = cloneBlocks(st.blocks || {});
  doc.__newLayers = st.newLayers.slice();
  __handleSeed = st.handleSeed;
  /* recreate any layer that existed in this snapshot */
  for (var k = 0; k < st.newLayers.length; k++) {
    var nm = st.newLayers[k];
    if (!doc.tables.layer[nm]) ensureLayer(doc, nm);
  }
  this.index = i;
  return true;
};

API.assignEntityIds = assignEntityIds;
API.nextHandle = nextHandle;
API.newShape = newShape;
API.makeEntity = makeEntity;
API.cloneEntity = cloneEntity;
API.cloneEntities = cloneEntities;
API.setEntityProps = setEntityProps;
API.transformEntity = transformEntity;
API.transformDimensionBlocks = transformDimensionBlocks;
API.ensureLayer = ensureLayer;
API.fmtNum = fmtNum;
API.History = History;
API.XFmove = XFmove;
API.XFrotate = XFrotate;
API.XFscale = XFscale;
API.XFmirror = XFmirror;
