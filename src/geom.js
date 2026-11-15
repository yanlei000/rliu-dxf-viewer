/* ==========================================================================
 * Color resolution, coordinate systems and drawing-item construction.
 * All entities are flattened into a small set of 2D drawing primitives:
 *   line / fill / text / point / infinite
 * ========================================================================== */

function packRGB(v) {
  v = (v >>> 0) & 0xFFFFFF;
  return '#' + ('000000' + v.toString(16)).slice(-6);
}

function aciToRgb(aci, dark) {
  var i = Math.abs(Math.round(n(aci, 7))) % 256;
  if (i === 0) i = 7;
  if (i === 7) return packRGB(dark ? 0xFFFFFF : 0x000000);
  return packRGB(ACI_RGB[i] === undefined ? 0xFFFFFF : ACI_RGB[i]);
}

function layerByName(doc, name) {
  return doc.tables.layer[name] || doc.tables.layer['0'] ||
    { name: name, color: 7, trueColor: null, ltype: 'CONTINUOUS', lineweight: -3, flags: 0 };
}

function colorByLayer(doc, name, dark) {
  var L = layerByName(doc, name);
  if (L.trueColor !== null && L.trueColor !== undefined) return packRGB(L.trueColor);
  return aciToRgb(L.color === undefined ? 7 : L.color, dark);
}

/* Color precedence: 420 true color > 62 ACI > BYLAYER(layer 420/62) > BYBLOCK(insert). */
function resolveColor(rec, doc, opts) {
  var tc = g(rec, 420);
  if (tc !== undefined && tc !== null && tc !== '') {
    return packRGB((n(tc, 0) >>> 0) & 0xFFFFFF);
  }
  var aci = g(rec, 62);
  var a = (aci === undefined || aci === null || aci === '') ? 256 : n(aci, 256);
  if (a === 256) return colorByLayer(doc, opts.layer, opts.dark);
  if (a === 0) return opts.color || colorByLayer(doc, opts.layer, opts.dark);
  return aciToRgb(a, opts.dark);
}

function resolveLinetype(rec, doc, ctx, layer) {
  var lt = s(g(rec, 6, ''));
  var up = lt.toUpperCase();
  if (up && up !== 'BYLAYER' && up !== 'BYBLOCK') return up;
  if (up === 'BYBLOCK') return (ctx.linetype || 'CONTINUOUS').toUpperCase();
  var L = layerByName(doc, layer);
  var name = (L.ltype || 'CONTINUOUS').toUpperCase();
  if (name === 'BYLAYER' || name === 'BYBLOCK') {
    return (ctx.depth > 0 ? (ctx.linetype || 'CONTINUOUS') : 'CONTINUOUS').toUpperCase();
  }
  return name;
}

function resolveLineweight(rec, doc, ctx, layer) {
  var lw = g(rec, 370);
  var v = (lw === undefined || lw === null || lw === '') ? -1 : n(lw, -1);
  if (v < 0) {
    if (v === -2 && ctx.lineweight) return ctx.lineweight;
    var L = layerByName(doc, layer);
    v = (L.lineweight > 0) ? L.lineweight : 25;
  }
  return v;
}

/* ---------- OCS (Object Coordinate System) / arbitrary axis algorithm ---------- */
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) {
  var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (l < 1e-12) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}
function getAxes(rec) {
  if (rec._axes !== undefined) return rec._axes;
  var nx = n(g(rec, 210, 0), 0), ny = n(g(rec, 220, 0), 0), nz = n(g(rec, 230, 1), 1);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && Math.abs(nz - 1) < 1e-9) {
    rec._axes = null;
    return null;
  }
  var N = norm3([nx, ny, nz]);
  var Ax = (Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64)
    ? cross3([0, 1, 0], N) : cross3([0, 0, 1], N);
  Ax = norm3(Ax);
  rec._axes = [Ax, norm3(cross3(N, Ax)), N];
  return rec._axes;
}
function ocsToWcs(p, axes) {
  var x = p[0] || 0, y = p[1] || 0, z = p[2] || 0;
  if (!axes) return [x, y, z];
  var A = axes[0], B = axes[1], C = axes[2];
  return [A[0] * x + B[0] * y + C[0] * z,
          A[1] * x + B[1] * y + C[1] * z,
          A[2] * x + B[2] * y + C[2] * z];
}
function identityXform(p) { return p; }
function toWorld(p, rec, ctx) {
  var q = ocsToWcs(p, getAxes(rec));
  q = ctx.xform(q);
  return [q[0], q[1]];
}

/* ---------- meta / emit ---------- */
function effectiveLayer(rec, ctx) {
  var L = s(g(rec, 8, '0'), '0') || '0';
  if (ctx.depth > 0 && L === '0' && ctx.layer && ctx.layer !== '0') return ctx.layer;
  return L;
}

