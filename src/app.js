/* ==========================================================================
 * UI wiring: file loading, layer panel, options, picking, export.
 * Everything runs locally in the browser; no network requests are made.
 * ========================================================================== */

function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var UNITS = {
  0: '无单位', 1: '英寸 in', 2: '英尺 ft', 3: '英里 mi', 4: '毫米 mm',
  5: '厘米 cm', 6: '米 m', 7: '千米 km', 8: '微英寸', 9: '密耳',
  10: '码 yd', 11: '埃', 12: '纳米 nm', 13: '微米 um', 14: '分米 dm',
  15: '十米', 16: '百米', 17: '亿米', 18: '天文单位', 19: '光年', 20: '秒差距'
};
var VERSIONS = {
  AC1006: 'R10', AC1009: 'R12', AC1012: 'R13', AC1014: 'R14',
  AC1015: 'AutoCAD 2000', AC1018: '2004', AC1021: '2007',
  AC1024: '2010', AC1027: '2013', AC1032: '2018'
};

/* Export-format picker: "same as source" plus every modern target. */
function fillExportVersions() {
  var sel = $('exportVer');
  if (!sel || typeof API.DXF_VERSIONS === 'undefined') return;
  var list = API.DXF_VERSIONS, html = '<option value="">与原图同版本</option>';
  for (var i = 0; i < list.length; i++) {
    html += '<option value="' + list[i].code + '">' + list[i].label + '</option>';
  }
  sel.innerHTML = html;
}

var viewer = null, scene = null, doc = null;
var fileName = '', fileSize = 0, fileEnc = '', parseMs = 0;
var layerToggle = {}, hideOff = false;
var toastTimer = null;
var sourceText = '';      /* original DXF text, kept for lossless DXF export */
var history = null;       /* undo/redo stack of entity snapshots */
/* BLANK_DXF is defined in src/blankdxf.js (a complete, openable template). */

function toast(msg, ms) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 3200);
}

function fmtSize(b) {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function num(v, digits) {
  if (!isFinite(v)) return '—';
  return (Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0))
    ? v.toExponential(3) : v.toFixed(digits === undefined ? 3 : digits);
}

/* ---------- decoding ---------- */
function decodeBuffer(buf) {
  var bytes = new Uint8Array(buf), head = '', i;
  for (i = 0; i < Math.min(22, bytes.length); i++) head += String.fromCharCode(bytes[i]);
  if (head.indexOf('AutoCAD Binary DXF') === 0) {
    throw new Error('检测到二进制 DXF。请在 CAD 中用 DXFOUT 另存为 ASCII DXF 后重试。');
  }
  var skip = (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(skip)),
             enc: skip ? 'UTF-8 (BOM)' : 'UTF-8' };
  } catch (e) {
    try { return { text: new TextDecoder('gbk').decode(bytes), enc: 'GBK / ANSI' }; }
    catch (e2) { return { text: new TextDecoder('windows-1252').decode(bytes), enc: 'Latin-1' }; }
  }
}

function readFile(file) {
  if (!file) return;
  if (!/\.dxf$/i.test(file.name)) { toast('请选择 .dxf 文件'); return; }
  $('stMsg').textContent = '正在读取 ' + file.name + ' ...';
  file.arrayBuffer().then(function (buf) {
    var d = decodeBuffer(buf);
    loadText(d.text, file.name, file.size, d.enc);
  }).catch(function (err) {
    $('stMsg').textContent = '';
    toast('读取失败：' + err.message, 6000);
  });
}

function loadText(text, name, size, enc) {
  var t0 = performance.now();
  try {
    doc = API.parse(text);
    sourceText = text;
    API.assignEntityIds(doc);
    history = new API.History(40);
    history.reset(doc);
    scene = null;
    rebuildScene(false);
    parseMs = performance.now() - t0;
    fileName = name; fileSize = size; fileEnc = enc;
    $('fileLabel').textContent = name;
    $('dropzone').classList.add('hidden');
    buildLayerPanel();
    buildStats();
    buildFileInfo();
    clearProps();
    updateStatus();
    Tools.clearSelection();
    Tools.measurements = [];
    Tools.syncLayerSelects();
    Tools.updatePropEdit();
    buildMeasureList();
    var skipped = Object.keys(scene.stats.skipped).length;
    toast('已加载 ' + scene.stats.topLevel + ' 个实体，生成 ' + scene.items.length + ' 个绘制图元' +
          (skipped ? '（' + skipped + ' 类对象未渲染，见左侧）' : ''), 4200);
    $('stMsg').textContent = '解析完成 ' + parseMs.toFixed(0) + ' ms';
  } catch (err) {
    $('stMsg').textContent = '';
    toast('解析失败：' + err.message, 7000);
    console.error(err);
  }
}

