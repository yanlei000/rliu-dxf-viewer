/* ==========================================================================
 * Measurement / drafting / editing tools.
 *
 * A small command state-machine sits on top of the viewer.  All committed
 * geometry becomes real DXF entity records, so it survives undo, layer
 * filtering, colour resolution and DXF export without any special casing.
 * Transient feedback (rubber bands, dimensions, snap markers, ghosts) is
 * drawn through viewer.overlayFn and never enters the document.
 * ========================================================================== */

var ACI_NAMES = {
  1: '红', 2: '黄', 3: '绿', 4: '青', 5: '蓝', 6: '洋红',
  7: '白/黑', 8: '深灰', 9: '浅灰', 30: '橙', 40: '橙黄',
  50: '黄绿', 60: '浅绿', 70: '草绿', 80: '深绿', 90: '青绿',
  100: '青蓝', 110: '湖蓝', 120: '浅蓝', 130: '紫蓝', 140: '蓝紫',
  150: '靛蓝', 160: '紫', 170: '品紫', 180: '紫红', 190: '玫瑰',
  200: '朱红', 210: '橙红', 220: '粉红', 230: '浅粉', 240: '灰粉',
  250: '深灰 33%', 251: '深灰 50%', 252: '灰 66%', 253: '灰 75%',
  254: '浅灰 90%', 255: '白'
};

var TOOL_INFO = {
  view:      { name: '浏览',   hint: '左键拖拽平移 · 滚轮缩放 · 单击查看属性' },
  pan:       { name: '平移',   hint: '拖拽平移画布，滚轮缩放' },
  select:    { name: '选择',   hint: '单击选择 · 拖拽框选 · 拖动已选对象可移动 · Shift 加选 · 中键/空格拖拽平移' },
  quick:     { name: '快速测量', hint: '悬停查看对象长度 / 面积 / 半径，单击生成标注' },
  dist:      { name: '距离',   hint: '依次指定两点，测量长度、增量与角度' },
  chain:     { name: '连续距离', hint: '连续指定点，回车或右键结束，统计总长' },
  angle:     { name: '角度',   hint: '依次指定 顶点、第一边上一点、第二边上一点' },
  area:      { name: '面积',   hint: '依次指定多边形顶点，回车/右键闭合；也可直接单击闭合图形' },
  radius:    { name: '半径',   hint: '单击圆或圆弧，读取半径 / 直径 / 周长' },
  coord:     { name: '坐标',   hint: '单击任意位置，标注该点坐标' },
  line:      { name: '直线',   hint: '指定起点和终点，可连续绘制；回车结束' },
  pline:     { name: '多段线', hint: '连续指定顶点，回车/右键结束，C 键闭合' },
  rect:      { name: '矩形',   hint: '指定对角两点' },
  circle:    { name: '圆',     hint: '指定圆心，再指定半径点（或直接输入半径回车）' },
  arc:       { name: '圆弧',   hint: '依次指定 起点、弧上一点、终点（三点定弧）' },
  point:     { name: '点',     hint: '单击放置点对象' },
  text:      { name: '文字',   hint: '在命令条输入文字后回车，再单击放置；字高在左侧设置' },
  move:      { name: '移动',   hint: '先选中对象，再指定基点和目标点（可输入 dx,dy）' },
  copy:      { name: '复制',   hint: '先选中对象，再指定基点和目标点' },
  rotate:    { name: '旋转',   hint: '先选中对象，指定基点，再指定角度（可输入角度回车）' },
  scale:     { name: '缩放',   hint: '先选中对象，指定基点，再指定比例（可输入倍数回车）' },
  mirror:    { name: '镜像',   hint: '先选中对象，指定镜像轴两点（保留原对象）' },
  erase:     { name: '删除',   hint: '删除当前选中的对象，可撤销' }
};

var Tools = {
  tool: 'view',
  step: 0,
  pts: [],
  cursor: null,
  snapped: null,
  drag: null,
  selection: {},
  measurements: [],
  measureId: 1,
  ghost: null,
  hoverItem: null,
  textValue: '文字',
  spaceDown: false,
  pendingSelection: false,
  lastPrompt: ''
};

/* ---------- small helpers ---------- */
function t$(id) { return document.getElementById(id); }
function fmtM(v, d) {
  if (!isFinite(v)) return '—';
  var a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(d === undefined ? 3 : d);
}
function unitSuffix() {
  if (!doc) return '';
  var u = doc.insunits;
  return u === 4 ? ' mm' : u === 6 ? ' m' : u === 5 ? ' cm' : u === 1 ? ' in' : '';
}
function unitArea() {
  var s = unitSuffix();
  return s ? s + '²' : '';
}
function ovColors() {
  return viewer.theme === 'dark'
    ? { measure: '#FBBF24', measure2: '#FDE68A', snap: '#38BDF8', sel: '#FFD54A',
        ghost: '#A78BFA', box: '#60A5FA', chip: 'rgba(18,24,33,.88)', chipText: '#FDE68A' }
    : { measure: '#B45309', measure2: '#92400E', snap: '#0284C7', sel: '#D97706',
        ghost: '#7C3AED', box: '#2563EB', chip: 'rgba(255,251,235,.94)', chipText: '#92400E' };
}
function w2sV(p, v) { return viewer.w2s(p[0], p[1], v); }

