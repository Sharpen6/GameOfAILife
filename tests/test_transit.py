"""The buses: laps, spacing, rows, doors, fares, and best_trip checked against riders who follow the timetable."""

from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from gameofailife import transit
from gameofailife.transit import BUS_IDS, LINES, STOP_AT, STOP_XY
from gameofailife.town import UNREACHABLE, build_map

SEED = 1
ROW_KEYS = {"id", "line", "x", "y", "dir", "at_stop", "riders"}
HEADINGS = {"e": (1, 0), "w": (-1, 0), "s": (0, 1), "n": (0, -1)}


def rider_trip(town, xy, place_id: str, tick: int, line: str, board: str, alight: str) -> dict:
    """Ride one trip the way the simulation does, one tick at a time, using only the public bus functions.

    to_stop: walk a tile a minute. waiting: from the tick the rider stands on the board stop (the tick they set off,
    when they start there), board the first bus of the line standing there and pay once. riding: the rider's tile
    is the bus's tile; get off on the tick the bus stands on the alight stop. from_stop: walk to the entry.
    Returns the log: arrival tick, the bus, fares paid and the ticks spent riding.
    """
    log = {"fares": 0, "bus": None, "riding_ticks": [], "boarded": None, "alighted": None}
    t = tick + len(town.path(tuple(xy), STOP_XY[board]))  # on the stop tile
    phase, riding = "waiting", None
    while phase != "from_stop":
        if phase == "waiting":
            bus = transit.bus_at_stop(line, board, t)
            if bus is not None:
                riding, phase = bus, "riding"
                log.update(bus=bus, boarded=t)
                log["fares"] += 1
                continue  # the same tick: the rider is on board at the stop
            assert t - tick < 200, "nobody waits this long"
        elif phase == "riding":
            where = transit.bus_xy(riding, t)
            log["riding_ticks"].append((t, where))
            if where == STOP_XY[alight] and t > log["boarded"]:
                riding, phase = None, "from_stop"
                log["alighted"] = t
                break
        t += 1
    log["arrive"] = t + len(town.path(STOP_XY[alight], town.places[place_id].entry))
    return log


def every_trip(town, xy, place_id: str, tick: int) -> dict[tuple[str, str, str], int]:
    """Door-to-door minutes of every single-bus trip from xy leaving at `tick`, ridden by rider_trip()."""
    out = {}
    for line in LINES.values():
        for a in line.stops:
            for b in line.stops:
                if a != b:
                    out[line.id, a, b] = rider_trip(town, xy, place_id, tick, line.id, a, b)["arrive"] - tick
    return out


