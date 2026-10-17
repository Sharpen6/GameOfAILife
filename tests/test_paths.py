"""Road fields and drive paths on the 80 x 50 map, warm(), and the walk fields they must never change."""

from __future__ import annotations

import hashlib
import json
import random
import time
import unittest
from collections import deque
from pathlib import Path

from gameofailife import housing, transit
from gameofailife.town import H, ROAD, UNREACHABLE, W, TownMap, build_map

SEED = 1
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "city_seed1.json"

# Minutes on foot from each commuter's home entry to their job or school on seed 1, as P0 built them. The golden
# file pins who lives and works where; this pins the walk between them (the walk fields, never changed by P1).
GOLDEN_WALKS = {
    "dana": 25, "yossi": 39, "noa": 21, "tom": 21, "ari": 35, "avi": 27, "rina": 45, "lior": 27, "maya": 27,
    "eli": 15, "shira": 27, "omer": 34, "gal": 34, "yael": 24, "nadia": 19, "sami": 23, "leila": 23, "omar": 26,
    "noga": 15, "tamar": 21, "yoni": 39, "efrat": 21, "amir": 21, "sivan": 15, "karim": 15, "gil": 31, "mor": 15,
    "tomer": 45, "neta": 15, "boaz": 45, "hila": 31, "oren": 20, "sara": 24, "lina": 24, "ziv": 20, "ido": 34,
    "rotem": 28, "erez": 28, "yarden": 28, "merav": 21, "nir": 26, "itai": 20, "dalia": 21, "ben": 21, "noam": 25,
    "ronit": 32, "amira": 32, "avigail": 21, "yaniv": 10, "shai": 20, "adi": 19, "hana": 26, "inbal": 26,
}
# sha1 over every place entry's walk field (place id, dist bytes, off bytes) in town.places order, over every
# place-to-place path(), and over the bus stops' walk fields, all taken on P0's town.py before P1 touched it.
FIELDS_SHA1 = "589983c27e78a46ad97c392ba875fb38e46a658a"
PATHS_SHA1 = "bd34d796971c054905390ba875674b006646021e"
STOP_FIELDS_SHA1 = "8261e79c4728e50575195842b190172daae2919e"

E_W_S_N = ((1, 0), (-1, 0), (0, 1), (0, -1))


def fresh_map(seed: int = SEED) -> TownMap:
    """A new TownMap of the same town with empty caches (build_map's map is shared and may be warm already)."""
    town = build_map(seed)
    return TownMap([row[:] for row in town.tiles], dict(town.places))


def is_road(town: TownMap, xy: tuple[int, int]) -> bool:
    x, y = xy
    return 0 <= x < town.w and 0 <= y < town.h and town.tiles[y][x] == ROAD


def plain_road_distances(town: TownMap, goal: tuple[int, int]) -> dict[tuple[int, int], int]:
    """Reference road field: steps from each road tile to `goal` moving over road tiles, the last step onto goal."""
    dist = {goal: 0}
    queue = deque([goal])
    while queue:
        x, y = queue.popleft()
        for dx, dy in E_W_S_N:
            nxt = (x + dx, y + dy)
            if nxt not in dist and is_road(town, nxt):
                dist[nxt] = dist[x, y] + 1
                queue.append(nxt)
    return dist


def shortest_drive(town: TownMap, start: tuple[int, int], goal: tuple[int, int]) -> int | None:
    """Reference drive length: onto the best neighbouring road tile (or from the road tile itself) and along."""
    dist = plain_road_distances(town, goal)
    if start == goal:
        return 0
    if is_road(town, start):
        return dist.get(start)
    near = [dist[(start[0] + dx, start[1] + dy)] for dx, dy in E_W_S_N if (start[0] + dx, start[1] + dy) in dist
            and is_road(town, (start[0] + dx, start[1] + dy))]
    return 1 + min(near) if near else None


