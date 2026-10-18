// Port of gameofailife/roads.py: the road graph the townsfolk travel on (region.md 6.6): walking and driving on
// streets, highways by car.
//
// Nodes are the STREET tiles ('#' road, 'b' road bridge, 'x' level crossing) that are not on a straight run, in
// tile order, then the highway interchanges that are not already nodes. Edges are the straight street runs between
// two nodes (walk WALK_T eighths of a minute a tile; drive CAR_T a tile + NODE_PEN) and the highway runs between
// interchanges (cars only, HWY_T a tile + NODE_PEN). Every cost is an integer number of eighths of a minute and the
// graph is undirected, so `minutes(a, b) == minutes(b, a)`.
//
// An end is a place id (the trip starts or ends on the place's entry tile, one entry step from the road tile the
// place attaches to: the entry's first STREET neighbour, E, W, S, N) or an [x, y] STREET tile (no entry step).
//
// Caches: one Dijkstra tree per destination road tile and mode (Int32Array dist and next hop, the only unbounded
// cache); the int minutes of every (a, b, mode) asked (cleared at MINUTES_CAP); and at most ROUTE_LRU Routes in a
// Map LRU (`keep = false` skips it). Ties are code: the start node is min([cost, node index]) over the two end
// nodes of the start tile's run, and the next hop is the smallest node index among equal-cost predecessors.
(function (G) {
  "use strict";

  const STREET = new Set(["#", "b", "x"]); // region.STREET_CODES
  const WALK_T = 8, CAR_T = 2, HWY_T = 1, NODE_PEN = 4; // eighths of a minute
  const ROUTE_LRU = 4096, MINUTES_CAP = 200000;
  const INF = 1 << 30;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // E, W, S, N: the order a place attaches to its road

  const endKey = a => (typeof a === "string" ? a : `${a[0]},${a[1]}`);

  function bisect_right(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x < a[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // heapq on [cost, node] pairs, compared as Python tuples
  const less = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
  function heappush(h, item) {
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }
  function heappop(h) {
    const top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  // An immutable route: `pts` the corners from start to end, `cum` tiles and `t8` eighths of a minute to each
  // corner, `tiles` and `minutes` (ceil of the eighths) in all.
  class Route {
    constructor(mode, pts, seg_cost) {
      const cum = [0], t8 = [0];
      let d = 0, t = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        d += Math.abs(x1 - x0) + Math.abs(y1 - y0);
        t += seg_cost[i];
        cum.push(d);
        t8.push(t);
      }
      this.mode = mode;
      this.pts = pts;
      this.cum = cum;
      this.t8 = t8;
      this.tiles = d;
      this.minutes = Math.ceil(t / 8);
      Object.freeze(this);
    }

    // [x, y, heading] m minutes after leaving: heading "e", "w", "s" or "n", null once arrived.
    at(m) {
      let t = m * 8;
      if (t < 0) t = 0;
      const t8 = this.t8;
      if (t >= t8[t8.length - 1]) {
        const [x, y] = this.pts[this.pts.length - 1];
        return [x, y, null];
      }
      const i = bisect_right(t8, t) - 1;
      const [x0, y0] = this.pts[i], [x1, y1] = this.pts[i + 1];
      const span = t8[i + 1] - t8[i];
      const k = span ? Math.trunc((t - t8[i]) * (Math.abs(x1 - x0) + Math.abs(y1 - y0)) / span) : 0;
      const dx = (x1 > x0) - (x1 < x0), dy = (y1 > y0) - (y1 < y0);
      const d = dx > 0 ? "e" : dx < 0 ? "w" : dy > 0 ? "s" : "n";
      return [x0 + dx * k, y0 + dy * k, d];
    }
  }

  // The road graph of one map. `highways` are the highway edges [[x, y], [x, y]] between two interchanges.
  class RoadNet {
    constructor(tiles, places, highways = [], interchanges = []) {
      this.h = tiles.length;
      this.w = tiles[0].length;
      const w = this.w, h = this.h;
      this.places = places;
      const street = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const row = tiles[y];
        for (let x = 0; x < w; x++) if (STREET.has(row[x])) street[y * w + x] = 1;
      }
      this.street = street;
      const node_of = new Map(), nodes = [];
      for (let i = 0; i < w * h; i++) {
        if (!street[i]) continue;
        const x = i % w, y = Math.floor(i / w);
        const e = x + 1 < w && street[i + 1];
        const ww = x > 0 && street[i - 1];
        const s = y + 1 < h && street[i + w];
        const n = y > 0 && street[i - w];
        if (!((e && ww && !s && !n) || (s && n && !e && !ww))) {
          node_of.set(i, nodes.length);
          nodes.push(i);
        }
      }
      for (const [x, y] of interchanges) {
        const i = y * w + x;
        if (!node_of.has(i)) {
          node_of.set(i, nodes.length);
          nodes.push(i);
        }
      }
      this.node_of = node_of;
      this.nodes = nodes;
      const adj = nodes.map(() => []); // node -> [[node, walk cost, drive cost]]
      const edge_of = new Map(); // road tile -> [lo node, hi node, tiles to lo, tiles to hi]; a node -> [k, k, 0, 0]
      for (let k = 0; k < nodes.length; k++) {
        const i = nodes[k];
        const x0 = i % w, y0 = Math.floor(i / w);
        for (const [dx, dy] of DIRS) {
          let x = x0, y = y0, d = 0;
          const run = [];
          for (;;) {
            x += dx;
            y += dy;
            if (!(0 <= x && x < w && 0 <= y && y < h) || !street[y * w + x]) break;
            d += 1;
            const j = y * w + x;
            if (node_of.has(j)) {
              const nj = node_of.get(j);
              adj[k].push([nj, d * WALK_T, d * CAR_T + NODE_PEN]);
              if (k < nj) run.forEach((r, t) => edge_of.set(r, [k, nj, t + 1, d - t - 1]));
              break;
            }
            run.push(j);
          }
        }
      }
      for (const [[ax, ay], [bx, by]] of highways) {
        const a = node_of.get(ay * w + ax), b = node_of.get(by * w + bx);
        if (a === undefined || b === undefined) throw new Error(`highway end ${ax},${ay} or ${bx},${by} is no node`);
        const d = Math.abs(bx - ax) + Math.abs(by - ay);
        adj[a].push([b, INF, d * HWY_T + NODE_PEN]);
        adj[b].push([a, INF, d * HWY_T + NODE_PEN]);
      }
      for (const i of nodes) edge_of.set(i, [node_of.get(i), node_of.get(i), 0, 0]);
      this.adj = adj;
      this.edge_of = edge_of;
      this._trees = new Map(); // road tile * 2 + (car ? 1 : 0) -> [dist, next hop]
      this._att = new Map(); // end key -> [road tile, entry steps]
      this._mins = new Map(); // "a|b|mode" -> int minutes
      this._routes = new Map(); // "a|b|mode" -> Route, at most ROUTE_LRU, oldest first
      this.memo = new Map(); // what rail.js derives from this graph (station access, worst trips)
    }

    // --- ends ---------------------------------------------------------------------------------------------
    // [road tile index, 1 if a is a place (one entry step) else 0]
    _end(a) {
      const key = endKey(a);
      let got = this._att.get(key);
      if (got !== undefined) return got;
      if (typeof a === "string") {
        const place = this.places.get(a);
        if (place === undefined) throw new Error(`${a} is no place`);
        const [ex, ey] = place.entry;
        for (const [dx, dy] of DIRS) {
          const x = ex + dx, y = ey + dy;
          if (0 <= x && x < this.w && 0 <= y && y < this.h && this.street[y * this.w + x]) {
            got = [y * this.w + x, 1];
            this._att.set(key, got);
            return got;
          }
        }
        throw new Error(`${a} has no road`);
      }
      const [x, y] = a;
      const i = y * this.w + x;
      if (!(0 <= x && x < this.w && 0 <= y && y < this.h) || !this.street[i]) {
        throw new Error(`${x},${y} is not a STREET tile`);
      }
      got = [i, 0];
      this._att.set(key, got);
      return got;
    }

    _entry(a) {
      return typeof a === "string" ? [this.places.get(a).entry[0], this.places.get(a).entry[1]] : null;
    }

    // Dijkstra from the road tile's run to every node: [dist, next hop toward the tile; -2 at a start node].
    _tree(road, mode) {
      const walk = mode === "walk";
      const key = road * 2 + (walk ? 0 : 1);
      let got = this._trees.get(key);
      if (got !== undefined) return got;
      const n = this.nodes.length;
      const dist = new Int32Array(n).fill(INF);
      const nxt = new Int32Array(n).fill(-1);
      const [lo, hi, dl, dh] = this.edge_of.get(road);
      const unit = walk ? WALK_T : CAR_T;
      const pq = [];
      for (const [node, d] of [[lo, dl], [hi, dh]]) {
        const c = d * unit;
        if (c < dist[node]) {
          dist[node] = c;
          nxt[node] = -2;
          heappush(pq, [c, node]);
        }
      }
      const adj = this.adj;
      while (pq.length) {
        const [d, a] = heappop(pq);
        if (d > dist[a]) continue;
        for (const [b, cw, cd] of adj[a]) {
          const nd = d + (walk ? cw : cd);
          if (nd < dist[b] || (nd === dist[b] && nxt[b] >= 0 && a < nxt[b])) {
            dist[b] = nd;
            nxt[b] = a;
            heappush(pq, [nd, b]);
          }
        }
      }
      got = [dist, nxt];
      this._trees.set(key, got);
      return got;
    }

    _has_tree(road, mode) { return this._trees.has(road * 2 + (mode === "walk" ? 0 : 1)); }

    // Build the trees toward every place in `places` (ids), walking and driving: a pure cache fill (which tree
    // `minutes` reads never changes its answer), so no trip pays for a tree (about 0.4 ms each) on a busy tick.
    warm(places) {
      for (const pid of places) {
        const road = this._end(pid)[0];
        this._tree(road, "walk");
        this._tree(road, "car");
      }
    }

    // [eighths from road tile ra to rb, start node; -1 when both lie on one run]: min([cost, node])
    _start(ra, rb, mode) {
      const unit = mode === "walk" ? WALK_T : CAR_T;
      const A = this.edge_of.get(ra), B = this.edge_of.get(rb);
      const w = this.w;
      if (ra === rb || (A[0] === B[0] && A[1] === B[1])) {
        return [(Math.abs((ra % w) - (rb % w)) + Math.abs(Math.floor(ra / w) - Math.floor(rb / w))) * unit, -1];
      }
      const dist = this._tree(rb, mode)[0];
      const c0 = A[2] * unit + dist[A[0]], c1 = A[3] * unit + dist[A[1]];
      return c0 <= c1 ? [c0, A[0]] : [c1, A[1]]; // equal cost: the lower node index
    }

    // Door-to-door minutes, ceil(eighths / 8), for mode "walk" or "car"; never builds a Route.
    minutes(a, b, mode = "walk") {
      const key = `${endKey(a)}|${endKey(b)}|${mode}`;
      let got = this._mins.get(key);
      if (got !== undefined) return got;
      let [ra, sa] = this._end(a);
      let [rb, sb] = this._end(b);
      if (!this._has_tree(rb, mode) && this._has_tree(ra, mode)) [ra, rb] = [rb, ra];
      const unit = mode === "walk" ? WALK_T : CAR_T;
      const A = this.edge_of.get(ra), B = this.edge_of.get(rb);
      const w = this.w;
      let cost;
      if (ra === rb || (A[0] === B[0] && A[1] === B[1])) {
        cost = (Math.abs((ra % w) - (rb % w)) + Math.abs(Math.floor(ra / w) - Math.floor(rb / w))) * unit;
      } else {
        const dist = this._tree(rb, mode)[0];
        const c0 = A[2] * unit + dist[A[0]], c1 = A[3] * unit + dist[A[1]];
        cost = c0 <= c1 ? c0 : c1;
      }
      got = Math.ceil((cost + unit * (sa + sb)) / 8);
      if (this._mins.size >= MINUTES_CAP) this._mins.clear();
      this._mins.set(key, got);
      return got;
    }

    // The Route from a to b: corners from a's entry (or tile) to b's. Kept in a ROUTE_LRU-entry LRU unless keep
    // is false (folk pass false: their trip holds the Route).
    route(a, b, mode = "walk", keep = true) {
      const key = `${endKey(a)}|${endKey(b)}|${mode}`;
      let got = this._routes.get(key);
      if (got !== undefined) {
        this._routes.delete(key);
        this._routes.set(key, got);
        return got;
      }
      const w = this.w;
      const unit = mode === "walk" ? WALK_T : CAR_T;
      const [ra] = this._end(a);
      const [rb] = this._end(b);
      const ea = this._entry(a), eb = this._entry(b);
      const pts = [], costs = [];
      if (ea !== null) {
        pts.push(ea);
        costs.push(unit);
      }
      pts.push([ra % w, Math.floor(ra / w)]);
      const [, start] = this._start(ra, rb, mode);
      if (start >= 0) {
        const [dist, nxt] = this._tree(rb, mode);
        let node = start;
        let i = this.nodes[node];
        const p = [i % w, Math.floor(i / w)];
        const last = pts[pts.length - 1];
        costs.push((Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1])) * unit);
        pts.push(p);
        while (nxt[node] >= 0) {
          const prev = node;
          node = nxt[node];
          i = this.nodes[node];
          pts.push([i % w, Math.floor(i / w)]);
          costs.push(dist[prev] - dist[node]);
        }
      }
      const q = [rb % w, Math.floor(rb / w)];
      const last = pts[pts.length - 1];
      costs.push((Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1])) * unit);
      pts.push(q);
      if (eb !== null) {
        pts.push(eb);
        costs.push(unit);
      }
      const out_p = [pts[0]], out_c = [];
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j], c = costs[j - 1], o = out_p[out_p.length - 1];
        if (p[0] === o[0] && p[1] === o[1]) {
          if (out_c.length) out_c[out_c.length - 1] += c;
          continue;
        }
        out_p.push(p);
        out_c.push(c);
      }
      const r = new Route(mode, out_p, out_c);
      if (keep) {
        this._routes.set(key, r);
        if (this._routes.size > ROUTE_LRU) this._routes.delete(this._routes.keys().next().value);
      }
      return r;
    }

    // The k nearest places of `kinds` from a (a itself excluded): [[minutes, id]], ties by id.
    nearby(a, kinds, mode = "walk", k = 3, max_minutes = null) {
      const want = typeof kinds === "string" ? new Set([kinds]) : new Set(kinds);
      const out = [];
      for (const [pid, p] of this.places) {
        if (want.has(p.kind) && pid !== a) {
          const m = this.minutes(pid, a, mode);
          if (max_minutes === null || max_minutes === undefined || m <= max_minutes) out.push([m, pid]);
        }
      }
      out.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
      return out.slice(0, k);
    }
  }

  // The town's RoadNet, built once and kept in town.memo "roadnet" (maps are shared and read-only).
  function roadnet(town) {
    let got = town.memo.get("roadnet");
    if (got === undefined) {
      got = new RoadNet(town.tiles, town.places, town.highway_edges || [], town.interchanges || []);
      town.memo.set("roadnet", got);
    }
    return got;
  }

  G.roads = {
    STREET, WALK_T, CAR_T, HWY_T, NODE_PEN, ROUTE_LRU, MINUTES_CAP, INF, DIRS, Route, RoadNet, roadnet,
    net: roadnet, endKey,
  };
})(globalThis.GameOfAILife || (globalThis.GameOfAILife = {}));
