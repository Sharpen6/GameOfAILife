"""The engine seams: the event chronicle, the city counters, travel helpers and the bus data.

These modules are pure and import nothing from the simulation, so most tests drive them with small fakes
that implement only what PLAN 3.10 says they read (`town.walk_minutes`, `town.places`, `clock.hour`, an
agent's tile, job and car). The last class checks them against the real 80 x 50 town once it exists.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

from gameofailife import chronicle, stats, transit, travel
from gameofailife import town as town_module
from gameofailife.chronicle import EVENT_TAGS, TOPIC_OF_TAG
from gameofailife.stats import COUNTERS, CityStats

PACKAGE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "gameofailife")

# PLAN section 4.1: the roads of the 80 x 50 map.
ROAD_ROWS = (3, 14, 25, 36)
ROAD_COLS = (3, 16, 29, 42, 55, 68)

# PLAN section 3.7, transcribed: tag -> (kind, importance). The reserved tags' kinds are the chronicle's choice.
PLAN_TAGS = {
    "death": ("death", 2), "hospital": ("health", 2), "discharged": ("health", 1),
    "injury": ("outcome", 1), "big_money": ("outcome", 2), "money_swing": ("outcome", 1), "outcome": ("outcome", 0),
    "goal_reached": ("goal", 2), "saving": ("money", 0), "bills_paid": ("money", 0), "pension": ("money", 0),
    "in_the_red": ("money", 1), "in_the_red_again": ("money", 2), "hardship": ("money", 1),
    "help_given": ("money", 2), "car_sold": ("money", 1), "stuff_sold": ("money", 1), "richest": ("money", 2),
    "first_meet": ("social", 1), "new_friend": ("social", 2), "falling_out": ("social", 2), "invite": ("social", 0),
    "invite_accepted": ("social", 1), "invite_declined": ("social", 0), "meetup": ("social", 0),
    "family_dinner": ("social", 1), "errand": ("social", 0), "call": ("social", 0), "text": ("message", 0),
    "weather": ("weather", 0), "closed": ("life", 0),
    "home_bought": ("home", 2), "home_rented": ("home", 2), "evicted": ("home", 2), "forced_sale": ("home", 2),
    "nowhere_to_go": ("home", 2), "home_listed": ("home", 2), "neglect": ("home", 2), "falling_apart": ("home", 2),
    "shabby": ("home", 1), "restored": ("home", 1), "too_late": ("home", 1), "emergency": ("home", 1),
    "emergency_settled": ("home", 0), "repaint": ("home", 0), "damp_chill": ("health", 1),
    "controller_joined": ("controller", 1), "controller_left": ("controller", 1),
    "came_of_age": ("life", 1), "other": ("life", 0),
    # v3 PLAN 3.1: the 21 new tags
    "talk": ("social", 0), "flirt": ("social", 0), "rival": ("social", 1), "row": ("social", 1),
    "moved_in": ("family", 2), "engaged": ("family", 2), "divorce": ("family", 2), "expecting": ("family", 1),
    "ill": ("health", 1), "recovered": ("health", 0), "doctor": ("health", 0), "chronic": ("health", 1),
    "raise": ("work", 1), "warning": ("work", 1), "quit": ("work", 1),
    "expense": ("money", 1), "windfall": ("money", 1), "loan": ("money", 1),
    "arrived": ("life", 1), "left_town": ("life", 1), "digest": ("life", 1),
}
RESERVED = ("job_new", "job_lost", "promotion", "retired", "partner", "breakup", "wedding", "birth", "moved_out")

# Every self.event(...) call in sim.py and server.py at the review-fix merge (26e71f1): where, today's kind, the
# tag it gets. The P0 integration tags them mechanically from this list (forks.py has no event calls).
CALL_SITES = [
    ("_roll_weather", "weather", "weather"),
    ("_charge_rent: rent and bills", "money", "bills_paid"),
    ("_charge_rent: behind on money", "money", "in_the_red"),
    ("_pay_pensions", "money", "pension"),
    ("_next: very unwell", "health", "hospital"),
    ("_find_shut", "life", "closed"),
    ("_end_activity: hospital", "health", "discharged"),
    ("_die", "death", "death"),
    ("_apply_outcome", "outcome", "outcome"),  # or whatever outcome_tag gives: injury, big_money, money_swing
    ("_meet_someone", "social", "first_meet"),
    ("_apply_extra: invite accept", "social", "invite_accepted"),
    ("_apply_extra: invite decline/later/ignore", "social", "invite_declined"),
    ("_apply_extra: save, goal bought", "goal", "goal_reached"),
    ("_apply_extra: save toward goal", "money", "saving"),
    ("_apply_extra: save, no goal", "money", "saving"),
    ("_apply_extra: ask_shop", "social", "errand"),
    ("_apply_extra: call", "social", "call"),
    ("_apply_extra: family", "social", "family_dinner"),
    ("_host_waits", "social", "meetup"),
    ("invite", "social", "invite"),
    ("send_message", "message", "text"),
    ("server hello: is now played by", "controller", "controller_joined"),
]


class TestImports(unittest.TestCase):
    def test_seam_modules_import_nothing_from_the_engine(self):
        """sim.py imports these modules, so none of them may import sim (or town, forks, server) back."""
        code = ("import sys, types; pkg = types.ModuleType('gameofailife'); pkg.__path__ = [sys.argv[1]]; "
                "sys.modules['gameofailife'] = pkg; "
                "import gameofailife.chronicle, gameofailife.stats, gameofailife.travel, gameofailife.transit; "
                "print(' '.join(sorted(m for m in sys.modules if m.startswith('gameofailife'))))")
        out = subprocess.run([sys.executable, "-c", code, PACKAGE_DIR], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.split(), ["gameofailife", "gameofailife.chronicle", "gameofailife.stats",
                                              "gameofailife.transit", "gameofailife.travel"])


class TestChronicle(unittest.TestCase):
    def test_every_plan_tag_with_its_kind_and_importance(self):
        for tag, spec in PLAN_TAGS.items():
            self.assertEqual(EVENT_TAGS.get(tag), spec, tag)
        for tag in RESERVED:
            kind, importance = EVENT_TAGS[tag]
            self.assertEqual(importance, 2, tag)
            self.assertIsInstance(kind, str)
        self.assertEqual(set(EVENT_TAGS), set(PLAN_TAGS) | set(RESERVED))

    def test_table_values(self):
        for tag, (kind, importance) in EVENT_TAGS.items():
            self.assertRegex(tag, r"^[a-z_]+$")
            self.assertIsInstance(kind, str)
            self.assertIn(importance, (0, 1, 2), tag)
            self.assertEqual(chronicle.kind_of(tag), kind)
            self.assertEqual(chronicle.importance_of(tag), importance)

    def test_unknown_tag_is_refused(self):
        with self.assertRaises(KeyError):
            chronicle.importance_of("rent_paid")  # renamed bills_paid
        with self.assertRaises(KeyError):
            chronicle.kind_of("nope")
        with self.assertRaises(KeyError):
            chronicle.make_event(1, 0, "Day 1 Mon 00:00", "x", tag="nope")
        # The tag is checked even when the call names the kind, the importance or both.
        for kw in ({"kind": "life"}, {"importance": 0}, {"kind": "life", "importance": 0}):
            with self.assertRaises(KeyError, msg=kw):
                chronicle.make_event(1, 0, "Day 1 Mon 00:00", "x", tag="nope", **kw)
        event = chronicle.make_event(1, 0, "Day 1 Mon 00:00", "x", tag="controller_left", kind="controller",
                                     importance=0)  # a single release
        self.assertEqual((event["tag"], event["kind"], event["importance"]), ("controller_left", "controller", 0))

    def test_thresholds(self):
        self.assertEqual((chronicle.BIG_MONEY, chronicle.MONEY_SWING, chronicle.INJURY), (150, 40, -8))
        self.assertEqual((chronicle.FRIEND_AT, chronicle.RIFT_AT, chronicle.RIFT_GAP_DAYS), (40, 0, 7))

    def test_every_existing_call_site_keeps_its_kind(self):
        """Tagging today's calls changes no event's kind, so `kind=` can be dropped from them."""
        for where, kind, tag in CALL_SITES:
            self.assertEqual(EVENT_TAGS[tag][0], kind, where)
        self.assertNotIn("other", {tag for _, _, tag in CALL_SITES})

    def test_outcome_tag(self):
        cases = [
            ({}, "outcome"),
            ({"energy": 10}, "outcome"),
            ({"money": 10}, "outcome"),
            ({"money": 39.99}, "outcome"),
            ({"money": 40}, "money_swing"),
            ({"money": -40}, "money_swing"),
            ({"money": 50, "fun": 15}, "money_swing"),
            ({"money": 149}, "money_swing"),
            ({"money": -150, "fun": -10}, "big_money"),
            ({"money": 150}, "big_money"),
            ({"hh_money": -200}, "big_money"),
            ({"hh_money": 45}, "money_swing"),
            ({"money": 100, "hh_money": 60}, "big_money"),  # the two add up
            ({"money": 100, "hh_money": -100}, "outcome"),
            ({"health": -7}, "outcome"),
            ({"health": -8, "fun": -6}, "injury"),
            ({"health": -10, "fun": -10}, "injury"),
            ({"health": 12}, "outcome"),
            ({"health": -10, "money": -50}, "injury"),  # same importance: the injury wins
            ({"health": -10, "money": -150}, "big_money"),  # the bigger news wins
            ({("rel", "dana"): -6, "memory": "Got in late.", "meet_new": True, "delay": 60}, "outcome"),
            ({"money": True}, "outcome"),
        ]
        for effects, tag in cases:
            self.assertEqual(chronicle.outcome_tag(effects), (tag, EVENT_TAGS[tag][1]), effects)

    def test_money_suffix(self):
        self.assertEqual(chronicle.money_suffix(-150), " (−$150)")
        self.assertEqual(chronicle.money_suffix(50), " (+$50)")
        self.assertEqual(chronicle.money_suffix(1400), " (+$1,400)")
        self.assertEqual(chronicle.money_suffix(-44900.0), " (−$44,900)")
        self.assertEqual(chronicle.money_suffix(2.5), " (+$3)")  # floor(x + 0.5), not banker's rounding
        self.assertEqual(chronicle.money_suffix(-0.5), " (−$1)")
        self.assertEqual(chronicle.money_suffix(0), "")
        self.assertEqual(chronicle.money_suffix(0.4), "")
        self.assertEqual(chronicle.money_suffix(-0.4), "")

    def test_outcome_event_texts(self):
        self.assertEqual(chronicle.outcome_event("Dana Cohen", "Minor fender bender", {"money": -150, "fun": -10}),
                         ("Dana Cohen: Minor fender bender (−$150).", "big_money", 2))
        self.assertEqual(chronicle.outcome_event("Tom Levi", "Gets food poisoning", {"health": -10, "fun": -10}),
                         ("Tom Levi: Gets food poisoning.", "injury", 1))
        self.assertEqual(chronicle.outcome_event("Ari Ben-David", "Makes a breakthrough", {"fun": 15, "money": 50}),
                         ("Ari: Makes a breakthrough (+$50).", "money_swing", 1))
        self.assertEqual(chronicle.outcome_event("Ari Ben-David", "Sleeps deeply", {"energy": 10}),
                         ("Ari: Sleeps deeply.", "outcome", 0))
        self.assertEqual(chronicle.outcome_event("Dana Cohen", "Finds a great sale", {"money": 10}),
                         ("Dana: Finds a great sale (+$10).", "outcome", 0))

    def test_topics(self):
        topics = [t for t, _ in chronicle.TOPICS]
        self.assertEqual(topics, ["homes", "money", "people", "health", "ai"])
        self.assertEqual(set(TOPIC_OF_TAG), set(EVENT_TAGS))
        for tag, topic in TOPIC_OF_TAG.items():
            self.assertTrue(topic is None or topic in topics, tag)
        for tag, (kind, _) in EVENT_TAGS.items():
            if kind == "home":
                self.assertEqual(TOPIC_OF_TAG[tag], "homes", tag)
            if kind in ("money", "goal"):
                self.assertEqual(TOPIC_OF_TAG[tag], "money", tag)
            if kind in ("social", "message"):
                self.assertEqual(TOPIC_OF_TAG[tag], "people", tag)
            if kind in ("health", "death"):
                self.assertEqual(TOPIC_OF_TAG[tag], "health", tag)
            if kind == "controller":
                self.assertEqual(TOPIC_OF_TAG[tag], "ai", tag)
        self.assertEqual(TOPIC_OF_TAG["injury"], "health")
        self.assertEqual(TOPIC_OF_TAG["big_money"], "money")
        self.assertEqual(TOPIC_OF_TAG["money_swing"], "money")
        for tag in ("outcome", "weather", "closed", "other"):
            self.assertIsNone(TOPIC_OF_TAG[tag], tag)

    def test_god_only_tags(self):
        self.assertEqual(chronicle.GOD_ONLY_TAGS, {"richest", "controller_joined", "controller_left"})
        self.assertEqual(chronicle.FULL_NAME_TAGS, {"big_money", "injury"})
        self.assertTrue(chronicle.GOD_ONLY_TAGS <= set(EVENT_TAGS))

    def test_make_event(self):
        ev = chronicle.make_event(5321, 18240, "Day 13 Sat 16:00", "Dana Cohen and Lea Tal have become friends.",
                                  tag="new_friend", agent="dana", agents=["lea", "dana"], place="cafe", at=(33, 26))
        self.assertEqual(ev, {"seq": 5321, "tick": 18240, "time": "Day 13 Sat 16:00", "kind": "social",
                              "tag": "new_friend", "importance": 2, "major": True,
                              "text": "Dana Cohen and Lea Tal have become friends.", "agent": "dana",
                              "agents": ["dana", "lea"], "place": "cafe", "at": [33, 26]})
        self.assertEqual(list(ev), ["seq", "tick", "time", "kind", "tag", "importance", "major", "text", "agent",
                                    "agents", "place", "at"])
        json.dumps(ev)
        quiet = chronicle.make_event(2, 9, "Day 1 Mon 06:09", "claude stopped playing Dana.", tag="controller_left",
                                     importance=0, agents=["dana"])
        self.assertEqual((quiet["kind"], quiet["importance"], quiet["major"]), ("controller", 0, False))
        self.assertEqual((quiet["agent"], quiet["agents"], quiet["place"], quiet["at"]), (None, ["dana"], None, None))
        rain = chronicle.make_event(3, 10, "Day 1 Mon 06:10", "It starts to rain.", tag="weather", kind="weather")
        self.assertEqual((rain["agents"], rain["importance"], rain["major"]), ([], 0, False))
        dying = chronicle.make_event(4, 11, "t", "x", tag="death", agent="david")
        self.assertEqual((dying["kind"], dying["agents"], dying["major"]), ("death", ["david"], True))

    def test_on_affinity_is_a_no_op(self):
        sim = SimpleNamespace(events=[])
        self.assertIsNone(chronicle.on_affinity(sim, "dana", "lea", 38.0, 41.0))
        self.assertEqual(sim.events, [])


class TestCityStats(unittest.TestCase):
    def test_counters(self):
        self.assertEqual(COUNTERS, ("asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "habit",
                                    "default"))
        s = CityStats()
        for block in (s.today, s.total):
            self.assertEqual(block, {**{c: 0 for c in COUNTERS}, "seconds": 0.0})
        s.count("asked")
        s.count("asked")
        s.count("in_time", seconds=2.5)
        s.count("in_time", seconds=1.0)
        s.count("habit")
        self.assertEqual((s.today["asked"], s.today["in_time"], s.today["habit"], s.today["timeouts"]), (2, 2, 1, 0))
        self.assertEqual(s.today["seconds"], 3.5)
        self.assertEqual(s.total, s.today)
        self.assertIsNot(s.total, s.today)
        self.assertEqual(stats.avg_seconds(s.today), 1.8)  # 1.75 rounds half up

    def test_reset_day_keeps_the_totals(self):
        s = CityStats()
        s.count("asked")
        s.count("in_time", seconds=4.0)
        s.count("against_habit")
        s.reset_day()
        self.assertEqual(s.today, {**{c: 0 for c in COUNTERS}, "seconds": 0.0})
        self.assertEqual((s.total["asked"], s.total["in_time"], s.total["against_habit"], s.total["seconds"]),
                         (1, 1, 1, 4.0))
        s.count("timeouts")
        self.assertEqual((s.today["timeouts"], s.total["timeouts"]), (1, 1))

    def test_avg_seconds(self):
        self.assertIsNone(stats.avg_seconds(CityStats().today))
        s = CityStats()
        s.count("in_time", seconds=2.25)
        self.assertEqual(stats.avg_seconds(s.today), 2.3)
        s.count("in_time", seconds=0.0)
        self.assertEqual(stats.avg_seconds(s.today), 1.1)

    def test_bad_counts_are_refused(self):
        s = CityStats()
        with self.assertRaises(KeyError):
            s.count("timeout")  # the counter is "timeouts"
        with self.assertRaises(ValueError):
            s.count("late", seconds=6.2)
        self.assertEqual(s.total, {**{c: 0 for c in COUNTERS}, "seconds": 0.0})

    def test_decided_by_names_a_counter(self):
        self.assertEqual(set(stats.DECIDED_BY), {"habit", "default", "model", "timeout", "withdrawn"})
        for by, name in stats.DECIDED_BY.items():
            self.assertIn(name, COUNTERS, by)
        self.assertEqual(stats.DECIDED_BY["model"], "in_time")
        self.assertEqual(stats.DECIDED_BY["timeout"], "timeouts")

    def test_sample_is_a_no_op(self):
        s = CityStats()
        self.assertIsNone(s.sample(SimpleNamespace()))
        self.assertEqual(s.today, CityStats().today)


class TestTransit(unittest.TestCase):
    LINE1 = ["maple_west", "school", "downtown_west", "downtown_east", "eastgate_south", "eastgate_north",
             "hilltop_east", "city_hall", "school_north", "maple_park", "maple_north"]
    DOORS = {  # city.md section 7.5
        "1": {"maple_west": 3, "school": 9, "downtown_west": 12, "downtown_east": 16, "eastgate_south": 20,
              "eastgate_north": 28, "hilltop_east": 32, "city_hall": 37, "school_north": 40, "maple_park": 43,
              "maple_north": 47},
        "2": {"maple_north": 6, "maple_park": 10, "school_north": 13, "city_hall": 16, "hilltop_east": 21,
              "eastgate_north": 25, "eastgate_south": 33, "downtown_east": 37, "downtown_west": 41, "school": 44,
              "maple_west": 50},
    }

    def test_constants(self):
        self.assertEqual((transit.BUS_FARE, transit.SPEED, transit.DWELL, transit.BUSES_PER_LINE), (2, 4, 1, 4))
        self.assertEqual(list(transit.LINES), ["1", "2"])

    def test_stops(self):
        self.assertEqual(len(transit.STOPS), 11)
        self.assertEqual([s[0] for s in transit.STOPS], self.LINE1)
        self.assertEqual(dict((sid, xy) for sid, _, xy in transit.STOPS), {
            "maple_west": (10, 25), "school": (28, 25), "downtown_west": (36, 25), "downtown_east": (48, 25),
            "eastgate_south": (60, 25), "eastgate_north": (60, 14), "hilltop_east": (49, 14),
            "city_hall": (36, 14), "school_north": (28, 14), "maple_park": (21, 14), "maple_north": (10, 14)})
        self.assertEqual(len({xy for _, _, xy in transit.STOPS}), 11)
        self.assertEqual(len({name for _, name, _ in transit.STOPS}), 11)
        for sid, name, (x, y) in transit.STOPS:
            self.assertIn(y, (14, 25), sid)  # Park Avenue or Main Street, both on the loop
            self.assertIn(y, ROAD_ROWS)
            self.assertTrue(3 < x < 68, sid)
            self.assertNotIn(x, ROAD_COLS, f"{sid} sits on a junction")
            self.assertFalse(sid.isdigit())
            self.assertEqual(transit.STOP_XY[sid], (x, y))
            self.assertEqual(transit.STOP_AT[x, y], sid)

    def test_routes_are_the_loop(self):
        loop = None
        for line in transit.LINES.values():
            route = line.route
            self.assertEqual(len(route), 152, line.id)
            self.assertEqual(len(set(route)), 152)
            self.assertEqual(route[0], (3, 25))
            self.assertEqual(line.corners[0], (3, 25))
            for (x0, y0), (x1, y1) in zip(route, route[1:] + route[:1]):
                self.assertEqual(abs(x1 - x0) + abs(y1 - y0), 1, (x0, y0))
            for x, y in route:
                self.assertTrue((y in (14, 25) and 3 <= x <= 68) or (x in (3, 68) and 14 <= y <= 25), (x, y))
            for x, y in line.corners:
                self.assertTrue(x in ROAD_COLS and y in ROAD_ROWS, (x, y))
                self.assertIn((x, y), route)
            if loop is None:
                loop = route
        self.assertEqual(transit.LINES["1"].route[1], (4, 25))  # east on Main Street
        self.assertEqual(transit.LINES["2"].route[1], (3, 24))  # north on Willow Lane
        self.assertEqual(transit.LINES["2"].route, (loop[0],) + loop[:0:-1])

    def test_laps_and_doors(self):
        for line in transit.LINES.values():
            self.assertEqual(len(line.lap), 52, line.id)
            self.assertEqual(line.every, 13)
            self.assertEqual(line.lap[0], 0)
            for a, b in zip(line.lap, line.lap[1:]):
                self.assertTrue(0 <= b - a <= transit.SPEED, (a, b))
            self.assertEqual(line.doors, self.DOORS[line.id])
            self.assertEqual(list(line.stops), sorted(line.doors, key=line.doors.get))
        self.assertEqual(list(transit.LINES["1"].stops), self.LINE1)
        self.assertEqual(list(transit.LINES["2"].stops), self.LINE1[::-1])
        doors1, doors2 = self.DOORS["1"], self.DOORS["2"]
        # city.md's example rides: doors open at the boarding stop to doors open at the alighting stop.
        self.assertEqual(doors1["downtown_east"] - doors1["maple_west"], 13)
        self.assertEqual(doors1["school_north"] - doors1["eastgate_north"], 12)
        self.assertEqual(doors2["downtown_west"] - doors2["eastgate_north"], 16)

    def test_timetable_json(self):
        tt = transit.timetable_json()
        self.assertEqual(set(tt), {"bus", "flights"})
        self.assertEqual(set(tt["bus"]), {"lines"})
        self.assertEqual(tt["flights"], ["08:00 Riverton to Lakeside", "14:00 Riverton to Lakeside",
                                         "20:00 Riverton to Lakeside"])
        one, two = tt["bus"]["lines"]
        self.assertEqual(one, {"id": "1", "name": "No. 1 (clockwise: Main Street east, Park Avenue west)",
                               "corners": [[3, 25], [68, 25], [68, 14], [3, 14]], "stops": self.LINE1,
                               "lap_minutes": 52, "buses": 4, "every_minutes": 13, "speed": 4, "dwell": 1,
                               "fare": 2})
        self.assertEqual(two["id"], "2")
        self.assertIn("anticlockwise", two["name"])
        self.assertEqual(two["corners"], [[3, 25], [3, 14], [68, 14], [68, 25]])
        self.assertEqual(two["stops"], self.LINE1[::-1])
        self.assertEqual({k: v for k, v in two.items() if k not in ("id", "name", "corners", "stops")},
                         {"lap_minutes": 52, "buses": 4, "every_minutes": 13, "speed": 4, "dwell": 1, "fare": 2})
        self.assertEqual(json.loads(json.dumps(tt)), tt)

    def test_stops_json(self):
        rows = transit.stops_json()
        self.assertEqual(len(rows), 11)
        self.assertEqual(rows[0], {"id": "maple_west", "name": "Maple Grove West", "x": 10, "y": 25,
                                   "lines": ["1", "2"]})
        for row, (sid, name, (x, y)) in zip(rows, transit.STOPS):
            self.assertEqual(row, {"id": sid, "name": name, "x": x, "y": y, "lines": ["1", "2"]})
        self.assertEqual(json.loads(json.dumps(rows)), rows)

    def test_fares(self):
        self.assertEqual([transit.fare(a) for a in (6, 17, 18, 40, 64, 65, 80)], [0, 0, 2, 2, 2, 0, 0])

    def test_p1_buses(self):  # was test_p1_stubs: P1 runs the buses (tests/test_transit.py has the rest)
        for tick in (0, 360, 18240):
            rows = transit.bus_rows(tick)
            self.assertEqual([r["id"] for r in rows], ["1a", "1b", "1c", "1d", "2a", "2b", "2c", "2d"])
            self.assertEqual(rows, transit.bus_rows(tick))
            self.assertIs(transit.doors_open("1", "maple_west", tick), False)  # no bus stands there then
        self.assertIs(transit.doors_open("1", "maple_west", self.DOORS["1"]["maple_west"]), True)
        town = town_module.build_map(1)
        walk = town.walk_minutes((10, 24), "hospital")
        self.assertEqual(transit.best_trip(town, (10, 24), "hospital", 360)[1:], ("1", "maple_west", "downtown_east"))
        self.assertLessEqual(transit.best_trip(town, (10, 24), "hospital", 360, worst=True)[0], walk - 5)


# --- fakes for travel: only what PLAN 3.10 says travel reads ------------------------------------

class FakePlace:
    """The building stands just north of its door: x, y is its corner, as on the real map, not its entry."""

    def __init__(self, place_id: str, kind: str, entry: tuple[int, int], hours: tuple[int, int] | None = None):
        self.id, self.kind, self.entry, self.hours = place_id, kind, entry, hours
        self.x, self.y = entry[0], entry[1] - 1

    def is_open(self, hour: float) -> bool:  # the same rule as town.Place
        return self.hours is None or self.hours[0] <= hour < self.hours[1]


class FakeTown:
    """Walking is the Manhattan distance to a place's entry; places in `cut_off` can't be reached, and
    nobody can walk from a building's corner tile (like a 'B' tile on the real map)."""

    def __init__(self, places: list[FakePlace], cut_off: tuple[str, ...] = ()):
        self.places = {p.id: p for p in places}
        self.cut_off = set(cut_off)
        self.walls = {(p.x, p.y) for p in places}
        self.memo = {}  # P1: transit caches its bus tables on the town

    def walk_minutes(self, xy, place_id: str) -> int:
        assert isinstance(xy, tuple) and len(xy) == 2, xy
        if place_id in self.cut_off or xy in self.walls:
            return 65535
        ex, ey = self.places[place_id].entry
        return abs(xy[0] - ex) + abs(xy[1] - ey)

    # P1 also reads these (PLAN 3.10: drive paths and the walk fields of the bus stops): roads run everywhere
    # with no junctions, and the bus stops are far away up the map, so no bus beats walking here.
    def drive_length(self, xy, place_id: str) -> tuple[int, int]:
        return self.walk_minutes(xy, place_id), 0

    def steps(self, xy, goal) -> int:
        return 65535 if xy in self.walls else abs(xy[0] - goal[0]) + abs(xy[1] - goal[1])


