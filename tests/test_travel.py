"""Travel in the running city (P1 phase 2): shifts start on time, the taxi stays a rare treat, the ambulance, riding
the bus, red lights, the 4-option work fork and the early shift's coffee at home, four distinct options from every
fork builder, and the tick budget."""

from __future__ import annotations

import collections
import dataclasses
import time
import unittest
from unittest import mock

from gameofailife import forks, sim as sim_module, transit, travel
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.sim import Simulation
from gameofailife.town import build_map

SEED = 1
# The fork builders P1 owns (the housing builders are P2's).
BUILDERS = ("invite_fork", "work_fork", "hunger_fork", "sleep_fork", "payday_fork", "groceries_fork", "lonely_fork",
            "free_time_fork")
PHASES = ["to_stop", "waiting", "riding", "from_stop"]  # a bus trip's phases, in order
PROBE_EVERY = 90  # minutes between calls to every builder for everyone
LOW_NEEDS = {"hunger": 20, "social": 20, "fun": 20, "energy": 10}  # low enough for every need's fork


def at(sim: Simulation, day: int, minute: int) -> None:
    sim.clock.tick = day * MINUTES_PER_DAY + minute


def at_home(sim: Simulation, agent) -> None:
    """Idle at the front door of home, with nothing planned."""
    home = sim.home_of(agent)
    agent.inside, (agent.x, agent.y) = home, sim.town.places[home].entry
    agent.state, agent.plan, agent.activity, agent.fork_id, agent.path = "idle", [], "idle", None, []


class Run:
    """A headless run with default plays, recording every shift start, every work fork decided and every fork built;
    for the first `probe_days` game days the builders are also probed every PROBE_EVERY minutes."""

    def __init__(self, seed: int, days: int, probe_days: int):
        build_map(seed).warm()
        self.sim = sim = Simulation(seed=seed)
        self.first = sim.clock.tick
        self.starts: dict[tuple[str, int], tuple[int, int]] = {}  # (agent, day) -> (shift start tick, minutes late)
        self.work: list[tuple[forks.Fork, int, str]] = []  # (work fork, choice, decided by)
        self.labels: list[tuple[str, list[str]]] = []  # (kind, labels) of every fork built
        self.kinds: collections.Counter = collections.Counter()
        begin, decide, build = Simulation._begin_activity, Simulation._decide, sim_module.build_fork

        def on_begin(sim, agent):
            if agent.activity == "work" and agent.job:
                start = sim.clock.tick - sim.clock.minute_of_day + agent.job.start_hour * 60
                self.starts.setdefault((agent.id, sim.clock.day), (start, sim.clock.tick - start))
            return begin(sim, agent)

        def on_decide(sim, agent, fork, choice, by, *args, **kwargs):
            if fork.kind == "work":
                self.work.append((fork, choice, by))
            return decide(sim, agent, fork, choice, by, *args, **kwargs)

        def on_build(sim, agent):
            fork = build(sim, agent)
            if fork is not None:
                self.record(fork)
            return fork

        self.cpu = 0.0
        with mock.patch.object(Simulation, "_begin_activity", on_begin), \
                mock.patch.object(Simulation, "_decide", on_decide), \
                mock.patch.object(sim_module, "build_fork", on_build):
            for t in range(days * MINUTES_PER_DAY):
                t0 = time.process_time()
                sim.step()
                sim.drain()
                self.cpu += time.process_time() - t0
                if t < probe_days * MINUTES_PER_DAY and t % PROBE_EVERY == 0:
                    self.probe()
        self.ticks = days * MINUTES_PER_DAY

    def record(self, fork: forks.Fork) -> None:
        self.kinds[fork.kind] += 1
        self.labels.append((fork.kind, [o.label for o in fork.options]))

    def probe(self) -> None:
        """Call each builder for everyone as they are now, but hungry, lonely, bored, tired, with an empty fridge and
        today's shift still ahead (payday on Friday at this minute), then put everything back."""
        sim = self.sim
        for agent in sim.living():
            hh = sim.household(agent)
            keep = dict(agent.needs), hh.groceries, agent.worked_today, agent.last_payday, sim.clock.tick
            agent.needs.update(LOW_NEEDS)
            hh.groceries, agent.worked_today = 0, -1
            for name in BUILDERS:
                if name == "payday_fork":
                    at(sim, 4, sim.clock.minute_of_day)
                fork = getattr(forks, name)(sim, agent)
                sim.clock.tick = keep[4]
                if fork is not None:
                    self.record(fork)
            agent.needs.clear()
            agent.needs.update(keep[0])
            hh.groceries, agent.worked_today, agent.last_payday = keep[1:4]


