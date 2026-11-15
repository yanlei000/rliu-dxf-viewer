/* ==========================================================================
 * Canvas 2D renderer with pan / zoom / layer filtering / picking / PNG export.
 * ========================================================================== */

var THEMES = {
  dark: { bg: '#212830', grid: 'rgba(255,255,255,0.055)', axis: 'rgba(255,255,255,0.16)' },
  light: { bg: '#FFFFFF', grid: 'rgba(0,0,0,0.06)', axis: 'rgba(0,0,0,0.18)' }
};

function computeBB(it) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i, p;
  if (it.kind === 'text' || it.kind === 'point') {
    var h = it.height || 1;
    var w = h * Math.max(2, (it.text || '').length * 0.6);
    /* A rotated string can extend on any side of its anchor.  Use a
     * conservative square so viewport culling never drops a label. */
    var r = Math.max(w, h * 2);
    return [it.pos[0] - r, it.pos[1] - r, it.pos[0] + r, it.pos[1] + r];
  }
  if (!it.pts || !it.pts.length) return null;
  for (i = 0; i < it.pts.length; i++) {
    p = it.pts[i];
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

function Viewer(canvas) {
  this.canvas = canvas;
  this.c = canvas.getContext('2d', { alpha: false });
  this.scene = null;
  this.theme = 'dark';
  this.opts = {
    lineweight: true, linetype: true, text: true, fill: true,
    points: true, grid: false, monochrome: false
  };
  this.layerVisible = {};
  this.scale = 1;
  this.panX = 0;
  this.panY = 0;
  this.dpr = 1;
  this.selected = null;
  this.overlayFn = null;      /* tools.js draws measurements / previews here */
  this.groups = { fill: [], line: [], text: [], point: [], infinite: [] };
}

Viewer.prototype.setScene = function (scene, keepView) {
  this.scene = scene;
  var g = { fill: [], line: [], text: [], point: [], infinite: [] };
  for (var i = 0; i < scene.items.length; i++) {
    var it = scene.items[i];
    it._bb = computeBB(it);
    if (g[it.kind]) g[it.kind].push(it);
  }
  this.groups = g;
  var lv = {};
  for (var j = 0; j < scene.stats.byLayerSorted.length; j++) {
    var name = scene.stats.byLayerSorted[j];
    lv[name] = this.layerVisible[name] === undefined ? true : this.layerVisible[name];
  }
  this.layerVisible = lv;
  if (!keepView) this.fit();
};

Viewer.prototype.setTheme = function (name) {
  this.theme = (name === 'light') ? 'light' : 'dark';
};

Viewer.prototype.center = function () {
  var b = this.scene ? this.scene.bounds : { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
};

Viewer.prototype.resize = function () {
  var w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  this.dpr = dpr;
  this.canvas.width = Math.max(1, Math.round(w * dpr));
  this.canvas.height = Math.max(1, Math.round(h * dpr));
  this.W = w;
  this.H = h;
};

Viewer.prototype.fit = function () {
  if (!this.scene) return;
  var b = this.scene.bounds;
  var w = Math.max(1e-6, b.maxX - b.minX), h = Math.max(1e-6, b.maxY - b.minY);
  var W = this.W || this.canvas.clientWidth || 800, H = this.H || this.canvas.clientHeight || 600;
  this.scale = Math.min((W * 0.92) / w, (H * 0.92) / h);
  if (!isFinite(this.scale) || this.scale <= 0) this.scale = 1;
  this.panX = 0;
  this.panY = 0;
  this.draw();
};

Viewer.prototype.view = function (W, H) {
  var c = this.center();
  return {
    W: W === undefined ? this.W : W,
    H: H === undefined ? this.H : H,
    scale: this.scale,
    panX: this.panX,
    panY: this.panY,
    dpr: this.dpr,
    cx: c[0], cy: c[1],
    bg: THEMES[this.theme].bg,
    grid: THEMES[this.theme].grid,
    axis: THEMES[this.theme].axis,
    dark: this.theme === 'dark'
  };
};

Viewer.prototype.w2s = function (x, y, v) {
  v = v || this.view();
  return [(x - v.cx) * v.scale + v.W / 2 + v.panX,
          v.H / 2 - (y - v.cy) * v.scale + v.panY];
};
Viewer.prototype.s2w = function (sx, sy, v) {
  v = v || this.view();
  return [(sx - v.W / 2 - v.panX) / v.scale + v.cx,
          (v.H / 2 + v.panY - sy) / v.scale + v.cy];
};
Viewer.prototype.visibleRect = function (v) {
  var a = this.s2w(0, v.H, v), b = this.s2w(v.W, 0, v);
  return [a[0], a[1], b[0], b[1]];
};

Viewer.prototype.zoomAt = function (px, py, factor) {
  var before = this.s2w(px, py);
  this.scale *= factor;
  this.scale = Math.max(1e-9, Math.min(1e9, this.scale));
  var after = this.s2w(px, py);
  this.panX += (after[0] - before[0]) * this.scale;
  this.panY -= (after[1] - before[1]) * this.scale;
  this.draw();
};

Viewer.prototype.layerOn = function (name) {
  return this.layerVisible[name] !== false;
};

Viewer.prototype.lineWidthPx = function (it, scale) {
  if (!this.opts.lineweight) return 1;
  var px = 1;
  if (it.worldWidth > 0) px = it.worldWidth * (scale || this.scale);
  else px = (it.lw || 25) / 100 * (96 / 25.4);
  return Math.max(0.7, Math.min(14, px));
};

Viewer.prototype.dashFor = function (it, scale) {
  if (!this.opts.linetype || !this.scene) return [];
  var doc = this.scene.doc;
  var def = doc.tables.ltype[it.linetype] || BUILTIN_LTYPES[it.linetype];
  if (!def || !def.pattern || !def.pattern.length) return [];
  var f = (scale || this.scale) * (it.ltscale || 1) * (doc.ltscale || 1);
  var d = [], ok = true;
  for (var i = 0; i < def.pattern.length; i++) {
    var x = Math.max(1.5, Math.abs(def.pattern[i]) * f);
    if (!isFinite(x) || x > 2e4) ok = false;
    d.push(x);
  }
  if (!ok) return [];
  if (d.length % 2) d.push(d[0]);
  return d;
};

Viewer.prototype.strokeColor = function (it, v) {
  if (it.color === '__BG__') return v.bg;
  if (this.opts.monochrome) return v.dark ? '#E6EDF3' : '#1F2937';
  return it.color;
};

Viewer.prototype.applyStroke = function (c, it, v) {
  c.strokeStyle = this.strokeColor(it, v);
  c.fillStyle = c.strokeStyle;
  c.lineWidth = this.lineWidthPx(it, v.scale);
  c.setLineDash(this.dashFor(it, v.scale));
  c.lineCap = 'butt';
  c.lineJoin = 'round';
};

function pointToSeg(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1;
  var l2 = dx * dx + dy * dy;
  var t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  var qx = x1 + t * dx - px, qy = y1 + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}
function pointInPoly(x, y, pts) {
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

Viewer.prototype.drawGrid = function (c, v) {
  var r = this.visibleRect(v);
  var span = Math.max(r[2] - r[0], r[3] - r[1]);
  var raw = span / 12;
  var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  var step = mag;
  [1, 2, 5, 10].some(function (m) { if (m * mag >= raw) { step = m * mag; return true; } return false; });
  c.save();
  c.strokeStyle = v.grid;
  c.lineWidth = 1;
  c.setLineDash([]);
  c.beginPath();
  var x, y, p;
  for (x = Math.ceil(r[0] / step) * step; x <= r[2]; x += step) {
    p = this.w2s(x, 0, v); c.moveTo(p[0], 0); c.lineTo(p[0], v.H);
  }
  for (y = Math.ceil(r[1] / step) * step; y <= r[3]; y += step) {
    p = this.w2s(0, y, v); c.moveTo(0, p[1]); c.lineTo(v.W, p[1]);
  }
  c.stroke();
  c.strokeStyle = v.axis;
  c.beginPath();
  p = this.w2s(0, 0, v);
  c.moveTo(p[0], 0); c.lineTo(p[0], v.H);
  c.moveTo(0, p[1]); c.lineTo(v.W, p[1]);
  c.stroke();
  c.restore();
};

Viewer.prototype.strokePath = function (c, pts, closed, v, minStep) {
  if (!pts || pts.length < 2) return;
  c.beginPath();
  var first = true, lx = 0, ly = 0, i, q;
  minStep = minStep === undefined ? 0.55 : minStep;
  for (i = 0; i < pts.length; i++) {
    q = this.w2s(pts[i][0], pts[i][1], v);
    if (!first && i < pts.length - 1 && Math.abs(q[0] - lx) + Math.abs(q[1] - ly) < minStep) continue;
    if (first) { c.moveTo(q[0], q[1]); first = false; } else c.lineTo(q[0], q[1]);
    lx = q[0]; ly = q[1];
  }
  if (closed) c.closePath();
  c.stroke();
};

Viewer.prototype.fillPath = function (c, pts, v) {
  if (!pts || pts.length < 3) return;
  c.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var q = this.w2s(pts[i][0], pts[i][1], v);
    if (i === 0) c.moveTo(q[0], q[1]); else c.lineTo(q[0], q[1]);
  }
  c.closePath();
  c.fill();
};

Viewer.prototype.drawTextItem = function (c, it, v) {
  var hpx = it.height * v.scale;
  if (hpx < 3 || hpx > 1200) return;
  var q = this.w2s(it.pos[0], it.pos[1], v);
  var lines = it.lines || [it.text];
  var refPx = it.refWidth ? it.refWidth * v.scale : 0;
  c.save();
  c.translate(q[0], q[1]);
  c.rotate(-it.rot);
  if (it.mirrorX) c.scale(-1, 1);
  if (it.mirrorY) c.scale(1, -1);
  c.font = hpx.toFixed(2) + 'px "Microsoft YaHei","Segoe UI",Arial,sans-serif';
  c.scale(it.widthFactor || 1, 1);
  c.fillStyle = this.strokeColor(it, v);
  var align = 'left', baseline = 'alphabetic';
  if (it.mtext) {
    var a = it.attach || 1;
    align = (a === 2 || a === 5 || a === 8) ? 'center' : ((a === 3 || a === 6 || a === 9) ? 'right' : 'left');
    baseline = 'middle';
  } else {
    if (it.hJust === 1 || it.hJust === 4) align = 'center';
    else if (it.hJust === 2) align = 'right';
    else if (it.hJust === 3 || it.hJust === 5) align = 'center';
    if (it.vJust === 1) baseline = 'bottom';
    else if (it.vJust === 2) baseline = 'middle';
    else if (it.vJust === 3) baseline = 'top';
  }
  c.textAlign = align;
  c.textBaseline = baseline;
  /* word wrap for MTEXT with a reference width */
  if (refPx > hpx && lines.length) {
    var src = lines.slice(), wrapped = [];
    for (var wi = 0; wi < src.length; wi++) {
      var cur = '', line = src[wi];
      for (var wc = 0; wc < line.length; wc++) {
        var test = cur + line.charAt(wc);
        if (cur && c.measureText(test).width > refPx) { wrapped.push(cur); cur = line.charAt(wc); }
        else cur = test;
      }
      wrapped.push(cur);
    }
    lines = wrapped;
  }
  var lh = hpx * 1.25 * (it.lineSpacing || 1);
  var start = 0;
  if (it.mtext) {
    var att = it.attach || 1;
    if (att <= 3) start = hpx * 0.5;
    else if (att >= 7) start = -(lines.length - 0.5) * lh;
    else start = -(lines.length - 1) * lh / 2;
  }
  for (var m = 0; m < lines.length; m++) {
    c.fillText(lines[m], 0, start + m * lh);
  }
  c.restore();
};

Viewer.prototype.drawInfinite = function (c, it, v) {
  var o = it.origin, d = it.dir;
  var r = this.visibleRect(v);
  var diag = Math.sqrt((r[2] - r[0]) * (r[2] - r[0]) + (r[3] - r[1]) * (r[3] - r[1])) * 2 + 10;
  var a, b;
  if (it.ray) {
    a = [o[0], o[1]];
    b = [o[0] + d[0] * diag, o[1] + d[1] * diag];
  } else {
    a = [o[0] - d[0] * diag, o[1] - d[1] * diag];
    b = [o[0] + d[0] * diag, o[1] + d[1] * diag];
  }
  var p1 = this.w2s(a[0], a[1], v), p2 = this.w2s(b[0], b[1], v);
  c.beginPath(); c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.stroke();
};

Viewer.prototype.paint = function (c, v, opts) {
  var self = this;
  opts = opts || {};
  /* All world/screen math uses CSS (logical) pixels.  The backing store is
   * dpr times larger, so the WHOLE frame must be drawn under that transform.
   * Resetting to identity here used to leave the extra right/bottom physical
   * margin unpainted and drew out-of-view geometry into that margin. */
  var dpr = v.dpr || 1;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  var pw = c.canvas ? c.canvas.width / dpr : v.W;
  var ph = c.canvas ? c.canvas.height / dpr : v.H;
  c.fillStyle = v.bg;
  c.fillRect(0, 0, Math.max(v.W, pw), Math.max(v.H, ph));
  /* Hard clip to the logical viewport: no entity, construction line or tool
   * overlay can ever bleed past the canvas edge. */
  c.save();
  c.beginPath();
  c.rect(0, 0, v.W, v.H);
  c.clip();
  if (this.opts.grid && !opts.noGrid) this.drawGrid(c, v);
  var r = this.visibleRect(v);
  var pad = 4 / v.scale;
  function visible(it) {
    if (!self.layerOn(it.layer)) return false;
    if (!it._bb || it.kind === 'infinite') return true;
    var b = it._bb;
    return !(b[2] < r[0] - pad || b[0] > r[2] + pad || b[3] < r[1] - pad || b[1] > r[3] + pad);
  }
  var i, it;
  /* pass 1: filled regions */
  if (this.opts.fill) {
    for (i = 0; i < this.groups.fill.length; i++) {
      it = this.groups.fill[i];
      if (!visible(it)) continue;
      c.fillStyle = it.color === '__BG__' ? v.bg : (this.opts.monochrome ? this.strokeColor(it, v) : it.color);
      c.globalAlpha = 1;
      this.fillPath(c, it.pts, v);
    }
  }
  c.globalAlpha = 1;
  /* pass 2: stroked geometry */
  for (i = 0; i < this.groups.line.length; i++) {
    it = this.groups.line[i];
    if (!visible(it)) continue;
    this.applyStroke(c, it, v);
    this.strokePath(c, it.pts, it.closed, v);
  }
  for (i = 0; i < this.groups.infinite.length; i++) {
    it = this.groups.infinite[i];
    if (!this.layerOn(it.layer)) continue;
    this.applyStroke(c, it, v);
    this.drawInfinite(c, it, v);
  }
  c.setLineDash([]);
  /* pass 3: points + text */
  if (this.opts.points) {
    for (i = 0; i < this.groups.point.length; i++) {
      it = this.groups.point[i];
      if (!visible(it)) continue;
      var q = this.w2s(it.pos[0], it.pos[1], v);
      c.strokeStyle = this.strokeColor(it, v);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(q[0] - 4, q[1]); c.lineTo(q[0] + 4, q[1]);
      c.moveTo(q[0], q[1] - 4); c.lineTo(q[0], q[1] + 4);
      c.stroke();
    }
  }
  if (this.opts.text) {
    for (i = 0; i < this.groups.text.length; i++) {
      it = this.groups.text[i];
      if (!visible(it)) continue;
      this.drawTextItem(c, it, v);
    }
  }
  /* selection highlight */
  if (this.selected) {
    it = this.selected;
    c.save();
    c.strokeStyle = this.theme === 'dark' ? '#FFD54A' : '#D97706';
    c.lineWidth = 2;
    c.setLineDash([6, 4]);
    if (it.pts && it.pts.length > 1) this.strokePath(c, it.pts, it.closed, v, 0);
    if (it.pos) {
      var pq = this.w2s(it.pos[0], it.pos[1], v);
      c.strokeRect(pq[0] - 5, pq[1] - 5, 10, 10);
    }
    c.restore();
  }
  /* Tool overlays: dimensions, rubber bands, snap markers, selections... */
  if (this.overlayFn && !opts.noOverlay) {
    c.save();
    c.setLineDash([]);
    this.overlayFn(c, v);
    c.restore();
  }
  c.restore();
};

Viewer.prototype.draw = function () {
  if (!this.scene || !this.c) return;
  /* OS zoom / moving the window to another monitor can change dpr without a
   * resize event; rebuild the backing store before painting. */
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  if (dpr !== this.dpr) this.resize();
  this.paint(this.c, this.view());
};

Viewer.prototype.pick = function (px, py) {
  if (!this.scene) return null;
  var v = this.view();
  var w = this.s2w(px, py, v);
  var tol = 7 / v.scale;
  var best = null, bestD = tol;
  var kinds = ['fill', 'line', 'text', 'point'];
  for (var k = 0; k < kinds.length; k++) {
    var arr = this.groups[kinds[k]] || [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!this.layerOn(it.layer)) continue;
      var bb = it._bb;
      if (bb && (w[0] < bb[0] - tol || w[0] > bb[2] + tol || w[1] < bb[1] - tol || w[1] > bb[3] + tol)) continue;
      var d = Infinity;
      if (it.kind === 'line' && it.pts) {
        for (var j = 0; j + 1 < it.pts.length; j++) {
          d = Math.min(d, pointToSeg(w[0], w[1], it.pts[j][0], it.pts[j][1], it.pts[j + 1][0], it.pts[j + 1][1]));
          if (d < bestD) break;
        }
      } else if (it.kind === 'fill' && it.pts) {
        if (pointInPoly(w[0], w[1], it.pts)) d = 0;
      } else if (it.pos) {
        d = Math.sqrt((w[0] - it.pos[0]) * (w[0] - it.pos[0]) + (w[1] - it.pos[1]) * (w[1] - it.pos[1])) - (it.height || 0);
        if (d < 0) d = 0;
      }
      if (d < bestD) { bestD = d; best = it; }
    }
  }
  return best;
};

/* Rectangle selection. crossing=false means "fully inside" (window),
 * crossing=true means "touches" (crossing). Items are returned raw; the
 * caller de-duplicates by top-level owner. */
Viewer.prototype.pickRect = function (px0, py0, px1, py1, crossing) {
  if (!this.scene) return [];
  var v = this.view();
  var a = this.s2w(Math.min(px0, px1), Math.max(py0, py1), v);
  var b = this.s2w(Math.max(px0, px1), Math.min(py0, py1), v);
  var x0 = a[0], y0 = a[1], x1 = b[0], y1 = b[1], out = [];
  var kinds = ['fill', 'line', 'text', 'point'];
  for (var k = 0; k < kinds.length; k++) {
    var arr = this.groups[kinds[k]] || [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!this.layerOn(it.layer)) continue;
      var bb = it._bb;
      if (!bb) continue;
      var hit = crossing
        ? !(bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1)
        : (bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1);
      if (hit) out.push(it);
    }
  }
  return out;
};

