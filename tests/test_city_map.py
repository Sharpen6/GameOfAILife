"""The 80 x 50 map: its layout, places and the invariants the walk fields and the renderer rely on."""

from __future__ import annotations

import ast
import random
import time
import unittest
from collections import deque
from pathlib import Path

from gameofailife import town as town_module
from gameofailife.town import (BLOCK_H, BLOCK_W, BLOCK_X, BLOCK_Y, DISTRICT_NAMES, DISTRICTS, ENTRY, H, PARK,
                               RIVER_ROWS, ROAD, ROAD_COL_END, ROAD_COLS, ROAD_ROWS, STREETS, TREE, UNREACHABLE, W,
                               WALKABLE, WATER, build_map, street_of)

SEED = 1


def plain_bfs(town, start, goal):
    """Reference answer from the start's side: (steps, fewest off-road tiles on a shortest walk, one shortest
    route), counting tiles after the start; None when the goal is unreachable."""
    best = {start: (0, 0)}
    prev = {start: None}
    layer = [start]
    while layer and goal not in best:
        ahead = []
        for cur in layer:
            steps, off = best[cur]
            x, y = cur
            for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if not town.walkable(*nxt):
                    continue
                key = (steps + 1, off + (town.tiles[nxt[1]][nxt[0]] != ROAD))
                if nxt not in best:
                    best[nxt], prev[nxt] = key, cur
                    ahead.append(nxt)
                elif best[nxt][0] == key[0] and key[1] < best[nxt][1]:
                    best[nxt] = key
        layer = ahead
    if goal not in best:
        return None
    route, node = [], goal
    while node != start:
        route.append(node)
        node = prev[node]
    return best[goal][0], best[goal][1], route[::-1]


def off_road(town, tiles):
    return sum(town.tiles[y][x] != ROAD for x, y in tiles)