class LapTest(unittest.TestCase):
    def test_laps_are_52_minutes_and_buses_run_13_apart(self):
        for line in LINES.values():
            self.assertEqual(len(line.lap), 52)
            self.assertEqual(line.every, 13)
            ids = [line.id + letter for letter in "abcd"]
            for t in range(0, 3 * 52):
                for here, ahead in zip(ids, ids[1:]):
                    self.assertEqual(transit.bus_xy(ahead, t), transit.bus_xy(here, t + 13), (here, ahead, t))
                for bus in ids:
                    self.assertEqual(transit.bus_xy(bus, t), transit.bus_xy(bus, t + 52))
            # Bus a sets off from the depot corner at tick 0 and is back there 52 minutes later, not before.
            self.assertEqual(transit.bus_xy(ids[0], 0), (3, 25))
            self.assertEqual([t for t in range(1, 53) if transit.bus_xy(ids[0], t) == (3, 25)], [52])

    def test_buses_drive_the_route_in_order(self):
        for line in LINES.values():
            index = {tile: i for i, tile in enumerate(line.route)}
            seen = []
            for t in range(52):
                here = index[transit.bus_xy(line.id + "a", t)]
                ahead = index[transit.bus_xy(line.id + "a", t + 1)]
                self.assertTrue(0 <= (ahead - here) % len(line.route) <= transit.SPEED, (line.id, t))
                seen.append(here)
            self.assertEqual(sum((b - a) % len(line.route) for a, b in zip(seen, seen[1:] + seen[:1])), 152)
            # It stops on every stop for exactly 2 minutes a lap and skips none.
            for sid in line.stops:
                self.assertEqual(sum(1 for t in range(52) if transit.bus_xy(line.id + "a", t) == STOP_XY[sid]), 2)

    def test_bus_rows_are_a_pure_function_of_the_tick(self):
        ticks = list(range(0, 2 * 1440, 7)) + [18240]
        first = {t: transit.bus_rows(t) for t in ticks}
        for t in reversed(ticks):  # in any order, any number of times
            self.assertEqual(transit.bus_rows(t), first[t])
        for t in ticks:
            rows = first[t]
            self.assertEqual([r["id"] for r in rows], list(BUS_IDS))
            self.assertEqual(rows, transit.bus_rows(t + 52))
            self.assertEqual(json.loads(json.dumps(rows)), rows)
            for row in rows:
                self.assertEqual(set(row), ROW_KEYS)
                line = LINES[row["line"]]
                self.assertEqual(row["id"][:-1], row["line"])
                xy = (row["x"], row["y"])
                self.assertEqual(xy, transit.bus_xy(row["id"], t))
                i = line.route.index(xy)
                nxt = line.route[(i + 1) % len(line.route)]
                self.assertEqual(HEADINGS[row["dir"]], (nxt[0] - xy[0], nxt[1] - xy[1]))
                self.assertEqual(row["at_stop"], STOP_AT.get(xy))
                self.assertEqual(row["riders"], 0)
        self.assertEqual(sorted({r["id"] for r in transit.bus_rows(0)}), sorted(BUS_IDS))
        self.assertEqual(BUS_IDS, ("1a", "1b", "1c", "1d", "2a", "2b", "2c", "2d"))

    def test_riders_are_counted_from_the_agents(self):
        agents = [SimpleNamespace(riding=r) for r in ("1a", "1a", "2c", None, "1a", None)]
        rows = {r["id"]: r["riders"] for r in transit.bus_rows(400, agents)}
        self.assertEqual(rows, {"1a": 3, "1b": 0, "1c": 0, "1d": 0, "2a": 0, "2b": 0, "2c": 1, "2d": 0})
        self.assertEqual({r["id"]: r["riders"] for r in transit.bus_rows(400, iter(agents))}, rows)
        # The rest of the row does not depend on who rides.
        strip = lambda rs: [{k: v for k, v in r.items() if k != "riders"} for r in rs]  # noqa: E731
        self.assertEqual(strip(transit.bus_rows(400, agents)), strip(transit.bus_rows(400)))

    def test_a_dead_rider_rides_nothing(self):
        rider = SimpleNamespace(riding="2b")
        self.assertEqual(transit.bus_rows(10, [rider])[5]["riders"], 1)
        rider.riding = None  # what _die does
        self.assertEqual(transit.bus_rows(10, [rider])[5]["riders"], 0)


