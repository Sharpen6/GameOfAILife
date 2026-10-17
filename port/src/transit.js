// Port of gameofailife/transit.py: buses: two lines round the Main Street loop, eleven stops, and the timetable
// that God and controllers see.
//
// The loop is Main Street (y 25) and Park Avenue (y 14), joined by Willow Lane (x 3) and Mill Road (x 68):
// 152 road tiles. Line 1 drives it clockwise (east on Main Street), line 2 anticlockwise, both from the depot
// corner (3, 25). Each minute a bus moves up to SPEED tiles, stopping early on a stop tile or on the depot
// corner, and stands DWELL extra minutes on a stop. So a lap takes 52 minutes, and the 4 buses of a line run
// 13 minutes apart: bus k of a line is at `route[lap[(tick + k * every) % len(lap)]]`, a pure function of
// the tick that both ports compute alike. Service runs 24 hours.
//
// A bus stands on a stop tile for 2 minutes with its doors open, and a passenger gets on or off in either of
// them. A rider who reaches the stop tile at tick T boards the first bus of the line standing there at T or
// later, and gets off on the tick that bus first stands on the alight stop. `best_trip` gives the minutes door
// to door of the trip the simulation will really make; `worst` takes the longest over a timetable period.
//
// Nothing here uses the town or the simulation; `best_trip` is handed the town and caches what it derives
// from it in `town.memo`. Riders are counted from the agents' `riding` field, so buses keep no state.
(function (G) {
  "use strict";
  const { pyMod } = G.py;

  const BUS_FARE = 2; // dollars a ride, for ages 18 to 64; children and people 65 and over ride free
  const SPEED = 4; // tiles a bus moves in a minute
  const DWELL = 1; // extra minutes a bus stands at each stop (it is on the stop tile for 2 minutes)
  const BUSES_PER_LINE = 4;
  const BUS_LETTERS = "abcd"; // bus k of line "1" is "1" + BUS_LETTERS[k]
  const MIN_SAVING = 5; // minutes a bus trip must save over walking before anyone takes it
  const UNREACHABLE = 65535; // what the town's walk fields give for a tile that cannot reach the goal
  const FLIGHTS = [8 * 60, 14 * 60, 20 * 60]; // minute of the day the plane from Riverton to Lakeside takes off

  // The 11 stops, all on road tiles of the loop, in line 1's driving order: [id, name, tile].
  const STOPS = [
    ["maple_west", "Maple Grove West", [10, 25]], // the Main Street houses
    ["school", "Millbrook School", [28, 25]], // school, Fresh Market, Maple Bakery
    ["downtown_west", "Brightline Tech", [36, 25]], // Brightline, Corner Cafe, Grand Arcade
    ["downtown_east", "City Hospital", [48, 25]], // hospital, bank, Fountain Square
    ["eastgate_south", "Elm Court", [60, 25]], // Elm Court, Eastgate Green, the Works
    ["eastgate_north", "Birch Court", [60, 14]], // Birch and Cedar Court
    ["hilltop_east", "Hilltop", [49, 14]], // 92 and 104 Park Avenue
    ["city_hall", "City Hall", [36, 14]], // City Hall, 66 and 78 Park Avenue
    ["school_north", "Millbrook School North", [28, 14]], // the school from the north
    ["maple_park", "Maple Park", [21, 14]], // Maple Park, Oak Street Diner
    ["maple_north", "Maple Grove North", [10, 14]], // the Park Avenue houses
  ];
  const key = t => `${t[0]},${t[1]}`;
  const STOP_XY = {}; // stop id -> tile
  const STOP_AT = new Map(); // "x,y" -> stop id
  for (const [sid, , at] of STOPS) {
    STOP_XY[sid] = at;
    STOP_AT.set(key(at), sid);
  }

  // One bus line: id "1" or "2", name, corners (the loop's corners in driving order, from the depot corner),
  // route (every tile of the loop in driving order; route[0] is the depot corner), lap (the route index a bus is
  // at in each minute of its lap), every (minutes between two buses), stops (stop ids in driving order) and
  // doors (stop id -> minute of the lap the bus stands there with its doors open).
  class Line {
    constructor(id, name, corners, route, lap, every, stops, doors) {
      Object.assign(this, { id, name, corners, route, lap, every, stops, doors });
      Object.freeze(this);
    }
  }

  const _sign = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

  // The closed loop through the corners, one tile at a time, each corner once, starting at the first.
  function _route(corners) {
    const tiles = [];
    corners.forEach(([x0, y0], i) => {
      const [x1, y1] = corners[(i + 1) % corners.length];
      const dx = _sign(x1 - x0), dy = _sign(y1 - y0);
      let x = x0, y = y0;
      while (!(x === x1 && y === y1)) {
        tiles.push([x, y]);
        x += dx;
        y += dy;
      }
    });
    return tiles;
  }

  // The route index at each minute of one lap: up to SPEED tiles a minute, stopping on a stop tile (then DWELL
  // more minutes there) or on the depot corner, which ends the lap.
  function _lap(route) {
    const out = [0];
    let i = 0;
    for (;;) {
      for (let s = 0; s < SPEED; s++) {
        i = (i + 1) % route.length;
        if (STOP_AT.has(key(route[i])) || i === 0) break;
      }
      out.push(i);
      if (STOP_AT.has(key(route[i]))) for (let d = 0; d < DWELL; d++) out.push(i);
      if (i === 0) return out.slice(0, -1);
    }
  }

  function _line(line_id, name, corners) {
    const route = _route(corners);
    const lap = _lap(route);
    const doors = {};
    for (let m = 1; m < lap.length; m++) {
      if (lap[m] === lap[m - 1] && STOP_AT.has(key(route[lap[m]]))) doors[STOP_AT.get(key(route[lap[m]]))] = m;
    }
    const stops = route.filter(t => STOP_AT.has(key(t))).map(t => STOP_AT.get(key(t)));
    return new Line(line_id, name, corners, route, lap, Math.floor(lap.length / BUSES_PER_LINE), stops, doors);
  }

  // Line id -> Line, in timetable order.
  const LINES = new Map([
    ["1", _line("1", "No. 1 (clockwise: Main Street east, Park Avenue west)", [[3, 25], [68, 25], [68, 14], [3, 14]])],
    ["2", _line("2", "No. 2 (anticlockwise: Park Avenue east, Main Street west)", [[3, 25], [3, 14], [68, 14], [68, 25]])],
  ]);

  // What one ride costs a passenger of this age.
  const fare = age => (18 <= age && age < 65 ? BUS_FARE : 0);

  // `town.stops`: [{id, name, x, y, lines}] in STOPS order.
  function stops_json() {
    return STOPS.map(([sid, name, [x, y]]) => ({
      id: sid, name, x, y, lines: Array.from(LINES.values()).filter(ln => ln.stops.includes(sid)).map(ln => ln.id),
    }));
  }

  // `town.timetable` (and the controllers' `query world` timetable), the PLAN section 3.2 shape.
  function timetable_json() {
    const pad = n => String(n).padStart(2, "0");
    return {
      bus: {
        lines: Array.from(LINES.values(), ln => ({
          id: ln.id, name: ln.name, corners: ln.corners.map(c => c.slice()), stops: ln.stops.slice(),
          lap_minutes: ln.lap.length, buses: BUSES_PER_LINE, every_minutes: ln.every, speed: SPEED, dwell: DWELL,
          fare: BUS_FARE,
        })),
      },
      flights: FLIGHTS.map(d => `${pad(Math.floor(d / 60))}:${pad(d % 60)} Riverton to Lakeside`),
    };
  }

  // The buses of a line split its lap evenly, so the set of bus positions repeats every `every` minutes.
  for (const ln of LINES.values()) {
    if (ln.lap.length !== ln.every * BUSES_PER_LINE) throw new Error(`line ${ln.id}: the lap must split evenly`);
  }

  // Bus ids in timetable order: 1a-1d, then 2a-2d.
  const BUS_IDS = [];
  for (const line_id of LINES.keys()) for (let k = 0; k < BUSES_PER_LINE; k++) BUS_IDS.push(line_id + BUS_LETTERS[k]);
  const _HEADING = { "1,0": "e", "-1,0": "w", "0,1": "s", "0,-1": "n" };

  // The minutes of the lap the bus stands on the stop tile, doors open: the minute it arrives and DWELL more.
  function _stand(line, stop) {
    const at = key(STOP_XY[stop]);
    const out = [];
    line.lap.forEach((i, m) => { if (key(line.route[i]) === at) out.push(m); });
    return out;
  }

  // For a rider reaching the stop at a tick t, by t % every: (the tick the caught bus first stood on the stop)
  // - t. It is -1 when the rider steps on in the bus's last minute there, and at most every - len(stand).
  function _offsets(line, stand) {
    const first = stand[0];
    const out = [];
    for (let r = 0; r < line.every; r++) {
      out.push(Math.min(...stand.map(s => pyMod(s - r, line.every) - (s - first))));
    }
    return out;
  }

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  // Derived timetable data, built once at load like LINES: line id -> stop id -> ...
  const _FIRST = {}, _OFFSET = {};
  for (const ln of LINES.values()) {
    _FIRST[ln.id] = {};
    _OFFSET[ln.id] = {};
    for (const sid of ln.stops) {
      _FIRST[ln.id][sid] = _stand(ln, sid)[0]; // arrival lap minute
      _OFFSET[ln.id][sid] = _offsets(ln, _stand(ln, sid));
    }
  }
  const PERIOD = Array.from(LINES.values()).reduce((p, ln) => p / gcd(p, ln.every) * ln.every, 1); // the bus timetable repeats every PERIOD minutes

  // Minutes on board from the bus's arrival at `board` to its arrival at `alight` (one less for a rider who
  // steps on in the bus's second minute at the stop).
  function ride_minutes(line, board, alight) {
    const ln = LINES.get(line);
    return pyMod(_FIRST[line][alight] - _FIRST[line][board], ln.lap.length);
  }

  function _bus(bus_id) {
    const line = LINES.get(bus_id.slice(0, -1));
    return [line, BUS_LETTERS.indexOf(bus_id[bus_id.length - 1])];
  }

  const _lap_minute = (line, k, tick) => pyMod(tick + k * line.every, line.lap.length);

  // The tile a bus is on at `tick` (where its riders are too).
  function bus_xy(bus_id, tick) {
    const [line, k] = _bus(bus_id);
    return line.route[line.lap[_lap_minute(line, k, tick)]];
  }

  // The id of the bus of `line` standing at `stop` with its doors open at `tick`, or null.
  function bus_at_stop(line, stop, tick) {
    const ln = LINES.get(line), at = key(STOP_XY[stop]);
    for (let k = 0; k < BUSES_PER_LINE; k++) {
      if (key(ln.route[ln.lap[_lap_minute(ln, k, tick)]]) === at) return ln.id + BUS_LETTERS[k];
    }
    return null;
  }

  // The `state.buses` rows at a tick: [{id, line, x, y, dir, at_stop, riders}] in BUS_IDS order.
  //
  // Positions are a pure function of the tick. `dir` is the heading to the bus's next route tile, `at_stop`
  // the stop it stands at (or null) and `riders` the number of `agents` (any iterable, such as
  // `sim.agents.values()`) whose `riding` is that bus; 0 for every bus when no agents are given.
  function bus_rows(tick, agents = []) {
    const riders = {};
    for (const agent of agents) if (agent.riding) riders[agent.riding] = (riders[agent.riding] || 0) + 1;
    const rows = [];
    for (const line of LINES.values()) {
      for (let k = 0; k < BUSES_PER_LINE; k++) {
        const i = line.lap[_lap_minute(line, k, tick)];
        const [x, y] = line.route[i];
        const [nx, ny] = line.route[(i + 1) % line.route.length];
        const bus_id = line.id + BUS_LETTERS[k];
        rows.push({ id: bus_id, line: line.id, x, y, dir: _HEADING[`${nx - x},${ny - y}`],
          at_stop: STOP_AT.get(key([x, y])) ?? null, riders: riders[bus_id] || 0 });
      }
    }
    return rows;
  }

  // True when a bus of `line` stands at `stop` with its doors open at `tick` (both minutes it stands there).
  const doors_open = (line, stop, tick) => bus_at_stop(line, stop, tick) !== null;

  // For each board stop of the line: [fewest minutes from the bus's arrival there to walking in at the place,
  // the alight stop that gives it], cached on the town. Ties go to the stop the bus reaches first.
  function _after(town, line, place_id) {
    const mkey = `transit_after|${line.id}|${place_id}`;
    let got = town.memo.get(mkey);
    if (got === undefined) {
      const walk_from = {};
      for (const sid of line.stops) walk_from[sid] = town.walk_minutes(STOP_XY[sid], place_id);
      got = {};
      for (const a of line.stops) {
        let best = UNREACHABLE, best_b = null;
        const at = line.stops.indexOf(a);
        for (const b of line.stops.slice(at + 1).concat(line.stops.slice(0, at))) {
          if (walk_from[b] < UNREACHABLE && ride_minutes(line.id, a, b) + walk_from[b] < best) {
            best = ride_minutes(line.id, a, b) + walk_from[b];
            best_b = b;
          }
        }
        got[a] = [best, best_b];
      }
      town.memo.set(mkey, got);
    }
    return got;
  }

  // The fastest single-bus trip from a tile to a place leaving at `tick`: [minutes door to door, line, board
  // stop, alight stop], or null when no bus beats walking by MIN_SAVING minutes or more.
  //
  // Door to door is the walk to the board stop, the wait, the ride and the walk from the alight stop, exactly as
  // the rider makes it. Ties go to line 1, then to the board stop the line reaches first from its depot corner.
  // With `worst` the tick does not matter: it is the trip of the departure minute whose best trip is slowest
  // (the earliest such minute), cached on the town, so whenever the rider leaves the best bus takes at most that.
  function best_trip(town, at, place_id, tick, worst = false) {
    at = [at[0], at[1]];
    const mkey = `transit_worst|${at[0]},${at[1]}|${place_id}`;
    if (worst && town.memo.has(mkey)) return town.memo.get(mkey);
    const walk = town.walk_minutes(at, place_id);
    let best = null;
    if (walk < UNREACHABLE) {
      const to_stop = {};
      for (const [sid, stop_xy] of Object.entries(STOP_XY)) to_stop[sid] = town.steps(at, stop_xy);
      const legs = []; // [walk to the board stop, the rest after the bus arrives there, line, board, alight]
      for (const line of LINES.values()) {
        const after = _after(town, line, place_id);
        for (const a of line.stops) {
          const [rest, b] = after[a];
          if (to_stop[a] < UNREACHABLE && b !== null) legs.push([to_stop[a], rest, line, a, b]);
        }
      }
      const ticks = worst ? Array.from({ length: PERIOD }, (_, t) => t) : [tick];
      for (const t of ticks) {
        let fastest = null;
        for (const [walk_a, rest, line, a, b] of legs) {
          const minutes = walk_a + _OFFSET[line.id][a][pyMod(t + walk_a, line.every)] + rest;
          if (fastest === null || minutes < fastest[0]) fastest = [minutes, line.id, a, b];
        }
        if (fastest !== null && (best === null || fastest[0] > best[0])) best = fastest;
      }
    }
    if (best !== null && best[0] > walk - MIN_SAVING) best = null;
    if (worst) town.memo.set(mkey, best);
    return best;
  }

  G.transit = {
    BUS_FARE, SPEED, DWELL, BUSES_PER_LINE, BUS_LETTERS, MIN_SAVING, UNREACHABLE, FLIGHTS, STOPS, STOP_XY,
    STOP_AT, Line, LINES, fare, stops_json, timetable_json, BUS_IDS, PERIOD, ride_minutes, bus_xy, bus_at_stop,
    bus_rows, doors_open, best_trip,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
