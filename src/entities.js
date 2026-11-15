/* ==========================================================================
 * Entity -> drawing primitive expansion.
 * Supports the full common DXF 2D entity set plus blocks, dimensions,
 * hatches, splines, ellipses, multilines and construction lines.
 * ========================================================================== */

var STRUCTURAL = {
  SECTION: 1, ENDSEC: 1, TABLE: 1, ENDTAB: 1, BLOCK: 1, ENDBLK: 1,
  SEQEND: 1, VERTEX: 1, CLASS: 1, ENDBLK: 1
};

function noteSkip(state, key) {
  state.stats.skipped[key] = (state.stats.skipped[key] || 0) + 1;
}

function p3(rec, xc, yc, zc) {
  return [n(g(rec, xc, 0), 0), n(g(rec, yc, 0), 0), n(g(rec, zc, 0), 0)];
}

function expandTextEntity(rec, ctx, state, type) {
  var meta = metaFrom(rec, ctx, state, type);
  var isM = (type === 'MTEXT');
  var raw = '';
  if (isM) {
    for (var i = 0; i < rec.pairs.length; i++) {
      if (rec.pairs[i][0] === 1 || rec.pairs[i][0] === 3) raw += s(rec.pairs[i][1]);
    }
  } else {
    raw = s(g(rec, 1, ''));
    if (!raw && type === 'ATTDEF') raw = s(g(rec, 2, ''));
  }
  var text = cleanText(raw, isM);
  if (!text) return;
  var styleName = s(g(rec, 7, 'STANDARD'), 'STANDARD');
  var style = state.doc.tables.style[styleName] || state.doc.tables.style['STANDARD'];
  var h = n(g(rec, 40, 0), 0);
  if (h <= 0) h = (style && style.height > 0) ? style.height : 2.5;
  /* For TEXT group 41 is the width factor; for MTEXT it is the reference
   * (wrapping) width and must never be used as a horizontal text scale. */
  var wf = isM ? 1 : (n(g(rec, 41, 1), 1) || 1);
  if (style && style.width) wf *= style.width;
  /* MTEXT and TEXT reuse several group codes with DIFFERENT meanings:
   *   71  TEXT  = generation flags (2 = backward, 4 = upside down)
   *       MTEXT = attachment point 1..9  (5 = middle-centre, very common)
   *   11/21  TEXT  = second alignment point (used when 72/73 are set)
   *          MTEXT = X-axis DIRECTION VECTOR, not a position!
   * Treating MTEXT 71 as a mirror flag used to flip every dimension value
   * upside down; using MTEXT 11/21 as the insertion point moved all such
   * text to the world origin, which is why vertical dimensions lost their
   * labels entirely. */
  var rot = n(g(rec, 50, 0), 0) * Math.PI / 180;
  if (isM) {
    var dvx = n(g(rec, 11, 0), 0), dvy = n(g(rec, 21, 0), 0);
    /* Many CAD writers leave group 50 at 0 and encode the text angle only
     * in the direction vector (aligned / rotated dimensions do this). */
    var aDir = (dvx || dvy) ? Math.atan2(dvy, dvx) : 0;
    if (aDir) rot = aDir;
  }
  rot += ctx.rotation;
  var hJust = isM ? 0 : n(g(rec, 72, 0), 0);
  var vJust = isM ? 0 : n(g(rec, 73, 0), 0);
  var genFlags = isM ? 0 : n(g(rec, 71, 0), 0);
  var attach = isM ? n(g(rec, 71, 1), 1) : 1;
  /* MTEXT is always anchored at 10/20/30; only justified TEXT uses 11/21. */
  var p1 = p3(rec, 10, 20, 30);
  var hasSecond = !isM && g(rec, 11) !== undefined;
  var p2 = hasSecond ? p3(rec, 11, 21, 31) : p1;
  var pos = (hasSecond && (hJust || vJust)) ? p2 : p1;
  emit(state, {
    kind: 'text',
    pos: toWorld(pos, rec, ctx),
    text: text,
    lines: text.split('\n'),
    height: h * ctx.scaleAvg,
    widthFactor: wf,
    rot: rot,
    hJust: hJust,
    vJust: vJust,
    attach: attach,
    lineSpacing: isM ? n(g(rec, 44, 1), 1) : 1,
    refWidth: isM ? n(g(rec, 41, 0), 0) * ctx.scaleAvg : 0,
    mirrorX: !!(genFlags & 2),
    mirrorY: !!(genFlags & 4),
    mtext: isM,
    color: meta.color, layer: meta.layer, linetype: meta.linetype,
    lw: meta.lw, ltscale: 1, worldWidth: 0,
    type: type, handle: meta.handle, source: meta.source
  });
}

