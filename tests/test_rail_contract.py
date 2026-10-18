"""The roads and rail contract across both engines (region.md 6.6-6.7, 8, 11 R2 4 and 7): port/src/roads.js and
rail.js equal gameofailife/roads.py and rail.py, run through port/tools/parity_rail.cjs; the state.trains rows and
the welcome's rail and timetable shapes.

The node tests skip when node is absent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import unittest
from pathlib import Path

from gameofailife import rail, roads
from tests.test_rail import ROW_KEYS
from tests.test_roads import pairs, region_town

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "port" / "tools" / "parity_rail.cjs"
NODE = os.environ.get("NODE") or shutil.which("node")
needs_node = unittest.skipUnless(NODE, "node is not installed")
AT = [-3, -0.5, 0, 0.5, 1, 2.25, 3.7, 7, 12.5, 20, 33.3, 61, 999]


def node(*args) -> object:
    run = subprocess.run([NODE, str(TOOL), *map(str, args)], capture_output=True, text=True, timeout=600)
    if run.returncode:
        raise AssertionError(f"parity_rail.cjs {' '.join(map(str, args))} failed:\n{run.stderr}")
    return json.loads(run.stdout)


def plain(value) -> object:
    """Tuples to lists, as the JSON from Node has them."""
    return json.loads(json.dumps(value))


def _leg(leg):
    kind, t0, t1, data = leg
    if isinstance(data, roads.Route):
        data = {"mode": data.mode, "pts": data.pts, "minutes": data.minutes}
    return [kind, t0, t1, data]


# --- what parity_rail.cjs prints, computed in Python -------------------------------------------------------------
def py_net(town, net):
    return {"nodes": len(net.nodes), "edges": sum(len(a) for a in net.adj) // 2, "first": net.nodes[:20],
            "last": net.nodes[-10:]}


def py_routes(town, net, n):
    out = []
    for i, (a, b) in enumerate(pairs(town, n)):
        mode = "car" if i % 3 == 0 else "walk"
        r = net.route(a, b, mode, i % 2 == 0)
        out.append([a, b, mode, net.minutes(a, b, mode), net.minutes(b, a, mode), r.pts, r.t8, r.tiles, r.minutes,
                    [r.at(m) for m in AT]])
    return out


def py_still(town, net, n):
    """One-point routes (an end to itself), as a trip's 0-minute walk from a station exit makes them."""
    ends = []
    for a, _ in pairs(town, n):
        ra = net._end(a)[0]
        ends += [a, (ra % net.w, ra // net.w)]
    for ln in rail.lines(town).values():
        for s in ln.stations:
            ends.extend(ln.exits[s])
    out = []
    for e in ends:
        for mode in ("walk", "car"):
            r = net.route(e, e, mode, False)
            out.append([e, mode, r.pts, r.t8, r.tiles, r.minutes, [r.at(m) for m in AT]])
    return out


def py_starts(town, net, n):
    out = []
    for a, b in pairs(town, n):
        ra, rb = net._end(a)[0], net._end(b)[0]
        out.append([net._start(ra, rb, "walk"), net._start(ra, rb, "car")])
    return out


def py_nearby(town, net, n):
    return [[net.nearby(a, ["cafe"], "walk", 3), net.nearby(a, ["office", "works"], "car", 5, 25)]
            for a, _ in pairs(town, n)]


def py_trains(town, ticks):
    return [rail.train_rows(town, t, {"R1": t % 7, "S2": t % 5}) for t in range(ticks)]


def py_trips(town, net, n):
    out = []
    for i, (a, b) in enumerate(pairs(town, n)):
        car = i % 4 == 0
        trips = []
        for t in (i % 1440, 420 + i % 180, 1000 + (i * 7) % 60):
            tr = rail.trip_via_roads(town, net, a, b, t, car)
            trips.append(None if tr is None else [tr.minutes, tr.board, tr.alight, [_leg(leg) for leg in tr.legs]])
        out.append([a, b, car, rail.worst_minutes(town, net, a, b, car), trips])
    return out


def py_boarding(town):
    out = []
    for ln in rail.lines(town).values():
        for track in ("out", "in"):
            for s in ln.stations:
                row = [rail.boarding(town, ln.id, track, s, t) for t in range(ln.cycle_minutes)]
                out.append([ln.id, track, s, row])
        out.append([ln.id, "run", ln.run, ln.cycle_minutes])
    out.append(["timetable", rail.timetable_json(town)])
    out.append(["rail", rail.rail_json(town)])
    return out


@needs_node
class NodeParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = region_town()
        cls.net = roads.roadnet(cls.town)

    def test_graph(self):
        self.assertEqual(node("net"), plain(py_net(self.town, self.net)))

    def test_300_routes(self):
        js = node("routes", 300)
        py = plain(py_routes(self.town, self.net, 300))
        self.assertEqual(len(js), 300)
        for a, b in zip(js, py):
            self.assertEqual(a, b, a[:3])

    def test_one_point_routes(self):
        js = node("still", 20)
        py = plain(py_still(self.town, self.net, 20))
        self.assertGreater(len(js), 80)
        self.assertEqual(js, py)
        for e, mode, pts, t8, tiles, minutes, at in py:
            if isinstance(e, list):  # a street tile to itself is one point; a place goes out to its street and back
                self.assertEqual((len(pts), tiles, minutes), (1, 0, 0), e)
                self.assertEqual(at, [[*pts[0], None]] * len(AT), e)

    def test_starts_among_5000_pairs(self):
        js = node("starts", 5000)
        py = plain(py_starts(self.town, self.net, 5000))
        self.assertEqual(js, py)
        ties = 0
        for a, b in pairs(self.town, 5000):
            ra, rb = self.net._end(a)[0], self.net._end(b)[0]
            A = self.net.edge_of[ra]
            for mode in ("walk", "car"):
                unit = roads.WALK_T if mode == "walk" else roads.CAR_T
                if ra == rb or A[:2] == self.net.edge_of[rb][:2]:
                    continue
                dist = self.net._tree(rb, mode)[0]
                ties += A[2] * unit + dist[A[0]] == A[3] * unit + dist[A[1]]
        self.assertGreater(ties, 0)  # equal-cost starts are among them, and Node broke each tie the same way

    def test_nearby(self):
        self.assertEqual(node("nearby", 100), plain(py_nearby(self.town, self.net, 100)))

    def test_train_rows_over_a_day(self):
        js = node("trains", 1440)
        py = plain(py_trains(self.town, 1440))
        self.assertEqual(len(js), 1440)
        for t, (a, b) in enumerate(zip(js, py)):
            self.assertEqual(a, b, t)

    def test_trips_and_worst_minutes(self):
        js = node("trips", 200)
        py = plain(py_trips(self.town, self.net, 200))
        for a, b in zip(js, py):
            self.assertEqual(a, b, a[:3])

    def test_boarding_tables_and_json(self):
        self.assertEqual(node("boarding"), plain(py_boarding(self.town)))

    def test_bench_report_only(self):
        got = node("bench", 100_000)
        print(f"\n  node (load {os.getloadavg()[0]:.1f}): minutes hit {got['minutes_hit_us']:.2f} us, route"
              f" {got['route_us']:.1f} us, train_rows {got['train_rows_us']:.1f} us, trip {got['trip_us']:.1f} us")
        self.assertEqual(set(got), {"minutes_hit_us", "route_us", "train_rows_us", "trip_us"})


class StateContractTest(unittest.TestCase):
    """region.md 8: what F3's `sim.trains()` sends every frame and what the welcome carries."""

    @classmethod
    def setUpClass(cls):
        cls.town = region_town()

    def test_state_trains_rows(self):
        for tick in (0, 437, 1439, 10_000):
            rows = rail.train_rows(self.town, tick, {"R3": 4})
            self.assertEqual(len(rows), 10)
            for r in rows:
                self.assertEqual(set(r), ROW_KEYS)
                self.assertIsInstance(r["i"], int)
                self.assertGreaterEqual(r["i"] - 3, 0)
                self.assertIn(r["track"], ("out", "in"))
                self.assertTrue(r["at_station"] is None or r["at_station"] in self.town.places)
                self.assertIsInstance(r["riders"], int)
        size = len(json.dumps(rail.train_rows(self.town, 500)))
        self.assertLess(size, 1600)

    def test_train_rows_speed(self):
        c = time.process_time()
        for t in range(10_000):
            rail.train_rows(self.town, t)
        per = (time.process_time() - c) / 10_000
        self.assertLess(per, 50e-6, f"{per * 1e6:.1f} us, load {os.getloadavg()[0]:.1f}")

    def test_welcome_rail_matches_the_map(self):
        rj = rail.rail_json(self.town)
        self.assertEqual(rj, plain(self.town.rail))
        if hasattr(self.town, "map_json"):
            self.assertEqual(plain(self.town.map_json()["rail"]), rj)
        tt = rail.timetable_json(self.town)
        stations = {s for ln in tt["lines"] for s in ln["stations"]}
        self.assertTrue(stations <= set(self.town.places))
        self.assertTrue(all(self.town.places[s].kind == "station" for s in stations))
        self.assertEqual(len(stations), 9)


class SimulationTrainsTest(unittest.TestCase):
    """Once F3's hooks are in: the state frame carries the 10 trains in region world and [] in millbrook, and the
    timetable carries `train` in region world only."""

    def test_state_and_timetable(self):
        from gameofailife.sim import Simulation
        try:
            sim = Simulation(1, world="region")
        except TypeError:
            self.skipTest("Simulation has no world= yet (F3's hooks)")
        state = sim.state_json(housing=False)
        if "trains" not in state:
            self.skipTest("state_json has no trains yet (F3's hooks)")
        self.assertEqual(len(state["trains"]), 10)
        tick = sim.clock.tick
        self.assertEqual(state["trains"], plain(rail.train_rows(sim.town, tick, sim.folk.riders(tick))))
        self.assertEqual(sim.timetable()["train"], plain(rail.timetable_json(sim.town)))
        mb = Simulation(1)
        self.assertEqual(mb.state_json(housing=False)["trains"], [])
        self.assertNotIn("train", mb.timetable())


if __name__ == "__main__":
    unittest.main()
