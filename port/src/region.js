// Port of gameofailife/region.py: the 256 x 192 region around Millbrook (design-v3/region.md): the region data
// plus build_map(seed).
//
// `build_region(seed)` reads the data once (`GameOfAILife.REGION_DATA`, set by port/build.py's inline script or by
// port/tools/engine.cjs), overlays Millbrook's own tiles (x < 69, y < 50) from `build_map(seed)`, and returns a
// RegionMap: a TownMap with the region's places after Millbrook's 39, priced homes, lot conditions, job slots,
// districts, the railway, highways and decor. Like `build_map` it is memoized and shared read-only; only the lazy
// caches fill in. Millbrook's places are copies that carry a capacity, never the cached `build_map` objects.
//
// Nothing here draws a random number. Prices are applied at load (region.md 4), so tuning them never changes an id.
(function (G) {
  "use strict";
  const T = G.town;

  const W = 256, H = 192;
  const FROZEN = [69, 50]; // x < 69 and y < 50: exactly build_map(seed)'s tiles
  const MILLBROOK = [0, 0, 80, 50]; // Millbrook's 80 x 50 (x, y, w, h); the strip x 69-79 is region data
  const WALK_CODES = ".#PebxF"; // the named tier's walkable tiles: v2's plus road bridge, level crossing and farmland
  const STREET_CODES = "#bx"; // streets: road, road bridge, level crossing
  const CAPACITY_BY_KIND = {
    home: 0, office: 150, bank: 40, townhall: 60, school: 300, hospital: 200,
    market: 60, shop: 80, cafe: 30, works: 120, park: 100, station: 300, venue: 150,
  };

  const _WALK = new Set(WALK_CODES);
  const _STREET = new Set(STREET_CODES);

  // The region data, parsed once and shared: callers must not change it.
  function load_data() {
    const d = G.REGION_DATA;
    if (!d) throw new G.py.PyError("FileNotFoundError", "GameOfAILife.REGION_DATA is not set (data/region.json)");
    return d;
  }

  // v to the nearest multiple of step, halves up (v >= 0).
  function _round_to(v, step) { return Math.trunc(v / step + 0.5) * step; }

  // The region's home rows as HOME_SPECS-shaped arrays with the district table and the station premium applied:
  // value = round100(base x dv x sv), rent = round5(rent x dr x sr), sv/sr within `station.tiles` Manhattan tiles
  // of a station entry.
  function priced_specs(data, places) {
    const pr = data.prices;
    const st = pr.station;
    const stations = data.places.filter(p => p.kind === "station").map(p => p.entry);
    const out = [];
    for (const [hid, pid, unit, tier, beds, base, rent, start, cond] of data.homes) {
      const p = places.get(pid);
      let [vm, rm] = pr.districts[p.district] || [1.0, 1.0];
      const [ex, ey] = p.entry;
      if (stations.some(([sx, sy]) => Math.abs(ex - sx) + Math.abs(ey - sy) <= st.tiles)) {
        vm = vm * st.value;
        rm = rm * st.rent;
      }
      out.push([hid, pid, unit, tier, beds, _round_to(base * vm, 100), _round_to(rent * rm, 5), start, cond]);
    }
    return out;
  }

  // Millbrook and the region on one 256 x 192 grid. Its own walkable and street sets (WALK_CODES, STREET_CODES);
  // town.js's are untouched. The attributes below are set by `build_region`.
  class RegionMap extends T.TownMap {
    constructor(tiles, places) {
      super(tiles, places);
      this.world = "region";
      const cells = [];
      for (const row of tiles) for (const c of row) cells.push(c);
      this._ok = Uint8Array.from(cells, c => (_WALK.has(c) ? 1 : 0));
      this._road = Uint8Array.from(cells, c => (_STREET.has(c) ? 1 : 0));
      this._tile_district = new Map(); // tile index -> district of the region place there (build_region fills it)
      const w = this.w, h = this.h, road = this._road;
      this.junctions = new Set();
      for (let i = 0; i < w * h; i++) {
        if (!road[i]) continue;
        const x = i % w, y = Math.floor(i / w);
        const n = (x + 1 < w && road[i + 1] ? 1 : 0) + (x > 0 && road[i - 1] ? 1 : 0) +
          (y + 1 < h && road[i + w] ? 1 : 0) + (y > 0 && road[i - w] ? 1 : 0);
        if (n >= 3) this.junctions.add(T.xy(x, y));
      }
    }

    _is_road(x, y) { return 0 <= x && x < this.w && 0 <= y && y < this.h && this._road[y * this.w + x] === 1; }

    walkable(x, y) { return 0 <= x && x < this.w && 0 <= y && y < this.h && this._ok[y * this.w + x] === 1; }

    // Inside the rectangle whose tiles are exactly build_map(seed)'s (Rule R's test).
    in_frozen(x, y) { return x < FROZEN[0] && y < FROZEN[1]; }

    // The district of the region place whose footprint or entry is the tile (so it always matches the place's own
    // district, which car_extra and the prices use), else Millbrook's district for a tile of its 80 x 50 (v2's
    // blocks), else the region district whose rect holds it, else "" (a street, the river, a highway).
    district_at(x, y) {
      if (0 <= x && x < this.w && 0 <= y && y < this.h) {
        const own = this._tile_district.get(y * this.w + x);
        if (own !== undefined) return own;
      }
      const [mx, my, mw, mh] = MILLBROOK;
      if (mx <= x && x < mx + mw && my <= y && y < my + mh) return T.district_at(x, y);
      for (const d of this.districts) {
        for (const [rx, ry, rw, rh] of d.rects) {
          if (rx <= x && x < rx + rw && ry <= y && y < ry + rh) return d.id;
        }
      }
      return "";
    }

    // Build only what the 60 need (region.md 6.2): the walk and road fields of Millbrook's 39 places and the walk
    // fields of the bus stops; then, once a Simulation with townsfolk has built the road graph they travel on
    // (roads.roadnet), its trees toward every place, so a shift's end never pays for them. Calling it again builds
    // nothing.
    warm() {
      const { STOP_XY } = G.transit;
      for (const place of this.places.values()) {
        if (this.millbrook_ids.has(place.id)) {
          this.walk_field(place.entry);
          this.road_field(place.entry);
        }
      }
      for (const at of Object.values(STOP_XY)) this.walk_field(at);
      const net = this.memo.get("roadnet");
      if (net !== undefined) net.warm(this.places.keys());
    }

    // One more region walk field per idle frame: not built tonight (PLAN 1, the 60 stay in Millbrook).
    warm_next() { return false; }

    // The map part of the region welcome's `town` (region.md 8): v2's keys at 256 x 192 without
    // road_rows/road_cols/road_col_end, places with `capacity`, and the region's own keys.
    map_json() {
      const junctions = Array.from(this.junctions, k => k.split(",").map(Number))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      return {
        w: this.w, h: this.h, tiles: this.rows(),
        places: Array.from(this.places.values(), p => p.to_json()),
        districts: this.districts, streets: T.streets_json(),
        junctions,
        world: this.world, millbrook: MILLBROOK.slice(),
        rail: this.rail, highways: this.highways,
        interchanges: this.interchanges.map(p => p.slice()), decor: this.decor,
      };
    }
  }

  // build_region's memo (Python: functools.lru_cache(maxsize=4)): regions are read-only, so callers share them.
  const _regions = new Map();
  const REGIONS_KEPT = 4;

  // The region for a seed (only Millbrook's trees depend on it). Memoized: callers share the returned map and must
  // never change it.
  function build_region(seed) {
    const key = String(seed);
    const hit = _regions.get(key);
    if (hit) {
      _regions.delete(key); // most recently used goes last
      _regions.set(key, hit);
      return hit;
    }
    const region = _build_region(seed);
    _regions.set(key, region);
    if (_regions.size > REGIONS_KEPT) _regions.delete(_regions.keys().next().value);
    return region;
  }

  // Tile index -> district for the region places' footprints, then their entry tiles (first place wins), so
  // district_at agrees with each place's own district where the rects do not (quayside_station's footprint and
  // entry lie in downtown_riverton's rect). Millbrook's places keep v2's blocks.
  function _tile_districts(m) {
    const out = new Map();
    const mine = Array.from(m.places.values()).filter(p => !m.millbrook_ids.has(p.id));
    for (const p of mine) {
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          const i = y * m.w + x;
          if (!out.has(i)) out.set(i, p.district);
        }
      }
    }
    for (const p of mine) {
      const i = p.entry[1] * m.w + p.entry[0];
      if (!out.has(i)) out.set(i, p.district);
    }
    return out;
  }

  function _build_region(seed) {
    const d = load_data();
    const [fw, fh] = d.frozen;
    const mb = T.build_map(seed);
    const tiles = d.rows.map(row => row.split(""));
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) tiles[y][x] = mb.tiles[y][x];
    const places = new Map();
    for (const [pid, p] of mb.places) places.set(pid, p.replace({ capacity: CAPACITY_BY_KIND[p.kind] }));
    for (const p of d.places) {
      places.set(p.id, new T.Place(p.id, p.name, p.kind, p.x, p.y, p.w, p.h,
        p.hours && p.hours.length ? p.hours.slice() : null, p.entry.slice(), p.face,
        p.district, p.style, p.floors, p.tier, p.units, p.capacity));
    }
    const m = new RegionMap(tiles, places);
    m.millbrook_ids = new Set(mb.places.keys());
    m._tile_district = _tile_districts(m);
    m.home_specs = priced_specs(d, places);
    m.lot_conditions = Object.assign({}, d.lots);
    m.job_slots = d.jobs.map(([t, pid, w, s, e, days, n]) => [t, pid, w, s, e, days.slice(), n]);
    m.districts = T.districts_json().concat(d.districts);
    m.rail = d.rail;
    m.decor = d.decor;
    m.prices = d.prices;
    m.highways = d.highways;
    m.interchanges = d.interchanges.map(p => p.slice());
    m.highway_edges = d.highway_edges.map(([a, b]) => [a.slice(), b.slice()]);
    return m;
  }

  // A region home's listed weekly rent at a lot condition: round5(rent x (0.6 + 0.4 x condition / 100)).
  // `home` is a housing Home or a home_specs row.
  function rent_at(town, home, condition) {
    const rent = Array.isArray(home) ? home[6] : home.rent;
    const [a, b] = town.world === "region" ? town.prices.condition_rent : [0.6, 0.4];
    return _round_to(rent * (a + b * condition / 100), 5);
  }

  // Minutes to park at a place: its district's `parking_minutes` (Downtown 10, Midtown 8), else 0.
  function car_extra(town, place_id) {
    if (town.world !== "region") return 0;
    const did = town.places.get(place_id).district;
    for (const d of town.districts) {
      if (d.id === did) return d.parking_minutes === undefined ? 0 : d.parking_minutes;
    }
    return 0;
  }

  G.region = {
    W, H, FROZEN, MILLBROOK, WALK_CODES, STREET_CODES, CAPACITY_BY_KIND, load_data, priced_specs, RegionMap,
    build_region, rent_at, car_extra, _round_to,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
