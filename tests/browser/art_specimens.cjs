#!/usr/bin/env node
// Headless check of the v3 view art (view.md 8, V2) on client/dev/specimens.html:
//
//   node tests/browser/art_specimens.cjs
//
// Over the distinct building styles in gameofailife/data/region.json (places and decor) plus Millbrook's (from
// client/dev/fixture_town.js), up to three sample places a style, each x 5 neglect stages x 4 seasons x day/night:
// - no console error, and more than 30% of the sprite's canvas opaque;
// - CV.spriteBox equals the drawn canvas rect (iso and flat), nothing touches the canvas edge (no clipping), every
//   night-glow window quad lies inside it, and CV.heightOf is within 4 px of the roof;
// - each sprite takes <= 6 ms at p95 and <= 10 ms at most (PLAN 6's timing rule: report-only when the 1-minute
//   load L > 8, else the limits times max(1, L / 4));
// - every new style is shift-invariant: a place with a variant drawn in place equals its canonical copy at (0, 0);
// - CV.spriteKey is equal iff its nine parts are: neglected and pristine homes never share a sprite, flats with
//   different names never do, places of one variant do, and Millbrook places keep their id in the key;
// - every tile code's CV.groundKey names an art drawer that returns a tw x (th + 24) tile, in iso and flat;
// - train cars, folk sheets and the van and truck draw.
// A screenshot sheet goes to $ART_SHOTS/art_specimens.png (default: the system temp folder).
// Playwright is looked for as a local module, then in the global node_modules; without it the test prints SKIP.
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const REPO = path.resolve(__dirname, "..", "..");
const CLIENT = path.join(REPO, "client");
const SHOTS = process.env.ART_SHOTS || os.tmpdir();

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

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
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
  if (ok) { passes += 1; return true; }
  failures += 1;
  console.log(`  FAIL ${what}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return false;
}

// The sample places: up to three of each style from the region (places, then decor rows) and all of Millbrook's.
const KIND = { tower: "office", apartments: "home", residential_tower: "home", row_houses: "home", house: "home", big_house: "home",
  shop: "shop", factory: "works", warehouse: "works" };
function samples() {
  const region = JSON.parse(fs.readFileSync(path.join(REPO, "gameofailife", "data", "region.json"), "utf8"));
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(CLIENT, "dev", "fixture_town.js"), "utf8"), ctx);
  const mill = ctx.window.CITY_FIXTURE.town.places.filter(p => p.kind !== "park");
  const by = new Map();
  const add = p => { if (p.kind === "park" || p.style === "park") return; const l = by.get(p.style) || []; if (l.length < 3) l.push(p); by.set(p.style, l); };
  for (const p of region.places) add({ id: p.id, name: p.name, kind: p.kind, style: p.style, x: p.x, y: p.y, w: p.w, h: p.h, floors: p.floors, face: p.face, entry: p.entry });
  region.decor.forEach((d, k) => add({ id: "decor_" + k, name: "", kind: KIND[d[4]] || "shop", style: d[4], x: d[0], y: d[1], w: d[2], h: d[3], floors: d[5], face: "s",
    entry: [d[0] + (d[2] >> 1), d[1] + d[3]], variant: d[6], decor: true }));
  const regionStyles = [...by.keys()];
  for (const p of mill) { const l = by.get(p.style) || []; l.push(p); by.set(p.style, l); }
  return { regionStyles, millStyles: [...new Set(mill.map(p => p.style))], places: [].concat(...by.values()) };
}

// Runs in the page.
function pageRun(arg) {
  const CV = window.CityView, out = { styles: {}, errors: [], keyFails: [], tileFails: [], shiftFails: [], shiftV2: [], movers: [] };
  const SEASONS = ["spring", "summer", "autumn", "winter"];
  const fnv = d => { let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
  const projs = { iso: CV.makeProj("iso", 256, 192, 0), flat: CV.makeProj("flat", 256, 192, 0) };
  const arts = { iso: CV.makeArt(projs.iso), flat: CV.makeArt(projs.flat) };
  const lookFor = (p, stage) => p.kind === "home" ? { stage, units: p.style === "apartments" || p.style === "residential_tower" ? [{ vacant: stage === 2 }, {}, { vacant: true, listing: 1 }, {}] : [], works: stage === 3 && p.style === "house" } : {};
  const inPlace = p => CV.variantOf(p) == null;
  // warm-up: every sample once, untimed
  for (const p of arg.places) arts.iso.building(CV.canonPlace(p), lookFor(p, 0), "summer");
  for (const p of arg.places) {
    const st = out.styles[p.style] || (out.styles[p.style] = { n: 0, ms: [], opaqueMin: 1, boundsBad: 0, clipBad: 0, heightBad: 0, glowBad: 0, windows: 0, samples: 0 });
    st.samples++;
    for (const kind of ["iso", "flat"]) {
      const art = arts[kind], proj = projs[kind];
      const q = inPlace(p) ? p : CV.canonPlace(p);
      for (const season of (kind === "iso" ? SEASONS : ["summer", "winter"])) for (let stage = 0; stage < 5; stage++) {
        const look = lookFor(p, stage);
        let b;
        const t0 = performance.now();
        try { b = art.building(q, look, season); } catch (e) { out.errors.push(`${p.style} ${p.id}: ${e && e.stack || e}`); continue; }
        // the sprite's cost is drawing it plus rasterising it (a one-pixel read forces that); the full read
        // below is the test's own and is not timed
        const g = b.c.getContext("2d"); g.getImageData(0, 0, 1, 1);
        const ms = performance.now() - t0;
        const W = b.c.width, H = b.c.height, d = g.getImageData(0, 0, W, H).data;
        if (kind === "iso") st.ms.push(ms);
        st.n++;
        let opaque = 0, minX = W, minY = H, maxX = -1, maxY = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 0) { opaque++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        st.opaqueMin = Math.min(st.opaqueMin, opaque / (W * H));
        const box = CV.spriteBox(q, look, proj);
        if (box.ox !== b.ox || box.oy !== b.oy || box.w !== W || box.h !== H) { st.boundsBad++; if (st.boundsBad === 1) out.errors.push(`${p.style} bounds ${JSON.stringify(box)} vs ${[b.ox, b.oy, W, H]}`); }
        if (minX <= 0 || minY <= 0 || maxX >= W - 1) { st.clipBad++; if (st.clipBad === 1) out.errors.push(`${p.style} ${kind} touches the canvas edge: ${[minX, minY, maxX, maxY, W, H]}`); }
        // the roof: the body's centre at heightOf - 2 is opaque, and within 4 px above it there is a pixel of roof
        if (kind === "iso") {
          const bd = CV.bodyOf(q), cx = (bd.x0 + bd.x1) / 2, cy = (bd.y0 + bd.y1) / 2, hz = CV.heightOf(q);
          const at = z => { const w = proj.toWorld(cx, cy, z); return [Math.round(w[0] - b.ox), Math.round(w[1] - b.oy)]; };
          let ok = false;
          for (let dz = -4; dz <= 2 && !ok; dz++) { const [x, y] = at(hz + dz); if (x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 0) ok = true; }
          if (!ok) { st.heightBad++; if (st.heightBad === 1) out.errors.push(`${p.style} no roof within 4 px of heightOf ${hz}`); }
        }
        // night: every window quad that glows lies inside the sprite
        st.windows = Math.max(st.windows, b.windows.length);
        for (const quad of b.windows) for (const pt of quad) if (pt[0] - b.ox < -1 || pt[1] - b.oy < -1 || pt[0] - b.ox > W + 1 || pt[1] - b.oy > H + 1) { st.glowBad++; break; }
      }
    }
    // shift invariance (iso): a place with a variant drawn in place equals its canonical copy
    if (!inPlace(p)) {
      const look = lookFor(p, 2), a = arts.iso.building(p, look, "winter"), c = arts.iso.building(CV.canonPlace(p), look, "winter");
      const o = projs.iso.toWorld(p.x, p.y), z = projs.iso.toWorld(0, 0);
      const same = a.c.width === c.c.width && a.c.height === c.c.height && a.ox - c.ox === o[0] - z[0] && a.oy - c.oy === o[1] - z[1] &&
        fnv(a.c.getContext("2d").getImageData(0, 0, a.c.width, a.c.height).data) === fnv(c.c.getContext("2d").getImageData(0, 0, c.c.width, c.c.height).data);
      if (!same) out.shiftFails.push(p.style + " " + p.id);
    } else {
      const look = lookFor(p, 0), moved = Object.assign({}, p, { x: p.x + 7, y: p.y + 3, entry: p.entry ? [p.entry[0] + 7, p.entry[1] + 3] : null });
      const a = arts.iso.building(p, look, "summer"), c = arts.iso.building(moved, look, "summer");
      const same = a.c.width === c.c.width && a.c.height === c.c.height &&
        fnv(a.c.getContext("2d").getImageData(0, 0, a.c.width, a.c.height).data) === fnv(c.c.getContext("2d").getImageData(0, 0, c.c.width, c.c.height).data);
      if (!same) out.shiftV2.push(p.style + " " + p.id);
    }
  }
  // spriteKey: equal iff the nine parts are equal
  const base = { id: "k1", name: "Harbour Court", kind: "home", style: "apartments", x: 120, y: 60, w: 6, h: 4, floors: 6, face: "s", entry: [123, 64], variant: 3 };
  const k = (p, look, season) => CV.spriteKey(p, look, season);
  const k0 = k(base, { stage: 0 }, "summer");
  if (k0.split("|").length !== 9) out.keyFails.push("a key has " + k0.split("|").length + " parts");
  const differ = [["style", { style: "residential_tower" }], ["w", { w: 7 }], ["h", { h: 5 }], ["floors", { floors: 7 }], ["face", { face: "e" }], ["variant", { variant: 4 }], ["signText", { name: "Quay Court" }]];
  for (const [what, ch] of differ) if (k(Object.assign({}, base, ch), { stage: 0 }, "summer") === k0) out.keyFails.push("a different " + what + " gives the same key");
  if (k(base, { stage: 4 }, "summer") === k0) out.keyFails.push("neglected and pristine homes share a key");
  if (k(base, { stage: 0, units: [{ vacant: true }] }, "summer") === k0) out.keyFails.push("a vacant unit does not change the key");
  if (k(base, { stage: 0 }, "winter") === k0) out.keyFails.push("a different season gives the same key");
  if (k(Object.assign({}, base, { id: "k2", x: 30 + 120, y: 90 }), { stage: 0 }, "summer") !== k0) out.keyFails.push("two places of one variant and the same parts differ");
  if (k(Object.assign({}, base, { id: "k3", variant: undefined }), { stage: 0 }, "summer") !== k(Object.assign({}, base, { id: "k3", variant: undefined, x: 140 }), { stage: 0 }, "summer")) out.keyFails.push("a hashed variant moved with the place");
  const shopA = { id: "s1", name: "A", kind: "shop", style: "shop", x: 100, y: 60, w: 4, h: 3, floors: 2, face: "s", variant: 1 };
  if (CV.signTextOf(shopA) !== CV.SHOP_SIGNS[1] || k(shopA, null, "summer").split("|")[8] !== CV.SHOP_SIGNS[1]) out.keyFails.push("a shop's sign is not its variant's word");
  const mA = { id: "main_12", name: "12 Main Street", kind: "home", style: "house", x: 10, y: 10, w: 3, h: 3, floors: 1, face: "s" };
  const mB = Object.assign({}, mA, { id: "main_20", x: 18 });
  if (CV.variantOf(mA) !== null || k(mA, null, "summer") === k(mB, null, "summer") || k(mA, null, "summer").split("|")[5] !== "main_12") out.keyFails.push("Millbrook places do not keep their id in the key");
  if (CV.signTextOf({ style: "tower", name: "Brightline Tech" }) !== "BRIGHTLINE" || CV.signTextOf({ style: "residential_tower", name: "Harbour View" }) !== "HARBOUR" || CV.signTextOf({ style: "house", name: "x" }) !== "")
    out.keyFails.push("signTextOf");
  const pal = CV.paletteOf(base);
  if (!pal || !["wall", "roof", "roof_kind", "glass", "trim"].every(n => typeof pal[n] === "string")) out.keyFails.push("paletteOf keys");
  // every tile code's drawer returns a tw x (th + 24) tile
  const mk = rows => ({ w: 3, h: 3, tiles: rows, millbrook: [-10, -10, 1, 1] });
  const fill = c => [c + c + c, c + c + c, c + c + c];
  const DEMO = { ".": fill("."), "#": ["...", "###", "..."], B: fill("B"), D: fill("D"), P: fill("P"), T: ["...", ".T.", "..."], e: [".B.", ".e.", ".#."],
    "~": ["~~~", "~~~", "..."], b: ["~#~", "~b~", "~#~"], x: [".#.", "=x=", ".#."], F: fill("F"), "=": ["...", "===", "SSS"], r: ["~~~", "=r=", "~~~"],
    S: ["SSS", "SSS", "==="], H: ["HHH", "HHH", "..."], h: ["~~~", "hhh", "hhh"] };
  for (const kind of ["iso", "flat"]) for (const code of Object.keys(DEMO)) for (const season of SEASONS) {
    const key = CV.groundKey(mk(DEMO[code]), 1, 1, season), art = arts[kind], proj = projs[kind];
    if (!Array.isArray(key) || typeof art[key[0]] !== "function") { out.tileFails.push(`${kind} ${code}: no drawer ${key && key[0]}`); continue; }
    let t;
    try { t = art[key[0]](...key.slice(1)); } catch (e) { out.tileFails.push(`${kind} ${code}: ${e}`); continue; }
    if (!t || t.width !== proj.tw || t.height !== proj.th + 24) out.tileFails.push(`${kind} ${code} ${season}: ${t && t.width}x${t && t.height}`);
  }
  // an R with code + CODE instead of tiles reads the same
  const R2 = { w: 3, h: 3, code: new Uint8Array([0, 1, 0, 2, 2, 2, 0, 1, 0]), CODE: { ".": 0, "#": 1, "=": 2 }, millbrook: [-10, -10, 1, 1] };
  if (JSON.stringify(CV.groundKey(R2, 1, 1, "summer")) !== JSON.stringify(CV.groundKey(mk([".#.", "===", ".#."]), 1, 1, "summer"))) out.tileFails.push("R.code and R.tiles disagree");
  // movers
  for (const [what, f] of [["trainCar", () => ["head", "car", "tail"].map((kk, i) => arts.iso.trainCar("#d23a3a", "esnw"[i], kk, i === 1))],
    ["folkSheet", () => { const l = []; for (let v = 0; v < 24; v++) l.push(arts.iso.folkSheet(v, false), arts.iso.folkSheet(v, true)); return l; }],
    ["van/truck", () => [arts.iso.car("#3a6ad6", "van", 0), arts.iso.car("#3a6ad6", "truck", 3), arts.flat.car("#3a6ad6", "truck", 1)]]]) {
    try { const l = f(); out.movers.push([what, l.length, l.every(s => s && s.c && s.c.width > 0), l.reduce((a, s) => a + s.c.width * s.c.height, 0)]); }
    catch (e) { out.movers.push([what, 0, false, String(e)]); }
  }
  return out;
}

(async () => {
  const pw = findPlaywright();
  if (!pw) { console.log("SKIP art_specimens: Playwright is not installed"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log("SKIP art_specimens: no browser to launch: " + String(e).split("\n")[0]); return; }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const L = os.loadavg()[0];
  try {
    const S = samples();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(base + "/dev/specimens.html");
    const out = await page.evaluate(pageRun, S);
    // every style of the region and Millbrook was drawn
    for (const s of S.regionStyles.concat(S.millStyles)) check(out.styles[s] && out.styles[s].n > 0, `style ${s} drawn`);
    check(!out.errors.length, "no errors drawing sprites", out.errors.slice(0, 6));
    const all = [];
    const rows = [];
    for (const [s, st] of Object.entries(out.styles)) {
      check(st.opaqueMin > 0.3, `${s}: > 30% opaque`, st.opaqueMin.toFixed(3));
      check(!st.boundsBad, `${s}: spriteBox equals the drawn bounds`, st.boundsBad);
      check(!st.clipBad, `${s}: nothing clipped at the canvas edge`, st.clipBad);
      check(!st.heightBad, `${s}: heightOf within 4 px of the roof`, st.heightBad);
      check(!st.glowBad, `${s}: night glow windows inside the sprite`, st.glowBad);
      check(st.windows > 0, `${s}: has windows that light at night`);
      const ms = st.ms.slice().sort((a, b) => a - b);
      all.push(...ms);
      rows.push(`${s.padEnd(18)} n ${String(st.n).padStart(3)}  median ${ms[ms.length >> 1].toFixed(2)}  p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(2)}  max ${ms[ms.length - 1].toFixed(2)} ms  opaque ${(st.opaqueMin * 100).toFixed(0)}%`);
    }
    all.sort((a, b) => a - b);
    const p95 = all[Math.floor(all.length * 0.95)], mx = all[all.length - 1], k = Math.max(1, L / 4);
    console.log(`sprite timings at load ${L.toFixed(2)} (${all.length} sprites):\n  ` + rows.join("\n  "));
    console.log(`all sprites: p95 ${p95.toFixed(2)} ms, max ${mx.toFixed(2)} ms`);
    if (L > 8) console.log(`  timing report-only (load ${L.toFixed(2)} > 8)`);
    else { check(p95 <= 6 * k, `sprite p95 <= ${(6 * k).toFixed(1)} ms`, p95.toFixed(2)); check(mx <= 10 * k, `sprite max <= ${(10 * k).toFixed(1)} ms`, mx.toFixed(2)); }
    check(!out.shiftFails.length, "every keyed place is shift-invariant", out.shiftFails.slice(0, 8));
    if (out.shiftV2.length) console.log(`  (v2 in-place styles not shift-invariant, reported: ${out.shiftV2.join(", ")})`);
    check(!out.keyFails.length, "spriteKey equal iff its nine parts are equal", out.keyFails);
    check(!out.tileFails.length, "every tile code's drawer returns a tw x (th + 24) tile", out.tileFails.slice(0, 8));
    for (const [what, n, ok, px] of out.movers) check(ok && n > 0, `${what} draw`, px);
    const folk = out.movers.find(m => m[0] === "folkSheet");
    if (folk) console.log(`folk sheets: 48 (24 x adult/child), ${(folk[3] / 1e6).toFixed(2)} MP`);
    check(!errors.length, "no console errors", errors.slice(0, 5));
    // the screenshot sheet: every sample style (one each, stage 2, winter) and every tile code
    await page.evaluate(places => { window.SPEC_PLACES = places; }, (() => { const seen = new Set(); return S.places.filter(p => !seen.has(p.style) && seen.add(p.style)); })());
    await page.selectOption("#stage", "2");
    await page.selectOption("#season", "winter");
    await page.waitForTimeout(100);
    const shot = path.join(SHOTS, "art_specimens.png");
    try { await (await page.$("#sheet")).screenshot({ path: shot }); console.log("sheet: " + shot); } catch (e) { console.log("no sheet: " + e); }
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`art_specimens: ${passes} passed, ${failures} failed (load ${L.toFixed(2)})`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