function rebuildScene(keepView) {
  scene = API.buildScene(doc, { dark: viewer.theme === 'dark' });
  viewer.setScene(scene, !!keepView);
  applyVisibility();
  viewer.draw();
}

/* Called after every document mutation: re-expand geometry and refresh all
 * panels while keeping the current pan/zoom. */
function refresh(keepView) {
  if (!doc) return;
  rebuildScene(keepView === undefined ? true : keepView);
  buildLayerPanel();
  buildStats();
  buildFileInfo();
  updateStatus();
  Tools.syncLayerSelects();
  Tools.updatePropEdit();
  viewer.draw();
}

/* Let the user start drawing even without opening a DXF first. */
function startBlankDrawing() {
  if (scene) return;
  if (!doc) {
    doc = API.parse(BLANK_DXF);
      doc.insunits = 4;
    API.assignEntityIds(doc);
    history = new API.History(40);
    history.reset(doc);
  }
  fileName = '新建图纸.dxf'; fileSize = 0; fileEnc = 'UTF-8';
  /* Keep the template as the export base so saving rewrites only ENTITIES:
   * the tables / block records / root dictionary stay intact and the result
   * is a DXF AutoCAD can open. */
  sourceText = BLANK_DXF;
  $('fileLabel').textContent = '新建图纸（未保存）';
  $('dropzone').classList.add('hidden');
  rebuildScene(false);
  buildLayerPanel(); buildStats(); buildFileInfo(); updateStatus();
  Tools.syncLayerSelects();
  toast('已创建空白图纸，可以开始绘制；完成后点「保存 DXF」', 4200);
}

function applyVisibility() {
  if (!scene) return;
  var names = scene.stats.byLayerSorted;
  for (var i = 0; i < names.length; i++) {
    var nm = names[i], L = doc.tables.layer[nm];
    var off = hideOff && L && (L.off || L.frozen);
    viewer.layerVisible[nm] = (layerToggle[nm] !== false) && !off;
  }
}

/* ---------- panels ---------- */
function buildLayerPanel() {
  var names = scene.stats.byLayerSorted, html = '', i;
  for (i = 0; i < names.length; i++) {
    var nm = names[i];
    var L = doc.tables.layer[nm] || {};
    var col = colorByLayer(doc, nm, viewer.theme === 'dark');
    var badge = [];
    if (L.off) badge.push('关');
    if (L.frozen) badge.push('冻');
    var checked = layerToggle[nm] !== false ? ' checked' : '';
    html += '<label class="layer-row' + (L.off || L.frozen ? ' off' : '') + '" data-name="' + esc(nm) + '">' +
      '<input type="checkbox" data-layer="' + esc(nm) + '"' + checked + '>' +
      '<span class="swatch" style="background:' + col + '"></span>' +
      '<span class="layer-name" title="' + esc(nm) + '">' + esc(nm) + '</span>' +
      (badge.length ? '<span class="layer-badge">' + badge.join('/') + '</span>' : '') +
      '<span class="layer-count">' + (scene.stats.byLayer[nm] || 0) + '</span></label>';
  }
  $('layerList').innerHTML = html || '<div class="prop-empty" style="padding:12px">无图层</div>';
  $('layerCount').textContent = names.length + ' 层';
}

function buildStats() {
  var by = scene.stats.byType, keys = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
  var max = keys.length ? by[keys[0]] : 1, html = '';
  for (var i = 0; i < keys.length; i++) {
    var v = by[keys[i]];
    html += '<div class="stat-row"><span class="k">' + esc(keys[i]) + '</span>' +
      '<span class="bar" style="width:' + Math.max(2, Math.round(v / max * 58)) + 'px"></span>' +
      '<span class="v">' + v + '</span></div>';
  }
  $('statList').innerHTML = html || '<div class="stat-row"><span class="k">（空）</span></div>';
  $('statTotal').textContent = scene.stats.topLevel + ' 实体';
  var sk = Object.keys(scene.stats.skipped);
  if (sk.length) {
    var parts = sk.map(function (k) { return esc(k) + ' ×' + scene.stats.skipped[k]; });
    $('skipNote').innerHTML = '<strong>未渲染类型（已保留计数）</strong><br>' + parts.join('、') +
      '<br>多为 ACIS 三维实体、光栅像素或代理对象，DXF 中不含可绘制的二维几何。';
    $('skipNote').style.display = 'block';
  } else {
    $('skipNote').style.display = 'none';
  }
}

