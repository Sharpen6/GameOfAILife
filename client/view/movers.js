// CityView movers: takes state frames, keeps one track per agent and bus, and each frame turns them into
// sorted draw items. Positions ease from the last shown point to the new tile along an L, over the measured
// real time between ticks. Of the two L orders the one whose inner tiles the mover may use wins (road for
// vehicles and buses, open ground for people), else the previous travel axis first, so cars turn at
// corners. When no L is clear, a walker steps straight across a blocked corner (between two park trees,
// through their shared corner point), and a walker or a car goes the shortest way round what is in the way.
// Cars keep to the right-hand lane. Buses keep to a wider one and swing from lane to lane through the lane
// corners; of two buses that would touch, one waits where it was until the other has gone by, checked on
// every frame and again on each new tick before the next moves start (at 8x or 16x a tick may get only a
// frame or two). Walkers keep to the pavement, each household at its own place along it (its members one
// behind another), and walkers bound for one spot of pavement on the same tick are spread apart along it;
// idle people on one tile stand in a small ring.
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
  // Buses keep 0.23 tiles right of the centre line, so two passing each other (0.42 wide) never touch. A
  // bus waiting for another to cross keeps BUS_AIR from it where it can, and never less than BUS_TOUCH.
  const BUS_LANE = 0.23, BUS_HL = 1.45 / 2, BUS_HW = 0.42 / 2, BUS_AIR = 0.18, BUS_TOUCH = 0.01;
  // A walker's place along the pavement: their household's own place (hashed from the home, AL_MAX tiles
  // at most from the tile's middle) plus their rank in it: 0, ahead, behind, further ahead... STEP apart.
  // Walkers bound for one spot of pavement keep at least STEP apart too, whatever their homes.
  const STAGGER = [0, 1, -1, 2, -2, 3, -3], STEP = 0.18, AL_MAX = 0.45;
  // A walker's straight step across a blocked corner skips this share of the move either side of the corner
  // point itself (a pixel or two), which lies on all four tiles at once.
  const CORNER = 0.02;
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
  // Does the straight line from (x0, y0) to tile (x1, y1) pass only over tiles that ok(x, y) allows, apart
  // from the two end tiles? A one-tile diagonal touches its two corner tiles only at their shared corner.
  function lineClear(x0, y0, x1, y1, ok) {
    const n = 8 * (Math.abs(x1 - x0) + Math.abs(y1 - y0)), ax = Math.round(x0), ay = Math.round(y0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = Math.floor(x0 + 0.5 + (x1 - x0) * t), y = Math.floor(y0 + 0.5 + (y1 - y0) * t);
      if (!(x === ax && y === ay) && !(x === x1 && y === y1) && !ok(x, y)) return false;
    }
    return true;
  }
  // The shortest way from tile (x0, y0) to tile (x1, y1) over tiles ok(x, y) allows (the two ends always
  // may be used), within a few tiles of them, going straight on where that is as short: its corner tiles
  // in order, or null when there is none of a sensible length.
  function detour(x0, y0, x1, y1, ok) {
    const PAD = 3, DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const bx = Math.min(x0, x1) - PAD, by = Math.min(y0, y1) - PAD, w = Math.abs(x1 - x0) + 2 * PAD + 1, h = Math.abs(y1 - y0) + 2 * PAD + 1;
    const inBox = (x, y) => x >= bx && y >= by && x < bx + w && y < by + h, ix = (x, y) => (y - by) * w + (x - bx);
    const dist = new Int16Array(w * h).fill(-1), q = [[x1, y1]];
    dist[ix(x1, y1)] = 0;
    for (let i = 0; i < q.length; i++) { // steps to the end, outward from it until the start is reached
      const [x, y] = q[i];
      if (x === x0 && y === y0) break;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (!inBox(nx, ny) || dist[ix(nx, ny)] >= 0 || !((nx === x0 && ny === y0) || ok(nx, ny))) continue;
        dist[ix(nx, ny)] = dist[ix(x, y)] + 1; q.push([nx, ny]);
      }
    }
    const n = dist[ix(x0, y0)];
    if (n < 0 || n > 2 * (Math.abs(x1 - x0) + Math.abs(y1 - y0)) + 4) return null;
    const via = [];
    let x = x0, y = y0, hd = -1;
    while (x !== x1 || y !== y1) {
      const d = dist[ix(x, y)];
      let k = -1;
      for (const c of hd >= 0 ? [hd, 0, 1, 2, 3] : [0, 1, 2, 3]) { const nx = x + DX[c], ny = y + DY[c]; if (inBox(nx, ny) && dist[ix(nx, ny)] === d - 1) { k = c; break; } }
      if (hd >= 0 && k !== hd) via.push([x, y]);
      hd = k; x += DX[k]; y += DY[k];
    }
    return via;
  }
  // A point at share t of the way along the polyline pts: where, the step direction, which segment (i,
  // from pts[i]) and the polyline's length.
  function along(pts, t) {
    const seg = [];
    let len = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); len += l; }
    let r = t * len, i = 0;
    while (i < seg.length - 1 && r > seg[i]) { r -= seg[i]; i++; }
    const a = pts[i], b = pts[i + 1], k = seg[i] ? Math.min(1, r / seg[i]) : 1;
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, sx: Math.sign(b[0] - a[0]), sy: Math.sign(b[1] - a[1]), t, moving: t < 1, seg: i, len };
  }
  // The point in tile (x, y) where the bus lane of heading a meets the lane of heading b (the lane of b when
  // the two run along one axis): x from the heading along y, y from the heading along x.
  function laneCorner(x, y, a, b) {
    const o = d => [[0, BUS_LANE], [-BUS_LANE, 0], [0, -BUS_LANE], [BUS_LANE, 0]][d];
    if (a % 2 === b % 2) return [x + 0.5 + o(b)[0], y + 0.5 + o(b)[1]];
    const ys = a % 2 ? a : b, xs = a % 2 ? b : a;
    return [x + 0.5 + o(ys)[0], y + 0.5 + o(xs)[1]];
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
    let lastTick = null, tickAt = 0, recs = new Map(), rankKey = "", alongOf = new Map();
    const tile = (x, y) => (x < 0 || y < 0 || x >= town.w || y >= town.h) ? null : town.tiles[y][x];
    // where a vehicle may cut a corner (roads, which run off the map) and where a person may (open ground)
    const roadOk = (x, y) => { const c = tile(x, y); return c === null || c === "#"; };
    const walkOk = (x, y) => { const c = tile(x, y); return c === null || WALKABLE.includes(c); };

    // The share (0..1) of its current move a track has made by now.
    const share = (tr, now) => Math.min(1, Math.max(0, (now - tr.t0) / tr.dur));
    // Where a track is shown now, in tile units, with the step direction it is moving in.
    function shown(tr, now) { return at(tr, share(tr, now)); }
    // The same at a share t (0..1) of the current move.
    function at(tr, t) {
      const [px, py] = tr.prev, [cx, cy] = tr.cur;
      const dx = cx - px, dy = cy - py, total = Math.abs(dx) + Math.abs(dy);
      if (!total) return { x: cx, y: cy, sx: 0, sy: 0, t: 1, moving: false };
      // a way round what blocks the L (or, with no corners, a walker's straight line across a blocked corner;
      // on a one-tile step it passes the corner point the four tiles share in one go, on neither tree tile)
      if (tr.via) {
        const u = !tr.via.length && Math.abs(dx) === 1 && Math.abs(dy) === 1 && Math.abs(t - 0.5) < CORNER ? (t < 0.5 ? 0.5 - CORNER : 0.5 + CORNER) : t;
        return along([tr.prev, ...tr.via, tr.cur], u);
      }
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
    // A new tile for a track. ok(x, y): the tiles this mover may use on the way. A diagonal move takes the
    // L whose inner tiles all pass ok (a car leaving its driveway turns onto the road first instead of
    // sliding along the lawn, a walker in a park steps round a tree); when both do, it keeps going along
    // the axis travelled last, so cars turn at corners. When no L is clear, or a straight move is blocked,
    // a walker (way "walk") goes straight across if that line is clear (a park step between two trees, over
    // their shared corner point), else a walker or a car ("walk", "drive") takes the shortest way round
    // (via, its corner tiles); a bus (no way) keeps to the L, as its route does.
    function track(key, x, y, now, fresh, ok, way) {
      let tr = tracks.get(key);
      if (!tr) { tr = { prev: [x, y], cur: [x, y], t0: now, dur: M.tickMs, first: "x", axis: null, via: null, face: 0, d: 0 }; tracks.set(key, tr); return tr; }
      if (!fresh) return tr;
      // a bus held short of another starts its next move from where it was last drawn, lane point and all
      const t = tr.hold != null ? tr.hold : share(tr, now), s = at(tr, t), lp = tr.bus ? busAt(tr, t) : null;
      tr.hold = null; tr.lane = null; tr.lp0 = lp && [lp.x, lp.y]; tr.seen = 0;
      // a walker's spread along the pavement (spread) carries on from where it was shown
      tr.adj0 = (tr.adj0 || 0) + ((tr.adj1 || 0) - (tr.adj0 || 0)) * s.t;
      if (s.t >= 0.5) tr.ax0 = tr.ax1;
      if (tr.cur[0] === x && tr.cur[1] === y) { // no new tile: the rest of the move shown, the same way
        if (tr.via) tr.via = tr.via.slice(s.seg || 0);
        tr.prev = [s.x, s.y]; tr.t0 = now; return tr;
      }
      const dx = x - s.x, dy = y - s.y;
      if (Math.abs(dx) + Math.abs(dy) > SNAP) { tr.prev = [x, y]; tr.lp0 = null; } else tr.prev = [s.x, s.y];
      tr.cur = [x, y]; tr.t0 = now; tr.dur = M.tickMs; tr.via = null;
      const x0 = Math.round(tr.prev[0]), y0 = Math.round(tr.prev[1]);
      let clear = true;
      if (dx && dy) {
        let first = null;
        if (ok) {
          const xs = lClear(x0, y0, x, y, true, ok), ys = lClear(x0, y0, x, y, false, ok);
          if (xs !== ys) first = xs ? "x" : "y";
          clear = xs || ys;
        }
        tr.first = first || tr.axis || (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
      } else {
        tr.first = dx ? "x" : "y";
        if (ok) clear = lClear(x0, y0, x, y, true, ok);
      }
      if (!clear && way) tr.via = way === "walk" && dx && dy && lineClear(tr.prev[0], tr.prev[1], x, y, ok) ? [] : detour(x0, y0, x, y, ok);
      return tr;
    }
    // Lane, kerb and jitter offsets inside a tile. Walkers on a road keep to the pavement on their side
    // and, along it, to their household's place and their own in it (stagger), so a family walks one
    // behind another and two households apart; at a junction they keep to a kerb corner. adj is the walker's
    // spread from others bound for the same spot (spread), eased in over the move: along the pavement, or
    // at a corner along ax, the way the walker came in.
    const isRoad = (x, y) => scene.isRoad(x, y);
    // A road tile that is not a junction, where walkers keep to a pavement along it: "ew", "ns" or null.
    function pavement(x, y) {
      if (!isRoad(x, y)) return null;
      const ew = isRoad(x - 1, y) || isRoad(x + 1, y), ns = isRoad(x, y - 1) || isRoad(x, y + 1);
      return ew && ns ? null : ns ? "ns" : "ew";
    }
    const sideOf = id => hash(id) % 2 ? 1 : -1;
    const cornerOf = id => hash(id + "k") % 2 ? 1 : -1;
    function offset(kind, id, x, y, d, vehicle, lane, adj, ax) {
      x = Math.round(x); y = Math.round(y);
      if (vehicle) { const L = lane || LANE; const o = [[0, L], [-L, 0], [0, -L], [L, 0]][d] || [0, 0]; return o; }
      if (isRoad(x, y)) {
        const side = sideOf(id), pv = pavement(x, y);
        if (!pv) { // a junction: a kerb corner
          const o = [cornerOf(id) * KERB, side * KERB];
          if (adj && ax) o[ax === "x" ? 0 : 1] += adj;
          return o;
        }
        const al = Math.max(-AL_MAX, Math.min(AL_MAX, stagger(id) + (adj || 0)));
        return pv === "ns" ? [side * KERB, al] : [al, side * KERB];
      }
      const h = hash(id + ":j");
      return [((h % 7) - 3) * 0.04, (((h >>> 8) % 7) - 3) * 0.04];
    }
    // A walker's place along the pavement: fixed per person (so moves stay smooth), their household's place
    // plus their rank in it (by id), so the members of a household, who walk the same tiles together, keep
    // STEP apart and two households seldom share a place.
    function stagger(id) { const al = alongOf.get(id); return al == null ? 0 : al; }
    // On a new tick: walkers bound for one spot of pavement (the same road tile and kerb, or the same kerb
    // corner of a junction) whose places are nearer than STEP are spread apart along it, in the order of
    // their places (ids on a tie), keeping within AL_MAX, so two people from two homes walking together
    // are drawn one behind the other, never as one figure. At a corner the group is centred on it and each
    // keeps to the way they came in. Each walker's spread (adj1) is eased in over the move from what was
    // shown (adj0).
    function spread() {
      const by = new Map();
      for (const [key, tr] of tracks) {
        const a = tr.agent, [x, y] = tr.cur;
        tr.adj1 = 0; tr.ax1 = null;
        if (!a || a.alive === false || a.inside || a.riding || VEHICLES[a.vehicle] || !isRoad(x, y)) continue;
        const corner = !pavement(x, y), k = x + "," + y + (sideOf(a.id) > 0 ? "+" : "-") + (corner ? (cornerOf(a.id) > 0 ? "+" : "-") : "");
        if (!by.has(k)) by.set(k, []);
        by.get(k).push({ tr, id: key, al: stagger(a.id), corner });
      }
      for (const g of by.values()) {
        if (g.length < 2) continue;
        g.sort((p, q) => p.al - q.al || (p.id < q.id ? -1 : 1));
        const gap = Math.min(STEP, 2 * AL_MAX / (g.length - 1)), v = g.map(q => q.al);
        for (let i = 1; i < v.length; i++) v[i] = Math.max(v[i], v[i - 1] + gap);
        if (v[v.length - 1] > AL_MAX) { v[v.length - 1] = AL_MAX; for (let i = v.length - 2; i >= 0; i--) v[i] = Math.min(v[i], v[i + 1] - gap); }
        const mid = (v[0] + v[v.length - 1]) / 2;
        g.forEach((q, i) => {
          if (!q.corner) { q.tr.adj1 = v[i] - q.al; return; }
          q.tr.adj1 = v[i] - mid; q.tr.ax1 = inAxis(q.tr);
        });
      }
    }
    // The axis of the last leg of a track's move into its tile ("x" or "y"); standing, the way it last went.
    function inAxis(tr) {
      const [cx, cy] = tr.cur, px = Math.round(tr.prev[0]), py = Math.round(tr.prev[1]);
      const from = tr.via && tr.via.length ? tr.via[tr.via.length - 1] : px !== cx && py !== cy ? (tr.first === "x" ? [cx, py] : [px, cy]) : [px, py];
      return from[0] !== cx ? "x" : from[1] !== cy ? "y" : tr.ax0 || tr.axis || "x";
    }

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
        const tr = track(a.id, a.x, a.y, now, fresh, VEHICLES[a.vehicle] ? roadOk : walkOk, VEHICLES[a.vehicle] ? "drive" : "walk");
        tr.agent = a;
      }
      // each person's place along the pavement (stagger): their household's, hashed from the home and kept
      // far enough in that the whole household stays within AL_MAX, plus their rank in it by id (redone when
      // people move house, arrive or die)
      const live = (st.agents || []).filter(a => a.alive !== false), rk = live.map(a => a.id + ":" + (a.home || "")).join(",");
      if (rk !== rankKey) {
        rankKey = rk; alongOf = new Map();
        const by = new Map();
        for (const a of live) { const h = a.home || ""; if (!by.has(h)) by.set(h, []); by.get(h).push(a.id); }
        for (const [h, ids] of by) {
          ids.sort();
          const own = ids.map((_, k) => STAGGER[k % STAGGER.length] * STEP), reach = Math.max(...own.map(Math.abs));
          const base = ((hash(h + ":al") % 1001) / 500 - 1) * Math.max(0, AL_MAX - reach);
          ids.forEach((id, k) => alongOf.set(id, Math.max(-AL_MAX, Math.min(AL_MAX, base + own[k]))));
        }
      }
      if (fresh) spread();
      const buses = busesOf(st);
      if (fresh) settleBuses(now);
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

    // A bus's lane path for its current move, in tile units, kept until the next move: from where it was
    // drawn when the move began, through the lane corner of the L (where its two lanes meet), to the lane
    // point in the end tile, already turned into the lane of the heading it leaves by (its row's dir). A bus
    // is drawn at a share of the path's length, so at a corner it swings from one lane into the other
    // instead of jumping across.
    function lanePath(tr) {
      if (tr.lane) return tr.lane;
      const [px, py] = tr.prev, [cx, cy] = tr.cur, dx = cx - px, dy = cy - py;
      const hx = dx > 0 ? 0 : 2, hy = dy > 0 ? 1 : 3;
      const legs = dx && dy ? (tr.first === "x" ? [hx, hy] : [hy, hx]) : dx ? [hx] : dy ? [hy] : [];
      const out = DIR_OF[tr.bus.dir] != null ? DIR_OF[tr.bus.dir] : legs.length ? legs[legs.length - 1] : tr.d;
      const pts = [];
      if (!legs.length) pts.push(tr.lp0 || laneCorner(cx, cy, out, out)); // standing: where it stands
      else {
        pts.push(tr.lp0 || laneCorner(px, py, legs[0], legs[0]));
        if (legs.length === 2) pts.push(tr.first === "x" ? laneCorner(cx, py, legs[0], legs[1]) : laneCorner(px, cy, legs[0], legs[1]));
        pts.push(laneCorner(cx, cy, legs[legs.length - 1], out));
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return (tr.lane = { pts, cum, len: cum[cum.length - 1], out });
    }
    // A bus at share t of its move: its body centre in tile units, its heading (the lane segment it is on;
    // standing, its row's dir) and whether it is moving.
    function busAt(tr, t) {
      const P = lanePath(tr), pts = P.pts, len = P.len;
      if (len < 1e-6) return { tr, t, moving: false, d: P.out, x: pts[0][0], y: pts[0][1] };
      const s = t * len;
      let i = 1;
      while (i < pts.length - 1 && (s > P.cum[i] || P.cum[i] - P.cum[i - 1] < 1e-6)) i++;
      const a = pts[i - 1], b = pts[i], seg = P.cum[i] - P.cum[i - 1], k = seg > 1e-6 ? Math.min(1, Math.max(0, (s - P.cum[i - 1]) / seg)) : 1;
      const ux = b[0] - a[0], uy = b[1] - a[1];
      const d = Math.abs(ux) >= Math.abs(uy) ? (ux > 0 ? 0 : 2) : (uy > 0 ? 1 : 3);
      return { tr, t, moving: t < 1, d, x: a[0] + ux * k, y: a[1] + uy * k, seg: i };
    }
    // Do two bus bodies overlap, with air between them (wide: BUS_AIR when they cross each other's road,
    // else BUS_TOUCH; side by side in opposite lanes they are 0.04 apart)?
    const busExt = d => d % 2 === 0 ? [BUS_HL, BUS_HW] : [BUS_HW, BUS_HL];
    function clash(a, b, wide) {
      const ea = busExt(a.d), eb = busExt(b.d), air = wide && a.d % 2 !== b.d % 2 ? BUS_AIR : BUS_TOUCH;
      return Math.abs(a.x - b.x) < ea[0] + eb[0] + air && Math.abs(a.y - b.y) < ea[1] + eb[1] + air;
    }
    const busOrder = (a, b) => String(a.tr.bus.line || "1").localeCompare(String(b.tr.bus.line || "1")) || String(a.tr.bus.id).localeCompare(String(b.tr.bus.id));
    // Of two buses that clash, the one that should give way: crossing, the one further from the crossing;
    // in one lane, the one behind; else (and on a near tie) line 2 before line 1, then the higher id.
    function waiter(a, b) {
      if (a.d % 2 !== b.d % 2) {
        const [X, Y] = a.d % 2 === 0 ? [a, b] : [b, a]; // X runs along x, Y along y; their lanes cross at (Y.x, X.y)
        const uX = (Y.x - X.x) * (X.d === 0 ? 1 : -1), uY = (X.y - Y.y) * (Y.d === 1 ? 1 : -1);
        if (Math.abs(uX - uY) > 0.2) return uX < uY ? Y : X;
      } else if (a.d === b.d) {
        const ahead = (a.d % 2 === 0 ? b.x - a.x : b.y - a.y) * (a.d < 2 ? 1 : -1); // how far b is ahead of a
        if (Math.abs(ahead) > 0.05) return ahead > 0 ? a : b;
      }
      return busOrder(a, b) <= 0 ? b : a;
    }
    // Hold bus B's move at the furthest point of it so far that is clear of bus P (with BUS_AIR across a
    // crossing where that can be had, else just clear): its track's clock is set back, so the next frames
    // carry on from there. False when B is standing (or has stood at the end of its move on an earlier
    // frame: it is never pulled back from there), or was in P's way all along its move.
    function holdBus(B, P, now) {
      const tr = B.tr, t = B.t;
      if (lanePath(tr).len < 1e-6 || (t >= 1 && !(tr.seen < 1))) return false;
      for (const wide of [true, false]) {
        const free = k => !clash(busAt(tr, k), P, wide);
        if (free(t)) return true;
        let k = 7;
        while (k >= 0 && !free(t * k / 8)) k--;
        if (k < 0) continue;
        let lo = t * k / 8, hi = t * (k + 1) / 8;
        for (let n = 0; n < 12; n++) { const m = (lo + hi) / 2; if (free(m)) lo = m; else hi = m; }
        tr.t0 = now - lo * tr.dur; tr.hold = lo;
        Object.assign(B, busAt(tr, lo));
        return true;
      }
      return false;
    }
    // On a new tick, before the buses take their next moves: of two buses that would touch where this tick
    // leaves them, the one that gives way is held where it was last clear, as a frame drawn late in the tick
    // would have held it, so the next moves start apart. At 8x or 16x (or on a slow device) a tick gets
    // only a frame or two, and none may come late enough (review ART-3).
    function settleBuses(now) {
      const bl = [];
      for (const tr of tracks.values()) if (tr.bus && tr.drawn) bl.push(busAt(tr, tr.hold != null ? tr.hold : share(tr, now)));
      for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) {
        const a = bl[i], b = bl[j];
        if (!clash(a, b, true)) continue;
        const W = waiter(a, b), F = W === a ? b : a;
        if (!holdBus(W, F, now) && !holdBus(F, W, now)) backUp(W, F, now);
      }
    }
    // A bus on another bus that no hold can part (the first frame after the page loads, say, two buses that
    // came to a stand on one spot, or a burst of ticks with no frame between them, so both moves start where
    // the two touch): it is put back along its lane path, then on behind where the path starts, as far as it
    // takes to clear the other (2 tiles at most). A standing bus stays there; a moving one waits there and
    // carries on along the rest of its path.
    function backUp(B, P, now) {
      const tr = B.tr, L = lanePath(tr), pts = L.pts, standing = L.len < 1e-6;
      const U = [[1, 0], [0, 1], [-1, 0], [0, -1]], head = (a, b) => Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? (b[0] > a[0] ? 0 : 2) : (b[1] > a[1] ? 1 : 3);
      const back = r => { // B put back r tiles: where, its heading there, and the index of the path point it is past
        if (standing) return [B.x - U[B.d][0] * r, B.y - U[B.d][1] * r, B.d, -1];
        let x = B.x, y = B.y;
        for (let j = B.seg - 1; j >= 0; j--) {
          const l = Math.hypot(pts[j][0] - x, pts[j][1] - y);
          if (l >= r && l > 1e-9) return [x + (pts[j][0] - x) * r / l, y + (pts[j][1] - y) * r / l, head(pts[j], [x, y]), j];
          r -= l; x = pts[j][0]; y = pts[j][1];
        }
        const d = busAt(tr, 0).d; // behind the start, along the heading the path starts with
        return [pts[0][0] - U[d][0] * r, pts[0][1] - U[d][1] * r, d, -1];
      };
      let k = 0, at = back(0);
      while (k < 40 && clash({ d: at[2], x: at[0], y: at[1] }, P, true)) at = back(++k * 0.05);
      const lane = [[at[0], at[1]], ...(standing ? [] : pts.slice(at[3] + 1))], cum = [0];
      for (let i = 1; i < lane.length; i++) cum.push(cum[i - 1] + Math.hypot(lane[i][0] - lane[i - 1][0], lane[i][1] - lane[i - 1][1]));
      tr.lane = { pts: lane, cum, len: cum[cum.length - 1], out: L.out };
      tr.lp0 = lane[0]; tr.t0 = now; tr.hold = 0;
      Object.assign(B, busAt(tr, 0));
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
      for (const [, tr] of tracks) if (tr.bus) { tr.hold = null; bl.push(busAt(tr, share(tr, now))); }
      // Two buses about to touch (crossing at a junction, or one turning across the other's lane): the one
      // that should give way (waiter) stops where it is, short of the other, until that one has gone by; if
      // it was in the way all along its move, the other one waits instead. The move is held where it
      // stands, so it never jumps, and it catches up over the next tick.
      for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) {
        const a = bl[i], b = bl[j];
        if (!clash(a, b, true)) continue;
        const W = waiter(a, b), F = W === a ? b : a;
        if (!holdBus(W, F, now) && !holdBus(F, W, now)) backUp(W, F, now);
      }
      for (const B of bl) {
        const tr = B.tr, b = tr.bus, s = at(tr, B.t);
        tr.d = B.d; tr.drawn = true; tr.seen = B.t;
        if (s.sx) tr.axis = "x"; else if (s.sy) tr.axis = "y";
        const tx = B.x, ty = B.y;
        busPos.push({ d: tr.d, x: tx, y: ty });
        const spr = art.bus(b.line || "1", tr.d, !!b.at_stop && !B.moving, b.riders | 0);
        const p = proj.toWorld(tx, ty);
        const it = { img: spr.c, sx: 0, sy: 0, sw: spr.c.width, sh: spr.c.height, wx: Math.round(p[0]) - spr.ax, wy: Math.round(p[1]) - spr.ay,
          depth: proj.depth(tx, ty) + 0.02, kind: "bus", id: b.id, hit: [spr.ax - 44, spr.ay - 40, spr.ax + 44, spr.ay + 14],
          lights: tr.d, moving: B.moving || !b.at_stop, cx: p[0], cy: p[1] };
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
        const o0 = offset("p", a.id, tr.prev[0], tr.prev[1], tr.d, veh, null, tr.adj0, tr.ax0), o1 = ring.get(key) || offset("p", a.id, tr.cur[0], tr.cur[1], tr.d, veh, null, tr.adj1, tr.ax1);
        // on a way round (or straight across a corner) a walker keeps to the way itself, off its kerb or
        // standing spot from half a tile after the start to half a tile before the end
        const k = s.t, f = !veh && tr.via && s.moving ? Math.max(0, 1 - 2 * Math.max(1, Math.round(s.len)) * Math.min(k, 1 - k)) : 1;
        let tx = s.x + 0.5 + (o0[0] + (o1[0] - o0[0]) * k) * f, ty = s.y + 0.5 + (o0[1] + (o1[1] - o0[1]) * k) * f;
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