function downloadBlob(name, text, mime, bom) {
  try {
    var blob = new Blob([(bom ? '\ufeff' : '') + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return true;
  } catch (e) { toast('导出失败：' + e.message, 5000); return false; }
}

/* ---------- tool activation ---------- */
Tools.setTool = function (name) {
  if (!TOOL_INFO[name]) name = 'view';
  if (name === 'erase') { Tools.eraseSelection(); return; }
  Tools.tool = name;
  Tools.step = 0;
  Tools.pts = [];
  Tools.ghost = null;
  Tools.scaleRef = 0;
  Tools.closePending = false;
  Tools.cmdBuf = '';
  Tools.pendingSelection = false;
  if (name === 'move' || name === 'copy' || name === 'rotate' ||
      name === 'scale' || name === 'mirror') {
    if (!Tools.hasSelection()) {
      toast('请先用「选择」工具选中对象，再执行' + TOOL_INFO[name].name, 3600);
      Tools.setTool('select');
      return;
    }
  }
  var rail = t$('toolrail');
  if (rail) {
    var btns = rail.querySelectorAll('button[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.tool === name);
    }
  }
  Tools.updateCmdBar();
  t$('stTool').textContent = '工具 ' + TOOL_INFO[name].name;
  viewer.selected = null;
  requestDraw();
};

Tools.updateCmdBar = function () {
  var bar = t$('cmdbar'), name = Tools.tool;
  var info = TOOL_INFO[name] || TOOL_INFO.view;
  var visible = (name !== 'view' && name !== 'pan');
  bar.style.display = visible ? 'flex' : 'none';
  if (!visible) {
    t$('stageHint').textContent = '滚轮缩放 · 拖拽平移 · 单击查看对象属性 · F 适应窗口 · Esc 返回浏览';
    return;
  }
  t$('cmdName').textContent = info.name;
  var prompt = info.hint;
  if (name === 'line' && Tools.pts.length) prompt = '指定下一点（回车结束）';
  if (name === 'pline' && Tools.pts.length) prompt = '指定下一点（回车结束，C 闭合）';
  if (name === 'rect' && Tools.pts.length) prompt = '指定矩形另一角';
  if (name === 'circle' && Tools.pts.length) prompt = '指定半径点，或输入半径后回车';
  if (name === 'arc') prompt = ['指定圆弧起点', '指定弧上一点', '指定圆弧终点'][Tools.step] || info.hint;
  if (name === 'dist' && Tools.pts.length) prompt = '指定第二点';
  if (name === 'chain') prompt = '指定下一点（回车/右键结束，累计 ' +
      fmtM(API.polyLength(Tools.pts, false)) + '）';
  if (name === 'angle') prompt = ['指定角度顶点', '指定第一边上一点', '指定第二边上一点'][Tools.step] || info.hint;
  if (name === 'area' && Tools.pts.length) prompt = '指定下一顶点（回车/右键闭合）';
  if (name === 'text') prompt = '输入文字后回车，再单击放置（当前：' + Tools.textValue + '）';
  if ((name === 'move' || name === 'copy' || name === 'rotate' || name === 'scale' || name === 'mirror')) {
    prompt = Tools.step === 0 ? '指定基点' : (TOOL_INFO[name].hint);
    if (name === 'mirror' && Tools.step === 1) prompt = '指定镜像轴第二点';
    if (name === 'rotate' && Tools.step === 1) prompt = '指定旋转角度，或输入角度回车';
    if (name === 'scale' && Tools.step === 1) prompt = '指定缩放比例，或输入倍数回车';
  }
  Tools.lastPrompt = prompt;
  t$('cmdPrompt').textContent = prompt;
  var inp = t$('cmdInput');
  inp.placeholder = (name === 'text') ? '文字内容，回车确认' : '输入数值后回车';
  if (document.activeElement !== inp) inp.value = '';
  t$('stageHint').textContent = prompt;
};

Tools.cancel = function () {
  Tools.setTool('view');
  Tools.clearSelection();
  t$('helpModal').classList.remove('show');
  clearProps();
  requestDraw();
};

/* ---------- selection ---------- */
Tools.hasSelection = function () {
  for (var k in Tools.selection) if (Tools.selection[k]) return true;
  return false;
};
Tools.selectionCount = function () {
  var n = 0;
  for (var k in Tools.selection) if (Tools.selection[k]) n++;
  return n;
};
Tools.selectedEntities = function () {
  var out = [];
  if (!doc) return out;
  for (var i = 0; i < doc.entities.length; i++) {
    if (Tools.selection[doc.entities[i].__id]) out.push(doc.entities[i]);
  }
  return out;
};
Tools.clearSelection = function () {
  Tools.selection = {};
  Tools.updatePropEdit();
};
Tools.setSelectionIds = function (ids, add) {
  if (!add) Tools.selection = {};
  for (var i = 0; i < ids.length; i++) Tools.selection[ids[i]] = true;
  Tools.updatePropEdit();
  requestDraw();
};
Tools.toggleSelectionId = function (id, add) {
  if (!add) Tools.selection = {};
  if (Tools.selection[id] && add) delete Tools.selection[id];
  else Tools.selection[id] = true;
  Tools.updatePropEdit();
};

/* ---------- document mutation ---------- */
function commit(label) {
  history.push(doc);
  refresh(true);
  Tools.updatePropEdit();
  if (label) t$('stMsg').textContent = label;
}

function addEntity(ent, label) {
  if (!ent) return;
  doc.entities.push(ent);
  commit(label || ('已添加 ' + ent.type));
}
Tools.eraseSelection = function () {
  var sel = Tools.selectedEntities();
  if (!sel.length) { toast('请先选择要删除的对象'); return; }
  var ids = {};
  for (var i = 0; i < sel.length; i++) ids[sel[i].__id] = true;
  doc.entities = doc.entities.filter(function (e) { return !ids[e.__id]; });
  Tools.clearSelection();
  commit('已删除 ' + sel.length + ' 个对象（可撤销）');
  toast('已删除 ' + sel.length + ' 个对象，Ctrl+Z 可撤销');
};

Tools.applyTransformToSelection = function (M, keepOriginal, label) {
  var sel = Tools.selectedEntities();
  if (!sel.length) return;
  var map = {}, i;
  for (i = 0; i < sel.length; i++) map[sel[i].__id] = sel[i];
  var copies = [];
  for (i = 0; i < sel.length; i++) {
    var e = sel[i];
    if (e.type === 'DIMENSION' || e.type === 'ARC_DIMENSION' || e.type === 'LARGE_RADIAL_DIMENSION') {
      API.transformDimensionBlocks(doc, e, M);
    }
    var t = API.transformEntity(e, M);
    if (keepOriginal) {
      t.__id = ++__entityId;
      t.pairs = t.pairs.filter(function (p) { return p[0] !== 5; });
      t.pairs.unshift([5, API.nextHandle()]);
      copies.push(t);
    } else {
      doc.entities[doc.entities.indexOf(e)] = t;
    }
  }
  if (keepOriginal) {
    for (i = 0; i < copies.length; i++) doc.entities.push(copies[i]);
    Tools.selection = {};
    for (i = 0; i < copies.length; i++) Tools.selection[copies[i].__id] = true;
  }
  Tools.ghost = null;
  commit(label);
};

/* ---------- settings ---------- */
Tools.style = function () {
  var layer = t$('setLayer').value || '0';
  var color = t$('setColor').value;
  var st = { layer: layer, aci: null, trueColor: null, lw: null, linetype: 'CONTINUOUS' };
  if (color === 'bylayer') { /* nothing */ }
  else if (color === 'custom') st.trueColor = parseInt(t$('setColorRGB').value.slice(1), 16);
  else st.aci = parseInt(color, 10);
  var lw = t$('setLw').value;
  if (lw !== '') st.lw = parseInt(lw, 10);
  return st;
};
Tools.textHeight = function () {
  var h = parseFloat(t$('setTextH').value);
  return isFinite(h) && h > 0 ? h : 2.5;
};
Tools.gridStep = function () {
  var v = viewer.view();
  var r = viewer.visibleRect(v);
  var span = Math.max(r[2] - r[0], r[3] - r[1]) / 12;
  var mag = Math.pow(10, Math.floor(Math.log(Math.max(1e-12, span)) / Math.LN10));
  var step = mag;
  [1, 2, 5, 10].some(function (m) { if (m * mag >= span) { step = m * mag; return true; } return false; });
  return step;
};
Tools.currentPoint = function () {
  if (Tools.snapped && Tools.snapped.p) return Tools.snapped.p.slice();
  return Tools.cursor ? Tools.cursor.slice() : [0, 0];
};
Tools.orthoPoint = function (p) {
  if (!t$('setOrtho').checked || !Tools.pts.length) return p;
  var b = Tools.pts[Tools.pts.length - 1];
  var dx = p[0] - b[0], dy = p[1] - b[1];
  return Math.abs(dx) >= Math.abs(dy) ? [p[0], b[1]] : [b[0], p[1]];
};
Tools.resolvePoint = function (raw) {
  var p = Tools.orthoPoint(raw);
  if (t$('setSnap').checked && scene) {
    var tol = 11 / viewer.scale;
    var snap = API.snapPoint(scene.items, p[0], p[1], {
      tol: tol,
      layerOn: function (L) { return viewer.layerOn(L); },
      gridStep: t$('setGridSnap').checked ? Tools.gridStep() : 0,
      ref: Tools.pts.length ? Tools.pts[Tools.pts.length - 1] : null
    });
    if (snap) { Tools.snapped = snap; return snap.p.slice(); }
  }
  Tools.snapped = null;
  if (t$('setGridSnap').checked) {
    var g = Tools.gridStep();
    return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }
  return p;
};

/* ---------- measurements ---------- */
function addMeasure(m) {
  m.id = Tools.measureId++;
  m.unit = unitSuffix();
  Tools.measurements.push(m);
  buildMeasureList();
  requestDraw();
}
function clearMeasures() {
  Tools.measurements = [];
  buildMeasureList();
  requestDraw();
}
function buildMeasureList() {
  var box = t$('measureList');
  if (!box) return;
  if (!Tools.measurements.length) {
    box.innerHTML = '<div class="prop-empty" style="padding:10px 2px">暂无测量记录，使用左侧测量工具开始。</div>';
    t$('measureCount').textContent = '0 条';
    return;
  }
  var html = '', list = Tools.measurements;
  for (var i = list.length - 1; i >= 0; i--) {
    var m = list[i];
    html += '<div class="measure-row" data-mid="' + m.id + '">' +
      '<span class="m-icon">' + esc(m.icon || '·') + '</span>' +
      '<span class="m-main"><b>' + esc(m.title) + '</b><small>' + esc(m.detail) + '</small></span>' +
      '<button class="m-del" data-del="' + m.id + '" title="删除">×</button></div>';
  }
  box.innerHTML = html;
  t$('measureCount').textContent = list.length + ' 条';
}
Tools.measureCSV = function () {
  if (!Tools.measurements.length) { toast('暂无测量数据'); return; }
  var rows = ['序号,类型,结果,明细,单位'];
  for (var i = 0; i < Tools.measurements.length; i++) {
    var m = Tools.measurements[i];
    var cells = [i + 1, m.title, m.valueText || '', (m.detail || '').replace(/,/g, '，'),
                 (m.unit || '').trim()];
    rows.push(cells.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(','));
  }
  downloadBlob('测量结果.csv', rows.join('\r\n'), 'text/csv', true);
  toast('已导出 ' + Tools.measurements.length + ' 条测量记录');
};

function measureFromItem(it) {
  if (!it) return;
  if (it.center && it.radius) {
    addMeasure({ type: 'radius', icon: 'R', center: it.center, radius: it.radius,
      pts: [it.center, [it.center[0] + it.radius, it.center[1]]],
      title: 'R ' + fmtM(it.radius) + unitSuffix(),
      valueText: fmtM(it.radius) + unitSuffix(),
      detail: 'D ' + fmtM(it.radius * 2) + unitSuffix() + ' · 周长 ' +
              fmtM(2 * Math.PI * it.radius) + unitSuffix() +
              ' · 圆心 ' + fmtM(it.center[0], 2) + ', ' + fmtM(it.center[1], 2) });
    return;
  }
  if (it.pts && it.pts.length > 2 && (it.closed || it.kind === 'fill')) {
    addMeasure({ type: 'area', icon: 'A', pts: it.pts.slice(),
      title: fmtM(API.polyArea(it.pts)) + unitArea(),
      valueText: fmtM(API.polyArea(it.pts)) + unitArea(),
      detail: '周长 ' + fmtM(API.polyLength(it.pts, true)) + unitSuffix() +
              ' · 顶点 ' + it.pts.length });
    return;
  }
  if (it.pts && it.pts.length > 1) {
    addMeasure({ type: 'dist', icon: 'L', pts: [it.pts[0], it.pts[it.pts.length - 1]],
      chain: it.pts.slice(),
      title: fmtM(API.polyLength(it.pts, it.closed)) + unitSuffix(),
      valueText: fmtM(API.polyLength(it.pts, it.closed)) + unitSuffix(),
      detail: '长度 ' + fmtM(API.polyLength(it.pts, it.closed)) + unitSuffix() +
              ' · 端点 ' + fmtM(it.pts[0][0], 2) + ',' + fmtM(it.pts[0][1], 2) +
              ' → ' + fmtM(it.pts[it.pts.length - 1][0], 2) + ',' + fmtM(it.pts[it.pts.length - 1][1], 2) });
  }
}

/* ---------- point input dispatcher ---------- */
function onToolPoint(p, E) {
  var T = Tools.tool, n = Tools.pts.length;
  if (T === 'quick') { measureFromItem(Tools.hoverItem); return; }
  if (T === 'coord') {
    addMeasure({ type: 'coord', icon: '+', pts: [p.slice()],
      title: 'X ' + fmtM(p[0]) + '  Y ' + fmtM(p[1]),
      valueText: p[0].toFixed(4) + ',' + p[1].toFixed(4),
      detail: '坐标 X=' + fmtM(p[0], 4) + '  Y=' + fmtM(p[1], 4) + unitSuffix() });
    return;
  }
  if (T === 'radius') {
    var ci = API.findCircle(scene.items, E.raw[0], E.raw[1], 14 / viewer.scale,
                            function (L) { return viewer.layerOn(L); });
    if (ci) measureFromItem(ci);
    else toast('请点在圆或圆弧的轮廓线上');
    return;
  }
  if (T === 'dist') {
    Tools.pts.push(p);
    if (Tools.pts.length >= 2) {
      var a = Tools.pts[0], b = Tools.pts[1];
      var d = API.dist2(a[0], a[1], b[0], b[1]);
      var ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      addMeasure({ type: 'dist', icon: 'L', pts: [a.slice(), b.slice()],
        title: fmtM(d) + unitSuffix(),
        valueText: fmtM(d) + unitSuffix(),
        detail: 'ΔX ' + fmtM(b[0] - a[0]) + ' · ΔY ' + fmtM(b[1] - a[1]) +
                ' · 角度 ' + fmtM(ang, 2) + '°' });
      Tools.pts = [];
    }
    Tools.updateCmdBar();
    return;
  }
  if (T === 'chain') { Tools.pts.push(p); Tools.updateCmdBar(); return; }
  if (T === 'angle') {
    Tools.pts.push(p);
    if (Tools.pts.length >= 3) {
      var o = Tools.pts[0], q1 = Tools.pts[1], q2 = Tools.pts[2];
      var A = API.angleBetween(o, q1, q2);
      addMeasure({ type: 'angle', icon: '∠', pts: Tools.pts.slice(),
        title: fmtM(A.included, 2) + '°',
        valueText: fmtM(A.included, 2) + '°',
        detail: '夹角 ' + fmtM(A.included, 2) + '° · 逆时针扫角 ' + fmtM(A.sweep, 2) +
                '° · 顶点 ' + fmtM(o[0], 2) + ',' + fmtM(o[1], 2) });
      Tools.pts = []; Tools.step = 0;
    } else Tools.step = Tools.pts.length;
    Tools.updateCmdBar();
    return;
  }
  if (T === 'area') {
    if (!n) {
      var hit = viewer.pick(E.px, E.py);
      if (hit && hit.pts && hit.pts.length > 2 && (hit.closed || hit.kind === 'fill')) {
        measureFromItem(hit);
        return;
      }
    }
    Tools.pts.push(p);
    Tools.updateCmdBar();
    return;
  }
  if (T === 'point') { addEntity(API.newShape('POINT', { pts: [p] }, Tools.style())); return; }
  if (T === 'text') {
    addEntity(API.newShape('TEXT', { pts: [p], text: Tools.textValue,
      height: Tools.textHeight(), rot: 0 }, Tools.style()));
    return;
  }
  if (T === 'line') {
    Tools.pts.push(p);
    if (Tools.pts.length >= 2) {
      addEntity(API.newShape('LINE', { pts: [Tools.pts[0], Tools.pts[1]] }, Tools.style()));
      Tools.pts = [Tools.pts[1]];
    }
    Tools.updateCmdBar();
    return;
  }
  if (T === 'pline') { Tools.pts.push(p); Tools.updateCmdBar(); return; }
  if (T === 'rect') {
    Tools.pts.push(p);
    if (Tools.pts.length >= 2) {
      var p0 = Tools.pts[0], p1 = Tools.pts[1];
      addEntity(API.newShape('LWPOLYLINE', {
        closed: true,
        pts: [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]]]
      }, Tools.style()));
      Tools.pts = [];
    }
    Tools.updateCmdBar();
    return;
  }
  if (T === 'circle') {
    Tools.pts.push(p);
    if (Tools.pts.length >= 2) {
      var r = API.dist2(Tools.pts[0][0], Tools.pts[0][1], p[0], p[1]);
      if (r > 1e-9) addEntity(API.newShape('CIRCLE', { center: Tools.pts[0], radius: r }, Tools.style()));
      Tools.pts = [];
    }
    Tools.updateCmdBar();
    return;
  }
  if (T === 'arc') {
    Tools.pts.push(p);
    Tools.step = Tools.pts.length;
    if (Tools.pts.length >= 3) {
      var c = API.circleFrom3Points(Tools.pts[0], Tools.pts[1], Tools.pts[2]);
      if (c) addEntity(API.newShape('ARC', c, Tools.style()));
      else toast('三点共线，无法确定圆弧');
      Tools.pts = []; Tools.step = 0;
    }
    Tools.updateCmdBar();
    return;
  }
  if (T === 'move' || T === 'copy' || T === 'rotate' || T === 'scale' || T === 'mirror') {
    Tools.pts.push(p);
    Tools.step = Tools.pts.length;
    if (Tools.pts.length >= 2) {
      Tools.finishEdit();
    } else Tools.updateCmdBar();
    return;
  }
}

