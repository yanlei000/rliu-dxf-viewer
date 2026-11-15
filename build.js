#!/usr/bin/env node
/* Build a single, dependency-free HTML file from the source parts. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = f => path.join(root, 'src', f);
const read = f => fs.readFileSync(f, 'utf8');

const aci = read(src('aci.js'));
/* The blank-drawing template is a real AutoCAD 2013 DXF export (tables, block
 * records, paper space and root dictionary included). Hand-written minimal
 * DXFs are rejected by AutoCAD with "DXF input invalid or incomplete". */
const blankDxf = read(src('blank.template.dxf'));
const blankJs = 'var BLANK_DXF = ' + JSON.stringify(blankDxf) + ';\n';
const pure = [aci, blankJs, read(src('parse.js')), read(src('geom.js')),
              read(src('entities.js')), read(src('editcore.js')),
              read(src('serialize.js')), read(src('snap.js'))];
const engine = pure.concat([read(src('viewer.js'))]);
const app = read(src('tools.js')) + '\n\n' + read(src('app.js'));
const css = read(src('app.css'));
const template = read(src('template.html'));

const iife = 'var DXF = (function () {\n"use strict";\nvar API = {};\n\n' +
  engine.join('\n\n') + '\n\n' + app + '\n\nreturn API;\n})();\n';

function guardScript(s) {
  return s.replace(/<\/script/gi, '<\\/script').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function guardStyle(s) {
  return s.replace(/<\/style/gi, '<\\/style');
}

/* The brand mark is inlined as base64 so the deliverable stays a single
 * dependency-free HTML file (also used as the favicon). */
const logoPath = path.join(root, 'logo.png');
const logoB64 = fs.existsSync(logoPath) ? fs.readFileSync(logoPath).toString('base64') : '';

const html = template
  .replace('/*__CSS__*/', guardStyle(css))
  .replace('/*__JS__*/', guardScript(iife))
  .replace(/__LOGO_B64__/g, logoB64);

const outHtml = path.join(root, 'DXF查看器.html');
fs.writeFileSync(outHtml, html, 'utf8');
/* Same bytes under index.html so GitHub Pages / any static host serves it
 * straight from the repo root. */
fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

/* Node-testable engine bundle (pure data, no DOM). */
const nodeBundle = '"use strict";\nvar API = {};\n\n' +
  pure.join('\n\n') + '\n\nmodule.exports = API;\n';
const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
fs.writeFileSync(path.join(distDir, 'engine.node.js'), nodeBundle, 'utf8');

console.log('built:', outHtml, '(' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
console.log('built:', path.join(distDir, 'engine.node.js'),
            '(' + (Buffer.byteLength(nodeBundle) / 1024).toFixed(1) + ' KB)');
