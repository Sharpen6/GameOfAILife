// Port of gameofailife/rail.py: the railway (region.md 7): two double-track lines run as a pure function of the
// tick, exact boarding, and the townsfolk's trip planner over the road graph.
//
// Each line has two tracks, "out" and "in", buffer to buffer, given as tile corners in town.rail.lines. A train
// starts at the first station's stop index on "out" with its doors open, moves up to `speed` tiles a minute
// (stopping early on a stop index), stands `dwell` more minutes with its doors open at each stop, lays over
// `layover` minutes at the far terminus, switches to "in" at the same station, runs back and lays over again; the
// cycle is padded at the home terminus to `trains x every` minutes. Train k of a line is at
// cycle[(tick + k * every) % cycle_minutes], so nothing here keeps state, and nothing draws dice.
//
// Boarding is exact: a rider on the platform at tick T boards the first train on their track with its doors open
// at that station at T or later (ties by train index) and alights on the first minute after boarding that the
// train stands with its doors open at their station. Trips and worst cases as in rail.py.
(function (G) {
  "use strict";

  const WALK = 0, DRIVE = 1, WAIT = 2, RIDE = 3; // leg kinds, as folk_model's
  const PLATFORM_MINUTES = 1, TRANSFER_MINUTES = 2, PARK_RIDE_MAX = 12;
  const FARE = 3; // dollars a journey for ages 18 to 64; the transfer is free
  const TOP = 3; // stations kept for access and egress
  const CACHE_CAP = 200000; // entries in each planner cache before it is cleared (pure caches)
  const HEADING = { "1,0": "e", "-1,0": "w", "0,1": "s", "0,-1": "n" };
  const pmod = (a, b) => ((a % b) + b) % b;
  const sk = (track, station) => `${track}|${station}`;

  // Every tile of a track from its corners, in driving order.
  function track_tiles(corners) {
    const out = [[corners[0][0], corners[0][1]]];
    for (let i = 0; i < corners.length - 1; i++) {
      const x0 = corners[i][0], y0 = corners[i][1], x1 = corners[i + 1][0], y1 = corners[i + 1][1];
      const dx = (x1 > x0) - (x1 < x0), dy = (y1 > y0) - (y1 < y0);
      let x = x0, y = y0;
      while (x !== x1 || y !== y1) {
        x += dx;
        y += dy;
        out.push([x, y]);
      }
    }
    return out;
  }

  // One line, from town.rail.lines[i] (see rail.py's Line). `stop`, `doors`, `first`, `board` are keyed
  // "track|station".
  class Line {
    constructor(data) {
      this.data = data;
      this.id = data.id;
      this.name = data.name;
      this.train_ids = Array.from(data.trains);
      this.trains = this.train_ids.length;
      this.every = data.every;
      this.cars = data.cars;
      this.speed = data.speed;
      this.dwell = data.dwell;
      this.layover = data.layover;
      this.capacity = data.capacity;
      this.fare = data.fare;
      this.corners = {};
      this.tracks = {};
      for (const [k, v] of Object.entries(data.tracks)) {
        this.corners[k] = v.map(p => [p[0], p[1]]);
        this.tracks[k] = track_tiles(v);
      }
      this.stations = data.stations.map(s => s.id);
      this.names = {};
      this.exits = {};
      this.stop = new Map(); // "track|station" -> stop index on that track
      for (const s of data.stations) {
        this.names[s.id] = s.name;
        this.exits[s.id] = s.exits.map(e => [e[0], e[1]]);
        this.stop.set(sk("out", s.id), s.i.out);
        this.stop.set(sk("in", s.id), s.i.in);
      }
      this.cycle = this._build();
      this.cycle_minutes = this.cycle.length;
      const C = this.cycle_minutes;
      this.doors = new Map(); // "track|station" -> cycle minutes with the doors open there
      for (let m = 0; m < C; m++) {
        const [track, , at, open] = this.cycle[m];
        if (open) {
          const key = sk(track, at);
          if (!this.doors.has(key)) this.doors.set(key, []);
          this.doors.get(key).push(m);
        }
      }
      this.first = new Map(); // "track|station" -> per cycle minute, minutes until the doors are next open
      for (const [key, ms] of this.doors) {
        const first = new Array(C).fill(0);
        const is_open = new Array(C).fill(false);
        for (const m of ms) is_open[m] = true;
        let d = null;
        for (let j = 2 * C - 1; j >= 0; j--) {
          if (is_open[j % C]) d = 0;
          else if (d !== null) d += 1;
          if (j < C) first[j] = d;
        }
        this.first.set(key, first);
      }
      this.board = new Map(); // "track|station" -> per tick % cycle_minutes, [train index, wait]
      for (const [key, first] of this.first) {
        const row = [];
        for (let c = 0; c < C; c++) {
          let best = null;
          for (let k = 0; k < this.trains; k++) {
            const w = first[(c + k * this.every) % C];
            if (best === null || w < best[1]) best = [k, w];
          }
          row.push(best);
        }
        this.board.set(key, row);
      }
      this.run = {}; // track -> minutes from the departure at the first station to the doors opening at each
      for (const [track, order] of [["out", this.stations], ["in", this.stations.slice().reverse()]]) {
        const dep = this._arrival(track, order[0], 0);
        this.run[track] = order.map(s => (s === order[0] ? 0 : pmod(this._arrival(track, s, dep) - dep, C)));
      }
      this._rows = [];
      for (let c = 0; c < C; c++) this._rows.push(this._row(c)); // [track, i, x, y, dir, at_station]
      this._worst = new Map(); // "track|a|b" -> the worst wait + ride over the cycle
    }

    _build() {
      const seq = [];
      const run = (track, order) => {
        const stops = new Map();
        for (const s of order) stops.set(this.stop.get(sk(track, s)), s);
        let i = this.stop.get(sk(track, order[0]));
        const last = this.stop.get(sk(track, order[order.length - 1]));
        seq.push([track, i, order[0], true]);
        while (i < last) {
          for (let n = 0; n < this.speed; n++) {
            i += 1;
            if (stops.has(i) || i === last) break;
          }
          const here = stops.has(i) ? stops.get(i) : null;
          seq.push([track, i, here, here !== null]);
          if (here !== null && i !== last) for (let n = 0; n < this.dwell; n++) seq.push([track, i, here, true]);
        }
      };
      const repeat = n => { const last = seq[seq.length - 1]; for (let j = 0; j < n; j++) seq.push(last); };
      run("out", this.stations);
      repeat(this.layover);
      run("in", this.stations.slice().reverse());
      repeat(this.layover);
      const cycle = this.trains * this.every;
      if (seq.length > cycle) {
        throw new Error(`line ${this.id}: a round trip of ${seq.length} minutes does not fit ${cycle}`);
      }
      repeat(cycle - seq.length);
      return seq;
    }

    _arrival(track, station, after) {
      const C = this.cycle_minutes;
      const ms = this.doors.get(sk(track, station));
      const set = new Set(ms);
      for (let d = 0; d < C; d++) {
        const m = (after + d) % C;
        if (set.has(m) && (!set.has(pmod(m - 1, C)) || ms.length === 1)) return m;
      }
      return ms[0];
    }

    _row(c) {
      const [track, i, at, open] = this.cycle[c];
      const t = this.tracks[track];
      const [x, y] = t[i];
      let nx, ny;
      if (i + 1 < t.length) [nx, ny] = t[i + 1];
      else [nx, ny] = [2 * x - t[i - 1][0], 2 * y - t[i - 1][1]];
      return [track, i, x, y, HEADING[`${nx - x},${ny - y}`], open ? at : null];
    }

    // [track, tile index, station or null, doors open] of train k at the tick.
    state(k, tick) {
      return this.cycle[pmod(tick + k * this.every, this.cycle_minutes)];
    }

    track_for(a, b) {
      return this.stations.indexOf(a) < this.stations.indexOf(b) ? "out" : "in";
    }

    // Minutes after boarding train k at `tick` until it next stands with its doors open at station b.
    ride(track, b, k, tick) {
      return this.first.get(sk(track, b))[pmod(tick + k * this.every + 1, this.cycle_minutes)] + 1;
    }

    worst(track, a, b) {
      const key = `${track}|${a}|${b}`;
      let got = this._worst.get(key);
      if (got === undefined) {
        got = 0;
        const table = this.board.get(sk(track, a));
        for (let t = 0; t < this.cycle_minutes; t++) {
          const [k, w] = table[t];
          const m = w + this.ride(track, b, k, t + w);
          if (m > got) got = m;
        }
        this._worst.set(key, got);
      }
      return got;
    }

    json() {
      const tracks = {}, track_tiles_n = {};
      for (const [k, v] of Object.entries(this.corners)) tracks[k] = v.map(p => [p[0], p[1]]);
      for (const [k, v] of Object.entries(this.tracks)) track_tiles_n[k] = v.length;
      return {
        id: this.id, name: this.name, cars: this.cars, tracks, track_tiles: track_tiles_n,
        trains: this.train_ids.slice(), every: this.every, speed: this.speed, dwell: this.dwell,
        layover: this.layover, capacity: this.capacity, fare: this.fare,
        stations: this.data.stations.map(s => ({
          id: s.id, name: s.name, i: { out: s.i.out, in: s.i.in }, platforms: s.platforms.map(r => Array.from(r)),
          exits: s.exits.map(e => Array.from(e)),
        })),
      };
    }
  }

  // The lines of one map and what is derived from them alone.
  class Rail {
    constructor(rail) {
      this.lines = new Map();
      for (const data of (rail && rail.lines) || []) {
        const ln = new Line(data);
        this.lines.set(ln.id, ln);
      }
      this.train = new Map(); // train id -> [line, k]
      this.order = []; // every station once, in line order then station order
      for (const ln of this.lines.values()) {
        ln.train_ids.forEach((tid, k) => this.train.set(tid, [ln, k]));
        for (const s of ln.stations) if (!this.order.includes(s)) this.order.push(s);
      }
      this.rank = new Map(this.order.map((s, n) => [s, n]));
      this.exits = new Map();
      for (const ln of this.lines.values()) for (const s of ln.stations) if (!this.exits.has(s)) this.exits.set(s, ln.exits[s]);
      this.serving = new Map(this.order.map(s => [s, Array.from(this.lines.values()).filter(ln => ln.stations.includes(s))]));
      this.hubs = this.order.filter(s => this.serving.get(s).length > 1); // where riders change lines
    }
  }

  function _rail(town) {
    let got = town.memo.get("rail_net");
    if (got === undefined) {
      got = new Rail(town.rail || null);
      town.memo.set("rail_net", got);
    }
    return got;
  }

  // Map of line id -> Line, empty in millbrook; kept in town.memo "rail".
  function lines(town) {
    let got = town.memo.get("rail");
    if (got === undefined) {
      got = _rail(town).lines;
      town.memo.set("rail", got);
    }
    return got;
  }

  const fare = age => (18 <= age && age <= 64 ? FARE : 0);

  // [train id, wait] of the first train on `track` with its doors open at `station` at `tick` or later.
  function boarding(town, line_id, track, station, tick) {
    const ln = lines(town).get(line_id);
    const [k, w] = ln.board.get(sk(track, station))[pmod(tick, ln.cycle_minutes)];
    return [ln.train_ids[k], w];
  }

  function ride_minutes(town, line_id, track, a, b) {
    const ln = lines(town).get(line_id);
    const order = track === "out" ? ln.stations : ln.stations.slice().reverse();
    return ln.run[track][order.indexOf(b)] - ln.run[track][order.indexOf(a)];
  }

  function train_xy(town, train_id, tick) {
    const [ln, k] = _rail(town).train.get(train_id);
    const row = ln._rows[pmod(tick + k * ln.every, ln.cycle_minutes)];
    return [row[2], row[3]];
  }

  // state.trains: one row a train, lines in order (region.md 8). Cars are drawn at i-1..i-3.
  function train_rows(town, tick, riders = null) {
    const rows = [];
    const got = riders || {};
    for (const ln of lines(town).values()) {
      const C = ln.cycle_minutes, every = ln.every, rs = ln._rows;
      ln.train_ids.forEach((tid, k) => {
        const [track, i, x, y, d, at] = rs[pmod(tick + k * every, C)];
        const n = got instanceof Map ? got.get(tid) : got[tid];
        rows.push({ id: tid, line: ln.id, track, i, x, y, dir: d, at_station: at, riders: n === undefined ? 0 : n });
      });
    }
    return rows;
  }

  function timetable_json(town) {
    const r = _rail(town);
    if (!r.lines.size) return null;
    const transfer = {};
    for (const s of r.hubs) transfer[s] = TRANSFER_MINUTES;
    return {
      lines: Array.from(r.lines.values(), ln => ({
        id: ln.id, name: ln.name, stations: ln.stations.slice(), trains: ln.trains, every_minutes: ln.every,
        cycle_minutes: ln.cycle_minutes, fare: ln.fare, capacity: ln.capacity,
        minutes: { out: ln.run.out.slice(), in: ln.run.in.slice() },
      })),
      transfer,
    };
  }

  function rail_json(town) {
    const r = _rail(town);
    if (!r.lines.size) return null;
    return { lines: Array.from(r.lines.values(), ln => ln.json()) };
  }

  // --- trips --------------------------------------------------------------------------------------------------
  // {minutes, board, alight, legs}: legs [kind, t0, t1, data]: WALK/DRIVE Route, WAIT station id, RIDE train id.
  function TrainTrip(minutes, board, alight, legs) {
    return Object.freeze({ minutes, board, alight, legs });
  }

  function _store(cache, key, value) {
    if (cache.size >= CACHE_CAP) cache.clear();
    cache.set(key, value);
    return value;
  }

  function _memo(net, name) {
    let got = net.memo.get(name);
    if (got === undefined) {
      got = new Map();
      net.memo.set(name, got);
    }
    return got;
  }

  const byMinutesRank = (p, q) => p[0] - q[0] || p[1] - q[1];

  // The TOP best stations from end a: [[minutes, rank, station, via, mode], ...] (see rail.py's _access).
  function _access(r, net, a, car) {
    const cache = _memo(net, "rail_access");
    const key = `${G.roads.endKey(a)}|${car ? 1 : 0}`;
    const got = cache.get(key);
    if (got !== undefined) return got;
    const best = [];
    for (const s of r.order) {
      const exits = r.exits.get(s);
      let top = [net.minutes(a, s, "walk"), s, "walk"];
      for (const e of exits) {
        const m = net.minutes(a, e, "walk") + PLATFORM_MINUTES;
        if (m < top[0]) top = [m, e, "walk"];
      }
      if (car) {
        const m = net.minutes(a, s, "car");
        if (m <= PARK_RIDE_MAX && m < top[0]) top = [m, s, "car"];
        for (const e of exits) {
          const me = net.minutes(a, e, "car");
          if (me <= PARK_RIDE_MAX && me + PLATFORM_MINUTES < top[0]) top = [me + PLATFORM_MINUTES, e, "car"];
        }
      }
      best.push([top[0], r.rank.get(s), s, top[1], top[2]]);
    }
    best.sort(byMinutesRank);
    return _store(cache, key, best.slice(0, TOP));
  }

  function _egress(r, net, b) {
    const cache = _memo(net, "rail_egress");
    const key = G.roads.endKey(b);
    const got = cache.get(key);
    if (got !== undefined) return got;
    const best = [];
    for (const s of r.order) {
      let top = [net.minutes(s, b, "walk"), s];
      for (const e of r.exits.get(s)) {
        const m = PLATFORM_MINUTES + net.minutes(e, b, "walk");
        if (m < top[0]) top = [m, e];
      }
      best.push([top[0], r.rank.get(s), s, top[1], "walk"]);
    }
    best.sort(byMinutesRank);
    return _store(cache, key, best.slice(0, TOP));
  }

  // Ways from station s to station t: [[line, track, s, t]] on one line, or two rides changing at a hub.
  function _plans(r, s, t) {
    for (const ln of r.serving.get(s)) {
      if (ln.stations.includes(t)) return [[[ln, ln.track_for(s, t), s, t]]];
    }
    const out = [];
    for (const x of r.hubs) {
      for (const l1 of r.serving.get(s)) {
        if (!l1.stations.includes(x)) continue;
        for (const l2 of r.serving.get(t)) {
          if (l2 === l1 || !l2.stations.includes(x)) continue;
          out.push([[l1, l1.track_for(s, x), s, x], [l2, l2.track_for(x, t), x, t]]);
        }
      }
    }
    return out;
  }

  const keyLess = (p, q) => p[0] < q[0] || (p[0] === q[0] && (p[1] < q[1] || (p[1] === q[1] && p[2] < q[2])));

  // The fastest train trip from end a to end b leaving at `tick`, or null. Its legs are chained from `tick`.
  function trip_via_roads(town, net, a, b, tick, car = false) {
    const r = _rail(town);
    if (!r.lines.size) return null;
    const acc = _access(r, net, a, car);
    const egr = _egress(r, net, b);
    let best = null;
    for (const [am, arank, s, avia, amode] of acc) {
      for (const [em, erank, t, evia] of egr) {
        if (s === t) continue;
        for (const plan of _plans(r, s, t)) {
          let now = tick + am;
          const rides = [];
          plan.forEach(([ln, track, x, y], n) => {
            if (n) now += TRANSFER_MINUTES;
            const [k, w] = ln.board.get(sk(track, x))[pmod(now, ln.cycle_minutes)];
            const t0 = now + w;
            now = t0 + ln.ride(track, y, k, t0);
            rides.push([t0, now, ln.train_ids[k], x]);
          });
          const key = [now + em - tick, arank, erank];
          if (best === null || keyLess(key, best[0])) best = [key, [am, s, avia, amode], [em, t, evia], rides];
        }
      }
    }
    if (best === null) return null;
    const [[minutes], [, s, avia, amode], [, t, evia], rides] = best;
    const legs = [];
    let route = net.route(a, avia, amode, false);
    legs.push([amode === "car" ? DRIVE : WALK, tick, tick + route.minutes, route]);
    let now = tick + route.minutes;
    for (const [t0, t1, tid, x] of rides) {
      legs.push([WAIT, now, t0, x]);
      legs.push([RIDE, t0, t1, tid]);
      now = t1;
    }
    if (typeof evia !== "string") {
      legs.push([WAIT, now, now + PLATFORM_MINUTES, t]);
      now += PLATFORM_MINUTES;
    }
    route = net.route(evia, b, "walk", false);
    legs.push([WALK, now, now + route.minutes, route]);
    return TrainTrip(minutes, s, t, legs);
  }

  // The longest door-to-door train trip from a to b over every departure tick, or null; memoized as an int.
  function worst_minutes(town, net, a, b, car = false) {
    const r = _rail(town);
    if (!r.lines.size) return null;
    const cache = _memo(net, "rail_worst");
    const key = `${G.roads.endKey(a)}|${G.roads.endKey(b)}|${car ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    let best = null;
    for (const [am, , s] of _access(r, net, a, car)) {
      for (const [em, , t] of _egress(r, net, b)) {
        if (s === t) continue;
        for (const plan of _plans(r, s, t)) {
          let m = am + em + TRANSFER_MINUTES * (plan.length - 1);
          for (const [ln, track, x, y] of plan) m += ln.worst(track, x, y);
          if (best === null || m < best) best = m;
        }
      }
    }
    return _store(cache, key, best);
  }

  G.rail = {
    WALK, DRIVE, WAIT, RIDE, PLATFORM_MINUTES, TRANSFER_MINUTES, PARK_RIDE_MAX, FARE, TOP, CACHE_CAP, track_tiles,
    Line, lines, fare, boarding, ride_minutes, train_xy, train_rows, timetable_json, rail_json, TrainTrip,
    trip_via_roads, worst_minutes,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
