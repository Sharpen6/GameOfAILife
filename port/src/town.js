// Port of gameofailife/town.py: the 80 x 50 tile map of Millbrook: streets, districts, the 39 places, seeded
// trees, walk and road fields.
//
// `build_map(seed)` is memoized and a TownMap is read-only after it is built: only its lazy caches (walk fields,
// road fields, drive lengths and `memo`) fill in, so Simulations with the same seed share one map and its fields.
// The layout and the places are the same for every seed; the seed only moves the trees. The homes live in
// housing.js and the cast in cast.js; this module uses neither.
//
// Port notes: tiles are [x, y] arrays; the junction set and the caches are keyed by strings ("x,y" and the
// like) or tile indexes; fields are Uint16Array.
(function (G) {
  "use strict";
  const { Rng, mix } = G.rng;

  const W = 80, H = 50;

  // Tile codes shared with the web client. Water is new and is not walkable.
  const GRASS = ".", ROAD = "#", BUILDING = "B", DOOR = "D", PARK = "P", TREE = "T", ENTRY = "e", WATER = "~";
  const WALKABLE = new Set([GRASS, ROAD, PARK, ENTRY]);
  const UNREACHABLE = 65535; // walk distance of a tile no walk reaches

  const ROAD_ROWS = [3, 14, 25, 36]; // east-west streets, x 0 to 79
  const ROAD_COLS = [3, 16, 29, 42, 55, 68]; // north-south streets, y 0 to ROAD_COL_END
  const ROAD_COL_END = 44; // the north-south streets stop at the riverbank (y 45)
  const RIVER_ROWS = [46, 47, 48, 49];
  const STREETS = [ // [name, axis, at]: a "row" street runs east-west along y = at, a "col" street north-south along x = at
    ["Ridge Road", "row", 3], ["Park Avenue", "row", 14], ["Main Street", "row", 25], ["River Road", "row", 36],
    ["Willow Lane", "col", 3], ["Oak Street", "col", 16], ["Market Street", "col", 29],
    ["Center Street", "col", 42], ["Eastgate Road", "col", 55], ["Mill Road", "col", 68],
  ];

  // The 24 blocks between the streets: columns c0-c5 and rows r0-r3.
  const BLOCK_X = [4, 17, 30, 43, 56, 69];
  const BLOCK_Y = [4, 15, 26, 37];
  const BLOCK_W = [12, 12, 12, 12, 12, 11];
  const BLOCK_H = [10, 10, 10, 8];

  const DISTRICTS = [ // [id, name, about, blocks as [column, row]]
    ["maple_grove", "Maple Grove", "ordinary houses, the school, Fresh Market",
      [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]],
    ["hilltop", "Hilltop", "big houses with gardens", [[2, 0], [3, 0]]],
    ["downtown", "Downtown", "offices, hospital, shops, City Hall", [[2, 1], [3, 1], [2, 2], [3, 2]]],
    ["eastgate", "Eastgate", "cheap flats, corner shops", [[4, 0], [4, 1]]],
    ["the_works", "The Works", "the factory by the river", [[4, 2], [5, 2], [4, 3], [5, 3]]],
    ["riverside", "Riverside", "the park along the river", [[0, 3], [1, 3], [2, 3], [3, 3]]],
    ["east_woods", "East Woods", "woodland at the edge of town", [[5, 0], [5, 1]]],
  ];
  const DISTRICT_NAMES = {};
  for (const [did, name] of DISTRICTS) DISTRICT_NAMES[did] = name;

  // Seeded woods, drawn after the park trees from the same stream: [block column, block row, tree density].
  const WOODS = [[5, 0, 0.30], [5, 1, 0.30], [0, 0, 0.04], [0, 3, 0.10], [3, 3, 0.08], [5, 3, 0.10]];
  const EDGE_TREES = 0.12; // the north strip (y 0-2) and the west strip (x 0-2, y 3-44)

  const xy = (x, y) => `${x},${y}`; // a tile as a string key, for sets and maps

  class Place {
    constructor(id, name, kind, x, y, w, h, hours = null, entry = [0, 0], face = null, district = "", style = "",
      floors = 0, tier = null, units = 0) {
      this.id = id;
      this.name = name;
      this.kind = kind; // home, office, bank, townhall, school, hospital, market, shop, cafe, works, park
      this.x = x;
      this.y = y;
      this.w = w;
      this.h = h;
      this.hours = hours; // [open hour, close hour]; null = always
      this.entry = entry; // walkable tile where agents arrive; it always touches a road
      this.face = face; // wall with the door: "n", "s", "e" or "w"; null for parks
      this.district = district;
      this.style = style; // the renderer's model key: house, big_house, apartments, tower, park, ...
      this.floors = floors; // building height; 0 for parks
      this.tier = tier; // homes: "flat", "house" or "big_house"
      this.units = units; // homes inside: 1 for a house, 6 for an apartment block, 0 for everything else
    }

    is_open(hour) {
      if (this.hours === null) return true;
      const [start, end] = this.hours;
      return start <= hour && hour < end;
    }

    to_json() {
      return {
        id: this.id, name: this.name, kind: this.kind,
        x: this.x, y: this.y, w: this.w, h: this.h, entry: this.entry.slice(), face: this.face,
        hours: this.hours ? this.hours.slice() : null, district: this.district, style: this.style,
        floors: this.floors, tier: this.tier, units: this.units,
      };
    }
  }

  // Neighbour indexes of tile c in the order E, W, S, N; -1 off the map.
  function neighbours(c, w, n) {
    const x = c % w;
    return [x + 1 < w ? c + 1 : -1, x ? c - 1 : -1, c + w < n ? c + w : -1, c - w];
  }

  // The tiles and places of the town. Read-only once built; only the lazy caches fill in.
  //
  // Tile index i is (i % w, i // w). Fields are arrays of w * h uint16 values, 65535 = unreachable.
  // `memo` holds values other modules derive from the map alone (and from fixed module data such as the bus
  // timetable), keyed by strings that start with the module's own tag, so Simulations sharing the map share them.
  class TownMap {
    constructor(tiles, places = new Map()) {
      this.tiles = tiles;
      this.places = places; // place id -> Place, in order: non-homes, parks, blocks, houses, big houses
      this.h = tiles.length;
      this.w = tiles.length ? tiles[0].length : 0;
      const cells = [];
      for (const row of tiles) for (const c of row) cells.push(c);
      this._ok = Uint8Array.from(cells, c => (WALKABLE.has(c) ? 1 : 0)); // 1 where walkable, by tile index
      this._road = Uint8Array.from(cells, c => (c === ROAD ? 1 : 0)); // 1 where road, by tile index
      this._fields = new Map(); // goal tile index -> [dist, off]
      this._roads = new Map(); // goal tile index -> road distance
      this._drives = new Map(); // "x,y,place id" -> [tiles, junctions]
      this.memo = new Map(); // derived values other modules cache on the shared map
      this.junctions = new Set(); // road tiles with 3 or more road neighbours, as "x,y"
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          if (this.tiles[y][x] !== ROAD) continue;
          let roads = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this._is_road(x + dx, y + dy)) roads++;
          if (roads >= 3) this.junctions.add(xy(x, y));
        }
      }
    }

    _is_road(x, y) { return 0 <= x && x < this.w && 0 <= y && y < this.h && this.tiles[y][x] === ROAD; }

    walkable(x, y) { return 0 <= x && x < this.w && 0 <= y && y < this.h && WALKABLE.has(this.tiles[y][x]); }

    rows() { return this.tiles.map(r => r.join("")); }

    // --- walk distance fields -------------------------------------------------

    // BFS from `goal` over walkable tiles, cached per goal tile: [dist, off] as Uint16Array.
    //
    // dist[i] is the number of steps from tile i to the goal; off[i] the fewest off-road tiles (counting tile
    // i and the goal) on any shortest walk from tile i. Both are 65535 where the goal can't be reached.
    walk_field(goal) {
      const [gx, gy] = goal;
      if (!(0 <= gx && gx < this.w && 0 <= gy && gy < this.h)) return this._blank_field();
      const g = gy * this.w + gx;
      let f = this._fields.get(g);
      if (f === undefined) {
        f = this._build_walk_field(g);
        this._fields.set(g, f);
      }
      return f;
    }

    _blank_field() {
      const n = this.w * this.h;
      return [new Uint16Array(n).fill(UNREACHABLE), new Uint16Array(n).fill(UNREACHABLE)];
    }

    _build_walk_field(g) {
      const w = this.w, n = this.w * this.h;
      const ok = this._ok, road = this._road;
      const [dist, off] = this._blank_field();
      if (!ok[g]) return [dist, off];
      dist[g] = 0;
      off[g] = 1 - road[g];
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      queue[tail++] = g;
      while (head < tail) {
        const c = queue[head++];
        const d = dist[c] + 1;
        const oc = off[c];
        // Neighbours in the order E, W, S, N.
        for (const nb of neighbours(c, w, n)) {
          if (nb < 0 || !ok[nb]) continue;
          const o = oc + 1 - road[nb];
          if (dist[nb] === UNREACHABLE) {
            dist[nb] = d;
            off[nb] = o;
            queue[tail++] = nb;
          } else if (dist[nb] === d && o < off[nb]) {
            off[nb] = o;
          }
        }
      }
      return [dist, off];
    }

    // A shortest walk from start to goal with the fewest off-road tiles, excluding start.
    //
    // It descends the goal's walk field, ties broken E, W, S, N; [] when start == goal or the goal is
    // unreachable. The start must be a walkable tile.
    path(start, goal) {
      if (start[0] === goal[0] && start[1] === goal[1]) return [];
      const [dist, off] = this.walk_field(goal);
      const w = this.w, n = this.w * this.h;
      const [sx, sy] = start;
      if (!(0 <= sx && sx < w && 0 <= sy && sy < this.h)) return [];
      let c = sy * w + sx;
      if (dist[c] === UNREACHABLE) return [];
      const out = [];
      while (dist[c]) {
        const want = dist[c] - 1;
        let best = -1;
        for (const nb of neighbours(c, w, n)) {
          if (nb >= 0 && dist[nb] === want && (best < 0 || off[nb] < off[best])) best = nb;
        }
        c = best;
        out.push([c % w, Math.floor(c / w)]);
      }
      return out;
    }

    // Minutes on foot from a tile to a place's entry (one tile a minute): O(1) once the field is built.
    walk_minutes(at, place_id) {
      const [x, y] = at;
      if (!(0 <= x && x < this.w && 0 <= y && y < this.h)) return UNREACHABLE;
      return this.walk_field(this.places.get(place_id).entry)[0][y * this.w + x];
    }

    // Steps on foot from one tile to another, such as a bus stop: O(1) once the goal's walk field is built.
    steps(start, goal) {
      const [x, y] = start;
      if (!(0 <= x && x < this.w && 0 <= y && y < this.h)) return UNREACHABLE;
      return this.walk_field(goal)[0][y * this.w + x];
    }

    // --- road fields and drive paths --------------------------------------------

    // BFS from `goal` (a place entry) that steps only onto road tiles, cached per goal tile, as Uint16Array.
    //
    // dist[i] is the number of steps from road tile i to the goal, where only the last step (from the road tile
    // beside the goal onto the goal) leaves the road. It is 0 at the goal and 65535 on every other off-road tile.
    road_field(goal) {
      const [gx, gy] = goal;
      if (!(0 <= gx && gx < this.w && 0 <= gy && gy < this.h)) return this._blank_field()[0];
      const g = gy * this.w + gx;
      let f = this._roads.get(g);
      if (f === undefined) {
        f = this._build_road_field(g);
        this._roads.set(g, f);
      }
      return f;
    }

    _build_road_field(g) {
      const w = this.w, n = this.w * this.h;
      const road = this._road;
      const dist = new Uint16Array(n).fill(UNREACHABLE);
      dist[g] = 0;
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      queue[tail++] = g;
      while (head < tail) {
        const c = queue[head++];
        const d = dist[c] + 1;
        // Neighbours in the order E, W, S, N.
        for (const nb of neighbours(c, w, n)) {
          if (nb >= 0 && road[nb] && dist[nb] === UNREACHABLE) {
            dist[nb] = d;
            queue[tail++] = nb;
          }
        }
      }
      return dist;
    }

    // The route a car takes to a place, excluding start: roads only, apart from the first and last step.
    //
    // From a road tile it descends the place's road field (ties E, W, S, N) to the road tile beside the entry,
    // then steps onto the entry. From a tile beside a road it first steps onto the neighbouring road tile with the
    // smallest road distance (ties E, W, S, N). From anywhere else, such as the middle of a park, it is the walk
    // path. [] when start is the entry or the place cannot be reached.
    drive_path(start, place_id) {
      const goal = this.places.get(place_id).entry;
      const [sx, sy] = start;
      if (sx === goal[0] && sy === goal[1]) return [];
      const w = this.w, n = this.w * this.h;
      if (!(0 <= sx && sx < w && 0 <= sy && sy < this.h)) return [];
      const dist = this.road_field(goal);
      const road = this._road;
      let c = sy * w + sx;
      const out = [];
      if (!road[c]) {
        let best = -1;
        for (const nb of neighbours(c, w, n)) {
          if (nb >= 0 && road[nb] && dist[nb] !== UNREACHABLE && (best < 0 || dist[nb] < dist[best])) best = nb;
        }
        if (best < 0) return this.path([sx, sy], goal);
        c = best;
        out.push([c % w, Math.floor(c / w)]);
      } else if (dist[c] === UNREACHABLE) {
        return this.path([sx, sy], goal);
      }
      while (dist[c]) {
        const want = dist[c] - 1;
        for (const nb of neighbours(c, w, n)) {
          if (nb >= 0 && dist[nb] === want) {
            c = nb;
            break;
          }
        }
        out.push([c % w, Math.floor(c / w)]);
      }
      return out;
    }

    // [tiles, junctions] on drive_path(start, place_id), memoized: [0, 0] at the entry, [65535, 0] when the
    // place cannot be reached. Junctions are the crossings a car may wait at; the start tile does not count.
    drive_length(start, place_id) {
      const key = `${start[0]},${start[1]},${place_id}`;
      let got = this._drives.get(key);
      if (got === undefined) {
        const path = this.drive_path(start, place_id);
        const entry = this.places.get(place_id).entry;
        if (!path.length && !(start[0] === entry[0] && start[1] === entry[1])) {
          got = [UNREACHABLE, 0];
        } else {
          let junctions = 0;
          for (const [x, y] of path) if (this.junctions.has(xy(x, y))) junctions++;
          got = [path.length, junctions];
        }
        this._drives.set(key, got);
      }
      return got;
    }

    // Build every field a tick may need now, so no tick pays for one: the walk and road fields of every
    // place entry and the walk fields of the bus stops. Calling it again builds nothing.
    warm() {
      const { STOP_XY } = G.transit; // transit uses nothing from the town; only the stop tiles are needed
      for (const place of this.places.values()) {
        this.walk_field(place.entry);
        this.road_field(place.entry);
      }
      for (const at of Object.values(STOP_XY)) this.walk_field(at);
    }

    // --- snapshot -------------------------------------------------------------

    // The map part of the God welcome's `town`; the simulation adds homes, housing, stops and timetable.
    map_json() {
      const junctions = Array.from(this.junctions, k => k.split(",").map(Number))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      return {
        w: this.w, h: this.h, tiles: this.rows(),
        places: Array.from(this.places.values(), p => p.to_json()),
        districts: districts_json(), streets: streets_json(),
        road_rows: ROAD_ROWS.slice(), road_cols: ROAD_COLS.slice(), road_col_end: ROAD_COL_END,
        junctions,
      };
    }
  }

  function districts_json() {
    return DISTRICTS.map(([did, name, about, blocks]) => ({
      id: did, name, about,
      rects: blocks.map(([c, r]) => [BLOCK_X[c], BLOCK_Y[r], BLOCK_W[c], BLOCK_H[r]]),
    }));
  }

  function streets_json() { return STREETS.map(([name, axis, at]) => ({ name, axis, at })); }

  // The district whose block holds the tile, or "" for a street or the riverbank.
  function district_at(x, y) {
    for (const [did, , , blocks] of DISTRICTS) {
      for (const [c, r] of blocks) {
        if (BLOCK_X[c] <= x && x < BLOCK_X[c] + BLOCK_W[c] && BLOCK_Y[r] <= y && y < BLOCK_Y[r] + BLOCK_H[r]) return did;
      }
    }
    return "";
  }

  // Street and house number for an entry tile next to a road: [street, number], or [null, null].
  //
  // On an east-west street the number is x * 2 on its north side and x * 2 + 1 on its south side; on a
  // north-south street it is y * 2 on its east side and y * 2 + 1 on its west side.
  function street_of(ex, ey) {
    const rows = {}, cols = {};
    for (const [name, axis, at] of STREETS) (axis === "row" ? rows : cols)[at] = name;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const rx = ex + dx, ry = ey + dy;
      if (dy && rows[ry] !== undefined) return [rows[ry], ex * 2 + (dy < 0 ? 1 : 0)]; // road to the north: the entry is on the south side
      if (dx && cols[rx] !== undefined) return [cols[rx], ey * 2 + (dx > 0 ? 1 : 0)]; // road to the east: the entry is on the west side
    }
    return [null, null];
  }

  // --- the places ---------------------------------------------------------------

  const NON_HOMES = [
    // id, name, kind, style, x, y, w, h, face, floors, hours
    // Downtown
    ["cityhall", "City Hall", "townhall", "city_hall", 32, 16, 6, 4, "n", 3, [8, 17]],
    ["office", "Brightline Tech", "office", "tower", 31, 20, 8, 4, "s", 8, [7, 20]],
    ["hospital", "City Hospital", "hospital", "hospital", 44, 17, 10, 7, "s", 4, null],
    ["cafe", "Corner Cafe", "cafe", "cafe", 31, 27, 4, 3, "n", 2, [6, 23]],
    ["arcade", "Grand Arcade", "shop", "arcade", 31, 31, 9, 4, "s", 3, [9, 21]],
    ["bank", "Millbrook Savings Bank", "bank", "bank", 44, 27, 5, 4, "n", 4, [9, 17]],
    // Maple Grove
    ["school", "Millbrook School", "school", "school", 18, 19, 10, 5, "e", 2, [7, 17]],
    ["diner", "Oak Street Diner", "cafe", "diner", 18, 16, 4, 2, "n", 1, [6, 22]],
    ["market", "Fresh Market", "market", "market", 18, 31, 5, 4, "s", 1, [7, 21]],
    ["bakery", "Maple Bakery", "cafe", "bakery", 24, 32, 4, 3, "s", 1, [6, 18]],
    // Eastgate
    ["grocer", "Eastgate Grocer", "market", "corner_shop", 57, 5, 4, 3, "n", 1, [7, 22]],
    ["noodles", "Noodle Bar", "cafe", "noodle_bar", 63, 5, 4, 3, "n", 2, [11, 24]],
    // The Works
    ["works", "Millbrook Works", "works", "factory", 57, 28, 10, 7, "s", 2, [6, 22]],
  ];

  const PARKS = [ // id, name, x, y, w, h, entry; trees are seeded in this order
    ["park", "Riverside Park", 17, 37, 25, 8, [23, 37]],
    ["maple_park", "Maple Park", 17, 4, 12, 10, [22, 13]],
    ["square", "Fountain Square", 50, 27, 5, 9, [52, 26]],
    ["green", "Eastgate Green", 63, 16, 5, 8, [65, 24]],
  ];

  const APARTMENTS = [ // id, name, x, y, w, h, face, floors; each block holds six flats
    ["birch_court", "Birch Court", 57, 10, 5, 3, "s", 3],
    ["cedar_court", "Cedar Court", 63, 10, 5, 3, "s", 3],
    ["elm_court", "Elm Court", 57, 21, 5, 3, "s", 3],
  ];
  const FLAT_UNITS = 6;

  // Ordinary houses [x, y, w, h, face]: 3 x 3, three to a row; top rows face north, bottom rows south.
  function house_slots() {
    const out = [];
    for (const [c, r, both_rows] of [[0, 1, true], [0, 2, true], [1, 2, false]]) {
      const x0 = BLOCK_X[c], y0 = BLOCK_Y[r];
      for (const top of (both_rows ? [true, false] : [true])) {
        for (let i = 0; i < 3; i++) {
          out.push(top ? [x0 + 1 + 4 * i, y0 + 1, 3, 3, "n"] : [x0 + 1 + 4 * i, y0 + 6, 3, 3, "s"]);
        }
      }
    }
    return out;
  }

  // Big houses on Hilltop [x, y, w, h, face]: 5 x 4, two to a block, facing south over Park Avenue.
  function big_house_slots() {
    const out = [];
    for (const c of [2, 3]) for (let i = 0; i < 2; i++) out.push([BLOCK_X[c] + 1 + 6 * i, BLOCK_Y[0] + 5, 5, 4, "s"]);
    return out;
  }

  function check(ok, what) {
    if (!ok) throw new G.py.PyError("AssertionError", String(what));
  }

  // Stamp a building with its door in the middle of the `face` wall; return its entry tile.
  function _building(tiles, x, y, w, h, face) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        check(tiles[yy][xx] === GRASS, [x, y, xx, yy, tiles[yy][xx]]);
        tiles[yy][xx] = BUILDING;
      }
    }
    let door, entry;
    if (face === "s") {
      door = [x + Math.floor(w / 2), y + h - 1]; entry = [x + Math.floor(w / 2), y + h];
    } else if (face === "n") {
      door = [x + Math.floor(w / 2), y]; entry = [x + Math.floor(w / 2), y - 1];
    } else if (face === "e") {
      door = [x + w - 1, y + Math.floor(h / 2)]; entry = [x + w, y + Math.floor(h / 2)];
    } else {
      door = [x, y + Math.floor(h / 2)]; entry = [x - 1, y + Math.floor(h / 2)];
    }
    tiles[door[1]][door[0]] = DOOR;
    check(tiles[entry[1]][entry[0]] === GRASS, [x, y, face, entry]);
    tiles[entry[1]][entry[0]] = ENTRY;
    return entry;
  }

  // build_map's memo (Python: functools.lru_cache(maxsize=4)): towns are read-only, so callers share them.
  const _towns = new Map();
  const TOWNS_KEPT = 4;

  // The town for a seed. Memoized: callers share the returned map and must never change it.
  function build_map(seed) {
    const key = String(seed);
    const hit = _towns.get(key);
    if (hit) {
      _towns.delete(key); // most recently used goes last
      _towns.set(key, hit);
      return hit;
    }
    const town = _build_map(seed);
    _towns.set(key, town);
    if (_towns.size > TOWNS_KEPT) _towns.delete(_towns.keys().next().value);
    return town;
  }

  function _build_map(seed) {
    const rng = new Rng(mix(seed, 0x9E3779B1, 7)); // the map stream: park trees, then woods
    const tiles = [];
    for (let y = 0; y < H; y++) tiles.push(new Array(W).fill(GRASS));
    for (const y of RIVER_ROWS) tiles[y] = new Array(W).fill(WATER);
    for (const y of ROAD_ROWS) tiles[y] = new Array(W).fill(ROAD);
    for (const x of ROAD_COLS) for (let y = 0; y < ROAD_COL_END + 1; y++) tiles[y][x] = ROAD;

    const places = new Map();
    for (const [pid, name, kind, style, x, y, w, h, face, floors, hours] of NON_HOMES) {
      const entry = _building(tiles, x, y, w, h, face);
      places.set(pid, new Place(pid, name, kind, x, y, w, h, hours, entry, face, district_at(x, y), style, floors));
    }
    for (const [pid, name, x, y, w, h, entry] of PARKS) {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) if (tiles[yy][xx] === GRASS) tiles[yy][xx] = PARK;
      }
      for (let k = 0; k < Math.floor(w * h / 8); k++) {
        const tx = rng.int(x, x + w - 1);
        const ty = rng.int(y, y + h - 1);
        if (tiles[ty][tx] === PARK && !(tx === entry[0] && ty === entry[1])
            && Math.abs(tx - entry[0]) + Math.abs(ty - entry[1]) > 1) tiles[ty][tx] = TREE;
      }
      tiles[entry[1]][entry[0]] = ENTRY;
      places.set(pid, new Place(pid, name, "park", x, y, w, h, null, entry.slice(), null, district_at(x, y), "park", 0));
    }
    for (const [pid, name, x, y, w, h, face, floors] of APARTMENTS) {
      const entry = _building(tiles, x, y, w, h, face);
      places.set(pid, new Place(pid, name, "home", x, y, w, h, null, entry, face, district_at(x, y), "apartments",
        floors, "flat", FLAT_UNITS));
    }
    for (const [tier, floors, slots] of [["house", 1, house_slots()], ["big_house", 2, big_house_slots()]]) {
      for (const [x, y, w, h, face] of slots) {
        const entry = _building(tiles, x, y, w, h, face);
        const [street, number] = street_of(entry[0], entry[1]);
        const pid = `${street.split(/\s+/)[0].toLowerCase()}_${number}`;
        places.set(pid, new Place(pid, `${number} ${street}`, "home", x, y, w, h, null, entry, face,
          district_at(x, y), tier, floors, tier, 1));
      }
    }

    // Woods and edge trees: grass tiles more than one tile (Chebyshev) from every entry.
    const near_entry = new Set();
    for (const p of places.values()) {
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) near_entry.add(xy(p.entry[0] + dx, p.entry[1] + dy));
    }
    const cells = [];
    for (const [c, r, density] of WOODS) {
      for (let y = BLOCK_Y[r]; y < BLOCK_Y[r] + BLOCK_H[r]; y++) {
        for (let x = BLOCK_X[c]; x < BLOCK_X[c] + BLOCK_W[c]; x++) cells.push([x, y, density]);
      }
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < 3; y++) cells.push([x, y, EDGE_TREES]); // north strip, by column
    for (let y = 3; y < 45; y++) for (let x = 0; x < 3; x++) cells.push([x, y, EDGE_TREES]); // west strip, by row
    for (const [x, y, density] of cells) {
      if (tiles[y][x] === GRASS && !near_entry.has(xy(x, y)) && rng.random() < density) tiles[y][x] = TREE;
    }
    return new TownMap(tiles, places);
  }

  G.town = {
    W, H, GRASS, ROAD, BUILDING, DOOR, PARK, TREE, ENTRY, WATER, WALKABLE, UNREACHABLE, ROAD_ROWS, ROAD_COLS,
    ROAD_COL_END, RIVER_ROWS, STREETS, BLOCK_X, BLOCK_Y, BLOCK_W, BLOCK_H, DISTRICTS, DISTRICT_NAMES, WOODS,
    EDGE_TREES, Place, TownMap, districts_json, streets_json, district_at, street_of, NON_HOMES, PARKS,
    APARTMENTS, FLAT_UNITS, house_slots, big_house_slots, _building, build_map, xy,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
