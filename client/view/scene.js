// CityView scene: normalizes the town, derives lots, plazas, park paths, driveways, lamps and stops from
// the tile codes, caches the ground in 512-px chunks per zoom level, keeps the upright statics (building
// slices, trees, lamps, fences, signs) sorted once by depth and merges the movers into them each frame,
// then draws night light, weather, the plane, markers and labels. It also answers hit tests.
// Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { hash, shade, rgba } = CV.color;
  const CH = 512;              // ground chunk size in world px
  const BUILDS_PER_FRAME = 2;  // chunk builds allowed per frame once the first frames are up
  const PING_MS = 3000, PING_ARROW_MS = 8000; // ping rings, and the arrow at the view's edge for an off-screen ping
  const STYLE_OF = { home: "house", office: "tower", school: "school", market: "market", cafe: "cafe", hospital: "hospital",
    shop: "arcade", bank: "bank", townhall: "city_hall", works: "factory", park: "park" };

  // Fill in what an older town_json lacks, so the view also runs on today's 40 x 25 town.
  CV.normalizeTown = function (t) {
    const town = Object.assign({}, t);
    town.places = (t.places || []).map(p0 => {
      const p = Object.assign({}, p0);
      if (!p.style) p.style = STYLE_OF[p.kind] || "house";
      if (p.floors == null) p.floors = CV.FLOORS[p.style] != null ? CV.FLOORS[p.style] : 2;
      if (p.face === undefined || (p.face === null && p.kind !== "park")) {
        const [ex, ey] = p.entry || [p.x, p.y + p.h];
        p.face = p.kind === "park" ? null : ey >= p.y + p.h ? "s" : ey < p.y ? "n" : ex >= p.x + p.w ? "e" : "w";
      }
      if (p.tier === undefined) p.tier = p.kind === "home" ? (p.style === "apartments" ? "flat" : p.style === "big_house" ? "big_house" : "house") : null;
      if (p.units == null) p.units = p.kind === "home" ? (p.style === "apartments" ? 6 : 1) : 0;
      return p;
    });
    const W = town.w, H = town.h, tiles = town.tiles;
    const road = (x, y) => x >= 0 && y >= 0 && x < W && y < H && tiles[y][x] === "#";
    if (!town.road_rows) { town.road_rows = []; for (let y = 0; y < H; y++) if ([...tiles[y]].filter(c => c === "#").length > W * 0.6) town.road_rows.push(y); }
    if (!town.road_cols) { town.road_cols = []; for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) if (tiles[y][x] === "#") n++; if (n > H * 0.6) town.road_cols.push(x); } }
    if (!town.junctions) {
      town.junctions = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (road(x, y) && (road(x + 1, y) + road(x - 1, y) + road(x, y + 1) + road(x, y - 1)) >= 3) town.junctions.push([x, y]);
    }
    if (!town.homes) {
      town.homes = [];
      for (const p of town.places) if (p.kind === "home") {
        if (p.units > 1) for (const u of ["1A", "1B", "2A", "2B", "3A", "3B"].slice(0, p.units)) town.homes.push({ id: p.id + "_" + u.toLowerCase(), place: p.id, unit: u });
        else town.homes.push({ id: p.id, place: p.id, unit: null });
      }
    }
    town.stops = town.stops || [];
    town.districts = town.districts || [];
    return town;
  };

  CV.makeScene = function (cv, rawTown, opt) {
    opt = opt || {};
    const town = CV.normalizeTown(rawTown);
    const W = town.w, H = town.h, tiles = town.tiles, places = town.places;
    // R: the tile predicates and the building list (region.js); BIG: the region path (LOD chunks, lazy sprites,
    // decor). Older 80 x 50 and 40 x 25 towns take v2's path unchanged.
    const R = CV.makeRegion(town), BIG = R.big;
    let proj = CV.makeProj(opt.projection || "iso", W, H, opt.rot || 0);
    let art = CV.makeArt(proj);
    const g = cv.getContext("2d");
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : tiles[y][x];
    const scene = {
      town, proj, cam: { x: 0, y: 0, zoom: 1 }, dpr: 1, season: "summer", minute: 600, weather: "clear", state: null,
      looks: {}, movers: [], selected: null, hover: null, hoverTile: null, highlight: null, overlay: null,
      pings: [], pingArrows: [], inset: { top: 0, right: 0, bottom: 0 }, reserved: [], quality: "high", lights: { ns: "green", ew: "red" },
      stats: { items: 0, chunks: 0, built: 0, draw: 0, frames: 0, cacheMP: 0, statics_builds: 0, spriteBuilds: 0, staleSprites: 0, buildMs: 0, spriteMs: 0, boxes: 0, runs: 0, splitRuns: 0 },
    };
    scene.R = R; scene.big = BIG;
    const placeById = new Map(places.map((p, i) => [p.id, i]));
    scene.placeById = placeById;
    const moverSources = [];
    const homePlace = new Map(town.homes.map(h => [h.id, h.place]));

    // --- tile classification (client-derived; no new tile codes) -----------------------------------------
    const N = W * H;
    const placeIdx = new Int16Array(N).fill(-1); // footprint owner
    const lotOf = new Int16Array(N).fill(-1);    // house or big house lot (lawn, fence)
    const zoneOf = new Uint8Array(N);            // 1 paved plaza, 2 works yard
    const zoneOwn = new Int16Array(N).fill(-1);  // the place a paved tile belongs to
    const pathMask = new Uint8Array(N);          // park paths
    const squareOf = new Uint8Array(N);          // paved square
    const driveOf = new Int16Array(N).fill(-1);  // driveway tile of a home
    const entryOf = new Map();
    const variant = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) variant[y * W + x] = BIG ? CV.hash2(x, y) % 8 : hash(x * 7919 + y * 104729 + 13) % 8;
    places.forEach((p, i) => {
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) placeIdx[y * W + x] = i;
      if (p.entry) entryOf.set(p.entry[1] * W + p.entry[0], i);
    });
    const dist = (p, x, y) => Math.max(p.x - x, x - (p.x + p.w - 1), p.y - y, y - (p.y + p.h - 1), 0);
    const downtown = (town.districts.find(d => d.id === "downtown") || { rects: [] }).rects;
    const inRects = (rects, x, y) => rects.some(r => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
    const isHouseLike = p => p.kind === "home" && p.style !== "apartments";
    // places by 8 x 8 tile cell, over their rect grown by the reach (2), in place order
    const GC = 8, gw = Math.ceil(W / GC) + 1, cellPlaces = new Map();
    places.forEach((p, i) => {
      if (p.kind === "park") return;
      for (let cy = Math.max(0, Math.floor((p.y - 2) / GC)); cy <= Math.floor((p.y + p.h + 2) / GC); cy++)
        for (let cx = Math.max(0, Math.floor((p.x - 2) / GC)); cx <= Math.floor((p.x + p.w + 2) / GC); cx++) {
          const k = cy * gw + cx; let l = cellPlaces.get(k); if (!l) cellPlaces.set(k, l = []); l.push(i);
        }
    });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = tiles[y][x];
      if (c !== "." && c !== "T") continue;
      let best = -1, bd = 9;
      for (const i of cellPlaces.get(Math.floor(y / GC) * gw + Math.floor(x / GC)) || []) {
        const p = places[i];
        const d = dist(p, x, y), reach = isHouseLike(p) ? 1 : 2;
        if (d <= reach && d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        const p = places[best];
        if (isHouseLike(p)) lotOf[y * W + x] = best;
        else { zoneOf[y * W + x] = p.style === "factory" ? 2 : 1; zoneOwn[y * W + x] = best; }
      } else if (inRects(downtown, x, y)) zoneOf[y * W + x] = 1;
    }
    // Back gardens run from the house to the next street when the land behind it is free (Hilltop's big
    // gardens); a neighbour's lot or anything built stops them.
    places.forEach((p, i) => {
      if (!isHouseLike(p)) return;
      const back = { s: [0, -1], n: [0, 1], e: [-1, 0], w: [1, 0] }[p.face];
      if (!back) return;
      const [bx, by] = back, along = bx === 0;
      const lo = along ? p.x - 1 : p.y - 1, hi = along ? p.x + p.w : p.y + p.h;
      for (let s = lo; s <= hi; s++) {
        let x = along ? s : bx > 0 ? p.x + p.w + 1 : p.x - 2, y = along ? (by > 0 ? p.y + p.h + 1 : p.y - 2) : s;
        for (let k = 0; k < 8; k++, x += bx, y += by) {
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          const c = tiles[y][x], j = y * W + x;
          if ((c !== "." && c !== "T") || placeIdx[j] >= 0 || zoneOf[j]) break;
          if (lotOf[j] >= 0) { if (lotOf[j] === i) continue; break; }
          lotOf[j] = i;
        }
      }
    });
    const lotTiles = places.map(() => []);
    for (let j = 0; j < N; j++) if (lotOf[j] >= 0) lotTiles[lotOf[j]].push([j % W, (j / W) | 0]);
    const parks = places.filter(p => p.kind === "park");
    const parkAt = new Int16Array(N).fill(-1);
    for (const p of parks) {
      const i0 = placeById.get(p.id);
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) parkAt[y * W + x] = i0;
      if (p.id === "square" || /square/i.test(p.name || "")) {
        for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) squareOf[y * W + x] = 1;
        continue;
      }
      const [ex, ey] = p.entry;
      const inPark = (x, y) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
      const mark = (x, y) => { if (inPark(x, y) && "PT".includes(at(x, y))) pathMask[y * W + x] = 1; };
      const col = Math.min(Math.max(ex, p.x), p.x + p.w - 1);
      for (let y = p.y; y < p.y + p.h; y++) mark(col, y);
      const mid = p.y + (p.h >> 1);
      for (let x = p.x; x < p.x + p.w; x++) mark(x, mid);
    }
    // driveways: the lot tile beside a house's entry (on the garage side for big houses)
    places.forEach((p, i) => {
      if (!isHouseLike(p) || !p.entry) return;
      const [ex, ey] = p.entry;
      const b = CV.bodyOf(p);
      const alongX = p.face === "n" || p.face === "s";
      let cands = alongX ? [[ex + 1, ey], [ex - 1, ey]] : [[ex, ey + 1], [ex, ey - 1]];
      if (p.style === "big_house" && alongX && ex + 0.5 > (b.x0 + b.x1) / 2) cands = [[ex - 1, ey], [ex + 1, ey]];
      const d = cands.find(([a, c]) => a >= 0 && c >= 0 && a < W && c < H && lotOf[c * W + a] === i);
      if (d) driveOf[d[1] * W + d[0]] = i;
    });
    // Open land: a block the map leaves empty becomes a playing field (Maple Grove), allotments (Riverside),
    // the works car park and depot (The Works, nearest first) or a rough meadow with a LAND FOR SALE board,
    // inside a one-tile grass verge. Woods stay woods. Purely visual: the tiles keep their codes.
    const USE = { pitch: 1, plot: 2, park: 3, yard: 4, meadow: 5, verge: 6 };
    const useOf = new Uint8Array(N), useK = new Uint8Array(N);
    const lands = [];
    {
      const free = (x, y) => { const c = tiles[y][x], j = y * W + x; return (c === "." || c === "T") && placeIdx[j] < 0 && lotOf[j] < 0 && !zoneOf[j]; };
      const cands = [];
      for (const d of town.districts) for (const r of d.rects || []) {
        const [rx, ry, rw, rh] = r;
        if (rw < 6 || rh < 6) continue;
        let n = 0, f = 0;
        for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { if (x < 0 || y < 0 || x >= W || y >= H) continue; n++; if (free(x, y)) f++; }
        if (n && f / n > 0.92) cands.push({ d: d.id, r });
      }
      const works = places.find(p => p.style === "factory");
      const far = c => works && works.entry ? Math.abs(c.r[0] + c.r[2] / 2 - works.entry[0]) + Math.abs(c.r[1] + c.r[3] / 2 - works.entry[1]) : 0;
      const give = (list, kinds) => list.forEach((c, k) => { c.kind = kinds[Math.min(k, kinds.length - 1)]; });
      give(cands.filter(c => c.d === "maple_grove").sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]), ["field", "meadow"]);
      give(cands.filter(c => c.d === "riverside").sort((a, b) => a.r[0] - b.r[0]), ["allotments", "meadow"]);
      give(cands.filter(c => c.d === "the_works").sort((a, b) => far(a) - far(b)), ["carpark", "depot", "meadow"]);
      for (const c of cands) {
        if (c.d === "east_woods") continue;
        const kind = c.kind || "meadow";
        const [rx, ry, rw, rh] = c.r;
        const inner = [rx + 1, ry + 1, rx + rw - 1, ry + rh - 1]; // x0, y0, x1, y1 (exclusive)
        const L = { kind, rect: c.r, inner, alongX: rw >= rh };
        lands.push(L);
        for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H || !free(x, y)) continue;
          const j = y * W + x, inIn = x >= inner[0] && x < inner[2] && y >= inner[1] && y < inner[3];
          const r = y - inner[1];
          if (kind === "meadow") useOf[j] = USE.meadow;
          else if (!inIn) useOf[j] = USE.verge;
          else if (kind === "field") { useOf[j] = USE.pitch; useK[j] = (L.alongX ? x - inner[0] : y - inner[1]) % 2; }
          else if (kind === "allotments") { useOf[j] = USE.plot; useK[j] = hash(`shed${x},${y}`) % 9 === 0 ? 6 : hash(`plot${x},${y}`) % 6; }
          else if (kind === "depot") useOf[j] = USE.yard;
          else { useOf[j] = USE.park; useK[j] = r % 3 === 1 ? 1 : r % 3 === 0 ? 0 : 2; } // 0 bays open south, 1 aisle, 2 bays open north
        }
        if (kind === "carpark") // the aisles run out through the verge to the street at each end
          for (let y = inner[1]; y < inner[3]; y++) if ((y - inner[1]) % 3 === 1) for (const x of [rx, rx + rw - 1]) {
            const j = y * W + x, nx = x === rx ? x - 1 : x + 1;
            if (x >= 0 && x < W && useOf[j] === USE.verge && R.isStreet(nx, y)) { useOf[j] = USE.park; useK[j] = 1; }
          }
      }
    }
    scene.useAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? 0 : useOf[y * W + x];
    scene.lotAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H || lotOf[y * W + x] < 0 ? null : places[lotOf[y * W + x]].id;
    scene.lands = lands;
    const isRoad = (x, y) => {
      if (x >= 0 && y >= 0 && x < W && y < H) return R.isStreet(x, y);
      // roads run off the map's edges
      const cx = Math.max(0, Math.min(W - 1, x)), cy = Math.max(0, Math.min(H - 1, y));
      if (y >= 0 && y < H) return R.isStreet(cx, y) && (x < 0 || x >= W);
      if (x >= 0 && x < W) return y < 0 && R.isStreet(x, 0);
      return false;
    };
    const stopAt = new Map();
    for (const s of town.stops) stopAt.set(s.y * W + s.x, s);
    const junctionSet = new Set(town.junctions.map(([x, y]) => y * W + x));

    const NEW_CODES = CV.groundKey ? "#bx=rSHhF~" : "=rSHhF"; // the region's streets, rails, highways, farms, water: V2's tiles
    const stageOf = p => { if (p.kind !== "home") return 0; const l = scene.looks[p.id]; return l ? l.stage | 0 : 0; };
    function groundSprite(x, y) {
      const c = tiles[y][x], i = y * W + x, v = variant[i], s = scene.season;
      if (BIG && NEW_CODES.includes(c)) { // the region's codes (region.md 3.1): V2's groundKey, else a stand-in
        if (CV.groundKey) { const k = CV.groundKey(R, x, y, s); const f = k && (typeof k[0] === "function" ? k[0] : art[k[0]]); if (f) return f.apply(art, k.slice(1)); }
        if (c === "H" || c === "h") { const m = (a, b) => R.isRoadLike(a, b) && !R.isStreet(a, b) ? 1 : 0; return art.road(m(x, y - 1) | m(x + 1, y) << 1 | m(x, y + 1) << 2 | m(x - 1, y) << 3, 0, s, v % 4); }
        if (c === "F") return art.meadow(s, v);
        return art.pavement(v % 2, c === "S" ? "#c8c0b0" : "#8a8070", 0, s);
      }
      if (R.isStreet(x, y)) {
        const mask = (isRoad(x, y - 1) ? 1 : 0) | (isRoad(x + 1, y) ? 2 : 0) | (isRoad(x, y + 1) ? 4 : 0) | (isRoad(x - 1, y) ? 8 : 0);
        const diag = (isRoad(x + 1, y - 1) ? 1 : 0) | (isRoad(x + 1, y + 1) ? 2 : 0) | (isRoad(x - 1, y + 1) ? 4 : 0) | (isRoad(x - 1, y - 1) ? 8 : 0);
        return art.road(mask, diag, s, v % 4);
      }
      if (c === "~") {
        const L = (a, b) => { const t = at(a, b); return t !== null && t !== "~"; };
        return art.water((L(x, y - 1) ? 1 : 0) | (L(x + 1, y) ? 2 : 0) | (L(x, y + 1) ? 4 : 0) | (L(x - 1, y) ? 8 : 0), v % 4);
      }
      if (squareOf[i]) return art.pavement(v % 2, "#d6cfbf");
      if (c === "B" || c === "D") {
        const p = places[placeIdx[i]];
        if (p && isHouseLike(p)) { const look = scene.looks[p.id]; return art.lawn(s, look ? look.stage | 0 : 0, v % 4); }
        return art.apron(v % 4, p ? stageOf(p) : 0, s);
      }
      if (c === "e") {
        const p = places[entryOf.get(i)];
        if (p && p.kind === "park") return art.path(s, 15);
        const axis = p && (p.face === "e" || p.face === "w") ? "x" : "y";
        return art.entry(s, axis, zoneOf[i] === 1 || (p && !isHouseLike(p)), p ? stageOf(p) : 0);
      }
      if (pathMask[i]) {
        const m = (a, b) => (a >= 0 && b >= 0 && a < W && b < H && (pathMask[b * W + a] || (at(a, b) === "e" && entryOf.has(b * W + a) && places[entryOf.get(b * W + a)].kind === "park"))) ? 1 : 0;
        return art.path(s, m(x, y - 1) | m(x + 1, y) << 1 | m(x, y + 1) << 2 | m(x - 1, y) << 3);
      }
      const u = useOf[i];
      if (u) {
        if (u === USE.pitch) return art.pitch(s, useK[i]);
        if (c === "T" || (u === USE.plot && useK[i] === 6)) return u === USE.meadow ? art.meadow(s, v) : art.grass(s, v);
        if (u === USE.plot) return art.plot(s, useK[i], v % 2);
        if (u === USE.park) return art.parking(s, ["bayS", "aisle", "bayN"][useK[i]], v % 4);
        if (u === USE.yard) return art.yard(v % 4);
        if (u === USE.meadow) return art.meadow(s, v);
        return art.grass(s, v);
      }
      if (c === "P" || (c === "T" && parkAt[i] >= 0)) return art.park(s, v % 4);
      if (driveOf[i] >= 0) {
        const p = places[driveOf[i]], look = scene.looks[p.id];
        return art.drive(s, look ? look.stage | 0 : 0, p.face === "e" || p.face === "w" ? "x" : "y", v % 4);
      }
      if (lotOf[i] >= 0) { const look = scene.looks[places[lotOf[i]].id]; return art.lawn(s, look ? look.stage | 0 : 0, v % 4); }
      if (zoneOf[i] === 1) return art.pavement(v % 2, null, zoneOwn[i] >= 0 ? stageOf(places[zoneOwn[i]]) : 0, s);
      if (zoneOf[i] === 2) return art.yard(v % 4);
      return art.grass(s, v);
    }

    // --- static items --------------------------------------------------------------------------------------
    // item: { img, sx, sy, sw, sh, wx, wy (world px of the sprite's top-left), depth, kind, ref }
    let statics = [], buildings = [], lampPts = [], signals = [], shelters = [], dirty = true;
    const lowerBound = (arr, d) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].depth < d) lo = m + 1; else hi = m; } return lo; };
    const bCache = new Map();
    function addSprite(list, spr, tx, ty, depth, kind, ref) {
      const p = proj.toWorld(tx, ty);
      const it = { img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0] - spr.ax), wy: Math.round(p[1] - spr.ay), depth, kind, ref };
      list.push(it);
      return it;
    }
    const lookSig = p => { const l = scene.looks[p.id]; if (!l) return "-"; return [l.stage | 0, l.works ? 1 : 0, (l.units || []).map(u => (u.vacant ? "v" : "o") + (u.listing ? "l" : "")).join("")].join(":"); };
    function buildingSprite(p) {
      const key = `${p.id}|${lookSig(p)}|${scene.season}`;
      let b = bCache.get(key);
      if (!b) { b = art.building(p, scene.looks[p.id], scene.season); b.key = key; bCache.set(key, b); }
      return b;
    }
    function hull(pts) {
      pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }
    const inHull = (h, x, y) => { for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false; } return true; };
    scene.inHull = inHull;

    // A home's lot tiles that touch a road, nearest the camera (largest depth) first. The moving van and the
    // SALE / RENT / LET board stand on them (PLAN decision 83), so they read even when the door is on a wall
    // turned away from the camera. A house's lot is its garden; a block of flats has none, so its paved apron
    // stands in. road: the side of the tile that meets the road (the camera-nearest one on a corner tile).
    // Ties go to the tile nearer the door. A tile where a nearer building or kerbside prop would hide most of
    // the board (hidden: 55 Main Street's corner behind the Grand Arcade, 66 Park Avenue's behind the City
    // Hall bus shelter) goes after those where it shows. Worked out once per static rebuild.
    const SIDES = [["n", 0, -1], ["e", 1, 0], ["s", 0, 1], ["w", -1, 0]];
    let frontCache = new Map();
    function frontTiles(p, i) {
      let out = frontCache.get(i);
      if (!out) { out = frontTilesOf(p, i); frontCache.set(i, out); }
      return out;
    }
    function frontTilesOf(p, i) {
      const own = [];
      if (isHouseLike(p)) own.push(...lotTiles[i]);
      else for (let y = p.y - 2; y < p.y + p.h + 2; y++) for (let x = p.x - 2; x < p.x + p.w + 2; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && zoneOwn[y * W + x] === i && zoneOf[y * W + x] === 1) own.push([x, y]);
      }
      const [ex, ey] = p.entry || [p.x, p.y];
      const out = [];
      for (const [x, y] of own) {
        const road = SIDES.filter(([, dx, dy]) => R.isStreet(x + dx, y + dy))
          .sort((a, b) => proj.depth(x + b[1] + 0.5, y + b[2] + 0.5) - proj.depth(x + a[1] + 0.5, y + a[2] + 0.5));
        if (!road.length) continue;
        const t = { x, y, road: road[0][0], depth: proj.depth(x + 0.5, y + 0.5), drive: driveOf[y * W + x] === i, near: Math.abs(x - ex) + Math.abs(y - ey) };
        t.hidden = boardCover(p, t) > 0.34;
        out.push(t);
      }
      out.sort((a, b) => a.hidden - b.hidden || b.depth - a.depth || a.near - b.near || b.x - a.x || b.y - a.y);
      return out;
    }
    // Where a board on lot tile t stands: a quarter tile in from the road edge (further in beside the van),
    // leaning toward its own home.
    function signAt(p, t, byVan) {
      let [a, b] = towardRoad(t, byVan ? 0.4 : 0.25);
      if (t.road === "n" || t.road === "s") a += Math.max(-0.22, Math.min(0.22, p.x + p.w / 2 - a));
      else b += Math.max(-0.22, Math.min(0.22, p.y + p.h / 2 - b));
      return [a, b];
    }
    // The world rect of a board on lot tile t (the board, not its post), and its depth.
    function boardRect(p, t) {
      const [a, b] = signAt(p, t, false), spr = art.sign("sale"), w = proj.toWorld(a, b);
      const x0 = Math.round(w[0] - spr.ax) + 1, y0 = Math.round(w[1] - spr.ay) + 1;
      return { x0, y0, x1: x0 + 24, y1: y0 + 12, depth: proj.depth(a, b) };
    }
    // The share of a board on lot tile t that buildings, and the props drawn before boards are placed
    // (bus shelters with their line plates, traffic lights, trees), nearer the camera cover.
    let coverProps = [], bGrid = null, pGrid = null;
    // a small world-px grid (256 px cells) of objects by their rect: buildings or props near a board
    function gridOf(list, rect) {
      const m = new Map();
      for (const o of list) {
        const [x0, y0, x1, y1] = rect(o);
        for (let gy = Math.floor(y0 / 256); gy <= Math.floor(y1 / 256); gy++) for (let gx = Math.floor(x0 / 256); gx <= Math.floor(x1 / 256); gx++) {
          const k = gx + ":" + gy; let l = m.get(k); if (!l) m.set(k, l = []); l.push(o);
        }
      }
      return m;
    }
    function gridGet(m, x0, y0, x1, y1) {
      if (!m) return [];
      const out = new Set();
      for (let gy = Math.floor(y0 / 256); gy <= Math.floor(y1 / 256); gy++) for (let gx = Math.floor(x0 / 256); gx <= Math.floor(x1 / 256); gx++) { const l = m.get(gx + ":" + gy); if (l) for (const o of l) out.add(o); }
      return [...out];
    }
    function boardCover(p, t) {
      const { x0, y0, x1, y1, depth } = boardRect(p, t);
      const near = (BIG ? gridGet(bGrid, x0, y0, x1, y1) : buildings).filter(B => B.b.ox < x1 && B.b.ox + B.b.c.width > x0 && B.b.oy < y1 && B.b.oy + B.b.c.height > y0);
      const props = (BIG ? gridGet(pGrid, x0, y0, x1, y1) : coverProps).filter(it => it.depth > depth && it.wx < x1 && it.wx + it.sw > x0 && it.wy < y1 && it.wy + it.sh > y0);
      if (!near.length && !props.length) return 0;
      let n = 0, hid = 0;
      for (let x = x0 + 1; x < x1; x += 2) for (let y = y0 + 1; y < y1; y += 2) {
        n++;
        if (near.some(B => { const sl = B.slices.find(q => x >= q.wx && x < q.wx + q.sw); return !!sl && sl.depth > depth && opaqueAt(B, x, y); })
          || props.some(it => propOpaque(it, x, y))) hid++;
      }
      return hid / n;
    }
    // Is a static prop's sprite solid at world point (wx, wy)? Its alpha is read once per sprite canvas.
    const propMasks = new WeakMap();
    function propOpaque(it, wx, wy) {
      let k = propMasks.get(it.img);
      if (!k) {
        const w = it.img.width, h = it.img.height, c = CV.canvas(w, h), q = c.getContext("2d", { willReadFrequently: true });
        q.drawImage(it.img, 0, 0);
        const d = q.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
        for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 40 ? 1 : 0;
        k = { m, w };
        propMasks.set(it.img, k);
      }
      const x = Math.floor(wx - it.wx), y = Math.floor(wy - it.wy);
      return x >= 0 && y >= 0 && x < it.sw && y < it.sh && k.m[(y + it.sy) * k.w + x + it.sx] === 1;
    }
    // The van takes the camera-nearest road lot tile where a board would show; the board takes it too, or the
    // next one while the van or a car parked on the driveway (carOn) has it.
    function lotSpots(p, i, moving, carOn) {
      const front = frontTiles(p, i);
      const van = moving && front.length ? front[0] : null;
      const sign = front.find(t => t !== van && !(carOn && t.drive)) || front.find(t => t !== van) || front[0] || null;
      return { front, van, sign };
    }
    scene.lotSpots = id => {
      const i = placeById.get(id), p = places[i];
      if (!p || p.kind !== "home") return null;
      if (dirty || !statics.length) buildStatics();
      const l = scene.looks[p.id] || {}, car = scene.parked.has(p.id), s = lotSpots(p, i, !!l.moving, car);
      const xy = t => t ? [t.x, t.y] : null;
      return { front: s.front.map(t => ({ x: t.x, y: t.y, depth: t.depth, drive: t.drive, road: t.road, hidden: t.hidden })), van: l.moving ? xy(s.van) : null,
        sign: (isHouseLike(p) ? l.listing : l.anyListed) ? xy(s.sign) : null, car };
    };
    // The homes with a car parked on the driveway now (the movers set it every frame). A listed home's board
    // keeps off the driveway only while a car stands there, so a change at a listed home rebuilds the statics.
    scene.parked = new Set();
    let parkedKey = "";
    scene.setParked = set => {
      scene.parked = set;
      const key = [...set].filter(id => { const l = scene.looks[id]; return l && (l.listing || l.anyListed); }).sort().join(",");
      if (key !== parkedKey) {
        if (BIG && statics.length && !dirty) { // only the homes whose board moves
          const a = new Set(parkedKey ? parkedKey.split(",") : []), b = new Set(key ? key.split(",") : []);
          scene.updatePlaces([...new Set([...a, ...b])].filter(id => a.has(id) !== b.has(id)));
        } else dirty = true;
        parkedKey = key;
      }
    };
    // The tile beside a home's door walk (a house's garden tile next to it, a block's apron), kept clear of lamps.
    function besideDoor(p, i) {
      if (p.kind !== "home" || !p.entry) return null;
      const [ex, ey] = p.entry;
      if (isHouseLike(p)) {
        const alongX = p.face === "n" || p.face === "s";
        return (alongX ? [[ex - 1, ey], [ex + 1, ey]] : [[ex, ey - 1], [ex, ey + 1]]).find(([a, b]) => lotOf[b * W + a] === i && driveOf[b * W + a] !== i) || null;
      }
      return [[ex + 1, ey], [ex - 1, ey], [ex, ey + 1], [ex, ey - 1]].find(([a, b]) => at(a, b) === "." || at(a, b) === "e") || null;
    }
    // A point a quarter tile in from a lot tile's road edge, and the van's heading along that road.
    const towardRoad = (t, k) => { const [, dx, dy] = SIDES.find(q => q[0] === t.road); return [t.x + 0.5 + dx * k, t.y + 0.5 + dy * k]; };

    // A home's lot items (view.md 3.3.3: also re-inserted alone when its look changes): fences or hedges, the
    // listing board, junk, the skip and the moving van, all with ref = the place's index.
    const LOT_KINDS = new Set(["f", "j", "s", "van"]);
    function lotItems(list, p, i) {
      const snowy = !!(CV.SEASON[scene.season] && CV.SEASON[scene.season].snow);
      const look = scene.looks[p.id] || { stage: 0 };
      const stage = look.stage | 0;
      const spots = lotSpots(p, i, !!look.moving, scene.parked.has(p.id));
      const listed = isHouseLike(p) ? (look.listing === "for_sale" ? "sale" : look.listing === "for_rent" ? "rent" : null) : look.anyListed ? "let" : null;
      const taken = (x, y) => [spots.van, listed ? spots.sign : null].some(t => t && t.x === x && t.y === y);
      if (isHouseLike(p)) {
        const inLot = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (lotOf[y * W + x] === i || placeIdx[y * W + x] === i || (p.entry && x === p.entry[0] && y === p.entry[1]));
        const hedge = p.style === "big_house";
        for (const [x, y] of lotTiles[i]) {
          if (driveOf[y * W + x] === i) continue;
          const v = hash(`${x}.${y}`) % 4;
          if (hedge && dist(p, x, y) >= 2 && tiles[y][x] === "." && hash(`gt${x},${y}`) % 7 === 0) // trees in the back garden
            { const tv = hash(`gv${x}`) % 6; addSprite(list, art.tree(scene.season, "round", tv), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t").remake = s => art.tree(s, "round", tv); }
          const edges = [["n", x, y - 1, 0.5, 0.06], ["s", x, y + 1, 0.5, 0.94], ["w", x - 1, y, 0.06, 0.5], ["e", x + 1, y, 0.94, 0.5]];
          for (const [side, nx, ny, ex, ey] of edges) {
            if (inLot(nx, ny)) continue;
            if (spots.van && spots.van.x === x && spots.van.y === y && side === spots.van.road) continue; // the van backed in through here
            const spr = hedge ? art.hedge(stage, side, scene.season, v) : art.fence(stage, side, v);
            const fit = addSprite(list, spr, x + 0.5, y + 0.5, proj.depth(x + ex, y + ey) + 0.02, "f", i);
            if (hedge) fit.remake = s => art.hedge(stage, side, s, v);
          }
        }
        // junk on the lot tile nearest the camera that the van and the board leave free
        let best = null, bd = -1e9;
        for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H || lotOf[y * W + x] !== i || driveOf[y * W + x] === i || taken(x, y)) continue;
          const d = proj.depth(x + 0.5, y + 0.5) - Math.abs(x - (p.x + p.w / 2)) * 0.3;
          if (d > bd) { bd = d; best = [x, y]; }
        }
        if (stage >= 2 && best) addSprite(list, art.junk(stage, hash(p.id) % 3, snowy), best[0] + 0.4, best[1] + 0.35, proj.depth(best[0] + 0.4, best[1] + 0.35), "j", i);
        if (look.works && best) addSprite(list, art.skip(), best[0] + 0.5, best[1] + 0.6, proj.depth(best[0] + 0.5, best[1] + 0.6), "j", i);
      } else {
        const [ex, ey] = p.entry;
        const side = [[ex + 1, ey], [ex - 1, ey], [ex, ey + 1], [ex, ey - 1]].filter(([a, b]) => (at(a, b) === "." || at(a, b) === "e") && !taken(a, b));
        // rubbish on the apron by the door of a run-down block: overflowing bins from shabby, then bags, a
        // mattress and scrap
        const o = side[1] || side[0];
        if (stage >= 2 && o) addSprite(list, art.junk(stage >= 4 ? 4 : 2, hash(p.id) % 3, snowy), o[0] + 0.5, o[1] + 0.45, proj.depth(o[0] + 0.5, o[1] + 0.45), "j", i);
        if (stage >= 4 && side[0] && side[0] !== o) addSprite(list, art.junk(3, (hash(p.id) + 1) % 3, snowy), side[0][0] + 0.3, side[0][1] + 0.6, proj.depth(side[0][0] + 0.3, side[0][1] + 0.6), "j", i);
      }
      if (listed && spots.sign) { // the board, a quarter tile in from the road edge, leaning toward its own home
        const [a, b] = signAt(p, spots.sign, spots.sign === spots.van);
        addSprite(list, art.sign(listed), a, b, proj.depth(a, b), "s", i);
      }
      if (spots.van) { // the moving van, backed onto the lot along the road
        const t = spots.van, [a, b] = towardRoad(t, 0.08), d = t.road === "n" || t.road === "s" ? 0 : 1;
        addSprite(list, art.van(d), a, b, proj.depth(a, b) + 0.05, "van", i);
      }
    }
    function buildStatics() {
      const t0 = performance.now();
      const list = [];
      buildings = [];
      if (BIG) bigBuildings(list);
      else places.forEach((p, i) => {
        if (p.kind === "park") return;
        const b = buildingSprite(p);
        const slices = proj.slices(p.x, p.y, p.x + p.w, p.y + p.h);
        const left = b.ox, right = b.ox + b.c.width;
        const rec = { i, p, b, slices: [], depth: Math.max(...slices.map(s => s.depth)), top: b.height };
        slices.forEach((s, k) => {
          const x0 = k === 0 ? left : Math.max(left, s.wx0), x1 = k === slices.length - 1 ? right : Math.min(right, s.wx1);
          if (x1 <= x0) return;
          const it = { img: b.c, sx: x0 - b.ox, sy: 0, sw: x1 - x0, sh: b.c.height, wx: x0, wy: b.oy, depth: s.depth, kind: "b", ref: i, rec };
          list.push(it); rec.slices.push(it);
        });
        const pts = [];
        const bd = CV.bodyOf(p);
        const hx0 = Math.min(bd.x0, p.x + 0.1), hy0 = Math.min(bd.y0, p.y + 0.1), hx1 = Math.max(bd.x1, p.x + p.w - 0.1), hy1 = Math.max(bd.y1, p.y + p.h - 0.1);
        for (const [x, y] of [[bd.x0, bd.y0], [bd.x1, bd.y0], [bd.x1, bd.y1], [bd.x0, bd.y1]]) { pts.push(proj.toWorld(x, y, 0)); pts.push(proj.toWorld(x, y, b.height)); }
        rec.hull = hull(pts);
        rec.ground = hull([[hx0, hy0], [hx1, hy0], [hx1, hy1], [hx0, hy1]].map(([x, y]) => proj.toWorld(x, y, 0)));
        rec.label = proj.toWorld((bd.x0 + bd.x1) / 2, (bd.y0 + bd.y1) / 2, b.labelZ);
        rec.center = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2, b.height / 2);
        buildings.push(rec);
      });
      frontCache = new Map(); // the lots' front tiles depend on the buildings just drawn
      // trees, benches, park furniture
      const woods = (town.districts.find(d => d.id === "east_woods") || { rects: [] }).rects;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = tiles[y][x], i = y * W + x;
        if (c === "T" && useOf[i] === USE.pitch) continue; // the playing field is kept clear
        if (c === "T") {
          const hv = hash(`${x},${y}`);
          const pine = inRects(woods, x, y) ? hv % 3 !== 0 : (parkAt[i] < 0 && hv % 6 === 0);
          const ox = ((hv >>> 8) % 7 - 3) * 0.04, oy = ((hv >>> 12) % 7 - 3) * 0.04;
          const tk = pine ? "pine" : "round", tv = (hv >>> 4) % 6;
          addSprite(list, art.tree(scene.season, tk, tv), x + 0.5 + ox, y + 0.5 + oy, proj.depth(x + 0.5 + ox, y + 0.5 + oy), "t").remake = s => art.tree(s, tk, tv);
        } else if (c === "P" && !pathMask[i] && hash(`b${x}:${y}`) % 11 === 0) {
          const bv = hash(`v${x}`) % 4;
          addSprite(list, art.tree(scene.season, "bush", bv), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t").remake = s => art.tree(s, "bush", bv);
        }
        if (pathMask[i] && hash(`b${x},${y}`) % 4 === 0) addSprite(list, art.bench(), x + 0.82, y + 0.3, proj.depth(x + 0.82, y + 0.3), "p");
      }
      // traffic lights on the two kerb corners that sit left and right on screen (north-east and south-west
      // at rotation 0), so the two poles never stack into one post in the middle of the junction
      signals = [];
      const cornerPts = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
      const sx = ([u, v]) => { const q = proj.toWorld(u, v); return q[0] - q[1] * 1e-3; };
      const left = cornerPts.reduce((m, c) => sx(c) < sx(m) ? c : m), right = cornerPts.reduce((m, c) => sx(c) > sx(m) ? c : m);
      for (const [x, y] of town.junctions) {
        if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) continue;
        const a = addSprite(list, art.signal(scene.lights.ns || "green"), x + left[0], y + left[1], proj.depth(x + left[0], y + left[1]), "sig");
        const b = addSprite(list, art.signal(scene.lights.ew || "red"), x + right[0], y + right[1], proj.depth(x + right[0], y + right[1]), "sig");
        signals.push([a, "ns"], [b, "ew"]);
      }
      // bus stop shelters on the kerb
      shelters = [];
      for (const s of town.stops) {
        const rowRoad = town.road_rows.includes(s.y);
        const tx = rowRoad ? s.x + 0.5 : s.x + 0.06, ty = rowRoad ? s.y + 0.06 : s.y + 0.5;
        shelters.push(addSprite(list, art.shelter((s.lines || ["1"]).join(",")), tx, ty, proj.depth(tx, ty), "stop", s.id));
      }
      // what stands nearer the camera than a board can hide it (boardCover): kerbside props placed so far
      coverProps = list.filter(it => it.kind === "t" || it.kind === "sig" || it.kind === "stop");
      if (BIG) { bGrid = gridOf(buildings, B => [B.b.ox, B.b.oy, B.b.ox + B.b.c.width, B.b.oy + B.b.c.height]); pGrid = gridOf(coverProps, it => [it.wx, it.wy, it.wx + it.sw, it.wy + it.sh]); }
      // street lamps on the north kerb of east-west roads and the west kerb of north-south roads; a lamp never
      // stands in front of a door's walk, the tile beside it or a lot's board (SALE, RENT, LET), nor in front
      // of the board on screen: it moves a tile along, or goes
      const boards = new Set(), boardRects = [];
      places.forEach((p, i) => {
        if (p.entry) boards.add(p.entry[1] * W + p.entry[0]);
        const b = besideDoor(p, i);
        if (b) boards.add(b[1] * W + b[0]);
        // the board's tile with and without a car on the driveway, so a car coming home never moves a lamp
        if (p.kind === "home") for (const car of [false, true]) { const t = lotSpots(p, i, false, car).sign; if (t) { boards.add(t.y * W + t.x); boardRects.push(boardRect(p, t)); } }
      });
      lampPts = [];
      const nearJ = (x, y) => junctionSet.has(y * W + x) || junctionSet.has(y * W + x + 1) || junctionSet.has(y * W + x - 1) || junctionSet.has((y + 1) * W + x) || junctionSet.has((y - 1) * W + x);
      const coversBoard = (lx, ly) => { // the lamp at tile point (lx, ly) is drawn over a board's face
        const w = proj.toWorld(lx, ly), d = proj.depth(lx, ly), x0 = w[0] - 2, y0 = w[1] - 41, x1 = w[0] + 9, y1 = w[1];
        return boardRects.some(r => d > r.depth && x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
      };
      const lampOk = (x, y, bx, by, lx, ly) => R.isStreet(x, y) && !R.isStreet(bx, by) && !nearJ(x, y) && !stopAt.has(y * W + x) && !boards.has(by * W + bx) && !coversBoard(lx, ly);
      for (const ry of town.road_rows) for (let x0 = 2; x0 < W; x0 += 4) {
        const x = [x0, x0 + 1, x0 - 1].find(a => a >= 0 && a < W && lampOk(a, ry, a, ry - 1, a + 0.5, ry + 0.07));
        if (x == null) continue;
        addSprite(list, art.lamp(), x + 0.5, ry + 0.07, proj.depth(x + 0.5, ry + 0.07), "l");
        lampPts.push([x + 0.5, ry + 0.07]);
      }
      for (const rx of town.road_cols) for (let y0 = 2; y0 < H; y0 += 4) {
        const y = [y0, y0 + 1, y0 - 1].find(b => b >= 0 && b < H && lampOk(rx, b, rx - 1, b, rx + 0.07, b + 0.5));
        if (y == null) continue;
        addSprite(list, art.lamp(), rx + 0.07, y + 0.5, proj.depth(rx + 0.07, y + 0.5), "l");
        lampPts.push([rx + 0.07, y + 0.5]);
      }
      // home lots: fences or hedges, listing signs, junk, works and moving vans
      places.forEach((p, i) => { if (p.kind === "home") lotItems(list, p, i); });
      // open land: goals and benches on the field, sheds and a wire fence round the allotments, parked cars,
      // containers and vans in the depot, bushes, trees and a LAND FOR SALE board on the meadows
      const deepest = pts => Math.max(...pts.map(([a, b]) => proj.depth(a, b)));
      for (const L of lands) {
        const [ix0, iy0, ix1, iy1] = L.inner, [rx, ry, rw, rh] = L.rect;
        const tilesIn = (u, f) => { for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) if (x >= 0 && y >= 0 && x < W && y < H && useOf[y * W + x] === u) f(x, y, y * W + x); };
        if (L.kind === "field") {
          const m = 0.3, x0 = ix0 + m, y0 = iy0 + m, x1 = ix1 - m, y1 = iy1 - m, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
          const ends = L.alongX ? [[x0, ym, -1], [x1, ym, 1]] : [[xm, y0, -1], [xm, y1, 1]];
          for (const [gx, gy, e] of ends) addSprite(list, art.goal(L.alongX, e), gx, gy, proj.depth(gx, gy) + 0.3, "p");
          const bench = L.alongX ? [[xm - 1.6, iy1 + 0.35], [xm + 1.6, iy1 + 0.35]] : [[ix1 + 0.35, ym - 1.6], [ix1 + 0.35, ym + 1.6]];
          for (const [bx, by] of bench) addSprite(list, art.bench(), bx, by, proj.depth(bx, by), "p");
        } else if (L.kind === "allotments") {
          tilesIn(USE.plot, (x, y, j) => {
            if (useK[j] === 6) addSprite(list, art.shed(hash(`sv${x}`) % 4), x + 0.5, y + 0.5, proj.depth(x + 0.75, y + 0.75), "p");
            for (const [side, nx, ny, ex, ey] of [["n", x, y - 1, 0.5, 0.06], ["s", x, y + 1, 0.5, 0.94], ["w", x - 1, y, 0.06, 0.5], ["e", x + 1, y, 0.94, 0.5]]) {
              if (nx >= 0 && ny >= 0 && nx < W && ny < H && useOf[ny * W + nx] === USE.plot) continue;
              if ((side === "s" || side === "n") && x === Math.floor((ix0 + ix1) / 2)) continue; // a gate
              addSprite(list, art.wire(side), x + 0.5, y + 0.5, proj.depth(x + ex, y + ey) + 0.02, "f");
            }
          });
        } else if (L.kind === "carpark") {
          tilesIn(USE.park, (x, y, j) => {
            if (useK[j] === 1 || tiles[y][x] === "T") return;
            for (const k of [0, 1]) {
              const h = hash(`car${x},${y},${k}`);
              if (h % 10 >= 6) continue;
              const tx = x + 0.26 + k * 0.48, ty = y + 0.5, d = (useK[j] === 0 ? 3 : 1) ^ (h % 7 === 0 ? 2 : 0);
              addSprite(list, art.car(CV.carColor(`lot${x}:${y}:${k}`), "car", d), tx, ty, proj.depth(tx, ty) + 0.02, "p");
            }
          });
        } else if (L.kind === "depot") {
          const COL = ["#b8452e", "#2f6aa8", "#3f8a4a", "#d0882a", "#7a7f88", "#a83a6a", "#2a8a8a"];
          const a0 = L.alongX ? ix0 : iy0, a1 = L.alongX ? ix1 : iy1, b0 = L.alongX ? iy0 : ix0, b1 = L.alongX ? iy1 : ix1;
          let n = 0;
          for (let b = b0 + 0.7; b < b1 - 0.4; b += 1.45) for (let a = a0 + 1.05; a + 0.75 <= a1 - 0.2; a += 1.8) {
            const h = hash(`ct${Math.round(a * 10)},${Math.round(b * 10)}`);
            if (h % 5 === 0) { if (n++ % 2 === 0) { const [tx, ty] = L.alongX ? [a, b] : [b, a]; addSprite(list, art.van(L.alongX ? 0 : 1), tx, ty, proj.depth(tx, ty) + 0.05, "p"); } continue; }
            const [cx, cy] = L.alongX ? [a, b] : [b, a];
            const foot = L.alongX ? [[cx - 0.75, cy - 0.25], [cx + 0.75, cy + 0.25]] : [[cx - 0.25, cy - 0.75], [cx + 0.25, cy + 0.75]];
            const d = deepest([[foot[0][0], foot[0][1]], [foot[1][0], foot[0][1]], [foot[1][0], foot[1][1]], [foot[0][0], foot[1][1]]]);
            addSprite(list, art.container(COL[h % COL.length], (h >>> 5) % 5 < 2 ? COL[(h >>> 8) % COL.length] : null, L.alongX), cx, cy, d, "p");
          }
        } else { // meadow
          let sign = null, sd = -1e9;
          tilesIn(USE.meadow, (x, y) => {
            if (tiles[y][x] !== ".") return;
            const h = hash(`md${x},${y}`);
            if (h % 11 === 0) addSprite(list, art.tree(scene.season, "bush", (h >>> 4) % 4), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t").remake = s => art.tree(s, "bush", (h >>> 4) % 4);
            else if (h % 29 === 1) addSprite(list, art.tree(scene.season, "round", (h >>> 4) % 6), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t").remake = s => art.tree(s, "round", (h >>> 4) % 6);
            const road = R.isStreet(x, y + 1) || R.isStreet(x + 1, y) || R.isStreet(x, y - 1) || R.isStreet(x - 1, y);
            if (road && proj.depth(x, y) > sd) { sd = proj.depth(x, y); sign = [x, y]; }
          });
          if (sign) addSprite(list, art.landSign(), sign[0] + 0.5, sign[1] + 0.5, proj.depth(sign[0] + 0.5, sign[1] + 0.5), "s");
        }
      }
      // shop dressing: cafe tables, market crates, the school flag
      for (const p of places) {
        if (p.kind === "home" || p.kind === "park") continue;
        const frontRow = (p.face === "s" || !proj.faces.includes(p.face)) ? p.y + p.h : p.y - 1;
        if (p.style === "cafe" || p.style === "noodle_bar") {
          const row = p.face === "n" && proj.faces.includes("s") ? p.y + p.h : frontRow;
          for (const fx of [0.3, 0.7]) { const x = p.x + p.w * fx, y = row + 0.45; if (zoneOf[Math.floor(y) * W + Math.floor(x)] === 1) addSprite(list, art.table(p.style === "cafe" ? "#8a4fa0" : "#c0392b"), x, y, proj.depth(x, y), "p"); }
        }
        if (p.style === "market") for (const fx of [0.2, 0.8]) { const x = p.x + p.w * fx, y = p.y + p.h + 0.35; if (at(Math.floor(x), Math.floor(y)) === ".") addSprite(list, art.crates(Math.round(fx * 10)), x, y, proj.depth(x, y), "p"); }
        if (p.style === "school" && p.entry) { const x = p.entry[0] + 0.6, y = p.entry[1] - 1.4; if (at(Math.floor(x), Math.floor(y)) === ".") addSprite(list, art.flag("#3a6ad6"), x, y, proj.depth(x, y), "p"); }
      }
      list.sort((a, b) => a.depth - b.depth || a.wx - b.wx);
      statics = list;
      dirty = false;
      occlusion = null; lampOcc.clear(); lampMasks = 0;
      staticsVersion++;
      scene.stats.statics_builds++;
      scene.stats.staticsMs = performance.now() - t0;
    }
    // The region's buildings (places and decor) from geometry alone (view.md 3.3.1): rect, slices, hull, label and
    // centre come from CV.spriteBox, never from art.building. rec.b stands in for the sprite until one is
    // attached (attach), with a canvas-shaped {width, height} so the v2 tests that read its size still work.
    function bigBuildings(list) {
      for (const B of R.buildings) {
        const p = B.p, i = B.decor ? -1 : placeById.get(p.id);
        const kp = B.kp || (B.kp = Object.assign({}, p, { variant: B.variant }));
        const box = art.spriteBox ? art.spriteBox(kp, scene.looks[p.id]) : CV.spriteBox(kp, scene.looks[p.id], proj);
        const b = { c: { width: box.w, height: box.h, fake: true }, ox: box.ox, oy: box.oy, height: box.height, labelZ: box.labelZ, windows: [], lights: [],
          porch: null, neon: null, smoke: null, beacon: null, id: B.sid, litShare: p.kind === "home" ? 70 : p.style === "tower" ? 45 : 60 };
        const slices = proj.slices(p.x, p.y, p.x + p.w, p.y + p.h);
        const left = b.ox, right = b.ox + box.w;
        const o0 = proj.toWorld(0, 0), o1 = proj.toWorld(p.x, p.y);
        const rec = { i, p, b, B, big: true, decor: B.decor, slices: [], depth: Math.max(...slices.map(s => s.depth)), top: b.height, dx: o1[0] - o0[0], dy: o1[1] - o0[1], att: null, lastKey: null };
        slices.forEach((s, k) => {
          const x0 = k === 0 ? left : Math.max(left, s.wx0), x1 = k === slices.length - 1 ? right : Math.min(right, s.wx1);
          if (x1 <= x0) return;
          const it = { img: null, sx: x0 - b.ox, sy: 0, sw: x1 - x0, sh: box.h, wx: x0, wy: b.oy, depth: s.depth, kind: "b", ref: i, rec };
          list.push(it); rec.slices.push(it);
        });
        const pts = [], bd = CV.bodyOf(p);
        const hx0 = Math.min(bd.x0, p.x + 0.1), hy0 = Math.min(bd.y0, p.y + 0.1), hx1 = Math.max(bd.x1, p.x + p.w - 0.1), hy1 = Math.max(bd.y1, p.y + p.h - 0.1);
        for (const [x, y] of [[bd.x0, bd.y0], [bd.x1, bd.y0], [bd.x1, bd.y1], [bd.x0, bd.y1]]) { pts.push(proj.toWorld(x, y, 0)); pts.push(proj.toWorld(x, y, b.height)); }
        rec.hull = hull(pts);
        rec.ground = hull([[hx0, hy0], [hx1, hy0], [hx1, hy1], [hx0, hy1]].map(([x, y]) => proj.toWorld(x, y, 0)));
        rec.label = proj.toWorld((bd.x0 + bd.x1) / 2, (bd.y0 + bd.y1) / 2, b.labelZ);
        rec.center = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2, b.height / 2);
        rec.wx0 = b.ox; rec.wy0 = b.oy; rec.wx1 = b.ox + box.w; rec.wy1 = b.oy + box.h;
        B.rec = rec;
        buildings.push(rec);
      }
    }
    // --- sprites of a big town (view.md 3.3.6): Map<spriteKey, entry>, LRU by area, built under the budget ------
    // A keyed (variant) building is drawn once at the canonical origin (id = sid, x = y = 0) and placed with the
    // shift toWorld(p.x, p.y) - toWorld(0, 0); Millbrook's places keep variant null and in-place drawing.
    const sprites = new Map(), spriteQueue = new Map();
    let spriteMP = 0;
    scene.spriteCap = 16e6;
    const recKey = rec => CV.spriteKey(rec.B.kp, rec.decor ? null : scene.looks[rec.p.id], scene.season);
    // the browser records canvas draws and rasterises them when the canvas is first read: a one-pixel read makes
    // that happen inside the build (and its budget) instead of in the first frame that draws it
    const flush = c => { try { c.getContext("2d").getImageData(0, 0, 1, 1); } catch (e) { /* a tainted or lost canvas */ } };
    CV.flushCanvas = CV.flushCanvas || flush;
    function buildSprite(rec, key) {
      const p = rec.p, look = rec.decor ? {} : scene.looks[p.id] || {};
      const t0 = performance.now();
      const s = rec.B.variant == null ? art.building(p, look, scene.season)
        : art.building(CV.canonPlace ? CV.canonPlace(rec.B.kp) : Object.assign({}, rec.B.kp, { id: rec.B.sid, x: 0, y: 0, entry: p.entry ? [p.entry[0] - p.x, p.entry[1] - p.y] : null }), look, scene.season);
      flush(s.c);
      const e = { c: s.c, s, used: frameNo, mp: s.c.width * s.c.height, inPlace: rec.B.variant == null, season: scene.season, ms: performance.now() - t0 };
      sprites.set(key, e); spriteMP += e.mp; scene.stats.spriteBuilds++;
      evictSprites();
      return e;
    }
    function evictSprites() {
      if (spriteMP <= scene.spriteCap) return;
      const old = [...sprites.entries()].filter(([, e]) => e.used < frameNo).sort((a, b) => a[1].used - b[1].used);
      for (const [k, e] of old) { if (spriteMP <= scene.spriteCap) break; sprites.delete(k); spriteMP -= e.mp; }
    }
    function attach(rec, e) {
      if (rec.att === e) return;
      rec.att = e;
      const s = e.s, dx = e.inPlace ? 0 : rec.dx, dy = e.inPlace ? 0 : rec.dy, sh = q => q ? [q[0] + dx, q[1] + dy] : null;
      Object.assign(rec.b, { c: e.c, windows: dx || dy ? (s.windows || []).map(w => w.map(sh)) : (s.windows || []), lights: (s.lights || []).map(sh),
        porch: sh(s.porch), neon: s.neon ? [s.neon[0] + dx, s.neon[1] + dy, s.neon[2], s.neon[3]] : null, smoke: sh(s.smoke), beacon: sh(s.beacon),
        litShare: s.litShare, glows: null, mask: null });
    }
    // The sprite to draw for rec now: its key's, else the last key drawn (a season or look change) while the new
    // one waits in the queue; null when it has none yet (a box stands in).
    function spriteOf(rec, queue) {
      const key = recKey(rec);
      let e = sprites.get(key);
      if (e) { e.used = frameNo; rec.lastKey = key; attach(rec, e); return e; }
      if (queue !== false) {
        const q = spriteQueue.get(key), d = Math.hypot((rec.wx0 + rec.wx1) / 2 - scene.cam.x, (rec.wy0 + rec.wy1) / 2 - scene.cam.y);
        if (!q || q.d > d) spriteQueue.set(key, { rec, d, f: frameNo });
      }
      e = rec.lastKey ? sprites.get(rec.lastKey) : null;
      if (e) { e.used = frameNo; attach(rec, e); scene.stats.staleSprites++; return e; }
      return null;
    }
    // Build queued sprites, nearest first, within ms (and at least one when nothing else was built this frame).
    // A sprite's cost is estimated from its area (ms per px, learned): while the camera moves, one that would
    // overrun what is left of the budget waits (its box stands in) and smaller ones go first.
    let avgSprite = 2, msPerPx = 2e-5;
    function buildQueued(budget, ms, still) {
      const jobs = [...spriteQueue.entries()].filter(([, j]) => j.f >= frameNo - 1).sort((a, b) => a[1].d - b[1].d);
      let spent = 0;
      for (const [k, j] of jobs) {
        if (sprites.has(k)) { spriteQueue.delete(k); continue; }
        if (spent >= ms || (budget.builds > 0 && budget.left() < Math.min(4, avgSprite))) break;
        const area = (j.rec.wx1 - j.rec.wx0) * (j.rec.wy1 - j.rec.wy0), est = area * msPerPx;
        if (!still && !budget.unlimited && est > Math.max(budget.left(), 4)) continue;
        const a = performance.now();
        budget.run(() => buildSprite(j.rec, k));
        const dt = performance.now() - a;
        spent += dt; avgSprite = avgSprite * 0.8 + dt * 0.2;
        if (area > 0) msPerPx = msPerPx * 0.8 + (dt / area) * 0.2;
        spriteQueue.delete(k);
      }
      for (const [k, j] of spriteQueue) if (j.f < frameNo - 1) spriteQueue.delete(k);
      return spent;
    }
    scene.sprites = { map: sprites, queue: spriteQueue, mp: () => spriteMP, has: rec => sprites.has(recKey(rec)), build: (rec) => buildSprite(rec, recKey(rec)), keyOf: recKey, spriteOf };
    let staticsVersion = 0;

    // --- opaque-pixel masks of building sprites: exact x-ray and "is this person hidden" tests -------------
    function maskOf(rec) {
      const b = rec.b;
      if (b.mask) return b.mask;
      if (b.c.fake) return { m: new Uint8Array(0), w: 0, h: 0, n: 0 }; // no sprite yet: nothing opaque
      const w = b.c.width, h = b.c.height;
      const c = CV.canvas(w, h), q = c.getContext("2d", { willReadFrequently: true });
      q.drawImage(b.c, 0, 0);
      const d = q.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
      let n = 0;
      for (let k = 0; k < m.length; k++) { m[k] = d[k * 4 + 3] > 40 ? 1 : 0; n += m[k]; }
      b.mask = { m, w, h, n };
      return b.mask;
    }
    function opaqueAt(rec, wx, wy) {
      const k = maskOf(rec), x = Math.floor(wx - rec.b.ox), y = Math.floor(wy - rec.b.oy);
      return x >= 0 && y >= 0 && x < k.w && y < k.h && k.m[y * k.w + x] === 1;
    }
    // Does building B, drawn after something at `depth` in the same column, cover the box (a person's
    // hit box)? Sampled every 2 px; a few samples are enough, since a person is small.
    function hidesBox(B, box, depth) {
      const b = B.b, [x0, y0, x1, y1] = box;
      if (x1 <= b.ox || x0 >= b.ox + b.c.width || y1 <= b.oy || y0 >= b.oy + b.c.height) return false;
      let n = 0;
      for (const sl of B.slices) {
        if (sl.depth <= depth) continue;
        const a0 = Math.max(x0, sl.wx), a1 = Math.min(x1, sl.wx + sl.sw);
        for (let x = Math.ceil(a0); x < a1; x += 2) for (let y = Math.ceil(y0); y < y1; y += 2) if (opaqueAt(B, x, y) && ++n >= 3) return true;
      }
      return false;
    }
    // Does building B really cover building T: its strips, drawn after T's in the same columns, hide at
    // least 120 px and 1.5% of T's opaque pixels? (A roof corner grazing a neighbour is not enough to
    // make a whole building see-through.) Sampled every 2 px, so each sample stands for 4 px.
    function hides(B, T) {
      const b = B.b, t = T.b;
      const x0 = Math.max(b.ox, t.ox), x1 = Math.min(b.ox + b.c.width, t.ox + t.c.width);
      const y0 = Math.max(b.oy, t.oy), y1 = Math.min(b.oy + b.c.height, t.oy + t.c.height);
      if (x1 <= x0 || y1 <= y0) return false;
      const need = Math.max(120, maskOf(T).n * 0.015) / 4;
      let n = 0;
      for (const sB of B.slices) {
        const a0 = Math.max(x0, sB.wx), a1 = Math.min(x1, sB.wx + sB.sw);
        for (let x = Math.ceil(a0); x < a1; x += 2) {
          const sT = T.slices.find(q => x >= q.wx && x < q.wx + q.sw);
          if (!sT || sB.depth <= sT.depth) continue;
          for (let y = Math.ceil(y0); y < y1; y += 2) if (opaqueAt(B, x, y) && opaqueAt(T, x, y) && ++n >= need) return true;
        }
      }
      return false;
    }
    // The buildings drawn see-through this frame: those that actually cover the target, and the world rect of
    // the target. The target is the selected person (or the building they are inside), else the first
    // highlighted person (or their building), else the first highlighted place. Only the part of a covering
    // building over that rect (plus about 24 screen px) turns see-through.
    let ghostKey = "", ghostSet = null;
    function ghosts() {
      const pad = 24 / Math.max(0.1, scene.cam.zoom);
      const hl = scene.highlight;
      let m = scene.selected && scene.moverById ? scene.moverById(scene.selected) : null;
      if (!m && hl && hl.agents && scene.moverById) for (const id of hl.agents) { m = scene.moverById(id); if (m) break; }
      if (m && m.item) {
        const it = m.item, h = it.hit || [0, 0, it.sw, it.sh];
        const box = [it.wx + h[0], it.wy + h[1], it.wx + h[2], it.wy + h[3]];
        const out = new Set();
        for (const r of buildings) if (hidesBox(r, box, it.depth)) out.add(r);
        return out.size ? { set: out, rect: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] } : null;
      }
      let rec = m && m.insideRec ? m.insideRec : null;
      const hp = hl && hl.places && hl.places[0];
      if (!rec && hp != null) rec = buildings.find(r => r.p.id === hp) || null;
      if (!rec) return null;
      const key = rec.p.id + "|" + staticsVersion;
      if (key !== ghostKey) { ghostKey = key; ghostSet = new Set(buildings.filter(r => r !== rec && hides(r, rec))); }
      if (!ghostSet.size) return null;
      const xs = rec.hull.map(q => q[0]), ys = rec.hull.map(q => q[1]);
      return { set: ghostSet, rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad] };
    }
    // Draw an image part opaque outside the ghost rect and see-through inside it, with a soft edge: the inner
    // part goes through a scratch canvas where a feathered mask (0.65 in the middle, 0 at the rect's edge)
    // is cut out of it. Returns false when the image does not meet the rect (the caller draws it normally).
    let gScratch = null, gMask = null, gMaskKey = "";
    function ghostBlit(img, sx, sy, sw, sh, wx, wy, v, R) {
      const dx0 = Math.round(wx * v.S + v.ox), dy0 = Math.round(wy * v.S + v.oy);
      const dx1 = Math.round((wx + sw) * v.S + v.ox), dy1 = Math.round((wy + sh) * v.S + v.oy);
      const rx0 = Math.round(R[0] * v.S + v.ox), ry0 = Math.round(R[1] * v.S + v.oy), rx1 = Math.round(R[2] * v.S + v.ox), ry1 = Math.round(R[3] * v.S + v.oy);
      const ix0 = Math.max(dx0, rx0), iy0 = Math.max(dy0, ry0), ix1 = Math.min(dx1, rx1), iy1 = Math.min(dy1, ry1);
      if (ix1 <= ix0 || iy1 <= iy0 || dx1 <= dx0 || dy1 <= dy0) return false;
      g.save(); g.beginPath(); g.rect(dx0, dy0, dx1 - dx0, dy1 - dy0); g.rect(ix0, iy0, ix1 - ix0, iy1 - iy0); g.clip("evenodd");
      g.drawImage(img, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
      g.restore();
      const iw = ix1 - ix0, ih = iy1 - iy0, rw = rx1 - rx0, rh = ry1 - ry0;
      if (!gScratch) gScratch = CV.canvas(1, 1);
      if (gScratch.width < iw || gScratch.height < ih) { gScratch.width = Math.max(gScratch.width, iw); gScratch.height = Math.max(gScratch.height, ih); }
      const feather = Math.max(4, Math.round(16 * scene.dpr));
      const mk = rw + "x" + rh + "x" + feather;
      if (mk !== gMaskKey) {
        gMaskKey = mk; gMask = CV.canvas(rw, rh);
        const q = gMask.getContext("2d"), off = rw + 4 * feather;
        q.shadowColor = "rgba(0,0,0,0.65)"; q.shadowBlur = feather; q.shadowOffsetX = off;
        q.fillStyle = "#000"; q.fillRect(feather - off, feather, Math.max(1, rw - 2 * feather), Math.max(1, rh - 2 * feather));
      }
      const sq = gScratch.getContext("2d");
      sq.setTransform(1, 0, 0, 1, 0, 0); sq.globalCompositeOperation = "source-over"; sq.clearRect(0, 0, iw, ih);
      sq.imageSmoothingEnabled = g.imageSmoothingEnabled;
      sq.drawImage(img, sx, sy, sw, sh, dx0 - ix0, dy0 - iy0, dx1 - dx0, dy1 - dy0);
      sq.globalCompositeOperation = "destination-out";
      sq.drawImage(gMask, rx0 - ix0, ry0 - iy0);
      sq.globalCompositeOperation = "source-over";
      g.drawImage(gScratch, 0, 0, iw, ih, ix0, iy0, iw, ih);
      return true;
    }
    // The same for an additive glow: full outside the rect, at `inside` alpha within it (no feather needed).
    function ghostGlow(img, wx, wy, v, R, base, inside) {
      const rx0 = Math.round(R[0] * v.S + v.ox), ry0 = Math.round(R[1] * v.S + v.oy), rx1 = Math.round(R[2] * v.S + v.ox), ry1 = Math.round(R[3] * v.S + v.oy);
      g.save(); g.beginPath(); g.rect(0, 0, cv.width, cv.height); g.rect(rx0, ry0, rx1 - rx0, ry1 - ry0); g.clip("evenodd");
      blit(img, 0, 0, img.width, img.height, wx, wy, v);
      g.restore();
      g.save(); g.beginPath(); g.rect(rx0, ry0, rx1 - rx0, ry1 - ry0); g.clip();
      g.globalAlpha = base * inside; blit(img, 0, 0, img.width, img.height, wx, wy, v);
      g.restore();
    }
    // Where a building's name plate goes: over its roof, or, when a nearer building covers that point, over
    // the highest part of it still in view (City Hall's clock tower beside the Brightline tower); null when
    // nothing of it shows. Worked out once per static rebuild.
    function labelAnchor(rec) {
      if (rec.anchorV === staticsVersion) return rec.anchor;
      rec.anchorV = staticsVersion;
      const b = rec.b;
      const depthAt = wx => { const sl = rec.slices.find(q => wx >= q.wx && wx < q.wx + q.sw); return sl ? sl.depth : rec.depth; };
      const near = buildings.filter(B => B !== rec && B.b.ox < b.ox + b.c.width && B.b.ox + B.b.c.width > b.ox && B.b.oy < b.oy + b.c.height && B.b.oy + B.b.c.height > b.oy);
      const covered = (wx, wy) => {
        const d = depthAt(wx);
        for (const B of near) { const sl = B.slices.find(q => wx >= q.wx && wx < q.wx + q.sw); if (sl && sl.depth > d && opaqueAt(B, wx, wy)) return true; }
        return false;
      };
      if (!near.length || !covered(rec.label[0], rec.label[1])) { rec.anchor = rec.label; return rec.anchor; }
      let best = null;
      for (let x = b.ox + 2; x < b.ox + b.c.width - 2; x += 2) {
        let top = null;
        for (let y = b.oy; y < b.oy + b.c.height; y++) if (opaqueAt(rec, x, y) && !covered(x, y)) { top = y; break; }
        if (top == null || (best && top >= best[1])) continue;
        let n = 0, m = 0; // most of a 12 x 12 patch under it must show, so a lone antenna does not win
        for (let yy = top; yy < top + 12; yy += 2) for (let xx = x - 6; xx <= x + 6; xx += 2) { m++; if (opaqueAt(rec, xx, yy) && !covered(xx, yy)) n++; }
        if (n >= m * 0.4) best = [x, top];
      }
      rec.anchor = best ? [best[0], best[1] - 10] : null;
      return rec.anchor;
    }
    // A person (or vehicle) item whose foot point lies under a nearer building's opaque pixels.
    function hiddenItem(it) {
      const fx = it.wx + it.sw / 2, fy = it.wy + it.sh - 3;
      for (const r of buildings) {
        const b = r.b;
        if (fx < b.ox || fx >= b.ox + b.c.width || fy < b.oy || fy >= b.oy + b.c.height) continue;
        const sl = r.slices.find(q => fx >= q.wx && fx < q.wx + q.sw);
        if (sl && sl.depth > it.depth && opaqueAt(r, fx, fy)) return true;
      }
      return false;
    }
    // Lamp bulbs and porch lights hidden behind a nearer building keep their glow off (the light pass is
    // additive and would otherwise shine through roofs). Recomputed with the statics.
    let occlusion = null;
    function hiddenAt(wx, wy, depth, self) {
      for (const r of buildings) {
        if (r === self || !inHull(r.hull, wx, wy)) continue;
        const sl = r.slices.find(it => wx >= it.wx && wx < it.wx + it.sw);
        if (sl && sl.depth > depth + 0.3) return true;
      }
      return false;
    }
    // A glow sprite with the nearer building slices cut out of it, or null when nothing nearer overlaps it.
    // out: a scratch canvas to cut it in (reused every frame for moving lights) instead of a new one.
    function maskedGlow(src, gx, gy, depth, self, out) {
      const w = src.width, h = src.height;
      let c = null, q = null;
      for (const r of buildings) {
        if (r === self) continue;
        for (const it of r.slices) {
          if (it.depth <= depth + 0.3 || it.wx >= gx + w || it.wx + it.sw <= gx || it.wy >= gy + h || it.wy + it.sh <= gy) continue;
          if (!c) {
            c = out || CV.canvas(w, h); q = c.getContext("2d");
            if (out) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } q.setTransform(1, 0, 0, 1, 0, 0); q.globalCompositeOperation = "source-over"; q.clearRect(0, 0, w, h); }
            q.drawImage(src, 0, 0); q.globalCompositeOperation = "destination-out";
          }
          q.drawImage(it.img, it.sx, it.sy, it.sw, it.sh, it.wx - gx, it.wy - gy, it.sw, it.sh);
        }
      }
      return c;
    }
    // Lazy lamp occlusion for a big town (view.md 3.3.7): a visible lamp's hidden flag and masked pool are worked
    // out the first time it shows, from the buildings near it, once every nearer one has its sprite (until then
    // the pool shows unmasked); at most 300 masks are kept and 2 ms a frame spent.
    const lampOcc = new Map();
    let lampMasks = 0, lampMs = 0;
    function hiddenAtIn(list, wx, wy, depth) {
      for (const r of list) {
        if (!inHull(r.hull, wx, wy)) continue;
        const sl = r.slices.find(it => wx >= it.wx && wx < it.wx + it.sw);
        if (sl && sl.depth > depth + 0.3) return true;
      }
      return false;
    }
    function maskedGlowIn(src, gx, gy, depth, list) {
      const w = src.width, h = src.height;
      let c = null, q = null;
      for (const r of list) for (const it of r.slices) {
        if (it.depth <= depth + 0.3 || it.wx >= gx + w || it.wx + it.sw <= gx || it.wy >= gy + h || it.wy + it.sh <= gy) continue;
        if (!c) { c = CV.canvas(w, h); q = c.getContext("2d"); q.drawImage(src, 0, 0); q.globalCompositeOperation = "destination-out"; }
        q.drawImage(r.att.c, it.sx, it.sy, it.sw, it.sh, it.wx - gx, it.wy - gy, it.sw, it.sh);
      }
      return c;
    }
    function lampState(k, lx, ly) {
      const o0 = lampOcc.get(k);
      if (o0) return o0;
      if (lampMs >= 2) return null;
      const a = performance.now();
      const d = proj.depth(lx, ly), top = proj.toWorld(lx, ly, 39), p = proj.toWorld(lx, ly, 0);
      const w = lampGlow.width, h = lampGlow.height, gx = p[0] - 48, gy = p[1] - 25;
      const near = inRect(Math.min(gx, top[0]) - 2, Math.min(gy, top[1]) - 2, gx + w + 2, gy + h + 2).filter(r => r.big && r.slices.some(it => it.depth > d + 0.3));
      if (near.some(r => !r.att)) { lampMs += performance.now() - a; return null; }
      const hidden = hiddenAtIn(near, top[0] + 6, top[1], d);
      const img = hidden || lampMasks >= 300 ? null : maskedGlowIn(lampGlow, gx, gy, d, near);
      if (img) lampMasks++;
      const o = { hidden, img };
      lampOcc.set(k, o);
      lampMs += performance.now() - a;
      return o;
    }
    function occlusionOf() {
      if (occlusion) return occlusion;
      // a big town works its lamps out lazily (lampState); porch pools draw without masks
      if (BIG) return (occlusion = { lamps: lampPts.map(() => false), lampImg: [], porch: new Map(), porchImg: new Map() });
      const lamps = [], lampImg = [];
      lampPts.forEach(([lx, ly]) => {
        const d = proj.depth(lx, ly), top = proj.toWorld(lx, ly, 39), p = proj.toWorld(lx, ly, 0);
        const hidden = hiddenAt(top[0] + 6, top[1], d, null);
        lamps.push(hidden);
        lampImg.push(hidden ? null : maskedGlow(lampGlow, p[0] - 48, p[1] - 25, d, null));
      });
      const porch = new Map(), porchImg = new Map();
      for (const r of buildings) {
        const e = r.p.entry, d = e ? proj.depth(e[0] + 0.5, e[1] + 0.5) - 0.5 : r.depth;
        const pts = [r.b.porch, ...(r.b.lights || [])].filter(Boolean);
        const vis = pts.map(q => !hiddenAt(q[0], q[1], d, r));
        porch.set(r, vis);
        porchImg.set(r, pts.map((q, k) => vis[k] ? maskedGlow(porchGlow, q[0] - 22, q[1] - 12, d, r) : null));
      }
      occlusion = { lamps, lampImg, porch, porchImg };
      return occlusion;
    }
    // Fountain jets are animated items at the centre of each paved square.
    const fountains = parks.filter(p => p.id === "square" || /square/i.test(p.name || "")).map(p => [p.x + p.w / 2, p.y + p.h / 2]);
    const smokeOf = () => buildings.filter(r => r.b.smoke);

    // --- ground chunks per level ---------------------------------------------------------------------
    let B = proj.bounds(); B.y1 += 24;
    const levels = new Map(); // level -> Map(key -> {c, used})
    let frameNo = 0;
    const staleOk = BIG; let staleN = 0;
    function chunk(level, cx, cy, mayBuild) {
      let m = levels.get(level); if (!m) levels.set(level, m = new Map());
      const key = cx + "," + cy;
      let ch = m.get(key);
      if ((!ch || (ch.stale && staleOk)) && mayBuild()) {
        const a = performance.now();
        ch = { c: BIG ? budget.run(() => renderChunk(level, cx, cy)) : renderChunk(level, cx, cy), used: 0 }; m.set(key, ch); scene.stats.built++;
        scene.stats.chunkMs = performance.now() - a; evict();
      }
      else if (ch && ch.stale) staleN++;
      if (ch) ch.used = frameNo;
      return ch;
    }
    // the near ground cache in device px, and a trim to cap (the low view's share of the chunk budget)
    const nearPx = () => { let t = 0; for (const m of levels.values()) for (const v of m.values()) t += v.c.width * v.c.height; return t; };
    function trimNear(cap) {
      for (;;) {
        let total = 0, old = null;
        for (const m of levels.values()) for (const [k, v] of m) { total += v.c.width * v.c.height; if (v.used < frameNo && (!old || v.used < old[2].used)) old = [m, k, v]; }
        scene.stats.cacheMP = total / 1e6;
        if (total <= cap || !old) return;
        old[0].delete(old[1]);
      }
    }
    function evict() {
      const budget = scene.chunkBudget || 12e6;
      for (;;) {
        let total = 0, old = null;
        for (const m of levels.values()) for (const [k, v] of m) { total += v.c.width * v.c.height; if (v.used < frameNo && (!old || v.used < old[2].used)) old = [m, k, v]; }
        scene.stats.cacheMP = total / 1e6;
        if (total <= budget || !old) return;
        old[0].delete(old[1]);
      }
    }
    // A chunk below zoom 1 is the finished zoom-1 chunk scaled down in one smoothed draw (from the cache, or
    // painted into a scratch canvas). Drawing each tile at the small scale instead lets the dark background
    // show through the half-covered pixels along every diamond edge, which reads as a grid.
    let scratch = null;
    function renderChunk(level, cx, cy) {
      const size = Math.round(CH * level);
      const c = CV.canvas(size, size), q = c.getContext("2d");
      if (level < 1 && BIG) { // a big town paints its smaller levels directly, unfiltered (tiles sit on even px)
        paintChunk(q, cx, cy, level);
        flush(c);
        return c;
      }
      if (level < 1) {
        const m1 = levels.get(1), have = m1 && m1.get(cx + "," + cy);
        let src = have && !have.stale && have.c;
        if (!src) {
          if (!scratch) scratch = CV.canvas(CH, CH);
          const sq = scratch.getContext("2d");
          sq.setTransform(1, 0, 0, 1, 0, 0); sq.clearRect(0, 0, CH, CH);
          paintChunk(sq, cx, cy);
          src = scratch;
        }
        q.imageSmoothingEnabled = true; q.imageSmoothingQuality = "high";
        q.drawImage(src, 0, 0, CH, CH, 0, 0, size, size);
        if (BIG) flush(c);
        return c;
      }
      paintChunk(q, cx, cy);
      if (BIG) flush(c);
      return c;
    }
    function paintChunk(q, cx, cy, k) {
      const wx0 = B.x0 + cx * CH, wy0 = B.y0 + cy * CH;
      k = k || 1;
      q.imageSmoothingEnabled = false;
      q.setTransform(k, 0, 0, k, -wx0 * k, -wy0 * k);
      const off = art.tileOffset, iso = proj.kind === "iso";
      const front = iso ? proj.faces : [];
      let tx0 = 0, ty0 = 0, tx1 = W - 1, ty1 = H - 1;
      if (BIG) { // only the tiles under the chunk (its corners in tile space, a margin for the tile's height)
        const cs = [[wx0, wy0 - 60], [wx0 + CH, wy0 - 60], [wx0, wy0 + CH + 8], [wx0 + CH, wy0 + CH + 8]].map(([a, b]) => proj.toTile(a, b));
        tx0 = Math.max(0, Math.floor(Math.min(...cs.map(q => q[0]))) - 2); tx1 = Math.min(W - 1, Math.ceil(Math.max(...cs.map(q => q[0]))) + 2);
        ty0 = Math.max(0, Math.floor(Math.min(...cs.map(q => q[1]))) - 2); ty1 = Math.min(H - 1, Math.ceil(Math.max(...cs.map(q => q[1]))) + 2);
      }
      for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
        const p0 = proj.toWorld(x, y);
        const tx = p0[0] - off[0], ty = p0[1] - off[1];
        if (tx > wx0 + CH || tx + proj.tw < wx0 || ty > wy0 + CH || ty + proj.th + 24 < wy0) continue;
        q.drawImage(groundSprite(x, y), tx, ty);
        const st = stopAt.get(y * W + x);
        if (st && tiles[y][x] === "#") { const rowRoad = town.road_rows.includes(y); q.drawImage(art.stopMark(rowRoad ? "x" : "y", rowRoad ? "n" : "w"), tx, ty); }
        if (iso) { // the map's edge slab
          const water = tiles[y][x] === "~";
          if (y === H - 1 && front.includes("s")) q.drawImage(art.slab("s", water, scene.season), tx, ty);
          if (x === W - 1 && front.includes("e")) q.drawImage(art.slab("e", water, scene.season), tx, ty);
          if (y === 0 && front.includes("n")) q.drawImage(art.slab("n", water, scene.season), tx, ty);
          if (x === 0 && front.includes("w")) q.drawImage(art.slab("w", water, scene.season), tx, ty);
        }
      }
      // building shadows lie on the ground, cast to the east-north-east
      q.fillStyle = "rgba(8,16,8,0.22)";
      const nearChunk = p => { if (!BIG) return true; const c0 = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2); return c0[0] > wx0 - 400 && c0[0] < wx0 + CH + 400 && c0[1] > wy0 - 300 && c0[1] < wy0 + CH + 300; };
      for (const p of places) {
        if (p.kind === "park" || !nearChunk(p)) continue;
        const fl = p.floors || 1;
        const hgt = Math.min(2.6, 0.45 + fl * (p.style === "house" ? 0.45 : 0.32) + (p.style === "big_house" ? 0.3 : 0));
        const b = CV.bodyOf(p);
        const pts = [proj.toWorld(b.x1, b.y0), proj.toWorld(b.x1 + hgt, b.y0 - hgt * 0.35), proj.toWorld(b.x1 + hgt, b.y1 - hgt * 0.35), proj.toWorld(b.x1, b.y1)];
        CV.poly(q, pts);
        if (b.silos) for (const t of [0.28, 0.72]) { const sx = (b.silos[0] + b.silos[2]) / 2, sy = b.silos[1] + (b.silos[3] - b.silos[1]) * t; CV.poly(q, [proj.toWorld(sx, sy - 0.3), proj.toWorld(sx + 2, sy - 1), proj.toWorld(sx + 2, sy - 0.4), proj.toWorld(sx, sy + 0.3)]); }
        q.fillStyle = "rgba(8,16,8,0.22)";
      }
      // pools and the fountain basin are ground too
      for (const p of places) {
        if (p.style !== "big_house" || !nearChunk(p)) continue;
        const b = CV.bodyOf(p);
        if (b.pool) { const look = scene.looks[p.id]; art.pool(q, b.pool, look ? look.stage | 0 : 0, 0, 0, scene.season); }
      }
      for (const [fx, fy] of fountains) { const p = proj.toWorld(fx, fy); art.fountainBasin(q, p[0], p[1]); }
      for (const L of lands) if (L.kind === "field") { const [x0, y0, x1, y1] = L.inner, m = 0.3; art.pitchLines(q, x0 + m, y0 + m, x1 - m, y1 - m, L.alongX); }
    }
    function invalidateRect(x0, y0, x1, y1) {
      const pts = [proj.toWorld(x0, y0), proj.toWorld(x1, y0), proj.toWorld(x1, y1), proj.toWorld(x0, y1)];
      const ax0 = Math.min(...pts.map(p => p[0])) - 70, ax1 = Math.max(...pts.map(p => p[0])) + 70;
      const ay0 = Math.min(...pts.map(p => p[1])) - 40, ay1 = Math.max(...pts.map(p => p[1])) + 40;
      for (const m of levels.values()) for (const k of [...m.keys()]) {
        const [cx, cy] = k.split(",").map(Number);
        const wx = B.x0 + cx * CH, wy = B.y0 + cy * CH;
        if (wx < ax1 && wx + CH > ax0 && wy < ay1 && wy + CH > ay0) m.delete(k);
      }
    }
    scene.invalidateGround = () => levels.clear();

    // --- frame ---------------------------------------------------------------------------------------
    let lampGlow = null, porchGlow = null;
    function makeGlow(rx, ry, col, a) {
      const c = CV.canvas(rx * 2, ry * 2), q = c.getContext("2d");
      const gr = q.createRadialGradient(rx, rx, 1, rx, rx, rx);
      gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
      q.setTransform(1, 0, 0, ry / rx, 0, 0); q.fillStyle = gr; q.beginPath(); q.arc(rx, rx, rx, 0, Math.PI * 2); q.fill();
      return c;
    }
    // today's nightAlpha curve, normalised to 0..1: 1 from 21:00 to 05:00, ramps 19-21 and 05-07
    scene.nightAlpha = minute => { const h = ((minute || 0) / 60) % 24; if (h >= 21 || h < 5) return 1; if (h < 7) return 1 - (h - 5) / 2; if (h >= 19) return (h - 19) / 2; return 0; };

    // The point the camera centres on: the middle of the canvas minus the UI insets.
    scene.view = () => {
      const S = scene.cam.zoom * scene.dpr;
      const k = scene.dpr, ins = scene.inset;
      const cxCss = (cv.width / k - (ins.right || 0)) / 2, cyCss = ((ins.top || 0) + cv.height / k - (ins.bottom || 0)) / 2;
      const ox = Math.round(cxCss * k - scene.cam.x * S), oy = Math.round(cyCss * k - scene.cam.y * S);
      return { S, ox, oy, x0: -ox / S, y0: -oy / S, x1: (cv.width - ox) / S, y1: (cv.height - oy) / S };
    };
    scene.worldToCss = (wx, wy) => { const v = scene.view(); return [(wx * v.S + v.ox) / scene.dpr, (wy * v.S + v.oy) / scene.dpr]; };
    scene.cssToWorld = (x, y) => { const v = scene.view(); return [(x * scene.dpr - v.ox) / v.S, (y * scene.dpr - v.oy) / v.S]; };

    // Which places glow at night, and the share of their windows lit (null: the building's own share).
    // Homes are lit while someone is in, up to stage 3 (a derelict house stays dark); between 00:30 and
    // 05:30 a household that is all asleep keeps only about one window in six lit.
    const LATE_SHARE = 17;
    function litPlaces() {
      const st = scene.state, out = new Map();
      if (!st) return out;
      const inside = new Map(), awake = new Set();
      for (const a of st.agents || []) {
        if (a.alive === false || !a.inside) continue;
        const pid = scene.placeById.has(a.inside) ? a.inside : homePlace.get(a.inside) || a.inside;
        inside.set(pid, (inside.get(pid) || 0) + 1);
        if (a.activity !== "sleep") awake.add(pid);
      }
      const hr = ((st.minute || 0) / 60) % 24, late = hr >= 0.5 && hr < 5.5;
      for (const p of places) {
        if (p.kind === "park") continue;
        if (p.kind === "home") {
          const l = scene.looks[p.id];
          if ((inside.get(p.id) || 0) > 0 && (!l || (l.stage | 0) < 4)) out.set(p.id, late && !awake.has(p.id) ? LATE_SHARE : null);
          continue;
        }
        const open = !p.hours || (hr >= p.hours[0] && hr < p.hours[1]);
        if (p.kind === "hospital" || open || inside.get(p.id)) out.set(p.id, null);
      }
      return out;
    }
    function glowOf(rec, share) {
      const b = rec.b, pct = share == null ? b.litShare : share;
      b.glows = b.glows || new Map();
      if (b.glows.has(pct)) return b.glows.get(pct);
      const win = b.windows.filter((q, k) => hash(b.id + ":" + k) % 100 < pct);
      if (!win.length) { b.glows.set(pct, null); return null; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of win) for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      x0 = Math.floor(x0); y0 = Math.floor(y0);
      const c = CV.canvas(x1 - x0 + 2, y1 - y0 + 2), q = c.getContext("2d");
      q.translate(-x0, -y0);
      for (const w of win) { CV.poly(q, w, "#e8a440"); }
      q.fillStyle = "#ffd890";
      for (const w of win) { const cx = (w[0][0] + w[2][0]) / 2, cy = (w[0][1] + w[2][1]) / 2; q.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2); }
      const gl = { c, wx: x0, wy: y0 };
      b.glows.set(pct, gl);
      return gl;
    }

    function blit(img, sx, sy, sw, sh, wx, wy, v) {
      const dx0 = Math.round(wx * v.S + v.ox), dy0 = Math.round(wy * v.S + v.oy);
      const dx1 = Math.round((wx + sw) * v.S + v.ox), dy1 = Math.round((wy + sh) * v.S + v.oy);
      if (dx1 <= dx0 || dy1 <= dy0) return;
      // a big town at device scale < 0.75 draws from half-size copies (one smoothed 2:1 draw each, made under the
      // budget): the frame then copies nearly 1:1 instead of filtering four times the pixels
      const m = v.mip ? mipOf(img) : null;
      if (v.mip && !m) scene.stats.mipMiss++;
      if (m) g.drawImage(m, sx / 2, sy / 2, sw / 2, sh / 2, dx0, dy0, dx1 - dx0, dy1 - dy0);
      else g.drawImage(img, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
    }
    let mips = new WeakMap(), mipFrame = -1, mipN = 0, mipMs = 0;
    function mipOf(img) {
      let m = mips.get(img);
      if (m) return m;
      // (copies have their own 3 ms a frame while the view moves, the frame's budget when it rests; a missing one
      // draws the full sprite scaled)
      if (mipFrame !== frameNo) { mipFrame = frameNo; mipN = 0; mipMs = 0; }
      if (!img.width || (mipN > 0 && mipMs >= 3 && budget.left() <= 0)) return null;
      mipN++;
      const a = performance.now();
      budget.run(() => {
        m = CV.canvas(Math.max(1, Math.ceil(img.width / 2)), Math.max(1, Math.ceil(img.height / 2)));
        const q = m.getContext("2d"); q.imageSmoothingEnabled = true;
        q.drawImage(img, 0, 0, img.width, img.height, 0, 0, img.width / 2, img.height / 2);
        flush(m);
      });
      mipMs += performance.now() - a;
      mips.set(img, m);
      return m;
    }
    scene.clearMips = () => { mips = new WeakMap(); };

    scene.draw = function (now) {
      const t0 = performance.now();
      frameNo++; scene.stats.frames = frameNo;
      if (BIG) { budget.begin(frameNo <= 1 || scene.eager || scene.unlimited); scene.stats.staleSprites = 0; scene.stats.mipMiss = 0; lampMs = 0; scene.spriteCap = scene.spriteCapSet || (isPhone() ? 8e6 : 16e6); }
      if (dirty || !statics.length) BIG ? budget.run(buildStatics) : buildStatics();
      if (!lampGlow) { lampGlow = makeGlow(54, 27, "#ffd890", 0.5); porchGlow = makeGlow(22, 12, "#ffd890", 0.6); }
      const v = scene.view(), S = v.S;
      const lod = scene.lodNow = lodOf(scene.cam.zoom);
      if (lod !== "near") { drawLow(v, lod, now); scene.stats.draw = performance.now() - t0; return; }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      g.fillStyle = "#1d2330"; g.fillRect(0, 0, cv.width, cv.height);
      // ground: the smallest cached level that is still at least the device scale
      // (a big town keeps the half level up to 0.75: a zoom on its way scales it up rather than filtering 4x the px)
      const level = BIG ? (S >= 0.75 ? 1 : S > 0.25 ? 0.5 : 0.25) : S > 0.5 ? 1 : S > 0.25 ? 0.5 : 0.25;
      g.imageSmoothingEnabled = S < level || (BIG && S < 1 && S !== level);
      let builds = 0; const mayBuild = BIG ? () => budget.may() : () => builds++ < BUILDS_PER_FRAME || frameNo < 4 || scene.eager;
      const nx = Math.ceil((B.x1 - B.x0) / CH), ny = Math.ceil((B.y1 - B.y0) / CH);
      const cx0 = Math.max(0, Math.floor((v.x0 - B.x0) / CH)), cx1 = Math.min(nx - 1, Math.floor((v.x1 - B.x0) / CH));
      const cy0 = Math.max(0, Math.floor((v.y0 - B.y0) / CH)), cy1 = Math.min(ny - 1, Math.floor((v.y1 - B.y0) / CH));
      let nch = 0; staleN = 0;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        let ch = chunk(level, cx, cy, mayBuild), lv = level;
        if (!ch) for (const alt of [0.5, 1, 0.25]) { const m = levels.get(alt); const c2 = m && m.get(cx + "," + cy); if (c2) { ch = c2; lv = alt; break; } }
        if (!ch) continue;
        const wx = B.x0 + cx * CH, wy = B.y0 + cy * CH;
        const dx0 = Math.round(wx * S + v.ox), dy0 = Math.round(wy * S + v.oy);
        const dx1 = Math.round((wx + CH) * S + v.ox), dy1 = Math.round((wy + CH) * S + v.oy);
        g.drawImage(ch.c, 0, 0, Math.round(CH * lv), Math.round(CH * lv), dx0, dy0, dx1 - dx0, dy1 - dy0);
        nch++;
      }
      g.imageSmoothingEnabled = false;
      groundOverlays(v, now);
      const tItems = performance.now(); scene.stats.groundMs = tItems - t0; scene.stats.nearStale = staleN;
      // items: visible statics merged with the sorted movers; x-ray what covers the target
      g.imageSmoothingEnabled = S < 1;
      const night = scene.nightAlpha(scene.minute);
      const ms = scene.movers;
      const gh = ghosts(), ghost = scene.ghost = gh ? gh.set : null;
      let i = 0, j = 0, n = 0;
      const pad = 2;
      const dyn = [];
      for (const [fx, fy] of fountains) { const spr = art.fountainJet(Math.floor(now / 140) % 6), p = proj.toWorld(fx, fy); dyn.push({ img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0] - spr.ax), wy: Math.round(p[1] - spr.ay), depth: proj.depth(fx, fy) }); }
      // mover sources registered with scene.addMovers (crowd, trains, pings): their items join the merge
      const vv = { S, ox: v.ox, oy: v.oy, x0: v.x0, y0: v.y0, x1: v.x1, y1: v.y1, lod: "near", level, night };
      for (const src of moverSources) if (src.items) src.items(vv, dyn);
      const merged = dyn.length ? ms.concat(dyn).sort((a, b) => a.depth - b.depth) : ms;
      v.mip = BIG && S < 0.75;
      // a big town draws its sprites unfiltered: the half copies land 1:1 at 0.5, and between the steps (a zoom on
      // its way) the unfiltered draw costs a quarter of the filtered one in software
      if (BIG) g.imageSmoothingEnabled = false;
      // the depth band (view.md 3.3.5): only statics whose ground point can show on screen
      let iEnd = statics.length;
      if (BIG) {
        const zk = proj.zk || 1, dlo = proj.depthOfWorldY(v.y0 - 40 * zk) - 2, dhi = proj.depthOfWorldY(v.y1 + 640 * zk) + 2;
        i = lowerBound(statics, dlo); iEnd = lowerBound(statics, dhi + 1e-9);
      }
      const boxed = new Set();
      while (i < iEnd || j < merged.length) {
        const s = i < iEnd ? statics[i] : null, m = j < merged.length ? merged[j] : null;
        const it = m && (!s || m.depth < s.depth) ? (j++, m) : (i++, s);
        if (it.rec && it.rec.big) { // a region building: its cached sprite, else a box at near scale while it builds
          if (it.wx > v.x1 + pad || it.wy > v.y1 + pad || it.wx + it.sw < v.x0 - pad || it.wy + it.sh < v.y0 - pad) continue;
          const e = spriteOf(it.rec);
          if (!e) {
            if (!boxed.has(it.rec)) { boxed.add(it.rec); CV.boxBuilding(g, it.rec.B, S, -v.ox / S, -v.oy / S, { proj, windows: 0 }); n++; }
            continue;
          }
          it.img = e.c;
        }
        if (it.draw) { // a seam item: {depth, wx, wy, wx1, wy1, draw(g, S, ox, oy)}
          if (it.wx > v.x1 + pad || it.wy > v.y1 + pad || it.wx1 < v.x0 - pad || it.wy1 < v.y0 - pad) continue;
          it.draw(g, S, v.ox, v.oy); n++;
          continue;
        }
        if (it.wx > v.x1 + pad || it.wy > v.y1 + pad || it.wx + it.sw < v.x0 - pad || it.wy + it.sh < v.y0 - pad) continue;
        if (!(ghost && it.rec && ghost.has(it.rec) && ghostBlit(it.img, it.sx, it.sy, it.sw, it.sh, it.wx, it.wy, v, gh.rect))) blit(it.img, it.sx, it.sy, it.sw, it.sh, it.wx, it.wy, v);
        if (it.extra) it.extra(g, v);
        n++;
      }
      scene.stats.items = n; scene.stats.chunks = nch; scene.stats.boxes = boxed.size; scene.stats.itemsMs = performance.now() - tItems;
      if (BIG && chunks && frameNo % 30 === 0) { chunks.begin(); chunks.trim(lowCap() - nearPx()); }
      if (BIG) {
        const st = lastNearView && lastNearView[0] === v.S && lastNearView[1] === v.ox && lastNearView[2] === v.oy; lastNearView = [v.S, v.ox, v.oy];
        const a = performance.now(); buildQueued(budget, 4, st); scene.stats.spriteMs = performance.now() - a;
        if (st && !spriteQueue.size && !scene.stats.boxes) prefetch();
      }
      smoke(v, now);
      // rain: an overcast wash, so a still frame reads as wet weather too
      const raining = scene.weather === "rain" || scene.weather === "storm";
      if (raining) { g.fillStyle = "rgba(40,50,70,0.15)"; g.fillRect(0, 0, cv.width, cv.height); }
      // night: an alpha tint toward blue, a warm wash at dusk and dawn, then the emissive lights
      if (night > 0) {
        g.fillStyle = `rgba(14,20,58,${(0.58 * night).toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height);
        const dusk = 0.1 * (1 - Math.abs(2 * night - 1));
        if (dusk > 0.005) { g.fillStyle = `rgba(255,140,60,${dusk.toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height); }
        emissive(v, night, now, gh);
      }
      const wet = scene.weather === "rain" || scene.weather === "snow" || scene.weather === "storm";
      if (wet) weather(now, scene.season === "winter" || scene.weather === "snow");
      plane(v, now, night);
      const tL = performance.now();
      labels(v, now);
      scene.stats.labelsMs = performance.now() - tL;
      if (BIG) scene.stats.buildMs = budget.spent;
      scene.stats.draw = performance.now() - t0;
    };

    // --- low zoom (view.md 3.2): mid = ground chunks, movers' marks, upright chunks, tint, lights; far = combined
    // two-step chunks, tint, lights, marks on top. Levels: near/mid the largest of [1, 0.5, 0.25] <= zoom x dpr, far
    // [0.125, 0.0625] by zoom x min(dpr, 1). LOD switches at 0.5 and 0.18, holding 3% below each when coming down.
    let lodCur = null;
    function lodOf(z) {
      if (!BIG) return "near";
      const h = 0.03, nearAt = lodCur === "near" ? 0.5 * (1 - h) : 0.5, midAt = lodCur === "near" || lodCur === "mid" ? 0.18 * (1 - h) : 0.18;
      lodCur = z >= nearAt ? "near" : z >= midAt ? "mid" : "far";
      return lodCur;
    }
    scene.lod = () => lodCur || lodOf(scene.cam.zoom);
    const levelFor = (lod, zoom) => lod === "far" ? (zoom * Math.min(scene.dpr, 1) >= 0.125 ? 0.125 : 0.0625)
      : (zoom * scene.dpr >= 1 ? 1 : zoom * scene.dpr >= 0.5 ? 0.5 : 0.25);
    scene.levelFor = levelFor;
    const budget = CV.makeBudget ? CV.makeBudget(8) : null;
    scene.budget = budget;
    // world-px cells of 512 holding the buildings and trees whose boxes touch them (chunk and occlusion queries)
    const CELL = 512;
    let cellKey = -1, cells = null;
    function cellIndex() {
      if (cellKey === staticsVersion && cells) return cells;
      cellKey = staticsVersion; cells = new Map();
      const put = (x0, y0, x1, y1, o) => {
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
          const k = gx + ":" + gy; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(o);
        }
      };
      for (const r of buildings) put(r.wx0, r.wy0, r.wx1, r.wy1, r);
      for (const it of statics) if (it.kind === "t") put(it.wx, it.wy, it.wx + it.sw, it.wy + it.sh, it);
      return cells;
    }
    function inRect(x0, y0, x1, y1) {
      const idx = cellIndex(), out = new Set();
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
        const l = idx.get(gx + ":" + gy);
        if (l) for (const o of l) out.add(o);
      }
      return [...out].filter(o => o.rec || o.big ? (o.wx0 < x1 && o.wx1 > x0 && o.wy0 < y1 && o.wy1 > y0) : (o.wx < x1 && o.wx + o.sw > x0 && o.wy < y1 && o.wy + o.sh > y0));
    }
    scene.buildingsIn = (x0, y0, x1, y1) => inRect(x0, y0, x1, y1).filter(o => o.big);
    const lowPainter = {
      origin: () => ({ x0: B.x0, y0: B.y0 - 1024 }),
      job(layer, level, wx0, wy0, span) {
        const c = CV.canvas(512, 512), q = c.getContext("2d"), steps = [], job = { c, steps, tag: null };
        if (layer === "g" || layer === "c") for (let k = 0; k < 4; k++) steps.push(() => CV.lowGround(q, R, proj, level, wx0, wy0, 512, scene.season, k * 128, (k + 1) * 128));
        if (layer === "u" || layer === "c" || layer === "l") {
          const list = inRect(wx0, wy0, wx0 + span, wy0 + span).sort((a, b) => a.depth - b.depth);
          if (layer === "l") {
            const minute = scene.minute, bucket = CV.lightBucket(minute);
            job.tag = bucket;
            const step = level >= 0.25 ? 1 : 2;
            steps.push(() => { for (const o of list) if (o.big) CV.lowLights(q, o.B, level, wx0, wy0, CV.lightShare(o.B, minute, null), { proj, step }); });
          } else {
            const win = level >= 0.25 ? 1 : level >= 0.125 ? 2 : 0;
            let boxedN = 0;
            for (let a = 0; a < list.length; a += 8) steps.push(() => {
              q.imageSmoothingEnabled = true;
              for (const o of list.slice(a, a + 8)) {
                if (!o.big) { // a tree: a blob
                  const r = Math.max(1, 9 * level), cxw = o.wx + o.sw / 2, cyw = o.wy + o.sh - 10;
                  CV.lowTree(q, (cxw - wx0) * level, (cyw - wy0) * level, r, scene.season);
                  continue;
                }
                const e = level >= 0.25 ? sprites.get(recKey(o)) : null;
                if (e) {
                  const s = e.s, dx = e.inPlace ? 0 : o.dx, dy = e.inPlace ? 0 : o.dy;
                  q.drawImage(e.c, (s.ox + dx - wx0) * level, (s.oy + dy - wy0) * level, e.c.width * level, e.c.height * level); e.used = frameNo;
                } else { CV.boxBuilding(q, o.B, level, wx0, wy0, { proj, windows: win }); boxedN++; }
              }
              job.tag = boxedN;
            });
          }
        }
        if (!steps.length) steps.push(() => {});
        return job;
      },
    };
    const chunks = CV.makeChunks ? CV.makeChunks(scene, lowPainter) : null;
    scene.chunks = chunks;
    // a phone: the view's 6 MP near budget (coarse pointer, narrow), or scene.phone when the host says
    const isPhone = () => scene.phone != null ? !!scene.phone : (scene.chunkBudget || 12e6) <= 6e6;
    const lowCap = () => scene.chunkCap || (isPhone() ? 10e6 : 24e6);
    scene.isPhone = isPhone;
    // What the region view is doing (view.md 3.2, the smoke tests and the HUD): lod, level, caches, the budget.
    scene.debug = () => {
      const st = scene.stats;
      return { big: BIG, lod: scene.lodNow || lodOf(scene.cam.zoom), level: scene.lodNow === "near" ? null : scene.levelNow || null,
        zoom: scene.cam.zoom, phone: isPhone(), frames: frameNo, drawMs: st.draw || 0, buildMs: st.buildMs || 0, groundMs: st.groundMs || 0,
        itemsMs: st.itemsMs || 0, labelsMs: st.labelsMs || 0, spriteMs: st.spriteMs || 0, lowMs: st.lowMs || 0,
        chunks: chunks ? chunks.size() : 0, chunkMP: chunks ? chunks.mp / 1e6 : 0, chunkCapMP: lowCap() / 1e6, pending: chunks ? chunks.pending : 0,
        chunksBuilt: chunks ? chunks.built : 0, nearMP: nearPx() / 1e6, cacheMP: ((chunks ? chunks.mp : 0) + nearPx()) / 1e6,
        sprites: sprites.size, spriteMP: spriteMP / 1e6, spriteCapMP: scene.spriteCap / 1e6, queue: spriteQueue.size, spriteBuilds: st.spriteBuilds || 0,
        staleSprites: st.staleSprites || 0, items: st.items || 0, boxes: st.boxes || 0, runs: st.runs || 0, splitRuns: st.splitRuns || 0,
        nearStale: scene.lodNow === "near" ? (st.nearStale || 0) + (st.mipMiss || 0) : 0, mipMiss: st.mipMiss || 0, statics_builds: st.statics_builds || 0, staticsMs: st.staticsMs || 0, placeUpdates: st.placeUpdates || 0, buildings: R.buildings.length };
    };
    let lastLowView = null, lastNearView = null;
    // idle prefetch: the far levels over the whole map, so a zoom out finds them baked
    const prefetch = () => { const r = { x0: B.x0, y0: B.y0 - 1024, x1: B.x1, y1: B.y1 }; chunks.prefetch("c", 0.0625, r, budget) || chunks.prefetch("c", 0.125, r, budget); };
    function drawLow(v, lod, now) {
      const S = v.S, far = lod === "far", lv = levelFor(lod, scene.cam.zoom), tLow = performance.now();
      scene.levelNow = lv;
      // the chunk budget (24 MP, 10 on phones) is shared with the near ground cache, which keeps a quarter of it
      trimNear(lowCap() / 4);
      chunks.cap = Math.max(lowCap() / 2, lowCap() - nearPx());
      chunks.begin();
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      g.fillStyle = "#1d2330"; g.fillRect(0, 0, cv.width, cv.height);
      g.imageSmoothingEnabled = true;
      const night = scene.nightAlpha(scene.minute);
      const vv = { S, ox: v.ox, oy: v.oy, x0: v.x0, y0: v.y0, x1: v.x1, y1: v.y1, lod, level: lv, night };
      const [cx0, cy0, cx1, cy1] = chunks.range(lv, v);
      let n = 0;
      const layer = (name, check) => {
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
          const e = chunks.want(name, lv, cx, cy, budget);
          if (check && e.c) check(e);
          if (chunks.draw(g, e, v)) n++;
        }
      };
      if (far) layer("c");
      else {
        layer("g");
        groundOverlays(v, now);
        for (const src of moverSources) if (src.marks) src.marks(g, vv, lod);
        // a u chunk goes stale every 15 frames when 4+ of its boxed buildings now have sprites (cheap check)
        layer("u", frameNo % 15 === 0 ? e => { if (e.tag >= 4) { let k = 0; for (const o of inRect(e.wx0, e.wy0, e.wx0 + e.span, e.wy0 + e.span)) if (o.big && sprites.has(recKey(o))) k++; if (k >= 4) e.stale = true; } } : null);
      }
      if (night > 0) {
        g.fillStyle = `rgba(14,20,58,${(0.58 * night).toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height);
        const dusk = 0.1 * (1 - Math.abs(2 * night - 1));
        if (dusk > 0.005) { g.fillStyle = `rgba(255,140,60,${dusk.toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height); }
        const bucket = CV.lightBucket(scene.minute);
        g.globalCompositeOperation = "lighter"; g.globalAlpha = Math.min(1, night * 1.1);
        layer("l", e => { if (e.tag !== bucket) e.stale = true; });
        g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
      }
      if (far) { groundOverlays(v, now); for (const src of moverSources) if (src.marks) src.marks(g, vv, lod); }
      chunks.refresh(budget);
      // sprites for the view (a mid u chunk re-bakes with them): nearest first, within 4 ms
      // (only while the camera rests: a zoom on its way has no use for them and a big one costs a frame)
      const still = lastLowView && lastLowView[0] === v.S && lastLowView[1] === v.ox && lastLowView[2] === v.oy;
      lastLowView = [v.S, v.ox, v.oy];
      if (!far && still && budget.left() > 0) {
        for (const o of inRect(v.x0, v.y0, v.x1, v.y1)) if (o.big) spriteOf(o);
        buildQueued(budget, 4, true);
      }
      if (still && !chunks.pending) prefetch();
      scene.stats.items = 0; scene.stats.chunks = n; scene.stats.boxes = 0;
      scene.stats.buildMs = budget.spent;
      const tL = performance.now();
      labels(v, now);
      scene.stats.labelsMs = performance.now() - tL; scene.stats.lowMs = tL - tLow;
    }

    // The tiles a place's overlay tint covers: a house's lot (its footprint and garden), or for places without a
    // lot (blocks of flats, shops) the footprint plus a one-tile apron of open ground.
    const tintTiles = places.map((p, i) => {
      const out = [], lot = isHouseLike(p);
      for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = y * W + x;
        if (placeIdx[k] === i || (lot ? lotOf[k] === i : (placeIdx[k] < 0 && !R.isStreet(x, y) && tiles[y][x] !== "~"))) out.push([x, y]);
      }
      if (lot) for (const [x, y] of lotTiles[i]) if (dist(p, x, y) > 1) out.push([x, y]);
      return out;
    });
    scene.tintTiles = id => placeById.has(id) ? tintTiles[placeById.get(id)].map(t => t.slice()) : [];

    // Ground overlays, drawn every frame over the cached ground and under everything upright (never baked
    // into a chunk): overlay tints, the hover tile, the selection and highlight rings, and pings.
    function groundOverlays(v, now) {
      const S = v.S;
      const diamond = (x, y, inset) => {
        const e = inset || 0;
        return [proj.toWorld(x + e, y + e), proj.toWorld(x + 1 - e, y + e), proj.toWorld(x + 1 - e, y + 1 - e), proj.toWorld(x + e, y + 1 - e)].map(([a, b]) => [a * S + v.ox, b * S + v.oy]);
      };
      const path = pts => { g.beginPath(); pts.forEach(([a, b], k) => k ? g.lineTo(a, b) : g.moveTo(a, b)); g.closePath(); };
      // overlay tints: colors {placeId: css colour}, or values {placeId: number} (0..1, or a stage for "condition");
      // over the lot tiles, or the footprint plus a one-tile apron for places without a lot
      const ov = scene.overlay;
      if (ov && (ov.colors || ov.values)) {
        const cond = ov.name === "condition";
        const col = val => cond ? CV.stageColors()[Math.max(0, Math.min(4, Math.round(val)))] : `hsl(${Math.round(10 + 110 * Math.max(0, Math.min(1, val)))} 70% 50%)`;
        // one path per place, filled once, so neighbouring diamonds leave no seams or darker edges
        g.globalAlpha = 0.5;
        const add = pts => pts.forEach(([a, b], k) => k ? g.lineTo(a, b) : g.moveTo(a, b));
        places.forEach((p, i) => {
          const c = ov.colors && ov.colors[p.id] != null ? ov.colors[p.id] : ov.values && ov.values[p.id] != null ? col(ov.values[p.id]) : null;
          if (!c) return;
          g.fillStyle = c;
          g.beginPath();
          for (const [x, y] of tintTiles[i]) { add(diamond(x, y)); g.closePath(); }
          g.fill();
        });
        g.globalAlpha = 1;
      }
      if (scene.hoverTile) {
        const [x, y] = scene.hoverTile;
        path(diamond(x, y)); g.strokeStyle = "rgba(255,255,255,0.7)"; g.lineWidth = Math.max(1, scene.dpr); g.stroke();
      }
      const sel = scene.selected && scene.moverById && scene.moverById(scene.selected);
      if (sel && sel.foot) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        const [fx, fy] = sel.foot;
        const rx = (sel.kind === "person" ? 10 : 22) * S, ry = rx / 2;
        g.strokeStyle = `rgba(255,226,122,${0.6 + 0.4 * pulse})`; g.lineWidth = 2 * scene.dpr;
        g.beginPath(); g.ellipse(fx * S + v.ox, fy * S + v.oy, rx + pulse * 2 * scene.dpr, ry + pulse * scene.dpr, 0, 0, Math.PI * 2); g.stroke();
      }
      const hl = scene.highlight;
      if (hl && hl.agents && scene.moverById) for (const id of hl.agents) {
        if (id === scene.selected) continue;
        const m = scene.moverById(id);
        if (!m || !m.item || !m.foot) continue;
        const pulse = 0.5 + 0.5 * Math.sin(now / 220);
        const rx = (m.kind === "person" ? 10 : 22) * S, ry = rx / 2, cx = m.foot[0] * S + v.ox, cy = m.foot[1] * S + v.oy;
        g.save(); g.shadowColor = "#7fd4ff"; g.shadowBlur = 8 * scene.dpr;
        g.strokeStyle = `rgba(127,212,255,${0.65 + 0.35 * pulse})`; g.lineWidth = 2 * scene.dpr;
        g.beginPath(); g.ellipse(cx, cy, rx + pulse * 2 * scene.dpr, ry + pulse * scene.dpr, 0, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      // pings: two expanding rings for 3 s (the off-screen arrow in the label pass lasts longer). The age is
      // never below 0: a frame's timestamp can be older than a ping stamped late in a long task.
      const keep = [];
      for (const pg of scene.pings) {
        const age = Math.max(0, now - pg.t0);
        if (age >= PING_ARROW_MS) continue;
        keep.push(pg);
        const t = age / PING_MS;
        if (t >= 1) continue;
        for (let k = 0; k < 2; k++) {
          const tt = (t * 2 + k * 0.5) % 1;
          const p = proj.toWorld(pg.x, pg.y);
          const rx = (16 + tt * 70) * S, ry = rx / 2;
          g.strokeStyle = rgba(pg.color, (1 - tt) * 0.9); g.lineWidth = 3 * scene.dpr;
          g.beginPath(); g.ellipse(p[0] * S + v.ox, p[1] * S + v.oy, rx, ry, 0, 0, Math.PI * 2); g.stroke();
        }
      }
      scene.pings = keep;
    }

    function smoke(v, now) {
      for (const rec of smokeOf()) {
        const [sx, sy] = rec.b.smoke;
        if (sx < v.x0 - 200 || sx > v.x1 + 200 || sy < v.y0 - 300 || sy > v.y1 + 50) continue;
        for (let k = 0; k < 9; k++) {
          const t = ((now / 5200) + k / 9) % 1;
          const r = Math.round(3 + t * 10), a = Math.round((0.75 - t * 0.7) * 10) / 10;
          if (a <= 0) continue;
          const spr = art.smokePuff(r, a);
          const x = sx + t * 46 + Math.sin(t * 6 + k) * 4, y = sy - t * 110;
          blit(spr.c, 0, 0, spr.c.width, spr.c.height, x - spr.ax, y - spr.ay, v);
        }
      }
    }

    let hlScratch = null;
    function emissive(v, night, now, gh) {
      const S = v.S, lit = litPlaces(), base = Math.min(1, night * 0.95);
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = base;
      // a see-through building's glows fade with it, where it is see-through
      const ghosted = rec => gh && gh.set.has(rec);
      const glow = (rec, img, wx, wy) => { if (ghosted(rec)) ghostGlow(img, wx, wy, v, gh.rect, base, 0.35); else blit(img, 0, 0, img.width, img.height, wx, wy, v); g.globalAlpha = base; };
      const offView = rec => BIG && rec.big && (rec.wx0 > v.x1 || rec.wy0 > v.y1 || rec.wx1 < v.x0 || rec.wy1 < v.y0);
      for (const rec of buildings) {
        if (!lit.has(rec.p.id) || offView(rec)) continue;
        const gl = glowOf(rec, lit.get(rec.p.id));
        if (!gl || gl.wx > v.x1 || gl.wy > v.y1 || gl.wx + gl.c.width < v.x0 || gl.wy + gl.c.height < v.y0) continue;
        glow(rec, gl.c, gl.wx, gl.wy);
      }
      const occ = occlusionOf();
      if (scene.quality !== "low") {
        lampPts.forEach(([lx, ly], k) => {
          if (occ.lamps[k]) return;
          const p = proj.toWorld(lx, ly);
          if (p[0] < v.x0 - 64 || p[0] > v.x1 + 64 || p[1] < v.y0 - 64 || p[1] > v.y1 + 64) return;
          const o = BIG ? lampState(k, lx, ly) : null;
          if (o && o.hidden) return;
          const img = (o ? o.img : occ.lampImg[k]) || lampGlow;
          blit(img, 0, 0, img.width, img.height, p[0] - 48, p[1] - 25, v);
        });
        for (const rec of buildings) {
          if (offView(rec)) continue;
          const b = rec.b, vis = occ.porch.get(rec) || [], imgs = occ.porchImg.get(rec) || [];
          [b.porch, ...(b.lights || [])].filter(Boolean).forEach((q, k) => { const img = imgs[k] || porchGlow; if (vis[k] !== false) glow(rec, img, q[0] - 22, q[1] - 12); });
        }
        // headlight cones, cut by the buildings nearer the camera like the lamp pools (a bus behind the bank
        // lights the road, not the bank's roof)
        for (const m of scene.movers) if (m.lights != null && m.moving) {
          const spr = art.headlights(m.lights), gx = m.cx - spr.ax, gy = m.cy - spr.ay, w = spr.c.width, h = spr.c.height;
          if (gx > v.x1 || gy > v.y1 || gx + w < v.x0 || gy + h < v.y0) continue;
          if (!hlScratch) hlScratch = CV.canvas(w, h);
          const img = (!BIG && maskedGlow(spr.c, gx, gy, m.depth, null, hlScratch)) || spr.c;
          blit(img, 0, 0, w, h, gx, gy, v);
        }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      // bulbs, neon and beacons sit on top at full strength
      const dot = (wx, wy, w, h, col) => { const x = Math.round(wx * S + v.ox), y = Math.round(wy * S + v.oy); g.fillStyle = col; g.fillRect(x - Math.round(w * S / 2), y, Math.max(1, Math.round(w * S)), Math.max(1, Math.round(h * S))); };
      lampPts.forEach(([lx, ly], k) => { if (occ.lamps[k] || (BIG && lampOcc.has(k) && lampOcc.get(k).hidden)) return; const p = proj.toWorld(lx, ly, 0); if (BIG && (p[0] < v.x0 - 16 || p[0] > v.x1 + 16 || p[1] < v.y0 || p[1] > v.y1 + 50)) return; dot(p[0] + 6, p[1] - 39, 4, 1, `rgba(255,244,200,${night})`); });
      for (const rec of buildings) {
        if (offView(rec)) continue;
        const b = rec.b;
        if (b.neon) { g.fillStyle = `rgba(255,90,140,${0.35 * night})`; g.fillRect(Math.round(b.neon[0] * S + v.ox) - 3, Math.round(b.neon[1] * S + v.oy) - 3, Math.round(b.neon[2] * S) + 6, Math.round(b.neon[3] * S) + 6); }
        if (b.beacon && Math.floor(now / 700) % 2 === 0) dot(b.beacon[0], b.beacon[1], 3, 3, `rgba(255,60,60,${night})`);
      }
      for (const m of scene.movers) if (m.blink && Math.floor(now / 250) % 2 === 0) dot(m.cx, m.cy - 22, 4, 3, `rgba(80,160,255,${Math.max(0.6, night)})`);
    }

    // Rain or snow in screen space, density by viewport area (CSS px). Rain falls as slanted 2-px streaks,
    // 10-14 px long, along the way the drops drift; snow as 2-px flakes.
    const drops = [];
    let lastRain = 0, dropSeed = 0x2545f491;
    // a fixed LCG: the view draws no random numbers (view.md 7)
    const rnd = () => (dropSeed = (Math.imul(dropSeed, 1664525) + 1013904223) >>> 0) / 4294967296;
    function weather(now, snow) {
      const k = scene.dpr, area = (cv.width / k) * (cv.height / k);
      const want = Math.round(area / (snow ? 7000 : 4000) * (scene.quality === "low" ? 0.5 : 1));
      while (drops.length < want) drops.push({ x: rnd() * cv.width, y: rnd() * cv.height, s: 2 + rnd() * 3, l: 10 + rnd() * 4 });
      const dt = Math.max(0, Math.min(0.1, (now - lastRain) / 1000 || 0)); lastRain = now;
      const vx = -80, vy = 520, vl = Math.hypot(vx, vy);
      if (snow) g.fillStyle = "rgba(255,255,255,.9)";
      else { g.strokeStyle = "rgba(200,220,255,0.7)"; g.lineWidth = 2 * k; g.lineCap = "butt"; g.beginPath(); }
      for (let i = 0; i < want; i++) {
        const d = drops[i];
        d.y += (snow ? 40 : vy) * dt * (d.s / 3) * k; d.x += (snow ? Math.sin(d.y / 30) * 12 : vx * (d.s / 3)) * dt * k;
        if (d.y > cv.height) { d.y = -16 * k; d.x = rnd() * (cv.width + 60 * k); }
        if (d.x < -16 * k) d.x = cv.width + 5;
        if (snow) { g.fillRect(d.x, d.y, 2 * k, 2 * k); continue; }
        const L = d.l * k;
        g.moveTo(d.x, d.y); g.lineTo(d.x + vx / vl * L, d.y + vy / vl * L);
      }
      if (!snow) g.stroke();
    }

    function plane(v, now, night) {
      const pl = scene.state && scene.state.plane;
      if (!pl) return;
      const t = Math.max(0, Math.min(1, pl.progress || 0));
      const tx = -12 + t * 104, ty = 20 + t * 10;
      const sh = art.planeShadow(), body = art.plane();
      const p0 = proj.toWorld(tx, ty, 0), p1 = proj.toWorld(tx, ty, 420);
      blit(sh.c, 0, 0, sh.c.width, sh.c.height, p0[0] - sh.ax, p0[1] - sh.ay, v);
      blit(body.c, 0, 0, body.c.width, body.c.height, p1[0] - body.ax, p1[1] - body.ay, v);
      if (night > 0) {
        const S = v.S, x = p1[0] * S + v.ox, y = p1[1] * S + v.oy;
        g.fillStyle = "#ff3a3a"; g.fillRect(Math.round(x - 4 * S), Math.round(y + 9 * S), 2, 2);
        g.fillStyle = "#3aff6a"; g.fillRect(Math.round(x + 4 * S), Math.round(y + 9 * S), 2, 2);
        if (Math.floor(now / 500) % 2 === 0) { g.fillStyle = "#ffffff"; g.fillRect(Math.round(x + 18 * S), Math.round(y - 2 * S), 2, 2); }
      }
    }

    // --- labels and markers in screen space ---------------------------------------------------------------
    // Name plates, badges and bubbles never go under the page's controls: scene.reserved holds their CSS
    // rects (the view refreshes it on resize and toggles), and a plate that would land there moves or drops.
    function labels(v, now) {
      const z = scene.cam.zoom, k = scene.dpr, S = v.S;
      g.font = `600 ${11 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      const blocked = (scene.reserved || []).map(r => [r[0] * k - 2 * k, r[1] * k - 2 * k, r[2] * k + 2 * k, r[3] * k + 2 * k]);
      if (scene.inset && scene.inset.top) blocked.push([0, 0, cv.width, scene.inset.top * k]);
      const placed = blocked.slice();
      const hit = r => placed.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
      const offScreen = r => r[2] < 0 || r[0] > cv.width || r[3] < 0 || r[1] > cv.height;
      // padR leaves room at the right end for an occupancy badge, which sits on the plate's top-right corner
      const plate = (text, x, y, fg, bg, force, padR) => {
        padR = padR || 0;
        const w = g.measureText(text).width + 12 * k + padR, h = 17 * k;
        let r = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
        if (offScreen(r)) return null;
        // a plate cut by the screen edge slides inside, as long as it still sits over its anchor
        const m = (padR ? 10 : 4) * k, dx = r[0] < m ? m - r[0] : r[2] > cv.width - m ? cv.width - m - r[2] : 0;
        if (dx) { if (Math.abs(dx) > w / 2 - 6 * k) return null; r = [r[0] + dx, r[1], r[2] + dx, r[3]]; }
        // the badge pinned to the corner sticks out above the plate, so it must be clear too
        const pin = q => [q[2] - 12 * k, q[1] - 9 * k, q[2] + 6 * k, q[1] + 9 * k], clash = q => hit(q) || (padR > 0 && hit(pin(q)));
        if (!force && clash(r)) { // try just above, then just below, before giving up
          const up = [r[0], r[1] - h - 2 * k, r[2], r[3] - h - 2 * k], dn = [r[0], r[1] + h + 2 * k, r[2], r[3] + h + 2 * k];
          r = !clash(up) && !offScreen(up) ? up : !clash(dn) && !offScreen(dn) ? dn : null;
          if (!r) return null;
        }
        placed.push(r);
        if (padR) placed.push(pin(r));
        g.fillStyle = bg; roundRect(r[0], r[1], w, h, 4 * k); g.fill();
        g.fillStyle = fg; g.fillText(text, (r[0] + r[2] - padR) / 2, (r[1] + r[3]) / 2 + 0.5 * k);
        return r;
      };
      const toScr = (wx, wy) => [wx * S + v.ox, wy * S + v.oy];
      const pulse = Math.floor(now / 400) % 2 === 0;
      const plateOf = new Map();
      const counts = (scene.state && scene.occupancy) || {};
      const padOf = rec => z >= 0.5 && counts[rec.p.id] ? 9 * k : 0;
      // selected person: a bobbing arrow and their name
      const selM = scene.selected && scene.moverById ? scene.moverById(scene.selected) : null;
      if (selM && selM.item) {
        const it = selM.item, [x, y] = toScr(it.wx + it.sw / 2, it.wy);
        const bob = Math.sin(now / 200) * 3 * k;
        arrow(x, y - 6 * k + bob - 4 * k, k);
        plate(selM.name || scene.selected, x, y - 26 * k + bob, "#2a1d05", "#ffe27a", true);
      } else if (selM && selM.insideRec) {
        const rec = selM.insideRec;
        outlineHull(rec, pulse ? "#ffe27a" : "#f6a945", v);
        const an = labelAnchor(rec) || rec.label, [x, y] = toScr(an[0], an[1]);
        plateOf.set(rec, plate(`${(selM.name || "").split(" ")[0]} · inside`, x, y - 4 * k, "#2a1d05", "#ffe27a", true, padOf(rec)));
      }
      // hovered person
      if (scene.hover && scene.hover !== scene.selected && scene.moverById) {
        const m = scene.moverById(scene.hover);
        if (m && m.item) { const [x, y] = toScr(m.item.wx + m.item.sw / 2, m.item.wy); plate(m.name || scene.hover, x, y - 12 * k, "#ffffff", "rgba(20,24,34,.88)", true); }
      }
      // highlighted places
      const hl = scene.highlight;
      if (hl && hl.places) for (const id of hl.places) {
        const rec = buildings.find(r => r.p.id === id);
        if (rec) { outlineHull(rec, pulse ? "#7fd4ff" : "#4ab0f0", v, true); const an = labelAnchor(rec) || rec.label, [x, y] = toScr(an[0], an[1]); if (!plateOf.get(rec)) plateOf.set(rec, plate(rec.p.name, x, y, "#08202e", "#9fdcff", true, padOf(rec))); }
      }
      if (hl && hl.agents && scene.moverById) for (const id of hl.agents) {
        if (id === scene.selected) continue;
        const m = scene.moverById(id);
        if (m && m.item) { const [x, y] = toScr(m.item.wx + m.item.sw / 2, m.item.wy); plate(m.name || id, x, y - 12 * k, "#08202e", "#9fdcff", true); }
        else if (m && m.insideRec) {
          const rec = m.insideRec;
          outlineHull(rec, pulse ? "#7fd4ff" : "#4ab0f0", v, true);
          const an = labelAnchor(rec) || rec.label, [x, y] = toScr(an[0], an[1]);
          if (!plateOf.get(rec)) plateOf.set(rec, plate(`${String(m.name || id).split(" ")[0]} · inside`, x, y - 4 * k, "#08202e", "#9fdcff", true, padOf(rec)));
        }
      }
      // speech bubbles, only over people the camera can see (or the selected one, who is drawn see-through)
      if (z >= 0.5) for (const m of scene.movers) {
        if (!m.bubble) continue;
        if (m.id !== scene.selected && hiddenItem(m)) continue;
        const [x, y] = toScr(m.wx + m.sw / 2, m.wy);
        const s2 = Math.max(1, Math.round(z)) * k, bw = (CV.textWidth(m.bubble[0]) + 6) * s2, bh = 12 * s2;
        const r = [x + 6 * k - s2, y - 4 * k - bh, x + 6 * k + bw, y - 4 * k];
        if (blocked.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
        bubble(x + 6 * k, y - 4 * k, m.bubble[0], m.bubble[1], s2);
      }
      // building names (zoomed in) or district names (zoomed out)
      if (z >= 0.5) {
        // a big town: the named buildings whose label point is near the screen, largest first, at most 40 (view.md 3.3.9)
        const list = !BIG ? buildings : buildings.filter(rec => !rec.decor && rec.p.name && rec.label[0] > v.x0 - 150 && rec.label[0] < v.x1 + 150
          && rec.label[1] > v.y0 - 40 && rec.label[1] < v.y1 + 40).sort((a, b) => b.p.w * b.p.h - a.p.w * a.p.h || (a.p.id < b.p.id ? -1 : 1));
        let shown = 0;
        for (const rec of list) {
          if (BIG && shown >= 40) break;
          if (rec.p.kind === "home" && (rec.p.style !== "apartments" || z < 1)) continue;
          if (plateOf.has(rec)) continue;
          const an = labelAnchor(rec); // re-anchored when a nearer building covers the roof
          if (!an) { plateOf.set(rec, null); continue; }
          const [x, y] = toScr(an[0], an[1]);
          const r = plate(rec.p.name, x, y, "#ffffff", "rgba(20,24,34,.78)", false, padOf(rec));
          plateOf.set(rec, r);
          if (r) shown++;
        }
        if (z >= 0.75) for (const p of parks) { const c = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2, 6); const [x, y] = toScr(c[0], c[1]); plate(p.name, x, y, "#eaffdf", "rgba(28,60,24,.8)"); }
      } else {
        // district names, sized to the district: clamp(9, width / (letters * 1.1), 13) CSS px, letter-spaced
        // only when 12 px or more; kept between the left edge and the control stack, and left out when the
        // pill would be wider than 70% of its district
        const ctlL = (scene.reserved || []).filter(q => q[2] > cv.width / k - 80 && q[1] < cv.height / k * 0.6).reduce((m, q) => Math.min(m, q[0]), cv.width / k);
        for (const d of town.districts) {
          if (!d.rects || !d.rects.length) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const r of d.rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]); }
          let sx0 = Infinity, sx1 = -Infinity;
          for (const [a, b] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) { const q = toScr(...proj.toWorld(a, b, 0)); sx0 = Math.min(sx0, q[0]); sx1 = Math.max(sx1, q[0]); }
          const dw = (sx1 - sx0) / k; // the district's projected width, CSS px
          const name = d.name.toUpperCase(), fs = Math.max(9, Math.min(13, dw / (name.length * 1.1)));
          const text = fs >= 12 ? name.split("").join(" ") : name;
          g.font = `700 ${(fs * k).toFixed(1)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
          const w = g.measureText(text).width + 14 * k, hh = Math.round(fs * 1.65) * k;
          if (w / k > dw * 0.7) continue;
          const c = proj.toWorld((x0 + x1) / 2, (y0 + y1) / 2, 40);
          let [x, y] = toScr(c[0], c[1]);
          // kept on screen clear of the controls, but never slid off its own district onto a neighbour
          const lo = Math.max(4 * k + w / 2, sx0 + w / 2), hi = Math.min(ctlL * k - 4 * k - w / 2, sx1 - w / 2);
          if (lo > hi) continue;
          x = Math.max(lo, Math.min(hi, x));
          const r = [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2];
          if (r[0] < 0 || offScreen(r) || hit(r)) continue;
          placed.push(r);
          g.fillStyle = "rgba(10,14,22,0.55)";
          roundRect(r[0], r[1], w, hh, 5 * k); g.fill();
          g.fillStyle = "rgba(255,255,255,0.88)"; g.fillText(text, x, y + k);
        }
        g.font = `600 ${11 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      }
      pingArrows(v, now, k, blocked, placed);
      // occupancy badges: pinned to the top-right corner of the name plate, or over the roof of a home
      if (z >= 0.5 && scene.state) {
        for (const rec of buildings) {
          const c = counts[rec.p.id];
          if (!c) continue;
          const r = plateOf.get(rec);
          if (r) { badge(String(c), r[2] - 3 * k, r[1], k); continue; }
          if (plateOf.has(rec)) continue; // its plate was dropped: no badge floating on its own
          const an = labelAnchor(rec);
          if (!an) continue;
          const [x, y] = toScr(an[0], an[1]);
          const bx = x + 14 * k, by = y - 4 * k, br = [bx - 10 * k, by - 9 * k, bx + 10 * k, by + 9 * k];
          if (hit(br)) continue;
          placed.push(br);
          badge(String(c), bx, by, k);
        }
      }
    }
    // A ping whose spot is off screen (or under the page's panels) gets a round arrow at the edge of the free
    // area, pointing at it, in the ping's colour; clicking it flies there (scene.pingArrows, CSS px).
    function pingArrows(v, now, k, avoid, placed) {
      const ins = scene.inset || {}, out = [];
      const m = 20 * k, R = 12 * k;
      const L = m, T = (ins.top || 0) * k + m, Rt = cv.width - (ins.right || 0) * k - m, B = cv.height - (ins.bottom || 0) * k - m;
      if (Rt <= L || B <= T) { scene.pingArrows = out; return; }
      const cx = (L + Rt) / 2, cy = (T + B) / 2;
      const seen = new Set();
      for (let n = scene.pings.length - 1; n >= 0; n--) {
        const pg = scene.pings[n], age = Math.max(0, now - pg.t0);
        if (age >= PING_ARROW_MS) continue;
        const w = proj.toWorld(pg.x, pg.y), px = w[0] * v.S + v.ox, py = w[1] * v.S + v.oy;
        if (px >= L - m && px <= Rt + m && py >= T - m && py <= B + m) continue;
        const key = Math.round(pg.x) + "," + Math.round(pg.y);
        if (seen.has(key)) continue;
        seen.add(key);
        // where the line from the centre to the spot leaves the free area
        const dx = px - cx, dy = py - cy, s = Math.min(dx ? (dx > 0 ? Rt - cx : L - cx) / dx : Infinity, dy ? (dy > 0 ? B - cy : T - cy) / dy : Infinity);
        let ax = cx + dx * s, ay = cy + dy * s;
        // slide along the edge off the page's controls (the zoom stack, the minimap)
        for (let tries = 0; tries < 4; tries++) {
          const q = avoid.find(r => ax + R > r[0] && ax - R < r[2] && ay + R > r[1] && ay - R < r[3]);
          if (!q) break;
          if (Math.abs(ax - L) < 1 || Math.abs(ax - Rt) < 1) ay = ay > cy ? q[1] - R - 2 * k : q[3] + R + 2 * k;
          else ax = ax > cx ? q[0] - R - 2 * k : q[2] + R + 2 * k;
          ax = Math.max(L, Math.min(Rt, ax)); ay = Math.max(T, Math.min(B, ay));
        }
        const a = Math.max(0.35, 1 - Math.max(0, age - PING_MS) / (PING_ARROW_MS - PING_MS)), ang = Math.atan2(dy, dx);
        g.save(); g.globalAlpha = a; g.translate(ax, ay);
        g.fillStyle = "rgba(14,18,28,0.9)"; g.beginPath(); g.arc(0, 0, R + 2 * k, 0, Math.PI * 2); g.fill();
        g.fillStyle = pg.color; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
        g.rotate(ang); g.fillStyle = "#14181f";
        g.beginPath(); g.moveTo(7 * k, 0); g.lineTo(-4 * k, -6 * k); g.lineTo(-1 * k, 0); g.lineTo(-4 * k, 6 * k); g.closePath(); g.fill();
        g.restore();
        avoid.push([ax - R, ay - R, ax + R, ay + R]); placed.push([ax - R, ay - R, ax + R, ay + R]);
        out.push({ x0: (ax - R) / k, y0: (ay - R) / k, x1: (ax + R) / k, y1: (ay + R) / k, target: pg.target || { tile: [pg.x, pg.y] } });
      }
      scene.pingArrows = out;
    }
    function roundRect(x, y, w, h, r) {
      g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
    }
    function arrow(x, y, k) {
      g.fillStyle = "#2a1d05";
      g.beginPath(); g.moveTo(x - 7 * k, y - 9 * k); g.lineTo(x + 7 * k, y - 9 * k); g.lineTo(x, y); g.closePath(); g.fill();
      g.fillStyle = "#ffe27a";
      g.beginPath(); g.moveTo(x - 5 * k, y - 8 * k); g.lineTo(x + 5 * k, y - 8 * k); g.lineTo(x, y - 2 * k); g.closePath(); g.fill();
    }
    function bubble(x, y, ch, color, s) {
      const w = (CV.textWidth(ch) + 4) * s, h = 9 * s;
      const bx = Math.round(x), by = Math.round(y - h - 3 * s);
      g.fillStyle = "#1e2028"; g.fillRect(bx - s, by - s, w + 2 * s, h + 2 * s); g.fillRect(bx + s, by + h, 3 * s, 2 * s);
      g.fillStyle = color; g.fillRect(bx, by, w, h); g.fillRect(bx + 2 * s, by + h, s, s);
      CV.pixelText(g, ch, bx + 2 * s, by + 2 * s, "#1e2028", s);
    }
    function badge(text, x, y, k) {
      g.font = `700 ${10 * k}px system-ui, sans-serif`;
      const w = Math.max(16 * k, g.measureText(text).width + 9 * k), h = 15 * k;
      g.fillStyle = "#3a2a10"; roundRect(x - w / 2 - k, y - h / 2 - k, w + 2 * k, h + 2 * k, 8 * k); g.fill();
      g.fillStyle = "#f6c445"; roundRect(x - w / 2, y - h / 2, w, h, 7 * k); g.fill();
      g.fillStyle = "#2a1d05"; g.fillText(text, x, y + 0.5 * k);
      g.font = `600 ${11 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    }
    // The hull's outline; with glow, a soft halo of the same colour round it (dashboard highlights).
    function outlineHull(rec, color, v, glow) {
      if (glow) { g.save(); g.shadowColor = color; g.shadowBlur = 10 * scene.dpr; }
      g.strokeStyle = color; g.lineWidth = 2 * scene.dpr;
      g.beginPath(); rec.hull.forEach(([x, y], i) => { const a = x * v.S + v.ox, b = y * v.S + v.oy; if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.closePath(); g.stroke();
      if (glow) { g.stroke(); g.restore(); }
    }

    // --- hit tests ------------------------------------------------------------------------------------
    // Everything under a CSS point. upright: movers, building hulls and bus stop shelters in one list by draw
    // depth, descending (the painter's key; PLAN decision 80), so the first is what the eye sees there. A
    // building ranks at the depth of its slice in that column where its sprite is solid under the point; on a
    // see-through pixel of its hull (beside a gable, past a roof's corner) it hides nothing and ranks behind
    // all that is drawn there. On equal depth a mover is drawn after the static, so it comes first. ground:
    // a stop's road tile, a park, a home's lot, then the tile itself.
    scene.pickAll = function (cssX, cssY, touch) {
      const [wx, wy] = scene.cssToWorld(cssX, cssY);
      const tol = (touch ? 12 : 4) / scene.cam.zoom;
      const c = [];
      const inBox = (x0, y0, x1, y1) => wx >= x0 - tol && wx <= x1 + tol && wy >= y0 - tol && wy <= y1 + tol;
      for (const m of scene.movers) {
        if (m.hit && inBox(m.wx + m.hit[0], m.wy + m.hit[1], m.wx + m.hit[2], m.wy + m.hit[3])) c.push({ hit: { kind: m.kind === "bus" ? "bus" : "agent", id: m.id }, depth: m.depth, mover: 1 });
      }
      if (dirty) buildStatics();
      for (const r of buildings) {
        if (!inHull(r.hull, wx, wy) && !inHull(r.ground, wx, wy)) continue;
        const sl = r.slices.find(q => wx >= q.wx && wx < q.wx + q.sw);
        c.push({ hit: { kind: "place", id: r.p.id }, depth: sl && opaqueAt(r, wx, wy) ? sl.depth : r.depth - 1e6, mover: 0 });
      }
      for (const it of shelters) if (inBox(it.wx + 4, it.wy + 4, it.wx + it.sw - 2, it.wy + it.sh - 2)) c.push({ hit: { kind: "stop", id: it.ref }, depth: it.depth, mover: 0 });
      for (const src of moverSources) {
        const h = src.pick ? src.pick(wx, wy, tol) : null;
        if (h) c.push({ hit: h, depth: h.depth != null ? h.depth : 1e9, mover: 1 });
      }
      c.sort((a, b) => b.depth - a.depth || b.mover - a.mover);
      const ground = [];
      const [tx, ty] = proj.toTile(wx, wy);
      const x = Math.floor(tx), y = Math.floor(ty);
      if (x >= 0 && y >= 0 && x < W && y < H) {
        const k = y * W + x;
        if (stopAt.has(k)) ground.push({ kind: "stop", id: stopAt.get(k).id });
        const pi = placeIdx[k];
        if (pi >= 0 && places[pi].kind === "park") ground.push({ kind: "place", id: places[pi].id });
        else if (lotOf[k] >= 0) ground.push({ kind: "place", id: places[lotOf[k]].id });
        ground.push({ kind: "tile", x, y });
      }
      return { upright: c.map(q => q.hit), ground };
    };
    scene.tileAt = (cssX, cssY) => {
      const [wx, wy] = scene.cssToWorld(cssX, cssY), [tx, ty] = proj.toTile(wx, wy);
      const x = Math.floor(tx), y = Math.floor(ty);
      return x >= 0 && y >= 0 && x < W && y < H ? [x, y] : null;
    };

    // --- state, looks, season, projection --------------------------------------------------------------
    scene.setLooks = looks => {
      const before = scene.looks;
      scene.looks = looks || {};
      let changed = false;
      const changedIds = [];
      for (const p of places) {
        if (p.kind !== "home") continue;
        const a = before[p.id], b = scene.looks[p.id];
        const sa = a ? JSON.stringify([a.stage | 0, a.works, a.moving, a.listing, a.anyListed, (a.units || []).map(u => [u.vacant, u.listing])]) : "";
        const sb = b ? JSON.stringify([b.stage | 0, b.works, b.moving, b.listing, b.anyListed, (b.units || []).map(u => [u.vacant, u.listing])]) : "";
        if (sa !== sb) {
          changed = true; changedIds.push(p.id);
          if (((a && a.stage) | 0) !== ((b && b.stage) | 0)) {
            const m = isHouseLike(p) ? 1 : 2; // a block's paving reaches two tiles out
            let x0 = p.x - m, y0 = p.y - m, x1 = p.x + p.w + m, y1 = p.y + p.h + m;
            for (const [x, y] of lotTiles[placeById.get(p.id)]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
            invalidateRect(x0, y0, x1, y1);
            if (BIG) invalidateLow(x0, y0, x1, y1);
          }
        }
      }
      if (changed) {
        if (BIG && statics.length && !dirty) scene.updatePlaces(changedIds);
        else dirty = true;
        scene.looksVersion = (scene.looksVersion | 0) + 1;
      }
      return changed;
    };
    scene.setSeason = s => {
      if (!s || s === scene.season || !CV.SEASON[s]) return;
      if (BIG) { // marks stale, clears nothing (view.md 3.3.7): old chunks and sprites draw until the new ones are built
        scene.season = s; chunks.staleAll();
        for (const m of levels.values()) for (const ch of m.values()) ch.stale = true;
        prewarmTiles();
        for (const it of statics) if (it.remake) { const spr = it.remake(s); it.img = spr.c; it.sw = spr.c.width; it.sh = spr.c.height; }
        return;
      }
      scene.season = s; art.clearTiles(); art.clearItems(); bCache.clear(); levels.clear(); dirty = true;
    };
    // Per-place update (view.md 3.3.3): a home's look changed. Its lot items are removed and re-inserted by depth,
    // its sprite re-keys (the old one draws until the new one is built), and its rect is invalidated.
    scene.updatePlace = id => scene.updatePlaces([id]);
    scene.updatePlaces = ids => {
      const idx = new Set(ids.map(id => placeById.get(id)).filter(i => i != null));
      if (!idx.size) return;
      if (!BIG || dirty || !statics.length) { dirty = true; return; }
      const t0 = performance.now();
      const add = [];
      for (const i of idx) {
        const p = places[i];
        if (p.kind === "home") lotItems(add, p, i);
        const B = R.buildingAt(p.x, p.y);
        if (B && B.rec) B.rec.b.glows = null; // (low chunks: setLooks invalidates them when the stage, and so the ground, changes)
      }
      const keep = statics.filter(it => !(idx.has(it.ref) && LOT_KINDS.has(it.kind)));
      const fresh = add.filter(it => LOT_KINDS.has(it.kind));
      if (fresh.length > 64) statics = keep.concat(fresh).sort((a, b) => a.depth - b.depth || a.wx - b.wx);
      else { statics = keep; for (const it of fresh) statics.splice(lowerBound(statics, it.depth + 1e-9), 0, it); }
      scene.stats.placeUpdates = (scene.stats.placeUpdates | 0) + idx.size;
      scene.stats.placeMs = performance.now() - t0;
    };
    function invalidateLow(x0, y0, x1, y1) {
      if (!chunks) return;
      const pts = [proj.toWorld(x0, y0), proj.toWorld(x1, y0), proj.toWorld(x1, y1), proj.toWorld(x0, y1)];
      chunks.invalidate(Math.min(...pts.map(q => q[0])) - 70, Math.min(...pts.map(q => q[1])) - 700, Math.max(...pts.map(q => q[0])) + 70, Math.max(...pts.map(q => q[1])) + 40);
    }
    // every distinct ground tile of the season, drawn once (view.md 3.2's prewarm)
    function prewarmTiles() {
      const t0 = performance.now();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) groundSprite(x, y);
      scene.stats.prewarmMs = performance.now() - t0;
    }
    scene.prewarmTiles = prewarmTiles;
    if (BIG) prewarmTiles();
    scene.setLights = l => {
      if (!l) return;
      if (l.ns === scene.lights.ns && l.ew === scene.lights.ew) return;
      scene.lights = { ns: l.ns, ew: l.ew };
      for (const [it, axis] of signals) { const spr = art.signal(scene.lights[axis] || "red"); it.img = spr.c; }
    };
    scene.setProjection = (kind, rot) => {
      proj = scene.proj = CV.makeProj(kind, W, H, rot || 0);
      art = scene.art = CV.makeArt(proj);
      bCache.clear(); levels.clear(); dirty = true;
      B = proj.bounds(); B.y1 += 24;
    };
    scene.art = art;
    scene.bounds = () => B;
    scene.buildings = () => { if (dirty) buildStatics(); return buildings; };
    scene.buildingOf = id => scene.buildings().find(r => r.p.id === id) || null;
    scene.isRoad = (x, y) => R.isStreet(x, y);
    scene.driveOf = id => { const i = placeById.get(id); for (let k = 0; k < N; k++) if (driveOf[k] === i) return [k % W, Math.floor(k / W)]; return null; };
    scene.prewarm = () => { scene.eager = true; };
    // The V1a-V1b seam (view.md 4.5): a mover source {items(v, out), marks(g, v, lod), pick(wx, wy, r) -> hit | null}.
    // items pushes {depth, wx, wy, wx1, wy1, draw(g, S, ox, oy)} merged by depth at near; marks draws after the
    // ground at mid and on top at far; v = {S, ox, oy, x0, y0, x1, y1, lod, level, night}. Returns a remover.
    scene.addMovers = src => { moverSources.push(src); return () => { const k = moverSources.indexOf(src); if (k >= 0) moverSources.splice(k, 1); }; };
    return scene;
  };
})();
