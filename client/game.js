// GameOfAILife God view: a Pokémon-style top-down pixel map of the city, drawn on a canvas.
"use strict";

const T = 16; // tile size in canvas pixels; CSS scales the canvas up with crisp pixels
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

let ws = null;
let town = null;
let state = null;
let speed = 1;
let role = "god";
let selected = null;
let detail = null;
let terrain = null; // pre-rendered static layer
let terrainSeason = null;
let lamps = []; // [x, y] canvas pixels of street-lamp bulbs, for the night glow
const shown = {}; // agent id -> smoothed {x, y} for drawing
const events = [];
const forks = [];
let lastFrame = performance.now();

// --- colours ----------------------------------------------------------------

const SEASON_GRASS = {
  spring: ["#5fb34a", "#529f3f", "#76c55c"],
  summer: ["#6fb43c", "#5f9f33", "#8bc950"],
  autumn: ["#a5a33f", "#8f8c35", "#c5a54a"],
  winter: ["#b9c9c2", "#a3b5ae", "#d4e0db"],
};
const ROOF = { home: "#c4533b", office: "#4b6ea8", school: "#d18f2f", market: "#3f9c6a",
  cafe: "#9a5aa8", hospital: "#e9e9ef", bank: "#2f6f73", townhall: "#8a6d3b", shop: "#d0663a", works: "#6e6a62" };
const WALL = { home: "#f2dfbd", office: "#c9d3e3", school: "#f0d9a8", market: "#e3efe0",
  cafe: "#efe0f0", hospital: "#ffffff", bank: "#dfe9e6", townhall: "#efe4cf", shop: "#f6e3cf", works: "#b9b4aa" };
// Homes by style: blocks of flats and big houses stand out from the ordinary houses.
const HOME_ROOF = { apartments: "#7d5a8c", big_house: "#3d6b4f" };
const HOME_WALL = { apartments: "#e6dccd", big_house: "#f4ead2" };
const roofOf = p => (p.kind === "home" && HOME_ROOF[p.style]) || ROOF[p.kind] || "#8a8a8a";
const wallOf = p => (p.kind === "home" && HOME_WALL[p.style]) || WALL[p.kind] || "#dddddd";

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
// --- a tiny 3x5 pixel font, so map text stays crisp when the canvas is scaled up ---------

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
};
// Glyphs are 5 rows tall; their width is the string length / 5 (M and W are wider so they stay legible).
const glyphOf = ch => GLYPHS[ch] || GLYPHS["?"];
function pixelWidth(text) {
  let w = -1;
  for (const ch of text.toUpperCase()) w += glyphOf(ch).length / 5 + 1;
  return Math.max(0, w);
}
function pixelText(g, text, x, y, color) {
  g.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = glyphOf(ch), gw = glyph.length / 5;
    for (let b = 0; b < glyph.length; b++) if (glyph[b] === "1") g.fillRect(cx + (b % gw), y + Math.floor(b / gw), 1, 1);
    cx += gw + 1;
  }
}
// Text with a dark plate behind it, centred on cx; y is the top of the plate.
function plate(g, text, cx, y, fg = "#ffffff", bg = "rgba(20,24,34,.85)") {
  const w = pixelWidth(text) + 4, x = Math.round(cx - w / 2);
  g.fillStyle = bg; g.fillRect(x, y, w, 9); g.fillRect(x + 1, y - 1, w - 2, 11);
  pixelText(g, text, x + 2, y + 2, fg);
}

function shortName(p) {
  if (p.kind === "home") return p.name.replace(/ house$/i, "");
  return p.name;
}

function shirt(id) { return `hsl(${hash(id) % 360} 65% 55%)`; }
function hair(id) { return ["#3b2416", "#6b4423", "#1d1d1d", "#c9a14a", "#8a3b1c", "#b8b8b8"][hash(id + "h") % 6]; }

// --- terrain ------------------------------------------------------------------

