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
  // The stage colours of the minimap's Homes overlay and of a "condition" overlay given by values: the
  // dashboard's Condition ramp (window.Dash.RAMPS.condition) when the page has the dashboard, so the minimap,
  // the map tint and the legend agree, else the same five colours (dashboard.js STAGE_COLOR).
  CV.STAGE_COLORS = ["#0ca30c", "#9aa5b8", "#fab219", "#ec835a", "#d03b3b"];
  CV.stageColors = () => {
    const r = window.Dash && window.Dash.RAMPS && window.Dash.RAMPS.condition;
    return Array.isArray(r) && r.length === 5 && r.every(c => typeof c === "string") ? r : CV.STAGE_COLORS;
  };

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

  // --- ground: the only place tile art is chosen (view.md 3.8, 4.5) ------------------------------------------
  // CV.groundKey(R, x, y, season) -> [drawer, ...args]; art[drawer](...args) is the tw x (th + 24) tile. Codes are
  // region.md 3.1's: . grass, # street, B D building lots, P park, T tree (grass under it), e entry walk, ~ water,
  // b road bridge, x level crossing, F farmland, = rail, r rail bridge, S platform, H highway, h highway bridge.
  // R needs w, h and either tiles (rows of code characters) or code (Uint8Array) with CODE (code character or
  // name -> int). An optional R.groundOverride(x, y, season) -> key | null lets the scene keep its own choice for a
  // tile (Millbrook's lawns, drives and lots). Off the map, streets run on (as v2's roads do at the map edge).
  const CODE_NAMES = { grass: ".", street: "#", road: "#", building: "B", lot: "D", park: "P", tree: "T", entry: "e",
    water: "~", road_bridge: "b", bridge: "b", crossing: "x", farm: "F", farmland: "F", rail: "=", rail_bridge: "r",
    platform: "S", highway: "H", highway_bridge: "h", frozen: "?" };
  const readers = new WeakMap();
  function codeReader(R) {
    let f = readers.get(R);
    if (f) return f;
    const W = R.w, Hh = R.h;
    if (R.tiles) f = (x, y) => x < 0 || y < 0 || x >= W || y >= Hh ? null : R.tiles[y][x];
    else if (typeof R.charAt === "function") f = (x, y) => x < 0 || y < 0 || x >= W || y >= Hh ? null : R.charAt(x, y);
    else {
      const inv = [];
      for (const k of Object.keys(R.CODE || {})) inv[R.CODE[k]] = k.length === 1 ? k : CODE_NAMES[k] || ".";
      f = (x, y) => x < 0 || y < 0 || x >= W || y >= Hh ? null : inv[R.code[y * W + x]] || ".";
    }
    readers.set(R, f);
    return f;
  }
  CV.tileVariant = (x, y) => hash(x * 7919 + y * 104729 + 13) % 8; // scene.js's per-tile variant
  const STREETS = "#bx", ROADLIKE = "#bxHh", RAILS = "=rx", HIGHWAYS = "Hh", OVER_WATER = "~brh";
  CV.groundKey = function (R, x, y, season) {
    if (typeof R.groundOverride === "function") { const o = R.groundOverride(x, y, season); if (o) return o; }
    const at = codeReader(R), c = at(x, y), v = CV.tileVariant(x, y), s = season || "summer";
    const W = R.w, Hh = R.h;
    // streets run off the map's edges (v2's isRoad)
    const isIn = (a, b, set) => {
      if (a >= 0 && b >= 0 && a < W && b < Hh) return set.indexOf(at(a, b)) >= 0;
      const cx = Math.max(0, Math.min(W - 1, a)), cy = Math.max(0, Math.min(Hh - 1, b));
      if (b >= 0 && b < Hh) return set.indexOf(at(cx, b)) >= 0;
      if (a >= 0 && a < W) return b < 0 && set.indexOf(at(a, 0)) >= 0;
      return false;
    };
    const mask4 = set => (isIn(x, y - 1, set) ? 1 : 0) | (isIn(x + 1, y, set) ? 2 : 0) | (isIn(x, y + 1, set) ? 4 : 0) | (isIn(x - 1, y, set) ? 8 : 0);
    const diag4 = set => (isIn(x + 1, y - 1, set) ? 1 : 0) | (isIn(x + 1, y + 1, set) ? 2 : 0) | (isIn(x - 1, y + 1, set) ? 4 : 0) | (isIn(x - 1, y - 1, set) ? 8 : 0);
    const mb = R.millbrook || CV.MILLBROOK || [0, 0, 80, 50];
    const inMill = x >= mb[0] && y >= mb[1] && x < mb[0] + mb[2] && y < mb[1] + mb[3];
    switch (c) {
      case "#": {
        // an 80 x 50 town keeps v2's rule (streets meet streets only); in the region streets also meet bridges,
        // crossings and highway ramps, and outside Millbrook's rectangle they gain edge lines
        const set = W <= 80 && Hh <= 50 ? "#" : ROADLIKE;
        return inMill ? ["road", mask4(set), diag4(set), s, v % 4] : ["road", mask4(set), diag4(set), s, v % 4, 1];
      }
      case "~": {
        const L = (a, b) => { const t = at(a, b); return t !== null && OVER_WATER.indexOf(t) < 0; };
        return ["water", (L(x, y - 1) ? 1 : 0) | (L(x + 1, y) ? 2 : 0) | (L(x, y + 1) ? 4 : 0) | (L(x - 1, y) ? 8 : 0), v % 4];
      }
      case "b": return ["roadBridge", mask4(ROADLIKE), s, v % 4];
      case "x": return ["crossing", mask4(ROADLIKE), mask4(RAILS + "S"), s, v % 4];
      case "=": return ["rail", mask4(RAILS), s, v % 4];
      case "r": return ["railBridge", mask4(RAILS), s, v % 4];
      case "S": return ["platform", mask4(RAILS), s, v % 2];
      case "H": return ["highway", mask4(HIGHWAYS), mask4("#bx"), s, v % 4];
      case "h": return ["highwayBridge", mask4(HIGHWAYS), s, v % 4];
      case "F": return ["farm", s, (hash((x >> 3) * 31 + (y >> 2) * 7 + 5) % 6) * 2 + ((x >> 3) + (y >> 2)) % 2];
      case "P": return ["park", s, v % 4];
      case "B": case "D": return ["apron", v % 4, 0, s];
      case "e": return ["entry", s, "y", true, 0];
      default: return ["grass", s, v];
    }
  };
  // The tile for a key, falling back to grass for a drawer this build does not have.
  CV.groundTileOf = function (art, key) {
    const f = art[key[0]];
    if (typeof f === "function") return f.apply(art, key.slice(1));
    return art.grass(key.find(a => typeof a === "string" && SEASON[a]) || "summer", 0);
  };

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
    // A home lot's lawn by neglect stage: striped and kept, unmown with dandelions, straw-yellow, overgrown,
    // dead. Under snow the kept lawns are clean white and the neglected ones show stalks, weeds and dirt.
    art.lawn = (season, stage, v) => groundTile(`l:${season}:${stage}:${v}`, g => {
      const S = SEASON[season];
      if (S.snow) {
        const base = ["#e2ebe8", S.grass, "#c9d2cc", "#bcc4bc", "#b2b4a8"][stage];
        poly(g, D(0, 0, 1, 1), base);
        speckle(g, v * 13 + 1, [S.light, S.dark], 14);
        if (stage === 0) { speckle(g, v * 5 + 3, ["#ffffff"], 10); return; }
        if (stage === 1) { tufts(g, v * 7 + 3, 4, "#8a8a6a", "#a8a888"); return; }
        if (stage === 2) { tufts(g, v * 7 + 3, 12, "#a08a4a", "#c8b46a", 0.08, 0.92, true); return; }
        const R = rng(v * 29 + stage);
        for (let i = 0; i < (stage === 4 ? 4 : 2); i++) { // trodden, dirty or bare patches
          const u = 0.12 + R() * 0.6, w = 0.14 + R() * 0.14, vv = 0.12 + R() * 0.6;
          poly(g, D(u, vv, u + w, vv + w * 0.9), stage === 4 ? "#7d6343" : "#9a9a88");
          if (stage === 4) speckle(g, i * 7 + v, ["#6a5238", "#8f7552", "#d8dcd8"], 6, Math.min(u, vv), Math.min(0.95, Math.max(u, vv) + w));
        }
        tufts(g, v * 7919 + 3, stage === 4 ? 16 : 20, "#4a4a32", "#7a7a52", 0.06, 0.94, true); // dead weeds through the snow
        tufts(g, v * 31 + 5, 8, "#6a5a2a", "#a8984a", 0.06, 0.94, true);
        return;
      }
      if (stage === 0) {
        const a = mix(S.grass, "#6fd04a", 0.25), b = shade(a, 1.08);
        poly(g, D(0, 0, 1, 1), a);
        for (let i = 0; i < 4; i++) if (i % 2 === 0) poly(g, D(i / 4, 0, (i + 1) / 4, 1), b); // mowed stripes
        speckle(g, v * 7 + 1, [shade(a, 0.92)], 10);
        if (S.flower.length && v % 2 === 0) speckle(g, v * 3 + 2, S.flower, 4, 0.1, 0.9);
      } else if (stage === 1) { // unmown: no stripes, the grass grown out unevenly in tall clumps
        const base = mix(S.grass, "#8a9a3a", 0.14);
        poly(g, D(0, 0, 1, 1), base);
        speckle(g, v * 97 + 1, [S.dark, S.light, shade(base, 0.88)], 26);
        tufts(g, v * 5 + 1, 6, S.dark, S.light, 0.06, 0.94, true);
        const R = rng(v * 41 + 9);
        for (let c = 0; c < 3; c++) { // clumps: a darker footing, then long blades of uneven height
          const cu = 0.18 + R() * 0.64, cw = 0.18 + R() * 0.64;
          poly(g, D(cu - 0.07, cw - 0.05, cu + 0.07, cw + 0.06), shade(base, 0.86));
          for (let i = 0; i < 10; i++) {
            const p = T(cu + (R() - 0.5) * 0.16, cw + (R() - 0.5) * 0.14), x = Math.round(p[0]), y = Math.round(p[1]), hh = 3 + Math.floor(R() * 4);
            g.fillStyle = shade(base, 0.68); g.fillRect(x, y - hh + 1, 1, hh);
            if (R() < 0.5) g.fillRect(x + 1, y - hh + 3, 1, hh - 2);
            g.fillStyle = shade(base, 1.18); g.fillRect(x, y - hh, 1, 1);
          }
        }
      } else if (stage === 2) { // mostly straw-yellow with a few green patches
        const base = mix(S.grass, "#c8b46a", 0.6);
        poly(g, D(0, 0, 1, 1), base);
        const R = rng(v * 13 + 2);
        for (let i = 0; i < 2; i++) { // what green is left
          const u = 0.15 + R() * 0.55, w = 0.14 + R() * 0.14, vv = 0.15 + R() * 0.55;
          poly(g, D(u, vv, u + w, vv + w * 0.8), mix(S.grass, "#a8a050", 0.25));
        }
        for (let i = 0; i < 2; i++) { // bald dry spots
          const u = 0.15 + R() * 0.6, w = 0.1 + R() * 0.1, vv = 0.15 + R() * 0.6;
          poly(g, D(u, vv, u + w, vv + w * 0.8), "#d8c890");
        }
        speckle(g, v * 19 + 3, ["#a89a58", "#8a8a48", "#e0d090"], 26);
        tufts(g, v * 9 + 4, 14, shade(base, 0.76), shade(base, 1.12), 0.08, 0.92, true);
      } else if (stage === 3) { // overgrown and gone to seed: olive-khaki, pale seed heads, brown patches
        const base = mix(S.grass, "#86803a", 0.6);
        poly(g, D(0, 0, 1, 1), base);
        const R = rng(v * 23 + 3);
        for (let i = 0; i < 2; i++) { // dead brown patches
          const u = 0.12 + R() * 0.6, w = 0.12 + R() * 0.12, vv = 0.12 + R() * 0.6;
          poly(g, D(u, vv, u + w, vv + w * 0.8), mix(base, "#7a5e3a", 0.55));
          speckle(g, v * 7 + i, ["#6a5034", "#8a7048"], 4, Math.min(u, vv), Math.min(0.95, Math.max(u, vv) + w));
        }
        speckle(g, v * 19 + 3, [shade(base, 0.86), shade(base, 1.1), "#a89a58"], 24);
        for (let i = 0; i < 24; i++) { // long stalks: a deep-green shadow, an olive blade, a pale seed head
          const p = T(0.06 + R() * 0.88, 0.06 + R() * 0.88), x = Math.round(p[0]), y = Math.round(p[1]), hh = 3 + Math.floor(R() * 4);
          g.fillStyle = "#3a5424"; g.fillRect(x + 1, y - hh + 3, 1, hh - 2);
          g.fillStyle = shade(base, 0.78); g.fillRect(x, y - hh + 1, 1, hh);
          g.fillStyle = i % 4 ? "#c8bd7a" : "#e2d8a0"; g.fillRect(x, y - hh - 1, 1, 2);
        }
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
    // In winter a kept home's drive is shovelled (bare concrete between snow banks); from stage 1 it is left
    // under the snow with tyre ruts.
    const strip = (axis, a, b, c0, c1) => axis === "y" ? D(a, c0, b, c1) : D(c0, a, c1, b);
    art.drive = (season, stage, axis, v) => groundTile(`dr:${season}:${stage}:${axis}:${v}`, g => {
      g.drawImage(art.lawn(season, stage, v), 0, 0);
      if (SEASON[season].snow) {
        if (stage === 0) {
          poly(g, strip(axis, 0.18, 0.82, 0, 1), "#ffffff");
          poly(g, strip(axis, 0.25, 0.75, 0, 1), "#aea89c");
          poly(g, strip(axis, 0.25, 0.75, 0.48, 0.52), "#9c968a");
          speckle(g, v * 3 + 1, ["#c8c2b6", "#ffffff"], 8, 0.3, 0.7);
        } else {
          poly(g, strip(axis, 0.22, 0.78, 0, 1), "#e6ecee");
          for (const r of [0.33, 0.6]) poly(g, strip(axis, r, r + 0.06, 0, 1), "#c6ced2");
        }
        return;
      }
      const c = stage >= 3 ? "#a9a49a" : "#c4bfb3";
      poly(g, strip(axis, 0.22, 0.78, 0, 1), c);
      poly(g, strip(axis, 0.22, 0.78, 0.48, 0.52), shade(c, 0.9));
      if (stage >= 3) speckle(g, v * 3, ["#7a7468", "#5f8a34"], 10, 0.25, 0.75);
    });
    // Cracks with weeds in them, on the paving round a run-down block of flats (stage 2 and up): jagged dark
    // lines with a pale lip, tufts in the cracks, and from stage 3 a broken slab.
    function cracks(g, stage, v, season) {
      if (stage < 2) return;
      const R = rng(v * 97 + stage * 13 + 5), weed = SEASON[season].snow ? ["#7a6a4a", "#a8946a"] : ["#4f7f2c", "#7cab3e"];
      for (let c = 0; c < stage - 1; c++) {
        let u = 0.1 + R() * 0.8, w = R() < 0.5 ? 0.04 : 0.96;
        const du = (R() - 0.5) * 0.12, dw = w < 0.5 ? 0.09 : -0.09;
        for (let k = 0; k < 9; k++) {
          const p = T(u, w), x = Math.round(p[0]), y = Math.round(p[1]);
          g.fillStyle = "#6e695e"; g.fillRect(x, y, 2, 1); g.fillStyle = "#d8d2c4"; g.fillRect(x, y + 1, 2, 1);
          if (k % 3 === 2) { g.fillStyle = weed[0]; g.fillRect(x, y - 2, 1, 3); g.fillRect(x + 2, y - 1, 1, 2); g.fillStyle = weed[1]; g.fillRect(x + 1, y - 3, 1, 3); }
          u = Math.max(0.04, Math.min(0.96, u + du + (R() - 0.5) * 0.1)); w += dw;
        }
      }
      if (stage >= 3) { const u = 0.2 + R() * 0.5, w = 0.2 + R() * 0.5; poly(g, D(u, w, u + 0.18, w + 0.14), "#9a9488"); poly(g, D(u + 0.02, w + 0.02, u + 0.16, w + 0.12), "#857f72"); speckle(g, v + 3, weed, 4, Math.min(u, w), Math.max(u, w) + 0.15); }
    }
    // Paved plaza: stone slabs in two tones with joints. Downtown and around shops and flats.
    art.pavement = (v, tone, stage, season) => groundTile(`pv:${tone || ""}:${v}:${stage | 0}:${stage >= 2 ? season : ""}`, g => {
      const base = tone || "#cbc4b4", alt = shade(base, 0.95), joint = shade(base, 0.84);
      poly(g, D(0, 0, 1, 1), base);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if ((i + j + v) % 2) poly(g, D(i / 2, j / 2, (i + 1) / 2, (j + 1) / 2), alt);
      poly(g, D(0.49, 0, 0.52, 1), joint); poly(g, D(0, 0.49, 1, 0.52), joint);
      poly(g, D(0, 0, 0.03, 1), joint); poly(g, D(0, 0, 1, 0.03), joint);
      speckle(g, v * 41 + 7, [shade(base, 0.9), shade(base, 1.05)], 8);
      cracks(g, stage | 0, v, season || "summer");
    });
    // Concrete apron around a building's inset body.
    art.apron = (v, stage, season) => groundTile(`ap:${v}:${stage | 0}:${stage >= 2 ? season : ""}`, g => {
      poly(g, D(0, 0, 1, 1), "#b4afa3");
      speckle(g, v * 5 + 1, ["#a39e92", "#c2bdb1"], 10);
      cracks(g, stage | 0, v + 11, season || "summer");
    });
    // Works yard: gravel with painted bay markings.
    art.yard = v => groundTile(`y:${v}`, g => {
      poly(g, D(0, 0, 1, 1), "#8f8c84");
      speckle(g, v * 41 + 1, ["#7c7970", "#a39f94", "#6d6a62"], 30);
      if (v % 4 === 0) poly(g, D(0.1, 0.46, 0.9, 0.52), "#e0bf4c");
      if (v % 4 === 2) { poly(g, D(0.3, 0.3, 0.5, 0.45), "#4a4a46"); }
    });
    // The walk from a door to the street.
    // The walk from a door to the street. In winter a kept home (stage 0) has it shovelled: bare flags
    // between white banks; from stage 1 it lies under the snow with a line of footprints.
    art.entry = (season, axis, paved, stage) => groundTile(`e:${season}:${axis}:${paved ? 1 : 0}:${SEASON[season].snow && !paved ? (stage ? 1 : 0) : 0}`, g => {
      const S = SEASON[season];
      if (paved) { g.drawImage(art.pavement(1), 0, 0); return; }
      poly(g, D(0, 0, 1, 1), S.grass);
      speckle(g, 5, [S.dark, S.light], 16);
      if (S.snow && stage) {
        const c = "#eef2f2";
        if (axis === "y") poly(g, D(0.32, 0, 0.68, 1), c); else poly(g, D(0, 0.32, 1, 0.68), c);
        for (let i = 0; i < 4; i++) { const p = axis === "y" ? T(0.45 + (i % 2) * 0.1, 0.12 + i * 0.24) : T(0.12 + i * 0.24, 0.45 + (i % 2) * 0.1); g.fillStyle = "#c2cacc"; g.fillRect(Math.round(p[0]), Math.round(p[1]), 2, 1); }
        return;
      }
      if (S.snow) { if (axis === "y") poly(g, D(0.27, 0, 0.73, 1), "#ffffff"); else poly(g, D(0, 0.27, 1, 0.73), "#ffffff"); }
      const c = S.snow ? "#bdb6aa" : "#d8cfbd", e = shade(c, 0.85);
      if (axis === "y") { poly(g, D(0.32, 0, 0.68, 1), e); poly(g, D(0.35, 0, 0.65, 1), c); for (let i = 1; i < 4; i++) poly(g, D(0.35, i / 4, 0.65, i / 4 + 0.025), e); }
      else { poly(g, D(0, 0.32, 1, 0.68), e); poly(g, D(0, 0.35, 1, 0.65), c); for (let i = 1; i < 4; i++) poly(g, D(i / 4, 0.35, i / 4 + 0.025, 0.65), e); }
    });

    // --- open land (the scene derives these uses for blocks the map leaves empty) ----------------------------
    // Rough meadow: unmown grass with straw, wildflowers and the odd bare spot.
    art.meadow = (season, v) => groundTile(`m:${season}:${v}`, g => {
      const S = SEASON[season];
      const base = S.snow ? "#d6e0dc" : mix(S.grass, "#a8a85a", 0.25);
      poly(g, D(0, 0, 1, 1), base);
      const R = rng(v * 71 + 5);
      for (let i = 0; i < 2; i++) {
        const u = 0.1 + R() * 0.6, w = 0.18 + R() * 0.16, vv = 0.1 + R() * 0.6;
        poly(g, D(u, vv, u + w, vv + w * 0.8), S.snow ? "#e8efec" : mix(base, i ? "#d0c478" : S.dark, 0.4));
      }
      if (!S.snow && v % 4 === 1) { const u = 0.3 + R() * 0.3, vv = 0.3 + R() * 0.3; poly(g, D(u, vv, u + 0.16, vv + 0.12), "#9a8058"); }
      speckle(g, v * 17 + 3, S.snow ? ["#ffffff", "#c2ccc8"] : [S.dark, S.light, "#c0b468"], 28);
      tufts(g, v * 23 + 1, S.snow ? 10 : 18, S.snow ? "#8a8a6a" : shade(base, 0.7), S.snow ? "#b0a880" : "#d0c478", 0.06, 0.94, true);
      if (S.flower.length) speckle(g, v * 5 + 9, ["#ffffff", "#f6e05a", "#b99af0", "#f39ac0"], 6, 0.1, 0.9);
    });
    // Playing field turf in mown stripes (k = 0 or 1); the lines are drawn over it by art.pitchLines.
    art.pitch = (season, k) => groundTile(`pi:${season}:${k}`, g => {
      const S = SEASON[season];
      const a = S.snow ? "#e4ebe8" : mix(S.grass, "#58c444", 0.35);
      poly(g, D(0, 0, 1, 1), k ? shade(a, 1.08) : a);
      speckle(g, k * 13 + 5, [shade(a, 0.93), shade(a, 1.04)], 10);
    });
    // Touchlines, halfway line, centre circle, penalty and goal boxes of a pitch over [x0, x1] x [y0, y1],
    // drawn in world coordinates into a ground chunk. Long axis along x when alongX.
    art.pitchLines = (g, x0, y0, x1, y1, alongX) => {
      const c = "#f6f8f2", w = 0.06;
      const L = alongX ? (a, b) => [a, b] : (a, b) => [b, a]; // (along, across) -> tile
      const [a0, a1, b0, b1] = alongX ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
      const band = (p, q, r, s) => { const A = L(p, r), B = L(q, r), C = L(q, s), E = L(p, s); poly(g, [P(A[0], A[1]), P(B[0], B[1]), P(C[0], C[1]), P(E[0], E[1])], c); };
      band(a0, a1, b0, b0 + w); band(a0, a1, b1 - w, b1); band(a0, a0 + w, b0, b1); band(a1 - w, a1, b0, b1);
      const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
      band(am - w / 2, am + w / 2, b0, b1);
      const r = Math.min(1.0, (b1 - b0) * 0.17);
      for (let k = 0; k < 40; k++) { // centre circle
        const t0 = k / 40 * Math.PI * 2, t1 = (k + 1) / 40 * Math.PI * 2;
        const p = (rr, t) => { const q = L(am + rr * Math.cos(t), bm + rr * Math.sin(t)); return P(q[0], q[1]); };
        poly(g, [p(r, t0), p(r, t1), p(r - w, t1), p(r - w, t0)], c);
      }
      for (const end of [-1, 1]) { // penalty box, goal box and spot
        const e = end < 0 ? a0 : a1, bw = Math.min(1.7, (a1 - a0) * 0.16), bh = (b1 - b0) * 0.56, gw = bw * 0.4, gh = bh * 0.5;
        const f = d => e - end * d;
        band(Math.min(e, f(bw)), Math.max(e, f(bw)), bm - bh / 2, bm - bh / 2 + w); band(Math.min(e, f(bw)), Math.max(e, f(bw)), bm + bh / 2 - w, bm + bh / 2);
        band(Math.min(f(bw), f(bw - w)), Math.max(f(bw), f(bw - w)), bm - bh / 2, bm + bh / 2);
        band(Math.min(e, f(gw)), Math.max(e, f(gw)), bm - gh / 2, bm - gh / 2 + w); band(Math.min(e, f(gw)), Math.max(e, f(gw)), bm + gh / 2 - w, bm + gh / 2);
        band(Math.min(f(gw), f(gw - w)), Math.max(f(gw), f(gw - w)), bm - gh / 2, bm + gh / 2);
        const sp = L(f(bw * 0.72), bm), q = P(sp[0], sp[1]); g.fillStyle = c; g.fillRect(Math.round(q[0]) - 1, Math.round(q[1]), 2, 1);
      }
      const cs = L(am, bm), q = P(cs[0], cs[1]); g.fillStyle = c; g.fillRect(Math.round(q[0]) - 1, Math.round(q[1]), 2, 1);
    };
    // Allotment plot: a soil bed with rows of one crop (k picks it), a grass path around it.
    const CROPS = [["#2f7a2a", "#5fb04a"], ["#3a7a6a", "#7ab8a0"], ["#4a8a22", "#a2d84a"], ["#3f8f3a", "#d8402a"], ["#3f8f3a", "#f2c83a"], null];
    art.plot = (season, k, v) => groundTile(`pl:${season}:${k}:${v}`, g => {
      const S = SEASON[season];
      poly(g, D(0, 0, 1, 1), S.snow ? "#dde6e2" : mix(S.grass, "#9aa04a", 0.25));
      speckle(g, v * 11 + 2, S.snow ? ["#ffffff"] : [S.dark, S.light], 10);
      const soil = S.snow ? "#e9efed" : "#7a5838", edge = S.snow ? "#b8b2a4" : "#5a3e24";
      poly(g, D(0.1, 0.1, 0.9, 0.9), edge); poly(g, D(0.12, 0.12, 0.9, 0.88), soil);
      const crop = CROPS[k % CROPS.length], R = rng(k * 31 + v * 7 + 1);
      for (let i = 0; i < 4; i++) {
        const v0 = 0.17 + i * 0.18;
        if (S.snow) { poly(g, D(0.15, v0, 0.86, v0 + 0.05), "#c8c0b0"); continue; }
        poly(g, D(0.15, v0, 0.86, v0 + 0.07), shade(soil, 0.82)); // furrow
        if (!crop) continue;
        for (let u = 0.18; u < 0.84; u += 0.09) {
          const p = T(u + R() * 0.02, v0 + 0.02), x = Math.round(p[0]), y = Math.round(p[1]);
          g.fillStyle = crop[0]; g.fillRect(x - 1, y - 2, 3, 3);
          g.fillStyle = crop[1]; g.fillRect(x, y - 2, 1, 1); if (k === 3 || k === 4) g.fillRect(x - 1, y, 1, 1);
        }
      }
      if (S.snow) tufts(g, v * 3 + k, 6, "#6a5a3a", "#8a7a5a", 0.15, 0.85, true);
    });
    // Car park tiles: asphalt with white bay lines, two bays per tile, open toward the aisle ("bayN" opens
    // north, "bayS" south), or a plain aisle with a painted arrow now and then.
    art.parking = (season, kind, v) => groundTile(`cp:${season}:${kind}:${v}`, g => {
      const snow = SEASON[season].snow;
      const asphalt = snow ? "#6c7078" : "#5c6068", line = snow ? "#eef2f4" : "#e9e9e2";
      poly(g, D(0, 0, 1, 1), asphalt);
      speckle(g, v * 13 + 7, [shade(asphalt, 1.12), shade(asphalt, 0.9)], 18);
      if (kind === "aisle") {
        if (v % 4 === 0) { poly(g, D(0.3, 0.47, 0.62, 0.53), line); poly(g, D(0.62, 0.4, 0.7, 0.6), line); }
      } else {
        const [a, b] = kind === "bayN" ? [0, 0.9] : [0.1, 1];
        for (const u of [0, 0.485, 0.97]) poly(g, D(u, a, u + 0.03, b), line);
        const z = kind === "bayN" ? 0.87 : 0.1;
        poly(g, D(0.02, z, 0.98, z + 0.03), line);
      }
      if (snow) speckle(g, v * 3 + 1, ["#f4f6f8", "#dfe3e6"], 12);
    });

    // Roads: asphalt, sidewalks on every side that meets a non-road tile, a kerb, a dashed centre line
    // along the axis, zebra crossings on the arms of junctions and sidewalk corners where blocks meet.
    // mask bits: 1 N, 2 E, 4 S, 8 W road neighbours; diag bits: 1 NE, 2 SE, 4 SW, 8 NW road diagonals.
    const SW = 0.17;
    art.SIDEWALK = SW;
    // marks (region streets): white edge lines inside the gutters of straight runs, and zebras on every arm of a
    // junction (v2's own junction zebras stay as they are).
    art.road = (mask, diag, season, v, marks) => groundTile(`r:${mask}:${diag}:${season}:${v}${marks ? ":m" : ""}`, g => {
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
      if (marks && arms <= 2) { // edge lines a little inside each kerb of a straight run
        const e = snow ? "#f6f6f6" : "#e8e8e2", a = k + 0.05, b = 1 - k - 0.05;
        if ((mask & 10) && !(mask & 5)) { if (N) poly(g, D(0, a, 1, a + 0.022), e); if (S) poly(g, D(0, b - 0.022, 1, b), e); }
        else if ((mask & 5) && !(mask & 10)) { if (Wd) poly(g, D(a, 0, a + 0.022, 1), e); if (E) poly(g, D(b - 0.022, 0, b, 1), e); }
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
    // stage 0 white pickets, 1 off-white with a leaning picket or two, 2 grey with 1 in 5 boards gone,
    // 3 a third gone and broken rails, 4 a few grey posts.
    art.fence = (stage, side, v) => oriented(`f:${stage}:${side}:${v}`, 80, 56, 40, 36, g => {
      const post = ["#ffffff", "#d6d0bf", "#bdb4a0", "#a89c84", "#8a7e66"][stage];
      const dark = shade(post, stage === 0 ? 0.72 : 0.66);
      const e = side === "n" ? [[0, 0], [1, 0]] : side === "s" ? [[0, 1], [1, 1]] : side === "w" ? [[0, 0], [0, 1]] : [[1, 0], [1, 1]];
      const at = (t, z) => P(e[0][0] + (e[1][0] - e[0][0]) * t, e[0][1] + (e[1][1] - e[0][1]) * t, z);
      const R = rng(v * 7 + stage * 31 + side.charCodeAt(0));
      const railOk = stage <= 3;
      if (railOk) { // rails
        for (const z of [4, 8]) {
          const segs = stage >= 3 ? [[0, 0.35], [0.6, 1]] : [[0, 1]];
          for (const [a, b] of segs) poly(g, [at(a, z), at(b, z), at(b, z + 1.2), at(a, z + 1.2)], stage >= 1 ? dark : shade(post, 0.86));
        }
      }
      const n = 9;
      const leanAt = stage === 1 ? [v % 3 + 2, v % 2 ? 7 : -1] : [];
      for (let i = 0; i <= n; i++) {
        const t = (i + 0.5) / (n + 1);
        const r = R();
        if (stage === 2 && i % 5 === (v + 2) % 5) continue;
        if (stage === 3 && r < 0.34) continue;
        if (stage === 4 && (i % 3 !== 0 || r < 0.3)) continue;
        const p = at(t, 0), x = Math.round(p[0]), y = Math.round(p[1]);
        const hh = stage === 4 ? 7 + Math.floor(r * 4) : 11;
        const lean = leanAt.includes(i) || (stage >= 2 && r > 0.82) ? (i % 2 ? 1 : -1) : 0;
        if (lean) { // a picket knocked askew: the top half slips one pixel sideways
          const half = Math.ceil(hh / 2);
          g.fillStyle = dark; g.fillRect(x, y - half, 2, half); g.fillRect(x + lean, y - hh, 2, hh - half);
          g.fillStyle = post; g.fillRect(x, y - half, 1, half); g.fillRect(x + lean, y - hh, 1, hh - half);
          continue;
        }
        g.fillStyle = dark; g.fillRect(x, y - hh, 2, hh);
        g.fillStyle = post; g.fillRect(x, y - hh, 1, hh);
        if (stage <= 2) { g.fillStyle = post; g.fillRect(x, y - hh - 1, 1, 1); }
      }
    });
    // Clipped hedge (big houses) along one lot edge: a green box; ragged from stage 1, wild as it rises.
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
      const n = stage === 0 ? 6 : 12;
      for (let i = 0; i < n; i++) {
        const a = i / n, b = (i + 1) / n;
        const hh = h + (stage === 1 ? Math.floor(R() * 4) - 1 : stage >= 2 ? Math.floor(R() * (stage * 2)) - stage : 0);
        const along = side === "n" || side === "s";
        const bx0 = along ? x0 + a : x0, bx1 = along ? x0 + b : x1, by0 = along ? y0 : y0 + a, by1 = along ? y1 : y0 + b;
        if (stage === 4 && R() < 0.2) continue;
        boxAt(g, bx0, by0, bx1, by1, 0, Math.max(3, hh), base, shade(base, stage === 0 ? 1.25 : stage === 1 ? 1.16 : 1.12));
      }
      if (stage >= 1) { // shoots sticking out of an untrimmed top
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
    art.junk = (stage, v, snow) => item(`j:${stage}:${v}:${snow ? 1 : 0}`, 34, 26, 17, 21, g => {
      ellipse(g, 17, 21, 14, 3, "rgba(0,0,0,.25)");
      g.fillStyle = "#2f4a2c"; g.fillRect(3, 9, 9, 12); g.fillStyle = "#3e5e3a"; g.fillRect(3, 9, 3, 12);
      g.fillStyle = "#24381f"; g.fillRect(2, 7, 11, 3);
      if (stage >= 2) { // overflowing: a second bin, lids pushed up on full bags, a split bag at the foot, litter
        g.fillStyle = "#2a4428"; g.fillRect(13, 11, 8, 10); g.fillStyle = "#38563a"; g.fillRect(13, 11, 2, 10);
        g.fillStyle = "#1e1e1e"; g.fillRect(13, 6, 8, 5); g.fillStyle = "#3a3a3e"; g.fillRect(14, 7, 2, 1);
        g.fillStyle = "#24381f"; g.fillRect(15, 3, 8, 2); g.fillRect(21, 5, 2, 2); // lid propped open
        g.fillStyle = "#1e1e1e"; g.fillRect(3, 3, 9, 5); g.fillStyle = "#3a3a3e"; g.fillRect(4, 4, 2, 1);
        g.fillStyle = "#24381f"; g.fillRect(2, 1, 9, 2);
        g.fillStyle = "#c84a3a"; g.fillRect(9, 4, 2, 2); g.fillStyle = "#e8e2d0"; g.fillRect(6, 2, 3, 1);
        g.fillStyle = "#26262a"; g.fillRect(21, 15, 6, 6); g.fillStyle = "#44444a"; g.fillRect(22, 16, 2, 1); g.fillRect(23, 13, 2, 2);
        g.fillStyle = "#e8e2d0"; g.fillRect(27, 20, 2, 1); g.fillRect(11, 21, 1, 1); g.fillStyle = "#c84a3a"; g.fillRect(29, 19, 2, 1); g.fillStyle = "#6a9ac8"; g.fillRect(17, 21, 2, 1);
      }
      if (stage >= 3) {
        g.fillStyle = "#1a1a1a"; g.fillRect(15, 15, 9, 6); g.fillStyle = "#3a3a3a"; g.fillRect(17, 16, 5, 4); g.fillStyle = "#1a1a1a"; g.fillRect(18, 17, 3, 2); // tyre
        g.fillStyle = "#26262a"; g.fillRect(24, 11, 7, 8); g.fillStyle = "#44444a"; g.fillRect(25, 12, 2, 2); g.fillRect(27, 9, 2, 2); // bin bags
      }
      if (stage >= 4) {
        g.fillStyle = "#d8cfb0"; g.fillRect(12, 6, 18, 6); g.fillStyle = "#b8ab88"; g.fillRect(12, 10, 18, 2); g.fillStyle = "#a89a7a"; g.fillRect(15, 7, 2, 1); g.fillRect(21, 8, 3, 1); // mattress
        g.fillStyle = "#8a5a3a"; g.fillRect(2, 21, 10, 2); g.fillStyle = "#6a6a70"; g.fillRect(26, 20, 6, 2);
      }
      if (snow) { // snow caps on whatever pokes out, and a drift round the foot
        g.fillStyle = "#ffffff"; g.fillRect(2, 6, 11, 2);
        if (stage >= 2) { g.fillRect(2, 0, 9, 1); g.fillRect(15, 2, 8, 1); g.fillRect(13, 5, 2, 1); g.fillRect(21, 14, 6, 1); }
        if (stage >= 3) { g.fillRect(15, 14, 9, 1); g.fillRect(24, 10, 7, 2); }
        if (stage >= 4) g.fillRect(12, 5, 18, 2);
        g.fillStyle = "#e8eef2"; g.fillRect(1, 19, 14, 3); if (stage >= 3) g.fillRect(14, 19, 18, 3);
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

    // Football goal on a pitch's end line: posts, crossbar and a net sloping back. alongX: the pitch's long
    // axis; end: -1 for the low end, 1 for the high end.
    art.goal = (alongX, end) => oriented(`goal:${alongX ? 1 : 0}:${end}`, 70, 50, 35, 34, g => {
      const L = alongX ? (a, b) => [0.5 + a, 0.5 + b] : (a, b) => [0.5 + b, 0.5 + a];
      const Q = (a, b, z) => { const t = L(a, b); return P(t[0], t[1], z); };
      const back = end * 0.28, hw = 0.36, h = 11;
      g.fillStyle = "rgba(255,255,255,0.35)";
      poly(g, [Q(0, -hw, h), Q(0, hw, h), Q(back, hw, 0), Q(back, -hw, 0)], "rgba(236,240,244,0.45)"); // net roof
      for (let k = 0; k <= 6; k++) { const b = -hw + k * hw / 3; const p0 = Q(0, b, h), p1 = Q(back, b, 0); g.fillStyle = "rgba(220,226,232,0.8)"; poly(g, [p0, [p0[0] + 1, p0[1]], [p1[0] + 1, p1[1]], p1]); }
      for (const b of [-hw, hw]) { const p = Q(0, b, 0); g.fillStyle = "#ffffff"; g.fillRect(Math.round(p[0]), Math.round(p[1]) - h, 2, h); g.fillStyle = "#c8ccd0"; g.fillRect(Math.round(p[0]) + 1, Math.round(p[1]) - h, 1, h); }
      poly(g, [Q(0, -hw, h + 1), Q(0, hw, h + 1), Q(0, hw, h - 1), Q(0, -hw, h - 1)], "#ffffff");
    });
    // Allotment shed: a small timber hut with a felt roof and a window.
    art.shed = v => oriented(`shed:${v}`, 48, 52, 24, 40, g => {
      const wood = ["#8a5a32", "#5a7a4a", "#4a6a8a", "#9a7a4a"][v % 4];
      shadowEllipse(g, 26, 40, 14, 4);
      const x0 = 0.3, y0 = 0.32, x1 = 0.7, y1 = 0.68;
      boxAt(g, x0, y0, x1, y1, 0, 13, wood, shade(wood, 1.1));
      for (const f of proj.faces) { const F = faceFn(f, x0, y0, x1, y1); for (let u = 0.06; u < F.len; u += 0.08) poly(g, quad(F, u, u + 0.012, 0, 13), shade(wood, f === proj.faces[0] ? 0.85 : 0.7)); }
      const F = faceFn(proj.faces[0], x0, y0, x1, y1);
      poly(g, quad(F, F.len * 0.55, F.len * 0.85, 5, 10), "#8cb8d8"); poly(g, quad(F, F.len * 0.12, F.len * 0.4, 0, 11), shade(wood, 0.6));
      const ym = (y0 + y1) / 2;
      poly(g, [P(x0 - 0.04, y1 + 0.04, 13), P(x1 + 0.04, y1 + 0.04, 13), P(x1 + 0.04, ym, 19), P(x0 - 0.04, ym, 19)], "#3a3a40");
      poly(g, [P(x0 - 0.04, y0 - 0.04, 13), P(x1 + 0.04, y0 - 0.04, 13), P(x1 + 0.04, ym, 19), P(x0 - 0.04, ym, 19)], "#2a2a30");
      poly(g, [P(x1, y0, 13), P(x1, y1, 13), P(x1, ym, 19)], shade(wood, 0.78));
    });
    // Wire fence along one edge of a tile: thin grey posts and two wires.
    art.wire = side => oriented(`wire:${side}`, 80, 40, 40, 26, g => {
      const e = side === "n" ? [[0, 0], [1, 0]] : side === "s" ? [[0, 1], [1, 1]] : side === "w" ? [[0, 0], [0, 1]] : [[1, 0], [1, 1]];
      const at = (t, z) => P(e[0][0] + (e[1][0] - e[0][0]) * t, e[0][1] + (e[1][1] - e[0][1]) * t, z);
      for (const z of [4, 8]) poly(g, [at(0, z), at(1, z), at(1, z + 1), at(0, z + 1)], "rgba(190,196,200,0.85)");
      for (const t of [0.02, 0.5]) { const p = at(t, 0); g.fillStyle = "#5a6068"; g.fillRect(Math.round(p[0]), Math.round(p[1]) - 10, 1, 10); }
    });
    // Shipping container, 1.5 x 0.5 tiles, along x or y, optionally with a second one stacked on top.
    art.container = (c1, c2, alongX) => oriented(`ct:${c1}:${c2 || ""}:${alongX ? 1 : 0}`, 120, 96, 60, 64, g => {
      const [x0, y0, x1, y1] = alongX ? [-0.25, 0.25, 1.25, 0.75] : [0.25, -0.25, 0.75, 1.25];
      const box = (z0, col) => {
        boxAt(g, x0, y0, x1, y1, z0, z0 + 16, col, shade(col, 1.15));
        for (const f of proj.faces) {
          const F = faceFn(f, x0, y0, x1, y1), k = f === proj.faces[0] ? 0.82 : 0.66;
          for (let u = 0.05; u < F.len - 0.03; u += 0.07) poly(g, quad(F, u, u + 0.02, z0 + 1, z0 + 15), shade(col, k));
          poly(g, quad(F, 0, F.len, z0 + 15, z0 + 16), shade(col, k * 0.9));
        }
      };
      ellipse(g, 60, 64, 40, 10, "rgba(0,0,0,0.18)");
      box(0, c1);
      if (c2) box(16, c2);
    });
    // "LAND FOR SALE" board on two posts, for an empty block.
    art.landSign = () => item("landsign", 64, 40, 32, 37, g => {
      ellipse(g, 32, 37, 20, 2, "rgba(0,0,0,.25)");
      g.fillStyle = "#5a3e24"; g.fillRect(12, 14, 2, 24); g.fillRect(50, 14, 2, 24);
      g.fillStyle = "#1e1e24"; g.fillRect(2, 1, 60, 18);
      g.fillStyle = "#f4f0e6"; g.fillRect(3, 2, 58, 16);
      g.fillStyle = "#d63a3a"; g.fillRect(3, 2, 58, 7);
      pixelText(g, "FOR SALE", 32 - Math.round(textWidth("FOR SALE") / 2), 3, "#ffffff");
      pixelText(g, "LAND", 32 - Math.round(textWidth("LAND") / 2), 11, "#2a2a30");
    });

    for (const part of CV._artParts) part(art, CV);
    return art;
  };
})();
