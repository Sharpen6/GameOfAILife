// CityView dev driver: a scripted stand-in for the server's state frames on the fixture town. Every
// person gets a day plan (commute, lunch, school, errands, evenings out) walked or driven along shortest
// paths; 8 buses run the No. 1 and No. 2 loop timetable; lots and homes carry conditions, listings, works
// and moving vans. state(tick) is a pure function of the tick, like the real bus timetable.
// Classic script for client/dev/view.html only.
"use strict";
(function () {
  const F = window.CityViewFixture;
  const hash = s => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  window.CityViewFake = function (opt) {
    opt = opt || {};
    const town = F.town, W = town.w, H = town.h, tiles = town.tiles;
    const place = new Map(town.places.map(p => [p.id, p]));
    const homePlace = new Map(town.homes.map(h => [h.id, h.place]));
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : tiles[y][x];

    // --- shortest paths on the tile grid (walkers prefer pavements; cars keep to the road) ---------------
    function cost(c, car) {
      if (c === null || c === "B" || c === "D" || c === "~") return 0;
      if (car) return c === "#" ? 1 : 40;
      return c === "#" || c === "e" ? 2 : c === "P" ? 3 : c === "T" ? 6 : 3;
    }
    const cache = new Map();
    function path(a, b, car) {
      const key = a + "|" + b + "|" + (car ? 1 : 0);
      if (cache.has(key)) return cache.get(key);
      const pa = place.get(a), pb = place.get(b);
      const [sx, sy] = pa.entry, [tx, ty] = pb.entry;
      const N = W * H, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
      const heap = [];
      const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
      const s = sy * W + sx, t = ty * W + tx;
      dist[s] = 0; push(0, s);
      while (heap.length) {
        const [d, i] = pop();
        if (d > dist[i]) continue;
        if (i === t) break;
        const x = i % W, y = (i / W) | 0;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const c = at(nx, ny), k = ny * W + nx;
          let w = cost(c, car);
          if (!w && k === t) w = 1;
          if (!w) continue;
          if (d + w < dist[k]) { dist[k] = d + w; prev[k] = i; push(d + w, k); }
        }
      }
      const out = [];
      for (let i = t; i >= 0; i = prev[i]) { out.push([i % W, (i / W) | 0]); if (i === s) break; }
      out.reverse();
      cache.set(key, out);
      return out;
    }

    // --- day plans ----------------------------------------------------------------------------------
    const ERRANDS = ["cafe", "diner", "noodles", "square", "maple_park", "green", "bakery", "market", "park", "arcade", "grocer"];
    const OUTINGS = ["park", "maple_park", "square", "green"];
    const near = (from, list, k) => {
      const p = place.get(from);
      const d = list.map(id => { const q = place.get(id); return [Math.abs(q.entry[0] - p.entry[0]) + Math.abs(q.entry[1] - p.entry[1]), id]; }).sort((a, b) => a[0] - b[0]);
      return d[Math.min(d.length - 1, k % Math.min(3, d.length))][1];
    };
    const plans = new Map();
    for (const c of F.cast) {
      const h = hash(c.id), home = homePlace.get(c.home) || c.home, j = n => (hash(c.id + n) % 1000) / 1000;
      const steps = [];
      const job = c.job, kid = c.age < 18 && job === "school", old = !job;
      const travel = (a, b) => path(a, b, false).length;
      if (c.id === "david") {
        steps.push({ dep: 630, to: "hospital", until: 760, veh: "ambulance" }, { dep: 760, to: home, until: 950, veh: "taxi" });
        steps.push({ dep: 960, to: "square", until: 1030 });
      } else if (kid) {
        steps.push({ dep: 480 - travel(home, "school") - 4 - Math.round(j("k") * 10), to: "school", until: (c.hours ? c.hours[1] : 14) * 60 + Math.round(j("o") * 8), veh: h % 5 === 0 ? "run" : "walk" });
        if (h % 4 !== 0) steps.push({ dep: 0, to: near("school", OUTINGS, h >>> 3), until: 990 + Math.round(j("p") * 75) });
        if (h % 2 === 0) steps.push({ dep: 1060 + Math.round(j("e") * 50), to: near(home, ["maple_park", "park", "green", "square"], h >>> 5), until: 1170 + Math.round(j("g") * 20) });
      } else if (c.id === "ruth") {
        steps.push({ dep: 560 + Math.round(j("a") * 50), to: "maple_park", until: 690 }, { dep: 690, to: home, until: 1072 });
        steps.push({ dep: 1072, to: "noodles", until: 1150, veh: "taxi" }, { dep: 1150, to: home, until: 1500, veh: "taxi" });
      } else if (old) {
        steps.push({ dep: 560 + Math.round(j("a") * 50), to: near(home, OUTINGS, h >>> 2), until: 660 + Math.round(j("b") * 30) });
        steps.push({ dep: 0, to: near(home, ["market", "bakery", "grocer", "cafe", "diner"], h >>> 4), until: 740 + Math.round(j("c") * 30) });
        steps.push({ dep: 900 + Math.round(j("d") * 60), to: near(home, ["cafe", "diner", "square", "maple_park", "green"], h >>> 6), until: 1010 + Math.round(j("f") * 60) });
        steps.push({ dep: 1050 + Math.round(j("q") * 50), to: near(home, ["grocer", "noodles", "bakery", "green", "maple_park", "square"], h >>> 9), until: 1130 + Math.round(j("r") * 40) });
      } else {
        const [a, b] = c.hours;
        const drive = c.car && path(home, job, true).length > 10;
        const len = drive ? Math.ceil(path(home, job, true).length / 3) : travel(home, job);
        const leave = a * 60 - len - 3 - Math.round(j("w") * 12), end = b * 60 + Math.round(j("x") * 10);
        if (h % 2 === 0 && a < 12 && b > 14) {
          const l0 = 720 + Math.round(j("l") * 25), l1 = l0 + 35 + Math.round(j("m") * 15);
          steps.push({ dep: leave, to: job, until: l0, veh: drive ? "car" : "walk" },
            { dep: l0, to: near(job, ["cafe", "square", "diner", "bakery"], h >>> 3), until: l1 }, { dep: l1, to: job, until: end });
        } else steps.push({ dep: leave, to: job, until: end, veh: drive ? "car" : "walk" });
        if (h % 4 !== 0 && b <= 18) {
          const e0 = Math.max(end + 25, 1020) + Math.round(j("v") * 80);
          steps.push({ dep: end, to: home, until: e0 }, { dep: e0, to: near(home, ERRANDS, h >>> 7), until: e0 + 50 + Math.round(j("u") * 50) });
        }
      }
      if (c.id === "ari") steps.push({ dep: 1190, to: "cafe", until: 1296 }, { dep: 1296, to: home, until: 1500, veh: "taxi" }); // a late taxi home
      // neighbours chatting outside the flats in the late afternoon (fills the pavements, exercises crowd rings)
      if (place.get(home).style === "apartments" && !kid && h % 3 !== 0) {
        const t0 = 1010 + Math.round(j("h") * 35), hang = { dep: t0, to: home, until: t0 + 30 + Math.round(j("i") * 25), hang: true };
        const k = steps.findIndex(s => s.dep > t0);
        if (k < 0) steps.push(hang); else steps.splice(k, 0, hang);
      }
      // walk the plan into a timeline of trips and stays; a car driven somewhere is driven home from there
      const segs = [];
      let cur = home, free = 0, carAt = home;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.hang && cur === home) {
          const t0 = Math.max(s.dep, free);
          if (s.until > t0) { segs.push({ kind: "out", t0, t1: s.until, place: home }); free = s.until; }
          continue;
        }
        if (s.to === cur) { free = Math.max(free, s.until); continue; }
        const veh = s.veh || (s.to === home && carAt === cur && cur !== home ? "car" : "walk");
        const car = veh === "car" || veh === "taxi" || veh === "ambulance";
        const pth = path(cur, s.to, car);
        const sp = car ? 3 : veh === "run" ? 2 : 1;
        const dep = Math.max(s.dep, free);
        const dur = Math.max(1, Math.ceil((pth.length - 1) / sp));
        segs.push({ kind: "trip", t0: dep, t1: dep + dur, path: pth, sp, veh, to: s.to, from: cur });
        segs.push({ kind: "in", t0: dep + dur, t1: Math.max(dep + dur, s.until), place: s.to });
        cur = s.to; free = Math.max(dep + dur, s.until);
        if (veh === "car") carAt = s.to;
      }
      if (cur !== home) {
        const car = carAt !== home && carAt === cur;
        const pth = path(cur, home, car), sp = car ? 3 : 1, dur = Math.max(1, Math.ceil((pth.length - 1) / sp));
        segs.push({ kind: "trip", t0: free, t1: free + dur, path: pth, sp, veh: car ? "car" : "walk", to: home, from: cur });
      }
      // a stay lasts until the next departure
      for (let i = 0; i + 1 < segs.length; i++) if (segs[i].kind !== "trip") segs[i].t1 = Math.max(segs[i].t1, segs[i + 1].t0);
      plans.set(c.id, { c, home, segs });
    }

    // --- buses ----------------------------------------------------------------------------------------
    function loopTiles(corners) {
      const out = [];
      for (let k = 0; k < corners.length; k++) {
        const [x0, y0] = corners[k], [x1, y1] = corners[(k + 1) % corners.length];
        const n = Math.abs(x1 - x0) + Math.abs(y1 - y0), dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
        for (let i = 0; i < n; i++) out.push([x0 + dx * i, y0 + dy * i]);
      }
      return out;
    }
    const stopAt = new Map(town.stops.map(s => [s.x + "," + s.y, s.id]));
    const lines = town.timetable.bus.lines.map(L => {
      const route = loopTiles(L.corners), lap = [];
      let i = 0, guard = 0;
      do {
        let moved = 0;
        for (; moved < L.speed; moved++) { i = (i + 1) % route.length; if (i === 0 || stopAt.has(route[i].join(","))) { moved++; break; } }
        const sid = stopAt.get(route[i].join(","));
        lap.push({ i, open: sid || null });
        if (sid) lap.push({ i, open: null });
      } while (i !== 0 && ++guard < 400);
      return { L, route, lap };
    });
    function buses(tick) {
      const out = [];
      for (const { L, route, lap } of lines) {
        for (let k = 0; k < L.buses; k++) {
          const e = lap[(tick + k * L.every_minutes) % lap.length];
          const [x, y] = route[e.i], [nx, ny] = route[(e.i + 1) % route.length];
          const dir = nx > x ? "e" : nx < x ? "w" : ny > y ? "s" : "n";
          const id = L.id + "abcd"[k];
          out.push({ id, line: L.id, x, y, dir, at_stop: e.open, riders: hash(id + ":" + Math.floor(tick / 26)) % 7 });
        }
      }
      return out;
    }

    // --- lots and homes -------------------------------------------------------------------------------
    const conditions = Object.assign({}, F.conditions);
    if (opt.conditions !== "plan") Object.assign(conditions, { main_13: 92, main_21: 70, main_29: 50, main_39: 30, main_47: 10, elm_court: 45 });
    const works = new Set(opt.conditions === "plan" ? [] : ["park_29"]);
    const moving = new Set(opt.conditions === "plan" ? [] : ["park_21", "cedar_court"]);
    function lots() {
      const out = {};
      for (const p of town.places) if (p.kind === "home") out[p.id] = { condition: conditions[p.id] != null ? conditions[p.id] : 80, works: works.has(p.id), moving: moving.has(p.id) };
      return out;
    }
    function homes() {
      const out = {};
      for (const h of town.homes) {
        const s = F.homes[h.id];
        const price = s.listing === "for_sale" ? h.base_value : s.listing === "for_rent" ? h.rent || 200 : null;
        out[h.id] = { hh: s.hh, owner: s.owner, listing: s.listing, price, value: h.base_value, emergency: null };
      }
      return out;
    }

    // --- one frame --------------------------------------------------------------------------------------
    function agentAt(pl, m, tick) {
      const c = pl.c, hp = place.get(pl.home);
      let seg = null;
      for (const s of pl.segs) if (m >= s.t0 && m < s.t1) { seg = s; break; }
      const a = { id: c.id, name: c.name, x: hp.entry[0], y: hp.entry[1], inside: pl.home, state: "busy", activity: m < 390 || m > 1350 ? "sleep" : "relax_home",
        vehicle: "walk", mood: 40 + hash(c.id + "m") % 55, luck: 50, controller: c.id === "dana" ? "llm" : null, alive: true, age: c.age,
        home: c.home, car: !!c.car, riding: null };
      if (seg && seg.kind === "trip") {
        const i = Math.min(seg.path.length - 1, Math.floor((m - seg.t0) * seg.sp + (seg.sp > 1 ? seg.sp - 1 : 0)));
        [a.x, a.y] = seg.path[Math.max(0, i)];
        a.inside = null; a.state = "travelling"; a.vehicle = seg.veh; a.activity = seg.to === pl.home ? "go_home" : "go_" + seg.to;
        const k = hash(c.id) + Math.floor(tick / 12);
        if (k % 13 === 0) a.state = "deciding";
        else if (k % 17 === 0 && seg.veh === "walk") a.activity = "phone_call";
      } else if (seg && seg.kind === "out") {
        const p = place.get(seg.place);
        [a.x, a.y] = p.entry; a.inside = null; a.state = "idle"; a.activity = "chat";
      } else if (seg && seg.kind === "in") {
        const p = place.get(seg.place);
        [a.x, a.y] = p.entry; a.inside = p.kind === "park" ? null : p.id;
        a.activity = p.id === c.job ? (c.job === "school" ? "school" : "work") : "errand";
        if (p.kind === "park") { a.state = "idle"; a.activity = "stroll"; }
      }
      return a;
    }
    function state(tick) {
      const m = ((tick % 1440) + 1440) % 1440, day = Math.floor(tick / 1440);
      const hh = String(Math.floor(m / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0");
      const p = tick % 8;
      const agents = [];
      for (const pl of plans.values()) agents.push(agentAt(pl, m, tick));
      let plane = null;
      for (const dep of [480, 840, 1200]) if (m >= dep && m < dep + 24) plane = { progress: Math.round((m - dep) / 24 * 1000) / 1000, from: "Riverton", to: "Lakeside" };
      const st = {
        tick, time: `Day ${day + 1} ${DAYS[day % 7]} ${hh}:${mm}`, minute: m, day, season: opt.season || "summer", weather: opt.weather || "clear",
        lights: { ns: p < 3 ? "green" : p === 3 ? "yellow" : "red", ew: p >= 4 && p < 7 ? "green" : p === 7 ? "yellow" : "red" },
        plane, buses: buses(tick), agents,
      };
      if (opt.housing !== false) { st.lots = lots(); st.homes = homes(); }
      return st;
    }
    return { state, plans, path, town };
  };

  // Specimen street (?specimen=1): five houses of one type and one palette side by side, facing the camera,
  // at neglect stages 0 to 4, with their lots, a street, lamps and a little traffic. The ids were picked so
  // that every palette choice (paint, roof, trim, shutters, door, curtains) hashes the same.
  window.CityViewFake.specimen = function (opt) {
    opt = opt || {};
    const ids = ["row_298", "row_2920", "row_20630", "row_23576", "row_33173"];
    const W = 26, H = 20, Y = 9, rows = [];
    for (let y = 0; y < H; y++) {
      let r = "";
      for (let x = 0; x < W; x++) r += y === Y + 4 ? "#" : (y <= Y - 3 || y >= Y + 6) && hash(`s${x},${y}`) % 4 === 0 ? "T" : ".";
      rows.push(r.split(""));
    }
    const places = ids.map((id, k) => {
      const x = 2 + 4 * k;
      for (let y = Y; y < Y + 3; y++) for (let i = 0; i < 3; i++) rows[y][x + i] = y === Y + 2 && i === 1 ? "D" : "B";
      rows[Y + 3][x + 1] = "e";
      return { id, name: `${2 + 4 * k} Specimen Row`, kind: "home", x, y: Y, w: 3, h: 3, entry: [x + 1, Y + 3], face: "s", hours: null,
        district: "maple_grove", style: "house", floors: 1, tier: "house", units: 1 };
    });
    const town = { w: W, h: H, tiles: rows.map(r => r.join("")), places,
      homes: ids.map(id => ({ id, place: id, unit: null, name: places.find(p => p.id === id).name, tier: "house", bedrooms: 3, base_value: 16000, rent: 400 })),
      districts: [{ id: "maple_grove", name: "Maple Grove", rects: [[0, 0, W, H]] }], streets: [{ name: "Specimen Row", axis: "row", at: Y + 4 }],
      road_rows: [Y + 4], road_cols: [], junctions: [], stops: [], timetable: { bus: { lines: [] }, flights: [] } };
    const cond = [92, 70, 50, 30, 10];
    function state(tick) {
      const m = ((tick % 1440) + 1440) % 1440;
      const lots = {}, homes = {};
      ids.forEach((id, k) => {
        lots[id] = { condition: cond[k], works: false, moving: false };
        homes[id] = { hh: k < 3 ? "family" + k : null, owner: k === 4 ? "market" : "landlord", listing: k === 4 ? "for_sale" : k === 3 ? "for_rent" : null, price: null, value: 16000, emergency: null };
      });
      const walk = (id, name, age, x, y, extra) => Object.assign({ id, name, x, y, inside: null, state: "travelling", activity: "errand", vehicle: "walk",
        mood: 60, luck: 50, controller: null, alive: true, age, home: ids[0], car: false, riding: null }, extra || {});
      const agents = [
        walk("pat", "Pat Row", 34, (5 + tick) % W, Y + 4),
        walk("kim", "Kim Row", 9, (18 - tick % W + W) % W, Y + 4),
        walk("lou", "Lou Row", 71, 7, Y + 3, { state: "idle", activity: "chat" }),
        walk("sam", "Sam Row", 40, 7, Y + 3, { state: "idle", activity: "chat" }),
        walk("dee", "Dee Row", 45, (2 + 3 * tick) % W, Y + 4, { vehicle: "car", car: true, home: ids[1] }),
        walk("ray", "Ray Row", 52, 3, Y + 3, { inside: ids[0], state: "busy", activity: "relax_home", car: true }),
      ];
      return { tick, time: "Specimen Row", minute: m, day: 0, season: opt.season || "summer", weather: opt.weather || "clear",
        lights: { ns: "green", ew: "red" }, plane: null, buses: [], agents, lots, homes };
    }
    return { town, state };
  };
})();
