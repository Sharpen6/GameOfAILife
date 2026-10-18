// CityView trains: state.trains rows (region.md 8: {id, line, track, i, x, y, dir, at_station, riders}, ids
// R1..R6 and S1..S4) drawn on welcome.town.rail (view.md 3.5, 4.1). A track's polyline is its corners
// (town.rail.lines[*].tracks[track]) + 0.5, the tile centres; its length is track_tiles - 1, so a row's i is
// the arc length s along it. s eases from the last shown s to the new i over M.tickMs, and snaps on a track
// change, when i drops, or when |di| > 12. Car k (0 = head) sits at s - k, clamped to the track, one tile
// long and facing its segment; depth = proj.depth(centre) + 0.05; doors open while at_station.
// CV.makeTrains(scene, M) registers with scene.addMovers: near sprites (art.trainCar(color, dir, kind, open)
// when the art has it, else a box in the line's colour), mid marks and far segments, picks
// {kind: "train", id, line, riders}. Classic script on window.CityView; no random numbers.
"use strict";
(function () {
  const CV = window.CityView = window.CityView || {};
  const LINE_COLORS = { R: "#c8323c", S: "#2f74c8" };
  CV.LINE_COLORS = CV.LINE_COLORS || LINE_COLORS;
  const SNAP = 12, CAR_W = 0.42;

  // A polyline with cumulative lengths, and the point at arc length s on it.
  function polyline(corners) {
    const pts = corners.map(c => [c[0] + 0.5, c[1] + 0.5]), cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.abs(pts[k][0] - pts[k - 1][0]) + Math.abs(pts[k][1] - pts[k - 1][1]));
    return { pts, cum, len: cum[cum.length - 1] };
  }
  function pointAt(pl, s) {
    s = Math.max(0, Math.min(pl.len, s));
    let k = 1;
    while (k < pl.pts.length - 1 && s > pl.cum[k]) k++;
    const a = pl.pts[k - 1], b = pl.pts[k], l = pl.cum[k] - pl.cum[k - 1], f = l > 0 ? (s - pl.cum[k - 1]) / l : 0;
    const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, d: dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3, seg: k - 1 };
  }
  CV.railPolyline = polyline;
  CV.railPointAt = pointAt;

  CV.makeTrains = function (scene, M) {
    const town = scene.town, lines = new Map();
    for (const l of (town.rail && town.rail.lines) || []) {
      const tracks = {};
      for (const k of Object.keys(l.tracks || {})) {
        const pl = polyline(l.tracks[k]);
        const tt = l.track_tiles && l.track_tiles[k];
        if (tt) pl.len = Math.min(pl.len, tt - 1);
        tracks[k] = pl;
      }
      lines.set(l.id, { l, tracks, color: l.color || LINE_COLORS[l.id] || "#8a8a96", cars: l.cars || 4 });
    }
    const trains = new Map(); // id -> {row, line, track, s0, s1, t0, dur}
    let lastTick = null, drawnCars = 0, version = 0;
    const viewNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    // drawing runs on the time of the frame being drawn (view.js: setNow), frames arrive on the real clock
    let frameNow = null;
    const drawNow = () => (frameNow != null ? frameNow : viewNow());
    const sOf = (t, now) => t.s0 + (t.s1 - t.s0) * Math.min(1, Math.max(0, (now - t.t0) / t.dur));

    function setState(st, now) {
      const rows = st && st.trains;
      if (!Array.isArray(rows)) return;
      const fresh = lastTick === null || st.tick !== lastTick;
      lastTick = st.tick;
      const seen = new Set();
      for (const r of rows) {
        const L = lines.get(r.line);
        if (!L || !L.tracks[r.track]) continue;
        seen.add(r.id);
        let t = trains.get(r.id);
        if (!t) { t = { row: r, line: L, track: r.track, s0: r.i, s1: r.i, t0: now, dur: 1 }; trains.set(r.id, t); continue; }
        t.row = r;
        if (!fresh) continue;
        const s = sOf(t, now), di = r.i - t.s1;
        if (r.track !== t.track || r.i < t.s1 || Math.abs(di) > SNAP) { t.track = r.track; t.s0 = t.s1 = r.i; t.t0 = now; t.dur = 1; continue; }
        t.s0 = s; t.s1 = r.i; t.t0 = now; t.dur = Math.max(30, (M && M.tickMs) || 417) * 1.1;
      }
      for (const id of [...trains.keys()]) if (!seen.has(id)) trains.delete(id);
      version++;
    }
    // the cars of train t now: [{x, y, d, k}] in tile units (centres)
    function cars(t, now) {
      const pl = t.line.tracks[t.track], s = sOf(t, now), out = [];
      for (let k = 0; k < t.line.cars; k++) { const p = pointAt(pl, s - k); out.push({ x: p.x, y: p.y, d: p.d, k }); }
      return out;
    }
    // A car's footprint corners in world px at height z: 1 tile along its heading, CAR_W across.
    function footprint(proj, c, z) {
      const ax = c.d % 2 === 0, hl = 0.5, hw = CAR_W / 2;
      const x0 = c.x - (ax ? hl : hw), x1 = c.x + (ax ? hl : hw), y0 = c.y - (ax ? hw : hl), y1 = c.y + (ax ? hw : hl);
      return [proj.toWorld(x0, y0, z), proj.toWorld(x1, y0, z), proj.toWorld(x1, y1, z), proj.toWorld(x0, y1, z)];
    }
    const shade = (hex, f) => {
      const n = parseInt(hex.slice(1), 16), r = Math.min(255, Math.round(((n >> 16) & 255) * f)), g = Math.min(255, Math.round(((n >> 8) & 255) * f)), b = Math.min(255, Math.round((n & 255) * f));
      return `rgb(${r},${g},${b})`;
    };
    // The stand-in car until the art has trainCar: a box 1 tile long, 15 px tall, darker sides, a window band,
    // open doors as light gaps.
    function boxCar(g, S, ox, oy, proj, c, color, open, kind) {
      const zt = 15 * (proj.zk || 1), base = footprint(proj, c, 0), top = footprint(proj, c, zt);
      const P = q => [q[0] * S + ox, q[1] * S + oy];
      const quad = (a, b, cc, d, fill) => { g.fillStyle = fill; g.beginPath(); const p = [a, b, cc, d].map(P); g.moveTo(p[0][0], p[0][1]); for (let k = 1; k < 4; k++) g.lineTo(p[k][0], p[k][1]); g.closePath(); g.fill(); };
      // the two faces the camera sees: the ones with the largest screen y
      const faces = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => ({ a, b, y: (base[a][1] + base[b][1]) / 2 })).sort((p, q) => q.y - p.y).slice(0, 2);
      for (const f of faces) {
        quad(base[f.a], base[f.b], top[f.b], top[f.a], shade(color, f === faces[0] ? 0.82 : 0.66));
        const mid = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const w0 = mid(base[f.a], top[f.a], 0.55), w1 = mid(base[f.b], top[f.b], 0.55), w2 = mid(base[f.b], top[f.b], 0.8), w3 = mid(base[f.a], top[f.a], 0.8);
        quad(w0, w1, w2, w3, open ? "#fff2b0" : "#a8cfe8");
      }
      quad(top[0], top[1], top[2], top[3], shade(color, 1.08));
      if (kind === "head") { const cx = (top[0][0] + top[2][0]) / 2, cy = (top[0][1] + top[2][1]) / 2; g.fillStyle = "#2a2a30"; g.fillRect(cx * S + ox - 1.5 * S, cy * S + oy - 6 * S, 3 * S, 6 * S); }
    }
    const viewIn = (v, w, m) => w[0] >= v.x0 - m && w[0] <= v.x1 + m && w[1] >= v.y0 - m && w[1] <= v.y1 + m;
    const T = {
      M, lines,
      setState(st, now) { setState(st, now == null ? viewNow() : now); },
      // tile-unit car centres of a train now (tests, minimap, follow)
      carsOf(id, now) { const t = trains.get(id); return t ? cars(t, now == null ? drawNow() : now) : null; },
      sOf(id, now) { const t = trains.get(id); return t ? sOf(t, now == null ? drawNow() : now) : null; },
      setNow(t) { frameNow = t == null ? null : +t; },
      rows: () => [...trains.values()].map(t => t.row),
      // The Transit layer, drawn by view.js over the scene: each line's tracks in its colour, the bus loops
      // dashed (town.timetable.bus.lines[*].corners, when the town has them), and a ring at each station
      // (stations: [{x, y, line}] in tiles). Returns the number of shapes drawn.
      drawTransit(g, stations) {
        const v = scene.view(), k = scene.dpr || 1, proj = scene.proj;
        const P = (x, y) => { const w = proj.toWorld(x, y); return [w[0] * v.S + v.ox, w[1] * v.S + v.oy]; };
        const path = pts => { g.beginPath(); pts.forEach((p, n) => { const q = P(p[0], p[1]); if (n) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); };
        let n = 0;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.lineJoin = "round"; g.lineCap = "round";
        const tt = town.timetable && town.timetable.bus && town.timetable.bus.lines;
        for (const b of Array.isArray(tt) ? tt : []) {
          if (!b || !Array.isArray(b.corners) || b.corners.length < 2) continue;
          path(b.corners.map(c => [c[0] + 0.5, c[1] + 0.5]));
          g.setLineDash([6 * k, 5 * k]); g.strokeStyle = "rgba(255, 207, 58, 0.9)"; g.lineWidth = 2.5 * k; g.stroke();
          n++;
        }
        g.setLineDash([]);
        for (const L of lines.values()) {
          for (const pl of Object.values(L.tracks)) {
            path(pl.pts);
            g.strokeStyle = "rgba(16, 16, 20, 0.55)"; g.lineWidth = 6 * k; g.stroke();
            g.strokeStyle = L.color; g.lineWidth = 3.5 * k; g.stroke();
            n++;
          }
        }
        for (const s of stations || []) {
          const L = lines.get(s.line), q = P(s.x, s.y);
          g.beginPath(); g.arc(q[0], q[1], 7 * k, 0, 2 * Math.PI);
          g.fillStyle = "#ffffff"; g.fill();
          g.strokeStyle = L ? L.color : "#8a8a96"; g.lineWidth = 3 * k; g.stroke();
          n++;
        }
        g.restore();
        return n;
      },
      stats: () => ({ trains: trains.size, trainCars: drawnCars }),
      version: () => version,
      items(v, out) {
        drawnCars = 0;
        if (v.lod && v.lod !== "near") return;
        const now = drawNow(), proj = scene.proj, art = scene.art;
        for (const t of trains.values()) {
          const open = !!t.row.at_station, cs = cars(t, now), n = cs.length;
          for (const c of cs) {
            const w = proj.toWorld(c.x, c.y);
            if (!viewIn(v, w, 80)) continue;
            drawnCars++;
            const kind = c.k === 0 ? "head" : c.k === n - 1 ? "tail" : "car";
            const depth = proj.depth(c.x, c.y) + 0.05;
            let sp = null;
            if (typeof art.trainCar === "function") { try { sp = art.trainCar(t.line.color, c.d, kind, open); } catch (e) { sp = null; } }
            if (sp && sp.c) {
              const img = sp.c, wx = Math.round(w[0]) - (sp.ax | 0), wy = Math.round(w[1]) - (sp.ay | 0);
              out.push({ depth, wx, wy, wx1: wx + img.width, wy1: wy + img.height, train: t.row.id, draw(g, S, ox, oy) {
                const dx0 = Math.round(wx * S + ox), dy0 = Math.round(wy * S + oy), dx1 = Math.round((wx + img.width) * S + ox), dy1 = Math.round((wy + img.height) * S + oy);
                if (dx1 > dx0 && dy1 > dy0) g.drawImage(img, 0, 0, img.width, img.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
              } });
            } else {
              out.push({ depth, wx: w[0] - 40, wy: w[1] - 40, wx1: w[0] + 40, wy1: w[1] + 24, train: t.row.id, draw(g, S, ox, oy) { boxCar(g, S, ox, oy, proj, c, t.line.color, open, kind); } });
            }
          }
        }
      },
      // mid: each car a short bar in the line's colour; far: one segment per train
      marks(g, v, lod) {
        drawnCars = 0;
        if (lod !== "mid" && lod !== "far") return;
        const now = drawNow(), proj = scene.proj, S = v.S, k = Math.max(1, Math.round(scene.dpr || 1));
        g.lineCap = "butt";
        for (const t of trains.values()) {
          const cs = cars(t, now);
          g.strokeStyle = t.line.color;
          g.lineWidth = (lod === "mid" ? 3 : 2) * k;
          const pl = t.line.tracks[t.track], s = sOf(t, now);
          const seg = (a, b) => {
            const p = pointAt(pl, a), q = pointAt(pl, b), wp = proj.toWorld(p.x, p.y), wq = proj.toWorld(q.x, q.y);
            g.beginPath(); g.moveTo(wp[0] * S + v.ox, wp[1] * S + v.oy); g.lineTo(wq[0] * S + v.ox, wq[1] * S + v.oy); g.stroke();
          };
          if (lod === "mid") for (const c of cs) { seg(s - c.k - 0.45, s - c.k + 0.45); drawnCars++; }
          else { seg(s - cs.length + 0.5, s + 0.5); drawnCars += cs.length; }
        }
      },
      pick(wx, wy, r) {
        const now = drawNow(), proj = scene.proj;
        let best = null, bd = Infinity;
        for (const t of trains.values()) for (const c of cars(t, now)) {
          const w = proj.toWorld(c.x, c.y, 8), d = Math.abs(wx - w[0]) / 34 + Math.abs(wy - w[1]) / 20;
          if (d <= 1 + r / 20 && d < bd) { bd = d; best = { t, c }; }
        }
        if (!best) return null;
        const row = best.t.row, hit = { kind: "train", id: row.id, line: row.line, riders: row.riders | 0 };
        Object.defineProperty(hit, "depth", { value: proj.depth(best.c.x, best.c.y) + 0.05, enumerable: false });
        return hit;
      },
    };
    if (typeof scene.addMovers === "function") T.remove = scene.addMovers(T);
    return T;
  };
})();