function parseHatchPaths(rec) {
  var paths = [], cur = null, last = null;
  for (var i = 0; i < rec.pairs.length; i++) {
    var c = rec.pairs[i][0], v = rec.pairs[i][1];
    if (c === 92) {
      cur = { flags: n(v), pts: [] };
      paths.push(cur);
      last = null;
    } else if (c === 98) {
      cur = null; last = null;                  /* seed-point section starts */
    } else if (!cur) {
      continue;
    } else if (c === 10 || c === 11) {
      last = { x: n(v), y: 0, e42: 0 };
      cur.pts.push(last);
    } else if ((c === 20 || c === 21) && last) {
      last.y = n(v);
    } else if (c === 42 && last) {
      last.e42 = n(v);
    } else if (c === 40 && last) {
      /* ARC edge radius: keep as a straight chord approximation */
      last.radius = n(v);
    }
  }
  return paths.filter(function (p) { return p.pts.length >= 3; });
}

function expandInsert(rec, ctx, state, depth) {
  var name = s(g(rec, 2, '')).toUpperCase();
  var block = state.doc.blocks[name];
  if (!block) { noteSkip(state, 'INSERT \u2192 ' + s(g(rec, 2, '?'))); return; }
  if (depth >= 10) { state.warnings.push('块嵌套超过 10 层，已截断'); return; }
  var meta = metaFrom(rec, ctx, state, 'INSERT');
  state.stats.blockInserts++;
  var cols = Math.max(1, Math.round(n(g(rec, 70, 1), 1)));
  var rows = Math.max(1, Math.round(n(g(rec, 71, 1), 1)));
  var csp = n(g(rec, 44, 0), 0), rsp = n(g(rec, 45, 0), 0);
  var rot = n(g(rec, 50, 0), 0);
  var sx = n(g(rec, 41, 1), 1) || 1, sy = n(g(rec, 42, 1), 1) || 1;
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var xf = makeInsertXform(rec, block.base, c * csp, r * rsp);
      var outer = ctx.xform;
      var child = {
        xform: function (p) { return outer(xf(p)); },
        color: meta.color,
        layer: meta.layer,
        linetype: meta.linetype,
        lineweight: meta.lw,
        rotation: ctx.rotation + rot * Math.PI / 180,
        scaleAvg: ctx.scaleAvg * Math.sqrt(Math.abs(sx * sy) || 1),
        depth: depth + 1
      };
      for (var i = 0; i < block.entities.length; i++) {
        expandEntity(block.entities[i], child, depth + 1, state);
      }
      var attribs = rec.attribs || [];
      for (var j = 0; j < attribs.length; j++) {
        expandTextEntity(attribs[j], child, state, 'ATTRIB');
      }
    }
  }
}