function buildFileInfo() {
  var b = scene.bounds;
  var ver = (doc.version || '').toUpperCase();
  var rows = [
    ['文件名', esc(fileName || '—')],
    ['文件大小', fmtSize(fileSize)],
    ['文本编码', esc(fileEnc || '—')],
    ['DXF 版本', esc((VERSIONS[ver] || ver || '未声明')) + (ver ? ' (' + esc(ver) + ')' : '')],
    ['图纸单位', esc(UNITS[doc.insunits] || ('代码 ' + doc.insunits))],
    ['SECTION 段', esc(doc.sectionNames.join(', ') || '—')],
    ['顶层实体', scene.stats.topLevel],
    ['绘制图元', scene.items.length],
    ['图层 / 块定义', scene.stats.byLayerSorted.length + ' / ' + Object.keys(doc.blocks).length],
    ['块引用展开', scene.stats.blockInserts],
    ['坐标范围', 'X ' + num(b.minX, 1) + ' ~ ' + num(b.maxX, 1) + '<br>Y ' + num(b.minY, 1) + ' ~ ' + num(b.maxY, 1)],
    ['解析耗时', parseMs ? parseMs.toFixed(0) + ' ms' : '—']
  ];
  var html = '';
  for (var i = 0; i < rows.length; i++) html += '<div class="k">' + rows[i][0] + '</div><div class="v">' + rows[i][1] + '</div>';
  $('fileInfo').innerHTML = html;
}

/* Names are intentionally prefixed: snap.js exports polyLength/polyArea via
 * API, and same-scope function declarations would otherwise be overwritten
 * by hoisting. Here we only need open-chain lengths for the property table. */
function uiPolyLength(pts) {
  var L = 0;
  for (var i = 1; i < pts.length; i++) {
    var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    L += Math.sqrt(dx * dx + dy * dy);
  }
  return L;
}
function uiPolyArea(pts) {
  var a = 0;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(a / 2);
}

function showProps(it) {
  /* In tool modes the selection highlight is drawn by Tools.overlay();
   * avoid painting the same object twice. */
  viewer.selected = (Tools.tool === 'view') ? it : null;
  viewer.draw();
  if (!it) { clearProps(); return; }
  var rows = [];
  function row(k, v) { rows.push('<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'); }
  row('类型', esc(it.type));
  row('图层', esc(it.layer));
  row('颜色', '<span class="swatch" style="display:inline-block;vertical-align:-2px;background:' +
      (it.color === '__BG__' ? '#FFFFFF' : it.color) + '"></span> ' + esc(it.color === '__BG__' ? '背景遮罩' : it.color));
  row('线型 / 线宽', esc(it.linetype) + ' / ' + (it.lw / 100).toFixed(2) + ' mm');
  row('句柄', esc(it.handle || '—'));
  if (it.pts && it.pts.length) {
    row('顶点数', it.pts.length);
    row('起点', num(it.pts[0][0]) + ', ' + num(it.pts[0][1]));
    row('终点', num(it.pts[it.pts.length - 1][0]) + ', ' + num(it.pts[it.pts.length - 1][1]));
    row('长度', num(uiPolyLength(it.pts)) + (it.closed ? ' (闭合)' : ''));
    if (it.kind === 'fill') row('面积', num(uiPolyArea(it.pts)));
  }
  if (it.pos) row('位置', num(it.pos[0]) + ', ' + num(it.pos[1]));
  if (it.text) row('文字', esc(it.text.length > 160 ? it.text.slice(0, 160) + '…' : it.text));
  if (it.height) row('字高', num(it.height));
  var raw = it.source && it.source.pairs ? it.source.pairs : [];
  var rawHtml = '';
  for (var i = 0; i < Math.min(raw.length, 120); i++) {
    rawHtml += esc(raw[i][0]) + '\t' + esc(raw[i][1]) + '\n';
  }
  if (raw.length > 120) rawHtml += '… 共 ' + raw.length + ' 组\n';
  $('propBox').innerHTML =
    '<div class="prop-title"><span class="swatch" style="background:' + (it.color === '__BG__' ? '#FFFFFF' : it.color) + '"></span>' +
    esc(it.type) + ' 对象</div>' +
    '<table class="prop-table">' + rows.join('') + '</table>' +
    (rawHtml ? '<details class="raw"><summary>查看原始 DXF 组码</summary><pre class="raw">' + esc(rawHtml) + '</pre></details>' : '');
  $('propHint').textContent = '已选中';
}
function clearProps() {
  if (viewer) { viewer.selected = null; }
  $('propBox').innerHTML = '<div class="prop-empty">单击图形中的任意对象，查看其 DXF 属性与原始组码。</div>';
  $('propHint').textContent = '';
}

