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
  cafe: "#9a5aa8", hospital: "#e9e9ef" };
const WALL = { home: "#f2dfbd", office: "#c9d3e3", school: "#f0d9a8", market: "#e3efe0",
  cafe: "#efe0f0", hospital: "#ffffff" };

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
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
  for (const p of town.places) if (p.kind !== "park") drawBuilding(g, p);
  // Pond in the park corner, for some life.
  g.fillStyle = "#3d8fd1"; g.fillRect(33 * T + 2, 18 * T + 4, 2 * T + 8, T + 6);
  g.fillStyle = "#79b9ea"; g.fillRect(33 * T + 6, 18 * T + 7, 10, 2);
  terrain = off;
  terrainSeason = season;
}

function drawBuilding(g, p) {
  const x = p.x * T, y = p.y * T, w = p.w * T, h = p.h * T;
  const roofH = Math.floor(h * 0.55);
  g.fillStyle = "rgba(0,0,0,.28)"; g.fillRect(x + 3, y + 4, w, h); // shadow
  g.fillStyle = WALL[p.kind]; g.fillRect(x, y + roofH, w, h - roofH); // front wall
  g.fillStyle = ROOF[p.kind]; g.fillRect(x - 1, y, w + 2, roofH); // roof
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
  // Sign on the roof.
  const sx = x + w / 2, sy = y + roofH / 2;
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

const drops = Array.from({ length: 140 }, () => ({ x: Math.random() * 640, y: Math.random() * 400, s: 2 + Math.random() * 3 }));

function draw(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  requestAnimationFrame(draw);
  if (!town || !state) return;
  if (!terrain || terrainSeason !== state.season) buildTerrain();
  ctx.drawImage(terrain, 0, 0);

  const night = nightAlpha(state.minute);
  if (night > 0.2) { // lit windows
    ctx.fillStyle = "rgba(255, 214, 102, .85)";
    for (const p of town.places) {
      if (p.kind === "park") continue;
      const roofH = Math.floor(p.h * T * 0.55), wy = p.y * T + roofH + 4;
      for (let wx = p.x * T + 4; wx < (p.x + p.w) * T - 6; wx += 12) {
        if (Math.abs(wx + 3 - (p.entry[0] * T + 8)) < 9) continue;
        if (hash(p.id + wx) % 3) ctx.fillRect(wx, wy, 7, 6);
      }
    }
  }
  drawLights();
  drawBus();

  // Agents, sorted by y so lower ones overlap higher ones like in Pokémon.
  const ppl = state.agents.filter(a => a.alive && !a.inside).sort((a, b) => a.y - b.y);
  const step = Math.max(1, (state.speed || speed) * 2.4 * 3) * dt;
  for (const a of state.agents) {
    const s = shown[a.id] || (shown[a.id] = { x: a.x, y: a.y });
    const dx = a.x - s.x, dy = a.y - s.y, d = Math.hypot(dx, dy);
    if (d > 4 || d <= step) { s.x = a.x; s.y = a.y; } else { s.x += dx / d * step; s.y += dy / d * step; }
  }
  for (const a of ppl) drawAgent(a, shown[a.id], now);
  drawOccupancy();
  drawPlane();

  if (night > 0) { ctx.fillStyle = `rgba(16, 24, 64, ${night})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  if (state.weather === "rain") drawRain(dt, state.season === "winter");
}

function drawLights() {
  const col = { green: "#3ee06a", yellow: "#ffd23f", red: "#ff4040" };
  for (const y of town.road_rows) for (const x of town.road_cols) {
    const px = x * T, py = y * T;
    ctx.fillStyle = "#222"; ctx.fillRect(px - 2, py - 2, 4, 4); ctx.fillRect(px + T - 2, py + T - 2, 4, 4);
    ctx.fillStyle = col[state.lights.ns]; ctx.fillRect(px - 1, py - 1, 2, 2);
    ctx.fillStyle = col[state.lights.ew]; ctx.fillRect(px + T - 1, py + T - 1, 2, 2);
  }
}

function drawBus() {
  const b = state.bus;
  const px = b.x * T, py = b.y * T;
  ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fillRect(px + 1, py + 4, 15, 11);
  ctx.fillStyle = "#f2b705"; ctx.fillRect(px, py + 2, 15, 11);
  ctx.fillStyle = "#3a5a7a"; for (let i = 1; i < 14; i += 4) ctx.fillRect(px + i, py + 4, 3, 3);
  ctx.fillStyle = "#222"; ctx.fillRect(px + 2, py + 12, 3, 2); ctx.fillRect(px + 10, py + 12, 3, 2);
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
  if (a.state === "deciding") bubble(px + 10, top - 8, "?", a.controller ? "#6cb6ff" : "#ffffff");
  else if (a.activity === "phone_call" || a.activity === "text") bubble(px + 10, top - 8, "…", "#ffffff");
  if (sel || hover === a.id) label(a.name.split(" ")[0], px + 8, py - 6);
}

function bubble(x, y, ch, color) {
  ctx.fillStyle = color; ctx.fillRect(x, y, 8, 7); ctx.fillRect(x + 1, y + 7, 2, 2);
  ctx.fillStyle = "#222"; ctx.font = "bold 7px monospace"; ctx.textAlign = "center"; ctx.fillText(ch, x + 4, y + 6);
}

function label(text, x, y) {
  ctx.font = "8px monospace"; ctx.textAlign = "center";
  const w = ctx.measureText(text).width + 4;
  ctx.fillStyle = "rgba(15,18,26,.8)"; ctx.fillRect(x - w / 2, y - 7, w, 9);
  ctx.fillStyle = "#fff"; ctx.fillText(text, x, y);
}

function drawOccupancy() {
  const counts = {};
  for (const a of state.agents) if (a.alive && a.inside) counts[a.inside] = (counts[a.inside] || 0) + 1;
  for (const p of town.places) {
    const n = counts[p.id];
    if (!n) continue;
    const x = (p.x + p.w) * T - 6, y = p.y * T + 2;
    ctx.fillStyle = "#f6c445"; ctx.fillRect(x - 6, y, 11, 9);
    ctx.fillStyle = "#222"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center"; ctx.fillText(String(n), x, y + 8);
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
    if (d.y > 400) { d.y = -5; d.x = Math.random() * 680; }
    if (d.x < -10) d.x = 650;
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
  let best = null, bestD = 0.9;
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
  tip.style.left = `${Math.min(ev.clientX - wr.left + 12, r.width - 200)}px`;
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
  selected = id;
  detail = null;
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
    <li data-id="${a.id}" class="${a.alive ? "" : "dead"}">
      <span class="swatch" style="background:${shirt(a.id)}"></span>
      <span class="grow"><b>${esc(a.name)}</b> <span class="small">${a.alive ? esc(pretty(a.activity)) : "died"}</span></span>
      <span class="small" title="Luck">☘ ${a.luck}</span>
      <span class="small" title="${a.controller ? "Played by " + esc(a.controller) : "Running on profile defaults"}">${a.controller ? "🤖" : "·"}</span>
    </li>`).join("");
}
document.getElementById("roster").addEventListener("click", ev => {
  const li = ev.target.closest("li");
  if (li) select(li.dataset.id);
});

let editingProfile = false;
function renderDetail(box) {
  const a = detail;
  const active = document.activeElement;
  if (box.contains(active) && (active.tagName === "TEXTAREA" || active.type === "range") || editingProfile) {
    // Keep the God's edits; only refresh the live numbers.
    const live = box.querySelector("#live");
    if (live) live.innerHTML = liveHtml(a);
    return;
  }
  const traits = Object.entries(a.profile.traits).map(([k, v]) => `
      <label for="t-${k}">${k}</label><input id="t-${k}" data-trait="${k}" type="range" min="0" max="1" step="0.05" value="${v}"><span>${v.toFixed(2)}</span>`).join("");
  const forksHtml = a.forks.slice().reverse().map(forkHtml).join("") || '<li class="small">No decisions yet.</li>';
  const rels = Object.entries(a.relationships).slice(0, 8).map(([id, r]) =>
    `<li>${esc(r.name)} <span class="small">${r.kind} · ${r.affinity > 0 ? "+" : ""}${r.affinity}</span></li>`).join("");
  box.innerHTML = `
    <button class="back" id="back">← Everyone</button>
    <h2>${esc(a.name)}</h2>
    <div class="small">${a.age} · ${a.job ? esc(a.job.title) : "retired"} · ${a.controller ? "played by " + esc(a.controller) : "running on profile defaults"}</div>
    <div id="live">${liveHtml(a)}</div>
    <div class="luck">
      <div class="row"><span>Cursed</span><b style="color:var(--text)">Luck <span id="luckv">${Math.round(a.luck)}</span></b><span>Blessed</span></div>
      <input id="luck" type="range" min="0" max="100" step="1" value="${a.luck}" aria-label="Luck">
      <div class="small">Your only power. ${esc(a.name.split(" ")[0])} will never know. Luck tilts the hidden odds of every outcome.</div>
    </div>
    <h3>Play style</h3>
    <textarea id="prompt" aria-label="Play-style prompt">${esc(a.profile.prompt)}</textarea>
    <div class="traits">${traits}</div>
    <button class="btn" id="saveprof">Save play style</button>
    <span class="small" id="savednote">${a.profile.edited ? "Written by you" : "Learns from choices"}</span>
    <h3>Recent decisions</h3><ul class="feed">${forksHtml}</ul>
    <h3>Owns</h3>
    <ul class="list">
      <li>${esc(a.possessions.home.name)} <span class="small">rented, $${a.possessions.home.weekly_rent}/week</span></li>
      <li>${a.possessions.car ? "A car" : "No car"}</li>
      <li>Phone <span class="small">${a.possessions.phone.condition}</span></li>
      <li>${a.possessions.groceries_at_home} meals in the fridge</li>
      ${a.possessions.savings_goal ? `<li>Saving for ${esc(a.possessions.savings_goal.name)} <span class="small">$${a.possessions.savings_goal.saved} of $${a.possessions.savings_goal.target}</span></li>` : ""}
    </ul>
    <h3>People</h3><ul class="list">${rels || '<li class="small">Nobody yet.</li>'}</ul>
    <h3>Memory</h3><ul class="list">${a.memory.slice().reverse().map(m => `<li>${esc(m)}</li>`).join("") || '<li class="small">Nothing yet.</li>'}</ul>`;
  box.querySelector("#back").onclick = () => { selected = null; detail = null; renderPeople(); };
  const luck = box.querySelector("#luck");
  luck.oninput = () => { box.querySelector("#luckv").textContent = luck.value; };
  luck.onchange = () => send({ type: "set_luck", agent_id: a.id, luck: Number(luck.value) });
  for (const r of box.querySelectorAll("[data-trait]")) {
    r.oninput = () => { editingProfile = true; r.nextElementSibling.textContent = Number(r.value).toFixed(2); };
  }
  box.querySelector("#prompt").oninput = () => { editingProfile = true; };
  box.querySelector("#saveprof").onclick = () => {
    const traitsOut = {};
    for (const r of box.querySelectorAll("[data-trait]")) traitsOut[r.dataset.trait] = Number(r.value);
    const prompt = box.querySelector("#prompt").value;
    send({ type: "set_profile", agent_id: a.id, traits: traitsOut, prompt: prompt !== a.profile.prompt ? prompt : null });
    editingProfile = false;
  };
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

function placeName(id) { const p = town.places.find(p => p.id === id); return p ? p.name : id; }

function forkHtml(f) {
  const opts = f.options.map((o, i) => `<li class="${i === f.choice ? "chosen" : ""}">${i === f.choice ? "▶ " : ""}${esc(o)}</li>`).join("");
  const who = state ? (state.agents.find(a => a.id === f.agent) || {}).name : "";
  const happened = f.happened && f.happened.length ? `<div class="small">Then: ${esc(f.happened.join("; "))}</div>` : "";
  return `<li><span class="time">${esc(f.time)}</span>${selected ? "" : `<b>${esc(who)}</b> · `}${esc(f.question)}
    <span class="tag ${f.decided_by}">${f.decided_by}</span><ol class="opts">${opts}</ol>
    ${f.reason && f.decided_by === "model" ? `<div class="small">“${esc(f.reason)}”</div>` : ""}${happened}</li>`;
}

function renderFeeds(newEvents, newForks) {
  if (newEvents.length) {
    events.unshift(...newEvents.slice().reverse());
    events.length = Math.min(events.length, 200);
    document.getElementById("events").innerHTML = events.map(e =>
      `<li class="k-${e.kind}"><span class="time">${esc(e.time)}</span>${esc(e.text)}</li>`).join("");
  }
  if (newForks.length) {
    forks.unshift(...newForks.slice().reverse());
    forks.length = Math.min(forks.length, 120);
    const keep = selected; selected = null;
    document.getElementById("forks").innerHTML = forks.map(forkHtml).join("");
    selected = keep;
  }
}

// --- network ------------------------------------------------------------------------

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

let lastDetailAsk = 0, lastRoster = 0;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => send({ type: "hello", role: "god" });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "welcome") {
      town = msg.town; state = msg.state; speed = msg.speed; terrain = null;
      role = msg.role;
      document.getElementById("role").textContent = "You are God of this city";
      renderHeader(); renderPeople(); renderFeeds(msg.history || [], []);
    } else if (msg.type === "state") {
      state = msg.state; state.speed = msg.speed; speed = msg.speed;
      renderHeader();
      renderFeeds(msg.events, msg.forks);
      const now = performance.now();
      if (selected && now - lastDetailAsk > 800) { lastDetailAsk = now; send({ type: "get_agent", agent_id: selected }); }
      if (!selected && now - lastRoster > 1000) { lastRoster = now; renderPeople(); }
    } else if (msg.type === "agent") {
      if (msg.agent.id === selected) { detail = msg.agent; renderPeople(); }
    } else if (msg.type === "speed") {
      speed = msg.speed; if (state) renderHeader();
    } else if (msg.type === "demoted") {
      role = "observer";
      document.getElementById("role").textContent = "Watching: God moved to another window";
    }
  };
  ws.onclose = () => {
    document.getElementById("clock").textContent = "Disconnected, retrying…";
    setTimeout(connect, 1500);
  };
}

connect();
requestAnimationFrame(draw);