function buildTerrain() {
  const season = state ? state.season : "spring";
  const off = document.createElement("canvas");
  off.width = town.w * T;
  off.height = town.h * T;
  const g = off.getContext("2d");
  const [grass, grassDark, grassLight] = SEASON_GRASS[season];
  for (let y = 0; y < town.h; y++) {
    for (let x = 0; x < town.w; x++) {
      const c = town.tiles[y][x];
      const px = x * T, py = y * T;
      const r = hash(`${x},${y}`);
      if (c === "#") {
        g.fillStyle = "#5d6168"; g.fillRect(px, py, T, T);
        g.fillStyle = "#666a72"; g.fillRect(px + (r % 12), py + ((r >> 4) % 12), 2, 2);
        const horiz = town.road_rows.includes(y), vert = town.road_cols.includes(x);
        g.fillStyle = "#e8d36a";
        if (horiz && !vert && x % 2 === 0) g.fillRect(px + 3, py + 7, 10, 2);
        if (vert && !horiz && y % 2 === 0) g.fillRect(px + 7, py + 3, 2, 10);
        if (horiz && vert) { // crosswalk stripes
          g.fillStyle = "#d9dbe0";
          for (let i = 1; i < T; i += 4) { g.fillRect(px + i, py, 2, 2); g.fillRect(px + i, py + T - 2, 2, 2); }
        }
      } else if (c === "~") { // the river: not walkable
        g.fillStyle = "#3d8fd1"; g.fillRect(px, py, T, T);
        if (r % 3 === 0) { g.fillStyle = "#79b9ea"; g.fillRect(px + (r % 9) + 2, py + ((r >> 3) % 10) + 3, 5, 1); }
      } else if (c === "P" || c === "T") {
        g.fillStyle = grassDark; g.fillRect(px, py, T, T);
        if (r % 7 === 0) { g.fillStyle = ["#f4e04d", "#f08ab4", "#ffffff"][r % 3]; g.fillRect(px + 5, py + 6, 2, 2); g.fillRect(px + 10, py + 10, 2, 2); }
      } else {
        g.fillStyle = grass; g.fillRect(px, py, T, T);
        if (r % 5 === 0) { g.fillStyle = grassLight; g.fillRect(px + (r % 11) + 2, py + ((r >> 3) % 11) + 2, 1, 3); g.fillRect(px + (r % 11) + 4, py + ((r >> 3) % 11) + 3, 1, 2); }
      }
      if (c === "e") { g.fillStyle = "#c9b48a"; g.fillRect(px + 3, py, 10, T); }
    }
  }
  // Trees after ground so canopies overlap neighbours a little.
  for (let y = 0; y < town.h; y++) for (let x = 0; x < town.w; x++) {
    if (town.tiles[y][x] !== "T") continue;
    const px = x * T, py = y * T;
    g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 3, py + 12, 11, 3);
    g.fillStyle = "#6b4a2b"; g.fillRect(px + 7, py + 9, 3, 6);
    g.fillStyle = season === "winter" ? "#e9f1ef" : season === "autumn" ? "#c8662c" : "#2f7d32";
    g.fillRect(px + 2, py + 1, 12, 9); g.fillRect(px + 4, py - 1, 8, 2);
    g.fillStyle = season === "autumn" ? "#e2913a" : season === "winter" ? "#ffffff" : "#45a047";
    g.fillRect(px + 4, py + 2, 4, 3);
  }
  // Street lamps on the grass verge north of each east-west road.
  lamps = [];
  for (const ry of town.road_rows) for (let x = 1; x < town.w; x += 4) {
    if (ry < 1 || town.road_cols.includes(x) || town.tiles[ry - 1][x] !== ".") continue;
    const px = x * T + 12, py = ry * T - 14;
    g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px - 1, py + 13, 4, 2);
    g.fillStyle = "#3b4150"; g.fillRect(px, py + 2, 2, 12);
    g.fillStyle = "#2a2f3a"; g.fillRect(px - 1, py, 4, 3);
    g.fillStyle = "#fff3c4"; g.fillRect(px, py + 1, 2, 1);
    lamps.push([px + 1, py + 2]);
  }
  for (const p of town.places) if (p.kind !== "park") drawBuilding(g, p);
  // A sign at each park's entrance tile.
  for (const park of town.places) {
    if (park.kind !== "park") continue;
    const ex = park.entry[0] * T, ey = park.entry[1] * T;
    g.fillStyle = "#6b4a2b"; g.fillRect(ex + 3, ey + 8, 2, 7); g.fillRect(ex + 11, ey + 8, 2, 7);
    plate(g, park.name, ex + 8, ey + 1, "#ffffff", "#7a5530");
  }
  terrain = off;
  terrainSeason = season;
}