Tools.finishEdit = function () {
  var T = Tools.tool, a = Tools.pts[0], b = Tools.pts[1];
  if (!a || !b) return;
  var M;
  if (T === 'move') M = API.XFmove(b[0] - a[0], b[1] - a[1]);
  else if (T === 'copy') M = API.XFmove(b[0] - a[0], b[1] - a[1]);
  else if (T === 'rotate') M = API.XFrotate(a, Tools.editAngle(a, b));
  else if (T === 'scale') M = API.XFscale(a, Tools.editScale(a, b));
  else if (T === 'mirror') M = API.XFmirror(a, b);
  if (!M) return;
  Tools.applyTransformToSelection(M, T === 'copy' || T === 'mirror',
    TOOL_INFO[T].name + ' 完成');
  Tools.pts = []; Tools.step = 0; Tools.ghost = null;
  Tools.updateCmdBar();
  toast(TOOL_INFO[T].name + '完成（Ctrl+Z 可撤销）', 2400);
};
Tools.editAngle = function (o, p) {
  return Math.atan2(p[1] - o[1], p[0] - o[0]) * 180 / Math.PI;
};
Tools.editScale = function (o, p) {
  var d = API.dist2(o[0], o[1], p[0], p[1]);
  var ref = Math.max(1e-9, Tools.scaleRef || 1);
  return d / ref;
};