function updateStatus() {
  if (!scene) return;
  $('stEntities').textContent = scene.stats.topLevel;
  $('stItems').textContent = scene.items.length;
  $('stLayers').textContent = scene.stats.byLayerSorted.length;
  $('stUnit').textContent = '单位 ' + (UNITS[doc.insunits] || '未知');
  updateScale();
}
function updateScale() {
  if (!viewer || !scene) return;
  $('stScale').textContent = num(viewer.scale, 3) + ' px/单位';
}
function paintEmpty() {
  if (!viewer) return;
  var d = viewer.dpr, c = viewer.c;
  c.setTransform(d, 0, 0, d, 0, 0);
  c.fillStyle = API.THEMES[viewer.theme].bg;
  c.fillRect(0, 0, c.canvas.width / d, c.canvas.height / d);
}

/* ---------- events ---------- */
var drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () { drawPending = false; viewer.draw(); });
  } else {
    setTimeout(function () { drawPending = false; viewer.draw(); }, 16);
  }
}

function bindEvents() {
  var cv = $('cv');
  $('btnOpen').onclick = $('btnDropOpen').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (e) {
    if (e.target.files && e.target.files[0]) readFile(e.target.files[0]);
    e.target.value = '';
  };
  var dz = $('dropzone');
  ['dragenter', 'dragover'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
  });
  window.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  $('btnFit').onclick = function () { viewer.fit(); updateScale(); };
  $('btnTheme').onclick = function () {
    viewer.setTheme(viewer.theme === 'dark' ? 'light' : 'dark');
    $('btnTheme').textContent = viewer.theme === 'dark' ? '浅色背景' : '深色背景';
    document.querySelector('.stage').style.background = API.THEMES[viewer.theme].bg;
    if (scene) {
      rebuildScene(true);      /* ACI 7 must flip with the background */
      buildLayerPanel();
    } else paintEmpty();
  };
  $('btnPng').onclick = function (e) {
    if (!scene) { toast('请先打开一个 DXF 文件'); return; }
    var url = viewer.exportPNG(!e.shiftKey, 2);
    if (!url) { toast('导出失败'); return; }
    var a = document.createElement('a');
    a.href = url;
    a.download = (fileName || 'drawing').replace(/\.dxf$/i, '') + (e.shiftKey ? '_当前视图' : '_整图') + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast(e.shiftKey ? '已导出当前视图 PNG' : '已导出整图 PNG');
  };
  $('btnHelp').onclick = function () { $('helpModal').classList.add('show'); };
  $('btnHelpClose').onclick = function () { $('helpModal').classList.remove('show'); };
  $('helpModal').onclick = function (e) { if (e.target === this) this.classList.remove('show'); };

  $('layerList').addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.layer) {
      layerToggle[t.dataset.layer] = t.checked;
      applyVisibility(); viewer.draw();
    }
  });
  $('layerSearch').addEventListener('input', function () {
    var q = this.value.toLowerCase();
    var rows = $('layerList').querySelectorAll('.layer-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.display = rows[i].dataset.name.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    }
  });
  $('btnAllOn').onclick = function () { setAllLayers(true); };
  $('btnAllOff').onclick = function () { setAllLayers(false); };

  var toggles = [
    ['tLineweight', 'lineweight'], ['tLinetype', 'linetype'], ['tText', 'text'],
    ['tFill', 'fill'], ['tPoints', 'points'], ['tGrid', 'grid'], ['tMono', 'monochrome']
  ];
  toggles.forEach(function (pair) {
    $(pair[0]).onchange = function () { viewer.opts[pair[1]] = this.checked; viewer.draw(); };
  });
  $('tHideOff').onchange = function () {
    hideOff = this.checked; applyVisibility(); viewer.draw();
  };

  var dragging = false, moved = false, lastX = 0, lastY = 0, toolsHandled = false;

  function evObj(e, type) {
    var r = cv.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var w = viewer.s2w(px, py);
    return { type: type, px: px, py: py, wx: w[0], wy: w[1], raw: [w[0], w[1]],
             button: e.button, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey };
  }
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  function capture(e) {
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  }
  cv.addEventListener('pointerdown', function (e) {
    var E = evObj(e, 'down');
    toolsHandled = Tools.onDown(E);
    if (toolsHandled) {
      if (e.button === 0 || e.button === 1) capture(e);
      return;
    }
    if (e.button !== 0) return;
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    capture(e);
    cv.classList.add('dragging');
  });
  cv.addEventListener('pointermove', function (e) {
    var E = evObj(e, 'move');
    if (scene) $('stCoord').textContent = num(E.wx, 2) + ', ' + num(E.wy, 2);
    if (toolsHandled) { Tools.onMove(E); return; }
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    lastX = e.clientX; lastY = e.clientY;
    viewer.panX += dx; viewer.panY += dy;
    requestDraw();
  });
  cv.addEventListener('pointerup', function (e) {
    var E = evObj(e, 'up');
    if (toolsHandled) { Tools.onUp(E); toolsHandled = false; return; }
    dragging = false;
    cv.classList.remove('dragging');
    if (moved || !scene) return;
    var it = viewer.pick(E.px, E.py);
    showProps(it);
  });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!scene) return;
    var r = cv.getBoundingClientRect();
    var factor = Math.exp(-e.deltaY * 0.0015);
    viewer.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    updateScale();
  }, { passive: false });
  cv.addEventListener('dblclick', function () { Tools.onDbl(); });

  window.addEventListener('resize', function () {
    viewer.resize();
    if (scene) viewer.draw(); else paintEmpty();
  });
  /* The stage can change size without a window resize (sidebar toggles,
   * media queries, font loading, first layout pass).  Keep the backing store
   * in sync so the drawing can never spill into neighbouring panels. */
  function stageResized() {
    var r = cv.getBoundingClientRect();
    var w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h) return;
    if (w === Math.round(viewer.W) && h === Math.round(viewer.H)) return;
    viewer.resize();
    if (scene) viewer.draw(); else paintEmpty();
  }
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(stageResized).observe($('stage')); }
    catch (err) { /* older browsers */ }
  }
  window.addEventListener('keydown', function (e) {
    if (Tools.onKey(e)) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { Tools.onKeyUp(e); });
}

