// CityView art: colour helpers, the crisp pixel primitives, palettes, ground tiles (grass, roads with
// sidewalks and markings, water, park paths, plazas, home lawns by neglect stage), trees and street props.
// Everything is procedural and drawn at base scale (1 art px = 1 world px at zoom 1) into small cached
// canvases; there are no image files. buildings.js and actors.js add their own drawers to the same art
// object through CityView._artParts. Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  CV._artParts = CV._artParts || [];

  // --- colour helpers ---------------------------------------------------------------------------
  const clamp8 = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  function hexRgb(h) {
    if (h[0] !== "#") return [128, 128, 128];
    if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    const n = parseInt(h.slice(1, 7), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const rgbHex = (r, g, b) => "#" + ((1 << 24) | (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)).toString(16).slice(1);
  const shade = (c, k) => { const [r, g, b] = hexRgb(c); return rgbHex(r * k, g * k, b * k); };
  const mix = (a, b, t) => { const p = hexRgb(a), q = hexRgb(b); return rgbHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t); };
  const rgba = (c, a) => { const [r, g, b] = hexRgb(c); return `rgba(${r},${g},${b},${a})`; };
  // Same FNV-1a as game.js, so colours picked by hash match the roster everywhere.
  function hash(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const f = n => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return rgbHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  // mulberry32: small deterministic stream for art variation.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  CV.color = { hexRgb, rgbHex, shade, mix, rgba, hash, hslHex, rng };
  CV.hash = hash;

  // Roster colours: the same formulas as game.js swatches.
  CV.shirt = id => `hsl(${hash(id) % 360} 65% 55%)`;
  CV.shirtHex = id => hslHex(hash(id) % 360, 65, 55);
  const HAIR = ["#3b2416", "#6b4423", "#1d1d1d", "#c9a14a", "#8a3b1c", "#b8b8b8"];
  CV.hair = id => HAIR[hash(id + "h") % 6];

  CV.STAGE_NAMES = ["kept", "worn", "shabby", "neglected", "derelict"];
  CV.stageOf = c => c >= 80 ? 0 : c >= 60 ? 1 : c >= 40 ? 2 : c >= 20 ? 3 : 4;

  // --- canvases and the crisp polygon fill ----------------------------------------------------------
  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  CV.canvas = canvas;

  // Convex polygon fill, one pixel column at a time: 2:1 edges come out as clean pixel staircases with
  // no anti-aliasing, and neighbouring polygons share edges with no gaps.
  function poly(g, pts, color) {
    if (color) g.fillStyle = color;
    let minX = Infinity, maxX = -Infinity;
    const n = pts.length;
    for (let i = 0; i < n; i++) { const x = pts[i][0]; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    const x0 = Math.round(minX), x1 = Math.round(maxX);
    for (let x = x0; x < x1; x++) {
      const cx = x + 0.5;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[0] - cx) * (b[0] - cx) > 0 || a[0] === b[0]) continue;
        const y = a[1] + (cx - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const ya = Math.round(lo), yb = Math.round(hi);
      if (yb > ya) g.fillRect(x, ya, 1, yb - ya);
    }
  }
  CV.poly = poly;
  const px = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  CV.px = px;

  // Filled pixel ellipse (row by row).
  function ellipse(g, cx, cy, rx, ry, color) {
    g.fillStyle = color;
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
      if (w > 0) g.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2, 1);
    }
  }
  CV.ellipse = ellipse;

  // Union of circles shaded like lit spheres in a few tones with an ordered dither: the pixel-art look of
  // tree canopies, bushes and hedges. tones: dark to light; the outer rim takes tones[0].
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v / 16 - 0.47);
  function shadedBlobs(w, h, circles, tones, seed, opt) {
    opt = opt || {};
    const c = canvas(w, h), g = c.getContext("2d");
    const img = g.createImageData(w, h), d = img.data;
    const T = tones.map(hexRgb), n = T.length;
    const R = rng(seed || 1);
    const L = [-0.55, -0.7, 0.45], ll = Math.hypot(L[0], L[1], L[2]);
    const inside = new Int16Array(w * h).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let k = circles.length - 1; k >= 0; k--) {
        const q = circles[k], dx = (x + 0.5 - q[0]) / q[2], dy = (y + 0.5 - q[1]) / (q[3] || q[2]);
        if (dx * dx + dy * dy <= 1) { inside[y * w + x] = k; break; }
      }
    }
    const noise = opt.noise == null ? 0.18 : opt.noise;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = inside[y * w + x];
      const r = R();
      if (k < 0) continue;
      const q = circles[k];
      const nx = (x + 0.5 - q[0]) / q[2], ny = (y + 0.5 - q[1]) / (q[3] || q[2]);
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      let v = (nx * L[0] + ny * L[1] + nz * L[2]) / ll * 0.5 + 0.5;
      v += (r - 0.5) * noise + BAYER[(y & 3) * 4 + (x & 3)] * 0.22 + (q[4] || 0);
      let t = Math.max(1, Math.min(n - 1, Math.floor(v * (n - 1) + 0.5)));
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || inside[y * w + x - 1] < 0 || inside[y * w + x + 1] < 0 || inside[(y - 1) * w + x] < 0 || inside[(y + 1) * w + x] < 0;
      if (edge && !opt.noRim) t = 0;
      const o = (y * w + x) * 4, col = T[t];
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  CV.shadedBlobs = shadedBlobs;

  // --- 3 x 5 pixel font (the same glyphs as game.js) -----------------------------------------------------
  const GLYPHS = {
    A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
    E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
    I: "111010010010111", J: "001001001101010", K: "101110100110101", L: "100100100100111",
    M: "1000111011101011000110001", N: "10011101101110011001", O: "010101101101010", P: "110101110100100",
    Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
    U: "101101101101111", V: "101101101101010", W: "1000110001101011101110001", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    0: "111101101101111", 1: "010110010010111", 2: "110001010100111", 3: "110001010001110",
    4: "101101111001001", 5: "111100110001110", 6: "011100111101111", 7: "111001010010010",
    8: "111101111101111", 9: "111101111001110",
    "'": "010010000000000", "-": "000000111000000", ".": "000000000000010", "?": "110001010000010",
    "!": "010010010000010", "+": "000010111010000", "$": "011110010011110", " ": "000000000000000",
    "…": "000000000000101", ":": "000010000010000",
  };
  const glyph = ch => GLYPHS[ch] || GLYPHS["?"];
  function textWidth(t) { let w = -1; for (const ch of String(t).toUpperCase()) w += glyph(ch).length / 5 + 1; return Math.max(0, w); }
  function pixelText(g, t, x, y, color, scale) {
    const s = scale || 1;
    g.fillStyle = color;
    let cx = x;
    for (const ch of String(t).toUpperCase()) {
      const gl = glyph(ch), gw = gl.length / 5;
      for (let b = 0; b < gl.length; b++) if (gl[b] === "1") g.fillRect(cx + (b % gw) * s, y + Math.floor(b / gw) * s, s, s);
      cx += (gw + 1) * s;
    }
  }
  CV.pixelText = pixelText; CV.textWidth = textWidth;

  // --- palettes ----------------------------------------------------------------------------------------
  const SEASON = {
    spring: { grass: "#6cb04a", light: "#86c662", dark: "#58983c", park: "#5ca443", parkLight: "#76bb57", parkDark: "#4a8a35",
      flower: ["#f6e05a", "#f39ac0", "#ffffff", "#b99af0"], leaf: ["#24562a", "#2f7034", "#3f8f3a", "#58a84a", "#7cc65e"], blossom: "#f8c6da", snow: false },
    summer: { grass: "#74a93d", light: "#8cc052", dark: "#5e8f2e", park: "#62a03a", parkLight: "#7cb84f", parkDark: "#4f8a2c",
      flower: ["#f6e05a", "#ffffff", "#ec6a42"], leaf: ["#1f4f24", "#2a6a2e", "#378a3a", "#4fa448", "#6cc05a"], snow: false },
    autumn: { grass: "#a3a246", light: "#bab65a", dark: "#878637", park: "#929a42", parkLight: "#a9ad55", parkDark: "#787f33",
      flower: ["#eaa23c"], leaf: ["#6e2a16", "#a8452a", "#c8662c", "#e2913a", "#f2c45a"], snow: false },
    winter: { grass: "#cdd9d4", light: "#e8efec", dark: "#aebdb7", park: "#c2d0ca", parkLight: "#dde7e3", parkDark: "#a6b7b0",
      flower: [], leaf: ["#8a9a96", "#b8c6c2", "#d8e2df", "#eef4f2", "#ffffff"], snow: true },
  };
  CV.SEASON = SEASON;

  // --- the art object, bound to one projection --------------------------------------------------------
  CV.makeArt = function (proj) {
    const P = (x, y, z) => proj.toWorld(x, y, z);
    const art = { proj, P };
    const iso = proj.kind === "iso";

    // Wall faces: u in tiles along the wall (screen left to right), z in px up the wall, d in tiles out
    // from the wall. rect(u0, u1, d0, d1) is the map rectangle of a strip standing in front of the wall.
    function faceFn(face, x0, y0, x1, y1) {
      switch (face) {
        case "s": return { face, len: x1 - x0, at: (u, z) => P(x0 + u, y1, z), out: (u, z, d) => P(x0 + u, y1 + d, z),
          rect: (u0, u1, d0, d1) => [x0 + u0, y1 + d0, x0 + u1, y1 + d1] };
        case "e": return { face, len: y1 - y0, at: (u, z) => P(x1, y1 - u, z), out: (u, z, d) => P(x1 + d, y1 - u, z),
          rect: (u0, u1, d0, d1) => [x1 + d0, y1 - u1, x1 + d1, y1 - u0] };
        case "n": return { face, len: x1 - x0, at: (u, z) => P(x1 - u, y0, z), out: (u, z, d) => P(x1 - u, y0 - d, z),
          rect: (u0, u1, d0, d1) => [x1 - u1, y0 - d1, x1 - u0, y0 - d0] };
        default: return { face, len: y1 - y0, at: (u, z) => P(x0, y0 + u, z), out: (u, z, d) => P(x0 - d, y0 + u, z),
          rect: (u0, u1, d0, d1) => [x0 - d1, y0 + u0, x0 - d0, y0 + u1] };
      }
    }
    const quad = (F, u0, u1, z0, z1) => [F.at(u0, z0), F.at(u1, z0), F.at(u1, z1), F.at(u0, z1)];
    const top = (x0, y0, x1, y1, z) => [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)];
    // A solid box: the faces turned to the camera, then its top.
    function boxAt(g, x0, y0, x1, y1, z0, z1, col, topCol) {
      for (const f of proj.faces) {
        const F = faceFn(f, x0, y0, x1, y1);
        poly(g, quad(F, 0, F.len, z0, z1), f === proj.faces[0] ? col : shade(col, 0.8));
      }
      poly(g, top(x0, y0, x1, y1, z1), topCol || shade(col, 1.12));
    }
    Object.assign(art, { faceFn, quad, top, boxAt });

    // A canvas covering a world-space box, with g translated so drawing in world coordinates lands in it.
    art.sprite = function (wx0, wy0, wx1, wy1) {
      const ox = Math.floor(wx0), oy = Math.floor(wy0);
      const c = canvas(Math.ceil(wx1) - ox, Math.ceil(wy1) - oy), g = c.getContext("2d");
      g.translate(-ox, -oy);
      return { c, g, ox, oy };
    };

    // --- ground tiles -------------------------------------------------------------------------------
    // Each ground sprite is tw x (th + 24): the tile's footprint plus 24 px under it for the map-edge slab.
    // T(u, v) is a tile-local point; the scene draws tile (x, y)'s sprite at P(x, y) - art.tileOffset.
    const corners = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    const minX = Math.min(...corners.map(c => c[0])), minY = Math.min(...corners.map(c => c[1]));
    const T = (u, v, z) => { const p = P(u, v, z); return [p[0] - minX, p[1] - minY]; };
    art.T = T;
    art.tileOffset = [corners[0][0] - minX, corners[0][1] - minY];
    const D = (u0, v0, u1, v1) => [T(u0, v0), T(u1, v0), T(u1, v1), T(u0, v1)];
    art.diamond = D;
    const tileCache = new Map();
    function groundTile(key, draw) {
      let t = tileCache.get(key);
      if (!t) {
        t = canvas(proj.tw, proj.th + 24);
        draw(t.getContext("2d"));
        tileCache.set(key, t);
      }
      return t;
    }
    art.groundTile = groundTile;
    art.clearTiles = () => tileCache.clear();

    // Pixel dots scattered over a tile (u, v in [a, b]).
    function speckle(g, seed, colors, n, a, b, w, h) {
      const R = rng(seed);
      a = a == null ? 0.06 : a; b = b == null ? 0.94 : b;
      for (let i = 0; i < n; i++) {
        const u = a + R() * (b - a), v = a + R() * (b - a), p = T(u, v);
        g.fillStyle = colors[Math.floor(R() * colors.length)];
        g.fillRect(Math.round(p[0]), Math.round(p[1]), w || 1, h || 1);
      }
    }
    // Grass blades: a dark 1x2 stroke with a light tip.
    function tufts(g, seed, n, dark, light, a, b, tall) {
      const R = rng(seed);
      a = a == null ? 0.08 : a; b = b == null ? 0.92 : b;
      for (let i = 0; i < n; i++) {
        const p = T(a + R() * (b - a), a + R() * (b - a)), x = Math.round(p[0]), y = Math.round(p[1]);
        const hh = tall ? 2 + Math.floor(R() * 3) : 2;
        g.fillStyle = dark; g.fillRect(x, y - hh + 1, 1, hh);
        if (tall && R() < 0.5) g.fillRect(x + 1, y - hh + 2, 1, hh - 1);
        g.fillStyle = light; g.fillRect(x, y - hh, 1, 1);
      }
    }
    art.speckle = speckle;

    art.grass = (season, v) => groundTile(`g:${season}:${v}`, g => {
      const S = SEASON[season];
      poly(g, D(0, 0, 1, 1), S.grass);
      speckle(g, v * 977 + 13, [S.dark, S.dark, S.light], 26);
      tufts(g, v * 31 + 5, 7, S.dark, S.light);
      if (S.flower.length && v % 3 === 0) speckle(g, v * 53 + 7, S.flower, 3, 0.25, 0.75);
      if (S.snow) speckle(g, v * 11 + 2, ["#ffffff", "#f2f6f5"], 12);
    });
    art.park = (season, v) => groundTile(`p:${season}:${v}`, g => {
      const S = SEASON[season];
      poly(g, D(0, 0, 1, 1), S.park);
      speckle(g, v * 577 + 3, [S.parkDark, S.parkDark, S.parkLight], 30);
      tufts(g, v * 17 + 9, 9, S.parkDark, S.parkLight);
      if (S.flower.length && v % 2 === 0) speckle(g, v * 91 + 5, S.flower, 5, 0.15, 0.85);
    });
    // Gravel paths through parks. mask bits: 1 N, 2 E, 4 S, 8 W neighbours that are path too.
    art.path = (season, mask) => groundTile(`pa:${season}:${mask}`, g => {
      const S = SEASON[season];
      poly(g, D(0, 0, 1, 1), S.park);
      speckle(g, mask * 37 + 1, [S.parkDark, S.parkLight], 18);
      const c = S.snow ? "#e9e6dc" : "#d9c79e", e = S.snow ? "#cfcabd" : "#b9a77c";
      const a = 0.3, b = 0.7;
      const parts = [[a, a, b, b]];
      if (mask & 1) parts.push([a, 0, b, a]);
      if (mask & 2) parts.push([b, a, 1, b]);
      if (mask & 4) parts.push([a, b, b, 1]);
      if (mask & 8) parts.push([0, a, a, b]);
      for (const q of parts) poly(g, D(q[0] - 0.04, q[1] - 0.04, q[2] + 0.04, q[3] + 0.04), e);
      for (const q of parts) poly(g, D(...q), c);
      speckle(g, mask * 7 + 3, [e, "#efe2bd"], 10, 0.32, 0.68);
    });
    // A home lot's lawn by neglect stage: striped and kept, plain, patchy, overgrown, dead.
    art.lawn = (season, stage, v) => groundTile(`l:${season}:${stage}:${v}`, g => {
      const S = SEASON[season];
      if (S.snow) {
        poly(g, D(0, 0, 1, 1), stage >= 3 ? "#c2cbc4" : S.grass);
        speckle(g, v * 13 + 1, [S.light, S.dark], 14);
        if (stage >= 3) tufts(g, v * 7 + 3, 14, "#7a7a5a", "#9a9a7a", 0.08, 0.92, true);
        return;
      }
      if (stage === 0) {
        const a = mix(S.grass, "#6fd04a", 0.25), b = shade(a, 1.08);
        poly(g, D(0, 0, 1, 1), a);
        for (let i = 0; i < 4; i++) if (i % 2 === 0) poly(g, D(i / 4, 0, (i + 1) / 4, 1), b); // mowed stripes
        speckle(g, v * 7 + 1, [shade(a, 0.92)], 10);
        if (S.flower.length && v % 2 === 0) speckle(g, v * 3 + 2, S.flower, 4, 0.1, 0.9);
      } else if (stage === 1) {
        poly(g, D(0, 0, 1, 1), S.grass);
        speckle(g, v * 97 + 1, [S.dark, S.light], 24);
        tufts(g, v * 5 + 1, 8, S.dark, S.light);
      } else if (stage === 2) {
        const base = mix(S.grass, "#b8a95a", 0.3);
        poly(g, D(0, 0, 1, 1), base);
        const R = rng(v * 13 + 2);
        for (let i = 0; i < 3; i++) { // dry yellow patches
          const u = 0.15 + R() * 0.6, w = 0.12 + R() * 0.12, vv = 0.15 + R() * 0.6;
          poly(g, D(u, vv, u + w, vv + w * 0.8), mix(base, "#d2c27a", 0.6));
        }
        speckle(g, v * 19 + 3, ["#a89a58", S.dark, "#8a8a48"], 22);
        tufts(g, v * 9 + 4, 12, shade(base, 0.8), shade(base, 1.1), 0.08, 0.92, true);
      } else if (stage === 3) {
        const base = mix(S.grass, "#3f6a2a", 0.45);
        poly(g, D(0, 0, 1, 1), base);
        tufts(g, v * 7919 + 3, 22, "#2f5422", "#5f8a34", 0.06, 0.94, true); // long grass
        tufts(g, v * 31 + 3, 8, "#3e6e2a", "#7a9a3a", 0.06, 0.94, true);
        speckle(g, v * 3 + 11, ["#e8d34a", "#f2f2f2"], 4, 0.1, 0.9); // weeds in flower
      } else {
        const base = mix(S.grass, "#9a8a52", 0.7);
        poly(g, D(0, 0, 1, 1), base);
        const R = rng(v * 17 + 4);
        for (let i = 0; i < 3; i++) { // bare dirt
          const u = 0.1 + R() * 0.6, w = 0.15 + R() * 0.15, vv = 0.1 + R() * 0.6;
          poly(g, D(u, vv, u + w, vv + w), "#7d6343");
          speckle(g, i * 5 + v, ["#6a5238", "#8f7552"], 6, Math.min(u, vv), Math.min(0.95, Math.max(u, vv) + w));
        }
        tufts(g, v * 41 + 5, 18, "#6a5a2a", "#a8984a", 0.06, 0.94, true); // dead grass
      }
    });
    // Driveway beside a house: a concrete strip from the street to the house, on the lawn.
    art.drive = (season, stage, axis, v) => groundTile(`dr:${season}:${stage}:${axis}:${v}`, g => {
      g.drawImage(art.lawn(season, stage, v), 0, 0);
      const c = stage >= 3 ? "#a9a49a" : "#c4bfb3";
      if (axis === "y") poly(g, D(0.22, 0, 0.78, 1), c); else poly(g, D(0, 0.22, 1, 0.78), c);
      if (axis === "y") poly(g, D(0.22, 0.48, 0.78, 0.52), shade(c, 0.9)); else poly(g, D(0.48, 0.22, 0.52, 0.78), shade(c, 0.9));
      if (stage >= 3) speckle(g, v * 3, ["#7a7468", "#5f8a34"], 10, 0.25, 0.75);
    });
    // Paved plaza: stone slabs in two tones with joints. Downtown and around shops and flats.
    art.pavement = (v, tone) => groundTile(`pv:${tone || ""}:${v}`, g => {
      const base = tone || "#cbc4b4", alt = shade(base, 0.95), joint = shade(base, 0.84);
      poly(g, D(0, 0, 1, 1), base);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if ((i + j + v) % 2) poly(g, D(i / 2, j / 2, (i + 1) / 2, (j + 1) / 2), alt);
      poly(g, D(0.49, 0, 0.52, 1), joint); poly(g, D(0, 0.49, 1, 0.52), joint);
      poly(g, D(0, 0, 0.03, 1), joint); poly(g, D(0, 0, 1, 0.03), joint);
      speckle(g, v * 41 + 7, [shade(base, 0.9), shade(base, 1.05)], 8);
    });
    // Concrete apron around a building's inset body.
    art.apron = v => groundTile(`ap:${v}`, g => {
      poly(g, D(0, 0, 1, 1), "#b4afa3");
      speckle(g, v * 5 + 1, ["#a39e92", "#c2bdb1"], 10);
    });
    // Works yard: gravel with painted bay markings.
    art.yard = v => groundTile(`y:${v}`, g => {
      poly(g, D(0, 0, 1, 1), "#8f8c84");
      speckle(g, v * 41 + 1, ["#7c7970", "#a39f94", "#6d6a62"], 30);
      if (v % 4 === 0) poly(g, D(0.1, 0.46, 0.9, 0.52), "#e0bf4c");
      if (v % 4 === 2) { poly(g, D(0.3, 0.3, 0.5, 0.45), "#4a4a46"); }
    });
    // The walk from a door to the street.
    art.entry = (season, axis, paved) => groundTile(`e:${season}:${axis}:${paved ? 1 : 0}`, g => {
      const S = SEASON[season];
      if (paved) { g.drawImage(art.pavement(1), 0, 0); return; }
      poly(g, D(0, 0, 1, 1), S.grass);
      speckle(g, 5, [S.dark, S.light], 16);
      const c = S.snow ? "#e6e2d8" : "#d8cfbd", e = shade(c, 0.85);
      if (axis === "y") { poly(g, D(0.32, 0, 0.68, 1), e); poly(g, D(0.35, 0, 0.65, 1), c); for (let i = 1; i < 4; i++) poly(g, D(0.35, i / 4, 0.65, i / 4 + 0.025), e); }
      else { poly(g, D(0, 0.32, 1, 0.68), e); poly(g, D(0, 0.35, 1, 0.65), c); for (let i = 1; i < 4; i++) poly(g, D(i / 4, 0.35, i / 4 + 0.025, 0.65), e); }
    });

    // Roads: asphalt, sidewalks on every side that meets a non-road tile, a kerb, a dashed centre line
    // along the axis, zebra crossings on the arms of junctions and sidewalk corners where blocks meet.
    // mask bits: 1 N, 2 E, 4 S, 8 W road neighbours; diag bits: 1 NE, 2 SE, 4 SW, 8 NW road diagonals.
    const SW = 0.17;
    art.SIDEWALK = SW;
    art.road = (mask, diag, season, v) => groundTile(`r:${mask}:${diag}:${season}:${v}`, g => {
      const snow = SEASON[season].snow;
      const asphalt = snow ? "#666a72" : "#50545c";
      poly(g, D(0, 0, 1, 1), asphalt);
      speckle(g, v * 13 + 5, [shade(asphalt, 1.12), shade(asphalt, 0.88), shade(asphalt, 0.94)], 22);
      const walk = snow ? "#e4e8ea" : "#bcb8ad", joint = snow ? "#c8cdd0" : "#a29e93", kerb = "#8b887f", gutter = "#3d4047";
      const N = !(mask & 1), E = !(mask & 2), S = !(mask & 4), Wd = !(mask & 8);
      const k = SW;
      const strip = (side) => {
        if (side === "n") { poly(g, D(0, 0, 1, k), walk); for (let i = 1; i < 4; i++) poly(g, D(i / 4, 0, i / 4 + 0.02, k), joint); poly(g, D(0, k - 0.03, 1, k), kerb); poly(g, D(0, k, 1, k + 0.025), gutter); }
        if (side === "s") { poly(g, D(0, 1 - k, 1, 1), walk); for (let i = 1; i < 4; i++) poly(g, D(i / 4, 1 - k, i / 4 + 0.02, 1), joint); poly(g, D(0, 1 - k, 1, 1 - k + 0.03), kerb); poly(g, D(0, 1 - k - 0.025, 1, 1 - k), gutter); }
        if (side === "w") { poly(g, D(0, 0, k, 1), walk); for (let i = 1; i < 4; i++) poly(g, D(0, i / 4, k, i / 4 + 0.02), joint); poly(g, D(k - 0.03, 0, k, 1), kerb); poly(g, D(k, 0, k + 0.025, 1), gutter); }
        if (side === "e") { poly(g, D(1 - k, 0, 1, 1), walk); for (let i = 1; i < 4; i++) poly(g, D(1 - k, i / 4, 1, i / 4 + 0.02), joint); poly(g, D(1 - k, 0, 1 - k + 0.03, 1), kerb); poly(g, D(1 - k - 0.025, 0, 1 - k, 1), gutter); }
      };
      if (N) strip("n"); if (S) strip("s"); if (Wd) strip("w"); if (E) strip("e");
      // sidewalk corners where two road arms meet around a block corner
      const corner = (u, vv) => { poly(g, D(u, vv, u + k, vv + k), walk); };
      if ((mask & 1) && (mask & 2) && !(diag & 1)) corner(1 - k, 0);
      if ((mask & 2) && (mask & 4) && !(diag & 2)) corner(1 - k, 1 - k);
      if ((mask & 4) && (mask & 8) && !(diag & 4)) corner(0, 1 - k);
      if ((mask & 8) && (mask & 1) && !(diag & 8)) corner(0, 0);
      const arms = (mask & 1) + (mask >> 1 & 1) + (mask >> 2 & 1) + (mask >> 3 & 1);
      const line = snow ? "#f2f2f2" : "#e9cf5a";
      if (arms >= 3) {
        const z = snow ? "#ffffff" : "#e6e8ec";
        for (let i = 0; i < 5; i++) {
          const a = k + 0.04 + i * 0.13, b = a + 0.065;
          if (mask & 1) poly(g, D(a, 0.025, b, 0.14), z);
          if (mask & 4) poly(g, D(a, 0.86, b, 0.975), z);
          if (mask & 8) poly(g, D(0.025, a, 0.14, b), z);
          if (mask & 2) poly(g, D(0.86, a, 0.975, b), z);
        }
      } else if ((mask & 10) && !(mask & 5)) {
        poly(g, D(0.08, 0.475, 0.38, 0.525), line); poly(g, D(0.58, 0.475, 0.88, 0.525), line);
      } else if ((mask & 5) && !(mask & 10)) {
        poly(g, D(0.475, 0.08, 0.525, 0.38), line); poly(g, D(0.475, 0.58, 0.525, 0.88), line);
      }
      if (snow) speckle(g, v * 3 + 1, ["#f4f6f8", "#dfe3e6"], 10);
    });
    // Bus stop paint on the road at a stop tile: a yellow box along the kerb.
    art.stopMark = (axis, side) => groundTile(`sm:${axis}:${side}`, g => {
      const c = "#e9cf5a", k = SW;
      if (axis === "x") {
        const v0 = side === "n" ? k + 0.03 : 1 - k - 0.2, v1 = v0 + 0.17;
        poly(g, D(0.1, v0, 0.9, v0 + 0.025), c); poly(g, D(0.1, v1 - 0.025, 0.9, v1), c);
        poly(g, D(0.1, v0, 0.125, v1), c); poly(g, D(0.875, v0, 0.9, v1), c);
      } else {
        const u0 = side === "w" ? k + 0.03 : 1 - k - 0.2, u1 = u0 + 0.17;
        poly(g, D(u0, 0.1, u0 + 0.025, 0.9), c); poly(g, D(u1 - 0.025, 0.1, u1, 0.9), c);
        poly(g, D(u0, 0.1, u1, 0.125), c); poly(g, D(u0, 0.875, u1, 0.9), c);
      }
    });
    // Water with ripples; sand and foam on edges that meet land. mask bits: land on N, E, S, W.
    art.water = (mask, v) => groundTile(`w:${mask}:${v}`, g => {
      const deep = "#3878bd", mid = "#4286c8";
      poly(g, D(0, 0, 1, 1), mid);
      const R = rng(v * 17 + 3);
      for (let i = 0; i < 7; i++) { // ripple strokes along the current
        const p = T(0.1 + R() * 0.8, 0.1 + R() * 0.8), x = Math.round(p[0]), y = Math.round(p[1]);
        g.fillStyle = i % 3 === 0 ? deep : "#6aa8dc"; g.fillRect(x, y, 4 + Math.floor(R() * 3), 1);
        if (i % 3 !== 0) { g.fillStyle = "#9cc8ec"; g.fillRect(x + 1, y, 2, 1); }
      }
      speckle(g, v * 7 + 1, [deep, "#4f92d0"], 12);
      const sand = "#dcc994", wet = "#c3ad78", foam = "#e8f4fb", S = 0.16;
      if (mask & 1) { poly(g, D(0, 0, 1, S), sand); poly(g, D(0, S - 0.04, 1, S), wet); poly(g, D(0, S, 1, S + 0.035), foam); }
      if (mask & 8) { poly(g, D(0, 0, S, 1), sand); poly(g, D(S - 0.04, 0, S, 1), wet); poly(g, D(S, 0, S + 0.035, 1), foam); }
      if (mask & 2) { poly(g, D(1 - S, 0, 1, 1), sand); poly(g, D(1 - S - 0.035, 0, 1 - S, 1), foam); }
      if (mask & 4) { poly(g, D(0, 1 - S, 1, 1), sand); poly(g, D(0, 1 - S - 0.035, 1, 1 - S), foam); }
    });
    // The SimCity-2000 slab under the map's front edges: earth strata, or a water column.
    art.slab = (side, water, season) => groundTile(`sl:${side}:${water ? 1 : 0}:${season}`, g => {
      const q = side === "s" ? [T(0, 1), T(1, 1)] : side === "e" ? [T(1, 1), T(1, 0)] : side === "n" ? [T(1, 0), T(0, 0)] : [T(0, 0), T(0, 1)];
      const lit = side === proj.faces[0];
      const k = lit ? 1 : 0.8;
      const band = (a, b, c) => poly(g, [[q[0][0], q[0][1] + a], [q[1][0], q[1][1] + a], [q[1][0], q[1][1] + b], [q[0][0], q[0][1] + b]], shade(c, k));
      if (water) { band(0, 3, "#5a9ad6"); band(3, 12, "#2f6aa3"); band(12, 24, "#22537f"); return; }
      band(0, 2, SEASON[season].dark); band(2, 9, "#8a6440"); band(9, 16, "#6c4c31"); band(16, 24, "#523a26");
      const R = rng(side.charCodeAt(0));
      for (let i = 0; i < 6; i++) { // pebbles in the strata
        const t = R(), a = q[0], b = q[1], x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t + 5 + R() * 16;
        g.fillStyle = shade("#a08060", k); g.fillRect(Math.round(x), Math.round(y), 2, 1);
      }
    });

    // --- upright items (billboards and small props) ---------------------------------------------------------
    // Items are anchored at their base point (ax, ay) inside the sprite.
    const itemCache = new Map();
    function item(key, w, h, ax, ay, draw) {
      let s = itemCache.get(key);
      if (!s) { const c = canvas(w, h), g = c.getContext("2d"); draw(g, c); s = { c, ax, ay }; itemCache.set(key, s); }
      return s;
    }
    art.item = item;
    art.clearItems = () => itemCache.clear();
    // An oriented prop drawn through the projection around tile-local point (0.5, 0.5).
    function oriented(key, w, h, ax, ay, draw) {
      return item(key, w, h, ax, ay, g => { const c = P(0.5, 0.5); g.translate(ax - c[0], ay - c[1]); draw(g); });
    }
    art.oriented = oriented;
    const shadowEllipse = (g, cx, cy, rx, ry) => ellipse(g, cx, cy, rx, ry, "rgba(18,30,12,0.28)");

    art.tree = (season, kind, v) => item(`t:${season}:${kind}:${v}`, 48, 70, 24, 64, g => {
      const S = SEASON[season];
      if (kind === "pine") {
        shadowEllipse(g, 27, 64, 12, 4);
        g.fillStyle = "#4a2f1c"; g.fillRect(22, 54, 4, 11); g.fillStyle = "#6a4528"; g.fillRect(22, 54, 2, 11);
        const tones = S.snow ? ["#1c3a26", "#2a5034", "#3a6a44", "#e6eeec", "#ffffff"] : season === "autumn" ? ["#173a20", "#22502c", "#2f6a38", "#3f8048", "#559a5a"] : ["#123c22", "#1c5230", "#286a3c", "#36824a", "#4f9e5e"];
        const h0 = 8 + (v % 3) * 3;
        const tiers = [];
        for (let i = 0; i < 4; i++) {
          const yTop = h0 + i * 10, half = 6 + i * 3.4;
          tiers.push([yTop, half]);
        }
        const c = canvas(48, 70), q = c.getContext("2d");
        const img = q.createImageData(48, 70), d = img.data;
        const T5 = tones.map(hexRgb);
        const R = rng(v * 7 + 1);
        for (let y = 0; y < 62; y++) for (let x = 0; x < 48; x++) {
          let inT = -1;
          for (let i = 0; i < tiers.length; i++) {
            const [yt, half] = tiers[i], yb = yt + 15;
            if (y >= yt && y < yb) { const t = (y - yt) / 15, hw = 1 + t * half; if (Math.abs(x + 0.5 - 24) <= hw) inT = i; }
          }
          if (inT < 0) continue;
          const [yt, half] = tiers[inT], t = (y - yt) / 15, hw = 1 + t * half, rel = (x + 0.5 - 24) / hw;
          let val = 0.62 - rel * 0.35 - t * 0.25 + (R() - 0.5) * 0.2 + BAYER[(y & 3) * 4 + (x & 3)] * 0.2;
          let k = Math.max(1, Math.min(S.snow ? 2 : 4, Math.floor(val * 4 + 0.5)));
          if (S.snow && t < 0.35 && rel < 0.5) k = rel < -0.2 ? 4 : 3;
          if (Math.abs(rel) > 0.9 || y === Math.ceil(yt + 14)) k = 0;
          const o = (y * 48 + x) * 4, col = T5[k];
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
        }
        q.putImageData(img, 0, 0);
        g.drawImage(c, 0, 0);
        return;
      }
      if (kind === "bush") {
        shadowEllipse(g, 27, 63, 12, 4);
        const tones = [S.leaf[0], S.leaf[1], S.leaf[2], S.leaf[3], S.leaf[4]];
        g.drawImage(shadedBlobs(30, 20, [[10, 12, 9, 8], [20, 11, 9, 8], [15, 8, 8, 7]], tones, v * 3 + 7), 9, 46);
        if (S.flower.length && v % 2 === 0) speckle(g, v, S.flower, 0);
        return;
      }
      // round deciduous tree
      shadowEllipse(g, 28, 64, 15, 5);
      const trunk = "#5e3f24";
      g.fillStyle = trunk; g.fillRect(21, 40, 5, 25); g.fillStyle = "#7a5432"; g.fillRect(21, 40, 2, 25);
      g.fillStyle = shade(trunk, 0.8); g.fillRect(18, 62, 11, 2);
      if (S.snow) { // bare branches dusted with snow
        g.fillStyle = "#5e3f24";
        for (const [x, y, w] of [[12, 26, 10], [25, 22, 11], [16, 15, 6], [27, 31, 9], [13, 34, 8], [22, 10, 2]]) g.fillRect(x, y, w, 2);
        g.fillRect(22, 10, 2, 30); g.fillRect(16, 15, 2, 12); g.fillRect(31, 22, 2, 10);
        g.fillStyle = "#ffffff"; for (const [x, y, w] of [[12, 25, 10], [25, 21, 11], [27, 30, 9], [16, 14, 6]]) g.fillRect(x, y, w, 1);
        return;
      }
      const R = rng(v * 13 + 5);
      const circles = [];
      const big = v % 4 === 3 ? 1.1 : 1;
      circles.push([24, 30, 14 * big, 12 * big]);
      for (let i = 0; i < 5; i++) circles.push([14 + R() * 20, 18 + R() * 16, (7 + R() * 4) * big, (6 + R() * 3) * big, 0.04]);
      circles.push([22 + R() * 4, 14, 8 * big, 7 * big, 0.08]);
      const leaf = S.leaf.slice();
      if (season === "spring" && v % 3 === 0) leaf[4] = S.blossom;
      g.drawImage(shadedBlobs(48, 46, circles, leaf, v * 31 + 3), 0, 0);
      if (season === "autumn") speckle(g, 0, [], 0);
    });

    // Street lamp: pole with an arm and a lamp head. The bulb glows at night (scene's emissive pass).
    art.lamp = () => item("lamp", 16, 52, 5, 49, g => {
      ellipse(g, 6, 49, 4, 1, "rgba(0,0,0,.25)");
      g.fillStyle = "#2c313c"; g.fillRect(3, 46, 5, 3);
      g.fillStyle = "#3d4454"; g.fillRect(4, 9, 2, 38); g.fillStyle = "#5a6375"; g.fillRect(4, 9, 1, 38);
      g.fillStyle = "#3d4454"; g.fillRect(5, 8, 6, 2); g.fillRect(10, 9, 1, 2);
      g.fillStyle = "#262a33"; g.fillRect(8, 10, 6, 3); g.fillStyle = "#454b58"; g.fillRect(8, 10, 6, 1);
      g.fillStyle = "#fff1b8"; g.fillRect(9, 13, 4, 1);
    });
    art.LAMP_BULB = [6, -36]; // bulb offset from the lamp's base point in world px (x, z)
    art.bench = () => item("bench", 22, 16, 11, 13, g => {
      ellipse(g, 11, 13, 9, 2, "rgba(0,0,0,.22)");
      g.fillStyle = "#3a3a3a"; g.fillRect(4, 8, 2, 6); g.fillRect(16, 8, 2, 6);
      g.fillStyle = "#b07a3c"; g.fillRect(2, 7, 18, 3); g.fillStyle = "#8a5a2a"; g.fillRect(2, 9, 18, 1);
      g.fillStyle = "#9a6a34"; g.fillRect(2, 2, 18, 3); g.fillStyle = "#c48a48"; g.fillRect(2, 2, 18, 1);
      g.fillStyle = "#3a3a3a"; g.fillRect(3, 4, 1, 4); g.fillRect(18, 4, 1, 4);
    });

    // Fence segment along one edge of a lot tile, drawn through the projection. side: n e s w.
    // stage 0 white pickets ... 4 a few grey posts.
    art.fence = (stage, side, v) => oriented(`f:${stage}:${side}:${v}`, 80, 56, 40, 36, g => {
      const post = ["#ffffff", "#ece6d6", "#d6cdb8", "#b0a58c", "#8a7e66"][stage];
      const dark = shade(post, 0.72);
      const e = side === "n" ? [[0, 0], [1, 0]] : side === "s" ? [[0, 1], [1, 1]] : side === "w" ? [[0, 0], [0, 1]] : [[1, 0], [1, 1]];
      const at = (t, z) => P(e[0][0] + (e[1][0] - e[0][0]) * t, e[0][1] + (e[1][1] - e[0][1]) * t, z);
      const R = rng(v * 7 + stage * 31 + side.charCodeAt(0));
      const railOk = stage <= 3;
      if (railOk) { // rails
        for (const z of [4, 8]) {
          const segs = stage >= 3 ? [[0, 0.35], [0.6, 1]] : [[0, 1]];
          for (const [a, b] of segs) poly(g, [at(a, z), at(b, z), at(b, z + 1.2), at(a, z + 1.2)], stage >= 2 ? dark : shade(post, 0.86));
        }
      }
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const t = (i + 0.5) / (n + 1);
        const r = R();
        if (stage === 2 && r < 0.12) continue;
        if (stage === 3 && r < 0.34) continue;
        if (stage === 4 && (i % 3 !== 0 || r < 0.3)) continue;
        const p = at(t, 0), x = Math.round(p[0]), y = Math.round(p[1]);
        const lean = stage >= 3 && r > 0.8 ? 1 : 0, hh = stage === 4 ? 7 + Math.floor(r * 4) : 11;
        g.fillStyle = dark; g.fillRect(x + lean, y - hh, 2, hh);
        g.fillStyle = post; g.fillRect(x + lean, y - hh, 1, hh);
        if (stage <= 2) { g.fillStyle = post; g.fillRect(x + lean, y - hh - 1, 1, 1); }
      }
    });
    // Clipped hedge (big houses) along one lot edge: a green box; ragged and wild as the stage rises.
    art.hedge = (stage, side, season, v) => oriented(`h:${stage}:${side}:${season}:${v}`, 84, 64, 42, 40, g => {
      const S = SEASON[season];
      const base = S.snow ? "#9fb0aa" : stage <= 1 ? "#3f7d34" : stage === 2 ? "#4a7a32" : stage === 3 ? "#567a30" : "#6e7438";
      const inset = 0.06, wdt = 0.16;
      let x0, y0, x1, y1;
      if (side === "n") { x0 = 0; x1 = 1; y0 = inset; y1 = inset + wdt; }
      else if (side === "s") { x0 = 0; x1 = 1; y0 = 1 - inset - wdt; y1 = 1 - inset; }
      else if (side === "w") { y0 = 0; y1 = 1; x0 = inset; x1 = inset + wdt; }
      else { y0 = 0; y1 = 1; x0 = 1 - inset - wdt; x1 = 1 - inset; }
      const h = [8, 9, 10, 13, 15][stage];
      const R = rng(v * 13 + stage);
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = i / n, b = (i + 1) / n;
        const hh = h + (stage >= 2 ? Math.floor(R() * (stage * 2)) - stage : 0);
        const along = side === "n" || side === "s";
        const bx0 = along ? x0 + a : x0, bx1 = along ? x0 + b : x1, by0 = along ? y0 : y0 + a, by1 = along ? y1 : y0 + b;
        if (stage === 4 && R() < 0.2) continue;
        boxAt(g, bx0, by0, bx1, by1, 0, Math.max(3, hh), base, shade(base, stage <= 1 ? 1.25 : 1.12));
      }
      if (stage >= 2) { // leaves sticking out
        for (let i = 0; i < 6 + stage * 4; i++) {
          const t = R(), p = side === "n" || side === "s" ? P(t, (y0 + y1) / 2, h + R() * 3) : P((x0 + x1) / 2, t, h + R() * 3);
          g.fillStyle = R() < 0.5 ? shade(base, 1.2) : shade(base, 0.75);
          g.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 2);
        }
      }
      if (stage >= 4) { for (let i = 0; i < 5; i++) { const p = P(R(), R(), 4 + R() * 6); g.fillStyle = "#8a6a3a"; g.fillRect(Math.round(p[0]), Math.round(p[1]), 2, 1); } }
    });
    // SALE / RENT board on a post.
    art.sign = kind => item(`sg:${kind}`, 26, 30, 13, 28, g => {
      ellipse(g, 13, 28, 5, 1, "rgba(0,0,0,.25)");
      g.fillStyle = "#5a3e24"; g.fillRect(12, 11, 2, 18); g.fillStyle = "#7a5636"; g.fillRect(12, 11, 1, 18);
      const bg = kind === "sale" ? "#d63a3a" : kind === "let" ? "#2f9a6a" : "#2f7fb8";
      g.fillStyle = "#1e1e24"; g.fillRect(1, 1, 24, 12);
      g.fillStyle = bg; g.fillRect(2, 2, 22, 10);
      g.fillStyle = shade(bg, 1.2); g.fillRect(2, 2, 22, 1);
      const t = kind === "sale" ? "SALE" : kind === "let" ? "LET" : "RENT";
      pixelText(g, t, 13 - Math.round(textWidth(t) / 2), 5, "#ffffff");
    });
    // Junk by neglect stage: overflowing bin, then a tyre and bin bags, then an old mattress and scrap.
    art.junk = (stage, v) => item(`j:${stage}:${v}`, 34, 26, 17, 21, g => {
      ellipse(g, 17, 21, 14, 3, "rgba(0,0,0,.25)");
      g.fillStyle = "#2f4a2c"; g.fillRect(3, 9, 9, 12); g.fillStyle = "#3e5e3a"; g.fillRect(3, 9, 3, 12);
      g.fillStyle = "#24381f"; g.fillRect(2, 7, 11, 3);
      if (stage >= 2) { g.fillStyle = "#1e1e1e"; g.fillRect(4, 3, 6, 5); g.fillStyle = "#e8e2d0"; g.fillRect(7, 2, 4, 2); g.fillStyle = "#c84a3a"; g.fillRect(5, 4, 2, 2); }
      if (stage >= 3) {
        g.fillStyle = "#1a1a1a"; g.fillRect(15, 15, 9, 6); g.fillStyle = "#3a3a3a"; g.fillRect(17, 16, 5, 4); g.fillStyle = "#1a1a1a"; g.fillRect(18, 17, 3, 2); // tyre
        g.fillStyle = "#26262a"; g.fillRect(24, 11, 7, 8); g.fillStyle = "#44444a"; g.fillRect(25, 12, 2, 2); g.fillRect(27, 9, 2, 2); // bin bags
      }
      if (stage >= 4) {
        g.fillStyle = "#d8cfb0"; g.fillRect(12, 6, 18, 6); g.fillStyle = "#b8ab88"; g.fillRect(12, 10, 18, 2); g.fillStyle = "#a89a7a"; g.fillRect(15, 7, 2, 1); g.fillRect(21, 8, 3, 1); // mattress
        g.fillStyle = "#8a5a3a"; g.fillRect(2, 21, 10, 2); g.fillStyle = "#6a6a70"; g.fillRect(26, 20, 6, 2);
      }
    });
    // Skip (builder's dumpster) during works.
    art.skip = () => item("skip", 36, 22, 18, 18, g => {
      ellipse(g, 18, 18, 15, 3, "rgba(0,0,0,.25)");
      g.fillStyle = "#e0a020"; g.fillRect(4, 8, 28, 10); g.fillStyle = "#b07a10"; g.fillRect(4, 15, 28, 3);
      g.fillStyle = "#f2c040"; g.fillRect(3, 7, 30, 2);
      g.fillStyle = "#8a7a6a"; g.fillRect(8, 5, 8, 3); g.fillStyle = "#a08a6a"; g.fillRect(18, 4, 9, 4);
    });
    // Bus stop shelter: roof, glass back, bench and a pole with the line numbers.
    art.shelter = (lines) => item(`st:${lines}`, 40, 44, 20, 40, g => {
      ellipse(g, 20, 40, 17, 3, "rgba(0,0,0,.25)");
      g.fillStyle = "#3a4250"; g.fillRect(5, 12, 2, 28); g.fillRect(29, 12, 2, 28);
      g.fillStyle = "rgba(170,210,235,.55)"; g.fillRect(7, 14, 22, 18);
      g.fillStyle = "#3a4250"; g.fillRect(3, 9, 30, 4); g.fillStyle = "#56607a"; g.fillRect(3, 9, 30, 1);
      g.fillStyle = "#8a6a44"; g.fillRect(9, 29, 18, 3);
      g.fillStyle = "#3a4250"; g.fillRect(35, 4, 2, 36);
      const cols = { "1": "#f29a05", "2": "#1fa2a0" };
      String(lines).split(",").forEach((l, i) => { g.fillStyle = cols[l] || "#888"; g.fillRect(33, 4 + i * 7, 6, 6); pixelText(g, l, 35, 4 + i * 7 + 1, "#ffffff"); });
    });
    // Traffic-light pole with a head showing one colour.
    art.signal = color => item(`sig:${color}`, 12, 50, 6, 47, g => {
      ellipse(g, 6, 47, 3, 1, "rgba(0,0,0,.25)");
      g.fillStyle = "#30343c"; g.fillRect(5, 14, 2, 34);
      g.fillStyle = "#1c1e24"; g.fillRect(3, 2, 6, 14); g.fillStyle = "#3a3e48"; g.fillRect(3, 2, 6, 1);
      const on = { red: 0, yellow: 1, green: 2 }[color];
      const lamp = ["#ff4a3a", "#ffd23f", "#3ee06a"];
      for (let i = 0; i < 3; i++) { g.fillStyle = i === on ? lamp[i] : shade(lamp[i], 0.3); g.fillRect(5, 4 + i * 4, 2, 2); }
    });
    // Fountain on Fountain Square: stone basin (drawn into the ground) and an animated jet (frames).
    art.fountainBasin = (g, cx, cy) => {
      ellipse(g, cx, cy + 2, 34, 15, "rgba(0,0,0,.18)");
      ellipse(g, cx, cy, 33, 15, "#d7d0c0");
      ellipse(g, cx, cy, 30, 13, "#b5ad9c");
      ellipse(g, cx, cy + 1, 28, 12, "#3f86c8");
      ellipse(g, cx - 4, cy - 2, 14, 5, "#5a9ad6");
      ellipse(g, cx, cy, 7, 3, "#cfc8b8");
    };
    art.fountainJet = f => item(`fj:${f}`, 40, 54, 20, 46, g => {
      const R = rng(f * 7 + 1);
      g.fillStyle = "#d7d0c0"; g.fillRect(17, 40, 6, 6); g.fillStyle = "#b5ad9c"; g.fillRect(17, 44, 6, 2);
      g.fillStyle = "rgba(200,230,255,.85)"; g.fillRect(19, 14, 2, 27);
      g.fillStyle = "rgba(255,255,255,.9)"; g.fillRect(19, 12, 2, 3);
      for (let i = 0; i < 18; i++) { // falling droplets
        const t = (i / 18 + f / 6) % 1, side = i % 2 ? 1 : -1, x = 20 + side * (2 + t * 13), y = 14 + t * t * 30 - (1 - t) * 4;
        g.fillStyle = i % 3 ? "rgba(190,225,255,.9)" : "rgba(255,255,255,.95)"; g.fillRect(Math.round(x), Math.round(y), 1, 2);
      }
      for (let i = 0; i < 6; i++) { g.fillStyle = "rgba(255,255,255,.8)"; g.fillRect(8 + Math.floor(R() * 24), 42 + Math.floor(R() * 5), 2, 1); }
    });
    art.smokePuff = (r, a) => item(`sm:${r}:${a}`, r * 2 + 2, r * 2 + 2, r + 1, r + 1, g => {
      ellipse(g, r + 1, r + 1, r, r, `rgba(210,212,218,${a})`);
      ellipse(g, r, r - 1, Math.max(1, r - 2), Math.max(1, r - 2), `rgba(236,238,242,${a})`);
    });
    // Produce crates outside the market.
    art.crates = v => item(`cr:${v}`, 36, 22, 18, 18, g => {
      ellipse(g, 18, 18, 15, 3, "rgba(0,0,0,.22)");
      const fruit = ["#e2402c", "#f2a12c", "#7cc04a", "#f2d23a", "#a83ac0"];
      for (let i = 0; i < 3; i++) {
        const x = 3 + i * 10, y = 9 - (i % 2) * 2;
        g.fillStyle = "#9a6a38"; g.fillRect(x, y, 9, 8); g.fillStyle = "#7a4e26"; g.fillRect(x, y + 5, 9, 1);
        g.fillStyle = fruit[(i + v) % 5]; g.fillRect(x + 1, y - 2, 7, 3);
        g.fillStyle = shade(fruit[(i + v) % 5], 1.25); g.fillRect(x + 2, y - 2, 2, 1);
      }
    });
    // Cafe table with an umbrella.
    art.table = color => item(`tb:${color}`, 26, 32, 13, 29, g => {
      ellipse(g, 13, 29, 9, 2, "rgba(0,0,0,.22)");
      g.fillStyle = "#e8e4dc"; g.fillRect(7, 20, 12, 2); g.fillStyle = "#6a6a6a"; g.fillRect(12, 22, 2, 7);
      g.fillStyle = "#6a6a6a"; g.fillRect(12, 6, 1, 14);
      g.fillStyle = color; g.fillRect(2, 4, 22, 3); g.fillRect(5, 2, 16, 2);
      g.fillStyle = "#ffffff"; for (let x = 4; x < 24; x += 6) g.fillRect(x, 4, 3, 3);
      g.fillStyle = "#8a6a44"; g.fillRect(4, 24, 3, 4); g.fillRect(19, 24, 3, 4);
    });
    // Flag on a pole.
    art.flag = color => item(`fl:${color}`, 22, 60, 3, 58, g => {
      ellipse(g, 4, 58, 3, 1, "rgba(0,0,0,.25)");
      g.fillStyle = "#cfd3da"; g.fillRect(2, 2, 2, 56); g.fillStyle = "#ffffff"; g.fillRect(2, 1, 2, 1);
      g.fillStyle = color; g.fillRect(4, 3, 14, 9); g.fillStyle = "#ffffff"; g.fillRect(4, 6, 14, 2);
    });

    for (const part of CV._artParts) part(art, CV);
    return art;
  };
})();