/* Enter / right-click finishes a multi-point command. */
Tools.finishCommand = function () {
  var T = Tools.tool, pts = Tools.pts;
  if (T === 'pline') {
    if (pts.length >= 2) addEntity(API.newShape('LWPOLYLINE',
      { pts: pts.slice(), closed: !!Tools.closePending }, Tools.style()));
    Tools.pts = []; Tools.closePending = false;
  } else if (T === 'line') {
    Tools.pts = [];
  } else if (T === 'chain') {
    if (pts.length >= 2) {
      var L = API.polyLength(pts, false);
      addMeasure({ type: 'chain', icon: 'Σ', pts: pts.slice(),
        title: 'Σ ' + fmtM(L) + unitSuffix(), valueText: fmtM(L) + unitSuffix(),
        detail: pts.length + ' 段 · 总长 ' + fmtM(L) + unitSuffix() +
                ' · 直线距离 ' + fmtM(API.dist2(pts[0][0], pts[0][1],
                  pts[pts.length - 1][0], pts[pts.length - 1][1])) + unitSuffix() });
    }
    Tools.pts = [];
  } else if (T === 'area') {
    if (pts.length >= 3) {
      addMeasure({ type: 'area', icon: 'A', pts: pts.slice(),
        title: fmtM(API.polyArea(pts)) + unitArea(),
        valueText: fmtM(API.polyArea(pts)) + unitArea(),
        detail: '周长 ' + fmtM(API.polyLength(pts, true)) + unitSuffix() +
                ' · 顶点 ' + pts.length });
    } else toast('面积测量至少需要 3 个点');
    Tools.pts = [];
  } else {
    Tools.pts = []; Tools.step = 0; Tools.ghost = null;
  }
  Tools.updateCmdBar();
  requestDraw();
};

/* Numeric / text command entry. */
Tools.onCommand = function (raw) {
  var s = String(raw || '').trim(), T = Tools.tool;
  if (!s) { Tools.finishCommand(); return; }
  if (T === 'text') {
    Tools.textValue = s;
    Tools.updateCmdBar();
    toast('文字已设为「' + s + '」，单击画布放置');
    return;
  }
  if (T === 'pline' && (s.toUpperCase() === 'C' || s === '闭合')) {
    Tools.closePending = true; Tools.finishCommand(); return;
  }
  if (/^[a-zA-Z]+$/.test(s) && TOOL_ALIASES[s.toLowerCase()]) {
    Tools.setTool(TOOL_ALIASES[s.toLowerCase()]); return;
  }
  var val = parseFloat(s);
  if (!isFinite(val)) { Tools.finishCommand(); return; }
  var p = Tools.currentPoint(), base = Tools.pts.length ? Tools.pts[Tools.pts.length - 1] : [0, 0];
  if (T === 'circle' && Tools.pts.length === 1) {
    if (val > 0) addEntity(API.newShape('CIRCLE', { center: base, radius: Math.abs(val) }, Tools.style()));
    Tools.pts = [];
    Tools.updateCmdBar();
    return;
  }
  if ((T === 'line' || T === 'pline' || T === 'dist' || T === 'chain' || T === 'rect') && Tools.pts.length) {
    var ang = Math.atan2(p[1] - base[1], p[0] - base[0]);
    if (Math.abs(p[0] - base[0]) + Math.abs(p[1] - base[1]) < 1e-12) ang = 0;
    onToolPoint([base[0] + val * Math.cos(ang), base[1] + val * Math.sin(ang)],
                { px: 0, py: 0, raw: p });
    return;
  }
  if (T === 'rotate' && Tools.pts.length === 1) {
    Tools.applyTransformToSelection(API.XFrotate(base, val), false, '旋转 ' + fmtM(val, 2) + '°');
    Tools.pts = []; Tools.step = 0; Tools.ghost = null; Tools.updateCmdBar();
    return;
  }
  if (T === 'scale' && Tools.pts.length === 1) {
    if (val !== 0) Tools.applyTransformToSelection(API.XFscale(base, val), false, '缩放 ×' + fmtM(val, 2));
    Tools.pts = []; Tools.step = 0; Tools.ghost = null; Tools.updateCmdBar();
    return;
  }
  if ((T === 'move' || T === 'copy') && Tools.pts.length === 1) {
    var parts = s.split(/[,，\s]+/);
    var dx = val, dy = parts.length > 1 ? parseFloat(parts[1]) : 0;
    if (!isFinite(dy)) dy = 0;
    Tools.applyTransformToSelection(API.XFmove(dx, dy), T === 'copy', TOOL_INFO[T].name + ' 完成');
    Tools.pts = []; Tools.step = 0; Tools.ghost = null; Tools.updateCmdBar();
    return;
  }
  Tools.finishCommand();
};

