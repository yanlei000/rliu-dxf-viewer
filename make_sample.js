#!/usr/bin/env node
/* Generate a coverage-test ASCII DXF containing most common entity types,
 * all color modes, block inheritance, hatch, dimension and OCS transforms. */
'use strict';
const fs = require('fs');
const path = require('path');

const L = [];
function P(c, v) { L.push(String(c), String(v)); }
function E(type, layer, color, extra) {
  P(0, type); P(8, layer);
  if (color !== undefined && color !== null) P(62, color);
  (extra || []).forEach(pair => P(pair[0], pair[1]));
}
function sec(name) { P(0, 'SECTION'); P(2, name); }

/* ---------------- HEADER ---------------- */
sec('HEADER');
P(9, '$ACADVER'); P(1, 'AC1015');
P(9, '$INSUNITS'); P(70, 4);
P(9, '$LTSCALE'); P(40, 1);
P(9, '$EXTMIN'); P(10, 0); P(20, 0); P(30, 0);
P(9, '$EXTMAX'); P(10, 300); P(20, 200); P(30, 0);
P(0, 'ENDSEC');

/* ---------------- TABLES ---------------- */
sec('TABLES');
P(0, 'TABLE'); P(2, 'LTYPE'); P(70, 3);
P(0, 'LTYPE'); P(2, 'CONTINUOUS'); P(70, 0); P(3, 'Solid line'); P(72, 65); P(73, 0); P(40, 0);
P(0, 'LTYPE'); P(2, 'DASHED'); P(70, 0); P(3, '__ __ __'); P(72, 65); P(73, 2); P(40, 0.75); P(49, 0.5); P(49, -0.25);
P(0, 'LTYPE'); P(2, 'CENTER'); P(70, 0); P(3, '____ . ____'); P(72, 65); P(73, 4); P(40, 2.0);
P(49, 1.25); P(49, -0.25); P(49, 0.25); P(49, -0.25);
P(0, 'ENDTAB');

P(0, 'TABLE'); P(2, 'LAYER'); P(70, 11);
const layers = [
  ['0', 7, 0, 'CONTINUOUS', null],
  ['RED', 1, 0, 'CONTINUOUS', null],
  ['YELLOW', 2, 0, 'CONTINUOUS', null],
  ['GREEN', 3, 0, 'CONTINUOUS', null],
  ['CYAN', 4, 0, 'CONTINUOUS', null],
  ['BLUE', 5, 0, 'CONTINUOUS', null],
  ['MAGENTA', 6, 0, 'CONTINUOUS', null],
  ['GRAY', 8, 0, 'DASHED', null],
  ['AXIS', 9, 0, 'CENTER', null],
  ['HIDDEN', -8, 1, 'DASHED', null],       // negative color = layer off
  ['TRUECOLOR', 7, 0, 'CONTINUOUS', 0x3399FF]
];
layers.forEach(([name, color, flag, lt, tc]) => {
  P(0, 'LAYER'); P(2, name); P(70, flag); P(62, color); P(6, lt); P(370, 25);
  if (tc !== null) P(420, tc);
});
P(0, 'ENDTAB');

P(0, 'TABLE'); P(2, 'STYLE'); P(70, 1);
P(0, 'STYLE'); P(2, 'STANDARD'); P(70, 0); P(40, 0); P(41, 1); P(50, 0); P(71, 0); P(1, 'txt'); P(3, 'txt.shx'); P(4, '');
P(0, 'ENDTAB');

/* A DXF without an APPID table is rejected outright by AutoCAD, so register
 * the ACAD application id that every AcDbEntity relies on. */
P(0, 'TABLE'); P(2, 'APPID'); P(70, 1);
P(0, 'APPID'); P(2, 'ACAD'); P(70, 0);
P(0, 'ENDTAB');
P(0, 'ENDSEC');