function drawBuilding(g, p) {
  const x = p.x * T, y = p.y * T, w = p.w * T, h = p.h * T;
  const roofH = Math.floor(h * 0.55);
  g.fillStyle = "rgba(0,0,0,.28)"; g.fillRect(x + 3, y + 4, w, h); // shadow
  g.fillStyle = wallOf(p); g.fillRect(x, y + roofH, w, h - roofH); // front wall
  g.fillStyle = roofOf(p); g.fillRect(x - 1, y, w + 2, roofH); // roof
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(x - 1, y + roofH - 3, w + 2, 3); // eave
  g.fillStyle = "rgba(255,255,255,.18)";
  for (let i = 4; i < roofH - 4; i += 4) g.fillRect(x + 1, y + i, w - 2, 1); // tiles
  // Windows on the front wall.
  const wy = y + roofH + 4;
  for (let wx = x + 4; wx < x + w - 6; wx += 12) {
    if (Math.abs(wx + 3 - (p.entry[0] * T + 8)) < 9) continue;
    g.fillStyle = "#3a5a7a"; g.fillRect(wx, wy, 7, 6);
    g.fillStyle = "#9cc8ea"; g.fillRect(wx + 1, wy + 1, 2, 2);
  }
  // Door.
  const dx = p.entry[0] * T + 4, dy = (p.entry[1] - 1) * T + 4;
  g.fillStyle = "#6b4226"; g.fillRect(dx, dy, 8, 12);
  g.fillStyle = "#e3b54a"; g.fillRect(dx + 6, dy + 6, 1, 2);
  // Chimney on houses, roof ridge highlight on everything.
  g.fillStyle = "rgba(255,255,255,.25)"; g.fillRect(x - 1, y, w + 2, 2);
  if (p.kind === "home" && p.style !== "apartments") {
    g.fillStyle = "#7a3a2a"; g.fillRect(x + w - 11, y - 4, 5, 8);
    g.fillStyle = "#5a2a1e"; g.fillRect(x + w - 12, y - 5, 7, 2);
  }
  // Name plate over the eave, Pokémon-sign style.
  const name = shortName(p);
  if (pixelWidth(name) + 4 <= w + 6) plate(g, name, x + w / 2, y + roofH - 7, "#ffffff", "rgba(30,26,22,.78)");
  // Sign on the roof.
  const sx = Math.round(x + w / 2), sy = Math.round(y + (roofH - 7) / 2);
  g.fillStyle = "#ffffff";
  if (p.kind === "hospital") { g.fillStyle = "#e23b3b"; g.fillRect(sx - 1, sy - 5, 3, 11); g.fillRect(sx - 5, sy - 1, 11, 3); }
  else if (p.kind === "cafe") { g.fillRect(sx - 4, sy - 2, 7, 6); g.fillRect(sx + 3, sy - 1, 2, 3); }
  else if (p.kind === "school") { g.fillStyle = "#7a4d12"; g.fillRect(sx - 5, sy - 3, 11, 7); g.fillStyle = "#fff"; g.fillRect(sx - 3, sy - 1, 7, 1); g.fillRect(sx - 3, sy + 1, 5, 1); }
  else if (p.kind === "market") { g.fillRect(sx - 5, sy - 1, 10, 5); g.fillStyle = "#f4d03f"; g.fillRect(sx - 6, sy - 3, 12, 2); }
  else if (p.kind === "office") { g.fillStyle = "#cfe1ff"; for (let i = -6; i <= 4; i += 5) g.fillRect(sx + i, sy - 3, 3, 6); }
}

// --- drawing each frame ----------------------------------------------------------

function nightAlpha(minute) {
  const h = minute / 60;
  if (h >= 21 || h < 5) return 0.5;
  if (h < 7) return 0.5 * (1 - (h - 5) / 2);
  if (h >= 19) return 0.5 * ((h - 19) / 2);
  return 0;
}

let drops = [];
// Rain (or snow) drops for the whole canvas: about one for every 1,800 square pixels.
function makeDrops() {
  const n = Math.round(canvas.width * canvas.height / 1800);
  drops = Array.from({ length: n }, () => ({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, s: 2 + Math.random() * 3 }));
}