def fake_sim(places: list[FakePlace], hour: float = 12.0, cut_off: tuple[str, ...] = ()):
    # Every fake character lives at the place "home" (on STREET it is at (0, 0)).
    return SimpleNamespace(town=FakeTown(places, cut_off), clock=SimpleNamespace(hour=hour, tick=int(hour * 60)),
                           home_of=lambda agent: "home")


def fake_agent(x: int = 0, y: int = 0, inside: str | None = None, car: bool = False, job=None, age: int = 40):
    return SimpleNamespace(x=x, y=y, inside=inside, owns_car=car, job=job, age=age)


def fake_job(place_id: str = "office", workdays: tuple[int, ...] = (0, 1, 2, 3, 4), wage: float = 30.0):
    return SimpleNamespace(place_id=place_id, workdays=workdays, hourly_wage=wage, start_hour=9, end_hour=17)


# A street along y = 0 with the character's home at x = 0, and a diner up the road at (0, 18).
STREET = [
    FakePlace("home", "home", (0, 0)),
    FakePlace("noodles", "cafe", (4, 0), (11, 24)),
    FakePlace("corner", "cafe", (10, 0), (6, 23)),
    FakePlace("arcade", "shop", (12, 0), (9, 21)),
    FakePlace("diner", "cafe", (0, 18), (6, 22)),
    FakePlace("bakery", "cafe", (20, 0), (6, 18)),
    FakePlace("market", "market", (30, 0), (7, 21)),
    FakePlace("park", "park", (50, 0)),
    FakePlace("office", "office", (10, 0), (7, 20)),
]