/* ---------------- BLOCKS ---------------- */
sec('BLOCKS');
P(0, 'BLOCK'); P(2, 'BOLT'); P(70, 0); P(10, 0); P(20, 0); P(30, 0); P(3, 'BOLT'); P(1, '');
E('CIRCLE', '0', 0, [[10, 0], [20, 0], [30, 0], [40, 5]]);        // BYBLOCK
E('LINE', '0', 256, [[10, -7], [20, 0], [30, 0], [11, 7], [21, 0], [31, 0]]);  // BYLAYER on layer 0
E('LINE', '0', 0, [[10, 0], [20, -7], [30, 0], [11, 0], [21, 7], [31, 0]]);
E('TEXT', '0', 0, [[10, 0], [20, 9], [30, 0], [40, 2.5], [1, 'BOLT'], [50, 0], [7, 'STANDARD']]);
P(0, 'ENDBLK');

P(0, 'BLOCK'); P(2, '*D1'); P(70, 1); P(10, 0); P(20, 0); P(30, 0); P(3, '*D1'); P(1, '');
E('LINE', 'YELLOW', 256, [[10, 212], [20, 22], [30, 0], [11, 272], [21, 22], [31, 0]]);
E('LINE', 'YELLOW', 256, [[10, 212], [20, 19], [30, 0], [11, 212], [21, 25], [31, 0]]);
E('LINE', 'YELLOW', 256, [[10, 272], [20, 19], [30, 0], [11, 272], [21, 25], [31, 0]]);
E('TEXT', 'YELLOW', 256, [[10, 242], [20, 24], [30, 0], [11, 242], [21, 24], [31, 0],
  [40, 3.2], [1, '60.00'], [72, 1], [73, 0], [7, 'STANDARD']]);
P(0, 'ENDBLK');
P(0, 'ENDSEC');

/* ---------------- ENTITIES ---------------- */
sec('ENTITIES');

/* 1. plain lines, bylayer / byobject / truecolor / negative ACI / off layer */
E('LINE', 'RED', 256, [[10, 10], [20, 180], [30, 0], [11, 60], [21, 180], [31, 0]]);
E('LINE', '0', 5, [[10, 10], [20, 174], [30, 0], [11, 60], [21, 174], [31, 0]]);
P(0, 'LINE'); P(8, '0'); P(420, 0xFF8800); P(10, 10); P(20, 168); P(30, 0); P(11, 60); P(21, 168); P(31, 0);
E('LINE', '0', -1, [[10, 10], [20, 162], [30, 0], [11, 60], [21, 162], [31, 0]]);
E('LINE', 'HIDDEN', 256, [[10, 10], [20, 156], [30, 0], [11, 60], [21, 156], [31, 0]]);
E('LINE', 'TRUECOLOR', 256, [[10, 10], [20, 150], [30, 0], [11, 60], [21, 150], [31, 0]]);
E('LINE', 'AXIS', 256, [[10, 10], [20, 144], [30, 0], [11, 60], [21, 144], [31, 0]]);
E('LINE', 'GRAY', 256, [[10, 10], [20, 138], [30, 0], [11, 60], [21, 138], [31, 0]]);

/* 2. LWPOLYLINE with bulges */
P(0, 'LWPOLYLINE'); P(8, 'GREEN'); P(62, 256); P(90, 5); P(70, 1); P(43, 0.4);
[[80, 180, 0], [110, 180, 0.5], [130, 165, 0], [110, 145, -0.6], [80, 150, 0]]
  .forEach(([x, y, b]) => { P(10, x); P(20, y); P(42, b); });

