// CityView low-zoom painters (view.md 3.4): CV.lowGround fills a chunk's ground through the inverse projection,
// CV.boxBuilding draws a building as lit walls and a roof (with window rows) at any scale, CV.lowLights draws its
// lit windows for the night layer, CV.tilePattern is the colour of a tile code at low zoom. Until V2's art API
// lands (v3-art-api) this file also holds fallbacks for CV.spriteBox, spriteKey, paletteOf, heightOf and
// signTextOf with protoR's bounds; each is defined only when V2's is missing. Classic script; no random numbers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const shade = (c, k) => CV.color.shade(c, k);
  const hash2 = (a, b) => CV.hash2(a, b);
  const fnv = s => CV.fnv ? CV.fnv(s) : CV.color.hash(String(s));
  let isoDefault = null;
  const projOr = proj => proj || isoDefault || (isoDefault = CV.makeIso(1, 1, 0));
  const sidOf = p => p.variant == null ? p.id : p.style + "#" + p.variant;

  // --- V2 API fallbacks (view.md 4.5) --------------------------------------------------------------------
  // spriteBox: art.building's bounds as pure geometry (protoR, 0 mismatches over 1,031 buildings).
  if (!CV.spriteBox) CV.spriteBox = function (p, look, proj) {
    const P = projOr(proj), STYLE = CV.STYLE || {};
    const st = STYLE[p.style] || STYLE.house || { floorPx: 26, roof: "gable", roofPx: 30 };
    const floors = Math.max(1, p.floors || (CV.FLOORS && CV.FLOORS[p.style]) || 1);
    const flatTop = st.roof === "flat" || st.roof === "glass" || st.roof === "saw";
    const Hh = floors * st.floorPx + (p.style === "house" ? 0 : 4) + (st.fascia || 0);
    const Hw = Hh + (flatTop ? 4 : 0);
    const extra = (st.roofPx || 0) + (p.style === "factory" ? 96 : p.style === "city_hall" ? 70 : p.style === "tower" ? 62 : p.style === "apartments" ? 34 : p.style === "school" ? 26 : p.style === "diner" ? 30 : 16);
    const topZ = Hw + extra;
    const fx0 = p.x - 0.25, fy0 = p.y - 0.25, fx1 = p.x + p.w + 0.25, fy1 = p.y + p.h + 0.25;
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const [a, b] of [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]]) for (const z of [0, topZ]) {
      const q = P.toWorld(a, b, z);
      if (q[0] < bx0) bx0 = q[0]; if (q[0] > bx1) bx1 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[1] > by1) by1 = q[1];
    }
    bx0 -= 6; bx1 += 6; by0 -= 6; by1 += 4;
    const ox = Math.floor(bx0), oy = Math.floor(by0), roofTop = Hw + (st.roofPx || 0);
    return { ox, oy, w: Math.ceil(bx1) - ox, h: Math.ceil(by1) - oy, height: roofTop, labelZ: roofTop + (p.style === "city_hall" ? 50 : p.style === "factory" ? 20 : 10) };
  };
  if (!CV.signTextOf) CV.signTextOf = p => p.style === "apartments" || p.style === "residential_tower" ? String(p.name || "").split(" ")[0].toUpperCase()
    : p.style === "tower" && /brightline/i.test(p.name || "") ? "BRIGHTLINE" : "";
  const lookSigOf = look => !look ? "-" : [look.stage | 0, look.works ? 1 : 0, (look.units || []).map(u => (u.vacant ? "v" : "o") + (u.listing ? "l" : "")).join("")].join(":");
  CV.lookSigOf = CV.lookSigOf || lookSigOf;
  if (!CV.spriteKey) CV.spriteKey = (p, look, season) => [p.style, p.w, p.h, p.floors, p.face, p.variant == null ? p.id : p.variant, lookSigOf(look), season, CV.signTextOf(p)].join("|");
  const HOUSE_PAINT = ["#f2dfbd", "#cfe0ea", "#efcab2", "#d6e6c6", "#f3e6a8", "#ecd0dc", "#e4ddcf", "#c3d7ec"];
  const HOUSE_ROOF = ["#a8463a", "#8a4a32", "#5a5f6a", "#7a3f2e", "#6a5040"];
  // styles V2 adds (until it lands): a wall colour and roof kind each, so boxes read by district
  const EXTRA = { shop: ["#e6d2b8", "flat"], restaurant: ["#ecd8c0", "flat"], row_houses: [null, "gable"], warehouse: ["#a9a596", "gable"],
    residential_tower: ["#9a5a44", "flat"], station: ["#d8d0c0", "flat"], hotel: ["#c9c2b4", "flat"], stadium: ["#c8ccd2", "flat"],
    cinema: ["#5a4a6a", "flat"], library: ["#cdbb9a", "flat"], police: ["#5a6a8a", "flat"], fire_station: ["#b84a3a", "flat"],
    mall: ["#d6d0c6", "flat"], clubhouse: ["#e6dcc6", "gable"] };
  if (!CV.paletteOf) CV.paletteOf = function (p) {
    const STYLE = CV.STYLE || {}, st = STYLE[p.style], ex = EXTRA[p.style], h0 = fnv(sidOf(p));
    const wall = st && st.wall ? (Array.isArray(st.wall) ? st.wall[h0 % st.wall.length] : st.wall) : ex && ex[0] ? ex[0] : HOUSE_PAINT[h0 % HOUSE_PAINT.length];
    const kind = st ? (st.roof === "gable" || st.roof === "hip" ? "gable" : "flat") : ex ? ex[1] : "gable";
    const roof = st && st.roofC ? st.roofC : kind === "gable" ? HOUSE_ROOF[(h0 >>> 4) % HOUSE_ROOF.length] : shade(wall, 0.62);
    return { wall, roof, roof_kind: kind, glass: p.style === "tower" ? "#9cc4e4" : "#8fb3d9", trim: "#ffffff" };
  };
  if (!CV.heightOf) CV.heightOf = (p, proj) => CV.spriteBox(p, null, proj).height;

  // --- low-zoom ground --------------------------------------------------------------------------------
  // Colour of a tile code at low zoom, by season (area averages of the L1 tiles, measured once by eye).
  const BASE = { ".": [116, 169, 61], "T": [64, 116, 46], "F": [176, 160, 90], "#": [92, 95, 102], "b": [118, 116, 118], "x": [102, 98, 96],
    "H": [128, 128, 126], "h": [140, 138, 134], "~": [63, 120, 181], "P": [98, 160, 58], "B": [170, 165, 150], "D": [170, 165, 150],
    "e": [200, 195, 180], "=": [116, 100, 84], "r": [104, 92, 80], "S": [184, 176, 160] };
  const SEASONED = { ".": 1, "T": 1, "P": 1, "F": 1 };
  const TINT = { spring: [1.0, 1.04, 1.0], summer: [1, 1, 1], autumn: [1.32, 0.95, 0.72], winter: null };
  const SNOW = { ".": [212, 222, 220], "T": [176, 192, 188], "P": [204, 216, 212], "F": [222, 228, 224] };
  CV.tilePattern = function (code, v, season) {
    const base = BASE[code] || BASE["."];
    if (!SEASONED[code]) return base;
    if (season === "winter") return SNOW[code] || base;
    const t = TINT[season] || TINT.summer;
    return [Math.min(255, base[0] * t[0]), Math.min(255, base[1] * t[1]), Math.min(255, base[2] * t[2])];
  };
  // The ground of the world rect [wx0, wx0 + size / level) x [wy0, ...) into q's (0, 0, size, size): one pixel per
  // device pixel through the inverse projection (affine, so it steps per pixel), noise by hash2 per tile.
  CV.lowGround = function (q, R, proj, level, wx0, wy0, size, season, py0, py1) {
    py0 = py0 || 0; py1 = py1 == null ? size : py1;
    const img = q.createImageData(size, py1 - py0), d = img.data, W = R.w, H = R.h, code = R.code;
    const t0 = proj.toTile(wx0, wy0), t1 = proj.toTile(wx0 + 1, wy0), t2 = proj.toTile(wx0, wy0 + 1);
    const ax = (t1[0] - t0[0]) / level, ay = (t1[1] - t0[1]) / level, bx = (t2[0] - t0[0]) / level, by = (t2[1] - t0[1]) / level;
    const pal = paletteTable(R, season);
    let o = 0;
    for (let py = py0; py < py1; py++) {
      let tx = t0[0] + bx * (py + 0.5) + ax * 0.5, ty = t0[1] + by * (py + 0.5) + ay * 0.5;
      for (let px = 0; px < size; px++, tx += ax, ty += ay, o += 4) {
        const ix = Math.floor(tx), iy = Math.floor(ty);
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
        const k = (code[iy * W + ix] * 8 + (noise(R, ix, iy))) * 3;
        d[o] = pal[k]; d[o + 1] = pal[k + 1]; d[o + 2] = pal[k + 2]; d[o + 3] = 255;
      }
    }
    q.putImageData(img, 0, py0);
  };
  // per-tile noise 0..7 (hash2, cached per region) and the colour of every code x noise, per season
  function noise(R, x, y) {
    if (!R._noise) { const n = R._noise = new Uint8Array(R.w * R.h); for (let yy = 0; yy < R.h; yy++) for (let xx = 0; xx < R.w; xx++) n[yy * R.w + xx] = hash2(xx, yy) & 7; }
    return R._noise[y * R.w + x];
  }
  function paletteTable(R, season) {
    R._pal = R._pal || {};
    if (R._pal[season]) return R._pal[season];
    const n = Math.max(16, Object.keys(R.CODE).length), out = new Uint8ClampedArray(n * 8 * 3);
    for (const [ch, k] of Object.entries(R.CODE)) {
      const b = CV.tilePattern(ch, 0, season);
      for (let z = 0; z < 8; z++) { out[(k * 8 + z) * 3] = b[0] + z - 4; out[(k * 8 + z) * 3 + 1] = b[1] + z - 4; out[(k * 8 + z) * 3 + 2] = b[2] + z - 4; }
    }
    return (R._pal[season] = out);
  }

  // --- boxes -----------------------------------------------------------------------------------------
  // q: a context; b: R's building {p, sid, ...}; k: device px per world px; (ox, oy): the world point at q's
  // origin. o: {proj, windows: 0 none | 1 every floor | 2 every 2nd floor}. Walls on the faces the camera sees,
  // gable or flat roof by paletteOf, at heightOf over bodyOf.
  const faceEdge = (f, x0, y0, x1, y1) => f === "s" ? [[x0, y1], [x1, y1]] : f === "e" ? [[x1, y1], [x1, y0]] : f === "n" ? [[x1, y0], [x0, y0]] : [[x0, y0], [x0, y1]];
  function poly(q, pts, c) { q.fillStyle = c; q.beginPath(); q.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) q.lineTo(pts[i][0], pts[i][1]); q.closePath(); q.fill(); }
  function boxGeo(b, proj) {
    if (b.geo && b.geo.proj === proj) return b.geo;
    const p = b.p, kp = b.kp || (b.kp = Object.assign({}, p, { variant: b.variant }));
    const pal = CV.paletteOf(kp), bd = CV.bodyOf(p);
    const h = Math.max(8, CV.heightOf(kp, proj) || 20);
    const STYLE = CV.STYLE || {}, st = STYLE[p.style];
    const fp = st && st.floorPx ? st.floorPx : p.style === "row_houses" || p.style === "house" ? 26 : 22;
    const gable = pal.roof_kind === "gable" && (p.floors || 1) <= 3;
    b.geo = { proj, pal, bd, h, fp, gable, top: gable ? h * 0.62 : h, nf: Math.max(1, Math.round((gable ? h * 0.62 : h) / fp)) };
    return b.geo;
  }
  CV.boxBuilding = function (q, b, k, ox, oy, o) {
    o = o || {};
    const proj = projOr(o.proj), G = boxGeo(b, proj), { pal, bd, h, top, gable } = G;
    const P = (x, y, z) => { const r = proj.toWorld(x, y, z); return [(r[0] - ox) * k, (r[1] - oy) * k]; };
    const x0 = bd.x0, y0 = bd.y0, x1 = bd.x1, y1 = bd.y1;
    const faces = proj.faces;
    faces.forEach((f, i) => {
      const [[a, c], [e, g]] = faceEdge(f, x0, y0, x1, y1);
      poly(q, [P(a, c, 0), P(e, g, 0), P(e, g, top), P(a, c, top)], i === 0 ? pal.wall : shade(pal.wall, 0.78));
    });
    if (gable) { // ridge along the longer side
      const alongX = (x1 - x0) >= (y1 - y0);
      if (alongX) { const ym = (y0 + y1) / 2; poly(q, [P(x0, y0, top), P(x1, y0, top), P(x1, ym, h), P(x0, ym, h)], shade(pal.roof, 0.82)); poly(q, [P(x0, y1, top), P(x1, y1, top), P(x1, ym, h), P(x0, ym, h)], pal.roof); }
      else { const xm = (x0 + x1) / 2; poly(q, [P(x0, y0, top), P(x0, y1, top), P(xm, y1, h), P(xm, y0, h)], shade(pal.roof, 0.82)); poly(q, [P(x1, y0, top), P(x1, y1, top), P(xm, y1, h), P(xm, y0, h)], pal.roof); }
    } else poly(q, [P(x0, y0, top), P(x1, y0, top), P(x1, y1, top), P(x0, y1, top)], pal.roof);
    if (o.windows) windows(q, b, G, P, faces, o.windows, null, null);
  };
  // window rows: every floor (step 1) or every 2nd (step 2); lit: a predicate (k) -> bool to draw only lit ones
  function windows(q, b, G, P, faces, step, lit, color) {
    const { bd, top, fp, nf, pal } = G, x0 = bd.x0, y0 = bd.y0, x1 = bd.x1, y1 = bd.y1;
    q.fillStyle = color || shade(pal.wall, 0.55);
    let n = 0;
    for (let f = 0; f < nf; f += step) {
      const z = f * fp + fp * 0.35, z2 = Math.min(top - 1, z + fp * 0.4);
      for (const face of faces) {
        const [[a, c], [e, g]] = faceEdge(face, x0, y0, x1, y1), len = Math.hypot(e - a, g - c);
        for (let t = 0.2; t < len - 0.2; t += 0.5, n++) {
          if (lit && !lit(n)) continue;
          const u = t / len, u2 = (t + 0.25) / len;
          const A = P(a + (e - a) * u, c + (g - c) * u, z), C = P(a + (e - a) * u2, c + (g - c) * u2, z2);
          q.fillRect(Math.min(A[0], C[0]), Math.min(A[1], C[1]), Math.max(1, Math.abs(C[0] - A[0])), Math.max(1, Math.abs(C[1] - A[1])));
        }
      }
    }
    return n;
  }
  // Lit windows of a building for the night layer: window n is lit when hash2(n, building) % 100 < share.
  CV.lowLights = function (q, b, k, ox, oy, share, o) {
    o = o || {};
    if (share <= 0) return;
    const proj = projOr(o.proj), G = boxGeo(b, proj);
    const P = (x, y, z) => { const r = proj.toWorld(x, y, z); return [(r[0] - ox) * k, (r[1] - oy) * k]; };
    const id = b.i | 0;
    windows(q, b, G, P, proj.faces, o.step || 1, n => hash2(n, id) % 100 < share, o.color || "#ffd27a");
  };
  // The share of a building's windows lit at a minute of the day (view.md 3.4): offices 70% until 19:00, then
  // 15%; homes by occupancy (else 5%, 17% late); shops until closing; decor by kind. Shares change per hour bucket.
  CV.lightShare = function (b, minute, occ) {
    const h = ((minute || 0) / 60) % 24, p = b.p, late = h >= 23 || h < 5, dawn = h >= 5 && h < 7;
    if (h >= 7 && h < 17) return 0;
    const office = p.kind === "office" || p.style === "tower" || p.style === "hotel";
    if (office) return h >= 17 && h < 19 ? 70 : late ? 8 : 15;
    if (p.kind === "home") { if (occ != null) return occ > 0 ? (late ? 17 : 55) : 5; return late ? 6 : dawn ? 20 : 40; }
    if (p.hours) return h >= p.hours[0] && h < p.hours[1] ? 60 : 4;
    return late ? 4 : 25;
  };
  CV.lightBucket = minute => { const h = ((minute || 0) / 60) % 24; return h >= 7 && h < 17 ? 0 : h >= 17 && h < 19 ? 1 : h >= 19 && h < 23 ? 2 : h >= 5 && h < 7 ? 4 : 3; };
  // A tree at low zoom: a blob.
  CV.lowTree = function (q, x, y, r, season) {
    q.fillStyle = season === "winter" ? "#9aa8a4" : season === "autumn" ? "#a8622a" : "#3f6f2a";
    q.fillRect(Math.round(x - r), Math.round(y - 2 * r), Math.max(1, Math.round(2 * r)), Math.max(1, Math.round(2 * r)));
  };
})();