def nearest_id(sim, agent, kinds, **kw) -> str | None:
    place = travel.nearest(sim, agent, kinds, **kw)
    return place.id if place else None


class TestTravel(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(travel.SPEEDS, {"walk": 1, "run": 2, "car": 4, "taxi": 4, "ambulance": 4, "bus": 1})
        self.assertEqual((travel.TAXI_FARE, travel.BUS_FARE), (12, 2))
        self.assertEqual(travel.TRIP_COST, {"walk": 0, "car": 2, "bus": 4})

    def test_travel_minutes(self):
        sim, me = fake_sim(STREET), fake_agent()
        expect = {"walk": 10, "run": 5, "car": 3, "taxi": 3, "ambulance": 3, "bus": 10, "hovercraft": 10}
        for mode, minutes in expect.items():
            self.assertEqual(travel.travel_minutes(sim, me, "office", mode), minutes, mode)
            self.assertEqual(travel.travel_minutes(sim, me, "office", mode, worst=True), minutes, mode)
        self.assertEqual(travel.travel_minutes(sim, me, "noodles", "car"), 1)
        self.assertEqual(travel.travel_minutes(sim, me, "home", "walk"), 0)  # standing on the entry
        inside = fake_agent(10, 0, inside="office")
        for mode in travel.SPEEDS:
            self.assertEqual(travel.travel_minutes(sim, inside, "office", mode), 0)
        self.assertEqual(travel.travel_minutes(sim, inside, "bakery", "walk"), 10)
        cut = fake_sim(STREET, cut_off=("office",))
        for mode in travel.SPEEDS:
            self.assertEqual(travel.travel_minutes(cut, me, "office", mode), travel.UNREACHABLE)

    def test_usual_mode_and_commute(self):
        sim = fake_sim(STREET)
        walker, driver = fake_agent(job=fake_job()), fake_agent(car=True, job=fake_job())
        self.assertEqual(travel.usual_mode(sim, walker), "walk")
        self.assertEqual(travel.usual_mode(sim, driver), "car")
        self.assertEqual(travel.commute_minutes(sim, walker), 10)
        self.assertEqual(travel.commute_minutes(sim, driver), 3)
        self.assertIsNone(travel.commute_minutes(sim, fake_agent(age=70)))
        self.assertEqual(travel.commute_minutes(sim, fake_agent(10, 0, inside="office", job=fake_job())), 0)
        pupil = fake_agent(age=9, job=fake_job("market", wage=0.0))
        self.assertEqual(travel.commute_minutes(sim, pupil), 30)

    def test_weekly_commute_cost(self):
        sim = fake_sim(STREET)
        cost = travel.weekly_commute_cost
        self.assertEqual(cost(sim, fake_agent(job=fake_job())), 0)  # walks
        self.assertEqual(cost(sim, fake_agent(car=True, job=fake_job())), 10)  # 5 days x $2
        self.assertEqual(cost(sim, fake_agent(car=True, job=fake_job(workdays=(4, 5, 6)))), 6)
        self.assertEqual(cost(sim, fake_agent(car=True)), 0)  # no job
        self.assertEqual(cost(sim, fake_agent(car=True, age=70)), 0)  # retired
        self.assertEqual(cost(sim, fake_agent(car=True, age=12, job=fake_job(wage=0.0))), 0)  # school is free
        with mock.patch.object(travel, "usual_mode", return_value="bus"):  # P1's usual_mode can pick the bus
            self.assertEqual(cost(sim, fake_agent(job=fake_job())), 20)  # 5 days x 2 rides x $2
            self.assertEqual(cost(sim, fake_agent(age=17, job=fake_job())), 0)
            self.assertEqual(cost(sim, fake_agent(age=65, job=fake_job())), 0)
            self.assertEqual(cost(sim, fake_agent(age=64, job=fake_job(workdays=(0, 2)))), 8)
            self.assertEqual(cost(sim, fake_agent(age=30, job=fake_job(wage=0.0))), 0)

    def test_nearest_open_place(self):
        me = fake_agent()
        self.assertEqual(nearest_id(fake_sim(STREET, 12.0), me, ("cafe",)), "noodles")
        self.assertEqual(nearest_id(fake_sim(STREET, 10.0), me, ("cafe",)), "corner")  # noodles opens at 11
        self.assertEqual(nearest_id(fake_sim(STREET, 10 + 57 / 60), me, ("cafe",)), "noodles")  # open by 11:01
        self.assertEqual(nearest_id(fake_sim(STREET, 5.75), me, ("cafe",)), "diner")  # corner shut at 05:55
        self.assertIsNone(nearest_id(fake_sim(STREET, 3.0), me, ("cafe",)))
        self.assertIsNone(nearest_id(fake_sim(STREET), me, ("hospital",)))
        self.assertEqual(nearest_id(fake_sim(STREET, 12.0), me, ("shop", "market")), "arcade")
        self.assertEqual(nearest_id(fake_sim(STREET, 8.0), me, ("shop", "market")), "market")  # arcade opens at 9
        self.assertEqual(nearest_id(fake_sim(STREET), me, "park"), "park")
        self.assertEqual(nearest_id(fake_sim(STREET, cut_off=("noodles",)), me, ("cafe",)), "corner")
        sim = fake_sim(STREET)
        self.assertIs(travel.nearest(sim, me, ("cafe",)), sim.town.places["noodles"])  # the Place itself

    def test_nearest_counts_the_stay(self):
        cafe = [FakePlace("cafe", "cafe", (15, 0), (6, 21))]
        inside = fake_agent(15, 0, inside="cafe")
        self.assertEqual(nearest_id(fake_sim(cafe, 20.5), inside, ("cafe",), stay=20), "cafe")
        self.assertIsNone(nearest_id(fake_sim(cafe, 20.5), inside, ("cafe",), stay=40))
        self.assertIsNone(nearest_id(fake_sim(cafe, 20.75), fake_agent(), ("cafe",)))  # 15 minutes: in at 21:00
        self.assertEqual(nearest_id(fake_sim(cafe, 20.5), fake_agent(), ("cafe",)), "cafe")
        self.assertEqual(nearest_id(fake_sim(cafe, 20.5), fake_agent(), ("cafe",), stay=14), "cafe")
        self.assertIsNone(nearest_id(fake_sim(cafe, 20.5), fake_agent(), ("cafe",), stay=15))

    def test_nearest_matches_the_open_on_arrival_rule(self):
        """Exactly the review fix's _open_on_arrival: open on arrival and still open `stay` minutes later."""
        me = fake_agent()
        for minute in range(0, 24 * 60, 7):
            hour = minute / 60
            sim = fake_sim(STREET, hour)
            for stay in (0, 15, 20, 40):
                ok = []
                for p in STREET:
                    if p.kind == "cafe":
                        arrive = hour + sim.town.walk_minutes((0, 0), p.id) / 60
                        if p.is_open(arrive) and p.is_open(arrive + stay / 60):
                            ok.append((sim.town.walk_minutes((0, 0), p.id), p.id))
                want = min(ok)[1] if ok else None
                self.assertEqual(nearest_id(sim, me, ("cafe",), stay=stay), want, (minute, stay))

    def test_nearest_inside_a_place(self):
        sim = fake_sim(STREET)
        self.assertEqual(nearest_id(sim, fake_agent(10, 0, inside="corner"), ("cafe",)), "corner")
        self.assertEqual(nearest_id(sim, fake_agent(10, 0), ("cafe",)), "corner")

    def test_nearest_with_meet_and_origin(self):
        sim, me = fake_sim(STREET), fake_agent()
        friend = fake_agent(0, 20)
        self.assertEqual(nearest_id(sim, me, ("cafe",)), "noodles")
        self.assertEqual(nearest_id(sim, me, ("cafe",), meet=friend), "diner")  # 18 + 2 beats 4 + 24
        self.assertEqual(nearest_id(sim, me, ("cafe",), meet=fake_agent(0, 18, inside="diner")), "diner")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin="market"), "bakery")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin=(20, 0)), "bakery")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin=[19, 0]), "bakery")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin="diner"), "diner")
        # On the way to the market every street cafe costs 30 minutes in all; ties go by id.
        self.assertEqual(nearest_id(sim, me, ("cafe",), meet="market"), "bakery")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin="home", meet="market"), "bakery")
        # Opening hours still count from where the character is, not from the origin.
        self.assertEqual(nearest_id(fake_sim(STREET, 10.0), me, ("cafe",), origin=(4, 0)), "corner")

    def test_nearest_from_or_meeting_at_a_place(self):
        """origin and meet may be a Place, such as town.places[job.place_id] or an earlier nearest() result."""
        me = fake_agent()
        for hour in (5.75, 10.0, 12.0, 19.0):
            sim = fake_sim(STREET, hour)
            places = sim.town.places
            for pid in places:
                for kinds in (("cafe",), ("shop", "market"), ("park",)):
                    by_id = nearest_id(sim, me, kinds, origin=pid)
                    self.assertEqual(nearest_id(sim, me, kinds, origin=places[pid]), by_id, (hour, pid, kinds))
                    by_id = nearest_id(sim, me, kinds, meet=pid)
                    self.assertEqual(nearest_id(sim, me, kinds, meet=places[pid]), by_id, (hour, pid, kinds))
                    by_id = nearest_id(sim, me, kinds, origin=pid, meet="office")
                    self.assertEqual(nearest_id(sim, me, kinds, origin=places[pid], meet=places["office"]), by_id)
        sim = fake_sim(STREET)
        places = sim.town.places
        self.assertEqual(nearest_id(sim, me, ("cafe",), meet=places["market"]), "bakery")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin=places["diner"]), "diner")  # 0 from inside it
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin=places["market"]), "bakery")
        cafe = travel.nearest(sim, me, ("cafe",))
        self.assertEqual(cafe.id, "noodles")
        self.assertEqual(nearest_id(sim, me, ("cafe",), origin=cafe), "noodles")  # chained: 0 from inside it
        # From the noodle bar on the way to the office: the arcade (8 + 2) beats the market (26 + 20).
        self.assertEqual(nearest_id(sim, me, ("shop", "market"), origin=cafe, meet=places["office"]), "arcade")

    def test_nearest_refuses_what_it_cannot_walk_from(self):
        sim, me = fake_sim(STREET), fake_agent()
        for where in (42, 4.5, object(), (1, 2, 3), {"x": 0, "y": 0}):
            with self.assertRaises(TypeError, msg=repr(where)):
                travel.nearest(sim, me, ("cafe",), meet=where)
            with self.assertRaises(TypeError, msg=repr(where)):
                travel.nearest(sim, me, ("cafe",), origin=where)
        with self.assertRaises(KeyError):
            travel.nearest(sim, me, ("cafe",), meet="nowhere")


