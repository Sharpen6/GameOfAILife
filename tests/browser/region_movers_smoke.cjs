#!/usr/bin/env node
// Headless smoke test for the v3 view's movers on the region (view.md 8, checks 8-13; V1b):
//
//   node tests/browser/region_movers_smoke.cjs
//
// It serves client/ on 127.0.0.1 with an in-memory page that loads the view's scripts, client/dev/region_data.js
// and the stub host client/dev/region_stub.js (frames every 50 ms, a tick every 417 ms / speed), and checks in
// headless Chromium:
//  8. crowd: at zoom 0.5 debug().crowdDrawn equals the crowd whose shown foot point is in the view; at speed 1 a
//     walker's shown position changes on >= 90% of the frames between two ticks; 8 people on one tile give 8
//     pick targets; >= 150 people drawn at the default view (1/4 at 85, 48) at 08:00; at far zoom people are
//     dots (no sprites) when the scene has levels of detail; at 2 ticks a frame a car 16 tiles on glides
//  9. trains: every car centre within 0.3 tiles of its track (speed 16); a train stands still while it stays at
//     a station; it snaps on a track change and when i drops; its cars sit at i, i-1, ... (car k at s - k);
//     at 2 ticks a frame (speed 16) a train running 13 to 24 tiles glides, no snap
// 10. bridges and crossings: a named car, a folk car and a walker each ease over a b tile and an x tile with no
//     jump between frames
// 11. pings: one talk event shows one bubble for 3 s; 30 events in a frame show 20; none at far zoom; talks rows
//     (indoor folk rows too) draw over their buildings; at one place the first row (named first, newest first) wins
// 12. navigation: focus({district}) lands within 2 tiles of its centre; focus({station}) on the station;
//     districts() and stations() list every district and station; a folk pick returns {kind: "agent",
//     id: "f...", folk: true}; a train pick returns {kind: "train", id, line, riders}
//     minimap: 240 x 120 on the region, the by-kind base in <= 10 ms (gated only at load <= 8), trains as dots in
//     their line colour, folk as 1 px dots, hover names the district, a click recentres, a double-click flies
//     there at zoom 0.5
//     Go to (G) lists Millbrook, every district and station and flies there; M shows Millbrook at 0.5; T draws
//     the Transit layer; track() follows a townsperson indoors and outlines the building
// 13. no Math.random in client/view/*.js
// Timings (frame gaps) are reported with the load, never gated here (PLAN 6). Set VIEW_SHOTS=<folder> to save
// screenshots (default view at 08:00, a station with a train, far view).
//
// Playwright is looked for as a local module, then in the global node_modules. Without it, or without a
// browser it can launch, the test prints SKIP and exits 0.
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const CLIENT = path.join(REPO, "client");
const SHOTS = process.env.VIEW_SHOTS || "";
const VIEW_SCRIPTS = ["proj", "art", "buildings", "towers", "rail_art", "actors", "region", "lod", "lowart", "scene", "movers", "crowd", "trains", "pings", "camera", "minimap", "view"];