function draw(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  requestAnimationFrame(draw);
  if (!town || !state) return;
  if (!terrain || terrainSeason !== state.season) buildTerrain();
  ctx.drawImage(terrain, 0, 0);

  const night = nightAlpha(state.minute);
  drawLights();
  drawBuses();

  // Agents, sorted by y so lower ones overlap higher ones like in Pokémon.
  const ppl = state.agents.filter(a => a.alive && !a.inside && !a.riding).sort((a, b) => a.y - b.y);
  const step = Math.max(1, (state.speed || speed) * 2.4 * 3) * dt;
  for (const a of state.agents) {
    const s = shown[a.id] || (shown[a.id] = { x: a.x, y: a.y });
    const dx = a.x - s.x, dy = a.y - s.y, d = Math.hypot(dx, dy);
    if (d > 4 || d <= step) { s.x = a.x; s.y = a.y; } else { s.x += dx / d * step; s.y += dy / d * step; }
  }
  for (const a of ppl) drawAgent(a, shown[a.id], now);
  drawPlane();

  if (night > 0) {
    ctx.fillStyle = `rgba(16, 24, 64, ${night})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawNightLights(night);
  }
  if (state.weather === "rain") drawRain(dt, state.season === "winter");
  drawSelectedInside(now);
  drawOccupancy();
  for (const a of ppl) if (selected === a.id || hover === a.id) {
    const s = shown[a.id];
    plate(ctx, a.name.split(" ")[0], Math.round(s.x * T) + 8, Math.round(s.y * T) - 12,
      selected === a.id ? "#ffe27a" : "#ffffff");
  }
}

// Windows of occupied buildings and street lamps glow through the night tint.
function drawNightLights(night) {
  const k = Math.min(1, night / 0.5);
  const occupied = new Set(state.agents.filter(a => a.alive && a.inside).map(a => a.inside));
  for (const p of town.places) {
    if (p.kind === "park") continue;
    const lit = occupied.has(p.id) || (p.kind !== "home" && p.kind !== "school" && (!p.hours || (state.minute / 60 >= p.hours[0] && state.minute / 60 < p.hours[1])));
    if (!lit) continue;
    const roofH = Math.floor(p.h * T * 0.55), wy = p.y * T + roofH + 4;
    for (let wx = p.x * T + 4; wx < (p.x + p.w) * T - 6; wx += 12) {
      if (Math.abs(wx + 3 - (p.entry[0] * T + 8)) < 9) continue;
      if (p.kind === "home" && hash(p.id + wx) % 4 === 0) continue;
      ctx.fillStyle = `rgba(255, 200, 90, ${0.18 * k})`; ctx.fillRect(wx - 2, wy - 2, 11, 10);
      ctx.fillStyle = `rgba(255, 220, 120, ${0.95 * k})`; ctx.fillRect(wx, wy, 7, 6);
      ctx.fillStyle = `rgba(200, 140, 60, ${0.9 * k})`; ctx.fillRect(wx + 3, wy, 1, 6);
    }
  }
  for (const [lx, ly] of lamps) {
    // A pool of light on the ground below the bulb, plus the bulb itself.
    const gx = lx, gy = ly + 14;
    const grad = ctx.createRadialGradient(gx, gy, 1, gx, gy, 16);
    grad.addColorStop(0, `rgba(255, 226, 140, ${0.32 * k})`);
    grad.addColorStop(1, "rgba(255, 226, 140, 0)");
    ctx.fillStyle = grad; ctx.fillRect(gx - 16, gy - 16, 32, 32);
    ctx.fillStyle = `rgba(255, 240, 190, ${0.35 * k})`; ctx.fillRect(lx - 2, ly - 2, 4, 4);
    ctx.fillStyle = `rgba(255, 248, 215, ${k})`; ctx.fillRect(lx - 1, ly - 1, 2, 2);
  }
}

// The selected character is indoors: pulse an outline around their building and name them at the door.
function drawSelectedInside(now) {
  if (!selected) return;
  const a = state.agents.find(x => x.id === selected);
  if (!a || !a.alive || !a.inside) return;
  const p = town.places.find(q => q.id === a.inside);
  if (!p) return;
  const on = Math.floor(now / 400) % 2 === 0;
  ctx.strokeStyle = on ? "#ffe27a" : "#f6a945"; ctx.lineWidth = 2;
  ctx.strokeRect(p.x * T - 3, p.y * T - 3, p.w * T + 6, p.h * T + 6);
  plate(ctx, a.name.split(" ")[0], p.entry[0] * T + 8, p.entry[1] * T + 4, "#ffe27a");
}

function drawLights() {
  const col = { green: "#3ee06a", yellow: "#ffd23f", red: "#ff4040" };
  const crossings = town.junctions || town.road_rows.flatMap(y => town.road_cols.map(x => [x, y]));
  for (const [x, y] of crossings) {
    const px = x * T, py = y * T;
    ctx.fillStyle = "#222"; ctx.fillRect(px - 2, py - 2, 4, 4); ctx.fillRect(px + T - 2, py + T - 2, 4, 4);
    ctx.fillStyle = col[state.lights.ns]; ctx.fillRect(px - 1, py - 1, 2, 2);
    ctx.fillStyle = col[state.lights.ew]; ctx.fillRect(px + T - 1, py + T - 1, 2, 2);
  }
}

function drawBuses() {
  for (const b of state.buses || []) {
    const px = b.x * T, py = b.y * T;
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fillRect(px + 1, py + 4, 15, 11);
    ctx.fillStyle = b.line === "2" ? "#e2553f" : "#f2b705"; ctx.fillRect(px, py + 2, 15, 11);
    ctx.fillStyle = "#3a5a7a"; for (let i = 1; i < 14; i += 4) ctx.fillRect(px + i, py + 4, 3, 3);
    ctx.fillStyle = "#222"; ctx.fillRect(px + 2, py + 12, 3, 2); ctx.fillRect(px + 10, py + 12, 3, 2);
  }
}

function drawAgent(a, s, now) {
  const px = Math.round(s.x * T), py = Math.round(s.y * T);
  const moving = a.state === "travelling";
  const sel = selected === a.id;
  if (sel) { ctx.strokeStyle = "#f6c445"; ctx.lineWidth = 1; ctx.strokeRect(px + 1.5, py - 1.5, 13, 17); }
  if (moving && a.vehicle === "car") {
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fillRect(px + 2, py + 7, 13, 8);
    ctx.fillStyle = shirt(a.id); ctx.fillRect(px + 1, py + 5, 14, 8);
    ctx.fillStyle = "#cfe6ff"; ctx.fillRect(px + 4, py + 6, 8, 3);
    ctx.fillStyle = "#222"; ctx.fillRect(px + 2, py + 12, 3, 2); ctx.fillRect(px + 11, py + 12, 3, 2);
    return;
  }
  const child = a.age < 13;
  const bob = moving && Math.floor(now / 160) % 2 ? 1 : 0;
  const top = py + (child ? 4 : 1) + bob;
  ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(px + 4, py + 14, 8, 2); // shadow
  ctx.fillStyle = "#2e3a59"; // legs
  if (moving && bob) { ctx.fillRect(px + 5, top + 10, 2, child ? 2 : 3); ctx.fillRect(px + 9, top + 9, 2, child ? 2 : 3); }
  else { ctx.fillRect(px + 5, top + 10, 2, child ? 2 : 3); ctx.fillRect(px + 9, top + 10, 2, child ? 2 : 3); }
  ctx.fillStyle = shirt(a.id); ctx.fillRect(px + 4, top + 5, 8, 6); // body
  ctx.fillStyle = "#f1c6a0"; ctx.fillRect(px + 5, top, 6, 5); // face
  ctx.fillStyle = a.age >= 65 ? "#d0d0d0" : hair(a.id); ctx.fillRect(px + 4, top - 1, 8, 2);
  ctx.fillStyle = "#222"; ctx.fillRect(px + 6, top + 2, 1, 1); ctx.fillRect(px + 9, top + 2, 1, 1);
  if (a.state === "deciding") bubble(px + 10, top - 9, "?", a.controller ? "#6cb6ff" : "#ffffff");
  else if (a.activity === "phone_call" || a.activity === "text") bubble(px + 10, top - 9, "...", "#ffffff");
}

// A speech bubble with a pixel-font glyph, outlined so it reads on grass and road alike.
function bubble(x, y, ch, color) {
  const w = pixelWidth(ch) + 4;
  ctx.fillStyle = "#222"; ctx.fillRect(x - 1, y - 1, w + 2, 9); ctx.fillRect(x, y + 8, 3, 2);
  ctx.fillStyle = color; ctx.fillRect(x, y, w, 7); ctx.fillRect(x + 1, y + 7, 1, 1);
  pixelText(ctx, ch, x + 2, y + 1, "#222");
}

function drawOccupancy() {
  const counts = {};
  for (const a of state.agents) if (a.alive && a.inside) counts[a.inside] = (counts[a.inside] || 0) + 1;
  for (const p of town.places) {
    const n = counts[p.id];
    if (!n || p.kind === "park") continue;
    const text = String(n), w = pixelWidth(text) + 4;
    const x = (p.x + p.w) * T - w - 1, y = p.y * T - 3;
    ctx.fillStyle = "#3a2a10"; ctx.fillRect(x - 1, y - 1, w + 2, 9);
    ctx.fillStyle = "#f6c445"; ctx.fillRect(x, y, w, 7);
    pixelText(ctx, text, x + 2, y + 1, "#2a1d05");
  }
}

function drawPlane() {
  if (!state.plane) return;
  const x = -30 + state.plane.progress * (canvas.width + 60), y = 46 - state.plane.progress * 20;
  ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.fillRect(x + 20, y + 60, 18, 4); // shadow far below
  ctx.fillStyle = "#f4f6fa"; ctx.fillRect(x, y, 22, 5); ctx.fillRect(x + 8, y - 6, 5, 17); ctx.fillRect(x, y - 4, 3, 5);
  ctx.fillStyle = "#4b6ea8"; ctx.fillRect(x + 17, y + 1, 4, 2);
}

function drawRain(dt, snow) {
  ctx.fillStyle = snow ? "rgba(255,255,255,.9)" : "rgba(170,200,255,.6)";
  for (const d of drops) {
    d.y += (snow ? 30 : 260) * dt * (d.s / 3);
    d.x += (snow ? Math.sin(d.y / 20) * 10 : -40) * dt;
    if (d.y > canvas.height) { d.y = -5; d.x = Math.random() * (canvas.width + 40); }
    if (d.x < -10) d.x = canvas.width + 10;
    if (snow) ctx.fillRect(d.x, d.y, 2, 2); else ctx.fillRect(d.x, d.y, 1, d.s + 2);
  }
}

// --- input -----------------------------------------------------------------------

let hover = null;
function tileAt(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * canvas.width / T, y: (ev.clientY - r.top) / r.height * canvas.height / T };
}
function agentAt(t) {
  let best = null, bestD = 1.1;
  for (const a of state.agents) {
    if (!a.alive || a.inside) continue;
    const s = shown[a.id] || a;
    const d = Math.hypot(s.x + 0.5 - t.x, s.y + 0.5 - t.y);
    if (d < bestD) { best = a; bestD = d; }
  }
  return best;
}
function placeAt(t) {
  return town.places.find(p => t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h + 1);
}
canvas.addEventListener("mousemove", ev => {
  if (!state) return;
  const t = tileAt(ev), a = agentAt(t), p = a ? null : placeAt(t);
  hover = a ? a.id : null;
  const tip = document.getElementById("tooltip");
  let text = "";
  if (a) text = `${a.name} · ${pretty(a.activity)}`;
  else if (p) {
    const inside = state.agents.filter(x => x.alive && x.inside === p.id).map(x => x.name.split(" ")[0]);
    const hours = p.hours ? `${p.hours[0]}:00–${p.hours[1]}:00` : "always open";
    text = `${p.name} (${hours})${inside.length ? " · " + inside.join(", ") : ""}`;
  }
  tip.hidden = !text;
  tip.textContent = text;
  const r = canvas.getBoundingClientRect(), wr = canvas.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.max(0, Math.min(ev.clientX - wr.left + 12, r.width - tip.offsetWidth - 4))}px`;
  tip.style.top = `${ev.clientY - wr.top + 14}px`;
});
canvas.addEventListener("mouseleave", () => { hover = null; document.getElementById("tooltip").hidden = true; });
canvas.addEventListener("click", ev => {
  if (!state) return;
  const t = tileAt(ev), a = agentAt(t);
  if (a) return select(a.id);
  const p = placeAt(t);
  if (p) {
    const inside = state.agents.filter(x => x.alive && x.inside === p.id);
    if (inside.length) select(inside[0].id);
  }
});