function metaFrom(rec, ctx, state, type) {
  var layer = effectiveLayer(rec, ctx);
  var color = resolveColor(rec, state.doc, { layer: layer, color: ctx.color, dark: state.dark });
  var lt = resolveLinetype(rec, state.doc, ctx, layer);
  return {
    type: type || rec.type,
    layer: layer,
    color: color,
    linetype: lt,
    lw: resolveLineweight(rec, state.doc, ctx, layer),
    ltscale: n(g(rec, 48, 1), 1) || 1,
    worldWidth: 0,
    handle: s(g(rec, 5, '')),
    transparency: g(rec, 440) === undefined ? 0 : n(g(rec, 440)),
    source: rec
  };
}

function emit(state, item) {
  /* Every primitive remembers the top-level DXF entity it came from.
   * Selection, grips and editing operate on whole top-level entities, which
   * is how a CAD user expects a block reference to behave. */
  item.owner = state.owner || null;
  item.ownerId = state.owner ? state.owner.__id : -1;
  state.items.push(item);
  var b = state.bounds;
  var pts = item.pts;
  if (item.kind === 'text' || item.kind === 'point') {
    var h = item.height || 1;
    expandB(b, item.pos[0] - h, item.pos[1] - h);
    expandB(b, item.pos[0] + h * Math.max(2, (item.text || '').length * 0.6), item.pos[1] + h);
  } else if (pts && !item.noBounds) {
    for (var i = 0; i < pts.length; i++) expandB(b, pts[i][0], pts[i][1]);
  }
  var lc = state.stats.byLayer;
  lc[item.layer] = (lc[item.layer] || 0) + 1;
}
function expandB(b, x, y) {
  if (!isFinite(x) || !isFinite(y)) return;
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

function pushLine(state, pts, meta, closed, extra) {
  if (!pts || pts.length < 2) return;
  var it = {
    kind: 'line', pts: pts, closed: !!closed,
    color: meta.color, layer: meta.layer, linetype: meta.linetype,
    lw: meta.lw, ltscale: meta.ltscale, worldWidth: meta.worldWidth || 0,
    type: meta.type, handle: meta.handle, source: meta.source
  };
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) it[k] = extra[k];
  emit(state, it);
}
function pushFill(state, pts, meta) {
  if (!pts || pts.length < 3) return;
  emit(state, {
    kind: 'fill', pts: pts, closed: true,
    color: meta.color, layer: meta.layer, linetype: 'CONTINUOUS',
    lw: meta.lw, ltscale: 1, worldWidth: 0,
    type: meta.type, handle: meta.handle, source: meta.source
  });
}