/* ---------- pointer handling ---------- */
Tools.onDown = function (E) {
  if (E.button === 1 || Tools.spaceDown) {
    Tools.drag = { mode: 'pan', x: E.px, y: E.py };
    return true;
  }
  if (E.button === 2) { Tools.finishCommand(); return true; }
  if (E.button !== 0) return true;
  var T = Tools.tool;
  if (T === 'view') return false;
  if (!scene) startBlankDrawing();
  if (T === 'pan') { Tools.drag = { mode: 'pan', x: E.px, y: E.py }; return true; }
  if (T === 'select') {
    var hit = viewer.pick(E.px, E.py);
    if (hit && hit.ownerId >= 0) {
      if (!Tools.selection[hit.ownerId]) Tools.toggleSelectionId(hit.ownerId, E.shiftKey);
      showProps(hit);
      if (Tools.selection[hit.ownerId]) {
        Tools.drag = { mode: 'move', x: E.px, y: E.py, start: [E.wx, E.wy], moved: false };
      }
    } else {
      Tools.drag = { mode: 'marquee', x: E.px, y: E.py, cur: [E.px, E.py], add: E.shiftKey };
      clearProps();
    }
    Tools.updatePropEdit();
    requestDraw();
    return true;
  }
  var p = Tools.resolvePoint(E.raw);
  onToolPoint(p, E);
  requestDraw();
  return true;
};

/* Compute the live transform preview before the overlay is painted. */
function updateGhost() {
  var T = Tools.tool, pts = Tools.pts;
  Tools.ghost = null;
  if (!Tools.cursor || !pts.length || !Tools.hasSelection()) return;
  var p = Tools.currentPoint(), a = pts[0];
  if (T === 'move' || T === 'copy') Tools.ghost = API.XFmove(p[0] - a[0], p[1] - a[1]);
  else if (T === 'rotate' && pts.length === 1) Tools.ghost = API.XFrotate(a, Tools.editAngle(a, p));
  else if (T === 'scale' && pts.length === 1) {
    var d = API.dist2(a[0], a[1], p[0], p[1]);
    if (!Tools.scaleRef && d > 1e-9) Tools.scaleRef = d;
    Tools.ghost = API.XFscale(a, Tools.editScale(a, p));
  } else if (T === 'mirror' && pts.length === 1) Tools.ghost = API.XFmirror(a, p);
}

Tools.onMove = function (E) {
  Tools.cursor = E.raw;
  if (scene && t$('setSnap').checked) {
    var tol = 11 / viewer.scale;
    Tools.snapped = API.snapPoint(scene.items, E.raw[0], E.raw[1], {
      tol: tol,
      layerOn: function (L) { return viewer.layerOn(L); },
      gridStep: t$('setGridSnap').checked ? Tools.gridStep() : 0,
      ref: Tools.pts.length ? Tools.pts[Tools.pts.length - 1] : null
    });
  } else Tools.snapped = null;
  if (!Tools.drag || Tools.drag.mode !== 'move') updateGhost();

  if (Tools.tool === 'quick') {
    var hit = viewer.pick(E.px, E.py);
    Tools.hoverItem = hit;
    var txt = '';
    if (hit) {
      if (hit.center && hit.radius) txt = 'R ' + fmtM(hit.radius) + ' · D ' + fmtM(hit.radius * 2);
      else if (hit.pts && (hit.closed || hit.kind === 'fill') && hit.pts.length > 2)
        txt = '面积 ' + fmtM(API.polyArea(hit.pts)) + unitArea() + ' · 周长 ' + fmtM(API.polyLength(hit.pts, true));
      else if (hit.pts) txt = '长度 ' + fmtM(API.polyLength(hit.pts, hit.closed));
    }
    t$('stMeasure').textContent = txt;
  }

  var d = Tools.drag;
  if (!d) { requestDraw(); return true; }
  var dx = E.px - d.x, dy = E.py - d.y;
  if (d.mode === 'pan') {
    viewer.panX += dx; viewer.panY += dy;
    d.x = E.px; d.y = E.py;
  } else if (d.mode === 'marquee') {
    d.cur = [E.px, E.py];
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
  } else if (d.mode === 'move') {
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) Tools.ghost = API.XFmove(E.wx - d.start[0], E.wy - d.start[1]);
  }
  requestDraw();
  return true;
};

Tools.onUp = function (E) {
  var d = Tools.drag;
  Tools.drag = null;
  if (!d) return (Tools.tool !== 'view');
  if (d.mode === 'marquee') {
    if (!d.moved) {
      if (!d.add) Tools.clearSelection();
    } else {
      var crossing = d.cur[0] < d.x;
      var arr = viewer.pickRect(d.x, d.y, d.cur[0], d.cur[1], crossing);
      var ids = {};
      for (var i = 0; i < arr.length; i++) if (arr[i].ownerId >= 0) ids[arr[i].ownerId] = true;
      Tools.setSelectionIds(Object.keys(ids), d.add);
      toast('已选中 ' + Object.keys(ids).length + ' 个对象');
    }
  } else if (d.mode === 'move' && d.moved && Tools.ghost) {
    var M = Tools.ghost;
    Tools.ghost = null;
    Tools.applyTransformToSelection(M, E.shiftKey, E.shiftKey ? '已复制并移动对象' : '已移动对象');
  }
  Tools.ghost = null;
  requestDraw();
  return true;
};

Tools.onDbl = function () {
  if (Tools.tool === 'pline' || Tools.tool === 'area' || Tools.tool === 'chain') Tools.finishCommand();
  else { viewer.fit(); updateScale(); }
};

/* ---------- keyboard ---------- */
var TOOL_KEYS = {
  v: 'select', h: 'pan', q: 'quick',
  d: 'dist', n: 'chain', k: 'angle', j: 'area', r: 'radius', i: 'coord',
  l: 'line', p: 'pline', b: 'rect', c: 'circle', a: 'arc', o: 'point', t: 'text',
  m: 'move', y: 'copy', u: 'rotate', s: 'scale', x: 'mirror', e: 'erase'
};
/* CAD-style aliases can also be typed into the command bar. */
var TOOL_ALIASES = {
  l: 'line', pl: 'pline', rec: 'rect', rect: 'rect', c: 'circle', cir: 'circle',
  a: 'arc', po: 'point', t: 'text', text: 'text',
  d: 'dist', di: 'dist', dist: 'dist', n: 'chain', chain: 'chain',
  aa: 'area', an: 'angle', ang: 'angle', ra: 'radius', rad: 'radius', id: 'coord',
  m: 'move', co: 'copy', cp: 'copy', ro: 'rotate', sc: 'scale',
  mi: 'mirror', e: 'erase', del: 'erase', v: 'select', sel: 'select', q: 'quick'
};
Tools.onKey = function (e) {
  var key = e.key, tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (key === 'Escape') { e.target.blur(); Tools.cancel(); return true; }
    return false;
  }
  if (e.ctrlKey || e.metaKey) {
    var k = key.toLowerCase();
    if (k === 'z') { e.shiftKey ? Tools.redo() : Tools.undo(); return true; }
    if (k === 'y') { Tools.redo(); return true; }
    if (k === 'a') { Tools.selectAll(); return true; }
    if (k === 's') { Tools.saveDXF(); return true; }
    return false;
  }
  if (key === 'Escape') { Tools.cancel(); return true; }
  if (key === 'Enter') { Tools.finishCommand(); return true; }
  if (key === 'Delete' || key === 'Backspace') { Tools.eraseSelection(); return true; }
  if (key === 'F8') { t$('setOrtho').checked = !t$('setOrtho').checked; toast('正交 ' + (t$('setOrtho').checked ? '开' : '关'), 1500); return true; }
  if (key === 'F3') { t$('setSnap').checked = !t$('setSnap').checked; toast('对象捕捉 ' + (t$('setSnap').checked ? '开' : '关'), 1500); return true; }
  if ((key === 'c' || key === 'C') && Tools.tool === 'pline' && Tools.pts.length >= 3) {
    Tools.closePending = true; Tools.finishCommand(); return true;
  }
  if (key === 'f' || key === 'F') { viewer.fit(); updateScale(); return true; }
  if (key === 'g' || key === 'G') {
    t$('tGrid').checked = !t$('tGrid').checked;
    viewer.opts.grid = t$('tGrid').checked; requestDraw(); return true;
  }
  if (key === ' ') { Tools.spaceDown = true; return true; }
  if (/^[0-9.,\-]$/.test(key) && Tools.tool !== 'view' && Tools.tool !== 'pan') {
    t$('cmdInput').focus();
    return true;
  }
  if (/^[a-zA-Z]$/.test(key)) {
    var tool = TOOL_KEYS[key.toLowerCase()];
    if (tool) { Tools.setTool(tool); return true; }
  }
  return false;
};
Tools.onKeyUp = function (e) {
  if (e.key === ' ') Tools.spaceDown = false;
};

