"""The townsfolk's road graph (gameofailife/roads.py, region.md 6.6 and 11 R2 1-3).

`region_town()` and `pairs()` are shared with tests/test_rail.py and tests/test_rail_contract.py.
"""

from __future__ import annotations

import math
import os
import time
import tracemalloc
import unittest
from collections import deque

from gameofailife import region, roads
from gameofailife import town as T

WALK_CODES = set(".#PebxF")


def region_town():
    """The seed-1 region map (shared and read-only)."""
    return region.build_region(1)


def pairs(town, n: int) -> list[tuple[str, str]]:
    """n (home, destination) pairs, strided over the places in order (parity_rail.cjs makes the same ones)."""
    homes = [pid for pid, p in town.places.items() if p.kind == "home"]
    dest = [pid for pid, p in town.places.items() if p.kind not in ("home", "park")]
    return [(homes[(i * 37 + 11) % len(homes)], dest[(i * 53 + 7) % len(dest)]) for i in range(n)]


def tile_walk(town, goal) -> dict:
    """Minutes on foot (a tile a minute over WALK_CODES and the goal) from every tile to `goal`, 4-neighbour BFS."""
    w, h = len(town.tiles[0]), len(town.tiles)
    dist = {goal: 0}
    q = deque([goal])
    while q:
        x, y = q.popleft()
        d = dist[(x, y)] + 1
        for dx, dy in roads.DIRS:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in dist and town.tiles[ny][nx] in WALK_CODES:
                dist[(nx, ny)] = d
                q.append((nx, ny))
    return dist


class RoadNetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = region_town()
        cls.net = roads.roadnet(cls.town)
        cls.pairs = pairs(cls.town, 300)

    def test_memoized_on_the_town(self):
        self.assertIs(roads.roadnet(self.town), self.net)
        self.assertIs(roads.net, roads.roadnet)
        self.assertIs(self.town.memo["roadnet"], self.net)

    def test_node_count(self):
        n = len(self.net.nodes)
        self.assertTrue(330 <= n <= 420, n)
        w, h, st = self.net.w, self.net.h, self.net.street

        def straight(i):
            x, y = i % w, i // w
            e, ww = x + 1 < w and st[i + 1], x > 0 and st[i - 1]
            s, nn = y + 1 < h and st[i + w], y > 0 and st[i - w]
            return (e and ww and not s and not nn) or (s and nn and not e and not ww)

        natural = [i for i in range(w * h) if st[i] and not straight(i)]
        self.assertEqual(self.net.nodes[:len(natural)], natural)  # street nodes in tile order, then interchanges
        inter = {y * w + x for x, y in self.town.interchanges}
        self.assertTrue(set(self.net.nodes[len(natural):]) <= inter)

    def test_routes_on_streets(self):
        hwy = set("Hh")
        inter = set(self.town.interchanges)
        for i, (a, b) in enumerate(self.pairs):
            mode = "car" if i % 3 == 0 else "walk"
            r = self.net.route(a, b, mode, keep=False)
            self.assertEqual(r.pts[0], tuple(self.town.places[a].entry))
            self.assertEqual(r.pts[-1], tuple(self.town.places[b].entry))
            for j, ((x0, y0), (x1, y1)) in enumerate(zip(r.pts, r.pts[1:])):
                self.assertTrue(x0 == x1 or y0 == y1, (a, b, r.pts))
                dx, dy = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
                x, y = x0, y0
                while (x, y) != (x1, y1):
                    x, y = x + dx, y + dy
                    if (j == 0 or j == len(r.pts) - 2) and (x, y) in (r.pts[0], r.pts[-1]):
                        continue  # the entry steps
                    c = self.town.tiles[y][x]
                    ok = c in roads.STREET or (mode == "car" and (c in hwy or (x, y) in inter))
                    self.assertTrue(ok, (a, b, mode, (x, y), c))
            m = self.net.minutes(a, b, mode)
            self.assertEqual(m, math.ceil(r.t8[-1] / 8))
            self.assertEqual(m, r.minutes)
            self.assertEqual(m, self.net.minutes(b, a, mode))
            self.assertLessEqual(self.net.minutes(a, b, "car"), self.net.minutes(a, b, "walk"))

    def test_road_walk_against_tile_walk(self):
        by_dest = {}
        for a, b in self.pairs:
            by_dest.setdefault(b, []).append(a)
        worst, worst_long = 0.0, 0.0
        for b in list(by_dest)[:40]:
            field = tile_walk(self.town, tuple(self.town.places[b].entry))
            for a in by_dest[b]:
                tw = field.get(tuple(self.town.places[a].entry))
                if not tw:
                    continue
                ratio = self.net.minutes(a, b, "walk") / tw
                worst = max(worst, ratio)
                if tw >= 20:
                    worst_long = max(worst_long, ratio)
        self.assertLessEqual(worst, 1.5)
        self.assertLessEqual(worst_long, 1.3)

    def test_route_at_monotonic(self):
        for i, (a, b) in enumerate(self.pairs[:100]):
            r = self.net.route(a, b, "car" if i % 3 == 0 else "walk", keep=False)
            path = [r.pts[0]]
            for (x0, y0), (x1, y1) in zip(r.pts, r.pts[1:]):
                dx, dy = (x1 > x0) - (x1 < x0), (y1 > y0) - (y1 < y0)
                x, y = x0, y0
                while (x, y) != (x1, y1):
                    x, y = x + dx, y + dy
                    path.append((x, y))
            self.assertEqual(len(path) - 1, r.tiles)
            done = 0
            for k in range(0, 8 * r.minutes + 9):
                x, y, d = r.at(k / 8)
                done = path.index((x, y), done)  # raises if the tile is not on the path at or after the last one
            self.assertEqual(r.at(r.minutes + 1), (*r.pts[-1], None))
            self.assertEqual(r.at(0)[:2], r.pts[0])
            self.assertEqual(r.at(-0.5), r.at(0))

    def test_route_at_one_point(self):
        """A route from a street tile to itself is one point: at(m) is that point, arrived, for every m, before 0
        too."""
        w = self.net.w
        for a, _ in self.pairs[:20]:
            ra = self.net._end(a)[0]
            tile = (ra % w, ra // w)
            for mode in ("walk", "car"):
                r = self.net.route(tile, tile, mode, keep=False)
                self.assertEqual((len(r.pts), r.tiles, r.minutes), (1, 0, 0))
                for m in (-3, -0.5, 0, 0.5, 10):
                    self.assertEqual(r.at(m), (*r.pts[0], None))

    def test_route_lru_and_keep(self):
        net = roads.RoadNet(self.town.tiles, self.town.places, self.town.highway_edges, self.town.interchanges)
        a, b = self.pairs[0]
        r = net.route(a, b)
        self.assertIs(net.route(a, b), r)
        net.route(a, self.pairs[1][1], keep=False)
        self.assertEqual(len(net._routes), 1)
        with self.assertRaises(AttributeError):
            r.minutes = 3
        homes = [p for p, q in self.town.places.items() if q.kind == "home"]
        for h in homes[:120]:
            for c in [p for p, q in self.town.places.items() if q.kind == "cafe"][:70]:
                net.route(h, c)
        self.assertEqual(len(net._routes), roads.ROUTE_LRU)

    def test_street_tile_ends_and_nearby(self):
        a = self.pairs[5][0]
        rows = self.net.nearby(a, ("cafe", "shop"), k=4)
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows, sorted(rows))
        self.assertTrue(all(self.town.places[p].kind in ("cafe", "shop") for _, p in rows))
        allc = sorted((self.net.minutes(p, a), p) for p, q in self.town.places.items() if q.kind in ("cafe", "shop"))
        self.assertEqual(rows, allc[:4])
        capped = self.net.nearby(a, ("cafe",), k=50, max_minutes=10)
        self.assertTrue(all(m <= 10 for m, _ in capped))
        exit_tile = (127, 73)  # Central's south exit, a STREET tile: no entry step
        self.assertEqual(self.net.minutes(exit_tile, exit_tile), 0)
        self.assertEqual(self.net.route(exit_tile, a).pts[0], exit_tile)
        with self.assertRaises(ValueError):
            self.net.minutes((0, 0), a)

    def test_minutes_memory_and_speed(self):
        net = roads.RoadNet(self.town.tiles, self.town.places, self.town.highway_edges, self.town.interchanges)
        homes = [p for p, q in self.town.places.items() if q.kind == "home"]
        dest = [p for p, q in self.town.places.items() if q.kind not in ("home", "park")]
        for b in dest:
            for mode in ("walk", "car"):
                net._tree(net._end(b)[0], mode)
        for a in homes:
            net._end(a)
        calls = [(homes[(i * 7) % len(homes)], dest[(i * 13 + i // len(homes)) % len(dest)],
                  "car" if i % 2 else "walk") for i in range(50_000)]
        tracemalloc.start()
        m0 = tracemalloc.get_traced_memory()[0]
        for a, b, mode in calls:
            net.minutes(a, b, mode)
        m1 = tracemalloc.get_traced_memory()[0]
        tracemalloc.stop()
        self.assertLess(m1 - m0, 10_000_000)
        c = time.process_time()
        for a, b, mode in calls:
            net.minutes(a, b, mode)
        hit = (time.process_time() - c) / len(calls)
        self.assertLess(hit, 20e-6, f"minutes() hit {hit * 1e6:.2f} us, load {os.getloadavg()[0]:.1f}")

    def test_millbrook_net(self):
        mb = T.build_map(1)
        net = roads.RoadNet(mb.tiles, mb.places)
        self.assertGreater(len(net.nodes), 20)
        ids = [p for p, q in mb.places.items() if q.kind != "park"]
        self.assertGreater(net.minutes(ids[0], ids[-1]), 0)
        self.assertEqual(net.minutes(ids[0], ids[-1]), net.route(ids[0], ids[-1]).minutes)


if __name__ == "__main__":
    unittest.main()
