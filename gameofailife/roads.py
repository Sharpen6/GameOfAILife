"""The road graph the townsfolk travel on (region.md 6.6): walking and driving on streets, highways by car.

Nodes are the STREET tiles ('#' road, 'b' road bridge, 'x' level crossing) that are not on a straight run, in tile
order, then the highway interchanges that are not already nodes. Edges are the straight street runs between two
nodes (walk WALK_T eighths of a minute a tile; drive CAR_T a tile + NODE_PEN) and the highway runs between
interchanges (cars only, HWY_T a tile + NODE_PEN). Every cost is an integer number of eighths of a minute and the
graph is undirected, so `minutes(a, b) == minutes(b, a)`.

An end is a place id (the trip starts or ends on the place's entry tile, one entry step from the road tile the
place attaches to: the entry's first STREET neighbour, E, W, S, N) or an (x, y) STREET tile (no entry step).

Caches: one Dijkstra tree per destination road tile and mode (`array('i')` dist and next hop, about 3 KB, the only
unbounded cache: at most two a place); the int minutes of every (a, b, mode) asked (cleared at MINUTES_CAP, a pure
cache, so clearing never changes an answer); and at most ROUTE_LRU Routes (`keep=False` skips that cache).

Ties are code, so the browser port finds the same routes: the start node is `min((cost, node index))` over the two
end nodes of the start tile's run, and the next hop is the smallest node index among equal-cost predecessors.
Nothing here draws dice or reads the simulation.
"""

from __future__ import annotations

import heapq
from array import array
from bisect import bisect_right
from collections import OrderedDict
from typing import Union

STREET = frozenset("#bx")  # region.STREET_CODES
WALK_T, CAR_T, HWY_T, NODE_PEN = 8, 2, 1, 4  # eighths of a minute: walk tile, street drive tile, highway tile, per edge
ROUTE_LRU, MINUTES_CAP = 4096, 200_000
INF = 1 << 30
DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))  # E, W, S, N: the order a place attaches to its road
End = Union[str, tuple]  # a place id, or an (x, y) STREET tile


