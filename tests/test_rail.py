"""The railway (gameofailife/rail.py, region.md 7 and 11 R2 5-7): cycles, boarding, trips, worst cases, state rows."""

from __future__ import annotations

import json
import os
import time
import unittest

from gameofailife import rail, roads
from gameofailife import town as T
from tests.test_roads import pairs, region_town

RUN_MINUTES = {"R": {"out": (0, 3, 8, 12, 19, 24), "in": (0, 4, 11, 15, 20, 24)},
               "S": {"out": (0, 3, 9, 14), "in": (0, 4, 10, 14)}}
ROW_KEYS = {"id", "line", "track", "i", "x", "y", "dir", "at_station", "riders"}


class LineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = region_town()
        cls.lines = rail.lines(cls.town)

    def test_two_lines(self):
        self.assertEqual(list(self.lines), ["R", "S"])
        self.assertIs(rail.lines(self.town), self.town.memo["rail"])
        R, S = self.lines["R"], self.lines["S"]
        self.assertEqual((R.trains, R.cycle_minutes, len(R.stations)), (6, 60, 6))
        self.assertEqual((S.trains, S.cycle_minutes, len(S.stations)), (4, 40, 4))
        self.assertEqual(R.train_ids, ("R1", "R2", "R3", "R4", "R5", "R6"))
        self.assertEqual(S.train_ids, ("S1", "S2", "S3", "S4"))
        for ln in self.lines.values():
            self.assertEqual({k: v for k, v in ln.run.items()}, RUN_MINUTES[ln.id])
            for track, order in (("out", ln.stations), ("in", ln.stations[::-1])):
                for a in order:
                    for b in order[order.index(a) + 1:]:
                        self.assertEqual(rail.ride_minutes(self.town, ln.id, track, a, b),
                                         RUN_MINUTES[ln.id][track][order.index(b)]
                                         - RUN_MINUTES[ln.id][track][order.index(a)])

    def test_doors_open_dwell_plus_one_at_each_stop(self):
        for ln in self.lines.values():
            for track, order in (("out", ln.stations), ("in", ln.stations[::-1])):
                for s in order[1:-1]:
                    self.assertEqual(len(ln.doors[(track, s)]), ln.dwell + 1, (ln.id, track, s))
                self.assertEqual(len(ln.doors[(track, order[0])]), 1)  # the departure minute
                self.assertGreaterEqual(len(ln.doors[(track, order[-1])]), ln.dwell + 1 + ln.layover - 1)

    def test_cars_stay_on_the_track_and_no_two_trains_share_a_tile(self):
        for ln in self.lines.values():
            for track, i, at, open_ in ln.cycle:
                self.assertGreaterEqual(i - 3, 0)
                self.assertLess(i, len(ln.tracks[track]))
                if open_:
                    self.assertEqual(i, ln.stop[(track, at)])
        for tick in range(120):
            seen = set()
            for ln in self.lines.values():
                for k in range(ln.trains):
                    track, i, _, _ = ln.state(k, tick)
                    for j in range(i, i - 4, -1):
                        tile = ln.tracks[track][j]
                        self.assertNotIn(tile, seen, (tick, ln.id, k))
                        seen.add(tile)

    def test_track_tiles_are_rail(self):
        for ln in self.lines.values():
            for track, tiles in ln.tracks.items():
                data = self.town.rail["lines"][list(self.lines).index(ln.id)]
                self.assertEqual(len(tiles), data["track_tiles"][track])
                for x, y in tiles:  # the view draws corners + 0.5: every tile between them is track
                    self.assertIn(self.town.tiles[y][x], "=rx", (ln.id, track, x, y))
                for (x0, y0), (x1, y1) in zip(tiles, tiles[1:]):
                    self.assertEqual(abs(x1 - x0) + abs(y1 - y0), 1)

    def test_boarding_is_exact(self):
        for ln in self.lines.values():
            for (track, s) in ln.doors:
                worst = 0
                for tick in range(1000, 1000 + 2 * ln.cycle_minutes):
                    tid, w = rail.boarding(self.town, ln.id, track, s, tick)
                    k = ln.train_ids.index(tid)
                    worst = max(worst, w)
                    st = ln.state(k, tick + w)
                    self.assertEqual((st[0], st[2], st[3]), (track, s, True))
                    for d in range(w):  # no train stands there open sooner
                        for kk in range(ln.trains):
                            st = ln.state(kk, tick + d)
                            self.assertFalse(st[0] == track and st[2] == s and st[3])
                terminus = s == (ln.stations[0] if track == "out" else ln.stations[-1])
                self.assertLessEqual(worst, 9 if terminus else 8, (ln.id, track, s))

    def test_train_rows(self):
        rows = rail.train_rows(self.town, 500, {"R3": 4})
        self.assertEqual(len(rows), 10)
        self.assertEqual([r["id"] for r in rows], ["R1", "R2", "R3", "R4", "R5", "R6", "S1", "S2", "S3", "S4"])
        for r in rows:
            self.assertEqual(set(r), ROW_KEYS)
            self.assertIn(r["dir"], "nsew")
            self.assertEqual(rail.train_xy(self.town, r["id"], 500), (r["x"], r["y"]))
            ln = self.lines[r["line"]]
            self.assertEqual(ln.tracks[r["track"]][r["i"]], (r["x"], r["y"]))
        self.assertEqual(rows[2]["riders"], 4)
        self.assertEqual(rows[0]["riders"], 0)
        self.assertTrue(any(r["at_station"] for t in range(60) for r in rail.train_rows(self.town, t)))
        json.dumps(rows)
        c = time.process_time()
        for t in range(5000):
            rail.train_rows(self.town, t)
        per = (time.process_time() - c) / 5000
        self.assertLess(per, 50e-6, f"train_rows {per * 1e6:.1f} us, load {os.getloadavg()[0]:.1f}")

    def test_json(self):
        tt = rail.timetable_json(self.town)
        self.assertEqual([ln["id"] for ln in tt["lines"]], ["R", "S"])
        self.assertEqual(tt["transfer"], {"central_station": 2})
        r = tt["lines"][0]
        self.assertEqual(set(r), {"id", "name", "stations", "trains", "every_minutes", "cycle_minutes", "fare",
                                  "capacity", "minutes"})
        self.assertEqual((r["trains"], r["every_minutes"], r["cycle_minutes"], r["fare"]), (6, 10, 60, 3))
        self.assertEqual(r["minutes"], {"out": [0, 3, 8, 12, 19, 24], "in": [0, 4, 11, 15, 20, 24]})
        self.assertEqual(rail.rail_json(self.town), json.loads(json.dumps(self.town.rail)))
        json.dumps(tt)

    def test_fare(self):
        self.assertEqual([rail.fare(a) for a in (5, 17, 18, 40, 64, 65, 90)], [0, 0, 3, 3, 3, 0, 0])

    def test_millbrook_has_no_railway(self):
        mb = T.build_map(1)
        self.assertEqual(rail.lines(mb), {})
        self.assertEqual(rail.train_rows(mb, 100), [])
        self.assertIsNone(rail.timetable_json(mb))
        self.assertIsNone(rail.rail_json(mb))
        net = roads.roadnet(mb)
        ids = [p for p, q in mb.places.items() if q.kind != "park"]
        self.assertIsNone(rail.trip_via_roads(mb, net, ids[0], ids[-1], 480))
        self.assertIsNone(rail.worst_minutes(mb, net, ids[0], ids[-1]))


class TripTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = region_town()
        cls.net = roads.roadnet(cls.town)
        cls.lines = rail.lines(cls.town)
        cls.pairs = pairs(cls.town, 300)

    def check_trip(self, tr, a, b, tick, car):
        self.assertEqual(tr.legs[0][1], tick)
        self.assertEqual(tr.legs[-1][2], tick + tr.minutes)
        for l0, l1 in zip(tr.legs, tr.legs[1:]):
            self.assertEqual(l0[2], l1[1])
        trains = {tid: (ln, k) for ln in self.lines.values() for k, tid in enumerate(ln.train_ids)}
        kinds = [leg[0] for leg in tr.legs]
        self.assertIn(kinds[0], (rail.WALK, rail.DRIVE) if car else (rail.WALK,))
        self.assertEqual(kinds[-1], rail.WALK)
        self.assertIn(kinds.count(rail.RIDE), (1, 2))
        for n, (kind, t0, t1, data) in enumerate(tr.legs):
            self.assertLessEqual(t0, t1)
            if kind in (rail.WALK, rail.DRIVE):
                self.assertIsInstance(data, roads.Route)
                self.assertEqual(t1 - t0, data.minutes)
                self.assertEqual(data.mode, "car" if kind == rail.DRIVE else "walk")
                if kind == rail.DRIVE:
                    self.assertLessEqual(data.minutes, rail.PARK_RIDE_MAX)
            elif kind == rail.WAIT:
                self.assertIn(data, self.town.places)
            else:
                ln, k = trains[data]
                board, alight = tr.legs[n - 1][3], None
                st0, st1 = ln.state(k, t0), ln.state(k, t1)
                self.assertTrue(st0[3] and st1[3] and st0[0] == st1[0], (data, t0, t1))
                self.assertEqual(st0[2], board)
                alight = st1[2]
                for t in range(t0 + 1, t1):  # it alights at the train's first stand at that station
                    st = ln.state(k, t)
                    self.assertFalse(st[2] == alight and st[3])
        self.assertEqual(tr.legs[1][3], tr.board)

    def test_trips_arrive_on_time_with_chained_legs(self):
        n = 0
        for i, (a, b) in enumerate(self.pairs[:150]):
            car = i % 4 == 0
            for tick in (i, 420 + i, 1000 + 3 * i):
                tr = rail.trip_via_roads(self.town, self.net, a, b, tick, car)
                if tr is None:
                    continue
                n += 1
                self.check_trip(tr, a, b, tick, car)
        self.assertGreater(n, 400)

    def test_worst_minutes_bounds_every_departure(self):
        for i, (a, b) in enumerate(self.pairs[:40]):
            car = i % 3 == 0
            w = rail.worst_minutes(self.town, self.net, a, b, car)
            self.assertIsInstance(w, int)
            self.assertIs(rail.worst_minutes(self.town, self.net, a, b, car), w)
            got = [rail.trip_via_roads(self.town, self.net, a, b, t, car).minutes for t in range(600, 720)]
            self.assertGreaterEqual(w, max(got), (a, b))
            self.assertLessEqual(w, max(got) + 12, (a, b))

    def test_trains_help_long_trips(self):
        saved = 0
        for a, b in self.pairs:
            walk = self.net.minutes(a, b)
            w = rail.worst_minutes(self.town, self.net, a, b)
            if walk >= 60 and w is not None and w <= walk - 10:
                saved += 1
        self.assertGreater(saved, 20)

    def test_street_tile_ends(self):
        tr = rail.trip_via_roads(self.town, self.net, (127, 73), self.pairs[3][1], 480)
        self.assertIsNotNone(tr)
        self.assertEqual(tr.legs[0][3].pts[0], (127, 73))
        self.assertEqual(rail.worst_minutes(self.town, self.net, [127, 73], self.pairs[3][1]),
                         rail.worst_minutes(self.town, self.net, (127, 73), self.pairs[3][1]))

    def test_ten_thousand_calls_in_a_second(self):
        for a, b in self.pairs:
            rail.trip_via_roads(self.town, self.net, a, b, 0)
            rail.worst_minutes(self.town, self.net, a, b)
        c = time.process_time()
        for i in range(10_000):
            a, b = self.pairs[i % 300]
            rail.trip_via_roads(self.town, self.net, a, b, 300 + i)
        trips = time.process_time() - c
        c = time.process_time()
        for i in range(10_000):
            a, b = self.pairs[i % 300]
            rail.worst_minutes(self.town, self.net, a, b, i % 2 == 0)
        worst = time.process_time() - c
        load = os.getloadavg()[0]
        self.assertLessEqual(trips, 1.0, f"10,000 trips {trips:.2f} s, load {load:.1f}")
        self.assertLessEqual(worst, 1.0, f"10,000 worst_minutes {worst:.2f} s, load {load:.1f}")


if __name__ == "__main__":
    unittest.main()
