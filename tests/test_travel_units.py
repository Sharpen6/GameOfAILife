"""travel.py on the real seed-1 town: mode-aware minutes, the usual way to work, its weekly cost and nearest.

The engine is not needed: a small fake simulation carries the real town, a clock and home_of, and the
characters are the real seed-1 cast from cast.build_cast (each standing at their home's entry).
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from gameofailife import cast, housing, transit, travel
from gameofailife.town import ROAD, build_map

SEED = 1


def ceil_div(a: int, b: int) -> int:
    return -(-a // b)


class Town:
    """The seed-1 town, homes and cast, built once for the module."""

    town = build_map(SEED)
    homes = housing.build_homes(town)
    agents, households = cast.build_cast(town, homes, SEED)

    @classmethod
    def home_of(cls, agent) -> str:
        return cls.homes[cls.households[agent.household_id].home_id].place


def fake_sim(hour: float = 7.0, tick: int | None = None) -> SimpleNamespace:
    return SimpleNamespace(town=Town.town, home_of=Town.home_of,
                           clock=SimpleNamespace(hour=hour, tick=int(hour * 60) if tick is None else tick))


def person(agent_id: str, **changes) -> SimpleNamespace:
    """A copy of a seed-1 character (at their home's entry) with some fields changed."""
    a = Town.agents[agent_id]
    fields = dict(id=a.id, x=a.x, y=a.y, inside=a.inside, owns_car=a.owns_car, job=a.job, age=a.age,
                  household_id=a.household_id, riding=None)
    fields.update(changes)
    return SimpleNamespace(**fields)


def walk_job(agent) -> int:
    return Town.town.walk_minutes((agent.x, agent.y), agent.job.place_id)


class TravelMinutesTest(unittest.TestCase):
    def test_each_mode(self):
        town = Town.town
        sim = fake_sim()
        for agent_id in ("rina", "dana", "ari", "yaniv", "gil", "hana"):
            me = person(agent_id)
            for place in ("hospital", "office", "school", "works", "cafe", "park", "maple_park", "noodles"):
                with self.subTest(who=agent_id, place=place):
                    start = (me.x, me.y)
                    walk = town.walk_minutes(start, place)
                    drive = town.drive_path(start, place)
                    junctions = sum(1 for t in drive if t in town.junctions)
                    self.assertEqual(travel.travel_minutes(sim, me, place, "walk"), walk)
                    self.assertEqual(travel.travel_minutes(sim, me, place, "run"), ceil_div(walk, 2))
                    self.assertEqual(travel.travel_minutes(sim, me, place, "car"), ceil_div(len(drive), 4) + junctions)
                    self.assertEqual(travel.travel_minutes(sim, me, place, "taxi"), ceil_div(len(drive), 4) + junctions)
                    self.assertEqual(travel.travel_minutes(sim, me, place, "ambulance"), ceil_div(len(drive), 4))
                    self.assertEqual(travel.travel_minutes(sim, me, place, "hovercraft"), walk)
                    trip = transit.best_trip(town, start, place, sim.clock.tick)
                    self.assertEqual(travel.travel_minutes(sim, me, place, "bus"), trip[0] if trip else walk)
                    self.assertEqual(travel.bus_trip(sim, me, place), trip)
                    for mode in travel.SPEEDS:
                        self.assertLessEqual(travel.travel_minutes(sim, me, place, mode), walk)

    def test_cars_keep_to_the_roads_so_they_are_not_simply_walk_over_4(self):
        sim, rina = fake_sim(), person("rina")
        walk = travel.travel_minutes(sim, rina, "hospital", "walk")
        car = travel.travel_minutes(sim, rina, "hospital", "car")
        tiles, junctions = Town.town.drive_length((rina.x, rina.y), "hospital")
        self.assertEqual(walk, 45)
        self.assertGreaterEqual(tiles, walk)
        self.assertGreater(junctions, 0)
        self.assertEqual(car, ceil_div(tiles, 4) + junctions)
        self.assertGreater(car, ceil_div(walk, 4))
        self.assertEqual(travel.travel_minutes(sim, rina, "hospital", "ambulance"), ceil_div(tiles, 4))

    def test_inside_and_unreachable(self):
        sim = fake_sim()
        inside = person("rina", x=49, y=24, inside="hospital")
        for mode in list(travel.SPEEDS) + ["hovercraft"]:
            self.assertEqual(travel.travel_minutes(sim, inside, "hospital", mode), 0)
            self.assertEqual(travel.travel_minutes(sim, inside, "hospital", mode, worst=True), 0)
        self.assertIsNone(travel.bus_trip(sim, inside, "hospital"))
        stuck = person("rina", x=31, y=28, inside=None)  # a building tile: nowhere to walk from
        for mode in travel.SPEEDS:
            self.assertEqual(travel.travel_minutes(sim, stuck, "hospital", mode), travel.UNREACHABLE)

    def test_the_bus_leaving_now(self):
        """A bus trip is the walk to the stop, the wait, the ride and the walk from the stop, leaving now."""
        rina = person("rina")
        start = (rina.x, rina.y)
        seen = set()
        for tick in range(420, 420 + 13):
            sim = fake_sim(tick=tick)
            minutes, line, board, alight = travel.bus_trip(sim, rina, "hospital")
            walk_a = len(Town.town.path(start, transit.STOP_XY[board]))
            walk_b = Town.town.walk_minutes(transit.STOP_XY[alight], "hospital")
            arrive = tick + walk_a
            board_at = next(t for t in range(arrive, arrive + 13) if transit.doors_open(line, board, t))
            bus = transit.bus_at_stop(line, board, board_at)
            alight_at = next(t for t in range(board_at + 1, board_at + 60)
                             if transit.bus_xy(bus, t) == transit.STOP_XY[alight])
            self.assertEqual(minutes, alight_at + walk_b - tick)
            self.assertEqual(travel.travel_minutes(sim, rina, "hospital", "bus"), minutes)
            seen.add(minutes)
        self.assertGreater(len(seen), 1)  # it depends on when she leaves

    def test_the_bus_falls_back_to_walking(self):
        sim = fake_sim()
        for agent_id, place in (("yaniv", "cafe"), ("eli", "grocer"), ("dana", "cafe")):
            me = person(agent_id)
            walk = travel.travel_minutes(sim, me, place, "walk")
            self.assertIsNone(travel.bus_trip(sim, me, place))
            self.assertEqual(travel.travel_minutes(sim, me, place, "bus"), walk)
            self.assertEqual(travel.travel_minutes(sim, me, place, "bus", worst=True), walk)

    def test_worst_case_bus(self):
        for agent_id in ("rina", "ari", "tomer", "yossi", "gal"):
            me = person(agent_id)
            place = me.job.place_id
            now = [travel.travel_minutes(fake_sim(tick=t), me, place, "bus") for t in range(1000, 1000 + 13)]
            worst = {travel.travel_minutes(fake_sim(tick=t), me, place, "bus", worst=True) for t in (0, 7, 1000, 5000)}
            self.assertEqual(len(worst), 1, agent_id)  # the worst case does not depend on the clock
            worst = worst.pop()
            walk = walk_job(me)
            if worst < walk:  # the bus always saves time: the worst is the slowest departure minute
                self.assertEqual(worst, max(now), agent_id)
            else:  # some minute it doesn't, so the worst case walks
                self.assertEqual(worst, walk, agent_id)
            self.assertTrue(all(n <= worst for n in now), agent_id)


class UsualModeTest(unittest.TestCase):
    def test_car_owners_drive(self):
        sim = fake_sim()
        owners = [a for a in Town.agents.values() if a.owns_car]
        self.assertTrue(owners)
        for a in owners:
            self.assertEqual(travel.usual_mode(sim, person(a.id)), "car")
        self.assertEqual(travel.usual_mode(sim, person("dana", job=None)), "car")  # with or without a job

    def test_the_bus_when_it_beats_a_long_walk(self):
        sim = fake_sim()
        for agent_id in ("rina", "yossi", "ari", "tomer", "boaz", "yoni", "ido"):
            me = person(agent_id)
            walk = walk_job(me)
            self.assertGreater(walk, travel.BUS_MIN_WALK, agent_id)
            worst = transit.best_trip(Town.town, (me.x, me.y), me.job.place_id, 0, worst=True)
            self.assertLessEqual(worst[0], walk - transit.MIN_SAVING, agent_id)
            self.assertEqual(travel.usual_mode(sim, me), "bus", agent_id)

    def test_walking_otherwise(self):
        sim = fake_sim()
        # gal: 34 minutes to Brightline, and some minutes no bus saves 5; noa: 21 minutes to school.
        for agent_id in ("gal", "noa", "ronit", "nir"):
            me = person(agent_id)
            self.assertEqual(travel.usual_mode(sim, me), "walk", agent_id)
        self.assertEqual(travel.usual_mode(sim, person("rina", job=None)), "walk")  # nowhere to go
        # A short walk never makes the bus usual, even when some bus would save time right now.
        lina = person("lina")
        self.assertLessEqual(walk_job(lina), travel.BUS_MIN_WALK)
        self.assertIsNotNone(travel.bus_trip(fake_sim(hour=8.0), lina, lina.job.place_id))
        self.assertEqual(travel.usual_mode(sim, lina), "walk")

    def test_every_commuter(self):
        """Seed 1: 16 drive, 7 ride the bus (all walks of 34 minutes or more) and 30 walk."""
        sim = fake_sim()
        modes = {a.id: travel.usual_mode(sim, person(a.id)) for a in Town.agents.values() if a.job}
        self.assertEqual(len(modes), 53)
        self.assertEqual(sorted(k for k, v in modes.items() if v == "bus"),
                         ["ari", "boaz", "ido", "rina", "tomer", "yoni", "yossi"])
        self.assertEqual(sum(v == "car" for v in modes.values()), 16)
        self.assertEqual(sum(v == "walk" for v in modes.values()), 30)

    def test_it_depends_on_home_not_on_where_they_are(self):
        sim = fake_sim()
        for agent_id in ("rina", "gal", "dana"):
            at_home = travel.usual_mode(sim, person(agent_id))
            office = Town.town.places["office"].entry
            at_work = person(agent_id, x=office[0], y=office[1], inside="office")
            self.assertEqual(travel.usual_mode(sim, at_work), at_home, agent_id)


class CommuteTest(unittest.TestCase):
    def test_commute_minutes_by_usual_mode(self):
        sim = fake_sim()
        for a in Town.agents.values():
            me = person(a.id)
            if not me.job:
                self.assertIsNone(travel.commute_minutes(sim, me))
                continue
            mode = travel.usual_mode(sim, me)
            want = travel.travel_minutes(sim, me, me.job.place_id, mode, worst=True)
            self.assertEqual(travel.commute_minutes(sim, me), want, a.id)
            if mode == "bus":
                self.assertLessEqual(want, walk_job(me) - transit.MIN_SAVING)
            elif mode == "walk":
                self.assertEqual(want, walk_job(me))

    def test_a_bus_commuter_is_always_in_time(self):
        """Setting off commute_minutes before the shift is always enough, whatever minute that is."""
        rina = person("rina")
        commute = travel.commute_minutes(fake_sim(), rina)
        self.assertEqual(commute, 31)
        for start in range(8 * 60, 8 * 60 + 13):
            leave = start - commute
            self.assertLessEqual(travel.travel_minutes(fake_sim(tick=leave), rina, "hospital", "bus"), commute)

    def test_commute_from_where_they_are(self):
        sim = fake_sim()
        office = Town.town.places["office"].entry
        at_work = person("ari", x=office[0], y=office[1], inside="office")
        self.assertEqual(travel.commute_minutes(sim, at_work), 0)
        cafe = Town.town.places["cafe"].entry  # next door to Brightline: the bus can't help from here
        at_cafe = person("ari", x=cafe[0], y=cafe[1], inside="cafe")
        self.assertEqual(travel.usual_mode(sim, at_cafe), "bus")
        self.assertEqual(travel.commute_minutes(sim, at_cafe), Town.town.walk_minutes(cafe, "office"))
        self.assertEqual(travel.commute_minutes(sim, person("dana")),
                         travel.travel_minutes(sim, person("dana"), "office", "car"))


class WeeklyCostTest(unittest.TestCase):
    def test_fares_by_usual_mode(self):
        sim = fake_sim()
        cost = travel.weekly_commute_cost
        self.assertEqual(cost(sim, person("rina")), 20)  # bus: 5 days x 2 rides x $2
        self.assertEqual(cost(sim, person("ari")), 20)
        self.assertEqual(cost(sim, person("tomer")), 0)  # a child on the school bus rides free
        self.assertEqual(cost(sim, person("boaz")), 0)  # 17
        self.assertEqual(cost(sim, person("rina", age=65)), 0)  # 65 and over ride free
        self.assertEqual(cost(sim, person("rina", age=64)), 20)
        part_time = person("rina")
        part_time.job = SimpleNamespace(place_id="hospital", workdays=(0, 3), hourly_wage=30.0)
        self.assertEqual(cost(sim, part_time), 8)
        self.assertEqual(cost(sim, person("dana")), 10)  # car: 5 days x $2
        self.assertEqual(cost(sim, person("gal")), 0)  # walks
        self.assertEqual(cost(sim, person("rina", job=None)), 0)
        drivers = sum(2 * len(a.job.workdays) for a in Town.agents.values()
                      if a.owns_car and a.job and a.job.hourly_wage > 0)
        bus = 3 * 20  # the paying bus riders: rina, yossi, ari
        self.assertEqual(sum(cost(sim, person(a.id)) for a in Town.agents.values()), drivers + bus)

    def test_bus_riders_on_seed_1(self):
        sim = fake_sim()
        paying = sorted(a.id for a in Town.agents.values()
                        if a.job and travel.usual_mode(sim, person(a.id)) == "bus" and travel.weekly_commute_cost(
                            sim, person(a.id)) > 0)
        self.assertEqual(paying, ["ari", "rina", "yossi"])


class NearestTest(unittest.TestCase):
    """nearest() keeps its P0 signature and stay rule on the real map."""

    def test_open_on_arrival_and_for_the_stay(self):
        cafe = Town.town.places["cafe"]  # Corner Cafe, open 06:00-23:00
        me = person("yaniv", x=cafe.entry[0], y=cafe.entry[1], inside="cafe")
        sim = fake_sim(hour=22.5)
        self.assertEqual(travel.nearest(sim, me, ("cafe",), stay=15).id, "cafe")
        self.assertEqual(travel.nearest(sim, me, ("cafe",), stay=29).id, "cafe")
        late = travel.nearest(sim, me, ("cafe",), stay=30)  # the noodle bar is open until 24:00
        self.assertEqual(late.id, "noodles")
        self.assertIsNone(travel.nearest(fake_sim(hour=23.5), me, ("cafe",), stay=30))

    def test_open_on_arrival_counts_the_walk_there(self):
        """At 05:15 every cafe is shut, but one far enough away is open by the time the walker gets there."""
        tamar = person("tamar")  # the hospital cleaner: Birch Court, 21 minutes from City Hospital, shift at 06:00
        self.assertEqual((tamar.job.title, tamar.job.start_hour, walk_job(tamar)), ("hospital cleaner", 6, 21))
        hospital = Town.town.places["hospital"]
        here = (tamar.x, tamar.y)
        for hour in (5.25, 5.5, 6.0, 7.0):
            got = travel.nearest(fake_sim(hour=hour), tamar, ("cafe",), meet=hospital, stay=15)
            ok = sorted((Town.town.walk_minutes(here, p.id) + Town.town.walk_minutes(hospital.entry, p.id), p.id)
                        for p in Town.town.places.values() if p.kind == "cafe"
                        and p.is_open(hour + Town.town.walk_minutes(here, p.id) / 60)
                        and p.is_open(hour + (Town.town.walk_minutes(here, p.id) + 15) / 60))
            self.assertEqual(got.id if got else None, ok[0][1] if ok else None, hour)
        early = travel.nearest(fake_sim(hour=5.25), tamar, ("cafe",), meet=hospital, stay=15)
        self.assertEqual(early.id, "bakery")  # 55 minutes away, open at 06:00: far too late for the shift
        self.assertEqual(Town.town.walk_minutes(here, "bakery"), 55)

    def test_nearest_parks_and_shops(self):
        sim = fake_sim(hour=12.0)
        for a in list(Town.agents.values())[:20]:
            me = person(a.id)
            park = travel.nearest(sim, me, ("park",))
            walks = sorted((Town.town.walk_minutes((me.x, me.y), p.id), p.id) for p in Town.town.places.values()
                           if p.kind == "park")
            self.assertEqual(park.id, walks[0][1], a.id)
            self.assertIn(travel.nearest(sim, me, ("shop", "market")).kind, ("shop", "market"))

    def test_signature(self):
        sim = fake_sim()
        me = person("rina")
        self.assertIs(travel.nearest(sim, me, "park"), travel.nearest(sim, me, ("park",)))
        with self.assertRaises(TypeError):
            travel.nearest(sim, me, ("cafe",), meet=3.5)


class RoadTilesTest(unittest.TestCase):
    def test_the_drive_estimate_follows_road_tiles(self):
        town = Town.town
        for a in Town.agents.values():
            if a.owns_car and a.job:
                path = town.drive_path((a.x, a.y), a.job.place_id)
                self.assertTrue(all(town.tiles[y][x] == ROAD for x, y in path[:-1]), a.id)


if __name__ == "__main__":
    unittest.main()
