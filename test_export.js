/* Export correctness tests: the failure modes that made AutoCAD refuse the
 * saved file ("DXF input invalid or incomplete" -> drawing discarded). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./dist/engine.node.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  ' + (detail || '')); }
}
const lines = t => t.split(/\r\n|\r|\n/);
function hasSeq(text, seq) {
  const L = lines(text);
  for (let i = 0; i + seq.length <= L.length; i++) {
    let hit = true;
    for (let k = 0; k < seq.length; k++) if (L[i + k].trim() !== seq[k]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
}
function headerVar(text, name) {
  const L = lines(text);
  for (let i = 0; i < L.length - 3; i++) {
    if (L[i].trim() === '9' && L[i + 1].trim().toUpperCase() === name.toUpperCase()) {
      return L[i + 3];
    }
  }
  return null;
}
function handleDups(text) {
  const L = lines(text);
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i + 1 < L.length; i += 2) {
    const c = L[i].trim();
    if (c !== '5' && c !== '105') continue;
    const h = L[i + 1].trim().toUpperCase();
    if (seen.has(h)) dup++; else seen.add(h);
  }
  return dup;
}

console.log('\n=== 1. Blank template integrity ===');
const blank = A.BLANK_DXF || '';
ok('template embedded', blank.length > 50000, blank.length + ' chars');
for (const sec of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']) {
  ok('section present: ' + sec, hasSeq(blank, ['0', 'SECTION', '2', sec]) , '');
}
for (const table of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'APPID', 'BLOCK_RECORD']) {
  ok('table present: ' + table, hasSeq(blank, ['0', 'TABLE', '2', table]), '');
}
ok('model space block record', hasSeq(blank, ['0', 'BLOCK', '5', '1F']) || blank.indexOf('*Model_Space') > 0);
ok('root dictionary', hasSeq(blank, ['0', 'DICTIONARY', '5', 'B']), '');

console.log('\n=== 2. Draw on blank canvas then export ===');
const bdoc = A.parse(blank);
bdoc.entities.push(A.newShape('LINE', { pts: [[0, 0], [120, 0]] }, { layer: '0', aci: 1 }));
bdoc.entities.push(A.newShape('CIRCLE', { center: [60, 40], radius: 25 }, { layer: '0', aci: 3 }));
bdoc.entities.push(A.newShape('ARC', { center: [20, 80], radius: 10, a0: 0, a1: 90 }, { layer: '0', aci: 5 }));
bdoc.entities.push(A.newShape('LWPOLYLINE', { pts: [[0, 0], [50, 0], [50, 30]], closed: true }, { layer: '0', aci: 6 }));
bdoc.entities.push(A.newShape('POINT', { pts: [[80, 80]] }, { layer: '0', aci: 7 }));
bdoc.entities.push(A.newShape('TEXT', { pts: [[5, 5]], text: 'Rliu', height: 6 }, { layer: '0', aci: 2 }));
const bOut = A.exportDXF(blank, bdoc);

ok('entities written', (bOut.match(/\n0\r?\n(?:LINE|CIRCLE|ARC|LWPOLYLINE|POINT|TEXT)\r?\n/g) || []).length >= 6);
ok('TABLES preserved', hasSeq(bOut, ['0', 'SECTION', '2', 'TABLES']));
ok('OBJECTS preserved', hasSeq(bOut, ['0', 'SECTION', '2', 'OBJECTS']));
ok('APPID preserved', hasSeq(bOut, ['0', 'TABLE', '2', 'APPID']));

console.log('\n=== 3. Subclass markers AutoCAD requires ===');
const tSlice = bOut.slice(bOut.indexOf('\n0\r\nARC\r\n'), bOut.indexOf('\n0\r\nARC\r\n') + 700);
ok('ARC has AcDbCircle marker', tSlice.indexOf('AcDbCircle') >= 0);
ok('ARC has AcDbArc marker', tSlice.indexOf('AcDbArc') >= 0);
ok('ARC centre code precedes AcDbArc',
   tSlice.indexOf('AcDbArc') > tSlice.indexOf('AcDbCircle') && tSlice.indexOf('AcDbArc') > 0);
const textSlice = bOut.slice(bOut.indexOf('\n0\r\nTEXT\r\n'), bOut.indexOf('\n0\r\nTEXT\r\n') + 900);
const textMarks = (textSlice.match(/AcDbText/g) || []).length;
ok('TEXT carries two AcDbText markers', textMarks >= 2, 'count=' + textMarks);
ok('TEXT has owner 330', /\n330\r?\n/.test(textSlice));
ok('no duplicate handles after drawing', handleDups(bOut) === 0, 'dups=' + handleDups(bOut));

console.log('\n=== 4. Real drawing round trip ===');
/* Prefer a third-party drawing placed in dist/ for regression; fall back to
 * the generated demo so the suite always runs. */