class RunningCityTest(unittest.TestCase):
    """Seed 1 for 5 days and seeds 2 and 3 for 2 days, each run once for all the tests below."""

    @classmethod
    def setUpClass(cls):
        cls.runs = {1: Run(1, 5, 2), 2: Run(2, 2, 2), 3: Run(3, 2, 2)}

    def test_at_most_5_percent_of_shifts_start_late(self):
        run = self.runs[SEED]
        # A shift starting as the run starts (06:00 on day 1) can't be made; every later one can.
        shifts = [late for start, late in run.starts.values() if start > run.first]
        self.assertGreater(len(shifts), 200)
        late = [m for m in shifts if m > 0]
        self.assertLessEqual(len(late), 0.05 * len(shifts), sorted(late))

    def test_default_plays_rarely_take_the_taxi(self):
        offered = picked = 0
        for run in self.runs.values():
            for fork, choice, by in run.work:
                taxi = [i for i, o in enumerate(fork.options) if o.vehicle == "taxi"]
                if taxi:
                    offered += 1
                    picked += choice in taxi
                    self.assertIn(by, ("default", "habit"))
        self.assertGreater(offered, 0)
        self.assertLess(picked, 0.1 * offered, (picked, offered))

    def test_every_builder_gives_4_distinct_options(self):
        for seed, run in self.runs.items():
            with self.subTest(seed=seed):
                bad = [(kind, labels) for kind, labels in run.labels if len(labels) != 4 or len(set(labels)) != 4]
                self.assertEqual(bad, [])
                self.assertLessEqual({name.removesuffix("_fork") for name in BUILDERS}, set(run.kinds))

    def test_the_work_fork_has_its_4_slots(self):
        for seed, run in self.runs.items():
            for fork, _, _ in run.work:
                usual, fast, coffee, skip = fork.options
                self.assertIn(usual.vehicle, ("walk", "bus"), seed)
                self.assertIn(fast.vehicle, ("car", "run", "taxi"), seed)
                self.assertEqual(coffee.steps[0][0], "coffee", seed)
                self.assertEqual(coffee.steps[1:], [("work", "job")], seed)
                self.assertTrue(skip.extra.get("skip_work"), seed)

    def test_the_mean_tick_is_under_0_4_ms_at_60_people(self):
        run = self.runs[SEED]
        self.assertEqual(len(run.sim.agents), 60)
        self.assertLess(run.cpu / run.ticks * 1000, 0.4)


class FallbackTest(unittest.TestCase):
    def test_with_every_place_shut_each_builder_keeps_4_options(self):
        """Each conditional outing has a fixed fallback in its slot, so a builder still offers 4 distinct options when
        no cafe, market or shop is open for it (travel.nearest finds nothing)."""
        sim = Simulation(seed=SEED)
        at(sim, 4, 18 * 60)  # Friday evening: payday
        fallbacks = {"hunger": {"Order food to the house", "Raid the cupboard for leftovers"},
                     "payday": {"Open a nice bottle at home", "Order something nice online"},
                     "lonely": {"Message a few people from home"}, "free_time": {"Play a board game at home"}}
        seen = collections.Counter()
        with mock.patch.object(Simulation, "nearest", lambda *args, **kwargs: None):
            for agent in sim.living():
                if not agent.is_adult:
                    continue
                agent.needs.update(LOW_NEEDS)
                agent.money, agent.last_payday = 900.0, -1
                sim.household(agent).groceries = 0
                self.assertIsNone(forks.groceries_fork(sim, agent))  # no market open: nothing to ask
                for name in ("hunger_fork", "payday_fork", "lonely_fork", "free_time_fork"):
                    fork = getattr(forks, name)(sim, agent)
                    if fork is None:
                        continue
                    labels = [o.label for o in fork.options]
                    self.assertEqual(len(set(labels)), 4, labels)
                    self.assertLessEqual(fallbacks[fork.kind], set(labels), agent.id)
                    seen[fork.kind] += 1
        self.assertEqual(set(seen), set(fallbacks))


