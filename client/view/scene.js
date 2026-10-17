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
    let proj = CV.makeProj(opt.projection || "iso", W, H, opt.rot || 0);
    let art = CV.makeArt(proj);
    const g = cv.getContext("2d");
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : tiles[y][x];
    const scene = {
      town, proj, cam: { x: 0, y: 0, zoom: 1 }, dpr: 1, season: "summer", minute: 600, weather: "clear", state: null,
      looks: {}, movers: [], selected: null, hover: null, hoverTile: null, highlight: null, overlay: null,
      pings: [], inset: { top: 0, right: 0, bottom: 0 }, reserved: [], quality: "high", lights: { ns: "green", ew: "red" },
      stats: { items: 0, chunks: 0, built: 0, draw: 0 },
    };
    const placeById = new Map(places.map((p, i) => [p.id, i]));
    scene.placeById = placeById;
    const homePlace = new Map(town.homes.map(h => [h.id, h.place]));

    // --- tile classification (client-derived; no new tile codes) -----------------------------------------
    const N = W * H;
    const placeIdx = new Int16Array(N).fill(-1); // footprint owner
    const lotOf = new Int16Array(N).fill(-1);    // house or big house lot (lawn, fence)
    const zoneOf = new Uint8Array(N);            // 1 paved plaza, 2 works yard
    const pathMask = new Uint8Array(N);          // park paths
    const squareOf = new Uint8Array(N);          // paved square
    const driveOf = new Int16Array(N).fill(-1);  // driveway tile of a home
    const entryOf = new Map();
    const variant = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) variant[y * W + x] = hash(x * 7919 + y * 104729 + 13) % 8;
    places.forEach((p, i) => {
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) placeIdx[y * W + x] = i;
      if (p.entry) entryOf.set(p.entry[1] * W + p.entry[0], i);
    });
    const dist = (p, x, y) => Math.max(p.x - x, x - (p.x + p.w - 1), p.y - y, y - (p.y + p.h - 1), 0);
    const downtown = (town.districts.find(d => d.id === "downtown") || { rects: [] }).rects;
    const inRects = (rects, x, y) => rects.some(r => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
    const isHouseLike = p => p.kind === "home" && p.style !== "apartments";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = tiles[y][x];
      if (c !== "." && c !== "T") continue;
      let best = -1, bd = 9;
      places.forEach((p, i) => {
        if (p.kind === "park") return;
        const d = dist(p, x, y), reach = isHouseLike(p) ? 1 : 2;
        if (d <= reach && d < bd) { bd = d; best = i; }
      });
      if (best >= 0) {
        const p = places[best];
        if (isHouseLike(p)) lotOf[y * W + x] = best;
        else zoneOf[y * W + x] = p.style === "factory" ? 2 : 1;
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
            if (x >= 0 && x < W && useOf[j] === USE.verge && at(nx, y) === "#") { useOf[j] = USE.park; useK[j] = 1; }
          }
      }
    }
    scene.useAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? 0 : useOf[y * W + x];
    scene.lotAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H || lotOf[y * W + x] < 0 ? null : places[lotOf[y * W + x]].id;
    scene.lands = lands;
    const isRoad = (x, y) => {
      if (x >= 0 && y >= 0 && x < W && y < H) return tiles[y][x] === "#";
      // roads run off the map's edges
      const cx = Math.max(0, Math.min(W - 1, x)), cy = Math.max(0, Math.min(H - 1, y));
      if (y >= 0 && y < H) return tiles[y][cx] === "#" && (x < 0 || x >= W);
      if (x >= 0 && x < W) return y < 0 && tiles[0][x] === "#";
      return false;
    };
    const stopAt = new Map();
    for (const s of town.stops) stopAt.set(s.y * W + s.x, s);
    const junctionSet = new Set(town.junctions.map(([x, y]) => y * W + x));

    function groundSprite(x, y) {
      const c = tiles[y][x], i = y * W + x, v = variant[i], s = scene.season;
      if (c === "#") {
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
        return art.apron(v % 4);
      }
      if (c === "e") {
        const p = places[entryOf.get(i)];
        if (p && p.kind === "park") return art.path(s, 15);
        const axis = p && (p.face === "e" || p.face === "w") ? "x" : "y";
        return art.entry(s, axis, zoneOf[i] === 1 || (p && !isHouseLike(p)));
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
      if (zoneOf[i] === 1) return art.pavement(v % 2);
      if (zoneOf[i] === 2) return art.yard(v % 4);
      return art.grass(s, v);
    }

    // --- static items --------------------------------------------------------------------------------------
    // item: { img, sx, sy, sw, sh, wx, wy (world px of the sprite's top-left), depth, kind, ref }
    let statics = [], buildings = [], lampPts = [], signals = [], dirty = true;
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

    function buildStatics() {
      const list = [];
      buildings = [];
      places.forEach((p, i) => {
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
      // trees, benches, park furniture
      const woods = (town.districts.find(d => d.id === "east_woods") || { rects: [] }).rects;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = tiles[y][x], i = y * W + x;
        if (c === "T" && useOf[i] === USE.pitch) continue; // the playing field is kept clear
        if (c === "T") {
          const hv = hash(`${x},${y}`);
          const pine = inRects(woods, x, y) ? hv % 3 !== 0 : (parkAt[i] < 0 && hv % 6 === 0);
          const ox = ((hv >>> 8) % 7 - 3) * 0.04, oy = ((hv >>> 12) % 7 - 3) * 0.04;
          addSprite(list, art.tree(scene.season, pine ? "pine" : "round", (hv >>> 4) % 6), x + 0.5 + ox, y + 0.5 + oy, proj.depth(x + 0.5 + ox, y + 0.5 + oy), "t");
        } else if (c === "P" && !pathMask[i] && hash(`b${x}:${y}`) % 11 === 0) {
          addSprite(list, art.tree(scene.season, "bush", hash(`v${x}`) % 4), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t");
        }
        if (pathMask[i] && hash(`b${x},${y}`) % 4 === 0) addSprite(list, art.bench(), x + 0.82, y + 0.3, proj.depth(x + 0.82, y + 0.3), "p");
      }
      // street lamps on the north kerb of east-west roads and the west kerb of north-south roads
      lampPts = [];
      const nearJ = (x, y) => junctionSet.has(y * W + x) || junctionSet.has(y * W + x + 1) || junctionSet.has(y * W + x - 1) || junctionSet.has((y + 1) * W + x) || junctionSet.has((y - 1) * W + x);
      for (const ry of town.road_rows) for (let x = 2; x < W; x += 4) {
        if (at(x, ry) !== "#" || at(x, ry - 1) === "#" || nearJ(x, ry) || stopAt.has(ry * W + x)) continue;
        addSprite(list, art.lamp(), x + 0.5, ry + 0.07, proj.depth(x + 0.5, ry + 0.07), "l");
        lampPts.push([x + 0.5, ry + 0.07]);
      }
      for (const rx of town.road_cols) for (let y = 2; y < H; y += 4) {
        if (at(rx, y) !== "#" || at(rx - 1, y) === "#" || nearJ(rx, y) || stopAt.has(y * W + rx)) continue;
        addSprite(list, art.lamp(), rx + 0.07, y + 0.5, proj.depth(rx + 0.07, y + 0.5), "l");
        lampPts.push([rx + 0.07, y + 0.5]);
      }
      // traffic lights: north-west pole shows north-south, south-east pole shows east-west
      signals = [];
      for (const [x, y] of town.junctions) {
        if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) continue;
        const a = addSprite(list, art.signal(scene.lights.ns || "green"), x + 0.08, y + 0.08, proj.depth(x + 0.08, y + 0.08), "sig");
        const b = addSprite(list, art.signal(scene.lights.ew || "red"), x + 0.92, y + 0.92, proj.depth(x + 0.92, y + 0.92), "sig");
        signals.push([a, "ns"], [b, "ew"]);
      }
      // bus stop shelters on the kerb
      for (const s of town.stops) {
        const rowRoad = town.road_rows.includes(s.y);
        const tx = rowRoad ? s.x + 0.5 : s.x + 0.06, ty = rowRoad ? s.y + 0.06 : s.y + 0.5;
        addSprite(list, art.shelter((s.lines || ["1"]).join(",")), tx, ty, proj.depth(tx, ty), "stop", s.id);
      }
      // home lots: fences or hedges, listing signs, junk, works and moving vans
      places.forEach((p, i) => {
        if (p.kind !== "home") return;
        const look = scene.looks[p.id] || { stage: 0 };
        const stage = look.stage | 0;
        if (isHouseLike(p)) {
          const inLot = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (lotOf[y * W + x] === i || placeIdx[y * W + x] === i || (p.entry && x === p.entry[0] && y === p.entry[1]));
          const hedge = p.style === "big_house";
          for (const [x, y] of lotTiles[i]) {
            if (driveOf[y * W + x] === i) continue;
            const v = hash(`${x}.${y}`) % 4;
            if (hedge && dist(p, x, y) >= 2 && tiles[y][x] === "." && hash(`gt${x},${y}`) % 7 === 0) // trees in the back garden
              addSprite(list, art.tree(scene.season, "round", hash(`gv${x}`) % 6), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t");
            const edges = [["n", x, y - 1, 0.5, 0.06], ["s", x, y + 1, 0.5, 0.94], ["w", x - 1, y, 0.06, 0.5], ["e", x + 1, y, 0.94, 0.5]];
            for (const [side, nx, ny, ex, ey] of edges) {
              if (inLot(nx, ny)) continue;
              const spr = hedge ? art.hedge(stage, side, scene.season, v) : art.fence(stage, side, v);
              addSprite(list, spr, x + 0.5, y + 0.5, proj.depth(x + ex, y + ey) + 0.02, "f", i);
            }
          }
          const [ex, ey] = p.entry;
          const alongX = p.face === "n" || p.face === "s";
          const beside = (alongX ? [[ex - 1, ey], [ex + 1, ey]] : [[ex, ey - 1], [ex, ey + 1]]).filter(([a, b]) => lotOf[b * W + a] === i && driveOf[b * W + a] !== i);
          const sale = look.listing === "for_sale" ? "sale" : look.listing === "for_rent" ? "rent" : null;
          if (sale && beside.length) { const [a, b] = beside[0]; addSprite(list, art.sign(sale), a + 0.5, b + (p.face === "s" ? 0.75 : 0.25), proj.depth(a + 0.5, b + 0.5), "s", i); }
          // junk on the lot tile nearest the camera
          let best = null, bd = -1e9;
          for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H || lotOf[y * W + x] !== i || driveOf[y * W + x] === i) continue;
            const d = proj.depth(x + 0.5, y + 0.5) - Math.abs(x - (p.x + p.w / 2)) * 0.3;
            if (d > bd) { bd = d; best = [x, y]; }
          }
          if (stage >= 2 && best) addSprite(list, art.junk(stage, hash(p.id) % 3), best[0] + 0.4, best[1] + 0.35, proj.depth(best[0] + 0.4, best[1] + 0.35), "j", i);
          if (look.works && best) addSprite(list, art.skip(), best[0] + 0.5, best[1] + 0.6, proj.depth(best[0] + 0.5, best[1] + 0.6), "j", i);
        } else {
          const [ex, ey] = p.entry;
          const side = [[ex + 1, ey], [ex - 1, ey], [ex, ey + 1], [ex, ey - 1]].filter(([a, b]) => at(a, b) === "." || at(a, b) === "e");
          const t = side[0] || [ex + 1, ey];
          if (look.anyListed) addSprite(list, art.sign("let"), t[0] + 0.5, t[1] + 0.5, proj.depth(t[0] + 0.5, t[1] + 0.5), "s", i);
          // rubbish on the apron by the door of a run-down block: a full bin, then bags, a mattress and scrap
          const o = side[1] || side[0];
          if (stage >= 3 && o) addSprite(list, art.junk(stage >= 4 ? 4 : 2, hash(p.id) % 3), o[0] + 0.5, o[1] + 0.45, proj.depth(o[0] + 0.5, o[1] + 0.45), "j", i);
          if (stage >= 4 && side[0] && side[0] !== o) addSprite(list, art.junk(3, (hash(p.id) + 1) % 3), side[0][0] + 0.3, side[0][1] + 0.6, proj.depth(side[0][0] + 0.3, side[0][1] + 0.6), "j", i);
        }
        if (look.moving && p.entry) { // moving van at the kerb in front of the door
          const [ex, ey] = p.entry;
          const r = [[ex, ey + 1], [ex, ey - 1], [ex + 1, ey], [ex - 1, ey]].find(([a, b]) => at(a, b) === "#");
          if (r) {
            const alongX = r[1] !== ey;
            const d = alongX ? 0 : 1;
            const off = alongX ? [0, r[1] > ey ? -0.2 : 0.2] : [r[0] > ex ? -0.2 : 0.2, 0];
            addSprite(list, art.van(d), r[0] + 0.5 + off[0], r[1] + 0.5 + off[1], proj.depth(r[0] + 0.5 + off[0], r[1] + 0.5 + off[1]) + 0.05, "van", i);
          }
        }
      });
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
            if (h % 11 === 0) addSprite(list, art.tree(scene.season, "bush", (h >>> 4) % 4), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t");
            else if (h % 29 === 1) addSprite(list, art.tree(scene.season, "round", (h >>> 4) % 6), x + 0.5, y + 0.5, proj.depth(x + 0.5, y + 0.5), "t");
            const road = at(x, y + 1) === "#" || at(x + 1, y) === "#" || at(x, y - 1) === "#" || at(x - 1, y) === "#";
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
      occlusion = null;
      staticsVersion++;
    }
    let staticsVersion = 0;

    // --- opaque-pixel masks of building sprites: exact x-ray and "is this person hidden" tests -------------
    function maskOf(rec) {
      const b = rec.b;
      if (b.mask) return b.mask;
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
    // The buildings drawn see-through this frame: those that actually cover the selected person (or the
    // building they are inside), or the first highlighted place. Whole buildings, never single strips.
    let ghostKey = "", ghostSet = null;
    function ghosts() {
      const m = scene.selected && scene.moverById ? scene.moverById(scene.selected) : null;
      if (m && m.item) {
        const it = m.item, h = it.hit || [0, 0, it.sw, it.sh];
        const box = [it.wx + h[0], it.wy + h[1], it.wx + h[2], it.wy + h[3]];
        const out = new Set();
        for (const r of buildings) if (hidesBox(r, box, it.depth)) out.add(r);
        return out.size ? out : null;
      }
      let rec = m && m.insideRec ? m.insideRec : null;
      const hp = scene.highlight && scene.highlight.places && scene.highlight.places[0];
      if (!rec && hp != null) rec = buildings.find(r => r.p.id === hp) || null;
      if (!rec) return null;
      const key = rec.p.id + "|" + staticsVersion;
      if (key !== ghostKey) { ghostKey = key; ghostSet = new Set(buildings.filter(r => r !== rec && hides(r, rec))); }
      return ghostSet.size ? ghostSet : null;
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
    function maskedGlow(src, gx, gy, depth, self) {
      const w = src.width, h = src.height;
      let c = null, q = null;
      for (const r of buildings) {
        if (r === self) continue;
        for (const it of r.slices) {
          if (it.depth <= depth + 0.3 || it.wx >= gx + w || it.wx + it.sw <= gx || it.wy >= gy + h || it.wy + it.sh <= gy) continue;
          if (!c) { c = CV.canvas(w, h); q = c.getContext("2d"); q.drawImage(src, 0, 0); q.globalCompositeOperation = "destination-out"; }
          q.drawImage(it.img, it.sx, it.sy, it.sw, it.sh, it.wx - gx, it.wy - gy, it.sw, it.sh);
        }
      }
      return c;
    }
    function occlusionOf() {
      if (occlusion) return occlusion;
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
    function chunk(level, cx, cy, mayBuild) {
      let m = levels.get(level); if (!m) levels.set(level, m = new Map());
      const key = cx + "," + cy;
      let ch = m.get(key);
      if (!ch && mayBuild()) { ch = { c: renderChunk(level, cx, cy), used: 0 }; m.set(key, ch); scene.stats.built++; evict(); }
      if (ch) ch.used = frameNo;
      return ch;
    }
    function evict() {
      const budget = scene.chunkBudget || 12e6;
      for (;;) {
        let total = 0, old = null;
        for (const m of levels.values()) for (const [k, v] of m) { total += v.c.width * v.c.height; if (v.used < frameNo && (!old || v.used < old[2].used)) old = [m, k, v]; }
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
      if (level < 1) {
        const m1 = levels.get(1), have = m1 && m1.get(cx + "," + cy);
        let src = have && have.c;
        if (!src) {
          if (!scratch) scratch = CV.canvas(CH, CH);
          const sq = scratch.getContext("2d");
          sq.setTransform(1, 0, 0, 1, 0, 0); sq.clearRect(0, 0, CH, CH);
          paintChunk(sq, cx, cy);
          src = scratch;
        }
        q.imageSmoothingEnabled = true; q.imageSmoothingQuality = "high";
        q.drawImage(src, 0, 0, CH, CH, 0, 0, size, size);
        return c;
      }
      paintChunk(q, cx, cy);
      return c;
    }
    function paintChunk(q, cx, cy) {
      const wx0 = B.x0 + cx * CH, wy0 = B.y0 + cy * CH;
      q.imageSmoothingEnabled = false;
      q.setTransform(1, 0, 0, 1, -wx0, -wy0);
      const off = art.tileOffset, iso = proj.kind === "iso";
      const front = iso ? proj.faces : [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
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
      for (const p of places) {
        if (p.kind === "park") continue;
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
        if (p.style !== "big_house") continue;
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
      if (dx1 > dx0 && dy1 > dy0) g.drawImage(img, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
    }

    scene.draw = function (now) {
      const t0 = performance.now();
      frameNo++;
      if (dirty || !statics.length) buildStatics();
      if (!lampGlow) { lampGlow = makeGlow(54, 27, "#ffd890", 0.5); porchGlow = makeGlow(22, 12, "#ffd890", 0.6); }
      const v = scene.view(), S = v.S;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      g.fillStyle = "#1d2330"; g.fillRect(0, 0, cv.width, cv.height);
      // ground: the smallest cached level that is still at least the device scale
      const level = S > 0.5 ? 1 : S > 0.25 ? 0.5 : 0.25;
      g.imageSmoothingEnabled = S < level;
      let builds = 0; const mayBuild = () => builds++ < BUILDS_PER_FRAME || frameNo < 4 || scene.eager;
      const nx = Math.ceil((B.x1 - B.x0) / CH), ny = Math.ceil((B.y1 - B.y0) / CH);
      const cx0 = Math.max(0, Math.floor((v.x0 - B.x0) / CH)), cx1 = Math.min(nx - 1, Math.floor((v.x1 - B.x0) / CH));
      const cy0 = Math.max(0, Math.floor((v.y0 - B.y0) / CH)), cy1 = Math.min(ny - 1, Math.floor((v.y1 - B.y0) / CH));
      let nch = 0;
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
      // items: visible statics merged with the sorted movers; x-ray what covers the target
      g.imageSmoothingEnabled = S < 1;
      const night = scene.nightAlpha(scene.minute);
      const ms = scene.movers;
      const ghost = scene.ghost = ghosts();
      let i = 0, j = 0, n = 0;
      const pad = 2;
      const dyn = [];
      for (const [fx, fy] of fountains) { const spr = art.fountainJet(Math.floor(now / 140) % 6), p = proj.toWorld(fx, fy); dyn.push({ img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0] - spr.ax), wy: Math.round(p[1] - spr.ay), depth: proj.depth(fx, fy) }); }
      const merged = dyn.length ? ms.concat(dyn).sort((a, b) => a.depth - b.depth) : ms;
      while (i < statics.length || j < merged.length) {
        const s = i < statics.length ? statics[i] : null, m = j < merged.length ? merged[j] : null;
        const it = m && (!s || m.depth < s.depth) ? (j++, m) : (i++, s);
        if (it.wx > v.x1 + pad || it.wy > v.y1 + pad || it.wx + it.sw < v.x0 - pad || it.wy + it.sh < v.y0 - pad) continue;
        const alpha = ghost && it.rec && ghost.has(it.rec) ? 0.35 : 1;
        if (alpha !== 1) g.globalAlpha = alpha;
        blit(it.img, it.sx, it.sy, it.sw, it.sh, it.wx, it.wy, v);
        if (alpha !== 1) g.globalAlpha = 1;
        if (it.extra) it.extra(g, v);
        n++;
      }
      scene.stats.items = n; scene.stats.chunks = nch;
      smoke(v, now);
      // night: an alpha tint toward blue, a warm wash at dusk and dawn, then the emissive lights
      if (night > 0) {
        g.fillStyle = `rgba(14,20,58,${(0.58 * night).toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height);
        const dusk = 0.1 * (1 - Math.abs(2 * night - 1));
        if (dusk > 0.005) { g.fillStyle = `rgba(255,140,60,${dusk.toFixed(3)})`; g.fillRect(0, 0, cv.width, cv.height); }
        emissive(v, night, now, ghost);
      }
      const wet = scene.weather === "rain" || scene.weather === "snow" || scene.weather === "storm";
      if (wet) weather(now, scene.season === "winter" || scene.weather === "snow");
      plane(v, now, night);
      labels(v, now);
      scene.stats.draw = performance.now() - t0;
    };

    // Ground overlays: lot tints (dashboard overlays), the hover tile, the selection ellipse and pings.
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
        const col = val => cond ? ["#3ec46a", "#a8d84a", "#f2c84a", "#f08a3a", "#e0402c"][Math.max(0, Math.min(4, Math.round(val)))] : `hsl(${Math.round(10 + 110 * Math.max(0, Math.min(1, val)))} 70% 50%)`;
        // one path per place, filled once, so neighbouring diamonds leave no seams or darker edges
        g.globalAlpha = 0.5;
        const add = pts => pts.forEach(([a, b], k) => k ? g.lineTo(a, b) : g.moveTo(a, b));
        for (const p of places) {
          const c = ov.colors && ov.colors[p.id] != null ? ov.colors[p.id] : ov.values && ov.values[p.id] != null ? col(ov.values[p.id]) : null;
          if (!c) continue;
          g.fillStyle = c;
          g.beginPath();
          const i = placeById.get(p.id), lot = isHouseLike(p);
          for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const k = y * W + x;
            const on = placeIdx[k] === i || (lot ? lotOf[k] === i : (placeIdx[k] < 0 && tiles[y][x] !== "#" && tiles[y][x] !== "~"));
            if (on) { add(diamond(x, y)); g.closePath(); }
          }
          if (lot) for (const [x, y] of lotTiles[i]) if (dist(p, x, y) > 1) { add(diamond(x, y)); g.closePath(); }
          g.fill();
        }
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
      const keep = [];
      for (const pg of scene.pings) {
        const t = (now - pg.t0) / 3000;
        if (t >= 1) continue;
        keep.push(pg);
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

    function emissive(v, night, now, ghost) {
      const S = v.S, lit = litPlaces(), base = Math.min(1, night * 0.95);
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = base;
      // a see-through building's glows fade with it
      const fade = rec => { if (ghost && ghost.has(rec)) g.globalAlpha = base * 0.35; };
      for (const rec of buildings) {
        if (!lit.has(rec.p.id)) continue;
        const gl = glowOf(rec, lit.get(rec.p.id));
        if (!gl || gl.wx > v.x1 || gl.wy > v.y1 || gl.wx + gl.c.width < v.x0 || gl.wy + gl.c.height < v.y0) continue;
        fade(rec);
        blit(gl.c, 0, 0, gl.c.width, gl.c.height, gl.wx, gl.wy, v);
        g.globalAlpha = base;
      }
      const occ = occlusionOf();
      if (scene.quality !== "low") {
        lampPts.forEach(([lx, ly], k) => {
          if (occ.lamps[k]) return;
          const p = proj.toWorld(lx, ly);
          if (p[0] < v.x0 - 64 || p[0] > v.x1 + 64 || p[1] < v.y0 - 64 || p[1] > v.y1 + 64) return;
          const img = occ.lampImg[k] || lampGlow;
          blit(img, 0, 0, img.width, img.height, p[0] - 48, p[1] - 25, v);
        });
        for (const rec of buildings) {
          const b = rec.b, vis = occ.porch.get(rec) || [], imgs = occ.porchImg.get(rec) || [];
          fade(rec);
          [b.porch, ...(b.lights || [])].filter(Boolean).forEach((q, k) => { const img = imgs[k] || porchGlow; if (vis[k] !== false) blit(img, 0, 0, img.width, img.height, q[0] - 22, q[1] - 12, v); });
          g.globalAlpha = base;
        }
        for (const m of scene.movers) if (m.lights != null && m.moving) { const spr = art.headlights(m.lights); blit(spr.c, 0, 0, spr.c.width, spr.c.height, m.cx - spr.ax, m.cy - spr.ay, v); }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      // bulbs, neon and beacons sit on top at full strength
      const dot = (wx, wy, w, h, col) => { const x = Math.round(wx * S + v.ox), y = Math.round(wy * S + v.oy); g.fillStyle = col; g.fillRect(x - Math.round(w * S / 2), y, Math.max(1, Math.round(w * S)), Math.max(1, Math.round(h * S))); };
      lampPts.forEach(([lx, ly], k) => { if (occ.lamps[k]) return; const p = proj.toWorld(lx, ly, 0); dot(p[0] + 6, p[1] - 39, 4, 1, `rgba(255,244,200,${night})`); });
      for (const rec of buildings) {
        const b = rec.b;
        if (b.neon) { g.fillStyle = `rgba(255,90,140,${0.35 * night})`; g.fillRect(Math.round(b.neon[0] * S + v.ox) - 3, Math.round(b.neon[1] * S + v.oy) - 3, Math.round(b.neon[2] * S) + 6, Math.round(b.neon[3] * S) + 6); }
        if (b.beacon && Math.floor(now / 700) % 2 === 0) dot(b.beacon[0], b.beacon[1], 3, 3, `rgba(255,60,60,${night})`);
      }
      for (const m of scene.movers) if (m.blink && Math.floor(now / 250) % 2 === 0) dot(m.cx, m.cy - 22, 4, 3, `rgba(80,160,255,${Math.max(0.6, night)})`);
    }

    // Rain or snow in screen space, density by viewport area.
    const drops = [];
    let lastRain = 0;
    function weather(now, snow) {
      const want = Math.round(cv.width * cv.height / (snow ? 7000 : 9000) * (scene.quality === "low" ? 0.5 : 1));
      while (drops.length < want) drops.push({ x: Math.random() * cv.width, y: Math.random() * cv.height, s: 2 + Math.random() * 3 });
      const dt = Math.min(0.1, (now - lastRain) / 1000 || 0); lastRain = now;
      g.fillStyle = snow ? "rgba(255,255,255,.9)" : "rgba(170,200,255,.5)";
      const k = scene.dpr;
      for (let i = 0; i < want; i++) {
        const d = drops[i];
        d.y += (snow ? 40 : 520) * dt * (d.s / 3) * k; d.x += (snow ? Math.sin(d.y / 30) * 12 : -80) * dt * k;
        if (d.y > cv.height) { d.y = -8; d.x = Math.random() * (cv.width + 60); }
        if (d.x < -10) d.x = cv.width + 5;
        if (snow) g.fillRect(d.x, d.y, 2 * k, 2 * k); else g.fillRect(d.x, d.y, k, (d.s + 5) * k);
      }
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
        if (!force && hit(r)) { // try just above, then just below, before giving up
          const up = [r[0], r[1] - h - 2 * k, r[2], r[3] - h - 2 * k], dn = [r[0], r[1] + h + 2 * k, r[2], r[3] + h + 2 * k];
          r = !hit(up) && !offScreen(up) ? up : !hit(dn) && !offScreen(dn) ? dn : null;
          if (!r) return null;
        }
        placed.push(r);
        if (padR) placed.push([r[2] - 12 * k, r[1] - 9 * k, r[2] + 6 * k, r[1] + 9 * k]);
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
        const [x, y] = toScr(rec.label[0], rec.label[1]);
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
        if (rec) { outlineHull(rec, pulse ? "#7fd4ff" : "#4ab0f0", v); const [x, y] = toScr(rec.label[0], rec.label[1]); if (!plateOf.get(rec)) plateOf.set(rec, plate(rec.p.name, x, y, "#08202e", "#9fdcff", true, padOf(rec))); }
      }
      if (hl && hl.agents && scene.moverById) for (const id of hl.agents) {
        const m = scene.moverById(id);
        if (m && m.item) { const [x, y] = toScr(m.item.wx + m.item.sw / 2, m.item.wy); plate(m.name || id, x, y - 12 * k, "#08202e", "#9fdcff", true); }
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
        for (const rec of buildings) {
          if (rec.p.kind === "home" && (rec.p.style !== "apartments" || z < 1)) continue;
          if (plateOf.has(rec)) continue;
          const [x, y] = toScr(rec.label[0], rec.label[1]);
          plateOf.set(rec, plate(rec.p.name, x, y, "#ffffff", "rgba(20,24,34,.78)", false, padOf(rec)));
        }
        if (z >= 0.75) for (const p of parks) { const c = proj.toWorld(p.x + p.w / 2, p.y + p.h / 2, 6); const [x, y] = toScr(c[0], c[1]); plate(p.name, x, y, "#eaffdf", "rgba(28,60,24,.8)"); }
      } else {
        g.font = `700 ${13 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        for (const d of town.districts) {
          if (!d.rects || !d.rects.length) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const r of d.rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]); }
          const c = proj.toWorld((x0 + x1) / 2, (y0 + y1) / 2, 40);
          const [x, y] = toScr(c[0], c[1]);
          const text = d.name.toUpperCase().split("").join(" ");
          const w = g.measureText(text).width + 16 * k;
          const r = [x - w / 2, y - 11 * k, x + w / 2, y + 11 * k];
          if (hit(r)) continue;
          placed.push(r);
          g.fillStyle = "rgba(10,14,22,0.55)";
          roundRect(r[0], r[1], w, 22 * k, 5 * k); g.fill();
          g.fillStyle = "rgba(255,255,255,0.88)"; g.fillText(text, x, y + k);
        }
        g.font = `600 ${11 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      }
      // occupancy badges: pinned to the top-right corner of the name plate, or over the roof of a home
      if (z >= 0.5 && scene.state) {
        for (const rec of buildings) {
          const c = counts[rec.p.id];
          if (!c) continue;
          const r = plateOf.get(rec);
          if (r) { badge(String(c), r[2] - 3 * k, r[1], k); continue; }
          if (plateOf.has(rec)) continue; // its plate was dropped: no badge floating on its own
          const [x, y] = toScr(rec.label[0], rec.label[1]);
          const bx = x + 14 * k, by = y - 4 * k, br = [bx - 10 * k, by - 9 * k, bx + 10 * k, by + 9 * k];
          if (hit(br)) continue;
          placed.push(br);
          badge(String(c), bx, by, k);
        }
      }
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
    function outlineHull(rec, color, v) {
      g.strokeStyle = color; g.lineWidth = 2 * scene.dpr;
      g.beginPath(); rec.hull.forEach(([x, y], i) => { const a = x * v.S + v.ox, b = y * v.S + v.oy; if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.closePath(); g.stroke();
    }

    // --- hit tests ------------------------------------------------------------------------------------
    // Every candidate under a CSS point, front to back: movers, then buildings, then the ground.
    scene.pickAll = function (cssX, cssY, touch) {
      const [wx, wy] = scene.cssToWorld(cssX, cssY);
      const tol = (touch ? 12 : 4) / scene.cam.zoom;
      const out = [];
      const ms = scene.movers.filter(m => m.hit).slice().sort((a, b) => b.depth - a.depth);
      for (const m of ms) if (wx >= m.wx + m.hit[0] - tol && wx <= m.wx + m.hit[2] + tol && wy >= m.wy + m.hit[1] - tol && wy <= m.wy + m.hit[3] + tol) out.push({ kind: m.kind === "bus" ? "bus" : "agent", id: m.id });
      const bs = buildings.slice().sort((a, b) => b.depth - a.depth);
      for (const b of bs) if (inHull(b.hull, wx, wy) || inHull(b.ground, wx, wy)) out.push({ kind: "place", id: b.p.id });
      const [tx, ty] = proj.toTile(wx, wy);
      const x = Math.floor(tx), y = Math.floor(ty);
      if (x >= 0 && y >= 0 && x < W && y < H) {
        const k = y * W + x;
        if (stopAt.has(k)) out.push({ kind: "stop", id: stopAt.get(k).id });
        const pi = placeIdx[k];
        if (pi >= 0 && places[pi].kind === "park") out.push({ kind: "place", id: places[pi].id });
        else if (lotOf[k] >= 0 && !out.some(h => h.kind === "place")) out.push({ kind: "place", id: places[lotOf[k]].id });
        out.push({ kind: "tile", x, y });
      }
      return out;
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
      for (const p of places) {
        if (p.kind !== "home") continue;
        const a = before[p.id], b = scene.looks[p.id];
        const sa = a ? JSON.stringify([a.stage | 0, a.works, a.moving, a.listing, a.anyListed, (a.units || []).map(u => [u.vacant, u.listing])]) : "";
        const sb = b ? JSON.stringify([b.stage | 0, b.works, b.moving, b.listing, b.anyListed, (b.units || []).map(u => [u.vacant, u.listing])]) : "";
        if (sa !== sb) {
          changed = true;
          if (((a && a.stage) | 0) !== ((b && b.stage) | 0)) {
            let x0 = p.x - 1, y0 = p.y - 1, x1 = p.x + p.w + 1, y1 = p.y + p.h + 1;
            for (const [x, y] of lotTiles[placeById.get(p.id)]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
            invalidateRect(x0, y0, x1, y1);
          }
        }
      }
      if (changed) { dirty = true; scene.looksVersion = (scene.looksVersion | 0) + 1; }
      return changed;
    };
    scene.setSeason = s => {
      if (!s || s === scene.season || !CV.SEASON[s]) return;
      scene.season = s; art.clearTiles(); art.clearItems(); bCache.clear(); levels.clear(); dirty = true;
    };
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
    scene.isRoad = (x, y) => at(x, y) === "#";
    scene.driveOf = id => { const i = placeById.get(id); for (let k = 0; k < N; k++) if (driveOf[k] === i) return [k % W, Math.floor(k / W)]; return null; };
    scene.prewarm = () => { scene.eager = true; };
    return scene;
  };
})();