const candidates = ['dist/user_source.dxf', '示例图纸.dxf']
  .map(p => path.join(__dirname, p));
const realPath = candidates.filter(p => fs.existsSync(p))[0];
if (realPath) {
  const src = fs.readFileSync(realPath, 'utf8');
  const d = A.parse(src);
  const out = A.exportDXF(src, d);
  ok('drawing reparsed', d.entities.length > 5, d.entities.length + ' entities @ ' + d.version);
  ok('SEQEND has owner + subclass',
     !/\nSEQEND\r?\n5\r?\n[0-9A-F]+\r?\n8\r?\n/.test(out),
     'legacy two-code SEQEND must be gone');
  ok('no duplicate handles', handleDups(out) === 0, 'dups=' + handleDups(out));
  ok('$ACADVER kept', headerVar(out, '$ACADVER') === d.version, headerVar(out, '$ACADVER'));
  ok('$HANDSEED refreshed', headerVar(out, '$HANDSEED') !== null, 'seed=' + headerVar(out, '$HANDSEED'));
  ok('EOF terminates the file', /\n\s*EOF\s*$/.test(out));

  console.log('\n=== 5. Cross-version export ===');
  /* Pick whatever target differs from the source, so the conversion branch runs. */
  const otherVer = String(d.version).toUpperCase() === 'AC1027' ? 'AC1024' : 'AC1027';
  const v13 = A.exportDXF(src, A.parse(src), { version: otherVer });
  ok('$ACADVER rewritten', headerVar(v13, '$ACADVER') === otherVer, headerVar(v13, '$ACADVER'));
  ok('$ACADMAINTVER zeroed', headerVar(v13, '$ACADMAINTVER') === '0', headerVar(v13, '$ACADMAINTVER'));
  ok('version-sensitive objects dropped',
     (v13.match(/\n0\r?\nVISUALSTYLE\r?\n/g) || []).length === 0);
  ok('dictionary entries kept valid', handleDups(v13) === 0, 'dups=' + handleDups(v13));

  const v2000 = A.exportDXF(src, A.parse(src), { version: 'AC1015' });
  ok('down-version to 2000 works', headerVar(v2000, '$ACADVER') === 'AC1015');
} else {
  console.log('  (skipped: no sample drawing available)');
}

console.log('\n=== 6. Large entity count does not overflow ===');
const many = A.parse(blank);
for (let i = 0; i < 12000; i++) {
  many.entities.push(A.newShape('LINE', { pts: [[i, 0], [i, 10]] }, { layer: '0', aci: 1 }));
}
let big = null, bigErr = null;
try { big = A.exportDXF(blank, many); } catch (e) { bigErr = e; }
ok('12000 entities exported without RangeError', big !== null && bigErr === null,
   bigErr ? bigErr.message : (big ? (big.length / 1024).toFixed(0) + ' KB' : ''));

console.log('\n=== 7. R12 source guard ===');
const r12 = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n' +
            '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n';
let threw = false;
try { A.exportDXF(r12, A.parse(r12), { version: 'AC1027', strict: true }); }
catch (e) { threw = /R12|升级/.test(e.message); }
ok('R12 -> R2013 refuses instead of writing a broken file', threw);

console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' + pass + ' passed' : '✓ all ' + pass + ' checks passed'));
process.exit(fail ? 1 : 0);