function expandDimension(rec, ctx, state, depth) {
  var blk = s(g(rec, 2, ''));
  var block = blk ? state.doc.blocks[blk.toUpperCase()] : null;
  if (block) {
    var child = {
      xform: ctx.xform,
      color: resolveColor(rec, state.doc, { layer: effectiveLayer(rec, ctx), color: ctx.color, dark: state.dark }),
      layer: effectiveLayer(rec, ctx),
      linetype: ctx.linetype,
      lineweight: ctx.lineweight,
      rotation: ctx.rotation,
      scaleAvg: ctx.scaleAvg,
      depth: depth + 1
    };
    for (var i = 0; i < block.entities.length; i++) {
      expandEntity(block.entities[i], child, depth + 1, state);
    }
    return;
  }
  /* Fallback for R12 dimensions without an anonymous block. */
  var meta = metaFrom(rec, ctx, state, 'DIMENSION');
  var def = toWorld([n(g(rec, 10, 0), 0), n(g(rec, 20, 0), 0), 0], rec, ctx);
  var a = toWorld([n(g(rec, 13, 0), 0), n(g(rec, 23, 0), 0), 0], rec, ctx);
  var b = toWorld([n(g(rec, 14, 0), 0), n(g(rec, 24, 0), 0), 0], rec, ctx);
  var tp = toWorld([n(g(rec, 11, 0), 0), n(g(rec, 21, 0), 0), 0], rec, ctx);
  if (a[0] || a[1]) pushLine(state, [a, def], meta, false);
  if (b[0] || b[1]) pushLine(state, [b, def], meta, false);
  pushLine(state, [a, b], meta, false);
  var h = Math.max(2.5, state.doc.tables.dimstyle &&
    state.doc.tables.dimstyle['STANDARD'] ? 2.5 : 2.5);
  emit(state, {
    kind: 'text', pos: tp, text: cleanText(s(g(rec, 1, '<>')), false) || '<>',
    lines: [cleanText(s(g(rec, 1, '<>')), false) || '<>'],
    height: h * ctx.scaleAvg, widthFactor: 1, rot: ctx.rotation,
    hJust: 1, vJust: 0, attach: 1, lineSpacing: 1, refWidth: 0,
    mirrorX: false, mirrorY: false, mtext: false,
    color: meta.color, layer: meta.layer, linetype: 'CONTINUOUS',
    lw: meta.lw, ltscale: 1, worldWidth: 0,
    type: 'DIMENSION', handle: meta.handle, source: meta.source
  });
}

