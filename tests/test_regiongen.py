"""The region data (design-v3/region.md 11, R1a 1-5): gameofailife.regiongen, data/region.json, gameofailife.region.

1. `regiongen --check` is fresh and fast; its output minus the additive keys is the hour-0 file byte for byte.
2. The frozen rectangle (x < 69, y < 50) is exactly build_map(s)'s for s 1-4, and every walk and road field the 60
   use is v2's inside S = {x < 69, y < 46} on seeds 1-2.
3. Entries touch a street, footprints never overlap, ids are unique, `[a-z0-9_]`, never integer-like and never
   Millbrook's; every place is reachable from Millbrook Station (and on R2's RoadNet once roads.py is there); the
   decor keeps its margin and stays out of Millbrook's 80 x 50.
4. The targets: homes, start-occupied, flats, slots, places, seats, shops, buildings and the station catchment.
5. `build_region` under 50 ms CPU once loaded; `map_json()` at most 190 KB; Node reproduces tiles, places, priced
   homes, job slots and the helpers (port/tools/parity_region.cjs).

tests/fixtures/region_seed1.json pins the file's sha1, the seed-1 tiles' sha1 and the counts; regenerate it with
`python3 tests/test_regiongen.py --write-fixture` only after a deliberate (additive) data change.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from collections import Counter, deque
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gameofailife import region, regiongen  # noqa: E402
from gameofailife import town as T  # noqa: E402
from gameofailife.housing import HOME_SPECS  # noqa: E402
from gameofailife.transit import STOP_XY  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "region_seed1.json"
PARITY = ROOT / "port" / "tools" / "parity_region.cjs"
NODE = os.environ.get("NODE") or shutil.which("node")
ID = re.compile(r"[a-z0-9_]*[a-z][a-z0-9_]*")  # [a-z0-9_] with a letter: never integer-like
MARGIN = set("eDS=xrhH")  # decor keeps one tile from these


def roads_module():
    """R2's gameofailife.roads once it has merged (v3-skel-rail), else None."""
    try:
        from gameofailife import roads
    except ImportError:
        return None
    return roads if hasattr(roads, "roadnet") else None


def run_minutes(line: dict) -> dict:
    """Minutes from each track's first stop to each later one: up to `speed` tiles a minute, `dwell` at a stop."""
    out = {}
    for track in ("out", "in"):
        idx = sorted(s["i"][track] for s in line["stations"])
        t, mins = 0, [0]
        for a, b in zip(idx, idx[1:]):
            t += math.ceil((b - a) / line["speed"]) + (line["dwell"] if len(mins) > 1 else 0)
            mins.append(t)
        out[track] = mins
    return out


def _median(xs: list) -> float:
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def summary(seed: int = 1) -> dict:
    """What region_seed1.json pins."""
    d = region.load_data()
    m = region.build_region(seed)
    pl = {p["id"]: p for p in d["places"]}
    homes = d["homes"]
    start = Counter(h[7] for h in homes)
    slots_by = Counter()
    for t, pid, *_, n in d["jobs"]:
        slots_by[pl[pid]["district"] if pid in pl else "millbrook"] += n
    medians = {}
    for did in sorted({pl[s[1]]["district"] for s in m.home_specs}):
        for tier in ("flat", "house", "big_house"):
            rows = [s for s in m.home_specs if s[3] == tier and pl[s[1]]["district"] == did]
            if rows:
                medians[f"{did}/{tier}"] = [_median([s[5] for s in rows]),
                                           _median([region.rent_at(m, s, m.lot_conditions[s[1]]) for s in rows])]
    return {
        "region_sha1": hashlib.sha1(Path(region.DATA).read_bytes()).hexdigest(),
        "hour0_sha1": regiongen.HOUR0_SHA1,
        "tiles_sha1": hashlib.sha1("\n".join(m.rows()).encode()).hexdigest(),
        "places": len(d["places"]),
        "kinds": dict(sorted(Counter(p["kind"] for p in d["places"]).items())),
        "homes": len(homes),
        "tiers": dict(sorted(Counter(h[3] for h in homes).items())),
        "homes_by_district": dict(sorted(Counter(pl[h[1]]["district"] for h in homes).items())),
        "start": dict(sorted(start.items())),
        "start_occupied": start["let"] + start["owned"],
        "slots": {"region": sum(j[6] for j in d["jobs"] if j[1] in pl),
                  "millbrook": sum(j[6] for j in d["jobs"] if j[1] not in pl)},
        "slots_by_district": dict(sorted(slots_by.items())),
        "decor": len(d["decor"]),
        "junctions": len(m.junctions),
        "stops": {ln["id"]: {s["id"]: [s["i"]["out"], s["i"]["in"]] for s in ln["stations"]}
                  for ln in d["rail"]["lines"]},
        "track_tiles": {ln["id"]: ln["track_tiles"] for ln in d["rail"]["lines"]},
        "run_minutes": {ln["id"]: run_minutes(ln) for ln in d["rail"]["lines"]},
        "price_medians": medians,
    }


