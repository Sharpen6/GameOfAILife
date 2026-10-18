// CityView region index (view.md 4.5): CV.makeRegion(town) -> R, the one place the view reads tile codes and
// lists the buildings (the town's places and the region's decor) with their sprite variants and shared ids.
// R.code is a Uint8Array of tile codes (region.md 3.1, or town.legend), R.isStreet / isWalk / isRoadLike /
// isRail are the tile predicates every painter and mover uses, R.placeAt maps a tile to its building, and
// R.districts carry their centres. CV.hash2 is the integer hash all low-zoom variation comes from.
// Classic script on window.CityView; no random numbers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};

  // Integer hash of two ints (protoR): the view's only source of variation besides FNV of ids.
  CV.hash2 = (x, y) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) | 0;
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return (h ^ h >>> 16) >>> 0;
  };
  const fnv = s => {
    let h = 0x811c9dc5;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  CV.fnv = CV.fnv || fnv;

  // region.md 3.1: grass, street, building, door yard, park, tree, entry, water, road bridge, level crossing,
  // farmland, rail, rail bridge, platform, highway, highway bridge
  const CODES = ".#BDPTe~bxF=rSHh";
  const STREET = "#bx", WALK = ".#PebxF", ROADLIKE = "#bxHh", RAIL = "=rx";
  // decor rows name a style only; the kind is what the building would be in the sim
  const DECOR_KIND = { tower: "office", apartments: "home", residential_tower: "home", row_houses: "home", house: "home", big_house: "home",
    shop: "shop", restaurant: "cafe", factory: "works", warehouse: "works", hotel: "office" };

  CV.makeRegion = function (town) {
    const W = town.w, H = town.h, tiles = town.tiles;
    const legend = town.legend || null;
    const CODE = {};
    for (let i = 0; i < CODES.length; i++) CODE[CODES[i]] = i;
    if (legend) for (const ch of Object.keys(legend)) if (CODE[ch] == null) CODE[ch] = Object.keys(CODE).length;
    const code = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = tiles[y];
      for (let x = 0; x < W; x++) { const c = CODE[row[x]]; code[y * W + x] = c == null ? 0 : c; }
    }
    // per-code lookups; an optional town.legend {char: {street, walk, road, rail}} overrides the built-in sets
    const n = Object.keys(CODE).length, mk = set => { const t = new Uint8Array(Math.max(16, n)); for (const ch of set) if (CODE[ch] != null) t[CODE[ch]] = 1; return t; };
    const tStreet = mk(STREET), tWalk = mk(WALK), tRoad = mk(ROADLIKE), tRail = mk(RAIL);
    if (legend) for (const [ch, o] of Object.entries(legend)) {
      const k = CODE[ch];
      if (o && typeof o === "object") { if ("street" in o) tStreet[k] = o.street ? 1 : 0; if ("walk" in o) tWalk[k] = o.walk ? 1 : 0; if ("road" in o) tRoad[k] = o.road ? 1 : 0; if ("rail" in o) tRail[k] = o.rail ? 1 : 0; }
    }
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    const pred = t => (x, y) => inb(x, y) && t[code[y * W + x]] === 1;
    const R = {
      w: W, h: H, code, CODE, tiles,
      isStreet: pred(tStreet), isWalk: pred(tWalk), isRoadLike: pred(tRoad), isRail: pred(tRail),
      is: (x, y, ch) => inb(x, y) && tiles[y][x] === ch,
      at: (x, y) => inb(x, y) ? tiles[y][x] : null,
      millbrook: (town.millbrook || [0, 0, 80, 50]).slice(),
      world: town.world || "millbrook",
    };
    const mb = R.millbrook;
    R.inMillbrook = (x, y) => x >= mb[0] && y >= mb[1] && x < mb[0] + mb[2] && y < mb[1] + mb[3];

    // buildings: every place but parks, then the decor rows [x, y, w, h, style, floors, variant]
    const faceOf = (x, y, w, h) => {
      for (let i = 0; i < w; i++) if (R.isStreet(x + i, y + h)) return "s";
      for (let i = 0; i < w; i++) if (R.isStreet(x + i, y - 1)) return "n";
      for (let i = 0; i < h; i++) if (R.isStreet(x + w, y + i)) return "e";
      for (let i = 0; i < h; i++) if (R.isStreet(x - 1, y + i)) return "w";
      return "s";
    };
    const entryFor = (x, y, w, h, f) => f === "s" ? [x + (w >> 1), y + h] : f === "n" ? [x + (w >> 1), y - 1] : f === "e" ? [x + w, y + (h >> 1)] : [x - 1, y + (h >> 1)];
    const buildings = [];
    const add = (p, decor) => {
      const mill = !decor && p.x + p.w <= mb[0] + mb[2] && p.y + p.h <= mb[1] + mb[3] && p.x >= mb[0] && p.y >= mb[1];
      const variant = p.variant != null ? p.variant : mill ? null : fnv(p.id) % 8;
      buildings.push({ p, i: buildings.length, decor, variant, sid: variant == null ? p.id : p.style + "#" + variant });
    };
    for (const p of town.places || []) if (p.kind !== "park") add(p, false);
    (town.decor || []).forEach((d, k) => {
      const [x, y, w, h, style, floors, variant] = d, face = faceOf(x, y, w, h);
      add({ id: "decor_" + k, name: "", kind: DECOR_KIND[style] || "home", style, x, y, w, h, floors: floors || 1, face,
        entry: entryFor(x, y, w, h, face), hours: null, district: "", tier: null, units: 0, variant: variant == null ? null : variant }, true);
    });
    R.buildings = buildings;
    R.placeAt = new Int32Array(W * H).fill(-1);
    for (const b of buildings) {
      const p = b.p;
      for (let y = Math.max(0, p.y); y < Math.min(H, p.y + p.h); y++) for (let x = Math.max(0, p.x); x < Math.min(W, p.x + p.w); x++) R.placeAt[y * W + x] = b.i;
    }
    R.buildingAt = (x, y) => inb(x, y) && R.placeAt[y * W + x] >= 0 ? buildings[R.placeAt[y * W + x]] : null;

    // districts, each with the centre of its largest rect
    R.districts = (town.districts || []).map(d => {
      const rects = (d.rects || []).map(r => r.slice());
      let big = rects[0] || [0, 0, 0, 0];
      for (const r of rects) if (r[2] * r[3] > big[2] * big[3]) big = r;
      return { id: d.id, name: d.name, rects, center: [big[0] + big[2] / 2, big[1] + big[3] / 2] };
    });
    const dIdx = new Int16Array(W * H).fill(-1);
    R.districts.forEach((d, k) => { for (const r of d.rects) for (let y = Math.max(0, r[1]); y < Math.min(H, r[1] + r[3]); y++) for (let x = Math.max(0, r[0]); x < Math.min(W, r[0] + r[2]); x++) if (dIdx[y * W + x] < 0) dIdx[y * W + x] = k; });
    R.districtAt = (x, y) => { x = Math.floor(x); y = Math.floor(y); return inb(x, y) && dIdx[y * W + x] >= 0 ? R.districts[dIdx[y * W + x]].id : ""; };
    R.district = id => R.districts.find(d => d.id === id) || null;

    // rail: each line's tracks as tile-centre polylines (corners + 0.5, view.md 4.1)
    R.rail = town.rail || null;
    R.tracks = [];
    if (R.rail && R.rail.lines) for (const line of R.rail.lines) for (const [track, pts] of Object.entries(line.tracks || {})) {
      R.tracks.push({ line: line.id, track, pts: pts.map(([x, y]) => [x + 0.5, y + 0.5]), tiles: (line.track_tiles || {})[track] || 0 });
    }
    R.big = W * H > 80 * 50 || buildings.length > 150;
    return R;
  };
})();