class DoorsTest(unittest.TestCase):
    def test_doors_open_while_a_bus_stands_at_the_stop(self):
        for line in LINES.values():
            for sid in line.stops:
                opened = []
                for t in range(52):
                    standing = [r for r in transit.bus_rows(t) if r["line"] == line.id and r["at_stop"] == sid]
                    self.assertEqual(transit.doors_open(line.id, sid, t), bool(standing), (line.id, sid, t))
                    self.assertEqual(transit.bus_at_stop(line.id, sid, t), standing[0]["id"] if standing else None)
                    if standing:
                        opened.append(t)
                self.assertEqual(len(opened), 4 * 2, (line.id, sid))  # 4 buses, 2 minutes each
                gaps = [(b - a) % 52 for a, b in zip(opened, opened[1:] + opened[:1])]
                self.assertEqual(sorted(gaps), [1, 1, 1, 1, 12, 12, 12, 12])  # never shut for more than 11 minutes
                # Line.doors is the minute bus a stands there for the second time in its lap.
                doors = line.doors[sid]
                self.assertTrue(transit.doors_open(line.id, sid, doors))
                self.assertTrue(transit.doors_open(line.id, sid, doors - 1))
                self.assertEqual(transit.bus_at_stop(line.id, sid, doors), line.id + "a")

    def test_unknown_lines_and_stops(self):
        with self.assertRaises(KeyError):
            transit.doors_open("3", "school", 0)
        with self.assertRaises(KeyError):
            transit.doors_open("1", "nowhere", 0)

    def test_ride_minutes(self):
        # city.md section 7.5's example rides.
        self.assertEqual(transit.ride_minutes("1", "maple_west", "downtown_east"), 13)
        self.assertEqual(transit.ride_minutes("1", "eastgate_north", "school_north"), 12)
        self.assertEqual(transit.ride_minutes("2", "eastgate_north", "downtown_west"), 16)
        for line in LINES.values():
            for a in line.stops:
                for b in line.stops:
                    if a != b:
                        self.assertEqual(transit.ride_minutes(line.id, a, b), (line.doors[b] - line.doors[a]) % 52)


class FareTest(unittest.TestCase):
    def test_fares_by_age(self):
        self.assertEqual(transit.BUS_FARE, 2)
        self.assertEqual({age: transit.fare(age) for age in (0, 5, 11, 17, 18, 30, 64, 65, 70, 99)},
                         {0: 0, 5: 0, 11: 0, 17: 0, 18: 2, 30: 2, 64: 2, 65: 0, 70: 0, 99: 0})

    def test_a_rider_boards_rides_alights_and_pays_once(self):
        town = build_map(SEED)
        start = town.places["main_13"].entry  # Rina's house, 45 minutes' walk from City Hospital
        for tick in range(400, 400 + 13):
            trip = transit.best_trip(town, start, "hospital", tick)
            minutes, line, board, alight = trip
            log = rider_trip(town, start, "hospital", tick, line, board, alight)
            self.assertEqual(log["fares"], 1)
            self.assertEqual(log["arrive"] - tick, minutes)
            ticks = [t for t, _ in log["riding_ticks"]]
            self.assertEqual(ticks, list(range(log["boarded"], log["alighted"] + 1)))
            self.assertEqual(log["riding_ticks"][0][1], STOP_XY[board])
            self.assertEqual(log["riding_ticks"][-1][1], STOP_XY[alight])
            for t, where in log["riding_ticks"]:  # the rider's tile is the bus's tile
                self.assertEqual(where, transit.bus_xy(log["bus"], t))
            self.assertEqual(log["bus"][:-1], line)
            self.assertLessEqual(log["boarded"] - (tick + len(town.path(start, STOP_XY[board]))), 11)


class BestTripTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = build_map(SEED)

    CASES = [("main_13", "hospital"), ("birch_court", "office"), ("cedar_court", "school"), ("park_13", "school"),
             ("park_21", "office"), ("main_20", "office")]

    def test_best_trip_is_exact(self):
        """Leaving at any minute, best_trip is the fastest trip a rider really makes, or None when no trip
        saves 5 minutes over walking."""
        for home, place in self.CASES:
            start = self.town.places[home].entry
            walk = self.town.walk_minutes(start, place)
            for tick in range(600, 600 + transit.PERIOD):
                with self.subTest(home=home, place=place, tick=tick):
                    trips = every_trip(self.town, start, place, tick)
                    fastest = min(trips.values())
                    got = transit.best_trip(self.town, start, place, tick)
                    if got is None:
                        self.assertGreater(fastest, walk - transit.MIN_SAVING)
                        continue
                    minutes, line, board, alight = got
                    self.assertEqual(minutes, fastest)
                    self.assertEqual(trips[line, board, alight], minutes)
                    self.assertLessEqual(minutes, walk - transit.MIN_SAVING)
                    # Ties go to line 1, then to the board stop the line reaches first.
                    first = min((k for k, v in trips.items() if v == fastest),
                                key=lambda k: (list(LINES).index(k[0]), LINES[k[0]].stops.index(k[1])))
                    self.assertEqual((line, board), first[:2])

    def test_the_timetable_repeats_every_13_minutes(self):
        start = self.town.places["main_13"].entry
        for tick in range(0, 13):
            self.assertEqual(transit.best_trip(self.town, start, "hospital", tick),
                             transit.best_trip(self.town, start, "hospital", tick + 13 * 111))

    def test_worst_is_the_slowest_departure_minute(self):
        for home, place in self.CASES:
            start = self.town.places[home].entry
            walk = self.town.walk_minutes(start, place)
            fastest = [min(every_trip(self.town, start, place, t).values()) for t in range(transit.PERIOD)]
            worst = transit.best_trip(self.town, start, place, 0, worst=True)
            with self.subTest(home=home, place=place):
                if max(fastest) > walk - transit.MIN_SAVING:
                    self.assertIsNone(worst)
                    continue
                self.assertEqual(worst[0], max(fastest))
                t = fastest.index(max(fastest))
                self.assertEqual(worst, transit.best_trip(self.town, start, place, t))
                for tick in (0, 5, 777, 18240):  # the tick does not matter
                    self.assertEqual(transit.best_trip(self.town, start, place, tick, worst=True), worst)
                    now = transit.best_trip(self.town, start, place, tick)
                    self.assertIsNotNone(now)
                    self.assertLessEqual(now[0], worst[0])

    def test_worst_is_never_slower_than_the_longest_wait(self):
        """At one stop the longest wait is 11 minutes: a bus every 13 minutes, standing there 2."""
        for home, place in self.CASES:
            start = self.town.places[home].entry
            worst = transit.best_trip(self.town, start, place, 0, worst=True)
            if worst is None:
                continue
            _, line, board, alight = worst
            longest = (len(self.town.path(start, STOP_XY[board])) + 11 + transit.ride_minutes(line, board, alight)
                       + self.town.walk_minutes(STOP_XY[alight], place))
            self.assertLessEqual(worst[0], longest)

    def test_city_examples(self):
        def trip(home, place, worst=False):
            return transit.best_trip(self.town, self.town.places[home].entry, place, 400, worst)
        self.assertEqual(trip("main_13", "hospital"), (20, "1", "maple_west", "downtown_east"))
        self.assertEqual(trip("main_13", "hospital", worst=True)[0], 31)
        self.assertEqual(trip("birch_court", "office", worst=True)[0], 29)
        self.assertEqual(trip("cedar_court", "school", worst=True)[1:], ("1", "eastgate_north", "school_north"))

    def test_no_bus_for_short_walks_or_from_inside(self):
        office = self.town.places["office"].entry
        self.assertIsNone(transit.best_trip(self.town, office, "office", 0))
        self.assertIsNone(transit.best_trip(self.town, office, "cafe", 0))
        self.assertIsNone(transit.best_trip(self.town, office, "cafe", 0, worst=True))
        self.assertIsNone(transit.best_trip(self.town, (31, 28), "hospital", 0))  # a building tile
        self.assertIsNone(transit.best_trip(self.town, (-5, 3), "hospital", 0))

    def test_best_trip_reads_the_town_it_is_given(self):
        town = build_map(SEED)
        start = town.places["main_13"].entry
        town.memo.pop(("transit_worst", start, "hospital"), None)
        worst = transit.best_trip(town, start, "hospital", 0, worst=True)
        self.assertEqual(town.memo[("transit_worst", start, "hospital")], worst)
        self.assertEqual(transit.best_trip(town, list(start), "hospital", 0, worst=True), worst)
        self.assertLess(self.town.walk_minutes(start, "hospital"), UNREACHABLE)


if __name__ == "__main__":
    unittest.main()