class Route:
    """An immutable route: `pts` the corners from start to end, `cum` tiles and `t8` eighths of a minute to each
    corner, `tiles` and `minutes` (ceil of the eighths) in all."""

    __slots__ = ("mode", "pts", "cum", "t8", "tiles", "minutes")

    def __init__(self, mode: str, pts: tuple, seg_cost: list) -> None:
        cum, t8, d, t = [0], [0], 0, 0
        for i in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            d += abs(x1 - x0) + abs(y1 - y0)
            t += seg_cost[i]
            cum.append(d)
            t8.append(t)
        sets = object.__setattr__
        sets(self, "mode", mode)
        sets(self, "pts", pts)
        sets(self, "cum", tuple(cum))
        sets(self, "t8", tuple(t8))
        sets(self, "tiles", d)
        sets(self, "minutes", -(-t // 8))

    def __setattr__(self, name, value):
        raise AttributeError("Route is immutable")

    def at(self, m: float) -> tuple[int, int, str | None]:
        """(x, y, heading) m minutes after leaving: heading "e", "w", "s" or "n", None once arrived."""
        t = m * 8
        if t < 0:
            t = 0
        t8 = self.t8
        if t >= t8[-1]:
            x, y = self.pts[-1]
            return x, y, None
        i = bisect_right(t8, t) - 1
        (x0, y0), (x1, y1) = self.pts[i], self.pts[i + 1]
        span = t8[i + 1] - t8[i]
        k = int((t - t8[i]) * (abs(x1 - x0) + abs(y1 - y0)) / span) if span else 0
        dx, dy = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
        d = "e" if dx > 0 else "w" if dx < 0 else "s" if dy > 0 else "n"
        return x0 + dx * k, y0 + dy * k, d


class RoadNet:
    """The road graph of one map. `highways` are the highway edges ((x, y), (x, y)) between two interchanges."""

    def __init__(self, tiles, places, highways=(), interchanges=()) -> None:
        self.h, self.w = len(tiles), len(tiles[0])
        w, h = self.w, self.h
        self.places = places
        street = bytearray(w * h)
        for y, row in enumerate(tiles):
            for x, c in enumerate(row):
                if c in STREET:
                    street[y * w + x] = 1
        self.street = street
        node_of, nodes = {}, []
        for i in range(w * h):
            if not street[i]:
                continue
            x = i % w
            y = i // w
            e = x + 1 < w and street[i + 1]
            ww = x > 0 and street[i - 1]
            s = y + 1 < h and street[i + w]
            n = y > 0 and street[i - w]
            if not ((e and ww and not s and not n) or (s and n and not e and not ww)):
                node_of[i] = len(nodes)
                nodes.append(i)
        for x, y in interchanges:
            i = y * w + x
            if i not in node_of:
                node_of[i] = len(nodes)
                nodes.append(i)
        self.node_of, self.nodes = node_of, nodes
        adj = [[] for _ in nodes]  # node -> [(node, walk cost, drive cost)]
        edge_of = {}  # road tile -> (lo node, hi node, tiles to lo, tiles to hi); a node tile -> (k, k, 0, 0)
        for k, i in enumerate(nodes):
            x0, y0 = i % w, i // w
            for dx, dy in DIRS:
                x, y, d, run = x0, y0, 0, []
                while True:
                    x, y = x + dx, y + dy
                    if not (0 <= x < w and 0 <= y < h) or not street[y * w + x]:
                        break
                    d += 1
                    j = y * w + x
                    if j in node_of:
                        adj[k].append((node_of[j], d * WALK_T, d * CAR_T + NODE_PEN))
                        if k < node_of[j]:
                            for t, r in enumerate(run):
                                edge_of[r] = (k, node_of[j], t + 1, d - t - 1)
                        break
                    run.append(j)
        for (ax, ay), (bx, by) in highways:
            a, b = node_of[ay * w + ax], node_of[by * w + bx]
            d = abs(bx - ax) + abs(by - ay)
            adj[a].append((b, INF, d * HWY_T + NODE_PEN))
            adj[b].append((a, INF, d * HWY_T + NODE_PEN))
        for i in nodes:
            edge_of[i] = (node_of[i], node_of[i], 0, 0)
        self.adj, self.edge_of = adj, edge_of
        self._trees = {}  # (road tile, mode) -> (dist, next hop), array('i') each
        self._att = {}  # end -> (road tile, entry steps)
        self._mins = {}  # (a, b, mode) -> int minutes
        self._routes = OrderedDict()  # (a, b, mode) -> Route, at most ROUTE_LRU
        self.memo = {}  # what rail.py derives from this graph (station access, worst trips)

    # --- ends --------------------------------------------------------------------------------------------------
    def _end(self, a):
        """(road tile index, 1 if a is a place (one entry step) else 0)."""
        got = self._att.get(a)
        if got is not None:
            return got
        if isinstance(a, str):
            ex, ey = self.places[a].entry
            for dx, dy in DIRS:
                x, y = ex + dx, ey + dy
                if 0 <= x < self.w and 0 <= y < self.h and self.street[y * self.w + x]:
                    got = self._att[a] = (y * self.w + x, 1)
                    return got
            raise ValueError(f"{a} has no road")
        x, y = a
        i = y * self.w + x
        if not (0 <= x < self.w and 0 <= y < self.h) or not self.street[i]:
            raise ValueError(f"{a} is not a STREET tile")
        got = self._att[(x, y)] = (i, 0)
        return got

    def _entry(self, a):
        return tuple(self.places[a].entry) if isinstance(a, str) else None

    def _tree(self, road: int, mode: str):
        """Dijkstra from the road tile's run to every node: (dist, next hop toward the tile; -2 at a start node)."""
        key = (road, mode)
        got = self._trees.get(key)
        if got is not None:
            return got
        n = len(self.nodes)
        dist = array("i", [INF]) * n
        nxt = array("i", [-1]) * n
        lo, hi, dl, dh = self.edge_of[road]
        walk = mode == "walk"
        unit = WALK_T if walk else CAR_T
        pq = []
        for node, d in ((lo, dl), (hi, dh)):
            c = d * unit
            if c < dist[node]:
                dist[node] = c
                nxt[node] = -2
                heapq.heappush(pq, (c, node))
        adj = self.adj
        while pq:
            d, a = heapq.heappop(pq)
            if d > dist[a]:
                continue
            for b, cw, cd in adj[a]:
                nd = d + (cw if walk else cd)
                if nd < dist[b] or (nd == dist[b] and nxt[b] >= 0 and a < nxt[b]):
                    dist[b] = nd
                    nxt[b] = a
                    heapq.heappush(pq, (nd, b))
        got = self._trees[key] = (dist, nxt)
        return got

    def _start(self, ra: int, rb: int, mode: str) -> tuple[int, int]:
        """(eighths from road tile ra to rb, start node; -1 when both lie on one run): min((cost, node))."""
        unit = WALK_T if mode == "walk" else CAR_T
        A, B = self.edge_of[ra], self.edge_of[rb]
        if ra == rb or (A[0] == B[0] and A[1] == B[1]):
            return (abs(ra % self.w - rb % self.w) + abs(ra // self.w - rb // self.w)) * unit, -1
        dist = self._tree(rb, mode)[0]
        c0, c1 = A[2] * unit + dist[A[0]], A[3] * unit + dist[A[1]]
        return (c0, A[0]) if c0 <= c1 else (c1, A[1])  # equal cost: the lower node index (A[0] <= A[1])

    def minutes(self, a: End, b: End, mode: str = "walk") -> int:
        """Door-to-door minutes, ceil(eighths / 8), for mode "walk" or "car". Reads one tree (b's, or a's when only
        that one is built: equal by symmetry); never builds a Route."""
        if a.__class__ is list:
            a = tuple(a)
        if b.__class__ is list:
            b = tuple(b)
        key = (a, b, mode)
        got = self._mins.get(key)
        if got is not None:
            return got
        ra, sa = self._end(a)
        rb, sb = self._end(b)
        trees = self._trees
        if (rb, mode) not in trees and (ra, mode) in trees:
            ra, rb = rb, ra
        unit = WALK_T if mode == "walk" else CAR_T
        A, B = self.edge_of[ra], self.edge_of[rb]
        if ra == rb or (A[0] == B[0] and A[1] == B[1]):
            cost = (abs(ra % self.w - rb % self.w) + abs(ra // self.w - rb // self.w)) * unit
        else:
            dist = (trees.get((rb, mode)) or self._tree(rb, mode))[0]
            c0, c1 = A[2] * unit + dist[A[0]], A[3] * unit + dist[A[1]]
            cost = c0 if c0 <= c1 else c1
        got = -(-(cost + unit * (sa + sb)) // 8)
        if len(self._mins) >= MINUTES_CAP:
            self._mins.clear()
        self._mins[key] = got
        return got

    def route(self, a: End, b: End, mode: str = "walk", keep: bool = True) -> Route:
        """The Route from a to b: corners from a's entry (or tile) to b's. Kept in a ROUTE_LRU-entry LRU unless
        keep is False (folk pass False: their trip holds the Route)."""
        if a.__class__ is list:
            a = tuple(a)
        if b.__class__ is list:
            b = tuple(b)
        key = (a, b, mode)
        got = self._routes.get(key)
        if got is not None:
            self._routes.move_to_end(key)
            return got
        w = self.w
        unit = WALK_T if mode == "walk" else CAR_T
        ra, _ = self._end(a)
        rb, _ = self._end(b)
        ea, eb = self._entry(a), self._entry(b)
        pts, costs = [], []
        if ea is not None:
            pts.append(ea)
            costs.append(unit)
        pts.append((ra % w, ra // w))
        cost, start = self._start(ra, rb, mode)
        if start >= 0:
            dist, nxt = self._tree(rb, mode)
            node = start
            i = self.nodes[node]
            p = (i % w, i // w)
            costs.append((abs(p[0] - pts[-1][0]) + abs(p[1] - pts[-1][1])) * unit)
            pts.append(p)
            while nxt[node] >= 0:
                prev, node = node, nxt[node]
                i = self.nodes[node]
                pts.append((i % w, i // w))
                costs.append(dist[prev] - dist[node])
        q = (rb % w, rb // w)
        costs.append((abs(q[0] - pts[-1][0]) + abs(q[1] - pts[-1][1])) * unit)
        pts.append(q)
        if eb is not None:
            pts.append(eb)
            costs.append(unit)
        out_p, out_c = [pts[0]], []
        for p, c in zip(pts[1:], costs):
            if p == out_p[-1]:
                if out_c:
                    out_c[-1] += c
                continue
            out_p.append(p)
            out_c.append(c)
        r = Route(mode, tuple(out_p), out_c)
        if keep:
            self._routes[key] = r
            if len(self._routes) > ROUTE_LRU:
                self._routes.popitem(last=False)
        return r

    def nearby(self, a: End, kinds, mode: str = "walk", k: int = 3, max_minutes: int | None = None
               ) -> list[tuple[int, str]]:
        """The k nearest places of `kinds` from a (a itself excluded): [(minutes, id)], ties by id."""
        if a.__class__ is list:
            a = tuple(a)
        out = []
        for pid, p in self.places.items():
            if p.kind in kinds and pid != a:
                m = self.minutes(pid, a, mode)
                if max_minutes is None or m <= max_minutes:
                    out.append((m, pid))
        out.sort()
        return out[:k]


def roadnet(town) -> RoadNet:
    """The town's RoadNet, built once and kept in `town.memo["roadnet"]` (maps are shared and read-only)."""
    got = town.memo.get("roadnet")
    if got is None:
        got = town.memo["roadnet"] = RoadNet(town.tiles, town.places, getattr(town, "highway_edges", None) or (),
                                             getattr(town, "interchanges", None) or ())
    return got


net = roadnet  # folk.md's name