document.getElementById("speed").addEventListener("click", ev => {
  const b = ev.target.closest("button");
  if (b) send({ type: "set_speed", speed: Number(b.dataset.speed) });
});
document.getElementById("tabs").addEventListener("click", ev => {
  const b = ev.target.closest("button");
  if (!b) return;
  for (const x of document.querySelectorAll("#tabs button")) x.classList.toggle("on", x === b);
  for (const id of ["people", "events", "forks"]) document.getElementById(`tab-${id}`).hidden = id !== b.dataset.tab;
});

// --- side panel --------------------------------------------------------------------

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = s => String(s || "").replace(/_/g, " ");
const NEED_COLOR = { hunger: "#f0a04b", energy: "#6cb6ff", social: "#f08ab4", fun: "#6fcf7c" };

function select(id) {
  if (id !== selected) editingProfile = null;
  selected = id;
  detail = null;
  detailKey = "";
  document.querySelector('#tabs button[data-tab="people"]').click();
  send({ type: "get_agent", agent_id: id });
  renderPeople();
}

function renderHeader() {
  document.getElementById("clock").textContent = state.time;
  const w = state.weather === "rain" ? (state.season === "winter" ? "❄ Snow" : "🌧 Rain") : "☀ Clear";
  const plane = state.plane ? ` · ✈ ${state.plane.from} to ${state.plane.to}` : "";
  document.getElementById("weather").textContent = `${state.season[0].toUpperCase() + state.season.slice(1)} · ${w}${plane}`;
  for (const b of document.querySelectorAll("#speed button")) b.classList.toggle("on", Number(b.dataset.speed) === speed);
}

