#!/usr/bin/env node
/* Emit a small demo DXF that AutoCAD can actually open: built on the real
 * blank template (tables + block records + dictionary), so it doubles as a
 * reference for what a valid export looks like. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./dist/engine.node.js');

const blank = fs.readFileSync(path.join(__dirname, 'src', 'blank.template.dxf'), 'utf8');
const doc = A.parse(blank);

function add(kind, geom, style) {
  const e = A.newShape(kind, geom, style);
  if (e) doc.entities.push(e);
}

/* frame */
add('LWPOLYLINE', { pts: [[0, 0], [300, 0], [300, 200], [0, 200]], closed: true }, { layer: '0', aci: 7 });
/* inner parts */
add('CIRCLE', { center: [80, 100], radius: 45 }, { layer: '0', aci: 1 });
add('CIRCLE', { center: [80, 100], radius: 22 }, { layer: '0', aci: 3 });
add('ARC', { center: [200, 100], radius: 55, a0: 30, a1: 150 }, { layer: '0', aci: 5 });
add('LINE', { pts: [[145, 30], [145, 170]] }, { layer: '0', aci: 6 });
add('LINE', { pts: [[130, 100], [270, 100]] }, { layer: '0', aci: 4 });
add('LWPOLYLINE', { pts: [[210, 40], [270, 40], [270, 70], [210, 70]], closed: false }, { layer: '0', aci: 2 });
add('POINT', { pts: [[30, 180]] }, { layer: '0', aci: 1 });
add('TEXT', { pts: [[100, 182]], text: 'Rliu DXF demo', height: 12 }, { layer: '0', aci: 2 });
add('TEXT', { pts: [[100, 12]], text: 'circle / arc / line / polyline', height: 8 }, { layer: '0', aci: 7 });

const out = path.join(__dirname, '示例图纸.dxf');
fs.writeFileSync(out, A.exportDXF(blank, doc), 'utf8');
console.log('generated ' + out + ' (' + doc.entities.length + ' entities, ' +
            (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