function expandMLine(rec, ctx, state) {
  var pts = collectPoints(rec, 10, 20, 30, []);
  if (pts.length < 2) return;
  var meta = metaFrom(rec, ctx, state, 'MLINE');
  var scale = n(g(rec, 40, 1), 1) || 1;
  var offsets = ga(rec, 49).map(function (v) { return n(v) * scale; });
  if (!offsets.length) offsets = [-0.5, 0.5];
  var joints = pts.map(function (p) { return [p.x, p.y]; });
  for (var k = 0; k < offsets.length; k++) {
    var line = [];
    for (var i = 0; i < joints.length; i++) {
      var prev = joints[Math.max(0, i - 1)], next = joints[Math.min(joints.length - 1, i + 1)];
      var dx = next[0] - prev[0], dy = next[1] - prev[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var q = toWorld([joints[i][0] - dy / len * offsets[k],
                       joints[i][1] + dx / len * offsets[k], 0], rec, ctx);
      line.push(q);
    }
    pushLine(state, line, meta, false);
  }
  /* end caps */
  var flags = n(g(rec, 71, 0), 0);
  if (flags & 1) {
    var e0 = offsets[0], e1 = offsets[offsets.length - 1];
    var a = pts[0], b = pts[1], dx0 = b.x - a.x, dy0 = b.y - a.y;
    var l0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
    pushLine(state, [
      toWorld([a.x - dy0 / l0 * e0, a.y + dx0 / l0 * e0, 0], rec, ctx),
      toWorld([a.x - dy0 / l0 * e1, a.y + dx0 / l0 * e1, 0], rec, ctx)
    ], meta, false);
  }
}

function expandInfiniteLine(rec, ctx, state, type) {
  var meta = metaFrom(rec, ctx, state, type);
  var origin = toWorld(p3(rec, 10, 20, 30), rec, ctx);
  var dv = ocsToWcs([n(g(rec, 11, 1), 1), n(g(rec, 21, 0), 0), n(g(rec, 31, 0), 0)], getAxes(rec));
  var zero = ctx.xform([0, 0, 0]);
  var moved = ctx.xform(dv);
  var dx = moved[0] - zero[0], dy = moved[1] - zero[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-12) return;
  emit(state, {
    kind: 'infinite', origin: origin, dir: [dx / len, dy / len], ray: type === 'RAY',
    color: meta.color, layer: meta.layer, linetype: meta.linetype, lw: meta.lw,
    ltscale: meta.ltscale, worldWidth: 0, type: type, handle: meta.handle,
    source: meta.source, noBounds: true, pts: []
  });
}

function expandFrame(rec, ctx, state, type) {
  var meta = metaFrom(rec, ctx, state, type);
  var pts;
  if (type === 'VIEWPORT') {
    var cx = n(g(rec, 10, 0), 0), cy = n(g(rec, 20, 0), 0);
    var w = n(g(rec, 40, 0), 0) / 2, h = n(g(rec, 41, 0), 0) / 2;
    if (!w || !h) return;
    pts = [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]];
    pushLine(state, toWorldPts(rec, ctx, pts, 0).concat([toWorld([cx - w, cy - h, 0], rec, ctx)]), meta, true);
    return;
  }
  if (type === 'WIPEOUT') {
    var wp = collectPoints(rec, 10, 20, null, []);
    if (wp.length < 3) return;
    var poly = polyWorld(rec, ctx, wp, true, 0);
    meta.color = '__BG__';
    pushFill(state, poly, meta);
    return;
  }
  /* IMAGE: draw its bounding frame (the raster itself is not stored in DXF). */
  var p = p3(rec, 10, 20, 30);
  var u = [n(g(rec, 11, 1), 1), n(g(rec, 21, 0), 0), 0];
  var v = [n(g(rec, 12, 0), 0), n(g(rec, 22, 1), 1), 0];
  var iw = n(g(rec, 13, 1), 1), ih = n(g(rec, 23, 1), 1);
  var a = [p[0], p[1], 0];
  var b = [p[0] + u[0] * iw, p[1] + u[1] * iw, 0];
  var c = [p[0] + u[0] * iw + v[0] * ih, p[1] + u[1] * iw + v[1] * ih, 0];
  var d = [p[0] + v[0] * ih, p[1] + v[1] * ih, 0];
  var world = [a, b, c, d, a].map(function (q) { return toWorld(q, rec, ctx); });
  pushLine(state, world, meta, true);
}