// A view that lost God keeps watching, with God's controls locked.
function lockControls() {
  const watching = role !== "god";
  document.body.classList.toggle("watching", watching);
  for (const el of document.querySelectorAll("#speed button, #luck, #saveprof")) el.disabled = watching;
}

let toastTimer = 0;
function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function renderPeople() {
  const roster = document.getElementById("roster"), box = document.getElementById("detail");
  if (selected && detail) {
    roster.hidden = true;
    box.hidden = false;
    renderDetail(box);
    return;
  }
  roster.hidden = false;
  box.hidden = true;
  roster.innerHTML = state.agents.map(a => `
    <li data-id="${a.id}" class="${a.alive ? "" : "dead"}${a.id === selected ? " sel" : ""}">
      <span class="swatch" style="background:${shirt(a.id)}"></span>
      <span class="grow"><b>${esc(a.name)}</b> <span class="small">${a.alive ? esc(pretty(a.activity)) : "died"}</span></span>
      <span class="where small">${a.alive ? esc(a.inside ? placeName(a.inside) : "outside") : ""}</span>
      <span class="luckchip" title="Luck">☘ ${a.luck}</span>
      ${a.controller ? `<span class="small" title="Played by ${esc(a.controller)}">🤖</span>` : ""}
    </li>`).join("");
}
document.getElementById("roster").addEventListener("click", ev => {
  const li = ev.target.closest("li");
  if (li) select(li.dataset.id);
});
// The roster is not refreshed while a press on it is down: replacing the row under the pointer loses the click.
let rosterPress = false;
document.getElementById("roster").addEventListener("pointerdown", () => { rosterPress = true; });
for (const t of ["pointerup", "pointercancel"]) window.addEventListener(t, () => { rosterPress = false; }, true);