class RoadFieldTest(unittest.TestCase):
    def setUp(self):
        self.town = build_map(SEED)

    def test_road_field_shape(self):
        entry = self.town.places["cafe"].entry
        dist = self.town.road_field(entry)
        self.assertEqual((dist.typecode, len(dist)), ("H", W * H))
        self.assertIs(self.town.road_field(entry), dist)  # cached per goal tile
        self.assertEqual(dist[entry[1] * W + entry[0]], 0)
        road = (entry[0], entry[1] - 1)  # Corner Cafe faces north onto Main Street
        self.assertTrue(is_road(self.town, road))
        self.assertEqual(dist[road[1] * W + road[0]], 1)
        for i, d in enumerate(dist):
            xy = (i % W, i // W)
            if xy != entry and not is_road(self.town, xy):
                self.assertEqual(d, UNREACHABLE, xy)
        self.assertEqual(set(self.town.road_field((W, 0))), {UNREACHABLE})  # off the map

    def test_road_field_lengths_are_correct(self):
        for place in self.town.places.values():
            with self.subTest(place=place.id):
                ref = plain_road_distances(self.town, place.entry)
                dist = self.town.road_field(place.entry)
                got = {(i % W, i // W): d for i, d in enumerate(dist) if d != UNREACHABLE}
                self.assertEqual(got, ref)
                self.assertTrue(any(d == 1 for d in got.values()), "every entry touches a road")

    def assert_drive(self, start: tuple[int, int], place_id: str) -> list[tuple[int, int]]:
        goal = self.town.places[place_id].entry
        path = self.town.drive_path(start, place_id)
        self.assertEqual(len(path), shortest_drive(self.town, start, goal))
        if not path:
            self.assertEqual(start, goal)
            return path
        self.assertNotIn(start, path)
        self.assertEqual(path[-1], goal)
        prev = start
        for step in path:
            self.assertEqual(abs(step[0] - prev[0]) + abs(step[1] - prev[1]), 1, (start, place_id, step))
            self.assertTrue(self.town.walkable(*step))
            prev = step
        # Roads only, apart from the first step (from the start onto the road) and the last (onto the entry):
        # every tile but the entry is a road tile.
        for step in path[:-1]:
            self.assertTrue(is_road(self.town, step), (start, place_id, step))
        return path

    def test_drive_paths_stay_on_the_roads_between_every_pair_of_places(self):
        for a in self.town.places.values():
            for b in self.town.places.values():
                with self.subTest(start=a.id, place=b.id):
                    path = self.assert_drive(a.entry, b.id)
                    if a is not b:
                        self.assertTrue(path and is_road(self.town, path[0]), "the first step is onto the road")

    def test_drive_paths_from_road_and_roadside_tiles(self):
        rng = random.Random(1717)
        roads = [(x, y) for y in range(H) for x in range(W) if is_road(self.town, (x, y))]
        roadside = [(x, y) for y in range(H) for x in range(W)
                    if self.town.walkable(x, y) and not is_road(self.town, (x, y))
                    and any(is_road(self.town, (x + dx, y + dy)) for dx, dy in E_W_S_N)]
        places = list(self.town.places)
        for start in rng.sample(roads, 60) + rng.sample(roadside, 60):
            place_id = rng.choice(places)
            with self.subTest(start=start, place=place_id):
                self.assert_drive(start, place_id)

    def test_drive_path_ties_go_east_west_south_north(self):
        # From the corner (3, 25) to Brightline Tech every shortest road route runs along Main Street: east first.
        path = self.town.drive_path((3, 25), "office")
        self.assertEqual(path[0], (4, 25))
        self.assertEqual(path[-2:], [(35, 25), (35, 24)])

    def test_drive_path_example_main_20_to_the_hospital(self):
        start = self.town.places["main_20"].entry
        walk = self.town.path(start, self.town.places["hospital"].entry)
        drive = self.town.drive_path(start, "hospital")
        self.assertEqual(len(walk), 39)  # straight along the lawns north of Main Street
        self.assertEqual(sum(not is_road(self.town, t) for t in walk), 36)
        self.assertEqual(len(drive), 41)  # onto Main Street, 39 tiles east, off at the hospital door
        self.assertEqual((drive[0], drive[-2], drive[-1]), ((10, 25), (49, 25), (49, 24)))
        self.assertEqual(self.town.drive_length(start, "hospital"), (41, 3))  # crossings at x 16, 29 and 42

    def test_drive_path_away_from_the_roads_walks(self):
        park = self.town.places["park"]
        inside = [(x, y) for y in range(park.y + 2, park.y + park.h - 2)
                  for x in range(park.x + 2, park.x + park.w - 2) if self.town.walkable(x, y)]
        self.assertTrue(inside)
        hospital = self.town.places["hospital"].entry
        for start in inside[:10]:
            self.assertEqual(self.town.drive_path(start, "hospital"), self.town.path(start, hospital))

    def test_drive_path_edges(self):
        entry = self.town.places["school"].entry
        self.assertEqual(self.town.drive_path(entry, "school"), [])
        self.assertEqual(self.town.drive_path(list(entry), "school"), [])
        self.assertEqual(self.town.drive_length(entry, "school"), (0, 0))
        self.assertEqual(self.town.drive_length(list(entry), "school"), (0, 0))
        self.assertEqual(self.town.drive_path((-1, 5), "school"), [])
        self.assertEqual(self.town.drive_length((31, 28), "school"), (UNREACHABLE, 0))  # inside a building
        with self.assertRaises(KeyError):
            self.town.drive_path(entry, "nowhere")

    def test_drive_length_counts_tiles_and_junctions(self):
        for a in list(self.town.places.values())[::3]:
            for b in self.town.places.values():
                path = self.town.drive_path(a.entry, b.id)
                want = (len(path), sum(t in self.town.junctions for t in path))
                self.assertEqual(self.town.drive_length(a.entry, b.id), want)
                self.assertEqual(self.town.drive_length(list(a.entry), b.id), want)


class WalkFieldsUnchangedTest(unittest.TestCase):
    """P1 adds road fields; the walk fields, their lengths and tie-breaks stay exactly as P0 built them."""

    def test_walk_lengths_match_the_golden_city(self):
        golden = json.loads(FIXTURE.read_text())
        town = build_map(SEED)
        self.assertEqual(hashlib.sha1("\n".join(town.rows()).encode()).hexdigest(), golden["tiles_sha1"])
        homes = housing.build_homes(town)
        walks = {p["id"]: town.walk_minutes(town.places[homes[p["home"]].place].entry, p["job_place"])
                 for p in golden["people"] if p["job_place"]}
        self.assertEqual(walks, GOLDEN_WALKS)

    def test_walk_fields_and_paths_are_pinned(self):
        for town in (fresh_map(), build_map(SEED)):
            fields = hashlib.sha1()
            for pid, place in town.places.items():
                dist, off = town.walk_field(place.entry)
                fields.update(pid.encode())
                fields.update(dist.tobytes())
                fields.update(off.tobytes())
            self.assertEqual(fields.hexdigest(), FIELDS_SHA1)
            stops = hashlib.sha1()
            for sid, xy in transit.STOP_XY.items():
                dist, off = town.walk_field(xy)
                stops.update(sid.encode())
                stops.update(dist.tobytes())
                stops.update(off.tobytes())
            self.assertEqual(stops.hexdigest(), STOP_FIELDS_SHA1)
        town = build_map(SEED)
        paths = hashlib.sha1()
        for a in town.places.values():
            for b in town.places.values():
                paths.update(repr(town.path(a.entry, b.entry)).encode())
        self.assertEqual(paths.hexdigest(), PATHS_SHA1)

    def test_steps_reads_the_walk_field(self):
        town = build_map(SEED)
        rng = random.Random(99)
        walkable = [(x, y) for y in range(H) for x in range(W) if town.walkable(x, y)]
        for _ in range(100):
            start, goal = rng.choice(walkable), rng.choice(list(transit.STOP_XY.values()))
            self.assertEqual(town.steps(start, goal), len(town.path(start, goal)))
        self.assertEqual(town.steps((-1, 0), (10, 25)), UNREACHABLE)
        self.assertEqual(town.steps((31, 28), (10, 25)), UNREACHABLE)  # a building tile


class WarmTest(unittest.TestCase):
    def test_warm_builds_every_field_once(self):
        town = fresh_map()
        self.assertEqual((len(town._fields), len(town._roads)), (0, 0))
        t0 = time.perf_counter()
        town.warm()
        elapsed = time.perf_counter() - t0
        entries = {p.entry for p in town.places.values()}
        goals = entries | set(transit.STOP_XY.values())
        self.assertEqual(len(town._fields), len(goals))  # 39 place entries and 11 stops
        self.assertEqual(len(town._roads), len(entries))
        self.assertLess(elapsed, 2.0, f"warm() took {elapsed:.3f} s")
        walk = {g: town._fields[g] for g in town._fields}
        road = {g: town._roads[g] for g in town._roads}
        town.warm()  # idempotent: nothing is rebuilt
        self.assertEqual(set(town._fields), set(walk))
        self.assertEqual(set(town._roads), set(road))
        for g, f in walk.items():
            self.assertIs(town._fields[g], f)
        for g, f in road.items():
            self.assertIs(town._roads[g], f)
        # Warm fields hold the same values as fields built lazily on first use.
        lazy = fresh_map()
        for place in town.places.values():
            self.assertEqual(town.walk_field(place.entry), lazy.walk_field(place.entry))
            self.assertEqual(town.road_field(place.entry), lazy.road_field(place.entry))

    def test_after_warm_lookups_build_nothing(self):
        town = fresh_map()
        town.warm()
        fields, roads = len(town._fields), len(town._roads)
        for a in town.places.values():
            for b in town.places:
                town.walk_minutes(a.entry, b)
                town.drive_length(a.entry, b)
                for xy in transit.STOP_XY.values():
                    town.steps(a.entry, xy)
        self.assertEqual((len(town._fields), len(town._roads)), (fields, roads))

    def test_the_shared_map_is_still_shared(self):
        self.assertIs(build_map(SEED), build_map(SEED))
        build_map(SEED).warm()
        self.assertIs(build_map(SEED), build_map(SEED))


if __name__ == "__main__":
    unittest.main()