function findPlaywright() {
  const tries = ["playwright"];
  try {
    const root = require("child_process").execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString().trim();
    if (root) tries.push(path.join(root, "playwright"));
  } catch (e) { /* no npm */ }
  tries.push("/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright");
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  return null;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>region movers</title>
<link rel="stylesheet" href="/view/view.css">
<style>html, body { margin: 0; height: 100%; background: #11151d; overflow: hidden; } #w { position: fixed; inset: 0; } #c { width: 100%; height: 100%; }</style>
</head><body><div id="w"><canvas id="c"></canvas></div>
${VIEW_SCRIPTS.map(n => `<script src="/view/${n}.js"></script>`).join("\n")}
<script src="/dev/region_data.js"></script>
<script src="/dev/region_stub.js"></script>
<script>
"use strict";
(function () {
  const q = new URLSearchParams(location.search);
  const stub = RegionStub(window.REGION, { named: [] });
  const calls = window.__calls = { pick: [] };
  const view = CityView.create(document.getElementById("c"), { onPick(h) { calls.pick.push(h); } },
    { persist: false, dynamicResolution: false, minimap: q.get("minimap") !== "0" });
  view.setTown(stub.town);
  let speed = +(q.get("speed") || 1), tick = (+(q.get("day") || 1)) * 1440 + (+(q.get("minute") || 480)), acc = 0;
  let drive = q.get("drive") !== "0";
  const push = t => { const f = stub.frame(t); window.__last = f; view.setState(f.state, speed, f.events); };
  push(tick);
  view.setCamera({ x: +(q.get("x") || 85), y: +(q.get("y") || 48), zoom: +(q.get("zoom") || 0.25) });
  view.start();
  // like the server: a frame whenever at least one game minute has passed
  setInterval(() => { if (!drive) return; acc += 50 * speed; let moved = false; while (acc >= 417) { tick++; acc -= 417; moved = true; } if (moved) push(tick); }, 50);
  window.__view = view; window.__stub = stub;
  window.__tick = () => tick;
  window.__setTick = t => { tick = t; push(t); };
  window.__speed = s => { speed = s; };
  window.__drive = on => { drive = !!on; };
  window.__push = (st, evs) => view.setState(st, speed, evs || []);
  // the state the stub sends for a tick, with the crowd and trains of the caller's choosing
  window.__frameAt = t => stub.state(t);
  // frames: n animation frames, each running fn(now) after the view drew
  window.__frames = (n, fn) => new Promise(res => { const out = []; const step = now => { out.push(fn(now)); if (out.length < n) requestAnimationFrame(step); else res(out); }; requestAnimationFrame(step); });
})();
</script></body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch (e) { rel = "/"; }
    if (rel === "/__movers.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(PAGE); return; }
    const file = path.join(CLIENT, path.normalize(rel).replace(/^[/\\]+/, ""));
    if (!file.startsWith(CLIENT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0, passes = 0;
const notes = [];
function check(ok, what, detail) {
  if (ok) { passes += 1; return true; }
  failures += 1;
  console.log(`  FAIL ${what}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return false;
}
const note = s => { notes.push(s); console.log(`  ${s}`); };

let BASE = "";
async function open(browser, query, o) {
  o = o || {};
  const ctx = await browser.newContext({ viewport: o.size || { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const log = { errors: [] };
  page.on("console", m => { if (m.type() === "error") log.errors.push(m.text()); });
  page.on("pageerror", e => log.errors.push(String((e && e.message) || e)));
  await page.goto(`${BASE}/__movers.html?${query || ""}`);
  await page.waitForFunction(() => window.__view && __view.scene() && __view.scene().stats.frames > 2, null, { timeout: 30000 });
  return { ctx, page, log };
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const noErrors = (log, what) => check(log.errors.length === 0, `${what}: no console errors`, log.errors.slice(0, 5));

// --- 8. crowd ----------------------------------------------------------------------------------------------
async function runCrowd(browser) {
  console.log("crowd");
  // the default view at 08:00: >= 150 drawn
  let { ctx, page, log } = await open(browser, "zoom=0.25&x=85&y=48&minute=480&drive=0");
  await page.waitForTimeout(600);
  let d = await page.evaluate(() => __view.debug());
  check(d.crowdDrawn >= 150, "crowd: >= 150 people drawn at the default view at 08:00", d.crowdDrawn);
  note(`default view 08:00: crowd ${d.crowd}, drawn ${d.crowdDrawn} (lod ${d.lod})`);
  await shot(page, "default_0800");
  // at zoom 0.5 crowdDrawn equals the crowd in view (computed here from the shown positions)
  await page.evaluate(() => __view.setCamera({ x: 126, y: 64, zoom: 0.5 }));
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => __frames(3, () => {
    const K = __view.crowd(), sc = __view.scene(), v = sc.view(), st = __last.state;
    let inView = 0;
    for (let k = 0; k < st.crowd.length; k += 4) {
      const p = K.pos(st.crowd[k]);
      if (!p) continue;
      const w = sc.proj.toWorld(p[0], p[1]);
      if (w[0] >= v.x0 && w[0] <= v.x1 && w[1] >= v.y0 && w[1] <= v.y1) inView++;
    }
    return { inView, drawn: __view.debug().crowdDrawn, lod: __view.lod() };
  }));
  const last = r[r.length - 1];
  check(last.inView > 0 && last.drawn === last.inView, "crowd: at 0.5 crowdDrawn equals the crowd in view", last);
  // 8 people on one tile: 8 pick targets
  await page.evaluate(() => __view.setCamera({ x: 126, y: 64, zoom: 2 }));
  const picks = await page.evaluate(async () => {
    const st = __frameAt(__tick());
    st.crowd = [];
    for (let i = 0; i < 8; i++) st.crowd.push(500 + i, 127, 62, 7);
    st.tick += 1;
    __push(st);
    await new Promise(r => setTimeout(r, 900));
    __push(Object.assign({}, st, { tick: st.tick + 1 }));
    await new Promise(r => setTimeout(r, 900));
    const out = [];
    for (let i = 0; i < 8; i++) { const c = __view.screenOf({ agent: "f" + (500 + i) }); const h = c && __view.pick(c[0], c[1]); out.push({ c, h }); }
    return out;
  });
  const ids = new Set(picks.map(p => p.h && p.h.id));
  check(ids.size === 8 && picks.every((p, i) => p.h && p.h.id === "f" + (500 + i) && p.h.folk === true && p.h.kind === "agent"),
    "crowd: 8 people on one tile give 8 pick targets", picks.map(p => p.h));
  check(JSON.stringify(picks[0].h) === JSON.stringify({ kind: "agent", id: "f500", folk: true }), "navigation: a folk pick returns {kind: agent, id: f..., folk: true}", picks[0].h);
  // a click on a person reaches onPick with that hit
  await page.mouse.click(picks[3].c[0], picks[3].c[1]);
  const clicked = await page.evaluate(() => __calls.pick[__calls.pick.length - 1]);
  check(clicked && clicked.id === "f503" && clicked.folk === true, "crowd: a click on a townsperson picks them", clicked);
  // speed 16 sends about 2 ticks a frame: a car 16 tiles on (highway speed, 8 tiles a tick) glides, no jump
  const car = await page.evaluate(async () => {
    const st = __frameAt(__tick()), K = __view.crowd();
    st.crowd = [600, 100, 62, 2]; st.tick += 10; __push(st);
    await __frames(2, () => 0);
    __push(Object.assign({}, st, { crowd: [600, 116, 62, 2], tick: st.tick + 2 }));
    return { p: K.pos(600, performance.now()) };
  });
  check(car.p && car.p[0] < 104, "crowd: at 2 ticks a frame (speed 16) a car 16 tiles on glides from where it was, no jump", car);
  // far: dots, no sprites (only when the scene has levels of detail)
  await page.evaluate(() => { __setTick(__tick() + 2); __view.setCamera({ x: 128, y: 96, zoom: 0.1 }); });
  await page.waitForTimeout(500);
  const far = await page.evaluate(() => ({ d: __view.debug(), lod: __view.lod(), sceneLod: typeof __view.scene().lod }));
  if (far.d.lod === "far" && far.sceneLod !== "undefined") check(far.d.crowdDrawn > 0 && far.d.crowdSprites === 0, "crowd: at far zoom people are dots", far.d);
  else note(`far zoom: the scene has no levels of detail yet (lod ${far.lod}, scene.lod ${far.sceneLod}); dots at far not checked`);
  await shot(page, "far");
  noErrors(log, "crowd");
  await ctx.close();

  // speed 1: a walker moves on >= 90% of the frames between two ticks
  ({ ctx, page, log } = await open(browser, "zoom=1&x=126&y=64&minute=480&speed=1"));
  await page.waitForTimeout(1500);
  const mv = await page.evaluate(async () => {
    const K = __view.crowd(), st0 = __last.state, walkers = [];
    for (let k = 0; k < st0.crowd.length; k += 4) if ((st0.crowd[k + 3] & 7) === 0) walkers.push(st0.crowd[k]);
    const samples = await __frames(150, now => ({ tick: __tick(), pos: walkers.slice(0, 60).map(i => K.pos(i)) }));
    // for each walker: the frames inside a tick (not the first frame of a tick) where it is moving between ticks
    let moved = 0, total = 0;
    for (let w = 0; w < Math.min(60, walkers.length); w++) {
      for (let f = 2; f < samples.length; f++) {
        const a = samples[f - 1], b = samples[f];
        if (a.tick !== b.tick || !a.pos[w] || !b.pos[w]) continue;
        // only walkers on a move: their position at the tick's start differs from the tile they head for
        const first = samples.findIndex(s => s.tick === b.tick), next = samples.findIndex(s => s.tick === b.tick + 1);
        if (first < 0 || next < 0 || !samples[first].pos[w] || !samples[next].pos[w]) continue;
        const d0 = Math.hypot(samples[next].pos[w][0] - samples[first].pos[w][0], samples[next].pos[w][1] - samples[first].pos[w][1]);
        if (d0 < 0.5) continue;
        total++;
        if (Math.hypot(b.pos[w][0] - a.pos[w][0], b.pos[w][1] - a.pos[w][1]) > 1e-4) moved++;
      }
    }
    return { moved, total, ticks: samples[samples.length - 1].tick - samples[0].tick, tickMs: __view.crowd().M.tickMs };
  });
  check(mv.total > 100 && mv.moved / mv.total >= 0.9, "crowd: at speed 1 a walker moves on >= 90% of the frames between two ticks", mv);
  note(`speed 1: walkers moved on ${mv.moved} of ${mv.total} frames (${(100 * mv.moved / Math.max(1, mv.total)).toFixed(1)}%), ${mv.ticks} ticks, tickMs ${mv.tickMs.toFixed(0)}`);
  noErrors(log, "crowd speed 1");
  await ctx.close();
}

// --- 9. trains -----------------------------------------------------------------------------------------------
async function runTrains(browser) {
  console.log("trains");
  let { ctx, page, log } = await open(browser, "zoom=0.5&x=127&y=67&minute=480&speed=16");
  await page.waitForTimeout(800);
  // every car centre within 0.3 tiles of its track, over 120 frames at speed 16
  const dev = await page.evaluate(() => __frames(120, () => {
    const T = __view.trains(), town = __view.scene().town;
    let worst = 0, n = 0;
    for (const r of T.rows()) {
      const l = town.rail.lines.find(q => q.id === r.line), pts = l.tracks[r.track].map(c => [c[0] + 0.5, c[1] + 0.5]);
      for (const c of T.carsOf(r.id)) {
        let best = Infinity;
        for (let k = 1; k < pts.length; k++) {
          const [ax, ay] = pts[k - 1], [bx, by] = pts[k], vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
          const t = L ? Math.max(0, Math.min(1, ((c.x - ax) * vx + (c.y - ay) * vy) / L)) : 0;
          best = Math.min(best, Math.hypot(c.x - (ax + vx * t), c.y - (ay + vy * t)));
        }
        worst = Math.max(worst, best); n++;
      }
    }
    return { worst, n, want: town.rail.lines.reduce((s, l) => s + l.trains.length * l.cars, 0) };
  }));
  const worst = Math.max(...dev.map(d => d.worst)), cars = dev[0].n, want = dev[0].want;
  // every train's cars (the lines' trains x cars: 10 trains x 2 cars since stage 5's shorter trains)
  check(cars === want && want === 20 && worst <= 0.3, "trains: every car centre within 0.3 tiles of its track (10 trains x their cars, 120 frames)", { worst, cars, want });
  await ctx.close();

  ({ ctx, page, log } = await open(browser, "zoom=1&x=127&y=67&minute=480&drive=0"));
  // a station stand: R line at central (out i 91): the tick it arrives, then the dwell tick with the same i
  const still = await page.evaluate(async () => {
    const cyc = __stub.railCycle("R");
    // the first dwell minute in the cycle: an entry with doors open whose previous entry has the same i
    let m = cyc.findIndex((c, k) => k > 0 && c[3] && cyc[k - 1][1] === c[1] && cyc[k - 1][0] === c[0] && cyc[k - 1][3]);
    const base = 1440 + 600 - ((1440 + 600) % 60); // a tick with (tick + 0 * every) % 60 === 0: train R1 at cycle[m]
    const t0 = base + m - 1;
    __setTick(t0);
    await new Promise(r => setTimeout(r, 700));
    __setTick(t0 + 1);
    const row = __view.trains().rows().find(r => r.id === "R1");
    const ss = await __frames(20, () => __view.trains().sOf("R1"));
    return { at: row.at_station, i: row.i, min: Math.min(...ss), max: Math.max(...ss) };
  });
  check(still.at && Math.abs(still.max - still.min) < 1e-9 && Math.abs(still.min - still.i) < 1e-9, "trains: a train stands still while it stays at a station", still);
  // speed 16 sends about 2 ticks a frame: a train that runs 13 to 24 tiles between two frames glides, no snap
  const glide = await page.evaluate(() => {
    const T = __view.trains(), base = 1440 + 480;
    let moves = 0, snaps = 0;
    for (let t = base; t < base + 240; t += 2) {
      __setTick(t);
      const before = new Map(T.rows().map(r => [r.id, { track: r.track, i: r.i }]));
      __setTick(t + 2);
      const now = performance.now();
      for (const r of T.rows()) {
        const b = before.get(r.id);
        if (!b || b.track !== r.track || r.i - b.i <= 12 || r.i - b.i > 24) continue;
        moves++;
        if (Math.abs(T.sOf(r.id, now) - r.i) < 1e-9) snaps++;
      }
    }
    return { moves, snaps };
  });
  check(glide.moves > 0 && glide.snaps === 0, "trains: at 2 ticks a frame (speed 16) a train running 13 to 24 tiles glides, no snap", glide);
  // cars at i, i-1, ... (one per car of the line) once settled
  const settled = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 700));
    const T = __view.trains(), row = T.rows().find(r => r.id === "R1"), l = __view.scene().town.rail.lines[0];
    const pl = CityView.railPolyline(l.tracks[row.track]);
    return { cars: l.cars, d: T.carsOf("R1").map((c, k) => { const p = CityView.railPointAt(pl, row.i - k); return Math.hypot(c.x - p.x, c.y - p.y); }) };
  });
  check(settled.d.length === settled.cars && settled.cars >= 2 && settled.d.every(d => d < 1e-6), "trains: car k sits at s - k (cars at i, i-1, ...)", settled);
  // snaps: a track change, and i dropping
  const snaps = await page.evaluate(async () => {
    const st = __frameAt(__tick() + 1), T = __view.trains();
    const r1 = st.trains.find(r => r.id === "R1");
    const other = r1.track === "out" ? "in" : "out";
    const a = Object.assign({}, r1, { track: other, i: 50 });
    __push(Object.assign({}, st, { trains: [a] }));
    const s1 = T.sOf("R1");
    await new Promise(r => setTimeout(r, 100));
    const b = Object.assign({}, a, { i: 30 });
    __push(Object.assign({}, st, { tick: st.tick + 1, trains: [b] }));
    const s2 = T.sOf("R1");
    await new Promise(r => setTimeout(r, 100));
    const c = Object.assign({}, b, { i: 45 }); // |di| > 12: snap
    __push(Object.assign({}, st, { tick: st.tick + 2, trains: [c] }));
    const s3 = T.sOf("R1");
    const dd = Object.assign({}, c, { i: 50 }); // a normal move: eases
    __push(Object.assign({}, st, { tick: st.tick + 3, trains: [dd] }));
    const s4 = T.sOf("R1");
    return { s1, s2, s3, s4 };
  });
  check(snaps.s1 === 50 && snaps.s2 === 30 && snaps.s3 === 45 && snaps.s4 >= 45 && snaps.s4 < 46, "trains: snap on a track change, an i drop and |di| > 12; ease otherwise", snaps);
  // a train pick
  await page.evaluate(() => __setTick(__tick() + 5));
  await page.waitForTimeout(900);
  const tp = await page.evaluate(() => {
    for (const r of __view.trains().rows()) {
      const c = __view.trains().carsOf(r.id)[1], css = __view.cssOfTile(c.x, c.y, 10);
      if (css[0] < 10 || css[1] < 10 || css[0] > 1270 || css[1] > 790) continue;
      const hits = __view.scene().pickAll(css[0], css[1]).upright, h = hits.find(x => x.kind === "train");
      if (h) return { h, id: r.id, riders: r.riders };
    }
    return null;
  });
  check(tp && tp.h.id === tp.id && tp.h.line && tp.h.riders === tp.riders && Object.keys(tp.h).join() === "kind,id,line,riders", "navigation: a train pick returns {kind: train, id, line, riders}", tp);
  // a station with a train, for the handoff
  await page.evaluate(() => { __setTick(1440 + 600 + 12); __view.setCamera({ x: 124, y: 70, zoom: 1.5 }); });
  await page.waitForTimeout(800);
  await shot(page, "station_train");
  noErrors(log, "trains");
  await ctx.close();
}

// --- 10. bridges and crossings --------------------------------------------------------------------------------
async function runBridges(browser) {
  console.log("bridges");
  const { ctx, page, log } = await open(browser, "zoom=1&x=81&y=40&minute=480&drive=0");
  const res = await page.evaluate(async () => {
    const R = __view.scene().town, tile = (x, y) => R.tiles[y][x];
    const out = {};
    // the road bridge on x = 81 (b at y 46-49) and the level crossing on x = 81 (x at y 32-33)
    const cases = { bridge: [81, 44, 81, 51, "b"], crossing: [81, 30, 81, 35, "x"] };
    for (const [name, [x0, y0, x1, y1, code]] of Object.entries(cases)) {
      const st = __frameAt(__tick());
      const named = { id: "tester", name: "Test Driver", x: x0, y: y0, inside: null, state: "travelling", activity: "commute", vehicle: "car",
        mood: 60, luck: 50, controller: null, alive: true, age: 40, home: null, car: true, riding: null };
      const base = Object.assign({}, st, { agents: [named], crowd: [700, x0, y0, 2, 701, x0, y0, 0], trains: [] });
      __push(Object.assign({}, base, { tick: st.tick + 1 }));
      await new Promise(r => setTimeout(r, 500));
      __push(Object.assign({}, base, { tick: st.tick + 2, agents: [Object.assign({}, named, { x: x1, y: y1 })], crowd: [700, x1, y1, 2, 701, x1, y1, 0] }));
      const sc = __view.scene();
      const frames = await __frames(40, () => {
        const r = __view.scene().moverById("tester"), f = r && r.foot ? sc.proj.toTile(r.foot[0], r.foot[1]) : null;
        return { named: f, car: __view.crowd().pos(700), walker: __view.crowd().pos(701) };
      });
      const res = {};
      for (const who of ["named", "car", "walker"]) {
        const ps = frames.map(f => f[who]).filter(Boolean);
        let maxStep = 0, over = false, back = false;
        for (let k = 1; k < ps.length; k++) {
          maxStep = Math.max(maxStep, Math.hypot(ps[k][0] - ps[k - 1][0], ps[k][1] - ps[k - 1][1]));
          if (ps[k][1] < ps[k - 1][1] - 1e-6) back = true;
        }
        for (const p of ps) if (tile(Math.floor(p[0]), Math.floor(p[1])) === code) over = true;
        res[who] = { n: ps.length, maxStep: +maxStep.toFixed(3), over, back, first: ps[0], last: ps[ps.length - 1] };
      }
      out[name] = res;
      __push(Object.assign({}, base, { tick: st.tick + 3, agents: [], crowd: [] }));
      await new Promise(r => setTimeout(r, 400));
    }
    return out;
  });
  for (const [name, r] of Object.entries(res)) for (const who of ["named", "car", "walker"]) {
    const q = r[who];
    check(q.n >= 20 && q.over && !q.back && q.maxStep < 0.75, `bridges: a ${who === "named" ? "named car" : who === "car" ? "folk car" : "walker"} eases over the ${name} (${name === "bridge" ? "b" : "x"} tile) without a jump`, q);
  }
  noErrors(log, "bridges");
  await ctx.close();
}

// --- 11. pings ------------------------------------------------------------------------------------------------
async function runPings(browser) {
  console.log("pings");
  const { ctx, page, log } = await open(browser, "zoom=0.5&x=40&y=25&minute=480&drive=0");
  await page.waitForTimeout(500);
  const one = await page.evaluate(async () => {
    const P = __view.pings(); P.clear();
    __view.events([{ seq: 900001, tick: __tick(), kind: "social", tag: "talk", importance: 0, major: false, text: "x", agent: "dana", agents: ["dana", "f12"], place: "cafe", at: [14, 24] }]);
    const t0 = performance.now(), out = [];
    for (const ms of [300, 2500, 3500]) { await new Promise(r => setTimeout(r, Math.max(0, t0 + ms - performance.now()))); await __frames(2, () => 0); out.push(__view.debug().pings); }
    return { counts: out, shown: P.shown() };
  });
  check(one.counts[0] === 1 && one.counts[1] === 1 && one.counts[2] === 0, "pings: one talk event shows one bubble for 3 s", one);
  const many = await page.evaluate(async () => {
    const P = __view.pings(); P.clear();
    const town = __view.scene().town, v = __view.scene().view(), proj = __view.scene().proj;
    // 30 places in view
    const ps = town.places.filter(p => p.kind !== "park").filter(p => { const w = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2); return w[0] > v.x0 + 40 && w[0] < v.x1 - 40 && w[1] > v.y0 + 80 && w[1] < v.y1 - 20; }).slice(0, 30);
    const evs = ps.map((p, k) => ({ seq: 910000 + k, tick: __tick(), kind: "social", tag: ["talk", "new_friend", "row", "flirt", "partner"][k % 5], importance: 0, agent: "f" + k, agents: ["f" + k, "f" + (k + 100)], place: p.id, at: p.entry }));
    __view.events(evs);
    await __frames(3, () => 0);
    const near = __view.debug().pings;
    __view.setCamera({ x: 40, y: 25, zoom: 0.1 });
    await __frames(3, () => 0);
    const far = __view.debug().pings;
    __view.setCamera({ x: 40, y: 25, zoom: 0.5 });
    return { places: ps.length, near, far };
  });
  check(many.places === 30 && many.near === 20, "pings: 30 events in a frame show 20", many);
  check(many.far === 0, "pings: none at far zoom", many);
  // talks rows: an indoor folk-only row draws over its building; an outdoor row between the two people
  const talks = await page.evaluate(async () => {
    const P = __view.pings(); P.clear();
    const town = __view.scene().town, st = __frameAt(__tick());
    const pi = town.places.findIndex(p => p.id === "cafe");
    st.crowd = [40, 14, 25, 7, 41, 15, 25, 7];
    st.talks = [[pi, "f300", "f301", 1, st.tick], [-1, "f40", "f41", 0, st.tick], [pi, "f300", "f301", 1, st.tick]];
    st.tick += 1;
    __push(st);
    await __frames(3, () => 0);
    return { n: __view.debug().pings, shown: P.shown() };
  });
  check(talks.n === 2 && talks.shown.some(s => s.place === "cafe" && s.a === "f300") && talks.shown.some(s => !s.place && s.a === "f40"),
    "pings: talks rows (an indoor folk row over its building, an outdoor one between two people), each once", talks);
  // the rows come named first, newest first (PLAN 2.10): at one place the first row wins
  const order = await page.evaluate(async () => {
    const P = __view.pings(), town = __view.scene().town, pi = town.places.findIndex(p => p.id === "cafe");
    const at = (rows, dt) => { P.clear(); const st = __frameAt(__tick()); st.talks = rows(st.tick); st.tick += dt; __push(st); };
    at(t => [[pi, "dana", "f1", 1, t], [pi, "f2", "f3", 0, t]], 2);
    await __frames(3, () => 0);
    const named = P.shown().filter(s => s.place === "cafe").map(s => s.a);
    at(t => [[pi, "f8", "f9", 0, t], [pi, "f4", "f5", 0, t - 7]], 3);
    await __frames(3, () => 0);
    const newest = P.shown().filter(s => s.place === "cafe").map(s => s.a);
    return { named, newest };
  });
  check(order.named.join() === "dana" && order.newest.join() === "f8",
    "pings: talks rows at one place: the first row (named first, newest first) is the one shown", order);
  // a birth: a glow with confetti and a stork, which move from frame to frame; a wedding: rings and confetti
  const party = await page.evaluate(async () => {
    const P = __view.pings(); P.clear();
    const c = document.getElementById("c"), g = c.getContext("2d");
    __view.events([{ seq: 920001, tick: __tick(), kind: "life", tag: "birth", importance: 2, agents: ["f500"], place: "cafe" },
      { seq: 920002, tick: __tick(), kind: "social", tag: "wedding", importance: 2, agents: ["f40", "f41"], place: "park" }]);
    await __frames(3, () => 0);
    const box = () => { const d = g.getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4 * 61) h = (h * 33 + d[i] + d[i + 1]) >>> 0; return h; };
    const a = box();
    await new Promise(r => setTimeout(r, 400));
    await __frames(2, () => 0);
    return { shown: P.shown().map(s => s.tag), moved: a !== box() };
  });
  check(party.shown.includes("birth") && party.moved, "pings: a birth's glow, confetti and stork animate", party);
  if (SHOTS) await shot(page, "pings_birth");
  await page.evaluate(() => { __view.pings().clear(); __drive(true); });
  await page.waitForTimeout(2500);
  const live = await page.evaluate(() => __view.debug().pings);
  note(`pings from the stub's talks and events at Millbrook 0.5: ${live} on screen`);
  noErrors(log, "pings");
  await ctx.close();
}

// --- 12. navigation -----------------------------------------------------------------------------------------
async function runNavigation(browser) {
  console.log("navigation");
  const { ctx, page, log } = await open(browser, "zoom=0.25&x=85&y=48&minute=480");
  const nav = await page.evaluate(async () => {
    const ds = __view.districts(), ss = __view.stations(), town = __view.scene().town, out = { districts: ds.length, stations: ss.length, off: [] };
    out.allDistricts = town.districts.every(d => ds.some(q => q.id === d.id));
    out.allStations = town.rail.lines.every(l => l.stations.every(s => ss.some(q => q.id === s.id && q.line === l.id)));
    for (const d of ds.slice(0, 4)) {
      __view.focus({ district: d.id });
      await new Promise(r => setTimeout(r, 1100));
      const c = __view.camera();
      out.off.push(+Math.hypot(c.x - d.center[0], c.y - d.center[1]).toFixed(2));
    }
    const s = ss.find(q => q.id === "central_station");
    __view.focus({ station: s.id });
    await new Promise(r => setTimeout(r, 1100));
    const c = __view.camera();
    out.station = +Math.hypot(c.x - s.x, c.y - s.y).toFixed(2);
    // a long fly: frame gaps (reported)
    __view.setCamera({ x: 20, y: 20, zoom: 1 });
    const gaps = []; let prev = 0;
    __view.focus({ station: "willow_hills_station" });
    await __frames(60, now => { if (prev) gaps.push(now - prev); prev = now; });
    gaps.sort((a, b) => a - b);
    out.flyMax = +gaps[gaps.length - 1].toFixed(1); out.flyMedian = +gaps[gaps.length >> 1].toFixed(1);
    __view.focus({ line: "S" });
    await new Promise(r => setTimeout(r, 1100));
    out.line = __view.camera();
    return out;
  });
  check(nav.allDistricts && nav.allStations && nav.stations >= 10, "navigation: districts() and stations() list every district and station", nav);
  check(nav.off.length === 4 && nav.off.every(d => d <= 2), "navigation: focus({district}) lands within 2 tiles of its centre", nav.off);
  check(nav.station <= 1, "navigation: focus({station}) lands on the station", nav.station);
  check(nav.line && nav.line.zoom < 0.5, "navigation: focus({line}) shows the whole line", nav.line);
  note(`long fly frame gaps: median ${nav.flyMedian} ms, max ${nav.flyMax} ms (report only; load ${os.loadavg()[0].toFixed(1)})`);
  // layers persist in goal.view when persistence is on (here off): the setter and reader agree
  const layers = await page.evaluate(() => { __view.setLayers({ pings: false, transit: true }); const a = __view.layers(); __view.setLayers({ pings: true, transit: false }); return a; });
  check(layers.pings === false && layers.transit === true && layers.labels === true, "navigation: setLayers and layers()", layers);
  noErrors(log, "navigation");
  await ctx.close();
}

// --- 12c. Go to, M, Transit, track ------------------------------------------------------------------------------
async function runGoto(browser) {
  console.log("go to, transit, track");
  const { ctx, page, log } = await open(browser, "zoom=0.25&x=85&y=48&minute=480");
  // Go to (G): Millbrook, every district, every station; a click flies there
  await page.keyboard.press("g");
  await page.waitForTimeout(150);
  const list = await page.evaluate(() => {
    const box = document.querySelector(".cv-goto"), items = [...box.querySelectorAll("[data-go]")].map(b => b.dataset.go);
    const ds = __view.districts().map(d => "district:" + d.id), ss = [...new Set(__view.stations().map(s => "station:" + s.id))];
    const r = box.getBoundingClientRect();
    return { open: box.classList.contains("cv-open"), millbrook: items.includes("millbrook:"), districts: ds.every(d => items.includes(d)),
      stations: ss.every(s => items.includes(s)), n: items.length, want: 1 + ds.length + ss.length, inside: r.top >= 0 && r.bottom <= innerHeight + 1 };
  });
  check(list.open && list.millbrook && list.districts && list.stations && list.n === list.want, "go to: G lists Millbrook, every district and every station", list);
  check(list.inside, "go to: the list is inside the window", list);
  const pick = await page.evaluate(() => { const s = __view.stations().find(q => q.id === "central_station") || __view.stations()[0]; return s; });
  await page.click(`.cv-goto [data-go="station:${pick.id}"]`);
  await page.waitForTimeout(1100);
  const c1 = await page.evaluate(() => __view.camera());
  check(Math.hypot(c1.x - pick.x, c1.y - pick.y) <= 1 && !(await page.evaluate(() => document.querySelector(".cv-goto").classList.contains("cv-open"))),
    "go to: a station item flies there and closes the list", { cam: c1, want: [pick.x, pick.y] });
  // M: Millbrook at zoom 0.5
  await page.keyboard.press("m");
  await page.waitForTimeout(1100);
  const c2 = await page.evaluate(() => __view.camera());
  check(Math.hypot(c2.x - 40, c2.y - 25) <= 1 && Math.abs(c2.zoom - 0.5) < 0.02, "keys: M shows Millbrook at zoom 0.5", c2);
  // T: the Transit layer draws over the map, and the View menu shows it on
  const tr = await page.evaluate(async () => {
    const d = () => { const c = document.getElementById("c"), x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < x.length; i += 997) h = (h * 31 + x[i]) >>> 0; return h; };
    __drive(false);
    await new Promise(r => setTimeout(r, 300));
    __view.setCamera({ x: 112, y: 50, zoom: 0.25 });
    await new Promise(r => setTimeout(r, 1500));
    const a = d();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    await new Promise(r => setTimeout(r, 300));
    const b = d(), on = __view.layers().transit;
    const shapes = __view.trains().drawTransit(document.getElementById("c").getContext("2d"), __view.stations());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    return { changed: a !== b, on, off: __view.layers().transit, shapes };
  });
  check(tr.on && !tr.off && tr.changed && tr.shapes >= 10, "keys: T switches the Transit layer (tracks and station rings over the map)", tr);
  // track(): a townsperson the map does not show is followed to where the host says, and outlined inside
  const tk = await page.evaluate(async () => {
    const st = __frameAt(__tick() + 1);
    const c = st.crowd, out = [];
    for (let k = 0; k + 3 < c.length; k += 4) if (c[k] !== 417) out.push(c[k], c[k + 1], c[k + 2], c[k + 3]);
    st.crowd = out;
    __push(st);
    const p = __view.scene().town.places.find(q => q.kind === "cafe");
    __view.track("f417", { x: p.x + 1, y: p.y + 1, inside: true });
    __view.select("f417", { follow: true });
    await new Promise(r => setTimeout(r, 1200));
    const cam = __view.camera(), hl = __view.scene().highlight;
    const res = { cam, want: [p.x + 1.5, p.y + 1.5], outlined: !!(hl && hl.places.includes(p.id)) };
    __view.track("f417", null); __view.select(null);
    res.cleared = !(__view.scene().highlight && __view.scene().highlight.places.includes(p.id));
    return res;
  });
  check(Math.hypot(tk.cam.x - tk.want[0], tk.cam.y - tk.want[1]) <= 1 && tk.outlined && tk.cleared, "track(): follow goes indoors to the tracked place and outlines it", tk);
  noErrors(log, "go to");
  await ctx.close();
}

// --- 12b. minimap ----------------------------------------------------------------------------------------------
async function runMinimap(browser) {
  console.log("minimap");
  const { ctx, page, log } = await open(browser, "zoom=0.5&x=85&y=48&minute=480&speed=4");
  await page.waitForTimeout(600);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.locator(".cv-minimap").screenshot({ path: path.join(SHOTS, "minimap.png") }); }
  const m = await page.evaluate(async () => {
    const mini = __view.minimap(), c = mini.canvas, r = c.getBoundingClientRect(), out = { w: r.width, h: r.height };
    const ms = [];
    for (let k = 0; k < 3; k++) { mini.rebuild(); mini.draw(performance.now(), true); ms.push(mini.stats().buildMs); }
    out.buildMs = +Math.min(...ms).toFixed(2);
    const g = c.getContext("2d"), px = () => g.getImageData(0, 0, c.width, c.height).data;
    __drive(false);
    await new Promise(res => setTimeout(res, 300));
    mini.draw(performance.now(), true);
    const withFolk = px();
    // trains: the head car's pixel is the line's colour
    const LC = CityView.LINE_COLORS, hex = v => "#" + [v[0], v[1], v[2]].map(n => n.toString(16).padStart(2, "0")).join("");
    const tr = __view.trains(), proj = __view.scene().proj;
    let trains = 0, onColour = 0;
    for (const row of tr.rows()) {
      const cs = tr.carsOf(row.id); if (!cs || !cs.length) continue;
      trains++;
      const w = proj.toWorld(cs[0].x, cs[0].y), p = mini.toMini(w[0], w[1]);
      const d = g.getImageData(Math.round(p[0]), Math.round(p[1]), 1, 1).data;
      if (hex(d) === LC[row.line[0]].toLowerCase()) onColour++;
    }
    out.trains = trains; out.onColour = onColour;
    // folk: the dots go when the crowd does
    const st = __frameAt(__tick() + 1); st.crowd = []; st.occ = undefined;
    __push(st);
    await new Promise(res => setTimeout(res, 700));
    mini.draw(performance.now(), true);
    const noFolk = px();
    let diff = 0; for (let i = 0; i < withFolk.length; i += 4) if (withFolk[i] !== noFolk[i] || withFolk[i + 1] !== noFolk[i + 1]) diff++;
    out.folkPixels = diff;
    // districts under their centres
    const ds = __view.districts(), town = __view.scene().town;
    out.districts = ds.length; out.named = 0; out.spots = [];
    for (const d of ds) {
      const w = proj.toWorld(d.center[0], d.center[1]), p = mini.toMini(w[0], w[1]), at = mini.districtAt(p[0], p[1]);
      if (at && at.id === d.id) out.named++;
      out.spots.push({ id: d.id, name: (town.districts.find(q => q.id === d.id) || {}).name, x: r.left + p[0], y: r.top + p[1], cx: d.center[0], cy: d.center[1] });
    }
    return out;
  });
  check(m.w === 240 && m.h === 120, "minimap: 240 x 120 CSS px on the region", [m.w, m.h]);
  const L = os.loadavg()[0];
  if (L <= 8) check(m.buildMs <= 10, "minimap: the by-kind base builds in 10 ms or less", `${m.buildMs} ms (load ${L.toFixed(1)})`);
  note(`minimap base build ${m.buildMs} ms (best of 3; load ${L.toFixed(1)}${L > 8 ? ", report only" : ""})`);
  check(m.trains >= 8 && m.onColour >= m.trains - 2, "minimap: trains are dots in their line's colour", { trains: m.trains, onColour: m.onColour });
  check(m.folkPixels >= 150, "minimap: townsfolk are 1 px dots (they go with the crowd)", m.folkPixels);
  check(m.named === m.districts && m.districts >= 6, "minimap: districtAt names each district at its centre", { named: m.named, of: m.districts });
  // hover names the district; a click recentres; a double-click flies there at 0.5
  const s = m.spots[1] || m.spots[0];
  await page.mouse.move(s.x, s.y);
  await page.waitForTimeout(150);
  const title = await page.evaluate(() => __view.minimap().canvas.title);
  check(title === s.name, "minimap: hover names the district", { title, want: s.name });
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(250);
  const c1 = await page.evaluate(() => __view.camera());
  check(Math.hypot(c1.x - s.cx, c1.y - s.cy) <= 2.5, "minimap: a click recentres the camera there", { cam: [c1.x, c1.y], want: [s.cx, s.cy] });
  const t = m.spots[3] || m.spots[0];
  await page.mouse.dblclick(t.x, t.y);
  await page.waitForTimeout(1100);
  const c2 = await page.evaluate(() => __view.camera());
  check(Math.abs(c2.zoom - 0.5) < 0.02 && Math.hypot(c2.x - t.cx, c2.y - t.cy) <= 2.5, "minimap: a double-click flies there at zoom 0.5", { cam: c2, want: [t.cx, t.cy] });
  noErrors(log, "minimap");
  await ctx.close();
}

// --- 13. no Math.random -----------------------------------------------------------------------------------------
function runNoRandom() {
  console.log("no Math.random");
  const dir = path.join(CLIENT, "view"), bad = [];
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".js") && /Math\.random/.test(fs.readFileSync(path.join(dir, f), "utf8"))) bad.push(f);
  check(bad.length === 0, "no Math.random in client/view/*.js", bad);
}

async function main() {
  runNoRandom();
  const pw = findPlaywright();
  if (!pw) { console.log("SKIP: playwright not found"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: no browser (${String(e.message || e).split("\n")[0]})`); return; }
  const server = await serve();
  BASE = `http://127.0.0.1:${server.address().port}`;
  const L = os.loadavg()[0];
  console.log(`load ${L.toFixed(2)}`);
  try {
    const only = (process.env.ONLY || "").split(",").filter(Boolean);
    for (const [name, fn] of [["crowd", runCrowd], ["trains", runTrains], ["bridges", runBridges], ["pings", runPings], ["navigation", runNavigation], ["minimap", runMinimap], ["goto", runGoto]]) {
      if (only.length && !only.includes(name)) continue;
      try { await fn(browser); } catch (e) { check(false, `${name}: ran to the end`, String((e && e.stack) || e).split("\n").slice(0, 3).join(" | ")); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`${passes} passed, ${failures} failed (load ${L.toFixed(2)} at start, ${os.loadavg()[0].toFixed(2)} at end)`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