let editingProfile = null; // id of the character whose play style has unsaved edits in the panel
let detailKey = "";
// Everything in the panel except the live numbers; when it is unchanged we only refresh the numbers,
// so scrolling, hovering and half-dragged sliders are never clobbered by the 800 ms refresh.
function staticKey(a) {
  return JSON.stringify([a.id, a.alive, a.controller, a.job, a.profile, a.possessions, a.relationships,
    a.memory, a.forks.map(f => [f.id, f.choice, f.happened])]);
}
function renderDetail(box) {
  const a = detail;
  const active = document.activeElement;
  const key = staticKey(a);
  const same = key === detailKey && box.querySelector("#live");
  const mine = box.dataset.agent === a.id; // the panel already shows this character
  if (same || mine && (box.contains(active) && (active.tagName === "TEXTAREA" || active.type === "range") || editingProfile === a.id)) {
    // Keep the God's edits; only refresh the live numbers.
    const live = box.querySelector("#live");
    if (live) live.innerHTML = liveHtml(a);
    const luck = box.querySelector("#luck");
    if (luck && active !== luck) { luck.value = a.luck; box.querySelector("#luckv").textContent = Math.round(a.luck); }
    return;
  }
  detailKey = key;
  box.dataset.agent = a.id;
  const traits = Object.entries(a.profile.traits).map(([k, v]) => `
      <label for="t-${k}">${k}</label><input id="t-${k}" data-trait="${k}" type="range" min="0" max="1" step="0.05" value="${v}"><span>${v.toFixed(2)}</span>`).join("");
  const forksHtml = a.forks.slice().reverse().map(forkHtml).join("") || '<li class="small">No decisions yet.</li>';
  const rels = Object.entries(a.relationships).slice(0, 8).map(([id, r]) =>
    `<li>${esc(r.name)} <span class="small">${r.kind} · ${r.affinity > 0 ? "+" : ""}${r.affinity}</span></li>`).join("");
  box.innerHTML = `
    <button class="back" id="back">← Everyone</button>
    <h2>${esc(a.name)}</h2>
    <a class="small" id="fullpage" href="character.html?id=${encodeURIComponent(a.id)}">Open the full character page</a>
    <div class="small">${a.age} · ${a.job ? esc(a.job.title) : "retired"} · ${a.controller ? "played by " + esc(a.controller) : "running on profile defaults"}</div>
    <div id="live">${liveHtml(a)}</div>
    <div class="luck">
      <div class="row"><span>Cursed</span><b style="color:var(--text)">Luck <span id="luckv">${Math.round(a.luck)}</span></b><span>Blessed</span></div>
      <input id="luck" type="range" min="0" max="100" step="1" value="${a.luck}" aria-label="Luck">
      <div class="small">Your only power. ${esc(a.name.split(" ")[0])} will never know. Luck tilts the hidden odds of every outcome.</div>
      <div class="small watchnote">Watching only: God moved to another window, so luck is locked here.</div>
    </div>
    <h3>Play style</h3>
    <textarea id="prompt" aria-label="Play-style prompt">${esc(a.profile.prompt)}</textarea>
    <div class="traits">${traits}</div>
    <button class="btn" id="saveprof">Save play style</button>
    <span class="small" id="savednote">${a.profile.edited ? "Written by you" : "Learns from choices"}</span>
    <h3>Recent decisions</h3><ul class="feed">${forksHtml}</ul>
    <h3>Owns</h3>
    <ul class="list">
      <li>${esc(a.possessions.home.name)} <span class="small">${homeTerms(a.possessions.home)}</span></li>
      <li>${a.possessions.car ? "A car" : "No car"}</li>
      <li>Phone <span class="small">${a.possessions.phone.condition}</span></li>
      <li>${a.possessions.groceries_at_home} meals in the fridge</li>
      ${a.possessions.savings_goal ? `<li>Saving for ${esc(a.possessions.savings_goal.name)} <span class="small">$${Math.round(a.possessions.savings_goal.saved)} of $${a.possessions.savings_goal.target}</span></li>` : ""}
    </ul>
    <h3>People</h3><ul class="list">${rels || '<li class="small">Nobody yet.</li>'}</ul>
    <h3>Memory</h3><ul class="list">${a.memory.slice().reverse().map(m => `<li>${esc(m)}</li>`).join("") || '<li class="small">Nothing yet.</li>'}</ul>`;
  box.querySelector("#back").onclick = () => { selected = null; detail = null; detailKey = ""; editingProfile = null; renderPeople(); };
  box.querySelector("#fullpage").onclick = ev => {
    // A plain click opens the page in this tab, and this view lets go of God as it unloads: leave that
    // page a one-shot note so it skips its takeover question. A new tab gets no note and asks first.
    if (role === "god" && ev.button === 0 && !(ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)) {
      try { sessionStorage.setItem("goal.character.from-city", String(Date.now())); } catch {}
    }
  };
  const luck = box.querySelector("#luck");
  luck.oninput = () => { box.querySelector("#luckv").textContent = luck.value; };
  // After a drag, let go of focus so the panel keeps refreshing; arrow keys keep it, to go on stepping.
  let dragged = false;
  luck.onpointerdown = () => { dragged = true; };
  luck.onkeydown = () => { dragged = false; };
  luck.onchange = () => { send({ type: "set_luck", agent_id: a.id, luck: Number(luck.value) }); if (dragged) luck.blur(); };
  for (const r of box.querySelectorAll("[data-trait]")) {
    r.oninput = () => { editingProfile = a.id; r.dataset.moved = "1"; r.nextElementSibling.textContent = Number(r.value).toFixed(2); };
  }
  box.querySelector("#prompt").oninput = () => { editingProfile = a.id; };
  box.querySelector("#saveprof").onclick = () => {
    // Only the sliders God moved, so the others keep what the profile has learned since.
    const traitsOut = {};
    for (const r of box.querySelectorAll("[data-trait][data-moved]")) traitsOut[r.dataset.trait] = Number(r.value);
    const prompt = box.querySelector("#prompt").value;
    send({ type: "set_profile", agent_id: a.id, traits: traitsOut, prompt: prompt !== a.profile.prompt ? prompt : null });
    editingProfile = null;
  };
  lockControls();
}

function liveHtml(a) {
  const bars = Object.entries(a.needs).map(([k, v]) => `
    <div class="bar"><span>${k}</span><span class="track"><span class="fill" style="width:${v}%;background:${NEED_COLOR[k]}"></span></span><span>${Math.round(v)}</span></div>`).join("");
  return `
    <p>${a.alive ? `Now: <b>${esc(pretty(a.activity))}</b>${a.place ? ` at ${esc(placeName(a.place))}` : ""}` : "<b>Died</b>"}</p>
    <div class="stats">
      <span>Money <b>$${a.money.toFixed(0)}</b></span><span>Health <b>${Math.round(a.health)}</b></span>
      <span>Mood <b>${a.mood}</b></span><span>Reputation <b>${a.reputation}</b></span>
    </div>
    ${bars}`;
}

