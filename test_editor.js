#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Tests for the editing / measuring / DXF-writing layer.
 *   node test_editor.js
 * ------------------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./dist/engine.node.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
};
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-6 : eps);
const head = t => console.log('\n=== ' + t + ' ===');

function simpleDoc() {
  const t = '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';
  const d = A.parse(t);
  d.version = 'AC1015';
  d.insunits = 4;
  A.assignEntityIds(d);
  return d;
}
function sceneOf(d, extra) {
  const doc = A.parse(A.exportDXF('', d));
  if (extra) extra(doc);
  return A.buildScene(doc, { dark: true });
}
function lineItem(s, type) { return s.items.filter(i => i.type === type); }
function firstPts(s, type) { const a = lineItem(s, type); return a.length ? a[0].pts : []; }
function pair(e, code) { const p = e.pairs.find(x => x[0] === code); return p ? p[1] : undefined; }

/* ------------------------------------------------------------------ */
head('1. New entity construction + render round-trip');
{
  const d = simpleDoc();
  const st = { layer: '0', aci: 1, lw: 25 };
  d.entities.push(A.newShape('LINE', { pts: [[0, 0], [10, 0]] }, st));
  d.entities.push(A.newShape('LWPOLYLINE', { pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true }, st));
  d.entities.push(A.newShape('CIRCLE', { center: [5, 5], radius: 3 }, st));
  d.entities.push(A.newShape('ARC', { center: [0, 0], radius: 4, a0: 0, a1: 90 }, st));
  d.entities.push(A.newShape('POINT', { pts: [[7, 7]] }, st));
  d.entities.push(A.newShape('TEXT', { pts: [[1, 1]], text: '测试 ABC', height: 2.5 }, st));
  const s = sceneOf(d);
  ok('six entities written', d.entities.length === 6, 'n=' + d.entities.length);
  ok('LINE geometry', firstPts(s, 'LINE').length === 2 &&
     near(firstPts(s, 'LINE')[1][0], 10), JSON.stringify(firstPts(s, 'LINE')));
  const lp = lineItem(s, 'LWPOLYLINE')[0];
  ok('closed LWPOLYLINE', lp && lp.closed === true && lp.corners.length === 4,
     lp ? 'corners=' + lp.corners.length : 'missing');
  const ci = lineItem(s, 'CIRCLE')[0];
  ok('CIRCLE centre/radius metadata', ci && near(ci.radius, 3) && near(ci.center[0], 5));
  ok('ARC angles survive', lineItem(s, 'ARC').length === 1 && lineItem(s, 'ARC')[0].pts.length > 10);
  ok('POINT rendered', lineItem(s, 'POINT').length === 1);
  const tx = lineItem(s, 'TEXT')[0];
  ok('TEXT content + height', tx && tx.text === '测试 ABC' && near(tx.height, 2.5),
     tx ? tx.text : 'missing');
  ok('explicit ACI 1 -> red', ci && String(ci.color).toUpperCase() === '#FF0000', ci ? ci.color : '');
  ok('owner attached to every primitive', s.items.every(i => i.owner && i.ownerId > 0));
}

head('2. Color / layer / lineweight property editing');
{
  const d = simpleDoc();
  const e = A.newShape('CIRCLE', { center: [0, 0], radius: 2 }, { layer: 'A', aci: 3 });
  d.entities.push(e);
  A.ensureLayer(d, 'NEWLAYER', 5);
  let t = A.setEntityProps(e, { layer: 'NEWLAYER', color: { rgb: 0x12AB34 }, lw: 50 });
  ok('layer changed', pair(t, 8) === 'NEWLAYER');
  ok('true color written', pair(t, 420) === 0x12AB34, String(pair(t, 420)));
  ok('stale ACI removed', pair(t, 62) === undefined);
  ok('lineweight written', pair(t, 370) === 50);
  t = A.setEntityProps(t, { color: 5 });
  ok('ACI replaces true color', pair(t, 62) === 5 && pair(t, 420) === undefined);
  t = A.setEntityProps(t, { color: 'BYLAYER' });
  ok('ByLayer clears both', pair(t, 62) === undefined && pair(t, 420) === undefined);
  d.entities[0] = t;
  const s = sceneOf(d);
  ok('layer colour inherited after ByLayer',
     String(lineItem(s, 'CIRCLE')[0].color).toUpperCase() === '#0000FF',
     lineItem(s, 'CIRCLE')[0].color);
}

