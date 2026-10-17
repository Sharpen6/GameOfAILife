#!/usr/bin/env node
// Headless smoke test for the isometric city view (client/view/*.js) on its dev page (client/dev/view.html),
// which drives the view with the fixture town (client/dev/fixture_town.js) and a fake host (fake_state.js).
//
//   node tests/browser/view_smoke.cjs
//
// It serves client/ on 127.0.0.1 and checks in headless Chromium (P4.md TESTS and acceptance):
// - globals: on a blank page the nine scripts add only window.CityView and the view adds no global of its
//   own while it runs; every facade method exists; CityView.shirt and .hair use game.js's formulas; the
//   page loads nothing but its own files and opens no socket; setMode before setTown is kept and stored
// - bench: the median draw is under 4 ms at zoom 1 on 1440x900 over 120 frames, in iso and in flat, both
//   with no console errors, and the view never pings on its own
// - picking: real clicks hit a known agent (ev {cssX, cssY, touch}), a roof in front of a pedestrian (then
//   the pedestrian on a second click) and a stacked pair in turn; select() never calls onSelect and Esc
//   deselects and calls onSelect(null); keys (arrows, WASD, + - 0, F) work and are ignored in a form
//   field; drag, wheel, the zoom buttons, the View menu, the follow chip (bottom centre) and the minimap
// - facade: focus (animated, a home id, a tile, a district, an agent, with an inset), highlight (glow
//   and x-ray), setOverlay (a block of flats takes the tint by pixel check, drawn per frame and never baked
//   into the ground chunks), ping (colours, false for unknown targets, the off-screen arrow flies there),
//   setInset, setMode, camera(), onCamera, stop/start, and setState keeping lots and homes it was not sent
// - stages: all five neglect stages on screen at zoom 2, pixel-distinct on the one-palette specimen street;
//   SALE / RENT / LET boards and moving vans on the camera-nearest road-touching lot tile
// - persistence: localStorage["goal.view"] keeps the projection and camera (never the rotation), and a
//   throwing localStorage costs nothing
// - today's 40 x 25 town and its state (one bus at state.bus) load and draw in iso and flat
// - phone (390 x 844, touch): tap and long-press (ev.touch), pinch and one-finger pan, the 6 MP chunk
//   budget, the collapsed minimap, no sideways scroll
// - the dashboard's dev page with the real view (?view=real) runs with no errors and no failed view calls
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0. Set VIEW_SHOTS=<folder> to also save screenshots.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const CLIENT = path.resolve(__dirname, "..", "..", "client");
const SHOTS = process.env.VIEW_SHOTS || "";
const VIEW_SCRIPTS = ["proj", "art", "buildings", "actors", "scene", "movers", "camera", "minimap", "view"];
const FACADE = ["setTown", "setState", "select", "focus", "highlight", "setOverlay", "ping", "setInset", "camera",
  "setMode", "start", "stop"];
const DESKTOP = { width: 1440, height: 900 };
const ZOOM_STEPS = [0.25, 0.5, 1, 1.5, 2, 3];
let BASE = "";

function findPlaywright() {
  const tries = ["playwright"];
  try {
    const root = require("child_process").execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 })
      .toString().trim();
    if (root) tries.push(path.join(root, "playwright"));
  } catch (e) { /* no npm */ }
  tries.push("/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright");
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  return null;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml" };

