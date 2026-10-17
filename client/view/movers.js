// CityView movers: takes state frames, keeps one track per agent and bus, and each frame turns them into
// sorted draw items. Positions ease from the last shown point to the new tile along an L, over the measured
// real time between ticks. Of the two L orders the one whose inner tiles the mover may use wins (road for
// vehicles and buses, open ground for people), else the previous travel axis first, so cars turn at
// corners. Cars keep to the right-hand lane and buses to a wider one, a bus crossing another bus's road
// waits short of it, walkers keep to the pavement (a household's members one behind another), and idle
// people on one tile stand in a small ring.
// Also the housing look adapter (state.lots / state.homes -> per-place looks) and occupancy counts.
// Classic script on window.CityView.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const { hash } = CV.color;
  const CAR_COLORS = ["#c0392b", "#2c6fbb", "#e4e4e0", "#2a2a30", "#3f8f4a", "#8a4fa0", "#d9822b", "#7a8a9a", "#6a1f2a", "#2fa3b5"];
  const DIR_OF = { e: 0, s: 1, w: 2, n: 3 };
  const VEHICLES = { car: 1, taxi: 1, ambulance: 1 };
  const LANE = 0.17, KERB = 0.4, RING = 0.22, SNAP = 12;
  const BUS_GAP = (1.45 + 0.62) / 2 + 0.1; // bus and car half lengths plus a little air, in tiles
  // Buses keep 0.23 tiles right of the centre line, so two passing each other (0.42 wide) never touch.
  const BUS_LANE = 0.23, BUS_HL = 1.45 / 2, BUS_HW = 0.42 / 2, BUS_AIR = 0.18;
  // A walker's place along the pavement, by rank in their household: 0, ahead, behind, further ahead...
  const STAGGER = [0, 1, -1, 2, -2, 3, -3], STEP = 0.18;
  const WALKABLE = ".#Pe";

  // Does the L from tile (x0, y0) to tile (x1, y1), x leg first or y leg first, pass only over tiles that
  // ok(x, y) allows? The two end tiles are left out: a car leaves from and arrives at a driveway.
  function lClear(x0, y0, x1, y1, xFirst, ok) {
    const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
    let x = x0, y = y0;
    for (const ax of xFirst ? "xy" : "yx") {
      if (ax === "x") { while (x !== x1) { x += sx; if ((x !== x1 || y !== y1) && !ok(x, y)) return false; } }
      else { while (y !== y1) { y += sy; if ((x !== x1 || y !== y1) && !ok(x, y)) return false; } }
    }
    return true;
  }
  CV.carColor = id => CAR_COLORS[hash(id + ":car") % CAR_COLORS.length];

  // state.lots and state.homes -> {placeId: {stage, works, moving, listing, vacant, anyListed, units}}.
  CV.looksFrom = function (town, lots, homes) {
    const looks = {};
    const byPlace = new Map();
    for (const h of town.homes || []) { if (!byPlace.has(h.place)) byPlace.set(h.place, []); byPlace.get(h.place).push(h); }
    for (const p of town.places || []) {
      if (p.kind !== "home") continue;
      const lot = lots && lots[p.id];
      const L = { stage: 0, works: false, moving: false, listing: null, vacant: false, anyListed: false, units: [] };
      if (lot) {
        L.stage = lot.stage != null ? Math.max(0, Math.min(4, lot.stage | 0)) : lot.condition != null ? CV.stageOf(lot.condition) : 0;
        L.condition = lot.condition; L.works = !!lot.works; L.moving = !!lot.moving;
      }
      const hs = byPlace.get(p.id) || [];
      if ((p.units || 1) > 1 || hs.length > 1) {
        L.units = hs.map(h => { const s = homes && homes[h.id]; return { id: h.id, unit: h.unit, vacant: s ? !s.hh : false, listing: s && s.listing || null }; });
        L.anyListed = L.units.some(u => u.listing);
        L.vacant = L.units.length > 0 && L.units.every(u => u.vacant);
      } else {
        const s = homes && homes[p.id];
        L.vacant = s ? !s.hh : false; L.listing = s && s.listing || null;
      }
      looks[p.id] = L;
    }
    return looks;
  };

  CV.makeMovers = function (scene) {
    const town = scene.town;
    const homeToPlace = new Map((town.homes || []).map(h => [h.id, h.place]));
    const placeOf = id => id == null ? null : scene.placeById.has(id) ? id : homeToPlace.get(id) || null;
    const tracks = new Map();
    const M = { placeOf, tickMs: 417, lots: null, homes: null, state: null };
    let lastTick = null, tickAt = 0, recs = new Map(), rankKey = "", ranks = new Map();
    const tile = (x, y) => (x < 0 || y < 0 || x >= town.w || y >= town.h) ? null : town.tiles[y][x];
    // where a vehicle may cut a corner (roads, which run off the map) and where a person may (open ground)
    const roadOk = (x, y) => { const c = tile(x, y); return c === null || c === "#"; };
    const walkOk = (x, y) => { const c = tile(x, y); return c === null || WALKABLE.includes(c); };

    // Where a track is shown now, in tile units, with the step direction it is moving in.
    function shown(tr, now) { return at(tr, Math.min(1, Math.max(0, (now - tr.t0) / tr.dur))); }
    // The same at a share t (0..1) of the current move.
    function at(tr, t) {
      const [px, py] = tr.prev, [cx, cy] = tr.cur;
      const dx = cx - px, dy = cy - py, total = Math.abs(dx) + Math.abs(dy);
      if (!total) return { x: cx, y: cy, sx: 0, sy: 0, t: 1, moving: false };
      const s = t * total;
      let x, y, sx = 0, sy = 0;
      if (tr.first === "x") {
        if (s <= Math.abs(dx)) { x = px + Math.sign(dx) * s; y = py; sx = Math.sign(dx); }
        else { x = cx; y = py + Math.sign(dy) * (s - Math.abs(dx)); sy = Math.sign(dy); }
      } else {
        if (s <= Math.abs(dy)) { x = px; y = py + Math.sign(dy) * s; sy = Math.sign(dy); }
        else { x = px + Math.sign(dx) * (s - Math.abs(dy)); y = cy; sx = Math.sign(dx); }
      }
      return { x, y, sx, sy, t, moving: t < 1 };
    }
    // A new tile for a track. ok(x, y): the tiles this mover may cut a corner over. A diagonal move takes the
    // L whose inner tiles all pass ok (a car leaving its driveway turns onto the road first instead of
    // sliding along the lawn, a walker in a park steps round a tree); when both or neither do, it keeps
    // going along the axis travelled last, so cars turn at corners.
    function track(key, x, y, now, fresh, ok) {
      let tr = tracks.get(key);
      if (!tr) { tr = { prev: [x, y], cur: [x, y], t0: now, dur: M.tickMs, first: "x", axis: null, face: 0, d: 0 }; tracks.set(key, tr); return tr; }
      if (!fresh) return tr;
      // a bus held short of a crossing starts its next move from where it was last drawn
      const s = tr.hold != null ? at(tr, tr.hold) : shown(tr, now);
      tr.hold = null;
      if (tr.cur[0] === x && tr.cur[1] === y) { tr.prev = [s.x, s.y]; tr.cur = [x, y]; tr.t0 = now; return tr; }
      const dx = x - s.x, dy = y - s.y;
      tr.prev = Math.abs(dx) + Math.abs(dy) > SNAP ? [x, y] : [s.x, s.y];
      tr.cur = [x, y]; tr.t0 = now; tr.dur = M.tickMs;
      if (dx && dy) {
        let first = null;
        if (ok) {
          const x0 = Math.round(tr.prev[0]), y0 = Math.round(tr.prev[1]);
          const xs = lClear(x0, y0, x, y, true, ok), ys = lClear(x0, y0, x, y, false, ok);
          if (xs !== ys) first = xs ? "x" : "y";
        }
        tr.first = first || tr.axis || (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
      } else tr.first = dx ? "x" : "y";
      return tr;
    }
    // Lane, kerb and jitter offsets inside a tile. Walkers on a road keep to the pavement on their side
    // and, along it, to their place in the household (stagger), so a family walks one behind another.
    const isRoad = (x, y) => scene.isRoad(x, y);
    function offset(kind, id, x, y, d, vehicle, lane) {
      x = Math.round(x); y = Math.round(y);
      if (vehicle) { const L = lane || LANE; const o = [[0, L], [-L, 0], [0, -L], [L, 0]][d] || [0, 0]; return o; }
      if (isRoad(x, y)) {
        const ew = isRoad(x - 1, y) || isRoad(x + 1, y), ns = isRoad(x, y - 1) || isRoad(x, y + 1);
        const side = hash(id) % 2 ? 1 : -1, side2 = hash(id + "k") % 2 ? 1 : -1;
        if (ew && ns) return [side2 * KERB, side * KERB];
        const al = stagger(id);
        if (ns) return [side * KERB, al];
        return [al, side * KERB];
      }
      const h = hash(id + ":j");
      return [((h % 7) - 3) * 0.04, (((h >>> 8) % 7) - 3) * 0.04];
    }
    // A walker's place along the pavement: fixed per person (so moves stay smooth), and different for each
    // member of a household (rank by id), who walk the same tiles together.
    function stagger(id) { const k = ranks.get(id); return k == null ? 0 : STAGGER[k % STAGGER.length] * STEP; }

    // A state frame: retarget tracks on a new tick, refresh looks when lots/homes came, count occupants.
    M.setState = function (st, speed, now) {
      now = now == null ? performance.now() : now;
      M.state = st;
      const fresh = lastTick === null || st.tick !== lastTick;
      if (fresh && lastTick !== null) {
        const gap = now - tickAt;
        if (gap > 5 && gap < 4000) M.tickMs = Math.max(30, Math.min(2000, M.tickMs * 0.7 + gap * 0.3));
      } else if (lastTick === null && speed) M.tickMs = Math.max(30, 417 / speed);
      if (fresh) { lastTick = st.tick; tickAt = now; }
      const seen = new Set();
      for (const a of st.agents || []) {
        seen.add(a.id);
        const tr = track(a.id, a.x, a.y, now, fresh, VEHICLES[a.vehicle] ? roadOk : walkOk);
        tr.agent = a;
      }
      // each person's rank in their household, by id, for the pavement stagger (redone when people move
      // house, arrive or die)
      const live = (st.agents || []).filter(a => a.alive !== false), rk = live.map(a => a.id + ":" + (a.home || "")).join(",");
      if (rk !== rankKey) {
        rankKey = rk; ranks = new Map();
        const by = new Map();
        for (const a of live) { const h = a.home || ""; if (!by.has(h)) by.set(h, []); by.get(h).push(a.id); }
        for (const ids of by.values()) ids.sort().forEach((id, k) => ranks.set(id, k));
      }
      const buses = busesOf(st);
      for (const b of buses) { const key = "bus:" + b.id; seen.add(key); const tr = track(key, b.x, b.y, now, fresh, roadOk); tr.bus = b; }
      for (const k of [...tracks.keys()]) if (!seen.has(k)) tracks.delete(k);
      let looksChanged = false;
      if (st.lots || st.homes) {
        if (st.lots) M.lots = st.lots;
        if (st.homes) M.homes = st.homes;
        looksChanged = scene.setLooks(CV.looksFrom(town, M.lots, M.homes));
      }
      const occ = {};
      for (const a of st.agents || []) if (a.alive !== false && a.inside && !a.riding) { const pid = placeOf(a.inside) || a.inside; occ[pid] = (occ[pid] || 0) + 1; }
      scene.occupancy = occ;
      return looksChanged;
    };
    let oldBus = null;
    function busesOf(st) {
      if (Array.isArray(st.buses)) return st.buses;
      if (st.bus && st.bus.x != null) { // today's single bus: line 1, facing by delta
        let dir = oldBus ? (st.bus.x > oldBus.x ? "e" : st.bus.x < oldBus.x ? "w" : st.bus.y > oldBus.y ? "s" : st.bus.y < oldBus.y ? "n" : oldBus.dir) : "e";
        oldBus = { x: st.bus.x, y: st.bus.y, dir };
        return [{ id: "bus", line: "1", x: st.bus.x, y: st.bus.y, dir, at_stop: st.bus.stopped ? "stop" : null, riders: 0 }];
      }
      return [];
    }

    // A bus at shown point s: its heading (the step it is taking, else its row's dir, else the last one) and
    // the centre of its body in its lane, in tile units.
    function busAt(tr, s) {
      const b = tr.bus;
      const d = s.sx > 0 ? 0 : s.sy > 0 ? 1 : s.sx < 0 ? 2 : s.sy < 0 ? 3 : DIR_OF[b.dir] != null ? DIR_OF[b.dir] : tr.d;
      const o = offset("bus", b.id, s.x, s.y, d, true, BUS_LANE);
      return { tr, s, d, x: s.x + 0.5 + o[0], y: s.y + 0.5 + o[1] };
    }
    // Do two bus bodies (plus a little air) overlap?
    const busExt = d => d % 2 === 0 ? [BUS_HL, BUS_HW] : [BUS_HW, BUS_HL];
    function busesMeet(a, b) {
      const ea = busExt(a.d), eb = busExt(b.d);
      return Math.abs(a.x - b.x) < ea[0] + eb[0] + BUS_AIR && Math.abs(a.y - b.y) < ea[1] + eb[1] + BUS_AIR;
    }
    const busOrder = (a, b) => String(a.tr.bus.line || "1").localeCompare(String(b.tr.bus.line || "1")) || String(a.tr.bus.id).localeCompare(String(b.tr.bus.id));
    // Hold bus B's move at the furthest point short of meeting bus P: its track's clock is set back, so the
    // next frames carry on from there. A bus standing still, or already in P's way where its move began,
    // is left as it is.
    function holdBus(B, P, now) {
      const tr = B.tr, t = B.s.t;
      if (!B.s.moving) return;
      const free = k => !busesMeet(busAt(tr, at(tr, k)), P);
      let k = 8;
      while (k >= 0 && !free(t * k / 8)) k--;
      if (k < 0 || k === 8) return;
      let lo = t * k / 8, hi = t * (k + 1) / 8;
      for (let n = 0; n < 10; n++) { const m = (lo + hi) / 2; if (free(m)) lo = m; else hi = m; }
      tr.t0 = now - lo * tr.dur; tr.hold = lo;
      Object.assign(B, busAt(tr, at(tr, lo)));
    }

    // Per frame: build the mover items into scene.movers (sorted by depth) and the lookup records.
    M.update = function (now) {
      const proj = scene.proj, art = scene.art;
      const items = [];
      recs = new Map();
      const st = M.state;
      if (!st) { scene.movers = items; return; }
      // idle people sharing a tile stand in a ring
      const idle = new Map();
      const pos = new Map();
      for (const [key, tr] of tracks) {
        const a = tr.agent;
        if (!a || a.alive === false || a.inside || a.riding) continue;
        const s = shown(tr, now);
        pos.set(key, s);
        if (!s.moving && !VEHICLES[a.vehicle]) { const k = tr.cur[0] + "," + tr.cur[1]; if (!idle.has(k)) idle.set(k, []); idle.get(k).push(key); }
      }
      const ring = new Map();
      for (const ids of idle.values()) if (ids.length >= 2) { ids.sort(); ids.forEach((id, k) => { const an = 2 * Math.PI * k / ids.length; ring.set(id, [Math.cos(an) * RING, Math.sin(an) * RING]); }); }
      // buses first, so riders can point at them
      const busRec = new Map(), busPos = [], bl = [];
      for (const [, tr] of tracks) if (tr.bus) { tr.hold = null; bl.push(busAt(tr, shown(tr, now))); }
      // Two buses crossing each other's road at a junction: the one further from the crossing (on a tie,
      // line 1, then the lower id, goes first) waits short of it until the other has cleared it. Its move is
      // held where it stands, so it never jumps, and it catches up over the next tick.
      for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) {
        const a = bl[i], b = bl[j];
        if (a.d % 2 === b.d % 2 || !busesMeet(a, b)) continue;
        const [X, Y] = a.d % 2 === 0 ? [a, b] : [b, a]; // X runs along x, Y along y; they cross at (Y.x, X.y)
        const uX = (Y.x - X.x) * (X.d === 0 ? 1 : -1), uY = (X.y - Y.y) * (Y.d === 1 ? 1 : -1);
        const first = Math.abs(uX - uY) > 0.2 ? (uX < uY ? X : Y) : busOrder(a, b) <= 0 ? a : b;
        holdBus(first === a ? b : a, first, now);
      }
      for (const B of bl) {
        const tr = B.tr, b = tr.bus, s = B.s;
        tr.d = B.d;
        if (s.sx) tr.axis = "x"; else if (s.sy) tr.axis = "y";
        const tx = B.x, ty = B.y;
        busPos.push({ d: tr.d, x: tx, y: ty });
        const spr = art.bus(b.line || "1", tr.d, !!b.at_stop && !s.moving, b.riders | 0);
        const p = proj.toWorld(tx, ty);
        const it = { img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0]) - spr.ax, wy: Math.round(p[1]) - spr.ay,
          depth: proj.depth(tx, ty) + 0.02, kind: "bus", id: b.id, hit: [spr.ax - 44, spr.ay - 40, spr.ax + 44, spr.ay + 14],
          lights: tr.d, moving: s.moving || !b.at_stop, cx: p[0], cy: p[1] };
        items.push(it);
        const r = { id: b.id, kind: "bus", name: `Bus ${b.id}`, item: it, foot: p };
        recs.set("bus:" + b.id, r); busRec.set(b.id, r);
      }
      const parked = new Set();
      for (const [key, tr] of tracks) {
        const a = tr.agent;
        if (!a || a.alive === false) continue;
        if (a.inside || a.riding) {
          const r = { id: a.id, kind: "person", name: a.name, item: null, foot: null, insideRec: null };
          if (a.riding && busRec.has(a.riding)) { const b = busRec.get(a.riding); r.item = b.item; r.foot = b.foot; r.riding = a.riding; }
          else if (a.inside) {
            const pid = placeOf(a.inside), rec = scene.buildingOf(pid);
            r.place = pid;
            if (rec) { r.insideRec = rec; r.foot = rec.center; } else { const p = proj.toWorld(a.x + 0.5, a.y + 0.5); r.foot = p; }
          }
          recs.set(a.id, r);
          continue;
        }
        const s = pos.get(key) || shown(tr, now);
        if (s.sx || s.sy) {
          tr.face = proj.facing(s.sx, s.sy);
          tr.d = s.sx > 0 ? 0 : s.sy > 0 ? 1 : s.sx < 0 ? 2 : 3;
          tr.axis = s.sx ? "x" : "y";
        }
        const veh = !!VEHICLES[a.vehicle];
        // lerp the in-tile offset between the two ends of the move
        const o0 = offset("p", a.id, tr.prev[0], tr.prev[1], tr.d, veh), o1 = ring.get(key) || offset("p", a.id, tr.cur[0], tr.cur[1], tr.d, veh);
        const k = s.t;
        let tx = s.x + 0.5 + o0[0] + (o1[0] - o0[0]) * k, ty = s.y + 0.5 + o0[1] + (o1[1] - o0[1]) * k;
        // a car in a bus's lane keeps nose to tail with it (behind it, unless well ahead), never inside it
        if (veh) for (const b of busPos) {
          if (b.d % 2 !== tr.d % 2) { // crossing the bus's road at a junction: wait short of it (or clear it)
            const bx = b.d % 2 === 0, cdir = tr.d < 2 ? 1 : -1;
            const dl = bx ? tx - b.x : ty - b.y, dc = bx ? ty - b.y : tx - b.x; // along the bus, across it
            if (Math.abs(dl) >= 0.725 + 0.2 || Math.abs(dc) >= 0.28 + 0.31) continue;
            const clear = (0.28 + 0.31 + 0.06) * (dc * cdir > 0.15 ? cdir : -cdir);
            if (bx) ty = b.y + clear; else tx = b.x + clear;
            continue;
          }
          if (b.d !== tr.d) continue;
          const ax = tr.d % 2 === 0, dir = tr.d < 2 ? 1 : -1;
          const along = ax ? tx - b.x : ty - b.y, across = ax ? ty - b.y : tx - b.x;
          if (Math.abs(across) > 0.3 || Math.abs(along) >= BUS_GAP) continue;
          const side = along * dir > 0.3 ? dir : -dir;
          if (ax) tx = b.x + side * BUS_GAP; else ty = b.y + side * BUS_GAP;
        }
        const p = proj.toWorld(tx, ty);
        let it;
        if (veh) {
          const spr = art.car(CV.carColor(a.id), a.vehicle, tr.d);
          it = { img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0]) - spr.ax, wy: Math.round(p[1]) - spr.ay,
            depth: proj.depth(tx, ty) + 0.02, kind: "car", id: a.id, hit: [spr.ax - 28, spr.ay - 26, spr.ax + 28, spr.ay + 12],
            lights: tr.d, moving: true, cx: p[0], cy: p[1], blink: a.vehicle === "ambulance" };
        } else {
          const sheet = art.person(a);
          const run = a.vehicle === "run";
          const fr = s.moving ? Math.floor(now / (run ? 85 : 150) + (hash(a.id) % 4)) % 4 : 0;
          const row = tr.face >= 0 ? tr.face : 0;
          it = { img: sheet.c, sx: fr * 16, sy: row * 30, sw: 16, sh: 30, wx: Math.round(p[0]) - 8, wy: Math.round(p[1]) - 28,
            depth: proj.depth(tx, ty) + 0.01, kind: "person", id: a.id, hit: [3, 1, 13, 30] };
        }
        if (a.state === "deciding") it.bubble = ["?", a.controller ? "#6cb6ff" : "#ffffff"];
        else if (a.activity === "phone_call" || a.activity === "text") it.bubble = ["…", "#ffffff"];
        else if (a.activity === "sleep") it.bubble = ["z", "#cfd8ff"];
        items.push(it);
        recs.set(a.id, { id: a.id, kind: it.kind === "car" ? "car" : "person", name: a.name, item: it, foot: p });
        if (veh && a.home) parked.add(placeOf(a.home) + ":" + a.id);
      }
      // a car parked on the home's driveway while its owner is at home (PLAN decision 45): an agent row with
      // car true whose owner is inside their home; one car per driveway, none while a moving van is there
      const done = new Set();
      for (const [, tr] of tracks) {
        const a = tr.agent;
        if (!a || !a.car || a.alive === false || VEHICLES[a.vehicle] || !a.inside) continue;
        const pid = placeOf(a.home);
        if (!pid || done.has(pid) || placeOf(a.inside) !== pid) continue;
        if ([...parked].some(k => k.startsWith(pid + ":"))) continue;
        if ((scene.looks[pid] || {}).moving) continue;
        const dv = scene.driveOf(pid);
        if (!dv) continue;
        done.add(pid);
        const pl = town.places[scene.placeById.get(pid)];
        const d = pl.face === "s" ? 1 : pl.face === "n" ? 3 : pl.face === "e" ? 0 : 2;
        const tx = dv[0] + 0.5, ty = dv[1] + 0.5;
        const spr = art.car(CV.carColor(a.id), "car", d);
        const p = proj.toWorld(tx, ty);
        items.push({ img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0]) - spr.ax, wy: Math.round(p[1]) - spr.ay,
          depth: proj.depth(tx, ty) + 0.02, kind: "parked", id: "parked:" + a.id, lights: null, moving: false, cx: p[0], cy: p[1] });
      }
      if (scene.setParked) scene.setParked(done);
      items.sort((a, b) => a.depth - b.depth);
      scene.movers = items;
    };
    // Dev and test hook: finish every move now (shown positions jump to the latest tiles).
    M.settle = () => { for (const tr of tracks.values()) tr.t0 = -1e9; };
    M.byId = id => recs.get(id) || recs.get("bus:" + id) || null;
    M.agent = id => { const tr = tracks.get(id); return tr && tr.agent || null; };
    M.bus = id => { const tr = tracks.get("bus:" + id); return tr && tr.bus || null; };
    scene.moverById = M.byId;
    return M;
  };
})();