head('3. Geometric transforms on raw DXF records');
{
  const d = simpleDoc();
  const line = A.newShape('LINE', { pts: [[0, 0], [10, 0]] }, { layer: '0' });
  const circle = A.newShape('CIRCLE', { center: [0, 0], radius: 5 }, { layer: '0' });
  const poly = A.newShape('LWPOLYLINE', { pts: [[0, 0], [4, 0], [4, 3]], closed: true }, { layer: '0' });
  const arc = A.newShape('ARC', { center: [0, 0], radius: 5, a0: 0, a1: 90 }, { layer: '0' });
  const text = A.newShape('TEXT', { pts: [[1, 1]], text: 'Hi', height: 2 }, { layer: '0' });
  d.entities.push(line, circle, poly, arc, text);

  const moved = A.transformEntity(line, A.XFmove(3, -2));
  ok('move LINE', near(pair(moved, 10), 3) && near(pair(moved, 20), -2) &&
     near(pair(moved, 11), 13) && near(pair(moved, 21), -2));

  const rot = A.transformEntity(line, A.XFrotate([0, 0], 90));
  ok('rotate LINE 90 deg', near(pair(rot, 11), 0, 1e-9) && near(pair(rot, 21), 10, 1e-9),
     pair(rot, 11) + ',' + pair(rot, 21));

  const scaled = A.transformEntity(circle, A.XFscale([0, 0], 2));
  ok('scale CIRCLE radius', near(pair(scaled, 40), 10));
  const scaled2 = A.transformEntity(circle, A.XFscale([0, 0], 3));
  ok('scale CIRCLE centre stays', near(pair(scaled2, 10), 0) && near(pair(scaled2, 40), 15));

  const cpoly = A.transformEntity(poly, A.XFmove(5, 5));
  const xs = cpoly.pairs.filter(p => p[0] === 10).map(p => p[1]);
  ok('move LWPOLYLINE all vertices', xs.length === 3 && near(xs[0], 5) && near(xs[2], 9), xs.join(','));

  const carc = A.transformEntity(arc, A.XFrotate([0, 0], 30));
  ok('rotate ARC angles', near(pair(carc, 50), 30) && near(pair(carc, 51), 120),
     pair(carc, 50) + '..' + pair(carc, 51));

  const ctext = A.transformEntity(text, A.XFscale([0, 0], 2));
  ok('scale TEXT height + position', near(pair(ctext, 40), 4) && near(pair(ctext, 10), 2));

  const mir = A.transformEntity(line, A.XFmirror([5, -10], [5, 10]));
  ok('mirror LINE about x=5', near(pair(mir, 10), 10, 1e-9) && near(pair(mir, 11), 0, 1e-9),
     pair(mir, 10) + '->' + pair(mir, 11));

  const marc = A.transformEntity(arc, A.XFmirror([0, 0], [1, 0]));
  ok('mirror ARC swaps angles', near(pair(marc, 50), 270) && near(pair(marc, 51), 360),
     pair(marc, 50) + '..' + pair(marc, 51));

  /* render transformed entities to make sure the whole pipeline works */
  d.entities = [moved, scaled, cpoly, carc, ctext];
  const s = sceneOf(d);
  ok('transformed entities still render', s.items.length >= 5, 'items=' + s.items.length);
  ok('moved LINE visible', near(firstPts(s, 'LINE')[0][0], 3));
}