// A blank page with the view's nine scripts, taking the window's property names before and after them.
const GLOBALS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>globals</title><link rel="stylesheet" href="/view/view.css">
<style>html, body { margin: 0; height: 100%; background: #11151d; } #w { position: fixed; inset: 0; } #c { width: 100%; height: 100%; }</style>
</head><body><div id="w"><canvas id="c"></canvas></div>
<script>window.__before = Object.getOwnPropertyNames(window);</script>
${VIEW_SCRIPTS.map(n => `<script src="/view/${n}.js"></script>`).join("\n")}
<script>window.__after = Object.getOwnPropertyNames(window);</script>
<script src="/dev/fixture_town.js"></script>
</body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch (e) { rel = "/"; }
    if (rel === "/__globals.html") {
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(GLOBALS_HTML);
      return;
    }
    const file = path.join(CLIENT, path.normalize(rel).replace(/^[/\\]+/, ""));
    if (!file.startsWith(CLIENT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0, passes = 0;
function check(ok, what, detail) {
  if (ok) { passes += 1; return true; }
  failures += 1;
  console.log(`  FAIL ${what}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return false;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// game.js's hash and swatch formulas, which CityView.shirt and CityView.hair must match
function gameHash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
const gameShirt = id => `hsl(${gameHash(id) % 360} 65% 55%)`;
const gameHair = id => ["#3b2416", "#6b4423", "#1d1d1d", "#c9a14a", "#8a3b1c", "#b8b8b8"][gameHash(id + "h") % 6];

// Today's 40 x 25 town (welcome.town before v2), which setTown must still accept.
const OLD_TOWN = {
  w: 40, h: 25,
  tiles: [
    "...#..........#..........#..........#...",
    "...#..........#..........#..........#...",
    "...#..........#..........#..........#...",
    "########################################",
    "...#.BBB.BBB..#..........#..........#...",
    "...#.BBB.BBB..#.BBBBBBBB.#.BBBBBBB..#...",
    "...#.BDB.BDB..#.BBBBBBBB.#.BBBBBBB..#...",
    "...#..e...e...#.BBBBBBBB.#.BBBBBBB..#...",
    "...#.BBB.BBB..#.BBBBBBBB.#.BBBBBBB..#...",
    "...#.BBB.BBB..#.BBBBDBBB.#.BBBDBBB..#...",
    "...#.BDB.BDB..#.....e....#....e.....#...",
    "...#..e...e...#..........#..........#...",
    "########################################",
    "...#.BBB.BBB..#..........#TPPPPTPTTT#...",
    "...#.BBB.BBB..#.BBBB.BBB.#PPTTTPPPPP#...",
    "...#.BDB.BDB..#.BBBB.BBB.#PPPPPPPPPP#...",
    "...#..e...e...#.BBDB.BDB.#PPPPPPTPPP#...",
    "...#.BBB.BBB..#...e...e..#PPPPPPPTPP#...",
    "...#.BBB.BBB..#.BBBBBBBB.#PPPPPPPPPP#...",
    "...#.BDB.BDB..#.BBBBBBBB.#PPPPPPTTPP#...",
    "...#..e...e...#.BBBBDBBB.#PPPPPPPTPP#...",
    "####################e###################",
    "...#..........#..........#..........#...",
    "...#..........#..........#..........#...",
    "...#..........#..........#..........#...",
  ],
  places: [
    { id: "home_cohen", name: "Cohen house", kind: "home", x: 5, y: 4, w: 3, h: 3, entry: [6, 7], hours: null },
    { id: "home_levi", name: "Levi house", kind: "home", x: 9, y: 4, w: 3, h: 3, entry: [10, 7], hours: null },
    { id: "home_bendavid", name: "Ari's flat", kind: "home", x: 5, y: 8, w: 3, h: 3, entry: [6, 11], hours: null },
    { id: "home_mizrahi", name: "Mizrahi house", kind: "home", x: 9, y: 8, w: 3, h: 3, entry: [10, 11], hours: null },
    { id: "home_peretz", name: "Peretz house", kind: "home", x: 5, y: 13, w: 3, h: 3, entry: [6, 16], hours: null },
    { id: "home_friedman", name: "Friedman house", kind: "home", x: 9, y: 13, w: 3, h: 3, entry: [10, 16], hours: null },
    { id: "home_katz", name: "Katz house", kind: "home", x: 5, y: 17, w: 3, h: 3, entry: [6, 20], hours: null },
    { id: "home_haddad", name: "Haddad house", kind: "home", x: 9, y: 17, w: 3, h: 3, entry: [10, 20], hours: null },
    { id: "office", name: "Brightline Tech", kind: "office", x: 16, y: 5, w: 8, h: 5, entry: [20, 10], hours: [7, 20] },
    { id: "school", name: "Millbrook School", kind: "school", x: 27, y: 5, w: 7, h: 5, entry: [30, 10], hours: [7, 17] },
    { id: "market", name: "Fresh Market", kind: "market", x: 16, y: 14, w: 4, h: 3, entry: [18, 17], hours: [7, 21] },
    { id: "cafe", name: "Corner Cafe", kind: "cafe", x: 21, y: 14, w: 3, h: 3, entry: [22, 17], hours: [6, 23] },
    { id: "hospital", name: "City Hospital", kind: "hospital", x: 16, y: 18, w: 8, h: 3, entry: [20, 21], hours: null },
    { id: "park", name: "Riverside Park", kind: "park", x: 26, y: 13, w: 10, h: 8, entry: [30, 16], hours: null },
  ],
  road_rows: [3, 12, 21], road_cols: [3, 14, 25, 36],
  timetable: { bus: { route: "Ring road loop", stops: [[3, 3], [14, 3], [25, 3], [36, 3], [36, 12], [36, 21], [25, 21], [14, 21], [3, 21], [3, 12]], minutes_per_loop: 122 }, flights: ["08:00 Riverton to Lakeside", "14:00 Riverton to Lakeside", "20:00 Riverton to Lakeside"] },
};
// Today's state frame for it: no lots, homes or buses, one bus at state.bus, agents without home or car.
function oldState(t) {
  const walk = (id, name, x, y, extra) => Object.assign({ id, name, x, y, inside: null, state: "travelling", activity: "commute",
    vehicle: "walk", mood: 70, luck: 50, controller: null, alive: true, age: 35 }, extra || {});
  const loop = [[3, 3], [14, 3], [25, 3], [36, 3], [36, 12], [36, 21], [25, 21], [14, 21], [3, 21], [3, 12]];
  const [bx, by] = loop[t % loop.length];
  return { tick: 500 + t, time: `Day 1 08:${String(10 + t).padStart(2, "0")}`, minute: 490 + t, day: 1, season: "summer", weather: "clear",
    lights: { ns: t % 2 ? "green" : "red", ew: t % 2 ? "red" : "green" }, bus: { x: bx, y: by, stopped: t % 3 === 0 }, plane: null,
    agents: [
      walk("dana", "Dana Cohen", 6, 7, { inside: "home_cohen", state: "busy", activity: "relax_home" }),
      walk("omer", "Omer Levi", 14, 5 + t, {}),
      walk("noa", "Noa Katz", 15 + t, 12, { vehicle: "car" }),
      walk("eli", "Eli Haddad", 22, 17, { inside: "cafe", state: "busy", activity: "eat" }),
      walk("maya", "Maya Peretz", 30, 16, { state: "idle", activity: "walk_park" }),
      walk("ari", "Ari Ben David", 30, 16, { state: "idle", activity: "walk_park" }),
      walk("gil", "Gil Friedman", 4, 15, { alive: false }),
    ] };
}

// --- the page ------------------------------------------------------------------------------------------

// In-page helpers for the dev page (window.__t).
function HELPERS() {
  const canvas = document.getElementById("map");
  let n = 0;
  window.__t = {
    // A crafted frame: everyone alive at home except the ones placed (standing idle on those tiles), no
    // buses; moves finished and drawn.
    craft(placed) {
      const st = __state();
      st.tick += 1000 + (++n);
      st.buses = [];
      for (const a of st.agents) if (a.alive !== false) Object.assign(a, { inside: a.home, riding: null, vehicle: "walk", state: "busy", activity: "relax_home" });
      for (const [id, xy] of Object.entries(placed)) {
        Object.assign(st.agents.find(a => a.id === id), { x: xy[0], y: xy[1], inside: null, riding: null, state: "idle", activity: "chat", vehicle: "walk", alive: true });
      }
      __push(st); __view.settle(); __view.frame();
      return st.tick;
    },
    // CSS px of an agent's foot (the point focus centres on)
    foot(id) { const s = __view.scene(), r = s.moverById(id); return r && r.foot ? s.worldToCss(r.foot[0], r.foot[1]) : null; },
    // the middle of the area the page leaves free (where focus puts its target)
    centre() { const i = __view.scene().inset; return [(canvas.clientWidth - (i.right || 0)) / 2, ((i.top || 0) + canvas.clientHeight - (i.bottom || 0)) / 2]; },
    // the mean colour of a (2r+1)^2 square at CSS (x, y)
    px(x, y, r) {
      r = r == null ? 1 : r;
      const k = __view.scene().dpr, d = canvas.getContext("2d").getImageData(Math.round(x * k) - r, Math.round(y * k) - r, 2 * r + 1, 2 * r + 1).data;
      let R = 0, G = 0, B = 0;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      const m = d.length / 4;
      return [R / m, G / m, B / m];
    },
    grab(x, y, w, h) { const k = __view.scene().dpr; return canvas.getContext("2d").getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))); },
    changed(a, b, tol) {
      let c = 0;
      const p = a.data, q = b.data;
      for (let i = 0; i < p.length && i < q.length; i += 4) if (Math.abs(p[i] - q[i]) > tol || Math.abs(p[i + 1] - q[i + 1]) > tol || Math.abs(p[i + 2] - q[i + 2]) > tol) c++;
      return c;
    },
    // CSS rect [x0, y0, x1, y1] of a building's sprite
    spriteRect(id) {
      const s = __view.scene(), r = s.buildingOf(id);
      if (!r) return null;
      const a = s.worldToCss(r.b.ox, r.b.oy), b = s.worldToCss(r.b.ox + r.b.c.width, r.b.oy + r.b.c.height);
      return [a[0], a[1], b[0], b[1]];
    },
    // CSS rect [x0, y0, x1, y1] of a building's outline (walls and roof, without the sprite's margins)
    hullRect(id) {
      const s = __view.scene(), r = s.buildingOf(id);
      if (!r) return null;
      const pts = r.hull.map(q => s.worldToCss(q[0], q[1]));
      return [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
    },
    // a building as drawn now: the screen pixels over its sprite, and the sprite's own alpha (its mask)
    houseShot(id) {
      const s = __view.scene(), r = s.buildingOf(id), z = s.cam.zoom * s.dpr, w = r.b.c.width, h = r.b.c.height, c = this.spriteRect(id);
      return { w, h, z, mask: r.b.c.getContext("2d").getImageData(0, 0, w, h).data, img: this.grab(c[0], c[1], w * z / s.dpr, h * z / s.dpr) };
    },
    // the share of the pixels both sprites cover that differ between two shots of a building
    shotDiff(A, B, tol) {
      const W = Math.min(A.img.width, B.img.width), H = Math.min(A.img.height, B.img.height), p = A.img.data, q = B.img.data;
      let n = 0, d = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const fx = Math.floor(x / A.z), fy = Math.floor(y / A.z);
        if (fx >= A.w || fx >= B.w || fy >= A.h || fy >= B.h || A.mask[(fy * A.w + fx) * 4 + 3] < 200 || B.mask[(fy * B.w + fx) * 4 + 3] < 200) continue;
        n++;
        const i = (y * A.img.width + x) * 4, j = (y * B.img.width + x) * 4;
        if (Math.abs(p[i] - q[j]) > tol || Math.abs(p[i + 1] - q[j + 1]) > tol || Math.abs(p[i + 2] - q[j + 2]) > tol) d++;
      }
      return n ? d / n : 0;
    },
    // draw until no ground chunk is left to build; returns the count built so far
    warm(max) { const s = __view.scene(); let b = -1; for (let i = 0; i < (max || 60) && b !== s.stats.built; i++) { b = s.stats.built; __view.frame(); __view.frame(); } return s.stats.built; },
    lastPick() { const c = __calls.pick; return c.length ? c[c.length - 1] : null; },
  };
}

async function open(browser, query, o) {
  o = o || {};
  const ctx = await browser.newContext({ viewport: o.size || DESKTOP, deviceScaleFactor: o.dpr || 1, hasTouch: !!o.touch, isMobile: !!o.mobile });
  if (o.init) await ctx.addInitScript(o.init);
  const page = await ctx.newPage();
  const log = { errors: [], warnings: [], requests: [], sockets: 0 };
  page.on("console", m => { if (m.type() === "error") log.errors.push(m.text()); else if (m.type() === "warning") log.warnings.push(m.text()); });
  page.on("pageerror", e => log.errors.push(String(e && e.message || e)));
  page.on("request", r => log.requests.push(r.url()));
  page.on("websocket", () => { log.sockets += 1; });
  await page.goto(`${BASE}${o.path || "/dev/view.html"}${query}`);
  if (!o.path) {
    await page.waitForFunction(() => window.__view && __view.scene() && __view.scene().stats.frames > 3, null, { timeout: 20000 });
    await page.evaluate(HELPERS);
  }
  return { ctx, page, log };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function noErrors(log, what) {
  check(log.errors.length === 0, `${what}: no console errors`, log.errors.slice(0, 5));
}

const cam = page => page.evaluate(() => Object.assign(__view.camera(), { wx: __view.cam().x, wy: __view.cam().y }));
const picks = page => page.evaluate(() => __calls.pick.length);
const lastPick = page => page.evaluate(() => __t.lastPick());

// --- runs ----------------------------------------------------------------------------------------------

// The nine scripts on a blank page: one global, every facade method, roster colours, no network.
async function runGlobals(browser) {
  const { ctx, page, log } = await open(browser, "", { path: "/__globals.html" });
  await page.waitForFunction(() => window.CITY_FIXTURE && window.__after, null, { timeout: 15000 });
  const g = await page.evaluate(FAC => {
    const before = new Set(window.__before);
    const added = window.__after.filter(k => !before.has(k) && k !== "__before");
    const CV = window.CityView;
    const host = document.getElementById("w");
    const view = window.__v = CV.create(document.getElementById("c"), {});
    const missing = FAC.filter(n => typeof view[n] !== "function");
    view.setMode({ projection: "flat" }); // before the town: kept, used by setTown and stored
    view.setTown(CITY_FIXTURE.town);
    view.setState(CITY_FIXTURE.state, 1);
    view.start();
    return { added, missing, cv: ["create", "shirt", "hair", "stageOf"].filter(n => typeof CV[n] !== "function"), proj: view.camera().projection,
      stored: localStorage.getItem("goal.view"), ctl: !!host.querySelector(":scope > .cv-ctl"), chip: !!host.querySelector(":scope > .cv-follow"),
      mini: !!host.querySelector(":scope > .cv-minimap"), ids: CITY_FIXTURE.state.agents.map(a => a.id),
      colours: CITY_FIXTURE.state.agents.map(a => [CV.shirt(a.id), CV.hair(a.id)]) };
  }, FACADE);
  check(g.added.length === 1 && g.added[0] === "CityView", "globals: the nine scripts define only window.CityView", g.added);
  check(g.missing.length === 0, "globals: every facade method exists", g.missing);
  check(g.cv.length === 0, "globals: CityView.create, shirt, hair and stageOf exist", g.cv);
  check(g.ctl && g.chip && g.mini, "globals: the view adds .cv-ctl, .cv-follow and .cv-minimap next to the canvas", g);
  check(g.proj === "flat", "globals: setMode before setTown is kept", g.proj);
  let stored = null;
  try { stored = JSON.parse(g.stored); } catch (e) { /* checked below */ }
  check(stored && stored.projection === "flat", "globals: setMode before setTown is stored in goal.view", g.stored);
  const bad = g.ids.filter((id, i) => g.colours[i][0] !== gameShirt(id) || g.colours[i][1] !== gameHair(id));
  check(bad.length === 0, "globals: CityView.shirt and CityView.hair match game.js", bad.slice(0, 5));
  await page.waitForTimeout(700);
  const later = await page.evaluate(() => {
    const before = new Set(window.__before);
    return { added: Object.getOwnPropertyNames(window).filter(k => !before.has(k) && !["__before", "__after", "__v", "CITY_FIXTURE"].includes(k)),
      frames: __v.scene().stats.frames };
  });
  check(later.added.length === 1 && later.added[0] === "CityView", "globals: a running view adds no global of its own", later.added);
  check(later.frames > 10, "globals: the view draws on its own after start()", later.frames);
  const foreign = log.requests.filter(u => !u.startsWith(BASE + "/"));
  check(foreign.length === 0, "globals: the page fetches nothing but its own files", foreign);
  check(log.sockets === 0, "globals: the view opens no socket", log.sockets);
  noErrors(log, "globals");
  await ctx.close();
}

// The frame-time budget, iso and flat, at zoom 1 on 1440 x 900 with the fake host's frames coming in.
async function runBench(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&zoom=1&dyn=0");
  await page.waitForTimeout(1500);
  const iso = await page.evaluate(() => __bench(125));
  console.log(`  iso draw median ${iso.median.toFixed(2)} ms, p90 ${iso.p90.toFixed(2)} ms over ${iso.n} frames`);
  check(iso.n >= 120 && iso.median < 4, "bench: iso median draw under 4 ms at zoom 1 on 1440x900", iso);
  const st = await page.evaluate(() => ({ zoom: __view.camera().zoom, pings: __view.scene().pings.length, w: document.getElementById("map").width,
    agents: __view.scene().movers.filter(m => m.kind === "person" || m.kind === "car").length, buses: __view.scene().movers.filter(m => m.kind === "bus").length,
    parked: __view.scene().movers.filter(m => m.kind === "parked").length }));
  check(st.zoom === 1 && st.w === 1440, "bench: the camera is at zoom 1 on a 1440 px canvas", st);
  check(st.agents > 0 && st.buses > 0 && st.parked > 0, "bench: people, buses and parked cars are drawn", st);
  check(st.pings === 0, "bench: the view never pings on its own", st.pings);
  await shot(page, "iso");
  await page.evaluate(() => __view.setMode({ projection: "flat" }));
  await page.waitForTimeout(1200);
  const flat = await page.evaluate(() => __bench(125));
  console.log(`  flat draw median ${flat.median.toFixed(2)} ms, p90 ${flat.p90.toFixed(2)} ms over ${flat.n} frames`);
  check(flat.n >= 120 && flat.median < 4, "bench: flat median draw under 4 ms at zoom 1", flat);
  check(await page.evaluate(() => __view.camera().projection) === "flat", "bench: setMode switches to flat");
  await shot(page, "flat");
  noErrors(log, "bench (iso and flat)");
  await ctx.close();

  // a page opened in flat mode draws a city, not a blank canvas
  const f = await open(browser, "?persist=0&flat=1&dyn=0");
  await f.page.waitForTimeout(800);
  const look = await f.page.evaluate(() => {
    const c = document.getElementById("map"), g = c.getContext("2d"), seen = new Set();
    for (let i = 0; i < 400; i++) { const d = g.getImageData((i * 97) % c.width, 60 + (i * 53) % (c.height - 60), 1, 1).data; seen.add(d[0] >> 4 << 8 | d[1] >> 4 << 4 | d[2] >> 4); }
    return { colours: seen.size, proj: __view.camera().projection };
  });
  check(look.proj === "flat" && look.colours > 12, "flat: ?flat=1 draws the city", look);
  noErrors(f.log, "flat page");
  await f.ctx.close();
}

// Real clicks on known things: an agent, a roof in front of a pedestrian, a stacked pair; then Esc, the
// keys and the controls.
async function runPicking(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0");
  const ids = await page.evaluate(() => __state().agents.filter(a => a.alive !== false).slice(0, 5).map(a => a.id));
  await page.evaluate(ids => __t.craft({ [ids[0]]: [48, 36], [ids[1]]: [30, 21], [ids[2]]: [52, 36], [ids[3]]: [52, 36], [ids[4]]: [52, 36] }), ids);

  // a known agent on an open road
  await page.evaluate(() => { __view.setCamera({ x: 48.5, y: 36.5, zoom: 2 }); __view.frame(); });
  let p = (await page.evaluate(id => __view.screenOf({ agent: id }), ids[0])).map(Math.round);
  await page.mouse.click(p[0], p[1]);
  let pk = await lastPick(page);
  check(pk && pk.hit && pk.hit.kind === "agent" && pk.hit.id === ids[0], "pick: a click on a known agent picks it", pk);
  check(pk && pk.ev && near(pk.ev.cssX, p[0], 1) && near(pk.ev.cssY, p[1], 1) && pk.ev.touch === false, "pick: onPick gets {cssX, cssY, touch: false}", pk && pk.ev);
  check(await page.evaluate(() => __calls.select.length) === 0 && await page.evaluate(() => __view.selected()) === ids[0],
    "pick: the page's view.select() does not call onSelect");
  await page.waitForTimeout(1600);

  // a pedestrian behind the office tower: the tower is in front, so it wins; a second click takes the pedestrian
  await page.evaluate(() => { __view.setCamera({ x: 30.5, y: 21.5, zoom: 2 }); __view.frame(); });
  p = (await page.evaluate(id => __view.screenOf({ agent: id }), ids[1])).map(Math.round);
  const under = await page.evaluate(([x, y]) => __view.scene().pickAll(x, y).upright, p);
  check(under.length >= 2 && under[0].kind === "place" && under[0].id === "office" && under.some(h => h.id === ids[1]),
    "pick: the office tower stands in front of the pedestrian behind it", under);
  await page.mouse.click(p[0], p[1]);
  pk = await lastPick(page);
  check(pk && pk.hit && pk.hit.kind === "place" && pk.hit.id === "office", "pick: a roof in front of a pedestrian wins (frontmost first)", pk && pk.hit);
  await page.waitForTimeout(350);
  await page.mouse.click(p[0], p[1]);
  pk = await lastPick(page);
  check(pk && pk.hit && pk.hit.kind === "agent" && pk.hit.id === ids[1], "pick: a second click on the spot takes the pedestrian behind", pk && pk.hit);
  await page.waitForTimeout(350);
  await page.mouse.click(p[0], p[1]);
  pk = await lastPick(page);
  check(pk && pk.hit && pk.hit.id === "office", "pick: a third click comes back to the front", pk && pk.hit);
  await shot(page, "pick-behind");
  await page.waitForTimeout(1600);

  // three people idle on one tile stand in a ring; find a point two of them share and click through them
  await page.evaluate(() => { __view.setCamera({ x: 52.5, y: 36.5, zoom: 2 }); __view.frame(); });
  const pair = await page.evaluate(ring => {
    const v = __view, s = v.scene(), pts = ring.map(id => v.screenOf({ agent: id }));
    let best = null;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const mx = Math.round((pts[i][0] + pts[j][0]) / 2), my = Math.round((pts[i][1] + pts[j][1]) / 2);
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
        const up = s.pickAll(mx + dx, my + dy).upright;
        if (up.length >= 2 && up.every(h => h.kind === "agent" && ring.includes(h.id)) && (!best || Math.abs(dx) + Math.abs(dy) < best.d)) {
          best = { x: mx + dx, y: my + dy, d: Math.abs(dx) + Math.abs(dy), order: up.map(h => h.id) };
        }
      }
    }
    if (best) best.depth = best.order.map(id => s.movers.find(m => m.id === id).depth);
    return best;
  }, ids.slice(2));
  if (check(!!pair, "pick: two of three people on one tile overlap on screen")) {
    check(pair.depth.every((d, k) => k === 0 || pair.depth[k - 1] >= d), "pick: the stacked candidates run front to back", pair);
    const got = [];
    for (let k = 0; k < pair.order.length + 1; k++) {
      await page.mouse.click(pair.x, pair.y);
      const h = await lastPick(page);
      got.push(h && h.hit ? h.hit.id : null);
      await page.waitForTimeout(350);
    }
    const want = pair.order.concat([pair.order[0]]);
    check(JSON.stringify(got) === JSON.stringify(want), "pick: clicking a stacked pair cycles through them and back", { got, want });
  }

  // Esc deselects and tells the page; select() itself never does
  check(await page.evaluate(() => __calls.select.length) === 0, "select: select() never calls onSelect");
  check(!!(await page.evaluate(() => __view.selected())), "esc: someone is selected before Esc");
  await page.keyboard.press("Escape");
  let sel = await page.evaluate(() => ({ calls: __calls.select.slice(), now: __view.selected(), chip: document.querySelector(".cv-follow").classList.contains("cv-show") }));
  check(sel.calls.length === 1 && sel.calls[0] === null, "esc: Esc fires onSelect(null)", sel.calls);
  check(sel.now === null && !sel.chip, "esc: Esc deselects and hides the follow chip", sel);
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => __calls.select.length) === 1, "esc: Esc with nothing selected calls nothing");

  // keys typed into a form field are not the map's
  await page.evaluate(id => __view.select(id, { follow: false }), ids[0]);
  const z0 = (await cam(page)).zoom;
  await page.focus("#speed");
  await page.keyboard.press("Equal");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  sel = await page.evaluate(() => ({ zoom: __view.camera().zoom, sel: __view.selected(), calls: __calls.select.length }));
  check(sel.zoom === z0 && sel.sel === ids[0] && sel.calls === 1, "keys: keys in a <select> are ignored", sel);
  await page.evaluate(() => document.activeElement.blur());

  // + - 0, arrows and WASD, F
  await page.evaluate(() => __view.setCamera({ x: 40, y: 25, zoom: 2 }));
  await page.keyboard.press("Equal");
  await page.waitForTimeout(450);
  check((await cam(page)).zoom === 3, "keys: + zooms in a step", (await cam(page)).zoom);
  await page.keyboard.press("Minus");
  await page.waitForTimeout(450);
  check((await cam(page)).zoom === 2, "keys: - zooms out a step", (await cam(page)).zoom);
  await page.keyboard.press("Digit0");
  await page.waitForTimeout(800);
  const fitted = await page.evaluate(() => ({ zoom: __view.camera().zoom, fit: __view.cam().fitZoom() }));
  check(near(fitted.zoom, fitted.fit, 1e-3), "keys: 0 fits the city", fitted);
  await page.evaluate(() => __view.setCamera({ x: 40, y: 25, zoom: 1 }));
  for (const [key, axis, sign] of [["ArrowRight", "wx", 1], ["ArrowDown", "wy", 1], ["a", "wx", -1], ["w", "wy", -1]]) {
    const a = await cam(page);
    await page.keyboard.down(key);
    await page.waitForTimeout(300);
    await page.keyboard.up(key);
    await page.waitForTimeout(60);
    const b = await cam(page);
    check((b[axis] - a[axis]) * sign > 40, `keys: ${key} pans the map`, [a[axis], b[axis]]);
  }
  await page.evaluate(id => __view.select(id, { follow: false }), ids[0]);
  await page.keyboard.press("f");
  let c = await page.evaluate(() => ({ follow: __view.camera().follow, chip: document.querySelector(".cv-follow").textContent }));
  check(c.follow === ids[0] && /Following/.test(c.chip), "keys: F follows the selected person", c);
  await page.waitForTimeout(300);
  const chip = await page.evaluate(() => { const r = document.querySelector(".cv-follow").getBoundingClientRect(); return { cx: (r.left + r.right) / 2, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
  check(near(chip.cx, chip.w / 2, 2) && near(chip.bottom, chip.h - 10, 2), "controls: the follow chip sits bottom centre", chip);
  await page.keyboard.press("f");
  c = await page.evaluate(() => ({ follow: __view.camera().follow, chip: document.querySelector(".cv-follow").textContent }));
  check(c.follow === null && /Follow /.test(c.chip), "keys: F again stops following", c);
  await page.click(".cv-follow-name");
  check(await page.evaluate(() => __view.camera().follow) === ids[0], "controls: the chip follows again");
  await page.click(".cv-follow-x");
  check(await page.evaluate(() => __view.camera().follow) === null, "controls: the chip's x stops following");

  // drag pans (and is not a click), the wheel zooms to a crisp step
  await page.evaluate(() => __view.setCamera({ x: 40, y: 25, zoom: 1 }));
  const n0 = await picks(page), a0 = await cam(page);
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(760, 520, { steps: 3 });
  await page.mouse.move(800, 540, { steps: 3 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const a1 = await cam(page);
  check(near(a1.wx - a0.wx, -100, 6) && near(a1.wy - a0.wy, -40, 6), "drag: a drag pans the map under the pointer", [a1.wx - a0.wx, a1.wy - a0.wy]);
  check(await picks(page) === n0, "drag: a drag is not a click");
  await page.mouse.move(720, 480);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(700);
  const zw = (await cam(page)).zoom;
  check(zw > 1 && ZOOM_STEPS.includes(zw), "wheel: the wheel zooms in and settles on a step", zw);

  // the zoom buttons, the View menu, the minimap
  await page.evaluate(() => __view.setCamera({ x: 40, y: 25, zoom: 1 }));
  await page.click(".cv-ctl .cv-btn:nth-child(1)");
  await page.waitForTimeout(400);
  check((await cam(page)).zoom === 1.5, "controls: the + button zooms in a step", (await cam(page)).zoom);
  await page.click(".cv-ctl .cv-btn:nth-child(2)");
  await page.waitForTimeout(400);
  check((await cam(page)).zoom === 1, "controls: the - button zooms out a step", (await cam(page)).zoom);
  const ctl = await page.evaluate(() => { const r = document.querySelector(".cv-ctl").getBoundingClientRect(), m = document.querySelector(".cv-minimap").getBoundingClientRect(), hud = document.getElementById("hud").getBoundingClientRect();
    return { right: r.right, top: r.top, hud: hud.bottom, mRight: m.right, mBottom: m.bottom, w: innerWidth, h: innerHeight }; });
  check(near(ctl.right, ctl.w - 10, 1) && near(ctl.top, ctl.hud + 10, 2), "controls: .cv-ctl sits top right under the page's inset", ctl);
  check(near(ctl.mRight, ctl.w - 10, 1) && near(ctl.mBottom, ctl.h - 10, 1), "controls: .cv-minimap sits bottom right", ctl);
  await page.click(".cv-btn-view");
  check(await page.evaluate(() => !!document.querySelector(".cv-menu.cv-open")), "controls: View opens its menu");
  await page.click(".cv-menu-item:nth-child(2)");
  check(await page.evaluate(() => __view.camera().projection) === "flat", "controls: View > Top-down switches to flat");
  await page.click(".cv-btn-view");
  await page.click(".cv-menu-item:nth-child(1)");
  check(await page.evaluate(() => __view.camera().projection) === "iso", "controls: View > Isometric switches back");
  const homes0 = await page.evaluate(() => document.querySelector(".cv-minimap").classList.contains("cv-homes"));
  await page.click(".cv-btn-view");
  await page.click(".cv-menu-item:nth-child(4)");
  const homes1 = await page.evaluate(() => document.querySelector(".cv-minimap").classList.contains("cv-homes"));
  check(homes1 !== homes0, "controls: View > Homes toggles the minimap's homes overlay", [homes0, homes1]);
  await page.keyboard.press("Escape");
  const open0 = await page.evaluate(() => !document.querySelector(".cv-minimap").classList.contains("cv-collapsed"));
  await page.click(".cv-minimap-toggle");
  const open1 = await page.evaluate(() => !document.querySelector(".cv-minimap").classList.contains("cv-collapsed"));
  check(open0 && !open1, "controls: the minimap's toggle collapses it", [open0, open1]);
  await page.click(".cv-minimap-toggle");
  await shot(page, "controls");
  noErrors(log, "picking and controls");
  await ctx.close();
}

// Every facade method doing its job.
async function runFacade(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0");
  const ids = await page.evaluate(() => __state().agents.filter(a => a.alive !== false).slice(0, 2).map(a => a.id));
  await page.evaluate(ids => __t.craft({ [ids[0]]: [48, 36], [ids[1]]: [12, 25] }), ids);
  check(await page.evaluate(() => localStorage.getItem("goal.view")) === null, "facade: persist false stores nothing");

  // focus: animated, centred in the free area; a home id gives its block
  const focusCheck = async (target, what, o) => {
    await page.evaluate(() => { __view.setCamera({ x: 8, y: 8, zoom: 1 }); __view.frame(); });
    const r = await page.evaluate(([t, o]) => ({ ok: __view.focus(t, o), c0: __view.camera() }), [target, o || null]);
    await page.waitForTimeout(150);
    const mid = await page.evaluate(() => __view.camera());
    await page.waitForTimeout(900);
    const end = await page.evaluate(t => ({ at: t.agent ? __t.foot(t.agent) : __view.screenOf(t), c: __t.centre(), cam: __view.camera(), w: innerWidth }), target);
    const want = o && o.inset ? [(end.w - (o.inset.right || 0)) / 2, end.c[1]] : end.c;
    check(r.ok === true, `focus ${what}: returns true`, r.ok);
    const moved = Math.hypot(mid.x - r.c0.x, mid.y - r.c0.y), left = Math.hypot(end.cam.x - mid.x, end.cam.y - mid.y);
    check(moved > 0.05 && left > 0.5, `focus ${what}: the camera flies there (animated)`, { moved, left });
    check(end.at && near(end.at[0], want[0], 3) && near(end.at[1], want[1], 3), `focus ${what}: lands in the middle of the free area`, { at: end.at, want });
  };
  await focusCheck({ place: "birch_court_2b" }, "{place: a home id}");
  await focusCheck({ place: "bank" }, "{place}");
  await focusCheck({ tile: [60, 30] }, "{tile}");
  await focusCheck({ district: "the_works" }, "{district}");
  await focusCheck({ agent: ids[0] }, "{agent}");
  await focusCheck({ place: "hospital" }, "with {inset}", { inset: { top: await page.evaluate(() => __view.scene().inset.top), right: 400, bottom: 0 } });
  check(await page.evaluate(() => __view.focus({ agent: "nobody" })) === false && await page.evaluate(() => __view.focus({ place: "nowhere" })) === false,
    "focus: unknown targets return false");
  check(await page.evaluate(() => __view.focus({ agent: "nobody" }) === false && __view.camera()) !== null, "focus: an unknown target leaves the camera be");

  // highlight: an outline glow, and x-ray through the office tower in front of City Hall
  const hl = await page.evaluate(() => {
    const v = __view, s = v.scene();
    v.stop();
    v.setCamera({ x: 35, y: 18, zoom: 1.5 }); __t.warm();
    const r = __t.spriteRect("cityhall"), box = [r[0] - 10, r[1] - 10, r[2] - r[0] + 20, r[3] - r[1] + 20];
    v.frame(); const a = __t.grab(...box);
    v.highlight({ places: ["cityhall"] }); v.frame();
    const b = __t.grab(...box), ghost = s.ghost ? [...s.ghost].map(q => q.p.id) : [], places = s.highlight && s.highlight.places;
    v.highlight({ places: ["birch_court_1a"], agents: [] }); v.frame();
    const viaHome = s.highlight && s.highlight.places;
    v.highlight({ agents: ["x"] }); const agents = s.highlight && s.highlight.agents;
    v.highlight(null); v.frame();
    const c = __t.grab(...box);
    v.start();
    return { changed: __t.changed(a, b, 24), back: __t.changed(a, c, 24), ghost, places, viaHome, agents, cleared: s.highlight, area: box[2] * box[3] };
  });
  check(JSON.stringify(hl.places) === '["cityhall"]', "highlight: places are highlighted", hl.places);
  check(hl.changed > 300, "highlight: the highlighted building is outlined", hl);
  check(hl.ghost.includes("office"), "highlight: the tower in front of the highlighted building is x-rayed", hl.ghost);
  check(JSON.stringify(hl.viaHome) === '["birch_court"]', "highlight: a home id highlights its block", hl.viaHome);
  check(JSON.stringify(hl.agents) === '["x"]' && hl.cleared === null, "highlight: agents, and null clears", hl);
  check(hl.back < hl.area * 0.01, "highlight: clearing it restores the picture", hl.back);

  // setOverlay: a block of flats takes the tint; drawn each frame over the cached ground, never baked into it
  const ov = await page.evaluate(() => {
    const v = __view, s = v.scene();
    v.stop();
    v.setCamera({ x: 59.5, y: 12.5, zoom: 2 });
    __t.warm();
    const pts = s.tintTiles("birch_court").map(([x, y]) => v.cssOfTile(x + 0.5, y + 0.5))
      .filter(([x, y]) => x > 20 && y > 70 && x < innerWidth - 230 && y < innerHeight - 20 && !s.pickAll(x, y).upright.length);
    const read = () => pts.map(([x, y]) => __t.px(x, y, 2));
    v.frame(); const before = read(), built0 = s.stats.built;
    v.setOverlay("condition", { birch_court: "#ff00ff" }); v.frame(); const tinted = read(), name = s.overlay && s.overlay.name;
    v.setOverlay("condition", { birch_court_2b: "#ff00ff" }); v.frame(); const viaHome = read();
    v.setOverlay(null); v.frame(); const after = read(), cleared = s.overlay;
    v.setOverlay("wealth", {}); v.frame(); const empty = read();
    v.setOverlay(null); v.frame();
    const built1 = s.stats.built;
    v.start();
    return { n: pts.length, before, tinted, viaHome, after, empty, built0, built1, name, cleared };
  });
  const magenta = (c, d) => (c[0] + c[2] - 2 * c[1]) - (d[0] + d[2] - 2 * d[1]);
  const shifted = rows => rows.filter((c, i) => magenta(c, ov.before[i]) > 30).length;
  const same = rows => rows.filter((c, i) => c.every((v, k) => Math.abs(v - ov.before[i][k]) < 3)).length;
  check(ov.n >= 4, "overlay: Birch Court's apron is on screen", ov.n);
  check(shifted(ov.tinted) >= Math.max(3, ov.n * 0.6), "overlay: a block of flats takes the overlay tint (pixel check)", { n: ov.n, shifted: shifted(ov.tinted) });
  check(shifted(ov.viaHome) >= Math.max(3, ov.n * 0.6), "overlay: a flat's home id tints its block", shifted(ov.viaHome));
  check(same(ov.after) >= ov.n * 0.9 && ov.cleared === null, "overlay: setOverlay(null) takes the tint away", { same: same(ov.after), n: ov.n });
  check(same(ov.empty) >= ov.n * 0.9, "overlay: an overlay with no colours tints nothing", same(ov.empty));
  check(ov.built1 === ov.built0, "overlay: tints are drawn per frame, not baked into ground chunks", [ov.built0, ov.built1]);
  check(ov.name === "condition", "overlay: the overlay keeps its name", ov.name);
  await shot(page, "overlay");

  // ping: colours by topic, false when there is nothing to point at, an arrow at the edge when off screen
  const pg = await page.evaluate(() => {
    const v = __view, s = v.scene();
    s.pings.length = 0;
    const out = { bank: v.ping({ place: "bank" }, "money"), flat: v.ping({ place: "birch_court_2b" }, "home"), tile: v.ping({ tile: [5, 5] }, "nonsense"),
      agent: v.ping({ agent: __state().agents[0].id }, "death"), none: v.ping({ agent: "nobody" }, "death"), nowhere: v.ping({ place: "nowhere" }) };
    out.pings = s.pings.map(p => [p.color, p.topic]);
    return out;
  });
  check(pg.bank && pg.flat && pg.tile && pg.agent, "ping: places, home ids, tiles and agents can be pinged", pg);
  check(pg.none === false && pg.nowhere === false, "ping: unknown targets return false", pg);
  check(JSON.stringify(pg.pings) === JSON.stringify([["#f6c445", "money"], ["#4ab0f0", "home"], ["#ffffff", "other"], ["#e0402c", "death"]]),
    "ping: rings take the topic's colour", pg.pings);
  await page.evaluate(() => { __view.scene().pings.length = 0; __view.setCamera({ x: 62, y: 8, zoom: 3 }); __view.ping({ place: "market" }, "social"); });
  await page.waitForTimeout(250);
  const arrow = await page.evaluate(() => (__view.scene().pingArrows || []).find(a => a.target && a.target.place === "market") || null);
  if (check(!!arrow, "ping: an off-screen ping draws an arrow at the edge")) {
    const n0 = await picks(page);
    await page.mouse.click(Math.round((arrow.x0 + arrow.x1) / 2), Math.round((arrow.y0 + arrow.y1) / 2));
    await page.waitForTimeout(1100);
    const at = await page.evaluate(() => ({ at: __view.screenOf({ place: "market" }), c: __t.centre() }));
    check(at.at && near(at.at[0], at.c[0], 4) && near(at.at[1], at.c[1], 4), "ping: clicking the arrow flies to the ping", at);
    check(await picks(page) === n0, "ping: clicking the arrow picks nothing");
  }
  await shot(page, "ping");

  // setInset moves the controls and the middle of the map
  const ins = await page.evaluate(() => {
    const v = __view, top = v.scene().inset.top;
    v.setInset({ top: 80, right: 300, bottom: 60 });
    const r = document.querySelector(".cv-ctl").getBoundingClientRect(), m = document.querySelector(".cv-minimap").getBoundingClientRect(), c = __t.centre();
    v.setInset({ top });
    return { right: r.right, top: r.top, mRight: m.right, mBottom: m.bottom, c, w: innerWidth, h: innerHeight };
  });
  check(near(ins.right, ins.w - 310, 1) && near(ins.top, 90, 1), "setInset: .cv-ctl keeps clear of the page's panels", ins);
  check(near(ins.mRight, ins.w - 310, 1) && near(ins.mBottom, ins.h - 70, 1), "setInset: the minimap keeps clear too", ins);
  check(near(ins.c[0], (ins.w - 300) / 2, 0.5) && near(ins.c[1], (80 + ins.h - 60) / 2, 0.5), "setInset: the map centres in the free area", ins.c);

  // setMode and camera()
  const md = await page.evaluate(() => {
    const v = __view;
    v.setCamera({ x: 33, y: 22, zoom: 1.5 });
    const a = v.camera();
    v.setMode({ projection: "flat" }); v.frame();
    const b = v.camera();
    v.setMode({ projection: "iso" }); v.frame();
    return { a, b, c: v.camera(), stored: localStorage.getItem("goal.view") };
  });
  check(["x", "y", "zoom", "follow", "projection"].every(k => k in md.a), "camera: camera() gives x, y, zoom, follow and projection", md.a);
  check(md.b.projection === "flat" && near(md.b.x, md.a.x, 0.5) && near(md.b.y, md.a.y, 0.5), "setMode: flat keeps the camera over the same tile", md);
  check(md.c.projection === "iso" && near(md.c.x, md.a.x, 0.5) && near(md.c.y, md.a.y, 0.5), "setMode: iso again", md.c);
  check(await page.evaluate(() => __calls.camera) > 0, "camera: onCamera is called when the camera moves");

  // stop and start
  const f0 = await page.evaluate(() => { __view.stop(); return __view.scene().stats.frames; });
  await page.waitForTimeout(300);
  const f1 = await page.evaluate(() => { const f = __view.scene().stats.frames; __view.start(); return f; });
  await page.waitForTimeout(300);
  const f2 = await page.evaluate(() => __view.scene().stats.frames);
  check(f1 === f0 && f2 > f1 + 5, "stop/start: stop() halts the loop and start() runs it again", [f0, f1, f2]);

  // select: never calls onSelect, with or without follow
  const sl = await page.evaluate(id => { __view.select(id); const a = __view.camera().follow; __view.select(null); return { a, b: __view.camera().follow, calls: __calls.select.length }; }, ids[0]);
  check(sl.a === ids[0] && sl.b === null && sl.calls === 0, "select: follows by default, null clears, and never calls onSelect", sl);

  // setState keeps the last lots and homes when a frame omits them, and a lot without a stage gets one
  const ls = await page.evaluate(() => {
    const v = __view, s = v.scene(), st = __state();
    v.setState(st, 1);
    const listed = Object.keys(st.homes).find(id => st.homes[id].listing && !id.includes("court"));
    const look = () => ({ stage: s.looks.main_47 && s.looks.main_47.stage, listing: listed && s.looks[listed] ? s.looks[listed].listing : null });
    const a = look();
    const bare = Object.assign({}, __state(st.tick + 1)); delete bare.lots; delete bare.homes;
    v.setState(bare, 1);
    const b = look();
    const fresh = __state(st.tick + 2); fresh.lots = JSON.parse(JSON.stringify(fresh.lots)); fresh.lots.main_47 = { condition: 95, works: false, moving: false };
    v.setState(fresh, 1);
    const c = look();
    v.setState(__state(st.tick + 3), 1);
    return { listed, a, b, c, d: look() };
  });
  check(ls.a.stage === 4 && !!ls.a.listing, "setState: lots and homes give stages and listings", ls);
  check(ls.b.stage === 4 && ls.b.listing === ls.a.listing, "setState: a frame without lots and homes keeps the last ones", ls);
  check(ls.c.stage === 0 && ls.d.stage === 4, "setState: a lot without a stage takes it from its condition", ls);
  check(await page.evaluate(() => { try { __view.setState(null); __view.setTown(__fake.town); __view.setState(__state(), 1); return true; } catch (e) { return String(e); } }) === true,
    "setTown: a second town replaces the first");
  noErrors(log, "facade");
  await ctx.close();
}

// The five neglect stages at zoom 2, and the boards and vans on the camera-nearest road lot tile.
async function runStages(browser) {
  const size = { width: 1600, height: 1000 };
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&dyn=0&hud=0&minimap=0&zoom=2&at=15,28.5", { size });
  const ids = ["main_13", "main_21", "main_29", "main_39", "main_47"];
  const st = await page.evaluate(ids => {
    const v = __view, s = v.scene();
    // centre on the five houses
    const hs = ids.map(id => s.buildingOf(id).hull).flat();
    const c = v.cam();
    c.x = (Math.min(...hs.map(q => q[0])) + Math.max(...hs.map(q => q[0]))) / 2; c.y = (Math.min(...hs.map(q => q[1])) + Math.max(...hs.map(q => q[1]))) / 2;
    __t.warm();
    return { stages: ids.map(id => s.looks[id] && s.looks[id].stage), rects: ids.map(id => __t.hullRect(id)), zoom: v.camera().zoom, top: s.inset.top, w: innerWidth, h: innerHeight };
  }, ids);
  check(JSON.stringify(st.stages) === "[0,1,2,3,4]", "stages: the showcase houses are at stages 0 to 4", st.stages);
  const shown = st.rects.map(r => r && r[0] >= 0 && r[2] <= st.w && r[1] >= st.top && r[3] <= st.h);
  check(st.zoom === 2 && shown.every(Boolean), "stages: all five stages are on screen at zoom 2", { shown, rects: st.rects.map(r => r && r.map(Math.round)) });
  await shot(page, "stages");

  // boards and vans (PLAN decision 83): on the place's road-touching lot tile nearest the camera
  const lots = await page.evaluate(() => {
    const s = __view.scene(), town = s.town, out = [];
    const road = (x, y) => y >= 0 && y < town.h && x >= 0 && x < town.w && town.tiles[y][x] === "#";
    for (const p of town.places) {
      if (p.kind !== "home") continue;
      const sp = s.lotSpots(p.id);
      if (!sp || (!sp.van && !sp.sign)) continue;
      out.push({ id: p.id, van: sp.van, sign: sp.sign, front: sp.front,
        touch: sp.front.every(t => road(t.x - 1, t.y) || road(t.x + 1, t.y) || road(t.x, t.y - 1) || road(t.x, t.y + 1)),
        inLot: sp.front.every(t => !(t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h)) });
    }
    return out;
  });
  const vans = lots.filter(l => l.van), signs = lots.filter(l => l.sign);
  check(vans.length >= 1 && signs.length >= 2, "lots: the fixture has moving vans and boards to check", { vans: vans.map(l => l.id), signs: signs.map(l => l.id) });
  for (const l of lots) {
    const top = Math.max(...l.front.map(t => t.depth));
    check(l.touch && l.inLot, `lots ${l.id}: the candidate tiles are off the footprint and touch a road`, l.front);
    if (l.van) check(l.van[0] === l.front[0].x && l.van[1] === l.front[0].y && l.front[0].depth === top, `lots ${l.id}: the van stands on the camera-nearest road lot tile`, l);
    if (l.sign) {
      const t = l.front.find(q => q.x === l.sign[0] && q.y === l.sign[1]);
      const rest = l.front.filter(q => !(l.van && q.x === l.van[0] && q.y === l.van[1]) && !q.drive);
      const best = rest.length ? Math.max(...rest.map(q => q.depth)) : top;
      check(!!t && t.depth >= best && !(l.van && l.van[0] === t.x && l.van[1] === t.y), `lots ${l.id}: the board stands on the nearest road lot tile the van and the driveway leave`, l);
    }
  }
  noErrors(log, "stages");
  await ctx.close();

  // the one-palette specimen street: neighbouring stages differ in plenty of pixels
  const sp = await open(browser, "?persist=0&drive=0&dyn=0&specimen=1&hud=0&minimap=0&zoom=2&at=12,11", { size });
  const diff = await sp.page.evaluate(() => {
    const v = __view, s = v.scene(), st = __state();
    st.agents = st.agents.filter(a => a.inside);
    __push(st); __view.settle();
    const ids = s.town.places.map(p => p.id), hs = ids.map(id => s.buildingOf(id).hull).flat();
    const c = v.cam();
    c.x = (Math.min(...hs.map(q => q[0])) + Math.max(...hs.map(q => q[0]))) / 2; c.y = (Math.min(...hs.map(q => q[1])) + Math.max(...hs.map(q => q[1]))) / 2;
    v.stop(); __t.warm(); v.frame();
    const rects = ids.map(id => __t.hullRect(id)), stages = ids.map(id => s.looks[id].stage);
    // every house drawn at each stage in turn: each stage against the next, house by house
    const COND = [92, 70, 50, 30, 10], shots = ids.map(() => []);
    for (let k = 0; k < 5; k++) {
      const f = __state();
      f.tick += 10 + k; f.agents = f.agents.filter(a => a.inside);
      for (const id of ids) f.lots[id] = { condition: COND[k], works: false, moving: false };
      __push(f); v.settle(); v.frame();
      ids.forEach((id, i) => shots[i].push(__t.houseShot(id)));
    }
    const pairs = [0, 1, 2, 3].map(k => Math.min(...shots.map(sh => __t.shotDiff(sh[k], sh[k + 1], 30))));
    v.start();
    return { stages, pairs, on: rects.every(r => r[0] >= 0 && r[1] >= 0 && r[2] <= innerWidth && r[3] <= innerHeight) };
  });
  console.log(`  specimen: least share of a house's pixels that change from one stage to the next ${diff.pairs.map(p => (p * 100).toFixed(1) + "%").join(", ")}`);
  check(JSON.stringify(diff.stages) === "[0,1,2,3,4]" && diff.on, "stages: the specimen street shows stages 0 to 4 at zoom 2", diff);
  check(diff.pairs.every(p => p > 0.05), "stages: on every house each stage is distinguishable from the next", diff.pairs);
  await shot(sp.page, "specimen");
  noErrors(sp.log, "specimen");
  await sp.ctx.close();
}

// localStorage["goal.view"]: the projection and the camera come back; the rotation never does.
async function runPersist(browser) {
  const { ctx, page, log } = await open(browser, "?drive=0&dyn=0");
  await page.click(".cv-btn-view");
  await page.click(".cv-menu-item:nth-child(2)");
  await page.evaluate(() => __view.setCamera({ x: 60, y: 10, zoom: 2 }));
  await page.waitForTimeout(900);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("goal.view") || "null"));
  check(saved && saved.projection === "flat" && saved.zoom === 2 && near(saved.x, 60, 0.3) && near(saved.y, 10, 0.3) && !("rot" in saved),
    "persist: goal.view holds the projection and the camera", saved);
  await page.reload();
  await page.waitForFunction(() => window.__view && __view.scene() && __view.scene().stats.frames > 3, null, { timeout: 20000 });
  let c = await page.evaluate(() => __view.camera());
  check(c.projection === "flat" && c.zoom === 2 && near(c.x, 60, 0.3) && near(c.y, 10, 0.3), "persist: a reload brings them back", c);
  await page.evaluate(() => localStorage.setItem("goal.view", JSON.stringify({ projection: "iso", rot: 2, zoom: 1, x: 40, y: 25 })));
  await page.reload();
  await page.waitForFunction(() => window.__view && __view.scene() && __view.scene().stats.frames > 3, null, { timeout: 20000 });
  c = await page.evaluate(() => __view.camera());
  check(c.projection === "iso" && c.rot === 0, "persist: a stored rotation is never restored", c);
  noErrors(log, "persist");
  await ctx.close();

  const denied = await open(browser, "?drive=0&dyn=0", { init: () => { Object.defineProperty(window, "localStorage", { get() { throw new Error("storage denied"); } }); } });
  await denied.page.click(".cv-btn-view");
  await denied.page.click(".cv-menu-item:nth-child(2)");
  await denied.page.evaluate(() => __view.setCamera({ x: 30, y: 30, zoom: 1.5 }));
  await denied.page.waitForTimeout(800);
  check(await denied.page.evaluate(() => __view.camera().projection) === "flat", "persist: a throwing localStorage still switches modes");
  noErrors(denied.log, "persist without storage");
  await denied.ctx.close();
}

// Today's 40 x 25 town and its frames.
async function runOldTown(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&dyn=0");
  await page.evaluate(([town, st]) => { __view.setTown(town); __view.setState(st, 1); }, [OLD_TOWN, oldState(0)]);
  for (let t = 1; t < 6; t++) { await page.evaluate(st => __view.setState(st, 1), oldState(t)); await page.waitForTimeout(120); }
  const o = await page.evaluate(() => {
    const v = __view, s = v.scene();
    v.setCamera({ fit: true });
    const r = { w: s.town.w, h: s.town.h, buses: s.movers.filter(m => m.kind === "bus").length, people: s.movers.filter(m => m.kind === "person").length,
      cars: s.movers.filter(m => m.kind === "car").length, focus: v.focus({ place: "office" }), ping: v.ping({ place: "park" }, "social"), hit: v.pick(400, 400) };
    v.setMode({ projection: "flat" }); v.frame(); v.setMode({ projection: "iso" }); v.frame();
    return r;
  });
  check(o.w === 40 && o.h === 25, "old town: setTown accepts today's 40x25 town", o);
  check(o.buses === 1 && o.people >= 3 && o.cars === 1, "old town: today's state (one bus at state.bus) draws", o);
  check(o.focus && o.ping, "old town: focus and ping work on it", o);
  await page.waitForTimeout(400);
  await shot(page, "old-town");
  noErrors(log, "old town");
  await ctx.close();
}

// A phone: touch picking, the long-press hover, pinch and pan, the smaller chunk budget.
async function runPhone(browser) {
  const size = { width: 390, height: 844 };
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0", { size, touch: true, mobile: true, dpr: 2 });
  const ids = await page.evaluate(() => __state().agents.filter(a => a.alive !== false).slice(0, 1).map(a => a.id));
  await page.evaluate(ids => { __t.craft({ [ids[0]]: [48, 36] }); __view.setCamera({ x: 48.5, y: 36.5, zoom: 2 }); __view.frame(); }, ids);
  const ph = await page.evaluate(() => {
    let coarse = false;
    try { coarse = matchMedia("(pointer: coarse)").matches; } catch (e) { /* none */ }
    const s = __view.scene(), r = document.querySelector(".cv-ctl").getBoundingClientRect();
    return { coarse, budget: s.chunkBudget, dpr: s.dpr, collapsed: document.querySelector(".cv-minimap").classList.contains("cv-collapsed"),
      ctl: [r.left, r.top, r.right, r.bottom], scroll: [document.documentElement.scrollWidth, innerWidth] };
  });
  check(ph.coarse && ph.budget === 6e6, "phone: ground chunks are capped at 6 MP on a narrow touch screen", ph);
  check(ph.dpr === 2, "phone: the canvas draws at the device pixel ratio", ph.dpr);
  check(ph.collapsed, "phone: the minimap starts collapsed", ph);
  check(ph.ctl[0] >= 0 && ph.ctl[2] <= size.width && ph.scroll[0] <= ph.scroll[1], "phone: the controls fit and nothing scrolls sideways", ph);
  const p = (await page.evaluate(id => __view.screenOf({ agent: id }), ids[0])).map(Math.round);
  await page.touchscreen.tap(p[0], p[1]);
  await page.waitForTimeout(150);
  let pk = await lastPick(page);
  check(pk && pk.hit && pk.hit.id === ids[0] && pk.ev.touch === true, "phone: a tap picks the person with ev.touch", pk);
  await page.waitForTimeout(1600);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
  const n0 = await picks(page), h0 = await page.evaluate(() => __calls.hover.length);
  await touch("touchStart", [p]);
  await page.waitForTimeout(700);
  await touch("touchEnd", []);
  await page.waitForTimeout(100);
  const hv = await page.evaluate(n => __calls.hover.slice(n), h0);
  const lp = hv.find(h => h.ev && h.ev.touch);
  check(lp && lp.hit && lp.hit.id === ids[0], "phone: a long press hovers (ev.touch true) instead of picking", hv);
  check(await picks(page) === n0, "phone: a long press is not a tap");
  const z0 = (await cam(page)).zoom;
  await touch("touchStart", [[150, 450], [240, 450]]);
  for (let k = 1; k <= 8; k++) { await touch("touchMove", [[150 - k * 8, 450], [240 + k * 8, 450]]); await page.waitForTimeout(20); }
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const z1 = (await cam(page)).zoom;
  check(z1 > z0 && ZOOM_STEPS.includes(z1), "phone: a pinch zooms and settles on a step", [z0, z1]);
  const a = await cam(page);
  await touch("touchStart", [[200, 600]]);
  for (let k = 1; k <= 6; k++) { await touch("touchMove", [[200, 600 - k * 30]]); await page.waitForTimeout(30); }
  await page.waitForTimeout(120);
  await touch("touchEnd", []);
  await page.waitForTimeout(100);
  const b = await cam(page);
  check(b.wy - a.wy > 150 / a.zoom, "phone: a one-finger drag pans", [a.wy, b.wy]);
  await shot(page, "phone");
  noErrors(log, "phone");
  await ctx.close();
}

// The dashboard's dev page with the real view: every call the dashboard makes goes through.
async function runDashboard(browser) {
  if (!fs.existsSync(path.join(CLIENT, "dev", "dashboard.html"))) return;
  const { ctx, page, log } = await open(browser, "?view=real", { path: "/dev/dashboard.html" });
  await page.waitForFunction(() => window.Dash && Dash.inspect() && Dash.inspect().events > 0 && window.devView && typeof devView.scene === "function" && devView.scene(),
    null, { timeout: 20000 });
  await page.waitForTimeout(600);
  const id = await page.evaluate(() => {
    const s = devView.scene(), a = s.state.agents.find(x => x.alive !== false && !x.riding);
    Dash.selectAgent(a.id, { focus: true, follow: true });
    Dash.setOverlay("condition");
    return a.id;
  });
  await page.waitForTimeout(900);
  const d = await page.evaluate(() => ({ sel: devView.selected(), overlay: devView.scene().overlay, dash: Dash.selected() }));
  check(d.sel === id && d.dash === id, "dashboard: selecting a person reaches the view", d);
  check(d.overlay && d.overlay.name === "condition" && Object.keys(d.overlay.colors).length > 10, "dashboard: the condition overlay reaches the view", d.overlay && d.overlay.name);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(await page.evaluate(() => Dash.selected()) === null, "dashboard: Esc on the map deselects in the dashboard too");
  await page.evaluate(() => { const h = (devView.scene().town.homes || [])[0]; if (h) Dash.openHome(h.id); Dash.setOverlay(null); });
  await page.waitForTimeout(600);
  const failed = log.warnings.filter(w => /view\.\w+ failed/.test(w));
  check(failed.length === 0, "dashboard: no view call fails", failed.slice(0, 3));
  await shot(page, "dashboard");
  noErrors(log, "dashboard with the real view");
  await ctx.close();
}

const RUNS = [["globals", runGlobals], ["bench", runBench], ["picking", runPicking], ["facade", runFacade], ["stages", runStages],
  ["persist", runPersist], ["old town", runOldTown], ["phone", runPhone], ["dashboard", runDashboard]];

async function main() {
  const pw = findPlaywright();
  if (!pw) { console.log("SKIP: Playwright is not installed"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: no browser to launch (${String(e && e.message || e).split("\n")[0]})`); return; }
  const server = await serve();
  BASE = `http://127.0.0.1:${server.address().port}`;
  const only = process.argv.slice(2);
  try {
    for (const [name, run] of RUNS) {
      if (only.length && !only.includes(name)) continue;
      console.log(name);
      try { await run(browser); } catch (e) { check(false, `${name}: the run finished`, String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