function setAllLayers(on) {
  var names = scene ? scene.stats.byLayerSorted : [];
  for (var i = 0; i < names.length; i++) layerToggle[names[i]] = on;
  var boxes = $('layerList').querySelectorAll('input[data-layer]');
  for (var j = 0; j < boxes.length; j++) boxes[j].checked = on;
  applyVisibility(); viewer.draw();
}

function init() {
  viewer = new API.Viewer($('cv'));
  viewer.resize();
  doc = API.parse(BLANK_DXF);
  doc.insunits = 4;
  API.assignEntityIds(doc);
  history = new API.History(40);
  history.reset(doc);
  viewer.overlayFn = function (c, v) { Tools.overlay(c, v); };
  fillExportVersions();
  paintEmpty();
  bindEvents();
  Tools.bind();
  var d = window.__DXF_INLINE__;
  if (d && d.base64) {
    /* Raw bytes embedded for non-UTF-8 (GBK/ANSI) drawings. */
    try {
      var bin = atob(d.base64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var dec = decodeBuffer(bytes.buffer);
      loadText(dec.text, d.name || '内嵌 DXF 图纸', d.size || 0, dec.enc);
    } catch (err) {
      toast('内嵌图纸解码失败：' + err.message, 7000);
    }
  } else if (d && d.text) {
    loadText(d.text, d.name || '内嵌 DXF 图纸', d.size || 0, d.encoding || '内嵌');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
