#!/usr/bin/env node
// Headless smoke test for the region view (V1a, view.md 3): the 256 x 192 region of client/dev/region_data.js
// on client/dev/region.html (manual=1: the test times setTown and drives every frame).
//
//   node tests/browser/region_view_smoke.cjs [check ...]     (checks: open sweep steady same night season fit flat)
//
// 1 open: the first default frame (setTown, setState, frame at zoom 1/4 over (85, 48)) is drawn within 600 ms
//   at 1280x800 and 390x844 dpr 2 (a phone), 1000 ms at 1440x900 dpr 2, and settles (no chunk pending)
// 2 sweep: from cold, zoom 1 -> fit -> 1 over Riverton Downtown in 120 frames: max <= 50 ms, p95 <= 25 ms,
//   sprites <= 16 MP (8 on the phone), chunks <= 24 MP (10 on the phone)
// 3 steady: at zoom 0.5 the median frame <= 12 ms; lod() is near at >= 0.5 and mid / far below
// 4 same: five views drawn on two fresh pages are equal pixel for pixel (slice runs are cut, so this compares the
//   v2 painter with itself), and CV.spriteBox equals art.building's bounds for every sprite key
// 5 night: at 22:00 twenty look changes (lot stages) keep every frame <= 33 ms and statics_builds flat
// 6 season: summer -> winter: no frame over 50 ms and everything updated (no stale sprite or chunk) within 3 s
// 7 fit: at night at fit zoom more than 2,000 lit-window pixels; the flat view passes 2, 3 and 6
//
// Timing rule (PLAN): L = os.loadavg()[0] at the start; L > 8: timings are reported only; else each limit is
// scaled by max(1, L / 4). Pixel, count and equality checks always gate. REGION_SHOTS=<folder> saves screenshots
// (default, 1/16, 1, night). Without Playwright or a browser it prints SKIP and exits 0.
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const CLIENT = path.join(REPO, "client");
const SHOTS = process.env.REGION_SHOTS || "";
const LOAD = os.loadavg()[0];
const GATE = LOAD <= 8, SCALE = Math.max(1, LOAD / 4);
let BASE = "";

function findPlaywright() {
  const tries = ["playwright", "/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright"];
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  return null;
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch (e) { rel = "/"; }
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
  if (ok) { passes += 1; console.log(`  ok   ${what}${detail ? ` (${detail})` : ""}`); return true; }
  failures += 1; console.log(`  FAIL ${what}${detail ? ` (${detail})` : ""}`);
  return false;
}
// a wall-clock limit: gated when the load allows (scaled), else reported
function timed(value, limit, what, detail) {
  const lim = limit * SCALE, d = `${value.toFixed(1)} ms, limit ${lim.toFixed(0)} ms${detail ? `, ${detail}` : ""}, load ${LOAD.toFixed(2)}`;
  if (!GATE) { console.log(`  info ${what} (${d}; report-only, load > 8)`); return true; }
  return check(value <= lim, what, d);
}
const stat = xs => { const s = [...xs].sort((a, b) => a - b); const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))] || 0; return { med: q(0.5), p95: q(0.95), max: s[s.length - 1] || 0 }; };

const SIZES = { desk: { size: { width: 1280, height: 800 }, dpr: 1 }, phone: { size: { width: 390, height: 844 }, dpr: 2, touch: true, mobile: true },
  big: { size: { width: 1440, height: 900 }, dpr: 2 } };