Tools.undo = function () {
  if (!history.canUndo()) { toast('没有可撤销的操作'); return; }
  history.restore(doc, history.index - 1);
  Tools.clearSelection();
  Tools.pts = []; Tools.step = 0;
  refresh(true);
  toast('已撤销');
};
Tools.redo = function () {
  if (!history.canRedo()) { toast('没有可重做的操作'); return; }
  history.restore(doc, history.index + 1);
  Tools.clearSelection();
  Tools.pts = []; Tools.step = 0;
  refresh(true);
  toast('已重做');
};
Tools.selectAll = function () {
  if (!scene) return;
  var ids = {};
  for (var i = 0; i < scene.items.length; i++) {
    var id = scene.items[i].ownerId;
    if (id >= 0 && viewer.layerOn(scene.items[i].layer)) ids[id] = true;
  }
  Tools.setSelectionIds(Object.keys(ids), false);
  Tools.setTool('select');
  toast('已全选 ' + Object.keys(ids).length + ' 个对象');
};
Tools.saveDXF = function () {
  if (!doc) { toast('没有可保存的图纸'); return; }
  var sel = t$('exportVer');
  var target = sel ? String(sel.value || '') : '';
  var text;
  try {
    text = API.exportDXF(sourceText || '', doc, { version: target || undefined, strict: true });
  } catch (e) {
    toast('导出失败：' + (e && e.message ? e.message : e), 7000);
    return;
  }
  var name = (fileName || '新建图纸').replace(/\.dxf$/i, '') + '_已编辑.dxf';
  if (downloadBlob(name, text, 'application/dxf')) {
    var label = '';
    if (target) {
      var list = API.DXF_VERSIONS || [];
      for (var i = 0; i < list.length; i++) if (list[i].code === target) label = ' · ' + list[i].label;
    }
    toast('已保存 ' + name + label + '（' + doc.entities.length + ' 个实体）', 4200);
  }
};

/* ---------- property editor panel ---------- */
Tools.updatePropEdit = function () {
  var box = t$('propEdit');
  if (!box) return;
  var n = Tools.selectionCount();
  if (!n) { box.style.display = 'none'; t$('selCount').textContent = ''; return; }
  box.style.display = 'block';
  t$('selCount').textContent = n + ' 个';
  var e = Tools.selectedEntities()[0];
  if (e) {
    t$('editLayer').value = API.s(API.g(e, 8, '0')) || '0';
    var tc = API.g(e, 420);
    var aci = API.g(e, 62);
    t$('editColor').value = tc !== undefined ? 'custom' : (aci === undefined ? 'bylayer' : String(aci));
  }
  t$('btnUndo').disabled = !history.canUndo();
  t$('btnRedo').disabled = !history.canRedo();
};
Tools.applyProps = function () {
  var sel = Tools.selectedEntities();
  if (!sel.length) { toast('请先选择对象'); return; }
  var layer = t$('editLayer').value;
  var color = t$('editColor').value;
  var col = color === 'bylayer' ? 'BYLAYER'
          : color === 'custom' ? { rgb: parseInt(t$('editColorRGB').value.slice(1), 16) }
          : parseInt(color, 10);
  var lwv = t$('editLw').value;
  var props = { layer: layer, color: col, lw: lwv === '' ? null : parseInt(lwv, 10) };
  for (var i = 0; i < sel.length; i++) {
    var t = API.setEntityProps(sel[i], props);
    doc.entities[doc.entities.indexOf(sel[i])] = t;
  }
  commit('已修改 ' + sel.length + ' 个对象的属性');
  toast('属性已应用到 ' + sel.length + ' 个对象');
};

/* ---------- overlay rendering ---------- */
function strokeW(c, v, pts, color, width, dash, closed) {
  if (!pts || pts.length < 2) return;
  c.save();
  c.strokeStyle = color; c.lineWidth = width || 1.4;
  c.setLineDash(dash || []);
  c.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var q = w2sV(pts[i], v);
    if (i === 0) c.moveTo(q[0], q[1]); else c.lineTo(q[0], q[1]);
  }
  if (closed) c.closePath();
  c.stroke();
  c.restore();
}
function arrowHead(c, at, from, color, size) {
  var ang = Math.atan2(at[1] - from[1], at[0] - from[0]);
  var s = size || 8;
  c.save();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(at[0], at[1]);
  c.lineTo(at[0] - s * Math.cos(ang - 0.36), at[1] - s * Math.sin(ang - 0.36));
  c.lineTo(at[0] - s * Math.cos(ang + 0.36), at[1] - s * Math.sin(ang + 0.36));
  c.closePath(); c.fill();
  c.restore();
}
function chip(c, x, y, text, pal, align) {
  c.save();
  c.font = '600 12px "Segoe UI","Microsoft YaHei",Arial,sans-serif';
  var w = c.measureText(text).width + 14, h = 20;
  var bx = align === 'center' ? x - w / 2 : x;
  c.fillStyle = pal.chip;
  if (c.roundRect) { c.beginPath(); c.roundRect(bx, y - h / 2, w, h, 4); c.fill(); }
  else c.fillRect(bx, y - h / 2, w, h);
  c.fillStyle = pal.chipText;
  c.textAlign = 'left'; c.textBaseline = 'middle';
  c.fillText(text, bx + 7, y + 0.5);
  c.restore();
}
function crossMark(c, x, y, color) {
  c.save(); c.strokeStyle = color; c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(x - 7, y); c.lineTo(x + 7, y);
  c.moveTo(x, y - 7); c.lineTo(x, y + 7);
  c.stroke(); c.restore();
}
function snapMarker(c, x, y, type, color) {
  c.save();
  c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2;
  c.beginPath();
  if (type === 'endpoint') c.rect(x - 5, y - 5, 10, 10);
  else if (type === 'midpoint') { c.moveTo(x, y - 6); c.lineTo(x + 6, y + 5); c.lineTo(x - 6, y + 5); c.closePath(); }
  else if (type === 'center') c.arc(x, y, 6, 0, Math.PI * 2);
  else if (type === 'quadrant') { c.moveTo(x, y - 7); c.lineTo(x + 7, y); c.lineTo(x, y + 7); c.lineTo(x - 7, y); c.closePath(); }
  else if (type === 'intersection') { c.moveTo(x - 6, y - 6); c.lineTo(x + 6, y + 6); c.moveTo(x + 6, y - 6); c.lineTo(x - 6, y + 6); }
  else if (type === 'nearest') { c.moveTo(x - 5, y - 5); c.lineTo(x + 5, y + 5); c.lineTo(x + 5, y - 5); c.lineTo(x - 5, y + 5); c.closePath(); }
  else c.rect(x - 4, y - 4, 8, 8);
  if (type === 'endpoint' || type === 'center' || type === 'quadrant' || type === 'intersection') c.stroke();
  else c.fill();
  c.restore();
}