/* 3. CIRCLE / ARC / ELLIPSE / SPLINE / POINT */
E('CIRCLE', 'YELLOW', 256, [[10, 90], [20, 120], [30, 0], [40, 16]]);
E('ARC', 'CYAN', 256, [[10, 140], [20, 120], [30, 0], [40, 16], [50, 30], [51, 300]]);
E('ELLIPSE', 'MAGENTA', 256, [[10, 190], [20, 120], [30, 0], [11, 22], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 6.283185307179586]]);
P(0, 'SPLINE'); P(8, 'BLUE'); P(62, 256); P(70, 0); P(71, 3); P(72, 8); P(73, 4); P(74, 0);
[0, 0, 0, 0, 0.5, 1, 1, 1].forEach(k => P(40, k));
[[230, 175], [245, 190], [265, 160], [285, 182]].forEach(([x, y]) => { P(10, x); P(20, y); P(30, 0); });
E('POINT', 'RED', 256, [[10, 160], [20, 178], [30, 0]]);

/* 4. OCS test: extrusion (0,0,-1) mirrors X, so -50 becomes +50 in WCS */
P(0, 'CIRCLE'); P(8, 'CYAN'); P(62, 256); P(10, -50); P(20, 100); P(30, 0); P(40, 9);
P(210, 0); P(220, 0); P(230, -1);

/* 5. SOLID / TRACE / 3DFACE */
E('SOLID', 'RED', 256, [[10, 10], [20, 100], [30, 0], [11, 25], [21, 100], [31, 0],
  [12, 10], [22, 112], [32, 0], [13, 25], [23, 112], [33, 0]]);
E('TRACE', 'BLUE', 256, [[10, 30], [20, 100], [30, 0], [11, 45], [21, 100], [31, 0],
  [12, 30], [22, 112], [32, 0], [13, 45], [23, 112], [33, 0]]);
E('3DFACE', 'GREEN', 256, [[10, 50], [20, 100], [30, 0], [11, 65], [21, 100], [31, 0],
  [12, 65], [22, 112], [32, 0], [13, 50], [23, 112], [33, 0]]);

/* 6. TEXT / MTEXT */
E('TEXT', 'GREEN', 256, [[10, 10], [20, 88], [30, 0], [40, 5], [1, '%%c20 通孔 / 中文测试'], [50, 0], [7, 'STANDARD'], [41, 1]]);
P(0, 'MTEXT'); P(8, 'CYAN'); P(62, 256); P(10, 90); P(20, 88); P(30, 0);
P(40, 4.2); P(41, 55); P(71, 1); P(44, 1.1); P(50, 0);
P(3, '{\\fSimSun|b0|i0;多行文字第一行\\P第二行 %%d45'); P(1, '\\P第三行 %%p0.05}');

/* 7. INSERT: ByBlock color inheritance, rotation/scale, array, ATTRIB */
P(0, 'INSERT'); P(8, '0'); P(62, 1); P(2, 'BOLT'); P(10, 30); P(20, 55); P(30, 0);
P(41, 1); P(42, 1); P(43, 1); P(50, 0);
P(0, 'INSERT'); P(8, '0'); P(62, 5); P(2, 'BOLT'); P(10, 70); P(20, 55); P(30, 0);
P(41, 1.6); P(42, 1.6); P(43, 1); P(50, 30);
P(0, 'INSERT'); P(8, '0'); P(62, 3); P(2, 'BOLT'); P(10, 120); P(20, 55); P(30, 0);
P(41, 1); P(42, 1); P(43, 1); P(50, 0); P(66, 1); P(70, 2); P(71, 1); P(44, 28); P(45, 0);
P(0, 'ATTRIB'); P(8, '0'); P(62, 0); P(10, 120); P(20, 64); P(30, 0); P(40, 2.5);
P(1, 'M10x30'); P(2, 'SPEC'); P(7, 'STANDARD'); P(70, 0);
P(0, 'SEQEND');
/* INSERT on a named layer: block entities on layer 0 must inherit that layer color */
P(0, 'INSERT'); P(8, 'GREEN'); P(62, 256); P(2, 'BOLT'); P(10, 185); P(20, 55); P(30, 0);
P(41, 1); P(42, 1); P(43, 1); P(50, 0);

