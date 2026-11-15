#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Embed a DXF file into a standalone HTML page that shows the drawing the
 * moment it is opened (no file picker, no server, no network).
 *
 *   node dxf2html.js <input.dxf> [output.html]
 *
 * UTF-8 DXF is embedded as text (smaller). Non-UTF-8 (e.g. GBK Chinese CAD
 * files) is embedded as raw bytes in base64 so the browser can decode it
 * with the same encoding auto-detection used by the normal file picker.
 * ------------------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) {
  console.error('用法: node dxf2html.js <input.dxf> [output.html]');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error('找不到文件: ' + input);
  process.exit(1);
}
const stat = fs.statSync(input);
if (stat.size > 120 * 1024 * 1024) {
  console.error('文件超过 120 MB，建议使用查看器直接打开，避免生成过大的 HTML。');
  process.exit(1);
}
const buf = fs.readFileSync(input);
const head = buf.slice(0, 22).toString('latin1');
if (head.indexOf('AutoCAD Binary DXF') === 0) {
  console.error('这是二进制 DXF，请先在本机 CAD 中另存为 ASCII DXF。');
  process.exit(1);
}

let payload;
try {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  payload = { text, encoding: 'UTF-8' };
} catch (e) {
  payload = { base64: buf.toString('base64'), encoding: '自动检测 (GBK/ANSI)' };
}

const templatePath = path.join(__dirname, 'DXF查看器.html');
if (!fs.existsSync(templatePath)) {
  console.error('找不到模板 DXF查看器.html，请先运行: node build.js');
  process.exit(1);
}
let html = fs.readFileSync(templatePath, 'utf8');
const name = path.basename(input);
const data = Object.assign({ name: name, size: stat.size, inline: true }, payload);
const json = JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const inject = '<script>window.__DXF_INLINE__ = ' + json + ';</script>\n';
const at = html.indexOf('<script>');
if (at < 0) { console.error('模板结构异常：未找到 <script> 标记'); process.exit(1); }
html = html.slice(0, at) + inject + html.slice(at);

const out = process.argv[3] || path.join(path.dirname(path.resolve(input)),
  path.basename(input, path.extname(input)) + '.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成: ' + out);
console.log('  源 DXF : ' + (stat.size / 1024).toFixed(1) + ' KB, ' + data.encoding);
console.log('  输出   : ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
console.log('双击该 HTML 即可直接看到图纸（无需选择文件、无需联网）。');
