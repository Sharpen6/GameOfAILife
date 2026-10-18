#!/usr/bin/env node
// Headless smoke test for the isometric city view (client/view/*.js) on its dev page (client/dev/view.html),
// which drives the view with the fixture town (client/dev/fixture_town.js) and a fake host (fake_state.js).
//
//   node tests/browser/view_smoke.cjs
//
// It serves client/ on 127.0.0.1 and checks in headless Chromium (P4.md TESTS and acceptance):
// - globals: on a blank page the nine scripts add only window.CityView and the view adds no global of its
//   own while it runs; every facade method exists; CityView.shirt and .hair use game.js's formulas; the
//   page loads nothing but its own files and opens no socket; setMode before setTown is kept and stored;
//   frames sent before setTown keep their lots and homes; camera() has exactly the 3.12 keys; the view's
//   stage palette (CityView.stageColors, STAGE_COLORS) is dashboard.js's STAGE_COLOR
// - bench: the median draw is under 4 ms at zoom 1 on 1440x900 over 120 frames, in iso and in flat, both
//   with no console errors, and the view never pings on its own
// - picking: real clicks hit a known agent (ev {cssX, cssY, touch}), a roof in front of a pedestrian (then
//   the pedestrian on a second click) and a stacked pair in turn; select() never calls onSelect and Esc
//   deselects and calls onSelect(null); keys (arrows, WASD, + - 0, F) work and are ignored in a form
//   field; drag, wheel, the zoom buttons, the View menu, the follow chip (bottom centre) and the minimap
// - facade: focus (animated, a home id, a tile, a district, an agent, with an inset, another person while
//   following someone), highlight (glow
//   and x-ray), setOverlay (a block of flats takes the tint by pixel check, drawn per frame and never baked
//   into the ground chunks), ping (colours, false for unknown targets, the off-screen arrow flies there),
//   setInset, setMode, camera(), onCamera, stop/start, and setState keeping lots and homes it was not sent
//   (across a second setTown too)
// - stages: all five neglect stages on screen at zoom 2, pixel-distinct on the one-palette specimen street;
//   SALE / RENT / LET boards and moving vans on the camera-nearest road-touching lot tile where a board
//   shows (a board steps off it only for the van, or for a car parked on the driveway while its owner is
//   home); 55 Main Street's board and van, which the Grand Arcade hid, show at zoom 1, 2 and 3
// - persistence: localStorage["goal.view"] keeps the projection and camera (never the rotation), and a
//   throwing localStorage costs nothing
// - today's 40 x 25 town and its state (one bus at state.bus) load and draw in iso and flat
// - phone (390 x 844, touch): tap and long-press (ev.touch), pinch and one-finger pan, the 6 MP chunk
//   budget, the collapsed minimap, no sideways scroll; with a sheet over the bottom and toasts under the
//   HUD, every control stays in the free area, clear of the others and tappable, or waits out of sight
// - rotation (a tested parameter with no UI): at rotations 1-3 the projection round-trips, the camera
//   keeps its tile, focus and picking find a known building, and nothing logs an error
// - long task: pings made late in long main-thread tasks (a frame dated before the ping) never stop the
//   map, and a page hook that throws in a frame reaches the page as an error but the map keeps drawing
// - movers: a car turning a corner keeps to the road and a walker to the pavement and paths through every
//   frame of an L-shaped move; a walker stepping between two park trees crosses at their shared corner, a
//   walker and a car whose straight move is blocked go round; a household walking one street keeps apart;
//   two buses meeting at a junction or head-on never overlap (one gives way) and both get through, in their
//   own lanes
// - buses: on the real timetable (transit.bus_rows, from python3) no two buses overlap in any frame where
//   they turn across each other at Willow Lane and Main Street, none jumps (a lane change at a corner swings
//   across), and two buses on one tile on the first frame after a page load are drawn apart
// - night: headlights behind a nearer building are hidden by it, like the lamp pools
// - ticker: no name plate or badge is drawn under the page's ticker (it carries data-cv-avoid); without the
//   mark the same sweep does draw there
// - plane: the plane is outlined dark and drawn at its altitude over the city
// - the dashboard's dev page with the real view (?view=real) runs with no errors and no failed view calls;
//   the minimap's Homes legend and colours are the dashboard's Condition colours
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0. Set VIEW_SHOTS=<folder> to also save screenshots.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const CLIENT = path.join(REPO, "client");
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
    // a frame taken in as if it came at time T (performance.now() reads T meanwhile), for frames drawn at
    // chosen times with __view.frame(T)
    pushAt(st, T) { const pn = performance.now; performance.now = () => T; try { __push(st); } finally { performance.now = pn; } },
    // a frame with everyone alive at home and no buses (a quiet city to move a few people and buses in)
    quiet(dt) {
      const st = __state();
      st.tick += dt; st.buses = []; st.plane = null;
      for (const a of st.agents) if (a.alive !== false) Object.assign(a, { inside: a.home, riding: null, vehicle: "walk", state: "busy", activity: "relax_home" });
      return st;
    },
    // where a mover is drawn, in tile units: a vehicle's centre, a person's feet
    tileOf(id) {
      const s = __view.scene(), m = s.movers.find(q => q.id === id && q.kind !== "parked");
      if (!m) return null;
      return m.kind === "person" ? s.proj.toTile(m.wx + 8, m.wy + 28) : s.proj.toTile(m.cx, m.cy);
    },
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
    const keys0 = Object.keys(view.camera());
    // two frames before the town, the second without lots and homes: the first one's are kept
    const full = CITY_FIXTURE.state, bare = Object.assign({}, full, { tick: full.tick + 1 });
    delete bare.lots; delete bare.homes;
    view.setState(full, 1); view.setState(bare, 1);
    view.setTown(CITY_FIXTURE.town);
    const looks = view.scene().looks, lotIds = Object.keys(full.lots);
    const kept = { lots: lotIds.length, looked: lotIds.filter(id => looks[id] && (looks[id].stage | 0) === full.lots[id].stage).length,
      staged: lotIds.filter(id => full.lots[id].stage > 0).length, listed: Object.values(looks).filter(l => l.listing || l.anyListed).length };
    view.start();
    return { added, missing, keys0, keys1: Object.keys(view.camera()), kept, cv: ["create", "shirt", "hair", "stageOf"].filter(n => typeof CV[n] !== "function"), proj: view.camera().projection,
      stored: localStorage.getItem("goal.view"), ctl: !!host.querySelector(":scope > .cv-ctl"), chip: !!host.querySelector(":scope > .cv-follow"),
      mini: !!host.querySelector(":scope > .cv-minimap"), ids: CITY_FIXTURE.state.agents.map(a => a.id),
      colours: CITY_FIXTURE.state.agents.map(a => [CV.shirt(a.id), CV.hair(a.id)]),
      stages: typeof CV.stageColors === "function" ? CV.stageColors() : null, STAGES: CV.STAGE_COLORS };
  }, FACADE);
  check(g.added.length === 1 && g.added[0] === "CityView", "globals: the nine scripts define only window.CityView", g.added);
  check(g.missing.length === 0, "globals: every facade method exists", g.missing);
  check(g.cv.length === 0, "globals: CityView.create, shirt, hair and stageOf exist", g.cv);
  check(g.ctl && g.chip && g.mini, "globals: the view adds .cv-ctl, .cv-follow and .cv-minimap next to the canvas", g);
  check(g.proj === "flat", "globals: setMode before setTown is kept", g.proj);
  const KEYS = JSON.stringify(["x", "y", "zoom", "follow", "projection"]);
  check(JSON.stringify(g.keys0) === KEYS && JSON.stringify(g.keys1) === KEYS, "globals: camera() is exactly {x, y, zoom, follow, projection}, before and after setTown", [g.keys0, g.keys1]);
  check(g.kept.lots > 0 && g.kept.looked === g.kept.lots && g.kept.staged > 0 && g.kept.listed > 0,
    "globals: a frame without lots and homes before setTown keeps the earlier frame's", g.kept);
  let stored = null;
  try { stored = JSON.parse(g.stored); } catch (e) { /* checked below */ }
  check(stored && stored.projection === "flat", "globals: setMode before setTown is stored in goal.view", g.stored);
  const bad = g.ids.filter((id, i) => g.colours[i][0] !== gameShirt(id) || g.colours[i][1] !== gameHair(id));
  check(bad.length === 0, "globals: CityView.shirt and CityView.hair match game.js", bad.slice(0, 5));
  // one stage palette (review H6): without the dashboard on the page the view's own copy is the dashboard's
  const dashStages = (fs.readFileSync(path.join(CLIENT, "dashboard.js"), "utf8").match(/const STAGE_COLOR = (\[[^\]]*\])/) || [])[1];
  check(!!dashStages && JSON.stringify(g.stages) === JSON.stringify(JSON.parse(dashStages)) && JSON.stringify(g.STAGES) === JSON.stringify(g.stages),
    "globals: CityView.stageColors() and CityView.STAGE_COLORS are the dashboard's STAGE_COLOR", { view: g.stages, own: g.STAGES, dashboard: dashStages });
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
  // focus on another person while following someone: the camera stays on the new person (no drift back);
  // focusing the person followed keeps following
  const ff = await page.evaluate(async ids => {
    const v = __view, wait = ms => new Promise(r => setTimeout(r, ms));
    v.setCamera({ x: 8, y: 8, zoom: 1 });
    v.select(ids[0], { follow: true });
    await wait(900);
    const ok = v.focus({ agent: ids[1] });
    await wait(1800);
    const other = { ok, follow: v.camera().follow, at: __t.foot(ids[1]), mid: __t.centre() };
    v.select(ids[0], { follow: true });
    v.focus({ agent: ids[0] });
    await wait(1000);
    const same = { follow: v.camera().follow, at: __t.foot(ids[0]), mid: __t.centre() };
    v.select(null);
    return { other, same };
  }, ids);
  check(ff.other.ok && ff.other.follow === null && near(ff.other.at[0], ff.other.mid[0], 3) && near(ff.other.at[1], ff.other.mid[1], 3),
    "focus {agent} while following someone else: stops following and stays on the new person", ff.other);
  check(ff.same.follow === ids[0] && near(ff.same.at[0], ff.same.mid[0], 3) && near(ff.same.at[1], ff.same.mid[1], 3),
    "focus {agent} on the person followed: keeps following", ff.same);

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
  check(JSON.stringify(Object.keys(md.a)) === JSON.stringify(["x", "y", "zoom", "follow", "projection"]), "camera: camera() gives exactly x, y, zoom, follow and projection", md.a);
  check(await page.evaluate(() => { const c = __calls.cameraLast; return !!c && JSON.stringify(Object.keys(c)); }) === JSON.stringify(["x", "y", "zoom", "follow", "projection"]),
    "camera: onCamera gets the same shape");
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
  const again = await page.evaluate(() => {
    const v = __view, bare = Object.assign({}, __state()); delete bare.lots; delete bare.homes;
    v.setTown(__fake.town); v.setState(bare, 1);
    const l = v.scene().looks.main_47;
    return l ? l.stage : null;
  });
  check(again === 4, "setTown: a frame without lots and homes after a second setTown keeps the last ones", again);
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
      out.push({ id: p.id, van: sp.van, sign: sp.sign, front: sp.front, car: sp.car,
        touch: sp.front.every(t => road(t.x - 1, t.y) || road(t.x + 1, t.y) || road(t.x, t.y - 1) || road(t.x, t.y + 1)),
        inLot: sp.front.every(t => !(t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h)) });
    }
    return out;
  });
  const vans = lots.filter(l => l.van), signs = lots.filter(l => l.sign);
  check(vans.length >= 1 && signs.length >= 2, "lots: the fixture has moving vans and boards to check", { vans: vans.map(l => l.id), signs: signs.map(l => l.id) });
  // a tile where a nearer building would hide most of a board (hidden) is passed over while another shows
  const shows = ts => { const o = ts.filter(t => !t.hidden); return o.length ? o : ts; };
  for (const l of lots) {
    const top = Math.max(...shows(l.front).map(t => t.depth));
    check(l.touch && l.inLot, `lots ${l.id}: the candidate tiles are off the footprint and touch a road`, l.front);
    if (l.van) check(l.van[0] === l.front[0].x && l.van[1] === l.front[0].y && l.front[0].depth === top && shows(l.front).includes(l.front[0]), `lots ${l.id}: the van stands on the camera-nearest road lot tile where a board shows`, l);
    if (l.sign) {
      // front[0], unless the van stands there or a car is parked on it (a driveway while the owner is home)
      const t = l.front.find(q => q.x === l.sign[0] && q.y === l.sign[1]);
      const rest = shows(l.front.filter(q => !(l.van && q.x === l.van[0] && q.y === l.van[1]) && !(l.car && q.drive)));
      const best = rest.length ? Math.max(...rest.map(q => q.depth)) : top;
      check(!!t && t.depth >= best && (!rest.length || rest.includes(t)), `lots ${l.id}: the board stands on the camera-nearest road lot tile the van or a parked car leaves`, l);
      if (!l.van && !l.car) check(t === l.front[0], `lots ${l.id}: with no van and no parked car the board stands on the camera-nearest road lot tile where it shows`, l);
    }
  }
  // a listed house whose camera-nearest road lot tile is its driveway: the board stands there until a car
  // parks on it (the owner comes home), then steps to the next tile, and comes back when the car leaves
  const car = await page.evaluate(() => {
    const v = __view, s = v.scene(), town = s.town;
    const p = town.places.find(q => {
      if (q.kind !== "home" || q.style === "apartments") return false;
      const sp = s.lotSpots(q.id);
      return sp && sp.sign && !sp.van && sp.front.length > 1 && sp.front[0].drive;
    });
    if (!p) return null;
    const home = town.homes.find(h => h.place === p.id), xy = sp => sp.sign && sp.sign.join(",");
    const f0 = s.lotSpots(p.id).front[0], st = __state();
    st.tick += 2000;
    const a = st.agents.find(q => q.alive !== false && !q.car);
    Object.assign(a, { car: true, home: home.id, inside: home.id, riding: null, vehicle: "walk", state: "busy", activity: "relax_home" });
    for (const q of st.agents) if (q !== a && q.car && (q.home === home.id || q.home === p.id)) q.car = false;
    __push(st); v.settle(); v.frame();
    const parked = s.lotSpots(p.id), cars = s.movers.filter(m => m.kind === "parked" && m.id === "parked:" + a.id).length;
    const away = __state(); away.tick = st.tick + 1;
    const b = away.agents.find(q => q.id === a.id);
    Object.assign(b, { car: true, home: home.id, inside: null });
    __push(away); v.settle(); v.frame();
    const gone = s.lotSpots(p.id);
    return { id: p.id, f0: [f0.x, f0.y].join(","), parked: { car: parked.car, sign: xy(parked) }, cars, gone: { car: gone.car, sign: xy(gone) } };
  });
  if (check(!!car, "lots: a listed house's nearest road lot tile is its driveway", car)) {
    check(car.parked.car && car.cars === 1 && car.parked.sign !== car.f0, "lots: a car parked on the driveway moves the board to the next road lot tile", car);
    check(!car.gone.car && car.gone.sign === car.f0, "lots: when the car leaves the board stands on the driveway tile again", car);
  }
  // 55 Main Street (review H5): the Grand Arcade hides most of a board on its camera-nearest road lot tile,
  // so the board and the moving van stand on the next one, where they read. The lot drawn with and without
  // each at zoom 1, 2 and 3: at least 60% of the board's pixels, and of the van's, show
  const sale = await page.evaluate(() => {
    const v = __view, s = v.scene(), id = "main_55", home = s.town.homes.find(h => h.place === id);
    if (!home || !s.lotSpots(id)) return null;
    const area = spr => { const d = spr.c.getContext("2d").getImageData(0, 0, spr.c.width, spr.c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] >= 200) n++; return n; };
    const front = s.lotSpots(id).front, road = front[0].road;
    const out = { front, board: area(s.art.sign("sale")), van: area(s.art.van(road === "n" || road === "s" ? 0 : 1)), zooms: [] };
    v.stop();
    let n = 0;
    const draw = (listing, moving) => {
      const st = __t.quiet(30000 + n++);
      st.homes[home.id] = Object.assign({}, st.homes[home.id], { listing });
      st.lots[id] = Object.assign({}, st.lots[id], { moving });
      __push(st); v.settle(); __t.warm(); v.frame(1e7);
    };
    const changed = (a, b) => { let c = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) >= 30) c++; return c; };
    for (const zoom of [1, 2, 3]) {
      const ws = front.map(t => s.proj.toWorld(t.x + 0.5, t.y + 0.5)), c = v.cam();
      c.x = ws.reduce((m, w) => m + w[0], 0) / ws.length; c.y = ws.reduce((m, w) => m + w[1], 0) / ws.length; c.zoom = zoom;
      draw(null, false);
      const a = s.worldToCss(Math.min(...ws.map(w => w[0])) - 48, Math.min(...ws.map(w => w[1])) - 56), b = s.worldToCss(Math.max(...ws.map(w => w[0])) + 48, Math.max(...ws.map(w => w[1])) + 24);
      const grab = () => __t.grab(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      const bare = grab();
      draw("for_sale", false);
      const board = changed(bare, grab()), sign = s.lotSpots(id).sign;
      draw(null, true);
      const van = changed(bare, grab()), at = s.lotSpots(id).van;
      out.zooms.push({ zoom, sign, board, at, van });
    }
    draw("for_sale", false);
    v.start();
    return out;
  });
  if (check(!!sale, "lots: the fixture has 55 Main Street", sale)) {
    check(sale.front.some(t => t.hidden) && !sale.front[0].hidden && sale.front.every((t, n) => !n || sale.front[n - 1].hidden <= t.hidden),
      "lots main_55: the road lot tile the Grand Arcade hides goes after those where a board shows", sale.front);
    console.log(`  main_55: board ${sale.board} px, van ${sale.van} px; shown at zoom 1, 2, 3: board ${sale.zooms.map(q => q.board).join(", ")}, van ${sale.zooms.map(q => q.van).join(", ")}`);
    for (const q of sale.zooms) {
      const z2 = q.zoom * q.zoom;
      check(q.board >= 0.6 * sale.board * z2, `lots main_55: its SALE board shows at zoom ${q.zoom}`, { ...q, boardPx: sale.board });
      check(q.van >= 0.6 * sale.van * z2, `lots main_55: its moving van shows at zoom ${q.zoom}`, { ...q, vanPx: sale.van });
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
  // (the view stopped first, so a save it still has due from the restore cannot overwrite the stored value)
  await page.evaluate(() => { __view.stop(); localStorage.setItem("goal.view", JSON.stringify({ projection: "iso", rot: 2, zoom: 1, x: 40, y: 25 })); });
  await page.reload();
  await page.waitForFunction(() => window.__view && __view.scene() && __view.scene().stats.frames > 3, null, { timeout: 20000 });
  c = await page.evaluate(() => ({ projection: __view.camera().projection, rot: __view.scene().proj.rot }));
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

  // A sheet over the bottom of the map and toasts under the HUD, as the dashboard does on a phone: every
  // control stays inside the free area, clear of the others, and a tap at its middle reaches it.
  const top0 = await page.evaluate(() => __view.scene().inset.top);
  await page.evaluate(id => __view.select(id, { follow: false }), ids[0]);
  const layout = (ins, o) => page.evaluate(([ins, o]) => {
    for (const id of ["__sheet", "__toasts"]) { const e = document.getElementById(id); if (e) e.remove(); }
    const cr = document.getElementById("map").getBoundingClientRect();
    const cover = (id, y0, y1) => { const e = document.createElement("div"); e.id = id; e.style.cssText = `position:fixed;left:0;right:0;top:${y0}px;height:${Math.max(0, y1 - y0)}px;z-index:40;background:rgba(30,36,50,0.92)`; document.body.appendChild(e); };
    cover("__sheet", cr.bottom - ins.bottom, cr.bottom);
    cover("__toasts", cr.top + ins.top - 70, cr.top + ins.top);
    __view.setInset(ins);
    const mini = document.querySelector(".cv-minimap");
    if (o.mini != null && mini.classList.contains("cv-collapsed") === o.mini) document.querySelector(".cv-minimap-toggle").click();
    const menu = document.querySelector(".cv-menu");
    if (!!o.menu !== menu.classList.contains("cv-open")) document.querySelector(".cv-btn-view").click();
    __view.frame();
    const y0 = cr.top + ins.top, y1 = cr.bottom - ins.bottom;
    const R = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
    const out = { free: [y0, y1], row: document.querySelector(".cv-ctl").classList.contains("cv-row"), parts: {} };
    const parts = { plus: ".cv-ctl > .cv-btn:nth-child(1)", minus: ".cv-ctl > .cv-btn:nth-child(2)", fit: ".cv-ctl > .cv-btn:nth-child(3)", view: ".cv-btn-view",
      mini: ".cv-minimap", chip: ".cv-follow" };
    if (o.menu) parts.menu = ".cv-menu";
    for (const [k, sel] of Object.entries(parts)) {
      const e = document.querySelector(sel), r = R(e), shown = getComputedStyle(e).visibility === "visible" && r[2] > r[0];
      const tap = sel === ".cv-minimap" ? document.querySelector(".cv-minimap-toggle") : e, t = R(tap);
      const hit = shown ? document.elementFromPoint((t[0] + t[2]) / 2, (t[1] + t[3]) / 2) : null;
      out.parts[k] = { r: r.map(Math.round), shown, inside: r[0] >= 0 && r[2] <= innerWidth && r[1] >= y0 - 0.5 && r[3] <= y1 + 0.5, reached: !!hit && (hit === tap || tap.contains(hit)) };
    }
    const box = ks => { const rs = ks.map(k => out.parts[k]).filter(q => q.shown).map(q => q.r); return rs.length ? [Math.min(...rs.map(q => q[0])), Math.min(...rs.map(q => q[1])), Math.max(...rs.map(q => q[2])), Math.max(...rs.map(q => q[3]))] : null; };
    const groups = { ctl: box(["plus", "minus", "fit", "view"]), mini: box(["mini"]), chip: box(["chip"]) };
    const meet = (a, b) => !!a && !!b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    out.overlaps = [["ctl", "mini"], ["ctl", "chip"], ["mini", "chip"]].filter(([a, b]) => meet(groups[a], groups[b])).map(q => q.join("+"));
    return out;
  }, [ins, o]);
  const good = (L, keys) => keys.every(k => L.parts[k].shown && L.parts[k].inside && L.parts[k].reached);
  const CTL = ["plus", "minus", "fit", "view", "mini", "chip"];
  let L = await layout({ top: top0 + 80, bottom: 464 }, { mini: false });
  check(good(L, CTL) && L.overlaps.length === 0, "phone layout: a short free area keeps every control in it, apart and tappable (minimap shut)", L);
  check(L.row, "phone layout: the zoom stack lies in a row when it is too tall for the free area", L.row);
  L = await layout({ top: top0 + 80, bottom: 464 }, { mini: true });
  check(good(L, CTL) && L.overlaps.length === 0, "phone layout: the same with the minimap open", L);
  await shot(page, "phone-sheet");
  L = await layout({ top: top0 + 80, bottom: 464 }, { mini: true, menu: true });
  check(good(L, ["view", "menu"]) && L.parts.menu.inside, "phone layout: the View menu opens inside the free area", L.parts);
  await shot(page, "phone-sheet-menu");
  L = await layout({ top: top0 + 30, bottom: 640 }, { mini: true, menu: false });
  check(CTL.every(k => !L.parts[k].shown || (L.parts[k].inside && L.parts[k].reached)) && L.overlaps.length === 0 && good(L, ["plus", "minus", "fit", "view"]),
    "phone layout: a very short free area keeps the stack and hides what does not fit", L);
  await shot(page, "phone-sheet-short");
  L = await layout({ top: top0 + 30, bottom: 760 }, { mini: false });
  check(CTL.every(k => !L.parts[k].shown), "phone layout: with no room at all the controls wait out of sight", L.parts);
  L = await layout({ top: top0, bottom: 0 }, { mini: false });
  check(good(L, CTL) && !L.row && L.overlaps.length === 0, "phone layout: with room again the stack stands in its column", L);
  await page.evaluate(() => { for (const id of ["__sheet", "__toasts"]) { const e = document.getElementById(id); if (e) e.remove(); } __view.select(null); });
  noErrors(log, "phone");
  await ctx.close();
}

// Rotation is a tested parameter of the iso projection with no UI: each quarter turn round-trips, keeps
// the camera's tile, and focuses and picks a known building, with no console errors.
async function runRotation(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&dyn=0");
  const tops = [];
  for (const rot of [1, 2, 3, 0]) {
    const r = await page.evaluate(async rot => {
      const v = __view;
      v.setCamera({ x: 33, y: 22, zoom: 1.5 }); v.frame();
      const before = v.camera();
      v.setMode({ projection: "iso", rot }); v.frame();
      const after = v.camera(), p = v.scene().proj;
      let err = 0;
      for (const [x, y] of [[0, 0], [10, 5], [79, 49], [33.3, 12.7], [64, 3], [5, 44]]) {
        const w = p.toWorld(x, y), t = p.toTile(w[0], w[1]);
        err = Math.max(err, Math.abs(t[0] - x), Math.abs(t[1] - y));
      }
      const corners = [[0, 0], [p.w, 0], [p.w, p.h], [0, p.h]].map(([x, y]) => p.toWorld(x, y));
      const top = corners.reduce((b, c, k) => c[1] < corners[b][1] ? k : b, 0); // the map corner drawn at the top
      const ok = v.focus({ place: "bank" });
      await new Promise(res => setTimeout(res, 1000));
      const at = v.screenOf({ place: "bank" }), hit = at && v.pick(at[0], at[1]);
      v.frame();
      const c = document.getElementById("map"), g = c.getContext("2d"), seen = new Set();
      for (let i = 0; i < 300; i++) { const d = g.getImageData((i * 97) % c.width, 60 + (i * 53) % (c.height - 60), 1, 1).data; seen.add(d[0] >> 4 << 8 | d[1] >> 4 << 4 | d[2] >> 4); }
      return { rot: p.rot, kind: p.kind, err, before, after, top, ok, at, mid: __t.centre(), hit, colours: seen.size };
    }, rot);
    check(r.kind === "iso" && r.rot === rot, `rotation ${rot}: setMode({projection: "iso", rot}) turns the projection`, r);
    check(r.err < 1e-6, `rotation ${rot}: toTile(toWorld(x, y)) round-trips`, r.err);
    check(near(r.after.x, r.before.x, 0.5) && near(r.after.y, r.before.y, 0.5), `rotation ${rot}: the camera keeps its tile across the turn`, [r.before, r.after]);
    tops.push(r.top);
    check(r.ok && r.at && near(r.at[0], r.mid[0], 4) && near(r.at[1], r.mid[1], 4), `rotation ${rot}: focus lands on the bank`, r);
    check(r.hit && r.hit.kind === "place" && r.hit.id === "bank", `rotation ${rot}: a click on the bank picks it`, r.hit);
    check(r.colours > 12, `rotation ${rot}: the city is drawn`, r.colours);
    await shot(page, `rot${rot}`);
  }
  check(new Set(tops).size === 4, "rotation: each quarter turn puts a different corner of the map at the top", tops);
  noErrors(log, "rotation");
  await ctx.close();
}

// A long main-thread task: a frame's timestamp can then be older than a ping stamped late in the task (and
// a ping on a home rebuilds its statics first). The rings never get a negative age, and a frame that throws,
// here a page onCamera hook, never stops the loop. On the dev page and on the dashboard's with the real view.
async function runLongTask(browser) {
  const pages = [["view", "", null, "__view"]];
  if (fs.existsSync(path.join(CLIENT, "dev", "dashboard.html"))) pages.push(["dashboard", "?view=real", { path: "/dev/dashboard.html" }, "devView"]);
  for (const [label, query, o, v] of pages) {
    const { ctx, page, log } = await open(browser, query, o || undefined);
    if (o) await page.waitForFunction(() => window.devView && typeof devView.scene === "function" && devView.scene() && devView.scene().stats.frames > 3, null, { timeout: 20000 });
    const frames = () => page.evaluate(v => window[v].scene().stats.frames, v);
    // the same thing by hand: a frame dated before the ping it draws
    const early = await page.evaluate(v => {
      const view = window[v], s = view.scene();
      try {
        view.ping({ place: "bank" }, "money");
        const t0 = s.pings[s.pings.length - 1].t0;
        for (const back of [1, 200, 700, 2900]) view.frame(t0 - back);
        return true;
      } catch (e) { return String(e); }
    }, v);
    check(early === true, `long task (${label}): a frame dated before a ping draws it without a negative ring`, early);
    const f0 = await frames();
    for (let i = 0; i < 4; i++) {
      await page.evaluate(([v, i]) => {
        const view = window[v], s = view.scene(), homes = s.town.homes || [];
        let t = performance.now();
        while (performance.now() - t < 700) { /* a slow phone, a big re-render */ }
        view.ping(i % 2 && homes.length ? { place: homes[i % homes.length].id } : { place: "bank" }, i % 2 ? "life" : "money");
        t = performance.now();
        while (performance.now() - t < 50) { /* busy after the ping too */ }
      }, [v, i]);
      await page.waitForTimeout(250);
    }
    const f1 = await frames();
    await page.waitForTimeout(800);
    const f2 = await frames();
    check(f1 > f0 && f2 > f1 + 10, `long task (${label}): pings made late in long tasks never stop the map`, [f0, f1, f2]);
    check(await page.evaluate(v => window[v].scene().pings.length, v) > 0, `long task (${label}): the pings are still drawn`);
    noErrors(log, `long task (${label})`);
    if (o) { await ctx.close(); continue; }

    // a page hook that throws in a frame: the error reaches the page, the map keeps drawing
    await page.evaluate(() => Object.defineProperty(__calls, "cameraLast", { configurable: true, get() { return null; }, set() { throw new Error("onCamera hook failed on purpose"); } }));
    const g0 = await frames();
    await page.evaluate(() => { __view.focus({ place: "bank" }, { zoom: 2, ms: 500 }); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { __view.focus({ district: "downtown" }, { zoom: 1, ms: 500 }); });
    await page.waitForTimeout(900);
    const g1 = await frames();
    const thrown = log.errors.filter(e => /on purpose/.test(e));
    check(g1 > g0 + 20, "long task: a page hook that throws in a frame never stops the map", [g0, g1]);
    check(thrown.length >= 1 && thrown.length <= 2, "long task: the hook's error reaches the page, not every frame", thrown.length);
    const n0 = await page.evaluate(() => { delete __calls.cameraLast; __calls.cameraLast = null; return __calls.camera; });
    await page.evaluate(() => { __view.focus({ place: "bank" }, { ms: 300 }); });
    await page.waitForTimeout(600);
    const back = await page.evaluate(() => ({ n: __calls.camera, last: __calls.cameraLast }));
    check(back.n > n0 && back.last && back.last.x != null, "long task: onCamera reports again once the hook is fixed", back);

    // a frame that throws with a clip still open: the next frames paint the whole canvas again (after the
    // 2 s in which a second error would not be reported)
    await page.waitForTimeout(2100);
    await page.evaluate(() => {
      const s = __view.scene(), orig = s.draw, g = document.getElementById("map").getContext("2d"), c = __t.centre();
      window.__before = __t.grab(c[0] - 60, c[1] - 60, 120, 120);
      s.draw = function (now) {
        s.draw = orig;
        g.save(); g.beginPath(); g.rect(0, 0, 2, 2); g.clip();
        throw new Error("draw failed on purpose");
      };
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => { __view.focus({ district: "downtown" }, { zoom: 1, ms: 50 }); });
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => {
      const c = __t.centre(), a = __before, b = __t.grab(c[0] - 60, c[1] - 60, 120, 120);
      return { share: __t.changed(a, b, 12) / (a.width * a.height), draws: __view.scene().draw.toString().includes("on purpose") };
    });
    check(!clip.draws && clip.share > 0.2, "long task: a frame that throws with a clip open leaves the next frames whole", clip);
    check(log.errors.filter(e => /draw failed on purpose/.test(e)).length === 1, "long task: the draw's error reaches the page once");
    log.errors = log.errors.filter(e => !/on purpose/.test(e));
    noErrors(log, "long task (view, hook)");
    await ctx.close();
  }
}

// Moving things keep to where they may go (review ART-1, ART-3, ART-5, ART-6), on frames sent at chosen times
// and drawn every 10.5 ms of each 417 ms tick:
// - a car leaving its driveway diagonally turns onto the road instead of sliding along the lawn, and its next
//   diagonal move runs down the road instead of through the house beside it
// - a walker stepping diagonally in a park goes round the tree tile, not through it; one stepping between two
//   trees (Eastgate Green, (67, 20) to (66, 19)) crosses at their shared corner point, never into a tree
//   tile; one whose straight move runs through a tree ((65, 20) to (65, 22)) goes round it
// - a car whose straight move from a driveway crosses a lawn ((6, 26) to (3, 26)) goes round by the road
// - a household walking the same pavement together is drawn one behind another, never on one spot
// - two buses crossing at a junction on the same minute never overlap (one waits short of the crossing and
//   catches up without a jump), and two passing head-on keep to their lanes
async function runMovers(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0&hud=0&minimap=0&zoom=2&at=15,26");
  const r = await page.evaluate(() => {
    const v = __view, s = v.scene(), T = s.town;
    v.stop();
    const line = (x0, y0, dx, dy, n) => [...Array(n)].map((_, k) => [x0 + dx * k, y0 + dy * k]);
    const people = {
      ben: { veh: "car", path: [[14, 26], [15, 25], [16, 28], [16, 31]] }, // main_29's driveway onto Main Street, then south
      neta: { veh: "walk", path: [[18, 5], [19, 4], [20, 5], [21, 4]] },  // Maple Park, round the trees at (19, 5) and (21, 5)
      dana: { veh: "walk", path: line(20, 25, 1, 0, 6) }, yossi: { veh: "walk", path: line(20, 25, 1, 0, 6) }, noa: { veh: "walk", path: line(20, 25, 1, 0, 6) },
      maya: { veh: "walk", path: [[67, 20], [66, 19], [67, 20], [66, 19]] }, // Eastgate Green, between the trees at (66, 20) and (67, 19)
      lior: { veh: "walk", path: [[65, 20], [65, 22], [65, 20]] },             // straight through the tree at (65, 21)
      avi: { veh: "car", path: [[6, 26], [3, 26]] },                           // a driveway at (6, 26), straight across the lawn to Willow Lane
    };
    const tl = (x, y) => T.tiles[y][x];
    const pre = [tl(66, 20), tl(67, 19), tl(67, 20), tl(66, 19), tl(65, 21), tl(65, 20), tl(65, 22), tl(6, 26), tl(5, 26), tl(4, 26), tl(3, 26), tl(6, 25), tl(3, 25)].join("");
    const buses = { "1a": { line: "1", dir: "e", path: line(-1, 25, 1, 0, 10) }, "2a": { line: "2", dir: "n", path: line(3, 29, 0, -1, 10) },
      "1b": { line: "1", dir: "w", path: line(51, 36, -1, 0, 10) }, "2b": { line: "2", dir: "e", path: line(43, 36, 1, 0, 10) } };
    const ext = d => d === "e" || d === "w" ? [0.725, 0.21] : [0.21, 0.725];
    const tileAt = p => (T.tiles[Math.floor(p[1])] || "")[Math.floor(p[0])];
    const out = { car: [], walk: [], family: Infinity, junction: -Infinity, headon: -Infinity, step: 0, samples: 0, pre, corner: [], treeGap: Infinity, round: [], avi: [] };
    const last = {};
    for (let k = 0; k < 10; k++) {
      const st = __t.quiet(5000 + k), t = 1e7 + k * 417;
      for (const [id, m] of Object.entries(people)) {
        const [x, y] = m.path[Math.min(k, m.path.length - 1)];
        Object.assign(st.agents.find(a => a.id === id), { x, y, inside: null, vehicle: m.veh, state: "travelling", activity: "commute" });
      }
      st.buses = Object.entries(buses).map(([id, b]) => ({ id, line: b.line, x: b.path[k][0], y: b.path[k][1], dir: b.dir, at_stop: null, riders: 0 }));
      __t.pushAt(st, t);
      for (let j = 0; j < 40; j++) {
        v.frame(t + j * 10.5);
        out.samples++;
        const car = __t.tileOf("ben"), c = tileAt(car);
        if (c !== "#" && !(Math.floor(car[0]) === 14 && Math.floor(car[1]) === 26)) out.car.push([k, j, car.map(q => +q.toFixed(2)), c]);
        const w = __t.tileOf("neta"), cw = tileAt(w);
        if (!".#Pe".includes(cw)) out.walk.push([k, j, w.map(q => +q.toFixed(2)), cw]);
        // between two trees: never in a tree tile (nor on the corner point the four tiles share), clear of the trunks
        const m2 = __t.tileOf("maya"), cm = tileAt(m2);
        if (cm === "T" || (Math.abs(m2[0] - 67) < 1e-6 && Math.abs(m2[1] - 20) < 1e-6)) out.corner.push([k, j, m2.map(q => +q.toFixed(3))]);
        out.treeGap = Math.min(out.treeGap, Math.hypot(m2[0] - 66.5, m2[1] - 20.5), Math.hypot(m2[0] - 67.5, m2[1] - 19.5));
        const l2 = __t.tileOf("lior");
        if (tileAt(l2) === "T") out.round.push([k, j, l2.map(q => +q.toFixed(2))]);
        const a2 = __t.tileOf("avi");
        if (tileAt(a2) !== "#" && !(Math.floor(a2[0]) === 6 && Math.floor(a2[1]) === 26)) out.avi.push([k, j, a2.map(q => +q.toFixed(2)), tileAt(a2)]);
        if (k >= 1 && k <= 5) {
          const fam = ["dana", "yossi", "noa"].map(id => { const m = s.movers.find(q => q.id === id); return s.worldToCss(m.wx + 8, m.wy + 28); });
          for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) out.family = Math.min(out.family, Math.hypot(fam[a][0] - fam[b][0], fam[a][1] - fam[b][1]));
        }
        const P = {};
        for (const id of Object.keys(buses)) {
          P[id] = __t.tileOf(id);
          if (last[id]) out.step = Math.max(out.step, Math.hypot(P[id][0] - last[id][0], P[id][1] - last[id][1]));
          last[id] = P[id];
        }
        const overlap = (a, b) => { const ea = ext(buses[a].dir), eb = ext(buses[b].dir); return Math.min(ea[0] + eb[0] - Math.abs(P[a][0] - P[b][0]), ea[1] + eb[1] - Math.abs(P[a][1] - P[b][1])); };
        out.junction = Math.max(out.junction, overlap("1a", "2a"));
        out.headon = Math.max(out.headon, overlap("1b", "2b"));
      }
    }
    out.end = { "1a": __t.tileOf("1a"), "2a": __t.tileOf("2a"), maya: __t.tileOf("maya"), lior: __t.tileOf("lior"), avi: __t.tileOf("avi") };
    return out;
  });
  check(r.pre === "TTPPTPPe..###", "movers: the fixture town has the trees, lawn and roads the moves below are about", r.pre);
  check(r.samples === 400, "movers: 400 frames drawn", r.samples);
  check(r.car.length === 0, "movers: a car leaving its driveway diagonally keeps to the road (never the lawn or the house)", r.car.slice(0, 6));
  check(r.walk.length === 0, "movers: a walker stepping diagonally in a park goes round the trees", r.walk.slice(0, 6));
  check(r.corner.length === 0 && r.treeGap > 0.6, "movers: a walker stepping between two trees crosses at their shared corner, never into a tree (0.6 tiles or more from the trunks)", { corner: r.corner.slice(0, 6), gap: r.treeGap });
  check(r.round.length === 0 && Math.hypot(r.end.lior[0] - 65.5, r.end.lior[1] - 20.5) < 0.3, "movers: a walker whose straight move runs through a tree goes round it, and gets there", { round: r.round.slice(0, 6), end: r.end.lior });
  check(r.avi.length === 0 && Math.floor(r.end.avi[0]) === 3 && Math.floor(r.end.avi[1]) === 26, "movers: a car whose straight move from a driveway crosses a lawn goes round by the road", { off: r.avi.slice(0, 6), end: r.end.avi });
  check(r.family >= 8, "movers: a family walking the same pavement is drawn one behind another (8 px apart or more at zoom 2)", r.family);
  check(r.junction <= 0, "movers: two buses crossing at a junction on the same minute never overlap", r.junction);
  check(r.headon <= 0, "movers: two buses passing head-on keep to their lanes", r.headon);
  check(r.step < 0.1, "movers: a bus that waits at a crossing catches up without a jump (tiles per 10.5 ms)", r.step);
  check(r.end["1a"][0] > 6 && r.end["2a"][1] < 22, "movers: both buses have crossed by the end", r.end);
  await shot(page, "movers");
  noErrors(log, "movers");
  await ctx.close();
}

// The real timetable's bus rows for ticks [t0, t0 + n), from the engine (python3, or $PYTHON).
function busRows(t0, n) {
  const code = "import json, sys\nsys.path.insert(0, sys.argv[1])\nfrom gameofailife import transit\n" +
    "print(json.dumps([transit.bus_rows(t) for t in range(int(sys.argv[2]), int(sys.argv[3]))]))";
  const out = require("child_process").execFileSync(process.env.PYTHON || "python3", ["-c", code, REPO, String(t0), String(t0 + n)], { timeout: 60000 });
  return JSON.parse(out.toString());
}

// Buses on the real timetable (review ART-3): from 06:00 to 06:40 (ticks 360-400) the line 1 and line 2 buses
// meet at the Willow Lane / Main Street junction (3, 25) every 13 minutes: at 06:04 1a (heading south) and 2a
// (heading west) both reach it, and at 06:05 1a turns east while 2a turns north across 1a's lane. Drawn 40
// times a tick:
// - no two bus bodies (1.45 x 0.42 tiles) overlap in any frame, and the junction pairs get through
// - no bus jumps: no step from one frame to the next is over 0.2 tiles (the most a bus covers is about 0.13,
//   catching up after a wait; a lane change at a corner swings across instead of jumping 0.33)
// - a fresh view whose first frame has two buses on one tile (tick 0: 1a and 2a both at (3, 25)) draws them
//   apart from that frame on
async function runBuses(browser) {
  const rows = busRows(360, 41), first = busRows(0, 3);
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0&hud=0&minimap=0&zoom=1&at=4,24");
  const r = await page.evaluate(([rows, first]) => {
    const v = __view;
    v.stop();
    const SUB = 40, ext = d => d % 2 === 0 ? [0.725, 0.21] : [0.21, 0.725];
    const out = { overlap: -Infinity, worst: null, step: 0, stepAt: null, frames: 0, first: -Infinity, junction: {}, firstRows: null };
    const run = (list, tick0, base) => {
      const last = {};
      for (let k = 0; k < list.length; k++) {
        const st = __t.quiet(base + k), t = 2e7 + base * 417 + k * 417;
        st.buses = list[k];
        __t.pushAt(st, t);
        for (let j = 0; j < SUB; j++) {
          v.frame(t + j * 417 / SUB);
          out.frames++;
          const bs = v.scene().movers.filter(m => m.kind === "bus").map(m => ({ id: m.id, d: m.lights, p: v.scene().proj.toTile(m.cx, m.cy) }));
          for (const b of bs) {
            if (last[b.id]) { const d = Math.hypot(b.p[0] - last[b.id][0], b.p[1] - last[b.id][1]); if (d > out.step) { out.step = d; out.stepAt = [tick0 + k, j, b.id]; } }
            last[b.id] = b.p;
            if (Math.abs(b.p[0] - 3.5) < 0.6 && Math.abs(b.p[1] - 25.5) < 0.6) out.junction[b.id] = true;
          }
          for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++) {
            const A = bs[a], B = bs[b], ea = ext(A.d), eb = ext(B.d);
            const ov = Math.min(ea[0] + eb[0] - Math.abs(A.p[0] - B.p[0]), ea[1] + eb[1] - Math.abs(A.p[1] - B.p[1]));
            if (tick0 === 0) out.first = Math.max(out.first, ov);
            else if (ov > out.overlap) { out.overlap = ov; out.worst = [tick0 + k, j, A.id, B.id]; }
          }
        }
      }
    };
    run(rows, 360, 3000);
    // a page load on a minute when two buses stand on one tile: a new town (new movers), tick 0 first
    v.setTown(window.CITY_FIXTURE.town);
    out.firstRows = first[0].filter(b => b.x === 3 && b.y === 25).map(b => b.id);
    run(first, 0, 4000);
    return out;
  }, [rows, first]);
  check(r.frames === 41 * 40 + 3 * 40, "buses: every frame drawn", r.frames);
  check(r.overlap <= 0, "buses: on the real timetable no two buses overlap in any frame (the 06:05 turns at Willow Lane and Main Street included)", { overlap: r.overlap, at: r.worst });
  check(["1a", "2a", "1d", "2d", "1c", "2c"].every(id => r.junction[id]), "buses: the line 1 and line 2 buses that meet at (3, 25) all go through it", Object.keys(r.junction));
  check(r.step <= 0.2, "buses: no bus jumps from one frame to the next (0.2 tiles at most, 40 frames a tick)", { step: r.step, at: r.stepAt });
  check(r.firstRows.length === 2 && r.first <= 0, "buses: two buses on one tile on a fresh view's first frame are drawn apart", { onTile: r.firstRows, overlap: r.first });
  noErrors(log, "buses");
  await ctx.close();
}