async function open(browser, o, query) {
  const ctx = await browser.newContext({ viewport: o.size, deviceScaleFactor: o.dpr, hasTouch: !!o.touch, isMobile: !!o.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${BASE}/dev/region.html?manual=1&${query || ""}`);
  await page.waitForFunction(() => window.__setTown && window.__stub !== undefined, null, { timeout: 30000 });
  await page.evaluate(() => {
    const g = document.getElementById("map").getContext("2d");
    // one frame, flushed (a pixel read waits for the draw)
    window.__f = () => { const t = performance.now(); window.__view.frame(); g.getImageData(0, 0, 1, 1); return performance.now() - t; };
    window.__dbg = () => window.__view.scene().debug();
    // frames until nothing is pending (chunks, sprites, boxes, stale ground), at most n
    window.__settle = n => {
      let k = 0, d;
      for (; k < (n || 400); k++) { window.__f(); d = window.__dbg(); if (!d.pending && !d.queue && !d.boxes && !d.staleSprites && !d.nearStale) break; }
      return { frames: k + 1, d };
    };
    window.__cam = c => window.__view.setCamera(c);
    // lit-window pixels: warm, bright pixels (the night tint makes everything else dark and blue)
    window.__lit = () => {
      const c = document.getElementById("map"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] > 120 && d[i + 2] < d[i] - 50) n++;
      return n;
    };
    window.__hash = () => {
      const c = document.getElementById("map"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i += 4) { h ^= d[i] | d[i + 1] << 8 | d[i + 2] << 16; h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16) + ":" + c.width + "x" + c.height;
    };
  });
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } };
const riverton = page => page.evaluate(() => { const R = window.__view.scene().R, d = R.district("downtown_riverton") || R.districts.find(x => /riverton/i.test(x.id)); return d ? d.center : [150, 100]; });

// 1: the first default frame, at three sizes
async function runOpen(browser) {
  for (const [name, o, limit] of [["1280x800", SIZES.desk, 600], ["390x844 dpr 2", SIZES.phone, 600], ["1440x900 dpr 2", SIZES.big, 1000]]) {
    const { ctx, page, errors } = await open(browser, o, name === "1440x900 dpr 2" ? "dyn=1" : "");
    const ms = await page.evaluate(() => window.__setTown());
    const r = await page.evaluate(() => { const c = window.__view.camera(); return { cam: c, d: window.__dbg(), lit: 0 }; });
    timed(ms, limit, `open ${name}: the first default frame`, `lod ${r.d.lod}, chunks ${r.d.chunks}, pending ${r.d.pending}`);
    check(Math.abs(r.cam.zoom - 0.25) < 1e-6 && Math.abs(r.cam.x - 85) < 0.6 && Math.abs(r.cam.y - 48) < 0.6, `open ${name}: the camera is the default view`, JSON.stringify(r.cam));
    check(r.d.pending === 0, `open ${name}: the first frame leaves no chunk pending`, `pending ${r.d.pending}`);
    check(r.d.big && r.d.buildings > 1000, `open ${name}: the region is big with its buildings`, `${r.d.buildings} buildings`);
    const s = await page.evaluate(() => window.__settle(200));
    check(s.d.pending === 0 && s.d.queue === 0, `open ${name}: settles`, `${s.frames} frames`);
    if (name === "1280x800") {
      await shot(page, "default");
      // the default view shows the river, its bridges and both rail lines: tile centres whose pixel is that
      // tile's low-zoom colour (CV.tilePattern; buildings in front hide some)
      const g = await page.evaluate(() => {
        const sc = window.__view.scene(), R = sc.R, CV = window.CityView, c = document.getElementById("map"), k = sc.dpr;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const shows = (x, y) => {
          const w = sc.proj.toWorld(x + 0.5, y + 0.5), q = sc.worldToCss(w[0], w[1]), X = Math.round(q[0] * k), Y = Math.round(q[1] * k);
          if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) return null;
          const i = (Y * c.width + X) * 4, col = CV.tilePattern(R.at(x, y), 0, sc.season);
          return Math.abs(d[i] - col[0]) + Math.abs(d[i + 1] - col[1]) + Math.abs(d[i + 2] - col[2]) <= 30;
        };
        const out = { river: 0, bridges: 0, lines: {} };
        for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
          const ch = R.at(x, y);
          if (ch === "~" && shows(x, y)) out.river++;
          if (ch === "b" && shows(x, y)) out.bridges++;
        }
        for (const t of R.tracks) {
          const seen = new Set();
          for (let i = 1; i < t.pts.length; i++) {
            const [ax, ay] = t.pts[i - 1], [bx, by] = t.pts[i], n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
            for (let s = 0; s <= n; s++) { const x = Math.floor(ax + (bx - ax) * s / (n || 1)), y = Math.floor(ay + (by - ay) * s / (n || 1)); seen.add(x + "," + y); }
          }
          let m = 0; for (const key of seen) { const [x, y] = key.split(",").map(Number); if (shows(x, y)) m++; }
          out.lines[t.line] = (out.lines[t.line] || 0) + m;
        }
        return out;
      });
      const ids = Object.keys(g.lines);
      check(g.river >= 50 && g.bridges >= 3 && ids.length >= 2 && ids.every(l => g.lines[l] >= 5),
        "open 1280x800: the default view shows the river, bridges and both rail lines", `river ${g.river} tiles, bridges ${g.bridges}, track tiles ${JSON.stringify(g.lines)}`);
    }
    check(!errors.length, `open ${name}: no console errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
}

// 2: the cold sweep (and the flat view's)
async function sweep(browser, o, label, query) {
  const { ctx, page, errors } = await open(browser, o, query);
  await page.evaluate(() => window.__setTown());
  const at = await riverton(page);
  const r = await page.evaluate(([x, y]) => {
    const fit = window.__view.cam().fitZoom(), ts = [], zs = [];
    let spr = 0, chk = 0;
    for (let i = 0; i < 120; i++) {
      const u = i < 60 ? i / 59 : (119 - i) / 59, z = Math.exp(Math.log(1) + (Math.log(fit) - Math.log(1)) * u);
      window.__cam({ zoom: z, x, y });
      ts.push(window.__f()); zs.push(z);
      const d = window.__dbg(); spr = Math.max(spr, d.spriteMP); chk = Math.max(chk, d.cacheMP);
    }
    return { ts, fit, spr, chk, phone: window.__dbg().phone };
  }, at);
  const s = stat(r.ts);
  timed(s.max, 50, `sweep ${label}: the worst frame`, `fit ${r.fit.toFixed(3)}, median ${s.med.toFixed(1)}`);
  timed(s.p95, 25, `sweep ${label}: the 95th percentile frame`);
  const sc = o.mobile ? 8 : 16, cc = o.mobile ? 10 : 24;
  check(r.spr <= sc, `sweep ${label}: sprites within ${sc} MP`, `${r.spr.toFixed(1)} MP`);
  check(r.chk <= cc + 0.01, `sweep ${label}: chunks within ${cc} MP`, `${r.chk.toFixed(1)} MP`);
  check(!!o.mobile === r.phone, `sweep ${label}: the phone caps apply on the phone only`);
  check(!errors.length, `sweep ${label}: no console errors`, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
async function runSweep(browser) { await sweep(browser, SIZES.desk, "1280x800"); await sweep(browser, SIZES.phone, "390x844 dpr 2"); }

// 3: steady near frames, and the LOD by zoom
async function steady(browser, label, query) {
  const { ctx, page, errors } = await open(browser, SIZES.desk, query);
  await page.evaluate(() => window.__setTown());
  const r = await page.evaluate(() => {
    const lods = {};
    for (const z of [3, 1, 0.5, 0.4, 0.25, 0.18, 0.1, 0.0625]) { window.__cam({ zoom: z, x: 60, y: 40 }); window.__f(); lods[z] = window.__view.scene().lod(); }
    window.__cam({ zoom: 0.5, x: 60, y: 40 });
    const st = window.__settle(400);
    const ts = []; for (let i = 0; i < 60; i++) ts.push(window.__f());
    return { lods, st, ts };
  });
  const s = stat(r.ts);
  timed(s.med, 12, `steady ${label}: the median frame at zoom 0.5`, `p95 ${s.p95.toFixed(1)}, settled in ${r.st.frames} frames, items ${r.st.d.items}`);
  const want = { 3: "near", 1: "near", 0.5: "near", 0.4: "mid", 0.25: "mid", 0.18: "mid", 0.1: "far", 0.0625: "far" };
  check(Object.entries(want).every(([z, l]) => r.lods[z] === l), `steady ${label}: lod() is near at >= 0.5, mid at 0.18-0.5, far below`, JSON.stringify(r.lods));
  check(!errors.length, `steady ${label}: no console errors`, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
async function runSteady(browser) { await steady(browser, "iso"); }

// 4: determinism: five near views over two fresh pages, and every LOD drawn twice on one page (at a fixed clock,
// since water, smoke and beacons move); spriteBox = art.building's bounds
async function runSame(browser) {
  const views = [[1, 40, 25], [0.5, 150, 100], [2, 30, 20], [0.5, 85, 48], [1, 128, 96]];
  const lows = [[0.25, 85, 48], [0.125, 128, 96], [0.0625, 128, 96], [0.4, 150, 100], [3, 60, 40]];
  const hashes = [];
  for (let k = 0; k < 2; k++) {
    const { ctx, page } = await open(browser, SIZES.desk, "");
    await page.evaluate(() => window.__setTown());
    const at = (vs) => page.evaluate(vs => vs.map(([z, x, y]) => { window.__cam({ zoom: z, x, y }); window.__settle(400); window.__view.frame(1e6); return window.__hash(); }), vs);
    hashes.push(await at(views));
    if (k === 0) {
      const a = await at(lows), b = await at(lows);
      check(a.every((h, i) => h === b[i]), "same: mid, far and near views draw equal pixels twice on one page", a.join(" "));
    }
    if (k === 0) {
      const r = await page.evaluate(() => {
        const sc = window.__view.scene(), art = sc.art, CV = window.CityView, seen = new Set(), bad = [];
        let n = 0;
        for (const b of sc.R.buildings) {
          const kp = Object.assign({}, b.p, { variant: b.variant }), key = CV.spriteKey(kp, null, "summer");
          if (seen.has(key)) continue;
          seen.add(key);
          const box = art.spriteBox(kp, null), pp = b.variant == null ? b.p : CV.canonPlace(kp), s = art.building(pp, {}, "summer");
          const box2 = b.variant == null ? box : art.spriteBox(pp, null);
          n++;
          if (s.ox !== box2.ox || s.oy !== box2.oy || s.c.width !== box2.w || s.c.height !== box2.h) bad.push(b.p.id);
        }
        return { n, bad };
      });
      check(r.bad.length === 0, "same: spriteBox equals art.building's bounds for every sprite key", `${r.n} keys, ${r.bad.length} differ ${r.bad.slice(0, 5).join(" ")}`);
    }
    await ctx.close();
  }
  check(hashes[0].every((h, i) => h === hashes[1][i]), "same: five near views draw equal pixels on two fresh pages", hashes[0].join(" ") + " / " + hashes[1].join(" "));
}

// 5: twenty look changes at night
async function runNight(browser) {
  const { ctx, page, errors } = await open(browser, SIZES.desk, "minute=1320");
  await page.evaluate(() => window.__setTown());
  const r = await page.evaluate(() => {
    window.__cam({ zoom: 0.5, x: 40, y: 25 });
    window.__settle(400);
    const sc = window.__view.scene(), st = window.__state, b0 = window.__dbg().statics_builds;
    const homes = sc.R.buildings.filter(b => !b.decor && b.p.kind === "home" && b.p.x < 80 && b.p.y < 50).slice(0, 20);
    const ts = [];
    homes.forEach((b, i) => {
      st.lots = Object.assign({}, st.lots, { [b.p.id]: { stage: 1 + i % 4, works: i % 5 === 0, moving: false } });
      window.__view.setState(st, 1);
      ts.push(window.__f());
      for (let k = 0; k < 2; k++) ts.push(window.__f());
    });
    return { ts, n: homes.length, b0, b1: window.__dbg().statics_builds, lit: window.__lit() };
  });
  const s = stat(r.ts);
  timed(s.max, 33, "night: the worst frame over twenty look changes", `${r.n} changes, median ${s.med.toFixed(1)}`);
  check(r.n === 20 && r.b1 === r.b0, "night: statics_builds stays flat", `${r.b0} -> ${r.b1}`);
  await page.evaluate(() => { window.__cam({ zoom: 1, x: 40, y: 25 }); window.__settle(200); });
  await shot(page, "night");
  check(!errors.length, "night: no console errors", errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// 6: a season change
async function season(browser, label, query) {
  const { ctx, page, errors } = await open(browser, SIZES.desk, query);
  await page.evaluate(() => window.__setTown());
  const r = await page.evaluate(async () => {
    window.__cam({ zoom: 0.5, x: 60, y: 40 });
    window.__settle(400);
    const st = window.__state; st.season = "winter";
    const t0 = performance.now(), ts = [];
    window.__view.setState(st, 1);
    let done = -1, d;
    while (performance.now() - t0 < 3000) {
      ts.push(window.__f()); d = window.__dbg();
      if (!d.pending && !d.queue && !d.staleSprites && !d.nearStale && !d.boxes) { done = performance.now() - t0; break; }
      await new Promise(res => setTimeout(res, 4));
    }
    // the mid view too: its chunks re-bake for winter
    window.__cam({ zoom: 0.25, x: 85, y: 48 });
    const t1 = performance.now(); let done2 = -1;
    while (performance.now() - t1 < 3000) { ts.push(window.__f()); d = window.__dbg(); if (!d.pending && !d.queue) { done2 = performance.now() - t1; break; } await new Promise(res => setTimeout(res, 4)); }
    return { ts, done, done2, season: window.__view.scene().season, d };
  });
  const s = stat(r.ts);
  timed(s.max, 50, `season ${label}: the worst frame after summer -> winter`, `median ${s.med.toFixed(1)}, ${r.ts.length} frames`);
  check(r.season === "winter" && r.done >= 0 && r.done2 >= 0, `season ${label}: everything is winter within 3 s`, `near ${r.done.toFixed(0)} ms, mid ${r.done2.toFixed(0)} ms`);
  check(!errors.length, `season ${label}: no console errors`, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
async function runSeason(browser) { await season(browser, "iso"); }

// 7: lit windows at fit, and the far / near shots
async function runFit(browser) {
  const { ctx, page, errors } = await open(browser, SIZES.desk, "minute=1320");
  await page.evaluate(() => window.__setTown());
  const r = await page.evaluate(() => { window.__cam({ fit: true }); const s = window.__settle(400); return { lit: window.__lit(), s, zoom: window.__view.camera().zoom }; });
  check(r.lit > 2000, "fit: night at fit zoom shows more than 2,000 lit pixels", `${r.lit} px at zoom ${r.zoom.toFixed(3)}, lod ${r.s.d.lod}`);
  await page.evaluate(() => { window.__state.minute = 600; window.__state.tick = 1440 + 600; window.__view.setState(window.__state, 1); window.__cam({ zoom: 0.0625, x: 128, y: 96 }); window.__settle(400); });
  await shot(page, "zoom-1-16");
  await page.evaluate(() => { window.__cam({ zoom: 1, x: 40, y: 25 }); window.__settle(400); });
  await shot(page, "zoom-1");
  check(!errors.length, "fit: no console errors", errors.slice(0, 3).join(" | "));
  await ctx.close();
}
async function runFlat(browser) {
  await sweep(browser, SIZES.desk, "flat 1280x800", "flat=1");
  await steady(browser, "flat", "flat=1");
  await season(browser, "flat", "flat=1");
}

const RUNS = [["open", runOpen], ["sweep", runSweep], ["steady", runSteady], ["same", runSame], ["night", runNight], ["season", runSeason],
  ["fit", runFit], ["flat", runFlat]];
async function main() {
  const pw = findPlaywright();
  if (!pw) { console.log("SKIP: Playwright is not installed"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: no browser to launch (${String(e && e.message || e).split("\n")[0]})`); return; }
  const server = await serve();
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`load ${LOAD.toFixed(2)}: timings ${GATE ? `gated, limits x ${SCALE.toFixed(2)}` : "report-only"}`);
  const only = process.argv.slice(2);
  try {
    for (const [name, run] of RUNS) {
      if (only.length && !only.includes(name)) continue;
      console.log(name);
      try { await run(browser); } catch (e) { check(false, `${name}: the run finished`, String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
    }
  } finally { await browser.close(); server.close(); }
  console.log(`${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