head('4. Undo / redo snapshots');
{
  const d = simpleDoc();
  const h = new A.History(10);
  h.reset(d);
  d.entities.push(A.newShape('LINE', { pts: [[0, 0], [1, 1]] }, {}));
  h.push(d);
  d.entities.push(A.newShape('CIRCLE', { center: [0, 0], radius: 2 }, {}));
  h.push(d);
  ok('history has 3 states', h.stack.length === 3);
  h.restore(d, 1);
  ok('undo -> 1 entity', d.entities.length === 1, 'n=' + d.entities.length);
  h.restore(d, 2);
  ok('redo -> 2 entities', d.entities.length === 2, 'n=' + d.entities.length);
  h.restore(d, 0);
  ok('undo to initial -> 0 entities', d.entities.length === 0);
  h.restore(d, 2);
  d.entities[0] = A.transformEntity(d.entities[0], A.XFmove(9, 9));
  h.restore(d, 2);
  ok('restored snapshot is independent', near(pair(d.entities[0], 10), 0),
     String(pair(d.entities[0], 10)));
}

head('5. DXF export / import round-trip (splicing original sections)');
{
  const original = fs.readFileSync(path.join(__dirname, 'sample.dxf'), 'utf8');
  const d = A.parse(original);
  A.assignEntityIds(d);
  const before = d.entities.length;
  A.ensureLayer(d, 'MEASURE-NOTES', 30);
  d.entities.push(A.newShape('LINE', { pts: [[0, 0], [42, 42]] },
    { layer: 'MEASURE-NOTES', aci: 1 }));
  d.entities.push(A.newShape('CIRCLE', { center: [10, 10], radius: 4 },
    { layer: 'MEASURE-NOTES', trueColor: 0x00A0FF }));
  d.entities[0] = A.transformEntity(d.entities[0], A.XFmove(1, 2));
  const out = A.exportDXF(original, d);
  ok('export produced text', out.length > original.length * 0.8, out.length + ' bytes');
  ok('HEADER section preserved', out.indexOf('$ACADVER') >= 0 && out.indexOf('HEADER') >= 0);
  ok('new layer injected into TABLES', /2\s*\nMEASURE-NOTES/.test(out));
  const d2 = A.parse(out);
  ok('entity count grows by 2', d2.entities.length === before + 2,
     before + ' -> ' + d2.entities.length);
  ok('new layer parsed', !!d2.tables.layer['MEASURE-NOTES']);
  ok('sections still parse', d2.sectionNames.length >= 4, d2.sectionNames.join(','));
  const s = A.buildScene(d2, { dark: true });
  const newLine = s.items.filter(i => i.type === 'LINE' && i.layer === 'MEASURE-NOTES');
  ok('added LINE renders on its layer', newLine.length === 1, 'n=' + newLine.length);
  const newCircle = s.items.filter(i => i.type === 'CIRCLE' && i.layer === 'MEASURE-NOTES');
  ok('added true-colour CIRCLE renders', newCircle.length === 1 &&
     String(newCircle[0].color).toUpperCase() === '#00A0FF',
     newCircle.length ? newCircle[0].color : 'missing');
  ok('layer list includes new layer', s.stats.byLayerSorted.indexOf('MEASURE-NOTES') >= 0);
  /* second round trip: editing the exported file must stay stable */
  const out2 = A.exportDXF(out, d2);
  const d3 = A.parse(out2);
  ok('second export is stable', d3.entities.length === d2.entities.length,
     d2.entities.length + ' vs ' + d3.entities.length);
}