/* 8. DIMENSION using anonymous block */
P(0, 'DIMENSION'); P(8, 'YELLOW'); P(62, 256); P(2, '*D1');
P(10, 242); P(20, 22); P(30, 0); P(11, 242); P(21, 24); P(31, 0);
P(13, 212); P(23, 14); P(33, 0); P(14, 272); P(24, 14); P(34, 0); P(70, 32); P(1, '');

/* 9. HATCH solid + ANSI31 pattern */
P(0, 'HATCH'); P(8, 'BLUE'); P(62, 256); P(10, 0); P(20, 0); P(30, 0);
P(2, 'SOLID'); P(70, 1); P(71, 0); P(91, 1);
P(92, 2); P(72, 1); P(73, 1); P(93, 4);
[[175, 100], [205, 100], [205, 118], [175, 118]].forEach(([x, y]) => { P(10, x); P(20, y); P(42, 0); });
P(97, 0); P(75, 0); P(76, 1); P(98, 0);
P(0, 'HATCH'); P(8, 'GREEN'); P(62, 256); P(10, 0); P(20, 0); P(30, 0);
P(2, 'ANSI31'); P(70, 0); P(71, 0); P(91, 1); P(41, 2); P(52, 45);
P(92, 2); P(72, 1); P(73, 1); P(93, 4);
[[220, 100], [250, 100], [250, 118], [220, 118]].forEach(([x, y]) => { P(10, x); P(20, y); P(42, 0); });
P(97, 0); P(75, 0); P(76, 1); P(98, 0);

/* 10. old POLYLINE + VERTEX */
P(0, 'POLYLINE'); P(8, 'MAGENTA'); P(62, 256); P(70, 0); P(10, 0); P(20, 0); P(30, 0);
[[10, 20], [25, 28, 0.4], [40, 20], [55, 30]].forEach(([x, y, b]) => {
  P(0, 'VERTEX'); P(8, 'MAGENTA'); P(10, x); P(20, y); P(30, 0); P(42, b || 0);
});
P(0, 'SEQEND');

/* 11. LEADER / MLINE / XLINE / RAY / IMAGE / VIEWPORT */
P(0, 'LEADER'); P(8, 'RED'); P(62, 256); P(70, 0);
[[260, 80], [275, 90], [290, 90]].forEach(([x, y]) => { P(10, x); P(20, y); P(30, 0); });
P(0, 'MLINE'); P(8, 'CYAN'); P(62, 256); P(40, 1.2); P(70, 0); P(71, 0); P(72, 2); P(73, 2);
P(49, -0.5); P(49, 0.5);
[[10, 8], [60, 8]].forEach(([x, y]) => { P(10, x); P(20, y); P(30, 0); });
P(0, 'XLINE'); P(8, 'AXIS'); P(62, 256); P(10, 150); P(20, 0); P(30, 0); P(11, 0); P(21, 1); P(31, 0);
P(0, 'RAY'); P(8, 'AXIS'); P(62, 256); P(10, 150); P(20, 0); P(30, 0); P(11, 1); P(21, 0.5); P(31, 0);
P(0, 'IMAGE'); P(8, '0'); P(62, 256); P(10, 265); P(20, 40); P(30, 0);
P(11, 0.1); P(21, 0); P(31, 0); P(12, 0); P(22, 0.1); P(32, 0); P(13, 180); P(23, 120);
P(0, 'VIEWPORT'); P(8, '0'); P(62, 8); P(10, 290); P(20, 10); P(30, 0); P(40, 20); P(41, 16);

/* 12. unsupported types must be reported, not silently dropped */
P(0, '3DSOLID'); P(8, '0'); P(62, 7); P(1, 'ACIS dummy');
P(0, 'TOLERANCE'); P(8, '0'); P(62, 7); P(1, 'dummy');

P(0, 'ENDSEC');
P(0, 'EOF');

const out = path.join(__dirname, 'sample.dxf');
fs.writeFileSync(out, L.join('\r\n') + '\r\n', 'utf8');
console.log('generated ' + out + ' (' + (L.length / 2) + ' group-code pairs)');