REAL_TOWN = getattr(town_module, "W", 0) == 80 and hasattr(town_module.TownMap, "walk_minutes")


@unittest.skipUnless(REAL_TOWN, "needs the 80 x 50 town with walk fields")
class TestOnTheRealTown(unittest.TestCase):
    """The same helpers against the real map, once P0's town.py is in."""

    @classmethod
    def setUpClass(cls):
        cls.town = town_module.build_map(1)

    def test_bus_data_fits_the_map(self):
        rows = self.town.rows()
        for sid, _, (x, y) in transit.STOPS:
            self.assertEqual(rows[y][x], town_module.ROAD, sid)
            self.assertNotIn((x, y), self.town.junctions, sid)
        for line in transit.LINES.values():
            for x, y in line.route:
                self.assertEqual(rows[y][x], town_module.ROAD, (line.id, x, y))
            for corner in line.corners:
                self.assertIn(tuple(corner), self.town.junctions)

    def test_travel_on_the_map(self):
        home = self.town.places["main_20"]
        sim = SimpleNamespace(town=self.town, clock=SimpleNamespace(hour=12.0))
        me = fake_agent(*home.entry, inside="main_20", car=True, job=fake_job("office"))
        walk = self.town.walk_minutes(tuple(home.entry), "office")
        self.assertTrue(0 < walk < travel.UNREACHABLE)
        self.assertEqual(travel.travel_minutes(sim, me, "office", "walk"), walk)
        tiles, junctions = self.town.drive_length(tuple(home.entry), "office")  # P1: cars keep to the roads
        self.assertEqual(travel.travel_minutes(sim, me, "office", "car"), -(-tiles // 4) + junctions)
        self.assertEqual(travel.commute_minutes(sim, me), -(-tiles // 4) + junctions)
        self.assertEqual(travel.travel_minutes(sim, me, "main_20", "walk"), 0)
        walks = {p.id: self.town.walk_minutes(tuple(home.entry), p.id) for p in self.town.places.values()}
        cafes = sorted((walks[p.id], p.id) for p in self.town.places.values()
                       if p.kind == "cafe" and p.is_open(12.0 + walks[p.id] / 60))
        self.assertTrue(cafes)
        self.assertEqual(travel.nearest(sim, me, ("cafe",)).id, cafes[0][1])
        self.assertEqual(travel.nearest(sim, me, ("park",)).kind, "park")
        for pid in ("office", "hospital", cafes[0][1]):
            place = self.town.places[pid]
            self.assertEqual(travel.nearest(sim, me, ("cafe",), meet=place),
                             travel.nearest(sim, me, ("cafe",), meet=pid))
            self.assertEqual(travel.nearest(sim, me, ("cafe",), origin=place),
                             travel.nearest(sim, me, ("cafe",), origin=pid))
        self.assertIsNotNone(travel.nearest(sim, me, ("cafe",), meet=self.town.places["office"]))


if __name__ == "__main__":
    unittest.main()