/* ---------- geometry helpers ---------- */
function bulgePoints(p1, p2, b) {
  var out = [];
  if (Math.abs(b) < 1e-9) return out;
  var dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  var c = Math.sqrt(dx * dx + dy * dy);
  if (c < 1e-12) return out;
  var sag = b * c / 2;
  var r = (c * c / 4 + sag * sag) / (2 * Math.abs(sag));
  var nx = -dy / c, ny = dx / c;
  var sign = b > 0 ? 1 : -1;
  var d = r - Math.abs(sag);
  var cx = (p1[0] + p2[0]) / 2 + nx * sign * d;
  var cy = (p1[1] + p2[1]) / 2 + ny * sign * d;
  var a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  var sweep = 4 * Math.atan(b);
  var steps = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  for (var k = 1; k < steps; k++) {
    var a = a1 + sweep * k / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/* Bulge-aware polyline in OCS coords -> world coords. */
function polyWorld(rec, ctx, pts, closed, zDefault) {
  var out = [], segs = closed ? pts.length : pts.length - 1;
  for (var i = 0; i < pts.length; i++) {
    out.push(toWorld([pts[i].x, pts[i].y, pts[i].z || zDefault || 0], rec, ctx));
    if (i < segs) {
      var j = (i + 1) % pts.length;
      var b = pts[i].e42 || 0;
      var arc = bulgePoints([pts[i].x, pts[i].y], [pts[j].x, pts[j].y], b);
      for (var k = 0; k < arc.length; k++) out.push(toWorld([arc[k][0], arc[k][1], 0], rec, ctx));
    }
  }
  return out;
}

function circlePts(cx, cy, r, segs) {
  var pts = [];
  for (var i = 0; i < segs; i++) {
    var a = i * 2 * Math.PI / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
function toWorldPts(rec, ctx, pts2d, z) {
  var out = [];
  for (var i = 0; i < pts2d.length; i++) out.push(toWorld([pts2d[i][0], pts2d[i][1], z || 0], rec, ctx));
  return out;
}

/* ---------- NURBS (SPLINE) ---------- */
function uniformKnots(count, degree) {
  var U = [], i;
  for (i = 0; i <= degree; i++) U.push(0);
  var inner = count - degree - 1;
  for (i = 1; i <= inner; i++) U.push(i / (inner + 1));
  for (i = 0; i <= degree; i++) U.push(1);
  return U;
}
function bsplineBasis(i, p, u, U) {
  if (p === 0) return (U[i] <= u && u < U[i + 1]) ? 1 : 0;
  var a = 0, b = 0;
  var d1 = U[i + p] - U[i], d2 = U[i + p + 1] - U[i + 1];
  if (d1 > 1e-12) a = (u - U[i]) / d1 * bsplineBasis(i, p - 1, u, U);
  if (d2 > 1e-12) b = (U[i + p + 1] - u) / d2 * bsplineBasis(i + 1, p - 1, u, U);
  return a + b;
}
function splinePoints(rec) {
  var ctrl = collectPoints(rec, 10, 20, 30, [41]);
  var fits = collectPoints(rec, 11, 21, 31, []);
  var degree = Math.max(1, Math.min(8, Math.round(n(g(rec, 71, 3), 3))));
  var knots = ga(rec, 40).map(function (v) { return n(v); });
  var closed = !!(n(g(rec, 70, 0), 0) & 1);
  if (ctrl.length < 2) {
    /* Fit-point-only splines: Catmull-Rom interpolation. */
    if (fits.length < 2) return [];
    var fp = [], i, t, p0, p1, p2, p3, k, x, y;
    for (i = 0; i < fits.length - 1; i++) {
      p0 = fits[Math.max(0, i - 1)]; p1 = fits[i];
      p2 = fits[i + 1]; p3 = fits[Math.min(fits.length - 1, i + 2)];
      for (k = 0; k < 10; k++) {
        t = k / 10; t = t;
        x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
             (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t * t +
             (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t * t * t);
        y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
             (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t * t +
             (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t * t * t);
        fp.push([x, y]);
      }
    }
    fp.push([fits[fits.length - 1].x, fits[fits.length - 1].y]);
    return fp;
  }
  degree = Math.min(degree, ctrl.length - 1);
  if (knots.length !== ctrl.length + degree + 1) knots = uniformKnots(ctrl.length, degree);
  var lo = knots[degree], hi = knots[ctrl.length];
  if (!(hi > lo)) { knots = uniformKnots(ctrl.length, degree); lo = knots[degree]; hi = knots[ctrl.length]; }
  var weights = ctrl.map(function (p) { return p.e41 === undefined ? 1 : (p.e41 || 1); });
  var steps = Math.max(24, Math.min(400, ctrl.length * 12));
  var out = [], u, j, bx, by, bw, B, w;
  for (var sIdx = 0; sIdx <= steps; sIdx++) {
    u = lo + (hi - lo) * sIdx / steps;
    if (sIdx === steps) u = hi - 1e-9;
    bx = 0; by = 0; bw = 0;
    for (j = 0; j < ctrl.length; j++) {
      B = bsplineBasis(j, degree, u, knots);
      if (!B) continue;
      w = B * weights[j];
      bx += w * ctrl[j].x; by += w * ctrl[j].y; bw += w;
    }
    out.push(bw > 1e-12 ? [bx / bw, by / bw] : [ctrl[0].x, ctrl[0].y]);
  }
  if (closed && out.length) out.push(out[0].slice());
  return out;
}

/* ---------- pattern hatch lines clipped to a polygon ---------- */
function hatchSegments(poly, angleDeg, spacing, maxLines) {
  var a = angleDeg * Math.PI / 180;
  var ca = Math.cos(-a), sa = Math.sin(-a);
  var rot = [], i, vmin = Infinity, vmax = -Infinity;
  for (i = 0; i < poly.length; i++) {
    var q = [poly[i][0] * ca - poly[i][1] * sa, poly[i][0] * sa + poly[i][1] * ca];
    rot.push(q);
    if (q[1] < vmin) vmin = q[1];
    if (q[1] > vmax) vmax = q[1];
  }
  if (!isFinite(vmin) || vmax - vmin < 1e-9) return [];
  if ((vmax - vmin) / spacing > maxLines) spacing = (vmax - vmin) / maxLines;
  if (spacing <= 1e-9) return [];
  var segs = [], ca2 = Math.cos(a), sa2 = Math.sin(a);
  for (var v = vmin + spacing / 2; v < vmax; v += spacing) {
    var xs = [];
    for (i = 0; i < rot.length; i++) {
      var A = rot[i], B2 = rot[(i + 1) % rot.length];
      if ((A[1] <= v && B2[1] > v) || (B2[1] <= v && A[1] > v)) {
        xs.push(A[0] + (v - A[1]) * (B2[0] - A[0]) / (B2[1] - A[1]));
      }
    }
    xs.sort(function (x, y) { return x - y; });
    for (var k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] < 1e-9) continue;
      segs.push([
        [xs[k] * ca2 - v * sa2, xs[k] * sa2 + v * ca2],
        [xs[k + 1] * ca2 - v * sa2, xs[k + 1] * sa2 + v * ca2]
      ]);
    }
  }
  return segs;
}

/* ---------- text cleanup ---------- */
function cleanText(str, multiline) {
  var t = String(str || '');
  if (multiline) {
    t = t.replace(/\\P/gi, '\n').replace(/\\~/g, ' ');
    t = t.replace(/\\[AaCcFfHhQqTtWw][^;]*;/g, '');
    t = t.replace(/\\S([^;]*)\^([^;]*);/g, '$1/$2');
    t = t.replace(/[{}]/g, '');
  }
  t = t.replace(/%%[cC]/g, '\u00D8')
       .replace(/%%[dD]/g, '\u00B0')
       .replace(/%%[pP]/g, '\u00B1')
       .replace(/%%[oO]/g, '')
       .replace(/%%[uU]/g, '')
       .replace(/%%%/g, '%');
  t = t.replace(/\\[A-Za-z]/g, '');
  return t;
}

/* ---------- INSERT transform ---------- */
function makeInsertXform(rec, base, offX, offY) {
  var axes = getAxes(rec);
  var ins0 = [n(g(rec, 10, 0), 0), n(g(rec, 20, 0), 0), n(g(rec, 30, 0), 0)];
  var ins = ocsToWcs(ins0, axes);
  var rot = n(g(rec, 50, 0), 0) * Math.PI / 180;
  var sx = n(g(rec, 41, 1), 1), sy = n(g(rec, 42, 1), 1), sz = n(g(rec, 43, 1), 1);
  if (!sx) sx = 1; if (!sy) sy = 1; if (!sz) sz = 1;
  var cs = Math.cos(rot), sn = Math.sin(rot);
  var ox = (offX || 0) * cs - (offY || 0) * sn;
  var oy = (offX || 0) * sn + (offY || 0) * cs;
  var ow = ocsToWcs([ox, oy, 0], axes);
  return function (p) {
    var x = (p[0] - base[0]) * sx, y = (p[1] - base[1]) * sy, z = ((p[2] || 0) - base[2]) * sz;
    var xr = x * cs - y * sn, yr = x * sn + y * cs;
    var q = ocsToWcs([xr, yr, z], axes);
    return [q[0] + ins[0] + ow[0], q[1] + ins[1] + ow[1], q[2] + ins[2] + ow[2]];
  };
}

/* ---------- scene builder ---------- */
function buildScene(doc, options) {
  options = options || {};
  var state = {
    doc: doc,
    dark: options.dark !== false,
    items: [],
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    stats: { byType: {}, skipped: {}, byLayer: {}, total: 0, topLevel: 0, blockInserts: 0, drawn: 0 },
    warnings: []
  };
  var ctx = {
    xform: identityXform, color: null, layer: '0', linetype: 'CONTINUOUS',
    lineweight: 25, rotation: 0, scaleAvg: 1, depth: 0
  };
  for (var i = 0; i < doc.entities.length; i++) {
    state.stats.topLevel++;
    /* Stable identity for selection / grips, even for documents that were
     * parsed outside the UI (e.g. Node tests or an exported round-trip). */
    if (!doc.entities[i].__id) doc.entities[i].__id = ++__entityId;
    state.owner = doc.entities[i];
    expandEntity(doc.entities[i], ctx, 0, state);
  }
  state.owner = null;
  /* Header extents are a useful fallback when few drawable items exist. */
  if (!isFinite(state.bounds.minX) && doc.extmin && doc.extmax) {
    expandB(state.bounds, n(doc.extmin[10], 0), n(doc.extmin[20], 0));
    expandB(state.bounds, n(doc.extmax[10], 0), n(doc.extmax[20], 0));
  }
  if (!isFinite(state.bounds.minX)) {
    state.bounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  }
  var w = state.bounds.maxX - state.bounds.minX, h = state.bounds.maxY - state.bounds.minY;
  if (w < 1e-6) { state.bounds.minX -= 1; state.bounds.maxX += 1; w = 2; }
  if (h < 1e-6) { state.bounds.minY -= 1; state.bounds.maxY += 1; h = 2; }
  state.stats.drawn = state.items.length;
  state.stats.byLayerSorted = Object.keys(state.stats.byLayer).sort();
  return state;
}

API.buildScene = buildScene;
API.aciToRgb = aciToRgb;
API.packRGB = packRGB;
API.cleanText = cleanText;