// Night (review ART-2): headlight cones are cut by the buildings nearer the camera, like the lamp pools. A
// car and a bus driving west behind the Savings Bank leave the bank's roof and walls as they are; a car in
// an open street still lights the road ahead.
async function runNight(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0&hud=0&minimap=0&zoom=2&at=46,27&minute=180");
  const r = await page.evaluate(() => {
    const v = __view, s = v.scene();
    v.stop();
    const frame = (on, k) => {
      const st = __t.quiet(7000 + k);
      if (on) {
        Object.assign(st.agents.find(a => a.id === "ben"), { x: 47 - k, y: 25, inside: null, vehicle: "car", state: "travelling", activity: "commute" });
        Object.assign(st.agents.find(a => a.id === "yossi"), { x: 47 + k, y: 36, inside: null, vehicle: "car", state: "travelling", activity: "commute" });
        st.buses = [{ id: "2c", line: "2", x: 50 - k, y: 25, dir: "w", at_stop: null, riders: 3 }];
      }
      return st;
    };
    const T = 1e7 + 417 + 400;
    __t.pushAt(frame(true, 0), 1e7); __t.pushAt(frame(true, 1), 1e7 + 417);
    v.frame(T); __t.warm(); v.frame(T);
    const rec = s.buildingOf("bank"), z = s.cam.zoom * s.dpr, c = __t.spriteRect("bank");
    const bank = () => __t.grab(c[0], c[1], rec.b.c.width * z / s.dpr, rec.b.c.height * z / s.dpr);
    const road = () => { const a = v.cssOfTile(49.5, 36.5); return __t.grab(a[0] - 40, a[1] - 24, 80, 48); };
    const lit = s.movers.filter(m => m.lights != null && m.moving).map(m => m.id).sort();
    const a = bank(), ra = road();
    __t.pushAt(frame(false, 2), 1e7 + 2 * 417);
    v.frame(T);
    const b = bank(), rb = road();
    // the bank's own pixels (its sprite's opaque ones) that the vehicles' lights changed
    const mask = rec.b.c.getContext("2d").getImageData(0, 0, rec.b.c.width, rec.b.c.height).data;
    let n = 0, tot = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const fx = Math.floor(x / z), fy = Math.floor(y / z);
      if (fx >= rec.b.c.width || fy >= rec.b.c.height || mask[(fy * rec.b.c.width + fx) * 4 + 3] < 200) continue;
      tot++;
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) > 6 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 6 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 6) n++;
    }
    return { lit, bank: n, of: tot, road: __t.changed(ra, rb, 10), night: s.nightAlpha(s.minute) };
  });
  check(r.night === 1 && JSON.stringify(r.lit) === JSON.stringify(["2c", "ben", "yossi"]), "night: it is night and three vehicles have their lights on", r);
  check(r.of > 10000 && r.bank <= 10, "night: headlights behind the Savings Bank never light its roof or walls", r);
  check(r.road > 300, "night: a car in an open street still lights the road ahead", r.road);
  await shot(page, "night");
  noErrors(log, "night");
  await ctx.close();
}