function drawMeasure(c, v, m, pal) {
  var i, a, b, q1, q2, mid, txt;
  if (m.type === 'dist' || m.type === 'chain') {
    var pts = m.chain || m.pts;
    strokeW(c, v, pts, pal.measure, 1.6, [7, 4]);
    for (i = 0; i + 1 < pts.length; i++) {
      a = w2sV(pts[i], v); b = w2sV(pts[i + 1], v);
      arrowHead(c, b, a, pal.measure, 8);
    }
    a = w2sV(pts[0], v); b = w2sV(pts[pts.length - 1], v);
    mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 16];
    chip(c, mid[0], mid[1], m.title, pal, 'center');
    return;
  }
  if (m.type === 'area') {
    var sp = [];
    for (i = 0; i < m.pts.length; i++) sp.push(w2sV(m.pts[i], v));
    c.save();
    c.fillStyle = viewer.theme === 'dark' ? 'rgba(251,191,36,.13)' : 'rgba(180,83,9,.12)';
    c.strokeStyle = pal.measure; c.lineWidth = 1.6; c.setLineDash([6, 4]);
    c.beginPath();
    for (i = 0; i < sp.length; i++) { if (i === 0) c.moveTo(sp[i][0], sp[i][1]); else c.lineTo(sp[i][0], sp[i][1]); }
    c.closePath(); c.fill(); c.stroke();
    c.restore();
    var ct = API.polyCentroid(m.pts), cp = w2sV(ct, v);
    crossMark(c, cp[0], cp[1], pal.measure);
    chip(c, cp[0], cp[1] - 20, 'A=' + m.title + '  P=' +
      (m.detail || '').split('·')[0].replace('周长 ', ''), pal, 'center');
    return;
  }
  if (m.type === 'angle') {
    var o = w2sV(m.pts[0], v), p1 = w2sV(m.pts[1], v), p2 = w2sV(m.pts[2], v);
    strokeW(c, v, [m.pts[0], m.pts[1]], pal.measure, 1.4, [6, 4]);
    strokeW(c, v, [m.pts[0], m.pts[2]], pal.measure, 1.4, [6, 4]);
    var t1 = Math.atan2(p1[1] - o[1], p1[0] - o[0]);
    var t2 = Math.atan2(p2[1] - o[1], p2[0] - o[0]);
    var sweep = t2 - t1;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    c.save(); c.strokeStyle = pal.measure; c.lineWidth = 2;
    c.beginPath(); c.arc(o[0], o[1], 38, t1, t1 + sweep, sweep < 0); c.stroke(); c.restore();
    var tm = t1 + sweep / 2, lp = [o[0] + 56 * Math.cos(tm), o[1] + 56 * Math.sin(tm)];
    chip(c, lp[0], lp[1], m.title, pal, 'center');
    return;
  }
  if (m.type === 'radius') {
    var cc = w2sV(m.center, v);
    var rr = m.radius * v.scale;
    c.save(); c.strokeStyle = pal.measure; c.lineWidth = 1.6; c.setLineDash([7, 4]);
    c.beginPath(); c.moveTo(cc[0], cc[1]);
    c.lineTo(cc[0] + rr * 0.707, cc[1] - rr * 0.707); c.stroke(); c.restore();
    crossMark(c, cc[0], cc[1], pal.measure);
    arrowHead(c, [cc[0] + rr * 0.707, cc[1] - rr * 0.707], cc, pal.measure, 9);
    chip(c, cc[0] + rr * 0.707, cc[1] - rr * 0.707 - 16, m.title, pal);
    return;
  }
  if (m.type === 'coord') {
    var q = w2sV(m.pts[0], v);
    crossMark(c, q[0], q[1], pal.measure);
    chip(c, q[0] + 10, q[1] - 14, m.title, pal);
  }
}

Tools.overlay = function (c, v) {
  var pal = ovColors(), i, j;
  /* selection highlight + grips */
  var ids = Tools.selection;
  if (Tools.hasSelection()) {
    var its = viewer.itemsForIds(ids);
    c.save();
    c.strokeStyle = pal.sel; c.lineWidth = 2; c.setLineDash([7, 4]);
    for (i = 0; i < its.length; i++) {
      var it = its[i];
      if (it.pts && it.pts.length > 1) {
        c.beginPath();
        for (j = 0; j < it.pts.length; j++) {
          var q = w2sV(it.pts[j], v);
          if (j === 0) c.moveTo(q[0], q[1]); else c.lineTo(q[0], q[1]);
        }
        c.stroke();
      }
      if (it.pos) {
        var pq = w2sV(it.pos, v);
        c.strokeRect(pq[0] - 6, pq[1] - 6, 12, 12);
      }
      var corners = it.corners || (it.pts && it.pts.length <= 4 ? it.pts : []);
      for (j = 0; j < corners.length && j < 12; j++) {
        var gq = w2sV(corners[j], v);
        c.setLineDash([]);
        c.fillStyle = pal.sel;
        c.fillRect(gq[0] - 3, gq[1] - 3, 6, 6);
        c.setLineDash([7, 4]);
      }
    }
    c.restore();
  }
  /* hover highlight for quick measure */
  if (Tools.tool === 'quick' && Tools.hoverItem) {
    var hi = Tools.hoverItem;
    strokeW(c, v, hi.pts, pal.snap, 2.6, [5, 3], hi.closed);
  }
  /* ghost transform preview */
  if (Tools.ghost && Tools.hasSelection() && !Tools.drag) {
    var gi = viewer.itemsForIds(ids), M = Tools.ghost;
    c.save(); c.strokeStyle = pal.ghost; c.lineWidth = 1.6; c.setLineDash([6, 4]);
    for (i = 0; i < gi.length; i++) {
      var g = gi[i];
      if (g.pts && g.pts.length > 1) {
        c.beginPath();
        for (j = 0; j < g.pts.length; j++) {
          var pp = [M.a * g.pts[j][0] + M.b * g.pts[j][1] + M.tx,
                    M.c * g.pts[j][0] + M.d * g.pts[j][1] + M.ty];
          var qq = w2sV(pp, v);
          if (j === 0) c.moveTo(qq[0], qq[1]); else c.lineTo(qq[0], qq[1]);
        }
        c.stroke();
      }
    }
    c.restore();
  }
  /* committed measurements */
  for (i = 0; i < Tools.measurements.length; i++) drawMeasure(c, v, Tools.measurements[i], pal);
  /* live preview */
  Tools.drawPreview(c, v, pal);
  /* marquee */
  var d = Tools.drag;
  if (d && d.mode === 'marquee' && d.moved) {
    var x0 = Math.min(d.x, d.cur[0]), y0 = Math.min(d.y, d.cur[1]);
    var w = Math.abs(d.cur[0] - d.x), h = Math.abs(d.cur[1] - d.y);
    c.save();
    c.fillStyle = d.cur[0] < d.x ? 'rgba(96,165,250,.12)' : 'rgba(74,222,128,.12)';
    c.strokeStyle = d.cur[0] < d.x ? pal.box : '#4ADE80';
    c.lineWidth = 1.2; c.setLineDash(d.cur[0] < d.x ? [6, 4] : []);
    c.fillRect(x0, y0, w, h); c.strokeRect(x0, y0, w, h);
    c.restore();
  }
  /* snap marker */
  if (Tools.snapped && Tools.tool !== 'view' && Tools.tool !== 'pan') {
    var sq = w2sV(Tools.snapped.p, v);
    snapMarker(c, sq[0], sq[1], Tools.snapped.type, pal.snap);
  }
};

