#!/usr/bin/env node
/* Coverage tests for the DXF parser / geometry / color engine. */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const API = require('./dist/engine.node.js');

let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { console.error('  FAIL  ' + name + (detail ? '  ' + detail : '')); process.exitCode = 1; }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); }
function center(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

const text = fs.readFileSync(path.join(__dirname, 'sample.dxf'), 'utf8');
const doc = API.parse(text);
const scene = API.buildScene(doc, { dark: true });
const light = API.buildScene(doc, { dark: false });
const items = scene.items;
const by = (fn) => items.filter(fn);
const line = (fn) => by(i => i.kind === 'line' && fn(i));

console.log('\n=== 1. Parsing ===');
ok('sections', ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES'].every(s => doc.sectionNames.includes(s)),
  doc.sectionNames.join(','));
ok('DXF version / units', doc.version === 'AC1015' && doc.insunits === 4,
  doc.version + ' / ' + doc.insunits);
ok('layer table', Object.keys(doc.tables.layer).length >= 11,
  Object.keys(doc.tables.layer).length + ' layers');
ok('linetype DASHED pattern', JSON.stringify(doc.tables.ltype.DASHED.pattern) === '[0.5,-0.25]',
  JSON.stringify(doc.tables.ltype.DASHED.pattern));
ok('blocks BOLT + *D1', !!doc.blocks.BOLT && !!doc.blocks['*D1']);
ok('normalize POLYLINE vertices', doc.entities.some(e => e.type === 'POLYLINE' && e.vertices.length === 4));
ok('normalize INSERT attributes', doc.entities.some(e => e.type === 'INSERT' && e.attribs && e.attribs.length === 1));
ok('top-level entities', doc.entities.length >= 30, doc.entities.length + ' entities');

console.log('\n=== 2. Flattening ===');
ok('drawing primitives generated', items.length > 55, items.length + ' items');
ok('bounds are finite', [scene.bounds.minX, scene.bounds.minY, scene.bounds.maxX, scene.bounds.maxY].every(isFinite),
  JSON.stringify(scene.bounds));
ok('no unsupported silent loss', Object.keys(scene.stats.skipped).length >= 2,
  JSON.stringify(scene.stats.skipped));
ok('skipped types reported', !!scene.stats.skipped['3DSOLID'] && !!scene.stats.skipped.TOLERANCE);
const counts = scene.stats.byType;
ok('INSERT expanded', scene.stats.blockInserts >= 4, 'count=' + scene.stats.blockInserts);
ok('nested block geometry present', counts.CIRCLE >= 6, 'circles=' + counts.CIRCLE);
const containerTypes = { INSERT: 1, DIMENSION: 1, '3DSOLID': 1, TOLERANCE: 1 };
const drawnTypes = new Set(items.map(i => i.type));
const missingGeom = Object.keys(counts).filter(t => !containerTypes[t] && !drawnTypes.has(t));
ok('every drawable entity type produced geometry', missingGeom.length === 0, missingGeom.join(',') || 'none missing');

console.log('\n=== 3. Color fidelity ===');
const colors = new Set(items.map(i => i.color));
[
  ['#ff0000', 'ACI 1 red / ByLayer RED'],
  ['#0000ff', 'ACI 5 blue'],
  ['#ff8800', 'group 420 true color'],
  ['#3399ff', 'layer 420 true color'],
  ['#ffff00', 'ACI 2 yellow'],
  ['#00ff00', 'ACI 3 green'],
  ['#00ffff', 'ACI 4 cyan'],
  ['#ff00ff', 'ACI 6 magenta'],
  ['#808080', 'ACI 8 dark gray'],
  ['#c0c0c0', 'ACI 9 light gray']
].forEach(([c, desc]) => ok(desc, colors.has(c), c));

const negLine = line(i => i.pts.length === 2 && near(i.pts[0][0], 10) && near(i.pts[0][1], 162));
ok('negative ACI keeps its color', negLine.length > 0 && negLine[0].color === '#ff0000',
  negLine[0] ? negLine[0].color : 'missing');
const offLayer = by(i => i.layer === 'HIDDEN');
ok('off/frozen layer still drawn', offLayer.length > 0 && offLayer[0].color === '#808080');
ok('light theme flips ACI 7', items.filter(i => i.color === '#ffffff').length > 0 &&
  light.items.filter(i => i.color === '#000000').length > 0);

console.log('\n=== 4. Blocks / inheritance / transforms ===');
const circles = line(i => i.closed && i.pts.length === 64);
function circleNear(x, y, eps) { return circles.find(i => near(center(i.pts)[0], x, eps || 1.5) && near(center(i.pts)[1], y, eps || 1.5)); }
const c1 = circleNear(30, 55), c2 = circleNear(70, 55), c3 = circleNear(120, 55),
      c4 = circleNear(148, 55), c5 = circleNear(185, 55);
ok('ByBlock inherits INSERT color (red)', !!c1 && c1.color === '#ff0000', c1 && c1.color);
ok('ByBlock inherits INSERT color (blue)', !!c2 && c2.color === '#0000ff', c2 && c2.color);
ok('ByBlock inherits INSERT color (green)', !!c3 && c3.color === '#00ff00', c3 && c3.color);
ok('INSERT column array expands 2 instances', !!c4 && c4.color === '#00ff00', c4 && c4.color);
ok('layer-0 block entity ByLayer inherits insert layer', !!c5 && c5.color === '#00ff00', c5 && c5.color);
if (c2) {
  const r = Math.hypot(c2.pts[0][0] - 70, c2.pts[0][1] - 55);
  ok('INSERT scale 1.6 applied', near(r, 8, 0.3), 'radius=' + r.toFixed(2));
}
const greenLayer0 = by(i => i.layer === 'GREEN' && i.type === 'LINE' && center(i.pts)[0] > 180 && center(i.pts)[0] < 192);
ok('layer-0 inheritance applies to all block entities', greenLayer0.length > 0);
const attr = by(i => i.type === 'ATTRIB' && i.text === 'M10x30');
ok('ATTRIB rendered with block transform', attr.length > 0);

console.log('\n=== 5. Geometry ===');
const ocs = circleNear(50, 100, 2);
ok('OCS extrusion (0,0,-1) mirrored X from -50 to +50', !!ocs, ocs ? JSON.stringify(center(ocs.pts)) : 'missing');
const lw = line(i => i.type === 'LWPOLYLINE');
ok('LWPOLYLINE bulge expanded to arc points', lw.length > 0 && lw[0].pts.length > 10,
  lw[0] ? lw[0].pts.length + ' points' : 'missing');
const spl = line(i => i.type === 'SPLINE');
ok('SPLINE NURBS sampled', spl.length > 0 && spl[0].pts.length >= 24,
  spl[0] ? spl[0].pts.length + ' points' : 'missing');
const ell = line(i => i.type === 'ELLIPSE');
ok('ELLIPSE sampled', ell.length > 0 && ell[0].pts.length > 40);
const arc = line(i => i.type === 'ARC');
ok('ARC sampled', arc.length > 0 && arc[0].pts.length > 20);
ok('SOLID / TRACE / 3DFACE filled', ['SOLID', 'TRACE', '3DFACE'].every(t => by(i => i.kind === 'fill' && i.type === t).length > 0));
ok('POINT primitive', by(i => i.kind === 'point').length > 0);
ok('TEXT cleaned (%%c -> diameter sign)', by(i => i.type === 'TEXT' && i.text.indexOf('\u00D820') === 0).length > 0);
ok('MTEXT multi-line decoded', by(i => i.type === 'MTEXT' && i.lines.length === 3).length > 0,
  (by(i => i.type === 'MTEXT')[0] || {}).lines ? JSON.stringify(by(i => i.type === 'MTEXT')[0].lines) : '');
ok('DIMENSION anonymous block expanded', by(i => i.layer === 'YELLOW' && i.type === 'TEXT' && i.text === '60.00').length > 0);
ok('HATCH SOLID fill', by(i => i.kind === 'fill' && i.type === 'HATCH' && i.layer === 'BLUE').length > 0);
ok('HATCH pattern lines clipped', by(i => i.type === 'HATCH' && i.layer === 'GREEN' && i.pts.length === 2).length > 3,
  by(i => i.type === 'HATCH' && i.layer === 'GREEN' && i.pts.length === 2).length + ' segments');
ok('XLINE / RAY infinite primitives', by(i => i.kind === 'infinite').length === 2);
ok('MLINE offsets', line(i => i.type === 'MLINE').length >= 2);
ok('LEADER arrow', line(i => i.type === 'LEADER').length >= 3);
ok('IMAGE / VIEWPORT frames', line(i => i.type === 'IMAGE' || i.type === 'VIEWPORT').length === 2);
ok('linetype inheritance from layer', by(i => i.layer === 'AXIS' && i.linetype === 'CENTER').length > 0 &&
  by(i => i.layer === 'GRAY' && i.linetype === 'DASHED').length > 0);

/* ---- TEXT vs MTEXT group-code semantics (dimension labels) ----
 * MTEXT 71 = attachment point (NOT a mirror flag); 11/21 = X-axis direction
 * vector (NOT an insertion point).  Confusing them used to flip horizontal
 * dimensions upside down and make vertical dimension labels disappear. */
console.log('\n=== 5b. TEXT / MTEXT group codes ===');
function miniEnt(type, pairs) {
  let s = '0\n' + type + '\n';
  for (const [c, v] of pairs) s += c + '\n' + v + '\n';
  return s;
}
const textDxf = '0\nSECTION\n2\nENTITIES\n' +
  miniEnt('MTEXT', [[8, '0'], [10, 100], [20, 200], [30, 0], [40, 5], [41, 0],
                    [71, 5], [72, 1], [73, 1], [11, 0], [21, 1], [31, 0], [50, 0], [1, 'ABC']]) +
  miniEnt('TEXT', [[8, '0'], [10, 10], [20, 20], [30, 0], [40, 3], [50, 30], [1, 'XYZ']]) +
  miniEnt('TEXT', [[8, '0'], [10, 30], [20, 40], [30, 0], [40, 3], [71, 4], [1, 'MIR']]) +
  '0\nENDSEC\n0\nEOF\n';
const td = API.parse(textDxf), ts = API.buildScene(td, { dark: true });
const tm = ts.items.filter(i => i.mtext)[0];
const t1 = ts.items.filter(i => i.type === 'TEXT' && i.text === 'XYZ')[0];
const t2 = ts.items.filter(i => i.type === 'TEXT' && i.text === 'MIR')[0];
ok('MTEXT anchored at 10/20 (not 11/21 direction vector)',
  !!tm && near(tm.pos[0], 100) && near(tm.pos[1], 200),
  tm ? tm.pos[0] + ',' + tm.pos[1] : 'missing');
ok('MTEXT 71 is attachment, never a mirror flag',
  !!tm && !tm.mirrorX && !tm.mirrorY && tm.attach === 5,
  tm ? 'attach=' + tm.attach + ' mirrorY=' + tm.mirrorY : 'missing');
ok('MTEXT direction vector drives text rotation',
  !!tm && near(tm.rot, Math.PI / 2),
  tm ? (tm.rot * 180 / Math.PI).toFixed(1) + ' deg' : 'missing');
ok('TEXT rotation still comes from group 50',
  !!t1 && near(t1.rot, Math.PI / 6),
  t1 ? (t1.rot * 180 / Math.PI).toFixed(1) + ' deg' : 'missing');
ok('TEXT 71=4 still means upside-down', !!t2 && t2.mirrorY && !t2.mirrorX);

console.log('\n=== 6. Summary ===');
console.log('  entities:', scene.stats.topLevel, '| primitives:', scene.items.length,
  '| layers:', scene.stats.byLayerSorted.length);
console.log('  types:', Object.keys(counts).sort().join(', '));
console.log('  skipped:', JSON.stringify(scene.stats.skipped));
console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : '') + '\n');