class Generator(unittest.TestCase):
    def test_check_is_fresh_and_fast(self):
        best = math.inf
        for _ in range(2):
            c0 = time.process_time()
            with redirect_stdout(io.StringIO()):
                status = regiongen.main(["--check"])
            best = min(best, time.process_time() - c0)
            self.assertEqual(status, 0, "data/region.json is stale: python3 -m gameofailife.regiongen --write")
        self.assertLess(best, 0.5, f"--check took {best:.3f} s cpu (load {os.getloadavg()[0]:.1f})")

    def test_hour0_file_minus_additive_keys(self):
        text = regiongen.dumps(regiongen.strip_additive(region.load_data()))
        self.assertEqual(hashlib.sha1(text.encode()).hexdigest(), regiongen.HOUR0_SHA1)
        self.assertEqual(Path(region.DATA).read_text(encoding="utf-8"), regiongen.dumps(region.load_data()))

    def test_check_exits_1_when_stale(self):
        stale = Path(region.DATA).read_text(encoding="utf-8").replace('"parking_minutes":10', '"parking_minutes":9')
        with tempfile.TemporaryDirectory(prefix="region-stale-") as tmp:
            path = Path(tmp) / "region.json"
            path.write_text(stale, encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(regiongen.main(["--check", "--out", str(path)]), 1)

    def test_additive_keys(self):
        d = region.load_data()
        self.assertEqual({x["id"]: x["parking_minutes"] for x in d["districts"] if x["parking_minutes"]},
                         {"downtown_riverton": 10, "midtown": 8})
        m = region.build_region(1)
        self.assertEqual(region.car_extra(m, "central_station"), 10)
        self.assertEqual(region.car_extra(m, "midtown_station"), 8)
        self.assertEqual(region.car_extra(m, "quay_market"), 0)
        self.assertEqual(region.car_extra(m, "hospital"), 0)
        self.assertEqual(region.car_extra(T.build_map(1), "hospital"), 0)


class Fixture(unittest.TestCase):
    def test_seed1_summary_equals_the_fixture(self):
        want = json.loads(FIXTURE.read_text())
        got = json.loads(json.dumps(summary(1)))
        for key in want:
            self.assertEqual(got.get(key), want[key], key)
        self.assertEqual(set(got), set(want))

    def test_pinned_numbers(self):
        s = summary(1)
        self.assertEqual(s["start_occupied"], 572)
        self.assertEqual(s["decor"], 656)
        self.assertEqual(s["slots"], {"region": 1241, "millbrook": 142})
        self.assertEqual(s["run_minutes"], {"R": {"out": [0, 3, 8, 12, 19, 24], "in": [0, 4, 11, 15, 20, 24]},
                                            "S": {"out": [0, 3, 9, 14], "in": [0, 4, 10, 14]}})
        self.assertEqual(s["stops"]["R"]["millbrook_station"], [4, 184])
        self.assertEqual(s["stops"]["S"]["central_station"], [4, 116])


class FrozenRectangle(unittest.TestCase):
    def test_tiles_equal_build_map(self):
        fw, fh = region.FROZEN
        for seed in (1, 2, 3, 4):
            m, mb = region.build_region(seed), T.build_map(seed)
            for y in range(fh):
                self.assertEqual(m.tiles[y][:fw], mb.tiles[y][:fw], (seed, y))
            self.assertEqual((m.w, m.h), (region.W, region.H))

    def test_nothing_walkable_in_the_river_west_of_69(self):
        m = region.build_region(1)
        for y in T.RIVER_ROWS:
            self.assertEqual({m.tiles[y][x] for x in range(69)}, {T.WATER}, y)
            self.assertFalse(any(m.walkable(x, y) for x in range(69)), y)

    def test_millbrook_places_are_copies_with_capacity(self):
        m, mb = region.build_region(1), T.build_map(1)
        self.assertEqual(list(m.places)[:len(mb.places)], list(mb.places))
        self.assertEqual(m.millbrook_ids, frozenset(mb.places))
        for pid, p in mb.places.items():
            q = m.places[pid]
            self.assertIsNot(q, p)
            self.assertEqual(p.capacity, 0)
            self.assertEqual(q.capacity, region.CAPACITY_BY_KIND[p.kind])
            self.assertEqual({k: v for k, v in q.to_json().items() if k != "capacity"}, p.to_json())
        self.assertNotIn("capacity", json.dumps(mb.map_json()))

    def test_fields_inside_s_equal_v2(self):
        sw, sh = 69, 46  # S = {x < 69, y < 46} (region.md 3.4)
        for seed in (1, 2):
            m, mb = region.build_region(seed), T.build_map(seed)
            idx = [y * m.w + x for y in range(sh) for x in range(sw)]
            jdx = [y * mb.w + x for y in range(sh) for x in range(sw)]
            goals = [p.entry for p in mb.places.values()] + list(STOP_XY.values())
            for g in goals:
                a, b = m.walk_field(g), mb.walk_field(g)
                self.assertEqual([a[0][i] for i in idx], [b[0][j] for j in jdx], (seed, g, "dist"))
                self.assertEqual([a[1][i] for i in idx], [b[1][j] for j in jdx], (seed, g, "off"))
            for p in mb.places.values():
                a, b = m.road_field(p.entry), mb.road_field(p.entry)
                self.assertEqual([a[i] for i in idx], [b[j] for j in jdx], (seed, p.id, "road"))
            self.assertEqual({j for j in m.junctions if j[0] < sw and j[1] < sh},
                             {j for j in mb.junctions if j[0] < sw and j[1] < sh}, seed)

    def test_warm_builds_only_millbrook(self):
        m = region.build_region.__wrapped__(3)  # a private copy: other tests may fill the shared one's caches
        m.warm()
        goals = {p.entry[1] * m.w + p.entry[0] for p in m.places.values() if p.id in m.millbrook_ids}
        stops = {y * m.w + x for x, y in STOP_XY.values()}
        self.assertEqual(set(m._fields), goals | stops)
        self.assertEqual(set(m._roads), goals)
        self.assertFalse(m.warm_next())


class Invariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = region.load_data()
        cls.m = region.build_region(1)
        cls.mine = [cls.m.places[p["id"]] for p in cls.d["places"]]

    def test_ids(self):
        d, mb = self.d, T.build_map(1)
        place_ids = [p["id"] for p in d["places"]]
        home_ids = [h[0] for h in d["homes"]]
        for ids in (place_ids, home_ids):
            self.assertEqual(len(ids), len(set(ids)))
            for i in ids:
                self.assertRegex(i, ID)
        self.assertFalse(set(place_ids) & set(mb.places))
        self.assertFalse(set(home_ids) & {h[0] for h in HOME_SPECS})
        self.assertFalse(set(home_ids) & set(mb.places))
        self.assertEqual([s[0] for s in self.m.home_specs], home_ids)  # after the 37, in file order

    def test_entries_touch_a_street(self):
        m = self.m
        for p in m.places.values():
            ex, ey = p.entry
            self.assertEqual(m.tiles[ey][ex], T.ENTRY, p.id)
            self.assertTrue(any(m._is_road(ex + dx, ey + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))),
                            p.id)

    def test_footprints_never_overlap(self):
        """No tile belongs to two buildings (places or decor). A park owns only its own P, T and e tiles: its rect
        is the block it greens, and north_park's block also holds Northgate station and the R tracks."""
        m = self.m
        owner = {}
        rects = [(p.id, p.x, p.y, p.w, p.h, p.kind == "park") for p in m.places.values()]
        rects += [(f"decor{k}", x, y, w, h, False) for k, (x, y, w, h, *_) in enumerate(m.decor)]
        for oid, x0, y0, w, h, park in rects:
            for y in range(y0, y0 + h):
                for x in range(x0, x0 + w):
                    if park and m.tiles[y][x] not in "PTe":
                        continue
                    self.assertFalse((x, y) in owner, (x, y, oid, owner.get((x, y))))
                    owner[x, y] = oid
        for p in self.mine:
            cells = [m.tiles[y][x] for y in range(p.y, p.y + p.h) for x in range(p.x, p.x + p.w)]
            if p.kind == "park":
                self.assertGreater(sum(c in "PT" for c in cells), len(cells) // 3, p.id)  # north_park: 53 of 120
            else:
                self.assertLessEqual(set(cells), set("BD"), p.id)

    def test_decor(self):
        m = self.m
        mx, my, mw, mh = region.MILLBROOK
        styles = Counter()
        for row in m.decor:
            x, y, w, h, style, floors, variant = row
            styles[style] += 1
            self.assertTrue(isinstance(style, str) and floors >= 1 and 0 <= variant < 8, row)
            self.assertFalse(x < mx + mw and y < my + mh, row)  # never in the frozen rectangle or the strip
            self.assertEqual({m.tiles[yy][xx] for yy in range(y, y + h) for xx in range(x, x + w)}, {T.BUILDING}, row)
            near = {m.tiles[yy][xx] for yy in range(max(0, y - 1), min(m.h, y + h + 1))
                    for xx in range(max(0, x - 1), min(m.w, x + w + 1))}
            self.assertFalse(near & MARGIN, row)
        self.assertEqual(len(m.decor), 656)

    def test_rows(self):
        d, m = self.d, self.m
        for p in self.mine:
            if p.hours:
                self.assertTrue(0 <= p.hours[0] < p.hours[1] <= 24, p.id)
            self.assertTrue(p.district, p.id)
        units = Counter(h[1] for h in d["homes"])
        for p in self.mine:
            if p.kind == "home":
                self.assertEqual(units[p.id], p.units, p.id)
                self.assertIn(p.id, m.lot_conditions)
                self.assertTrue(0 <= m.lot_conditions[p.id] <= 100)
        for hid, pid, unit, tier, beds, value, rent, start, cond in m.home_specs:
            p = m.places[pid]
            self.assertEqual((p.kind, p.tier), ("home", tier), hid)
            self.assertIn(start, ("let", "owned", "for_sale"))
            self.assertTrue(value > 0 and value % 100 == 0 and rent > 0 and rent % 5 == 0, hid)
        for title, pid, wage, s, e, days, n in m.job_slots:
            self.assertIn(pid, m.places)
            self.assertNotEqual(m.places[pid].kind, "home")
            self.assertTrue(0 <= s < e <= 24 and wage > 0 and n > 0 and days and set(days) <= set(range(7)),
                            (title, pid))
        self.assertEqual(sum(r[6] for r in m.job_slots if r[1] in m.millbrook_ids), 142)

    def test_reachable_from_millbrook_station(self):
        m = self.m
        w, h = m.w, m.h
        sx, sy = m.places["millbrook_station"].entry
        seen = bytearray(w * h)
        seen[sy * w + sx] = 1
        q = deque([(sx, sy)])
        while q:
            x, y = q.popleft()
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if m.walkable(nx, ny) and not seen[ny * w + nx]:
                    seen[ny * w + nx] = 1
                    q.append((nx, ny))
        self.assertEqual([pid for pid, p in m.places.items() if not seen[p.entry[1] * w + p.entry[0]]], [])
        roads = roads_module()
        if roads is None:
            self.skipTest("gameofailife.roads (R2, v3-skel-rail) is not merged: tile BFS only")
        net = roads.roadnet(m)
        far = [pid for pid in m.places if net.minutes("millbrook_station", pid) >= 10_000]
        self.assertEqual(far, [])

    def test_prices(self):
        d, m = self.d, self.m
        self.assertEqual(m.prices, d["prices"])
        raw = {h[0]: h for h in d["homes"]}
        for spec in m.home_specs:
            base = raw[spec[0]]
            self.assertGreaterEqual(spec[5], base[5] * 0.7 - 100)
            listed = region.rent_at(m, spec, 100)
            self.assertEqual(listed, spec[6])
            self.assertLessEqual(region.rent_at(m, spec, 0), listed)
        heights = [s for s in m.home_specs if s[3] == "big_house" and m.places[s[1]].district == "the_heights"]
        self.assertEqual(_median([s[5] for s in heights]), 76000)


class Targets(unittest.TestCase):
    def test_counts(self):
        d = region.load_data()
        m = region.build_region(1)
        homes = d["homes"]
        start = Counter(h[7] for h in homes)
        self.assertTrue(540 <= len(homes) <= 620, len(homes))
        self.assertGreaterEqual(start["let"] + start["owned"], 490)
        flats = sum(h[3] == "flat" for h in homes) / len(homes)
        self.assertTrue(0.55 <= flats <= 0.75, flats)
        pl = {p["id"] for p in d["places"]}
        self.assertGreaterEqual(sum(j[6] for j in d["jobs"] if j[1] in pl), 1200)
        self.assertEqual(sum(j[6] for j in d["jobs"] if j[1] not in pl), 142)
        self.assertLessEqual(len(d["places"]), 360)
        kinds = Counter(p["kind"] for p in d["places"])
        self.assertGreaterEqual(sum(p["capacity"] for p in d["places"] if p["kind"] == "school"), 900)
        self.assertGreaterEqual(kinds["cafe"] + kinds["shop"] + kinds["market"], 90)
        buildings = [p for p in m.places.values() if p.kind != "park"]
        self.assertGreaterEqual(len(buildings) + len(m.decor), 1000)
        tall = sum(p.floors >= 10 for p in buildings) + sum(row[5] >= 10 for row in m.decor)
        self.assertGreaterEqual(tall, 30)

    def test_station_catchment(self):
        """At least 120 homes and 250 job slots within 15 minutes of a station: on R2's RoadNet (road walk, the
        measure folk use) when it is merged, else by tile walk, which is never longer."""
        d = region.load_data()
        m = region.build_region(1)
        stations = [p["id"] for p in d["places"] if p["kind"] == "station"]
        exits = {s["id"]: [tuple(e) for e in s["exits"]] for ln in d["rail"]["lines"] for s in ln["stations"]}
        roads = roads_module()
        if roads is not None:
            net = roads.roadnet(m)

            def acc(pid, sid):
                return min([net.minutes(pid, sid)] + [net.minutes(pid, e) + 1 for e in exits[sid]])
        else:
            def acc(pid, sid):
                x, y = m.places[pid].entry
                ends = [m.places[sid].entry] + exits[sid]
                return min(m.steps((x, y), g) + (k > 0) for k, g in enumerate(ends))
        units = Counter(h[1] for h in d["homes"])
        slots = Counter()
        for j in d["jobs"]:
            slots[j[1]] += j[6]
        near_homes = sum(n for pid, n in units.items() if min(acc(pid, s) for s in stations) <= 15)
        near_slots = sum(n for pid, n in slots.items() if min(acc(pid, s) for s in stations) <= 15)
        self.assertGreaterEqual(near_homes, 120)
        self.assertGreaterEqual(near_slots, 250)

    def test_map_json_size_and_keys(self):
        m = region.build_region(1)
        got = m.map_json()
        size = len(json.dumps(got))
        self.assertLessEqual(size, 190_000, size)
        self.assertEqual(set(got), {"w", "h", "tiles", "places", "districts", "streets", "junctions", "world",
                                    "millbrook", "rail", "highways", "interchanges", "decor"})
        self.assertEqual((got["w"], got["h"], got["world"], got["millbrook"]), (256, 192, "region", [0, 0, 80, 50]))
        self.assertTrue(all("capacity" in p for p in got["places"] if p["kind"] != "home"))
        self.assertTrue(all("rects" in x for x in got["districts"]))
        line = got["rail"]["lines"][0]
        self.assertEqual(set(line), {"id", "name", "cars", "tracks", "track_tiles", "trains", "every", "speed",
                                     "dwell", "layover", "capacity", "fare", "stations"})
        self.assertEqual(set(line["stations"][0]), {"id", "name", "i", "platforms", "exits"})
        mb = T.build_map(1)
        self.assertEqual(set(mb.map_json()), {"w", "h", "tiles", "places", "districts", "streets", "road_rows",
                                              "road_cols", "road_col_end", "junctions"})

    def test_build_region_is_fast_once_loaded(self):
        region.load_data()
        T.build_map(5)
        best = math.inf
        for _ in range(3):
            c0 = time.process_time()
            region.build_region.__wrapped__(5)
            best = min(best, time.process_time() - c0)
        self.assertLess(best, 0.050, f"{best * 1000:.1f} ms cpu (load {os.getloadavg()[0]:.1f})")

    def test_defaults_in_millbrook(self):
        mb = T.build_map(1)
        self.assertEqual(mb.world, "millbrook")
        self.assertIsNone(mb.millbrook_ids)
        self.assertIsNone(mb.rail)
        for attr in ("home_specs", "job_slots", "decor", "highways", "interchanges", "highway_edges"):
            self.assertEqual(len(getattr(mb, attr)), 0, attr)
        self.assertEqual(dict(mb.lot_conditions), {})
        self.assertTrue(mb.in_frozen(200, 100))
        self.assertFalse(mb.warm_next())
        m = region.build_region(1)
        self.assertEqual((m.in_frozen(68, 49), m.in_frozen(69, 0), m.in_frozen(0, 50)), (True, False, False))
        self.assertEqual((m.district_at(10, 10), m.district_at(74, 30), m.district_at(130, 60), m.district_at(3, 3)),
                         ("maple_grove", "the_works", "downtown_riverton", ""))


@unittest.skipUnless(NODE, "node is not installed")
class NodeParity(unittest.TestCase):
    def test_node_builds_the_same_region(self):
        for seed in (1, 2):
            run = subprocess.run([NODE, str(PARITY), "region", str(seed)], capture_output=True, text=True, timeout=300)
            self.assertEqual(run.returncode, 0, run.stderr)
            js = json.loads(run.stdout)
            m = region.build_region(seed)
            py = json.loads(json.dumps({"map": m.map_json(), "home_specs": m.home_specs, "job_slots": m.job_slots,
                                        "lot_conditions": m.lot_conditions}))
            self.assertEqual(js["world"], "region")
            for key in py["map"]:
                self.assertEqual(js["map"][key], py["map"][key], (seed, key))
            for key in ("home_specs", "job_slots", "lot_conditions"):
                self.assertEqual(js[key], py[key], (seed, key))
            self.assertEqual(js["millbrook_ids"], sorted(m.millbrook_ids))
            rents = [[region.rent_at(m, s, m.lot_conditions.get(s[1], 100)), region.rent_at(m, s, 0),
                      region.rent_at(m, s, 37.5)] for s in m.home_specs]
            self.assertEqual(js["rents"], rents)
            self.assertEqual(js["parking"], [region.car_extra(m, pid) for pid in m.places])
            self.assertEqual(js["districts"], [m.district_at(x, y) for y in range(0, m.h, 7) for x in range(0, m.w, 5)])
            self.assertEqual(js["frozen"], [m.in_frozen(x, y) for x, y in ((0, 0), (68, 49), (69, 0), (0, 50), (200, 100))])
            self.assertEqual(js["walk"], [int(m.walkable(i % m.w, i // m.w)) for i in range(0, m.w * m.h, 97)])
            self.assertEqual(js["street"], [m._road[i] for i in range(0, m.w * m.h, 97)])
            self.assertFalse(js["warm_next"])
            self.assertEqual(js["millbrook"], {"world": "millbrook", "in_frozen": True, "car_extra": 0})
            load = os.getloadavg()[0]
            if load <= 8:  # PLAN 6: Node timings are report-only above load 8
                self.assertLess(js["build_ms"], 200 * max(1, load / 4), js["build_ms"])


def write_fixture() -> None:
    FIXTURE.write_text(json.dumps(summary(1), indent=1) + "\n")
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    if "--write-fixture" in sys.argv:
        write_fixture()
    else:
        unittest.main()