Tools.drawPreview = function (c, v, pal) {
  var T = Tools.tool, p = Tools.currentPoint(), pts = Tools.pts, i;
  if (T === 'view' || T === 'pan' || T === 'select' || T === 'quick' || !Tools.cursor) return;
  var col = pal.measure, dash = [6, 4];
  if (pts.length) {
    if (T === 'line' || T === 'pline' || T === 'chain' || T === 'dist' || T === 'area') {
      var chain = pts.concat([p]);
      strokeW(c, v, chain, col, 1.5, dash, false);
      if (T === 'dist' && chain.length === 2) {
        var a = w2sV(chain[0], v), b = w2sV(chain[1], v);
        chip(c, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 16,
             fmtM(API.dist2(chain[0][0], chain[0][1], chain[1][0], chain[1][1])) + unitSuffix(), pal, 'center');
      }
      if (T === 'area' && chain.length >= 3) {
        var tmp = chain.slice();
        c.save(); c.fillStyle = viewer.theme === 'dark' ? 'rgba(251,191,36,.10)' : 'rgba(180,83,9,.09)';
        c.beginPath();
        for (i = 0; i < tmp.length; i++) { var tq = w2sV(tmp[i], v); if (i === 0) c.moveTo(tq[0], tq[1]); else c.lineTo(tq[0], tq[1]); }
        c.closePath(); c.fill(); c.restore();
      }
    }
    if (T === 'rect') {
      strokeW(c, v, [[pts[0][0], pts[0][1]], [p[0], pts[0][1]], [p[0], p[1]],
                     [pts[0][0], p[1]]], col, 1.5, dash, true);
    }
    if (T === 'circle') {
      var r = API.dist2(pts[0][0], pts[0][1], p[0], p[1]);
      var cc = w2sV(pts[0], v);
      c.save(); c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash(dash);
      c.beginPath(); c.arc(cc[0], cc[1], r * v.scale, 0, Math.PI * 2); c.stroke(); c.restore();
      strokeW(c, v, [pts[0], p], col, 1, [3, 4]);
    }
    if (T === 'arc' && pts.length >= 2) {
      var tri = pts.concat([p]);
      var cf = API.circleFrom3Points(tri[0], tri[1], tri[2]);
      if (cf) {
        var ac = w2sV(cf.center, v), ar = cf.radius * v.scale;
        c.save(); c.strokeStyle = col; c.lineWidth = 1.6; c.setLineDash(dash);
        c.beginPath();
        c.arc(ac[0], ac[1], ar, -cf.a0 * Math.PI / 180, -cf.a1 * Math.PI / 180, true);
        c.stroke(); c.restore();
      } else strokeW(c, v, tri, col, 1.5, dash);
    }
    if (T === 'angle') {
      strokeW(c, v, pts.concat([p]), col, 1.5, dash);
    }
    if (T === 'move' || T === 'copy' || T === 'rotate' || T === 'scale' || T === 'mirror') {
      strokeW(c, v, [pts[0], p], col, 1.4, dash);
    }
    /* base / committed point markers */
    for (i = 0; i < pts.length; i++) {
      var mp = w2sV(pts[i], v);
      c.save(); c.fillStyle = col; c.fillRect(mp[0] - 2.5, mp[1] - 2.5, 5, 5); c.restore();
    }
  }
  /* crosshair for point tools */
  if (T === 'point' || T === 'coord' || T === 'text' || T === 'radius') {
    var cp = w2sV(p, v);
    crossMark(c, cp[0], cp[1], col);
    if (T === 'text') chip(c, cp[0] + 10, cp[1] - 14, Tools.textValue, pal);
  }
};

/* ---------- UI binding ---------- */
function fillColorSelect(el, includeCustom) {
  var html = '<option value="bylayer">随层 ByLayer</option>';
  var keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 50, 70, 90, 110, 140, 170, 200, 220, 250, 255];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var hex = API.aciToRgb(k, true);
    html += '<option value="' + k + '">' + k + ' · ' + (ACI_NAMES[k] || '') +
            ' ' + String(hex).toUpperCase() + '</option>';
  }
  html += '<option value="custom">自定义颜色…</option>';
  el.innerHTML = html;
}
function fillLayerSelect(el) {
  var keep = el.value;
  var names = Object.keys(doc.tables.layer).sort(), html = '';
  for (var i = 0; i < names.length; i++) {
    html += '<option value="' + esc(names[i]) + '">' + esc(names[i]) + '</option>';
  }
  el.innerHTML = html;
  if (keep && names.indexOf(keep) >= 0) el.value = keep;
  return names;
}
Tools.syncLayerSelects = function () {
  if (!doc) return;
  fillLayerSelect(t$('setLayer'));
  fillLayerSelect(t$('editLayer'));
};
function fillLwSelect(el) {
  var vals = [['', '随层'], [-3, '默认'], [5, '0.05 mm'], [9, '0.09 mm'], [13, '0.13 mm'],
              [18, '0.18 mm'], [25, '0.25 mm'], [35, '0.35 mm'], [50, '0.50 mm'],
              [70, '0.70 mm'], [100, '1.00 mm'], [140, '1.40 mm'], [200, '2.00 mm']];
  var html = '';
  for (var i = 0; i < vals.length; i++) html += '<option value="' + vals[i][0] + '">' + vals[i][1] + '</option>';
  el.innerHTML = html;
}

Tools.bind = function () {
  var rail = t$('toolrail');
  rail.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-tool]') : null;
    if (!b) return;
    Tools.setTool(b.dataset.tool);
  });
  fillColorSelect(t$('setColor'));
  fillColorSelect(t$('editColor'));
  fillLayerSelect(t$('setLayer'));
  fillLayerSelect(t$('editLayer'));
  fillLwSelect(t$('setLw'));
  fillLwSelect(t$('editLw'));

  t$('btnNewLayer').onclick = function () {
    var name = window.prompt('新图层名称：', '新图层' + (Object.keys(doc.tables.layer).length + 1));
    if (!name) return;
    name = name.trim();
    if (!name) return;
    API.ensureLayer(doc, name, 7);
    fillLayerSelect(t$('setLayer'));
    fillLayerSelect(t$('editLayer'));
    t$('setLayer').value = name;
    buildLayerPanel();
    toast('已创建图层「' + name + '」，保存 DXF 时会写入图层表');
  };
  t$('setColor').onchange = function () {
    if (this.value === 'custom') t$('setColorRGB').click();
  };
  t$('editColor').onchange = function () {
    if (this.value === 'custom') t$('editColorRGB').click();
  };
  t$('setLayer').onchange = function () { buildLayerPanel(); };
  t$('btnApplyProps').onclick = Tools.applyProps;
  t$('btnEraseSel').onclick = Tools.eraseSelection;
  t$('btnSelectAll').onclick = Tools.selectAll;

  t$('cmdCancel').onclick = function () { Tools.setTool('select'); };
  t$('cmdInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { Tools.onCommand(this.value); this.value = ''; e.preventDefault(); }
    if (e.key === 'Escape') { this.value = ''; this.blur(); Tools.cancel(); e.preventDefault(); }
  });
  t$('btnClearMeasure').onclick = clearMeasures;
  t$('btnCsv').onclick = Tools.measureCSV;
  t$('measureList').addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (!del) return;
    var id = parseInt(del.dataset.del, 10);
    Tools.measurements = Tools.measurements.filter(function (m) { return m.id !== id; });
    buildMeasureList(); requestDraw();
  });
  t$('btnUndo').onclick = Tools.undo;
  t$('btnRedo').onclick = Tools.redo;
  t$('btnSaveDxf').onclick = Tools.saveDXF;

  t$('helpModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });
  Tools.setTool('view');
  Tools.updatePropEdit();
  buildMeasureList();
};

API.Tools = Tools;
/* Read-only accessors, handy for automation and for debugging in devtools. */
API.getViewer = function () { return viewer; };
API.getScene = function () { return scene; };
API.getDoc = function () { return doc; };