function expandEntity(rec, ctx, depth, state) {
  if (!rec || !rec.type) return;
  var t = rec.type;
  if (STRUCTURAL[t]) return;
  state.stats.byType[t] = (state.stats.byType[t] || 0) + 1;
  var meta, pts, closed, z, i, out;

  switch (t) {
    case 'LINE':
      meta = metaFrom(rec, ctx, state, 'LINE');
      pushLine(state, [
        toWorld(p3(rec, 10, 20, 30), rec, ctx),
        toWorld(p3(rec, 11, 21, 31), rec, ctx)
      ], meta, false);
      break;

    case 'LWPOLYLINE':
      pts = collectPoints(rec, 10, 20, null, [42]);
      if (pts.length < 2) break;
      closed = !!(n(g(rec, 70, 0), 0) & 1);
      meta = metaFrom(rec, ctx, state, 'LWPOLYLINE');
      var cw = n(g(rec, 43, 0), 0);
      if (cw > 0) meta.worldWidth = cw;
      out = polyWorld(rec, ctx, pts, closed, 0);
      if (closed && out.length > 2) out.push(out[0].slice());
      pushLine(state, out, meta, closed, {
        corners: pts.map(function (q) { return toWorld([q.x, q.y, q.z || 0], rec, ctx); })
      });
      break;

    case 'POLYLINE': {
      var flags = n(g(rec, 70, 0), 0);
      var verts = rec.vertices || [];
      meta = metaFrom(rec, ctx, state, 'POLYLINE');
      if (flags & 64) {
        /* Polyface mesh: VERTEX records with bit 7 (128) are face lists. */
        var coords = [], faces = [];
        for (i = 0; i < verts.length; i++) {
          var vf = n(g(verts[i], 70, 0), 0);
          if (vf & 128) {
            faces.push([n(g(verts[i], 71, 0)), n(g(verts[i], 72, 0)),
                        n(g(verts[i], 73, 0)), n(g(verts[i], 74, 0))]);
          } else {
            coords.push(p3(verts[i], 10, 20, 30));
          }
        }
        for (i = 0; i < faces.length; i++) {
          var poly = [], f = faces[i];
          for (var q = 0; q < 4; q++) {
            var ix = Math.abs(f[q]);
            if (!ix || !coords[ix - 1]) break;
            poly.push(toWorld(coords[ix - 1], rec, ctx));
            if (q === 3 || !f[q + 1]) break;
          }
          if (poly.length >= 3) pushFill(state, poly, meta);
        }
        break;
      }
      if (flags & 16) {
        var rows = Math.round(n(g(rec, 71, 0), 0));
        var cols = Math.round(n(g(rec, 72, 0), 0));
        if (rows > 1 && cols > 1 && verts.length >= rows * cols) {
          var rr, cc, line;
          for (rr = 0; rr < rows; rr++) {
            line = [];
            for (cc = 0; cc < cols; cc++) line.push(toWorld(p3(verts[rr * cols + cc], 10, 20, 30), rec, ctx));
            pushLine(state, line, meta, !!(flags & 1));
          }
          for (cc = 0; cc < cols; cc++) {
            line = [];
            for (rr = 0; rr < rows; rr++) line.push(toWorld(p3(verts[rr * cols + cc], 10, 20, 30), rec, ctx));
            pushLine(state, line, meta, !!(flags & 32));
          }
          break;
        }
      }
      var vp = [];
      for (i = 0; i < verts.length; i++) {
        vp.push({
          x: n(g(verts[i], 10, 0), 0), y: n(g(verts[i], 20, 0), 0),
          z: n(g(verts[i], 30, 0), 0), e42: n(g(verts[i], 42, 0), 0)
        });
      }
      if (vp.length < 2) break;
      var pclosed = !!(flags & 1);
      out = polyWorld(rec, ctx, vp, pclosed, 0);
      if (pclosed && out.length > 2) out.push(out[0].slice());
      pushLine(state, out, meta, pclosed, {
        corners: vp.map(function (q) { return toWorld([q.x, q.y, q.z], rec, ctx); })
      });
      break;
    }

    case 'CIRCLE': {
      var cr = n(g(rec, 40, 0), 0);
      if (cr <= 0) break;
      z = n(g(rec, 30, 0), 0);
      meta = metaFrom(rec, ctx, state, 'CIRCLE');
      var ccx = n(g(rec, 10, 0), 0), ccy = n(g(rec, 20, 0), 0);
      out = toWorldPts(rec, ctx, circlePts(ccx, ccy, cr, 64), z);
      pushLine(state, out, meta, true, {
        center: toWorld([ccx, ccy, z], rec, ctx), radius: cr * ctx.scaleAvg
      });
      break;
    }

    case 'ARC': {
      var ar = n(g(rec, 40, 0), 0);
      if (ar <= 0) break;
      var a0 = n(g(rec, 50, 0), 0), a1 = n(g(rec, 51, 0), 0);
      var sweep = a1 - a0;
      while (sweep <= 0) sweep += 360;
      if (sweep > 360) sweep = 360;
      var segs = Math.max(8, Math.min(180, Math.ceil(sweep / 5)));
      var acx = n(g(rec, 10, 0), 0), acy = n(g(rec, 20, 0), 0);
      z = n(g(rec, 30, 0), 0);
      var ap = [];
      for (i = 0; i <= segs; i++) {
        var aa = (a0 + sweep * i / segs) * Math.PI / 180;
        ap.push([acx + ar * Math.cos(aa), acy + ar * Math.sin(aa)]);
      }
      meta = metaFrom(rec, ctx, state, 'ARC');
      pushLine(state, toWorldPts(rec, ctx, ap, z), meta, false, {
        center: toWorld([acx, acy, z], rec, ctx), radius: ar * ctx.scaleAvg,
        startAngle: a0, endAngle: a0 + sweep
      });
      break;
    }

    case 'ELLIPSE': {
      var ec = p3(rec, 10, 20, 30);
      var maj = [n(g(rec, 11, 0), 0), n(g(rec, 21, 0), 0), n(g(rec, 31, 0), 0)];
      var la = Math.sqrt(maj[0] * maj[0] + maj[1] * maj[1] + maj[2] * maj[2]);
      if (la < 1e-12) break;
      var ratio = Math.abs(n(g(rec, 40, 1), 1));
      var ux = maj[0] / la, uy = maj[1] / la, uz = maj[2] / la;
      var vx = -uy, vy = ux, vz = 0;
      var t0 = n(g(rec, 41, 0), 0), t1 = n(g(rec, 42, Math.PI * 2), Math.PI * 2);
      var tsweep = t1 - t0;
      while (tsweep <= 0) tsweep += Math.PI * 2;
      if (tsweep > Math.PI * 2) tsweep = Math.PI * 2;
      var esteps = Math.max(24, Math.min(240, Math.ceil(tsweep / (Math.PI / 48))));
      var ep = [];
      for (i = 0; i <= esteps; i++) {
        var tt = t0 + tsweep * i / esteps;
        var co = Math.cos(tt) * la, si = Math.sin(tt) * la * ratio;
        ep.push([ec[0] + co * ux + si * vx, ec[1] + co * uy + si * vy, ec[2] + co * uz + si * vz]);
      }
      meta = metaFrom(rec, ctx, state, 'ELLIPSE');
      pushLine(state, ep.map(function (q) { return toWorld(q, rec, ctx); }), meta, tsweep >= Math.PI * 2 - 1e-6);
      break;
    }

    case 'SPLINE':
      out = splinePoints(rec);
      if (out.length < 2) break;
      meta = metaFrom(rec, ctx, state, 'SPLINE');
      pushLine(state, toWorldPts(rec, ctx, out, 0), meta, !!(n(g(rec, 70, 0), 0) & 1));
      break;

    case 'POINT':
      meta = metaFrom(rec, ctx, state, 'POINT');
      emit(state, {
        kind: 'point', pos: toWorld(p3(rec, 10, 20, 30), rec, ctx),
        height: 0, text: '', color: meta.color, layer: meta.layer,
        linetype: meta.linetype, lw: meta.lw, ltscale: 1, worldWidth: 0,
        type: 'POINT', handle: meta.handle, source: meta.source
      });
      break;

    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      meta = metaFrom(rec, ctx, state, t);
      var corners = [p3(rec, 10, 20, 30), p3(rec, 11, 21, 31), p3(rec, 12, 22, 32)];
      var fourth = g(rec, 13) !== undefined ? p3(rec, 13, 23, 33) : corners[2].slice();
      corners.push(fourth);
      var order = (t === '3DFACE') ? [0, 1, 2, 3] : [0, 1, 3, 2];
      pushFill(state, order.map(function (k) { return toWorld(corners[k], rec, ctx); }), meta);
      break;
    }

    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'MTEXT':
      expandTextEntity(rec, ctx, state, t);
      break;

    case 'INSERT':
      expandInsert(rec, ctx, state, depth);
      break;

    case 'DIMENSION':
    case 'ARC_DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
      expandDimension(rec, ctx, state, depth);
      break;

    case 'HATCH': {
      var paths = parseHatchPaths(rec);
      if (!paths.length) { noteSkip(state, 'HATCH (no boundary)'); break; }
      var solid = !!(n(g(rec, 70, 0), 0) & 1);
      var hscale = n(g(rec, 41, 1), 1) || 1;
      var hangle = n(g(rec, 52, 0), 0);
      meta = metaFrom(rec, ctx, state, 'HATCH');
      for (i = 0; i < paths.length; i++) {
        var wp = polyWorld(rec, ctx, paths[i].pts, true, 0);
        if (wp.length < 3) continue;
        if (solid) {
          pushFill(state, wp, meta);
        } else {
          pushLine(state, wp.concat([wp[0].slice()]), meta, true);
          var segs2 = hatchSegments(wp, hangle, Math.abs(hscale) * 2.5, 240);
          for (var j = 0; j < segs2.length; j++) pushLine(state, segs2[j], meta, false);
        }
      }
      break;
    }

    case 'LEADER':
    case 'MLEADER': {
      meta = metaFrom(rec, ctx, state, t);
      var lp = collectPoints(rec, 10, 20, null, []);
      if (lp.length >= 2) {
        var lw = lp.map(function (p) { return toWorld([p.x, p.y, 0], rec, ctx); });
        pushLine(state, lw, meta, false);
        var e0 = lw[lw.length - 2], e1 = lw[lw.length - 1];
        var ang = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]);
        var segLen = Math.sqrt((e1[0] - e0[0]) * (e1[0] - e0[0]) + (e1[1] - e0[1]) * (e1[1] - e0[1]));
        var tip = Math.max(1e-6, Math.min(segLen * 0.22, 12));
        pushLine(state, [
          e1,
          [e1[0] - tip * Math.cos(ang - 0.35), e1[1] - tip * Math.sin(ang - 0.35)]
        ], meta, false);
        pushLine(state, [
          e1,
          [e1[0] - tip * Math.cos(ang + 0.35), e1[1] - tip * Math.sin(ang + 0.35)]
        ], meta, false);
      }
      if (t === 'MLEADER') {
        var mt = cleanText(s(g(rec, 1, '')) || s(g(rec, 3, '')), true);
        if (mt && lp.length) {
          emit(state, {
            kind: 'text', pos: toWorld([lp[lp.length - 1].x, lp[lp.length - 1].y, 0], rec, ctx),
            text: mt, lines: mt.split('\n'), height: (n(g(rec, 40, 2.5), 2.5) || 2.5) * ctx.scaleAvg,
            widthFactor: 1, rot: ctx.rotation, hJust: 0, vJust: 0, attach: 1,
            lineSpacing: 1, refWidth: 0, mirrorX: false, mirrorY: false, mtext: false,
            color: meta.color, layer: meta.layer, linetype: 'CONTINUOUS', lw: meta.lw,
            ltscale: 1, worldWidth: 0, type: t, handle: meta.handle, source: meta.source
          });
        }
      }
      break;
    }

    case 'MLINE':
      expandMLine(rec, ctx, state);
      break;

    case 'XLINE':
    case 'RAY':
      expandInfiniteLine(rec, ctx, state, t);
      break;

    case 'IMAGE':
    case 'WIPEOUT':
    case 'VIEWPORT':
      expandFrame(rec, ctx, state, t);
      break;

    case 'TOLERANCE':
    case 'TABLE':
    case 'ACAD_TABLE':
    case '3DSOLID':
    case 'REGION':
    case 'BODY':
    case 'SURFACE':
    case 'EXTRUDEDSURFACE':
    case 'LOFTEDSURFACE':
    case 'REVOLVEDSURFACE':
    case 'SWEPTSURFACE':
    case 'HELIX':
    case 'LIGHT':
    case 'CAMERA':
    case 'UNDERLAY':
    case 'MESH':
    case 'GEOPOSITIONMARKER':
    case 'POSITIONMARKER':
    case 'SECTION':
    case 'SPATIAL_FILTER':
    case 'OLE2FRAME':
    case 'OLEFRAME':
    case 'RTEXT':
    case 'ARCALIGNEDTEXT':
    case 'MPOLYGON':
    case 'LAYOUT':
      noteSkip(state, t);
      break;

    default:
      noteSkip(state, t);
      break;
  }
}