/* All primitives belonging to a set of top-level entity ids. */
Viewer.prototype.itemsForIds = function (ids) {
  var out = [], kinds = ['fill', 'line', 'text', 'point', 'infinite'];
  for (var k = 0; k < kinds.length; k++) {
    var arr = this.groups[kinds[k]] || [];
    for (var i = 0; i < arr.length; i++) if (ids[arr[i].ownerId]) out.push(arr[i]);
  }
  return out;
};

Viewer.prototype.exportPNG = function (wholeDrawing, multiplier) {
  if (!this.scene) return null;
  multiplier = multiplier || 2;
  var W, H, v;
  if (wholeDrawing) {
    var b = this.scene.bounds;
    var dw = b.maxX - b.minX, dh = b.maxY - b.minY;
    var base = Math.min(2400 / Math.max(1e-6, dw), 1600 / Math.max(1e-6, dh));
    W = Math.max(400, Math.round(dw * base));
    H = Math.max(300, Math.round(dh * base));
    v = this.view(W, H);
    v.scale = Math.min((W * 0.94) / dw, (H * 0.94) / dh);
    v.panX = 0; v.panY = 0;
  } else {
    W = this.W * multiplier;
    H = this.H * multiplier;
    v = this.view(W, H);
    v.scale = this.scale * multiplier;
    v.panX = this.panX * multiplier;
    v.panY = this.panY * multiplier;
  }
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var c = cv.getContext('2d', { alpha: false });
  v.dpr = 1; /* offscreen export canvas is 1:1, never the screen dpr */
  this.paint(c, v, { noGrid: true, noOverlay: true });
  return cv.toDataURL('image/png');
};

API.Viewer = Viewer;
API.THEMES = THEMES;