// "rented, $220/week" or "owned, $76/week in property tax".
function homeTerms(h) {
  if (h.tenure === "owned") return `owned, $${h.weekly_cost}/week in property tax`;
  return `rented from ${esc(h.landlord || "the landlord")}, $${h.weekly_cost}/week`;
}

function placeName(id) { const p = town.places.find(p => p.id === id); return p ? p.name : id; }

function forkHtml(f) {
  const opts = f.options.map((o, i) => `<li class="${i === f.choice ? "chosen" : ""}">${i === f.choice ? "▶ " : ""}${esc(o)}</li>`).join("");
  const who = state ? (state.agents.find(a => a.id === f.agent) || {}).name : "";
  const happened = f.happened && f.happened.length ? `<div class="small">Then: ${esc(f.happened.join("; "))}</div>` : "";
  return `<li><span class="time">${esc(f.time)}</span>${selected ? "" : `<b>${esc(who)}</b> · `}${esc(f.question)}
    <span class="tag ${f.decided_by}">${f.decided_by}</span><ol class="opts">${opts}</ol>
    ${f.reason && f.decided_by === "model" ? `<div class="small">“${esc(f.reason)}”</div>` : ""}${happened}</li>`;
}

function renderFeeds(newEvents, newForks, reset = false) {
  if (reset) { events.length = 0; forks.length = 0; }
  if (newEvents.length || reset) {
    events.unshift(...newEvents.slice().reverse());
    events.length = Math.min(events.length, 200);
    document.getElementById("events").innerHTML = events.map(e =>
      `<li class="k-${e.kind}"><span class="time">${esc(e.time)}</span>${esc(e.text)}</li>`).join("");
  }
  if (newForks.length || reset) {
    // A fork comes again once its outcomes land: that copy replaces its entry, which keeps its place.
    for (const f of newForks) {
      const i = forks.findIndex(x => x.id === f.id);
      if (i >= 0) forks[i] = f; else forks.unshift(f);
    }
    forks.length = Math.min(forks.length, 120);
    const keep = selected; selected = null;
    document.getElementById("forks").innerHTML = forks.map(forkHtml).join("");
    selected = keep;
  }
}

// --- network ------------------------------------------------------------------------

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// One canvas pixel block per tile for the whole town (80 x 50 tiles is 1280 x 800); CSS scales it down.
function fitCanvas() {
  if (canvas.width !== town.w * T || canvas.height !== town.h * T) {
    canvas.width = town.w * T; canvas.height = town.h * T; // this resets the context state too
    ctx.imageSmoothingEnabled = false;
  }
  canvas.style.aspectRatio = `${town.w} / ${town.h}`;
  if (drops.length === 0 || drops.length !== Math.round(canvas.width * canvas.height / 1800)) makeDrops();
}

let lastDetailAsk = 0, lastRoster = 0;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => send({ type: "hello", role: "god" });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "welcome") {
      town = msg.town; state = msg.state; speed = msg.speed; terrain = null;
      fitCanvas();
      role = msg.role;
      document.getElementById("role").textContent = "You are God of this city";
      lockControls();
      // A reconnect starts the feeds again from the welcome, as a fresh page would.
      renderHeader(); renderPeople(); renderFeeds(msg.history || [], [], true);
    } else if (msg.type === "state") {
      const last = state;
      state = msg.state; state.speed = msg.speed; speed = msg.speed;
      if (last && !("lots" in state)) state.lots = last.lots; // frames carry them only when they change
      if (last && !("homes" in state)) state.homes = last.homes;
      renderHeader();
      renderFeeds(msg.events, msg.forks);
      const now = performance.now();
      if (selected && now - lastDetailAsk > 800) { lastDetailAsk = now; send({ type: "get_agent", agent_id: selected }); }
      if (!selected && !rosterPress && now - lastRoster > 1000) { lastRoster = now; renderPeople(); }
    } else if (msg.type === "agent") {
      if (msg.agent.id === selected) {
        const first = !detail;
        detail = msg.agent; renderPeople();
        // On narrow screens the panel sits below the map: bring the character into view.
        if (first && window.matchMedia("(max-width: 900px)").matches) document.querySelector("aside").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } else if (msg.type === "speed") {
      speed = msg.speed; if (state) renderHeader();
    } else if (msg.type === "demoted") {
      role = "observer";
      document.getElementById("role").textContent = "Watching only: God moved to another window. Reload to be God here.";
      lockControls();
    } else if (msg.type === "error") {
      toast(`Not done: ${msg.error}`);
    }
  };
  ws.onclose = () => {
    document.getElementById("clock").textContent = "Disconnected, retrying…";
    setTimeout(connect, 1500);
  };
}

connect();
requestAnimationFrame(draw);
