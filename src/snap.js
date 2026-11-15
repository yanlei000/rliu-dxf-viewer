/* ==========================================================================
 * Object snap + measurement maths.  Pure functions over scene primitives.
 * ========================================================================== */

function dist2(ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

function closestOnSeg(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1;
  var l2 = dx * dx + dy * dy;
  var t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [x1 + t * dx, y1 + t * dy];
}

function segIntersect(a, b, c, d) {
  var x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
  var x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1];
  var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-12) return null;
  var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  var u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

var SNAP_PRIORITY = {
  endpoint: 0, intersection: 1, center: 2, quadrant: 3,
  midpoint: 4, perpendicular: 5, nearest: 6
};
var SNAP_LABEL = {
  endpoint: '端点', intersection: '交点', center: '圆心', quadrant: '象限点',
  midpoint: '中点', perpendicular: '垂足', nearest: '最近点', grid: '栅格'
};

/* Find the best snap point near (wx,wy).
 * opts = { tol, layerOn, gridStep, ref, types } */
function snapPoint(items, wx, wy, opts) {
  opts = opts || {};
  var tol = opts.tol || 1;
  var types = opts.types || {};
  var on = opts.layerOn || function () { return true; };
  var reach = tol * 2.5;
  var best = null, bestScore = Infinity;
  var segs = [], cand = [], i, j, it;

  function consider(p, type) {
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
    var d = dist2(wx, wy, p[0], p[1]);
    if (d > reach) return;
    var pri = SNAP_PRIORITY[type];
    var score = pri * 0.42 + d / Math.max(1e-9, tol);
    if (score < bestScore) { bestScore = score; best = { p: p, type: type, label: SNAP_LABEL[type] || type, dist: d }; }
  }

  for (i = 0; i < items.length && cand.length < 90; i++) {
    it = items[i];
    if (!on(it.layer) || it.kind === 'infinite') continue;
    var bb = it._bb;
    if (bb && (bb[2] < wx - reach || bb[0] > wx + reach || bb[3] < wy - reach || bb[1] > wy + reach)) continue;
    cand.push(it);
  }

  for (i = 0; i < cand.length; i++) {
    it = cand[i];
    var pts = it.pts || [];
    var corners = it.corners || (pts.length <= 3 ? pts : [pts[0], pts[pts.length - 1]]);
    if (types.endpoint !== false) {
      for (j = 0; j < corners.length; j++) consider(corners[j], 'endpoint');
    }
    if (it.center && it.radius) {
      if (types.center !== false) consider(it.center, 'center');
      if (types.quadrant !== false) {
        var r = it.radius;
        consider([it.center[0] + r, it.center[1]], 'quadrant');
        consider([it.center[0] - r, it.center[1]], 'quadrant');
        consider([it.center[0], it.center[1] + r], 'quadrant');
        consider([it.center[0], it.center[1] - r], 'quadrant');
      }
      if (types.nearest !== false) {
        var ang = Math.atan2(wy - it.center[1], wx - it.center[0]);
        consider([it.center[0] + it.radius * Math.cos(ang),
                  it.center[1] + it.radius * Math.sin(ang)], 'nearest');
      }
    }
    if (types.midpoint !== false) {
      for (j = 0; j + 1 < corners.length; j++) {
        consider([(corners[j][0] + corners[j + 1][0]) / 2,
                  (corners[j][1] + corners[j + 1][1]) / 2], 'midpoint');
      }
      if (it.closed && corners.length > 2) {
        var c0 = corners[0], cl = corners[corners.length - 1];
        consider([(c0[0] + cl[0]) / 2, (c0[1] + cl[1]) / 2], 'midpoint');
      }
    }
    if (pts.length > 1) {
      for (j = 0; j + 1 < pts.length; j++) {
        var a = pts[j], b = pts[j + 1];
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-12) continue;
        if (segs.length < 220) segs.push([a, b]);
        if (types.nearest !== false) consider(closestOnSeg(wx, wy, a[0], a[1], b[0], b[1]), 'nearest');
        if (types.perpendicular !== false && opts.ref) {
          consider(closestOnSeg(opts.ref[0], opts.ref[1], a[0], a[1], b[0], b[1]), 'perpendicular');
        }
      }
    }
  }

  if (types.intersection !== false && segs.length > 1) {
    var lim = Math.min(segs.length, 80);
    for (i = 0; i < lim; i++) {
      for (j = i + 1; j < lim; j++) {
        var q = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
        if (q) consider(q, 'intersection');
      }
    }
  }

  if (best) return best;
  if (opts.gridStep > 0) {
    var gs = opts.gridStep;
    return {
      p: [Math.round(wx / gs) * gs, Math.round(wy / gs) * gs],
      type: 'grid', label: SNAP_LABEL.grid, dist: 0
    };
  }
  return null;
}

/* Locate a circle/arc primitive under the cursor (radius measurement). */
function findCircle(items, wx, wy, tol, layerOn) {
  var on = layerOn || function () { return true; };
  var best = null, bd = Infinity;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.center || !it.radius || !on(it.layer)) continue;
    var d = Math.abs(dist2(wx, wy, it.center[0], it.center[1]) - it.radius);
    if (d < tol && d < bd) { bd = d; best = it; }
  }
  return best;
}

/* ---------- measurement maths ---------- */
function polyLength(pts, closed) {
  if (!pts || pts.length < 2) return 0;
  var L = 0;
  for (var i = 1; i < pts.length; i++) L += dist2(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  if (closed && pts.length > 2) L += dist2(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return L;
}
function polyArea(pts) {
  if (!pts || pts.length < 3) return 0;
  var a = 0;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(a / 2);
}
function polyCentroid(pts) {
  var cx = 0, cy = 0, a = 0, i, j;
  for (i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    cx = 0; cy = 0;
    for (i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    return [cx / pts.length, cy / pts.length];
  }
  a *= 3;
  return [cx / a, cy / a];
}
function angleBetween(o, a, b) {
  var a1 = Math.atan2(a[1] - o[1], a[0] - o[0]);
  var a2 = Math.atan2(b[1] - o[1], b[0] - o[0]);
  var d = (a2 - a1) * 180 / Math.PI;
  while (d < 0) d += 360;
  while (d >= 360) d -= 360;
  return { included: Math.min(d, 360 - d), sweep: d };
}
function circleFrom3Points(p1, p2, p3) {
  var ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  var r = dist2(ux, uy, ax, ay);
  if (!isFinite(r) || r <= 0) return null;
  var norm = function (a) { a = a * 180 / Math.PI; while (a < 0) a += 360; while (a >= 360) a -= 360; return a; };
  var t1 = norm(Math.atan2(ay - uy, ax - ux));
  var t2 = norm(Math.atan2(by - uy, bx - ux));
  var t3 = norm(Math.atan2(cy - uy, cx - ux));
  var ccw = norm(t2 - t1) < norm(t3 - t1);
  var s = ccw ? t1 : t3, e = ccw ? t3 : t1;
  while (e <= s) e += 360;
  return { center: [ux, uy], radius: r, a0: s, a1: e };
}

API.closestOnSeg = closestOnSeg;
API.segIntersect = segIntersect;
API.snapPoint = snapPoint;
API.findCircle = findCircle;
API.polyLength = polyLength;
API.polyArea = polyArea;
API.polyCentroid = polyCentroid;
API.angleBetween = angleBetween;
API.circleFrom3Points = circleFrom3Points;
API.dist2 = dist2;