// The ticker (review ART-4): client/index.html marks the dashboard's #ticker data-cv-avoid, so name plates
// and badges keep clear of it. The ticker is copied from index.html into the dev page, bottom-left as the
// dashboard places it; a camera sweep records every label drawn and none lands under it (and, as a control,
// the same sweep with the mark taken off does put labels there).
async function runTicker(browser) {
  const html = fs.readFileSync(path.join(CLIENT, "index.html"), "utf8");
  const tag = (html.match(/<div\s+id="ticker"[^>]*>/) || [""])[0];
  check(!!tag, "ticker: client/index.html has #ticker", tag);
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0");
  await page.evaluate(tag => {
    document.getElementById("world").insertAdjacentHTML("beforeend", tag + "</div>");
    const t = document.getElementById("ticker");
    t.style.cssText = "position:absolute;left:8px;bottom:8px;z-index:5;width:560px;height:34px;background:rgba(20,24,34,.8)";
  }, tag);
  const sweep = () => page.evaluate(async () => {
    const v = __view, s = v.scene(), g = document.getElementById("map").getContext("2d"), k = s.dpr;
    v.stop();
    await new Promise(res => setTimeout(res, 300));
    v.frame(); // takes in the page's marked elements (refreshed every 250 ms)
    const r = document.getElementById("ticker").getBoundingClientRect(), cr = document.getElementById("map").getBoundingClientRect();
    const box = [(r.left - cr.left) * k, (r.top - cr.top) * k, (r.right - cr.left) * k, (r.bottom - cr.top) * k];
    const orig = g.fillText;
    let all = 0, under = [];
    g.fillText = function (text, x, y) { all++; if (x >= box[0] && x <= box[2] && y >= box[1] - 6 * k && y <= box[3] + 6 * k) under.push(text); return orig.apply(this, arguments); };
    try {
      for (const zoom of [1, 1.5, 2]) for (let ty = 4; ty < 50; ty += 3) for (let tx = 4; tx < 80; tx += 4) { v.setCamera({ x: tx, y: ty, zoom }); v.frame(performance.now()); }
    } finally { g.fillText = orig; }
    return { all, under: under.length, sample: [...new Set(under)].slice(0, 6) };
  });
  const marked = await sweep();
  check(/\bdata-cv-avoid\b/.test(tag) && marked.all > 500 && marked.under === 0, "ticker: no name plate or badge is drawn under the ticker", { tag, marked });
  await page.evaluate(() => document.getElementById("ticker").removeAttribute("data-cv-avoid"));
  const bare = await sweep();
  check(bare.under > 0, "ticker: (control) without the mark the same sweep does draw labels there", bare);
  noErrors(log, "ticker");
  await ctx.close();
}