class TaxiTest(unittest.TestCase):
    def test_the_taxi_is_offered_only_to_adults_without_a_car_and_a_long_walk(self):
        sim = Simulation(seed=SEED)
        taxis = 0
        for agent in sim.living():
            job = agent.job
            if not job:
                continue
            at(sim, min(job.workdays), job.start_hour * 60 - forks.WORK_LEAD)
            at_home(sim, agent)
            agent.worked_today = -1
            fork = forks.work_fork(sim, agent)
            if fork is None:  # a walk so long the fork came earlier
                continue
            fast = fork.options[1]
            walk = sim.walk_minutes(agent, job.place_id)
            want = ("car" if agent.owns_car else "taxi" if agent.is_adult and walk > travel.TAXI_MIN_WALK else "run")
            self.assertEqual(fast.vehicle, want, agent.id)
            if want == "taxi":
                taxis += 1
                self.assertEqual(fast.cost, travel.TAXI_FARE)
                self.assertEqual(fast.tags, {"thrift": -0.6, "diligence": 0.5, "adventure": 0.1})
                self.assertIn(f"(${travel.TAXI_FARE})", fast.label)
        self.assertGreater(taxis, 0)

    def test_a_taxi_drives_door_to_door_and_leaves_its_passenger_on_foot(self):
        sim = Simulation(seed=SEED)
        agent = next(a for a in sim.living() if a.is_adult and not a.owns_car)
        at(sim, 0, 10 * 60)
        at_home(sim, agent)
        agent.money = 100.0
        target = "hospital"
        minutes = sim.travel_minutes(agent, target, "taxi")
        fork = forks.Fork(agent.id, "test", "?", [forks.Option(f"Taxi {i}", [("idle", target)], cost=travel.TAXI_FARE,
                                                               vehicle="taxi") for i in range(4)], sim.clock.tick)
        sim._decide(agent, fork, 0, "model", "")
        self.assertEqual((agent.vehicle, agent.money), ("taxi", 100.0 - travel.TAXI_FARE))
        self.assertEqual(agent.path, sim.town.drive_path(sim.town.places[sim.home_of(agent)].entry, target))
        for ticks in range(1, 3 * minutes):
            sim.clock.advance()
            sim._tick_agent(agent)
            if agent.state != "travelling":
                break
        self.assertEqual((agent.activity_place, agent.state), (target, "busy"))
        tiles, junctions = sim.town.drive_length(sim.town.places[sim.home_of(agent)].entry, target)
        self.assertEqual(minutes, -(-tiles // 4) + junctions * travel.LIGHT_WAIT)
        self.assertLessEqual(-(-tiles // 4), ticks)
        self.assertLessEqual(ticks, -(-tiles // 4) + 3 * junctions)  # a red light lasts 3 minutes
        self.assertEqual((agent.vehicle, agent.speed), ("walk", 1))  # the taxi has gone


class LightsTest(unittest.TestCase):
    def travel(self, vehicle: str, red: bool) -> int:
        """Tiles a `vehicle` covers in one minute from just north of a junction, heading south."""
        sim = Simulation(seed=SEED)
        jx, jy = min(sim.town.junctions, key=lambda j: (j[1], j[0]))
        agent = sim.living()[0]
        agent.inside, agent.trip, agent.state = None, None, "travelling"
        agent.x, agent.y = jx, jy - 1
        agent.vehicle, agent.speed = vehicle, sim_module.SPEEDS[vehicle]
        agent.path = [(jx, jy + i) for i in range(6)]
        sim.clock.tick = 600
        while (sim.lights()["ns"] == "red") != red:
            sim.clock.tick += 1
        sim._travel(agent)
        return 6 - len(agent.path)

    def test_cars_and_taxis_wait_at_a_red_light(self):
        for vehicle in ("car", "taxi"):
            self.assertEqual(self.travel(vehicle, red=True), 0, vehicle)
            self.assertEqual(self.travel(vehicle, red=False), 4, vehicle)

    def test_the_ambulance_and_people_on_foot_do_not(self):
        self.assertEqual(self.travel("ambulance", red=True), 4)
        self.assertEqual(self.travel("walk", red=True), 1)
        self.assertEqual(self.travel("bus", red=True), 1)  # a bus rider's own walk to the stop


class AmbulanceTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=SEED)
        at(self.sim, 0, 11 * 60)
        # The adult living farthest from the hospital.
        self.agent = max((a for a in self.sim.living() if a.is_adult),
                         key=lambda a: self.sim.town.walk_minutes(self.sim.town.places[self.sim.home_of(a)].entry,
                                                                  "hospital"))
        at_home(self.sim, self.agent)
        self.sim.drain()

    def test_below_25_health_an_ambulance_takes_them_to_hospital(self):
        sim, agent = self.sim, self.agent
        agent.health, agent.money = 20.0, 100.0
        minutes = sim.travel_minutes(agent, "hospital", "ambulance")
        self.assertLess(minutes, sim.walk_minutes(agent, "hospital"))
        sim.clock.advance()
        sim._tick_agent(agent)
        self.assertEqual((agent.vehicle, agent.state, agent.activity), ("ambulance", "travelling", "hospital"))
        events = [e for e in sim.drain()[0] if e["tag"] == "hospital"]
        name = sim.town.places["hospital"].name
        self.assertEqual([e["text"] for e in events],
                         [f"{agent.name} feels very unwell, and an ambulance takes them to {name}."])
        for ticks in range(1, 3 * minutes):
            sim.clock.advance()
            sim._tick_agent(agent)
            self.assertEqual(agent.money, 100.0)  # the ride is free (the hospital's fee comes on leaving)
            if agent.state != "travelling":
                break
        self.assertEqual(ticks, minutes)  # no waiting at lights
        self.assertEqual((agent.state, agent.inside), ("busy", "hospital"))
        self.assertEqual(agent.vehicle, "walk")

    def test_at_25_health_nobody_calls_one(self):
        sim, agent = self.sim, self.agent
        agent.health = 25.0
        sim.clock.advance()
        sim._tick_agent(agent)
        self.assertNotEqual(agent.vehicle, "ambulance")
        self.assertFalse([e for e in sim.drain()[0] if e["tag"] == "hospital"])


class BusRiderTest(unittest.TestCase):
    """Rina lives 45 minutes' walk from City Hospital, where she works: the bus is her usual way."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)
        self.rina = self.sim.agents["rina"]
        self.assertEqual(self.sim.usual_mode(self.rina), "bus")

    def ride(self, tick: int) -> dict:
        sim, rina = self.sim, self.rina
        sim.clock.tick = tick
        at_home(sim, rina)
        rina.money = 100.0
        trip = travel.bus_trip(sim, rina, "hospital")
        self.assertIsNotNone(trip)
        sim.start_plan(rina, [("work", "job")], "bus")
        log = {"trip": trip, "riding": [], "phases": [rina.trip["phase"]]}
        while rina.state == "travelling":
            self.assertLess(sim.clock.tick - tick, 120)
            sim.clock.advance()
            sim._tick_agent(rina)
            if rina.riding:
                self.assertEqual((rina.x, rina.y), transit.bus_xy(rina.riding, sim.clock.tick))
                rows = {r["id"]: r["riders"] for r in sim.buses()}
                self.assertEqual(rows[rina.riding], 1)
                log["riding"].append(rina.riding)
            if rina.trip and rina.trip["phase"] != log["phases"][-1]:
                log["phases"].append(rina.trip["phase"])
        log["arrive"] = sim.clock.tick
        return log

    def test_arrival_is_departure_plus_best_trip_minutes(self):
        for tick in range(400, 400 + 13):  # every minute of a headway
            with self.subTest(tick=tick):
                log = self.ride(tick)
                minutes, line, board, alight = log["trip"]
                self.assertEqual(log["arrive"] - tick, minutes)
                self.assertEqual((self.rina.activity, self.rina.inside), ("work", "hospital"))
                self.assertEqual(self.rina.money, 98.0)  # the fare, once
                self.assertEqual(len(set(log["riding"])), 1)
                self.assertEqual(log["riding"][0][:-1], line)
                self.assertEqual(log["phases"], sorted(set(log["phases"]), key=PHASES.index))
                self.assertIn("riding", log["phases"])
                self.assertIsNone(self.rina.riding)
                self.assertIsNone(self.rina.trip)

    def test_the_bus_option_charges_on_boarding_and_children_ride_free(self):
        sim, rina = self.sim, self.rina
        job = rina.job
        at(sim, min(job.workdays), job.start_hour * 60 - sim.commute_minutes(rina) - sim_module.SHIFT_MARGIN)
        at_home(sim, rina)
        rina.money, rina.worked_today = 100.0, -1
        fork = forks.work_fork(sim, rina)
        bus = fork.options[0]
        self.assertEqual((bus.vehicle, bus.cost, bus.charge), ("bus", transit.BUS_FARE, False))
        self.assertTrue(bus.label.startswith("Take the No. ") and bus.label.endswith(" bus to work"), bus.label)
        sim._decide(rina, fork, 0, "model", "")
        self.assertEqual(rina.money, 100.0)  # nothing on deciding
        while rina.state == "travelling" and not rina.riding:
            sim.clock.advance()
            sim._tick_agent(rina)
        self.assertEqual(rina.money, 98.0)
        for age in (70, 12):
            rina.age = age
            log = self.ride(400)
            self.assertIn("riding", log["phases"], age)
            self.assertEqual(rina.money, 100.0, age)  # 65 and over, and children, ride free


class CoffeeFirstTest(unittest.TestCase):
    """PLAN decision 55: the third work option is a coffee at the open cafe adding least to the way to work, when the
    cup and the detour still get the character in on time, and otherwise a coffee at home first."""

    @classmethod
    def setUpClass(cls):
        cls.sim = sim = Simulation(seed=SEED)
        cls.coffees = []  # (agent, minutes left before the shift, the coffee option) for each minute of each window
        for agent in sim.living():
            if not agent.job:
                continue
            start = agent.job.start_hour * 60
            for minute in range(start - max(forks.WORK_LEAD, cls.home_walk(agent) + 15), start + 1):
                cls.coffees.append((agent, start - minute, cls.fork_at(agent, minute).options[2]))

    @classmethod
    def home_walk(cls, agent) -> int:
        return cls.sim.town.walk_minutes(cls.sim.town.places[cls.sim.home_of(agent)].entry, agent.job.place_id)

    @classmethod
    def fork_at(cls, agent, minute: int) -> forks.Fork:
        at(cls.sim, min(agent.job.workdays), minute)
        at_home(cls.sim, agent)
        agent.worked_today = -1
        return forks.work_fork(cls.sim, agent)

    def test_the_0600_hospital_cleaner_asked_at_0515_makes_coffee_at_home(self):
        agent = next(a for a in self.sim.living()
                     if a.job and a.job.title == "hospital cleaner" and a.job.start_hour == 6)
        fork = self.fork_at(agent, 5 * 60 + 15)
        labels = [o.label for o in fork.options]
        self.assertEqual(len(set(labels)), 4, labels)
        coffee = fork.options[2]
        self.assertEqual(coffee.label, "Make a coffee at home, then go")
        self.assertEqual(coffee.steps, [("coffee", "home"), ("work", "job")])
        self.assertEqual((coffee.cost, coffee.vehicle), (0, "walk"))
        self.assertNotIn("meet_new", [o.id for o in coffee.outcomes])
        # The cafes are shut until 06:00, so the nearest open on arrival is too far to be on the way.
        cafe = self.sim.nearest(agent, ("cafe",), meet=self.sim.town.places[agent.job.place_id],
                                stay=forks.COFFEE_MINUTES)
        self.assertGreater(self.sim.walk_minutes(agent, cafe.id), 45)

    def test_a_cafe_only_when_the_detour_is_on_time(self):
        cafes = 0
        for agent, left, coffee in self.coffees:
            place = coffee.steps[0][1]
            if place == "home":
                continue
            cafes += 1
            cafe = self.sim.town.places[place]
            self.assertEqual(coffee.label, f"Grab a coffee at {cafe.name} first")
            self.assertEqual((coffee.cost, coffee.steps[1:]), (4, [("work", "job")]))
            trip = (self.sim.town.walk_minutes(self.sim.town.places[self.sim.home_of(agent)].entry, place)
                    + forks.COFFEE_MINUTES + self.sim.town.walk_minutes(cafe.entry, agent.job.place_id))
            self.assertLessEqual(trip, left, (agent.id, left))
            self.assertEqual({o.id: o.p for o in coffee.outcomes}["late"], 0.7)  # on time: the base odds
        self.assertGreater(cafes, 20)
        self.assertGreater(len(self.coffees) - cafes, 20)

    def test_the_coffee_at_home_has_the_cafes_tags_and_lateness_by_timing(self):
        tags = {tuple(sorted(c.tags.items())) for _, _, c in self.coffees}
        self.assertEqual(len(tags), 1)  # one set of tags for the cafe and the cup at home
        seen = set()
        for agent, left, coffee in self.coffees:
            if coffee.steps[0][1] != "home":
                continue
            self.assertEqual((coffee.label, coffee.cost), ("Make a coffee at home, then go", 0))
            self.assertNotIn("meet_new", [o.id for o in coffee.outcomes])
            late_by = forks.COFFEE_MINUTES + self.home_walk(agent) - left
            late = {o.id: o.p for o in coffee.outcomes}["late"]
            self.assertEqual(late, max(0.0, min(0.5, late_by / 40)), (agent.id, left))
            self.assertEqual(coffee.base, round(0.35 - max(0.0, min(1.0, late_by / 20)), 3))
            seen.add(late > 0)
        self.assertEqual(seen, {False, True})


class TimingTest(unittest.TestCase):
    def home_walk(self, sim: Simulation, agent) -> int:
        return sim.town.walk_minutes(sim.town.places[sim.home_of(agent)].entry, agent.job.place_id)

    def test_late_options_lose_value_and_gain_late_odds(self):
        sim = Simulation(seed=SEED)
        agent = next(a for a in sim.living() if a.job and not a.owns_car and a.is_adult
                     and 15 < self.home_walk(sim, a) <= travel.BUS_MIN_WALK)  # who walks to work
        start, walk = agent.job.start_hour * 60, self.home_walk(sim, agent)
        for left in (walk + 5, walk, walk - 4, walk - 10, walk - 30):
            at(sim, min(agent.job.workdays), start - left)
            at_home(sim, agent)
            agent.worked_today = -1
            usual = forks.work_fork(sim, agent).options[0]
            self.assertEqual(usual.vehicle, "walk")
            late_by = max(0, walk - left)
            self.assertEqual(usual.base, round(0.6 - min(1.0, late_by / 20), 3), left)
            self.assertAlmostEqual({o.id: o.p for o in usual.outcomes}["late"], 0.12 + min(0.5, late_by / 40))

    def test_the_commute_sets_the_leave_time(self):
        sim = Simulation(seed=SEED)
        for agent in sim.living():
            if not agent.job:
                continue
            day, start = min(agent.job.workdays), agent.job.start_hour * 60
            at(sim, day, start - 200)
            at_home(sim, agent)
            agent.worked_today = -1
            commute = sim.commute_minutes(agent)
            self.assertEqual(commute, sim.travel_minutes(agent, agent.job.place_id, sim.usual_mode(agent), worst=True))
            leave = start - commute - sim_module.SHIFT_MARGIN
            for minute, due in ((leave - 1, False), (leave, True)):
                at(sim, day, minute)
                self.assertEqual(sim._must_leave_for_work(agent), due, (agent.id, minute))

    def test_the_commute_sets_the_wake_time(self):
        sim = Simulation(seed=SEED)
        for agent in sim.living():
            if not agent.job or 1 not in agent.job.workdays:
                continue
            at(sim, 0, 23 * 60)
            at_home(sim, agent)
            sim.start_plan(agent, [("sleep", "home")])
            wake = min(7 * 60, agent.job.start_hour * 60 - max(90, sim.commute_minutes(agent) + 60))
            woken = (agent.busy_until - MINUTES_PER_DAY) % MINUTES_PER_DAY
            self.assertTrue(wake <= woken < wake + 25, (agent.id, wake, woken))


if __name__ == "__main__":
    unittest.main()