head('6. Blank-drawing export');
{
  const d = simpleDoc();
  A.ensureLayer(d, 'DRAW', 2);
  d.entities.push(A.newShape('LWPOLYLINE', { pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true },
    { layer: 'DRAW', aci: 2 }));
  const out = A.exportDXF('', d);
  const d2 = A.parse(out);
  ok('minimal DXF parses', d2.entities.length === 1, 'n=' + d2.entities.length);
  ok('minimal DXF has LAYER table', !!d2.tables.layer['DRAW']);
  ok('minimal DXF ends with EOF', /0\s*\nEOF\s*$/.test(out.trim()));
  const s = A.buildScene(d2, { dark: true });
  ok('closed rectangle renders', s.items.length === 1 && s.items[0].closed);
}

head('7. Object snap');
{
  const d = simpleDoc();
  d.entities.push(A.newShape('LINE', { pts: [[0, 0], [10, 0]] }, {}));
  d.entities.push(A.newShape('LINE', { pts: [[5, -5], [5, 5]] }, {}));
  d.entities.push(A.newShape('CIRCLE', { center: [20, 0], radius: 4 }, {}));
  const s = A.buildScene(d, { dark: true });
  s.items.forEach(i => {
    i._bb = [Math.min.apply(null, i.pts.map(p => p[0])), Math.min.apply(null, i.pts.map(p => p[1])),
             Math.max.apply(null, i.pts.map(p => p[0])), Math.max.apply(null, i.pts.map(p => p[1]))];
  });
  const opts = { tol: 0.6, layerOn: () => true };
  const e1 = A.snapPoint(s.items, 0.2, 0.1, opts);
  ok('endpoint snap', e1 && e1.type === 'endpoint' && near(e1.p[0], 0) && near(e1.p[1], 0),
     e1 ? e1.type + ' ' + e1.p : 'none');
  const mid = A.snapPoint(s.items, 5, 0, opts);
  ok('intersection snap at (5,0)', mid && near(mid.p[0], 5) && near(mid.p[1], 0) &&
     mid.type === 'intersection', mid ? mid.type + ' ' + mid.p : 'none');
  const cen = A.snapPoint(s.items, 20.1, 0.1, opts);
  ok('centre snap', cen && cen.type === 'center' && near(cen.p[0], 20),
     cen ? cen.type + ' ' + cen.p : 'none');
  const quad = A.snapPoint(s.items, 24, 0, opts);
  ok('quadrant snap', quad && near(quad.p[0], 24), quad ? quad.type : 'none');
  const free = A.snapPoint(s.items, 100, 100, opts);
  ok('no false snap far away', free === null);
  const grid = A.snapPoint(s.items, 100.3, 100.2, { tol: 0.2, gridStep: 0.5, layerOn: () => true });
  ok('grid fallback', grid && grid.type === 'grid' && near(grid.p[0], 100.5),
     grid ? grid.p.join(',') : 'none');
}

head('8. Measurement maths');
{
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
  ok('polygon area 100', near(A.polyArea(pts), 100));
  ok('closed perimeter 40', near(A.polyLength(pts, true), 40));
  ok('centroid (5,5)', near(A.polyCentroid(pts)[0], 5) && near(A.polyCentroid(pts)[1], 5));
  const ang = A.angleBetween([0, 0], [10, 0], [0, 10]);
  ok('right angle', near(ang.included, 90) && near(ang.sweep, 90));
  ok('distance 3-4-5', near(A.dist2(0, 0, 3, 4), 5));
  const c = A.circleFrom3Points([1, 0], [0, 1], [-1, 0]);
  ok('three point circle', c && near(c.radius, 1) && near(c.center[0], 0) && near(c.a0, 0) && near(c.a1, 180),
     c ? JSON.stringify(c) : 'null');
  ok('collinear points rejected', A.circleFrom3Points([0, 0], [1, 1], [2, 2]) === null);
  const ci = A.findCircle([{ center: [0, 0], radius: 5, layer: '0' }], 5, 0, 0.1);
  ok('findCircle under cursor', !!ci);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : '') + pass + ' checks passed');
process.exit(fail ? 1 : 0);