// The plane (review ART-7): outlined dark so it reads as a craft overhead over pale roofs, at its altitude.
async function runPlane(browser) {
  const { ctx, page, log } = await open(browser, "?persist=0&drive=0&follow=0&dyn=0&hud=0&minimap=0&zoom=1");
  const r = await page.evaluate(() => {
    const v = __view, s = v.scene(), spr = s.art.plane().c, d = spr.getContext("2d").getImageData(0, 0, spr.width, spr.height).data, W = spr.width, H = spr.height;
    // every opaque pixel on the sprite's edge is dark
    const A = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? 0 : d[(y * W + x) * 4 + 3];
    let edge = 0, light = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (A(x, y) < 200 || Math.min(A(x - 1, y), A(x + 1, y), A(x, y - 1), A(x, y + 1)) >= 40) continue;
      edge++;
      const i = (y * W + x) * 4;
      if (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] >= 90) light++;
    }
    // over the city at zoom 1 (over a bus shelter, as the review saw it), 420 px up
    v.stop();
    const prog = 0.583, tx = -12 + prog * 104, ty = 20 + prog * 10, top = s.proj.toWorld(tx, ty, 420);
    const c = v.cam(); c.x = top[0]; c.y = top[1]; c.zoom = 1;
    const st = __t.quiet(9000);
    __t.pushAt(st, 1e7); __t.warm(); v.frame(1e7 + 100);
    const at = s.worldToCss(top[0], top[1]), grab = () => __t.grab(at[0] - 40, at[1] - 30, 80, 60);
    const a = grab();
    const st2 = __t.quiet(9001); st2.plane = { progress: prog, flight: "08:00 Riverton to Lakeside" };
    __t.pushAt(st2, 1e7 + 417); v.frame(1e7 + 500);
    const b = grab();
    let dark = 0, changed = 0, sx = 0, sy = 0;
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) < 30) continue;
      changed++; sx += x; sy += y;
      if (0.3 * b.data[i] + 0.59 * b.data[i + 1] + 0.11 * b.data[i + 2] < 70) dark++;
    }
    return { edge, light, changed, dark, centre: changed ? [sx / changed - 40, sy / changed - 30].map(q => +q.toFixed(1)) : null };
  });
  check(r.edge > 50 && r.light === 0, "plane: the sprite has a dark outline all round", r);
  check(r.changed > 300 && r.dark > 60, "plane: over the city at zoom 1 it is drawn with its dark outline", r);
  check(r.centre && Math.abs(r.centre[0]) < 8 && Math.abs(r.centre[1]) < 8, "plane: it flies at its altitude (420 world px up)", r.centre);
  noErrors(log, "plane");
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
  // the minimap's Homes colours are the dashboard's Condition colours (review H6): its legend and the homes
  // drawn on it, zoomed out to 0.5 where it colours them by itself
  await page.waitForFunction(() => !devView.cam().busy(), null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const box = document.querySelector(".cv-minimap");
    if (box && box.classList.contains("cv-collapsed")) box.querySelector(".cv-minimap-toggle").click();
    devView.setCamera({ zoom: 0.5 });
  });
  await page.waitForTimeout(700);
  const mm = await page.evaluate(() => {
    const ramp = Dash.RAMPS.condition, s = devView.scene(), box = document.querySelector(".cv-minimap");
    const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const swatches = [...box.querySelectorAll(".cv-minimap-swatch")].map(e => getComputedStyle(e).backgroundColor);
    const c = box.querySelector(".cv-minimap-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const px = ramp.map(h => { const [r, g, b] = rgb(h); let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) <= 6) n++; return n; });
    const stages = [...new Set(s.town.places.filter(p => p.kind === "home").map(p => (s.looks[p.id] || {}).stage | 0))].sort();
    return { ramp, want: ramp.map(h => `rgb(${rgb(h).join(", ")})`), swatches, px, stages, homes: box.classList.contains("cv-homes"), zoom: devView.camera().zoom };
  });
  check(JSON.stringify(mm.swatches) === JSON.stringify(mm.want), "dashboard: the minimap's legend uses the dashboard's Condition colours", mm);
  check(mm.homes && mm.stages.length >= 3 && mm.stages.every(k => mm.px[k] > 0), "dashboard: the minimap draws each home stage in the dashboard's Condition colour", mm);
  noErrors(log, "dashboard with the real view");
  await ctx.close();
}

const RUNS = [["globals", runGlobals], ["bench", runBench], ["picking", runPicking], ["facade", runFacade], ["stages", runStages],
  ["persist", runPersist], ["old town", runOldTown], ["phone", runPhone], ["rotation", runRotation], ["long task", runLongTask],
  ["movers", runMovers], ["buses", runBuses], ["night", runNight], ["ticker", runTicker], ["plane", runPlane], ["dashboard", runDashboard]];

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