class LayoutTest(unittest.TestCase):
    def setUp(self):
        self.town = build_map(SEED)

    def test_map_is_80_by_50(self):
        self.assertEqual((self.town.w, self.town.h), (W, H))
        self.assertEqual((W, H), (80, 50))
        self.assertEqual([len(r) for r in self.town.rows()], [80] * 50)

    def test_build_map_is_memoized_and_shared(self):
        self.assertIs(build_map(SEED), self.town)
        self.assertIsNot(build_map(SEED + 1), self.town)

    def test_streets_river_and_riverbank(self):
        rows = self.town.rows()
        for y in ROAD_ROWS:
            self.assertEqual(rows[y], ROAD * W)
        for x in ROAD_COLS:
            self.assertTrue(all(rows[y][x] == ROAD for y in range(ROAD_COL_END + 1)))
        self.assertEqual(rows[ROAD_COL_END + 1].count(ROAD), 0)
        for y in RIVER_ROWS:
            self.assertEqual(rows[y], WATER * W)
        self.assertEqual(len(STREETS), len(ROAD_ROWS) + len(ROAD_COLS))

    def test_water_is_not_walkable(self):
        self.assertNotIn(WATER, WALKABLE)
        for y in RIVER_ROWS:
            for x in range(W):
                self.assertFalse(self.town.walkable(x, y))
        self.assertTrue(all(self.town.walkable(x, RIVER_ROWS[0] - 1) for x in range(W)))  # the riverbank
        self.assertEqual(self.town.walk_minutes((10, 47), "office"), UNREACHABLE)
        self.assertEqual(self.town.path(self.town.places["office"].entry, (10, 47)), [])

    def test_24_junctions_at_the_crossings(self):
        self.assertEqual(len(self.town.junctions), 24)
        self.assertEqual(self.town.junctions, {(x, y) for x in ROAD_COLS for y in ROAD_ROWS})

    def test_the_39_places_in_order(self):
        places = list(self.town.places.values())
        self.assertEqual(len(places), 39)
        groups = [("park" if p.kind == "park" else p.tier or "other") for p in places]
        order = ["other", "park", "flat", "house", "big_house"]
        self.assertEqual(groups, sorted(groups, key=order.index))
        self.assertEqual([groups.count(g) for g in order], [13, 4, 3, 15, 4])
        for pid in ("office", "school", "hospital", "market", "cafe", "park", "grocer", "works", "main_20", "park_78",
                    "birch_court"):
            self.assertIn(pid, self.town.places)

    def test_place_fields(self):
        for p in self.town.places.values():
            with self.subTest(place=p.id):
                self.assertEqual(set(p.to_json()), {"id", "name", "kind", "x", "y", "w", "h", "entry", "face", "hours",
                                                    "district", "style", "floors", "tier", "units"})
                if p.kind == "park":
                    self.assertEqual((p.face, p.floors, p.style, p.hours), (None, 0, "park", None))
                else:
                    self.assertIn(p.face, ("n", "s", "e", "w"))
                    self.assertGreater(p.floors, 0)
                if p.kind == "home":
                    self.assertIn(p.tier, ("flat", "house", "big_house"))
                    self.assertEqual(p.units, 6 if p.tier == "flat" else 1)
                    self.assertEqual(p.style, "apartments" if p.tier == "flat" else p.tier)
                else:
                    self.assertEqual((p.tier, p.units), (None, 0))
        self.assertEqual(self.town.places["noodles"].hours, (11, 24))
        self.assertTrue(self.town.places["noodles"].is_open(23.5))
        self.assertFalse(self.town.places["noodles"].is_open(10.9))

    def test_every_entry_touches_a_road(self):
        for p in self.town.places.values():
            ex, ey = p.entry
            with self.subTest(place=p.id):
                self.assertEqual(self.town.tiles[ey][ex], ENTRY)
                self.assertTrue(any(self.town.tiles[ey + dy][ex + dx] == ROAD
                                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))))

    def test_doors_face_their_entry(self):
        for p in self.town.places.values():
            if p.kind == "park":
                continue
            ex, ey = p.entry
            door = {"n": (ex, ey + 1), "s": (ex, ey - 1), "e": (ex - 1, ey), "w": (ex + 1, ey)}[p.face]
            self.assertEqual(self.town.tiles[door[1]][door[0]], "D", p.id)

    def test_every_district_is_known(self):
        self.assertEqual(len(DISTRICTS), 7)
        for p in self.town.places.values():
            self.assertIn(p.district, DISTRICT_NAMES, p.id)
        homes = {p.tier: p.district for p in self.town.places.values() if p.kind == "home"}
        self.assertEqual(homes, {"flat": "eastgate", "house": "maple_grove", "big_house": "hilltop"})
        self.assertEqual(self.town.places["office"].district, "downtown")
        self.assertEqual(self.town.places["works"].district, "the_works")
        self.assertEqual(self.town.places["park"].district, "riverside")

    def test_districts_cover_the_24_blocks_once(self):
        blocks = [b for _, _, _, bs in DISTRICTS for b in bs]
        self.assertEqual(sorted(blocks), sorted((c, r) for c in range(6) for r in range(4)))
        for c in range(6):
            self.assertEqual(BLOCK_X[c] + BLOCK_W[c], (ROAD_COLS[c + 1] if c < 5 else W))
        for r in range(4):
            self.assertEqual(BLOCK_Y[r] + BLOCK_H[r], (ROAD_ROWS[r + 1] if r < 3 else ROAD_COL_END + 1))

    def test_house_addresses(self):
        self.assertEqual(street_of(10, 24), ("Main Street", 20))
        self.assertEqual(street_of(6, 26), ("Main Street", 13))
        self.assertEqual(self.town.places["main_20"].name, "20 Main Street")
        self.assertEqual(self.town.places["park_78"].name, "78 Park Avenue")
        self.assertEqual(self.town.places["river_28"].entry, (14, 35))

    def test_trees_are_seeded_and_only_move_with_the_seed(self):
        other = build_map(2)
        self.assertNotEqual(self.town.rows(), other.rows())
        flat = lambda t: ["".join("." if c == TREE else c for c in r).replace(PARK, ".") for r in t.rows()]  # noqa: E731
        self.assertEqual(flat(self.town), flat(other))
        self.assertGreater(sum(r.count(TREE) for r in self.town.rows()), 100)
        for p in self.town.places.values():
            ex, ey = p.entry
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                self.assertNotEqual(self.town.tiles[ey + dy][ex + dx], TREE, p.id)

    def test_map_json(self):
        data = self.town.map_json()
        self.assertEqual((data["w"], data["h"], len(data["tiles"]), len(data["places"])), (80, 50, 50, 39))
        self.assertEqual(len(data["junctions"]), 24)
        self.assertEqual(data["junctions"][:2], [[3, 3], [16, 3]])
        self.assertEqual((data["road_rows"], data["road_cols"], data["road_col_end"]),
                         ([3, 14, 25, 36], [3, 16, 29, 42, 55, 68], 44))
        downtown = next(d for d in data["districts"] if d["id"] == "downtown")
        self.assertEqual(downtown["rects"], [[30, 15, 12, 10], [43, 15, 12, 10], [30, 26, 12, 10], [43, 26, 12, 10]])
        self.assertIn({"name": "Main Street", "axis": "row", "at": 25}, data["streets"])
        self.assertIn({"name": "Oak Street", "axis": "col", "at": 16}, data["streets"])

    def test_town_imports_neither_cast_nor_housing(self):
        tree = ast.parse(Path(town_module.__file__).read_text())
        imported = [(n.module or "") for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
        imported += [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
        for name in imported:
            self.assertNotIn("cast", name)
            self.assertNotIn("housing", name)


class WalkFieldTest(unittest.TestCase):
    def setUp(self):
        self.town = build_map(SEED)

    def test_every_place_reachable_from_every_home(self):
        homes = [p for p in self.town.places.values() if p.kind == "home"]
        self.assertEqual(len(homes), 22)
        for home in homes:
            for place in self.town.places.values():
                with self.subTest(home=home.id, place=place.id):
                    minutes = self.town.walk_minutes(home.entry, place.id)
                    self.assertLess(minutes, UNREACHABLE)
                    path = self.town.path(home.entry, place.entry)
                    self.assertEqual(len(path), minutes)
                    if path:
                        self.assertEqual(path[-1], place.entry)

    def test_path_contract(self):
        start = self.town.places["main_20"].entry
        goal = self.town.places["hospital"].entry
        path = self.town.path(start, goal)
        self.assertNotIn(start, path)
        self.assertEqual(path[-1], goal)
        prev = start
        for step in path:
            self.assertEqual(abs(step[0] - prev[0]) + abs(step[1] - prev[1]), 1)
            self.assertTrue(self.town.walkable(*step))
            prev = step
        self.assertEqual(self.town.path(goal, goal), [])
        self.assertEqual(self.town.walk_minutes(goal, "hospital"), 0)
        self.assertEqual(self.town.drive_path(start, "hospital"), path)

    def test_field_shape(self):
        dist, off = self.town.walk_field(self.town.places["cafe"].entry)
        self.assertEqual((dist.typecode, off.typecode, len(dist), len(off)), ("H", "H", W * H, W * H))
        self.assertIs(self.town.walk_field(self.town.places["cafe"].entry)[0], dist)
        g = self.town.places["cafe"].entry
        self.assertEqual((dist[g[1] * W + g[0]], off[g[1] * W + g[0]]), (0, 1))  # the entry is not a road tile
        road = (g[0], g[1] - 1)
        self.assertEqual(self.town.tiles[road[1]][road[0]], ROAD)
        self.assertEqual((dist[road[1] * W + road[0]], off[road[1] * W + road[0]]), (1, 1))
        building = (31, 28)
        self.assertEqual(dist[building[1] * W + building[0]], UNREACHABLE)

    def test_paths_equal_plain_bfs_on_200_seeded_pairs(self):
        rng = random.Random(4242)
        walkable = [(x, y) for y in range(H) for x in range(W) if self.town.walkable(x, y)]
        place_at = {p.entry: p.id for p in self.town.places.values()}
        goals = rng.sample(walkable, 20) + list(place_at)
        for _ in range(200):
            start, goal = rng.choice(walkable), rng.choice(goals)
            with self.subTest(start=start, goal=goal):
                path = self.town.path(start, goal)
                ref = plain_bfs(self.town, start, goal)
                if ref is None:
                    self.assertEqual(path, [])
                    continue
                steps, fewest_off, route = ref
                self.assertEqual(len(path), steps)
                self.assertEqual(off_road(self.town, path), fewest_off)
                self.assertLessEqual(off_road(self.town, path), off_road(self.town, route))
                if goal in place_at:
                    self.assertEqual(self.town.walk_minutes(start, place_at[goal]), steps)
                if path:
                    self.assertEqual(path[-1], goal)

    def test_walk_minutes_is_constant_time_after_warm(self):
        self.town.warm()
        fields = len(self.town._fields)
        self.assertGreaterEqual(fields, 39)
        places = list(self.town.places)
        starts = [p.entry for p in self.town.places.values()] + [(x, 25) for x in range(W)]
        t0 = time.perf_counter()
        total = 0
        for _ in range(4):
            for xy in starts:
                for pid in places:
                    total += self.town.walk_minutes(xy, pid)
        elapsed = time.perf_counter() - t0
        self.assertEqual(len(self.town._fields), fields)  # no field was built: every call was a lookup
        self.assertLess(elapsed, 0.5, f"{4 * len(starts) * len(places)} lookups took {elapsed:.3f} s")
        self.assertGreater(total, 0)


if __name__ == "__main__":
    unittest.main()
