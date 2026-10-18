// Region stub host: a scripted stand-in for the v3 server on client/dev/region_data.js (window.REGION, the
// welcome.town of region.md 8). It sends what the region world's frames carry for the view (PLAN 2.10, 2.11;
// view.md 4.2): `crowd` (about 1,000 townsfolk, some 600 of them out on the streets at 08:00, walking on the
// kerbs, cycling and driving in the lanes, a few waiting at stations and a few standing together),
// `occ` (folk inside each place, in town.places order), `folk_n`, `trains` (both lines, from region.md 7's rail
// cycle, derived from each line's track corners exactly as scratch-region/rail.py does), `talks` (named first,
// then folk-only talks indoors, one per place, then outdoors; newest first, at most 20) and social events with
// `place` and `agents`. Everything is a pure function of the tick: no random draws, no clock.
//
//   const stub = RegionStub(window.REGION, {named, folk, season, weather, speed})
//                                 named: agent rows to carry (default CITY_FIXTURE's 60 when that file is
//                                 loaded, else none, and talks and events then name 8 of v2's cast ids)
//   stub.town                     welcome.town (region data plus the v2 keys the view reads)
//   stub.welcome(tick)            {type: "welcome", role: "god", town, state, speed}
//   stub.state(tick)              a full state (occ included)
//   stub.events(tick)             the events of that tick (social tags with place and agents)
//   stub.frame(tick)              {type: "state", speed, state, events, forks: []}: occ only when 10+ ticks have
//                                 passed since the last one sent (or every 40th frame), as the host sends it
//   stub.railCycle(lineId)        the line's cycle: [[track, i, station | null, doorsOpen], ...]
//   stub.trackTiles(lineId, trk)  the track's tiles [[x, y], ...]
//   stub.folkAt(i, tick)          {x, y, k} | null: where townsperson i is (null when indoors)
// Classic script for the dev pages and the browser smokes only.
"use strict";
(function () {
  const STREET = "#bx";
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // integer hash of two ints (any 32-bit mix will do; the view has its own CV.hash2)
  function h2(a, b) {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  }
  // share of the townsfolk outdoors by minute of the day (peaks at 08:00 and 17:30)
  const OUT = [[0, 0.03], [300, 0.02], [390, 0.15], [450, 0.52], [480, 0.62], [540, 0.36], [600, 0.2], [720, 0.3],
    [810, 0.2], [960, 0.26], [1050, 0.55], [1110, 0.4], [1200, 0.2], [1320, 0.08], [1440, 0.03]];
  function outShare(m) {
    for (let k = 1; k < OUT.length; k++) if (m <= OUT[k][0]) { const [a, fa] = OUT[k - 1], [b, fb] = OUT[k]; return fa + (fb - fa) * (m - a) / (b - a); }
    return OUT[0][1];
  }
  // A track's tiles from its corners (inclusive, unit steps), as scratch-region gen.track_tiles.
  function trackTiles(corners) {
    const out = [[corners[0][0], corners[0][1]]];
    for (let k = 1; k < corners.length; k++) {
      let [x, y] = out[out.length - 1];
      const [tx, ty] = corners[k], sx = Math.sign(tx - x), sy = Math.sign(ty - y);
      while (x !== tx || y !== ty) { x += sx; y += sy; out.push([x, y]); }
    }
    return out;
  }
  // region.md 7's cycle: out from the first stop, `speed` tiles a minute at most, `dwell` minutes at each stop,
  // `layover` at the end, back on `in`, `layover`, padded to trains x every. Entries [track, i, station, open].
  function buildCycle(ln) {
    const seq = [], order = ln.stations.map(s => s.id), stopOf = (trk, sid) => ln.stations.find(s => s.id === sid).i[trk];
    const run = (trk, ids) => {
      const stops = new Map(ids.map(s => [stopOf(trk, s), s]));
      let i = stopOf(trk, ids[0]);
      const last = stopOf(trk, ids[ids.length - 1]);
      seq.push([trk, i, ids[0], true]);
      while (i < last) {
        for (let n = 0; n < ln.speed; n++) { i++; if (stops.has(i) || i === last) break; }
        const here = stops.has(i) ? stops.get(i) : null;
        seq.push([trk, i, here, here !== null]);
        if (here !== null && i !== last) for (let d = 0; d < ln.dwell; d++) seq.push([trk, i, here, true]);
      }
    };
    run("out", order);
    for (let d = 0; d < ln.layover; d++) seq.push(seq[seq.length - 1]);
    run("in", order.slice().reverse());
    for (let d = 0; d < ln.layover; d++) seq.push(seq[seq.length - 1]);
    const cycle = (ln.trains.length || ln.trains) * ln.every;
    while (seq.length < cycle) seq.push(seq[seq.length - 1]);
    return seq;
  }

  window.RegionStub = function (region, opt) {
    region = region || window.REGION;
    opt = opt || {};
    const W = region.w, H = region.h, tiles = region.tiles, places = region.places;
    const N = W * H, FOLK = opt.folk != null ? opt.folk : 1000;
    const code = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? "" : tiles[y][x];
    const street = (x, y) => STREET.includes(code(x, y)) && code(x, y) !== "";
    const town = Object.assign({ streets: [], stops: [], timetable: { bus: { lines: [] }, flights: [] } }, region);
    if (!town.timetable.train && region.rail) {
      town.timetable = Object.assign({}, town.timetable, { train: { lines: region.rail.lines.map(l => ({ id: l.id, stations: l.stations.map(s => s.id), trains: l.trains.length, every_minutes: l.every })) } });
    }

    // --- streets: every STREET tile, and walks along them -------------------------------------------------
    const streets = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (street(x, y)) streets.push(y * W + x);
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const LEN = 160;
    const paths = new Int32Array(FOLK * LEN);
    for (let i = 0; i < FOLK; i++) {
      let t = streets[h2(i, 1) % streets.length], d = h2(i, 2) % 4;
      for (let s = 0; s < LEN; s++) {
        paths[i * LEN + s] = t;
        const x = t % W, y = (t / W) | 0, ok = [];
        for (let k = 0; k < 4; k++) if (street(x + DX[k], y + DY[k])) ok.push(k);
        let nd = -1;
        if (ok.length >= 3) { // a junction: straight on, left or right by hash
          const pick = ok.filter(k => k !== (d + 2) % 4);
          nd = pick[h2(i * 977 + s, 3) % pick.length];
        } else if (ok.includes(d)) nd = d;
        else nd = ok.find(k => k !== (d + 2) % 4);
        if (nd == null || nd < 0) nd = ok.length ? ok[0] : d; // a dead end: turn back
        if (!ok.length) continue;
        d = nd; t = (y + DY[d]) * W + (x + DX[d]);
      }
    }
    // modes (view.md 4.2): 0 walk, 1 run, 2 car, 3 bike, 4 taxi, 5 ambulance, 6 waiting, 7 other outdoors
    const mode = new Uint8Array(FOLK), child = new Uint8Array(FOLK), rank = new Uint16Array(FOLK);
    for (let i = 0; i < FOLK; i++) {
      const r = h2(i, 4) % 100;
      mode[i] = r < 22 ? 2 : r < 27 ? 3 : r < 29 ? 1 : r < 30 ? 4 : r < 34 ? 6 : r < 38 ? 7 : 0;
      child[i] = mode[i] === 0 && h2(i, 5) % 100 < 18 ? 1 : 0;
      rank[i] = h2(i, 6) % 1000;
    }
    if (FOLK > 999) mode[999] = 5;
    const SPEED = [1, 2, 4, 2, 4, 5, 0, 0];
    // waiting folk stand at a station exit; standing folk stand in pairs (i, i + 1) on a kerb or in a park
    const exits = [];
    for (const l of (region.rail && region.rail.lines) || []) for (const s of l.stations) for (const e of s.exits || []) exits.push(e);
    const parks = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (code(x, y) === "P") parks.push([x, y]);
    function spot(i) {
      if (mode[i] === 6 && exits.length) return exits[h2(i, 7) % exits.length];
      const j = i - (i % 2), pool = parks.length && h2(j, 8) % 2 ? parks : null;
      if (pool) return pool[h2(j, 9) % pool.length];
      const t = streets[h2(j, 10) % streets.length];
      return [t % W, (t / W) | 0];
    }
    const minuteOf = tick => ((tick % 1440) + 1440) % 1440;
    const isOut = (i, tick) => rank[i] < outShare(minuteOf(tick)) * 1000;
    function folkAt(i, tick) {
      if (i < 0 || i >= FOLK || !isOut(i, tick)) return null;
      const m = mode[i], k = m | (child[i] << 3);
      if (m === 6 || m === 7) { const [x, y] = spot(i); return { x, y, k }; }
      const L = LEN - 1, ph = ((tick * SPEED[m] + h2(i, 11) % (2 * L)) % (2 * L) + 2 * L) % (2 * L), s = ph <= L ? ph : 2 * L - ph;
      const t = paths[i * LEN + s];
      return { x: t % W, y: (t / W) | 0, k };
    }
    function crowd(tick) {
      const out = [];
      for (let i = 0; i < FOLK; i++) { const f = folkAt(i, tick); if (f) out.push(i, f.x, f.y, f.k); }
      return out;
    }
    // --- occ: folk inside each place (workplaces by day, homes otherwise) -----------------------------------
    const homesIdx = [], workIdx = [];
    places.forEach((p, k) => { if (p.kind === "home") homesIdx.push(k); else if (p.kind !== "park" && p.kind !== "station") workIdx.push(k); });
    function occ(tick) {
      const o = new Array(places.length).fill(0), m = minuteOf(tick), day = m >= 540 && m < 1020;
      for (let i = 0; i < FOLK; i++) {
        if (isOut(i, tick)) continue;
        const atWork = day && h2(i, 12) % 100 < 72 && workIdx.length;
        const list = atWork ? workIdx : homesIdx.length ? homesIdx : workIdx;
        if (list.length) o[list[h2(i, atWork ? 13 : 14) % list.length]]++;
      }
      return o;
    }
    // --- trains -------------------------------------------------------------------------------------------
    const lines = ((region.rail && region.rail.lines) || []).map(l => {
      const tr = {};
      for (const k of Object.keys(l.tracks)) tr[k] = trackTiles(l.tracks[k]);
      return { l, tracks: tr, cycle: buildCycle(l), ids: Array.isArray(l.trains) ? l.trains : Array.from({ length: l.trains }, (_, k) => l.id + (k + 1)) };
    });
    const DIRS = { "1,0": "e", "-1,0": "w", "0,1": "s", "0,-1": "n" };
    function trains(tick) {
      const rows = [], m = minuteOf(tick), peak = (m >= 420 && m < 570) || (m >= 990 && m < 1140);
      for (const L of lines) {
        L.ids.forEach((id, k) => {
          const c = L.cycle[(((tick + k * L.l.every) % L.cycle.length) + L.cycle.length) % L.cycle.length];
          const t = L.tracks[c[0]], i = c[1], [x, y] = t[i];
          const nx = i + 1 < t.length ? t[i + 1] : [2 * x - t[i - 1][0], 2 * y - t[i - 1][1]];
          rows.push({ id, line: L.l.id, track: c[0], i, x, y, dir: DIRS[(nx[0] - x) + "," + (nx[1] - y)], at_station: c[3] ? c[2] : null,
            riders: m < 330 ? 0 : h2(k * 31 + L.l.id.charCodeAt(0), Math.floor(tick / 10)) % (peak ? 18 : 7) });
        });
      }
      return rows;
    }
    // --- named characters (static rows, optional) ---------------------------------------------------------
    const fx = window.CITY_FIXTURE;
    const named = (opt.named || (fx && fx.state && fx.state.agents) || []).map(a => Object.assign({}, a));
    // with no rows, talks and events still name a few of v2's cast ids (people the view has no row for)
    const namedIds = named.length ? named.filter(a => a.alive !== false).map(a => a.id) : opt.named ? [] : ["dana", "tom", "ari", "noa", "miriam", "eli", "shira", "gil"];
    const millPlaces = [];
    places.forEach((p, k) => { if (p.x < 80 && p.y < 50 && p.kind !== "home") millPlaces.push(k); });
    // --- talks and social events ----------------------------------------------------------------------------
    // The talks begun at tick s: one folk-only talk indoors, one between two standing folk outdoors when a pair
    // is out, and every third minute a talk with a named character (when there are any).
    function talksAt(s) {
      const rows = { named: [], inside: [], outside: [] };
      const pi = workIdx.length ? workIdx[h2(s, 21) % workIdx.length] : -1;
      if (pi >= 0) rows.inside.push([pi, "f" + (h2(s, 22) % FOLK), "f" + (h2(s, 23) % FOLK), (h2(s, 24) % 3) - 1, s]);
      for (let n = 0; n < 6; n++) {
        let i = h2(s * 7 + n, 25) % FOLK; i -= i % 2;
        if (mode[i] === 7 && mode[i + 1] === 7 && isOut(i, s) && isOut(i + 1, s)) { rows.outside.push([-1, "f" + i, "f" + (i + 1), h2(s, 26) % 2, s]); break; }
      }
      if (namedIds.length && h2(s, 27) % 3 === 0) {
        const a = namedIds[h2(s, 28) % namedIds.length], other = h2(s, 29) % 2 ? namedIds[h2(s, 30) % namedIds.length] : "f" + (h2(s, 31) % FOLK);
        if (other !== a) rows.named.push([millPlaces.length ? millPlaces[h2(s, 32) % millPlaces.length] : -1, a, other, (h2(s, 33) % 3) - 1, s]);
      }
      return rows;
    }
    function talks(tick) {
      const named = [], inside = [], outside = [], seen = new Set();
      for (let s = tick; s > tick - 10; s--) {
        const r = talksAt(s);
        named.push(...r.named);
        for (const row of r.inside) if (!seen.has(row[0])) { seen.add(row[0]); inside.push(row); }
        outside.push(...r.outside);
      }
      return named.concat(inside, outside).slice(0, 20);
    }
    const TAGS = [["talk", "social", 0], ["flirt", "social", 0], ["new_friend", "social", 2], ["falling_out", "social", 2], ["rival", "social", 1],
      ["row", "social", 1], ["partner", "social", 2], ["engaged", "family", 2], ["wedding", "family", 2], ["birth", "family", 2], ["party", "social", 1], ["breakup", "social", 2]];
    const stamp = tick => { const m = minuteOf(tick), d = Math.floor(tick / 1440); return `Day ${d + 1} ${DAYS[d % 7]} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
    function events(tick) {
      const out = [];
      const add = (k, tag, kind, imp, agents, placeIdx, at) => {
        const p = placeIdx >= 0 ? places[placeIdx] : null;
        out.push({ seq: tick * 8 + k + 1, tick, time: stamp(tick), kind, tag, importance: imp, major: imp >= 2,
          text: `${agents.join(" and ")}: ${tag.replace(/_/g, " ")}${p ? " at " + p.name : ""}.`, agent: agents[0], agents: agents.slice(),
          place: p ? p.id : null, at: at || (p ? p.entry : null) });
      };
      // every named talk that begins now is a `talk` event (folk-only talks are memory only, PLAN 2.8)
      const r = talksAt(tick);
      r.named.forEach((row, k) => add(k, h2(tick, 34) % 5 ? "talk" : "flirt", "social", 0, [row[1], row[2]], row[0], null));
      // now and then a bigger social moment, at a Millbrook place or on a street between two standing folk
      if (h2(tick, 35) % 20 === 0) {
        const [tag, kind, imp] = TAGS[2 + h2(tick, 36) % (TAGS.length - 2)];
        const a = namedIds.length ? namedIds[h2(tick, 37) % namedIds.length] : "f" + (h2(tick, 38) % FOLK);
        const b = "f" + (h2(tick, 39) % FOLK);
        const pk = millPlaces.length ? millPlaces[h2(tick, 40) % millPlaces.length] : workIdx.length ? workIdx[0] : -1;
        add(4, tag, kind, imp, [a, b], pk, null);
      }
      return out;
    }

    function state(tick) {
      const m = minuteOf(tick), d = Math.floor(tick / 1440);
      return {
        tick, time: stamp(tick), minute: m, day: d, season: opt.season || "summer", weather: opt.weather || "clear",
        lights: { ns: Math.floor(tick / 2) % 2 ? "red" : "green", ew: Math.floor(tick / 2) % 2 ? "green" : "red" }, plane: null, buses: [],
        agents: named.map(a => Object.assign({}, a)),
        crowd: crowd(tick), occ: occ(tick), folk_n: FOLK, trains: trains(tick), talks: talks(tick),
      };
    }
    let frames = 0, occTick = null, occFrame = 0;
    function frame(tick) {
      const st = state(tick);
      frames++;
      if (occTick !== null && tick - occTick < 10 && frames - occFrame < 40) delete st.occ;
      else { occTick = tick; occFrame = frames; }
      return { type: "state", speed: opt.speed || 1, state: st, events: events(tick), forks: [] };
    }
    function welcome(tick) {
      const st = state(tick);
      occTick = tick; occFrame = frames;
      return { type: "welcome", role: "god", speed: opt.speed || 1, town, state: st };
    }
    return {
      town, welcome, state, events, frame, folkAt, crowd, occ, trains, talks, folk_n: FOLK,
      railCycle: id => { const L = lines.find(q => q.l.id === id); return L ? L.cycle.map(c => c.slice()) : null; },
      trackTiles: (id, trk) => { const L = lines.find(q => q.l.id === id); return L && L.tracks[trk] ? L.tracks[trk].map(t => t.slice()) : null; },
    };
  };
  window.RegionStub.trackTiles = trackTiles;
  window.RegionStub.buildCycle = buildCycle;
})();
