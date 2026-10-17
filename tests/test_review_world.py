"""Regression tests for the reviewed world bugs: roads, park trees, opening hours, payday and quiet options."""

from __future__ import annotations

import heapq
import unittest
from unittest import mock

from gameofailife import forks, sim as sim_module
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Fork, Option, free_time_fork, groceries_fork, hunger_fork, invite_fork, lonely_fork, payday_fork
from gameofailife.sim import Simulation
from gameofailife.town import ROAD, ROAD_COLS, ROAD_ROWS, build_map

SEED = 1
WALLED_PARK_SEEDS = (18, 440, 823, 1488)  # the park entry was boxed in by trees on these seeds


def at(sim: Simulation, day: int, hour: int, minute: int = 0) -> None:
    sim.clock.tick = day * MINUTES_PER_DAY + hour * 60 + minute


def labels(fork: Fork | None) -> list[str]:
    return [o.label for o in fork.options] if fork else []


def best_route(town, start, goal) -> tuple[int, int] | None:
    """Reference answer: (length, off-road tiles) of the best shortest path, by Dijkstra."""
    best = {start: (0, 0)}
    heap = [(0, 0, start)]
    while heap:
        steps, off, cur = heapq.heappop(heap)
        if best.get(cur) != (steps, off):
            continue
        if cur == goal:
            return steps, off
        x, y = cur
        for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if town.walkable(*nxt):
                key = (steps + 1, off + (town.tiles[nxt[1]][nxt[0]] != ROAD))
                if key < best.get(nxt, (10 ** 9, 0)):
                    best[nxt] = key
                    heapq.heappush(heap, (*key, nxt))
    return None


class RoadsTest(unittest.TestCase):
    """Finding 1: paths said they preferred roads on ties but never did, so no car met a red light."""

    def test_shortest_paths_keep_to_the_road(self):
        town = build_map(SEED)
        entries = [p.entry for p in town.places.values()]
        for a in entries:
            for b in entries:
                if a == b:
                    continue
                with self.subTest(start=a, goal=b):
                    path = town.path(a, b)
                    got = (len(path), sum(town.tiles[y][x] != ROAD for x, y in path))
                    self.assertEqual(got, best_route(town, a, b))

    def test_dana_drives_to_work_along_the_road(self):
        town = build_map(SEED)
        path = town.path(town.places["home_cohen"].entry, town.places["office"].entry)
        self.assertEqual(len(path), 17)  # walking time unchanged
        self.assertGreaterEqual(sum(town.tiles[y][x] == ROAD for x, y in path), 4)  # was 1 road tile

    def test_red_light_stops_a_car(self):
        sim = Simulation(seed=SEED)
        real = sim._travel
        stops, crossings = [], []

        def travel(agent):
            if agent.vehicle != "car" or not agent.path:
                return real(agent)
            before, left = (agent.x, agent.y), list(agent.path)
            real(agent)
            moved = left[:len(left) - len(agent.path)]
            crossings.extend(t for t in moved if t[0] in ROAD_COLS and t[1] in ROAD_ROWS)
            if agent.path and (agent.x, agent.y) == before:
                stops.append((sim.clock.stamp(), agent.id, sim.lights()))

        with mock.patch.object(sim, "_travel", travel):
            sim.run_days(1)
        self.assertTrue(crossings, "no car crossed a road intersection")
        self.assertTrue(stops, "no car ever waited at a red light")
        for _, _, light in stops:
            self.assertIn("red", light.values())


class ParkTreesTest(unittest.TestCase):
    """Finding 9: trees could box in the park entry, and trips there teleported."""

    def test_every_entry_reachable_on_walled_seeds(self):
        for seed in WALLED_PARK_SEEDS:
            town = build_map(seed)
            for place in town.places.values():
                with self.subTest(seed=seed, place=place.id):
                    self.assertTrue(town.path((ROAD_COLS[0], ROAD_ROWS[0]), place.entry))

    def test_trip_to_the_park_walks_there(self):
        sim = Simulation(seed=18)
        ari = sim.agents["ari"]
        start = (ari.x, ari.y)
        self.assertGreater(sim.walk_minutes(ari, "park"), 0)
        sim._start_step(ari, "walk_park", "park")
        self.assertEqual(ari.state, "travelling")
        self.assertEqual((ari.x, ari.y), start)
        self.assertEqual(ari.path[-1], sim.town.places["park"].entry)

    def test_other_seeds_keep_their_trees(self):
        town = build_map(SEED)
        self.assertGreater(sum(row.count("T") for row in town.rows()), 5)


class OpeningHoursForksTest(unittest.TestCase):
    """Findings 4, 24, 25: forks offered places that would be shut by the time the character got there."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)

    def hungry(self, aid: str, money: float = 300.0):
        agent = self.sim.agents[aid]
        agent.needs["hunger"] = 20
        agent.money = money
        self.sim.household(agent).groceries = 0
        return agent

    def test_no_cafe_meal_when_it_shuts_before_arrival(self):
        at(self.sim, 2, 22, 45)  # Wed; Ari's walk is 22 minutes, the cafe shuts at 23:00
        ari = self.hungry("ari")
        self.assertNotIn("Eat at Corner Cafe", labels(hunger_fork(self.sim, ari)))
        at(self.sim, 2, 12, 0)
        self.assertIn("Eat at Corner Cafe", labels(hunger_fork(self.sim, ari)))

    def test_no_groceries_trip_when_the_market_shuts_before_arrival(self):
        at(self.sim, 2, 20, 50)  # Eli's walk is 13 minutes, the market shuts at 21:00
        eli = self.hungry("eli")
        fork = hunger_fork(self.sim, eli)
        self.assertNotIn("Buy groceries, then cook", labels(fork))
        self.assertEqual(len(fork.options), 4)
        self.assertIsNone(groceries_fork(self.sim, eli))

    def test_no_groceries_trip_that_arrives_before_opening(self):
        eli = self.hungry("eli")
        at(self.sim, 2, 6, 40)  # would arrive 06:53; the market opens at 07:00
        self.assertIsNone(groceries_fork(self.sim, eli))
        at(self.sim, 2, 6, 50)  # arrives 07:03
        self.assertIn("Buy groceries now", labels(groceries_fork(self.sim, eli)))

    def test_no_invite_fork_to_a_place_shut_on_arrival(self):
        tom, ari = self.sim.agents["tom"], self.sim.agents["ari"]
        at(self.sim, 2, 21, 30)
        self.sim.invite(tom, "ari", "market")
        self.assertIsNone(invite_fork(self.sim, ari))
        at(self.sim, 2, 10, 0)
        self.assertIsNotNone(invite_fork(self.sim, ari))

    def test_forks_in_a_run_only_offer_places_open_on_arrival(self):
        checked = []
        real = forks.build_fork

        def recording(sim, agent):
            fork = real(sim, agent)
            for opt in fork.options if fork else []:
                where = sim._resolve_place(agent, opt.steps[0][1])
                place = sim.town.places.get(where or "")
                if place and place.hours and opt.steps[0][0] != "work":
                    arrive = sim.clock.hour + sim.walk_minutes(agent, place.id) / 60
                    checked.append((fork.kind, opt.label, sim.clock.stamp(), place.is_open(arrive)))
            return fork

        sim = Simulation(seed=3)  # used to offer groceries at 06:32 on day 3, before the market opens
        with mock.patch.object(sim_module, "build_fork", recording):
            sim.run_days(3)
        self.assertTrue(checked)
        self.assertEqual([c for c in checked if not c[3]], [])


class ShutOnArrivalTest(unittest.TestCase):
    """Findings 4, 25: a shut place still sold groceries and charged for meals nobody ate."""

    def setUp(self):
        self.sim = Simulation(seed=SEED)

    def decide_late(self, agent, build, label: str, late: tuple[int, int, int]) -> Fork:
        """Build the fork while the place is open, then decide it later, as a slow controller at high speed might."""
        fork = build(self.sim, agent)
        choice = labels(fork).index(label)
        at(self.sim, *late)
        self.sim._decide(agent, fork, choice, "model", "")
        return fork

    def run_until(self, agent, done, limit: int = 120) -> None:
        """Tick only this character, so nobody else in the house shops or eats meanwhile."""
        for _ in range(limit):
            self.sim.clock.advance()
            self.sim._tick_agent(agent)
            if done(agent):
                return
        self.fail(f"{agent.id} never got there")

    def test_shut_market_sells_nothing_and_refunds(self):
        eli = self.sim.agents["eli"]
        eli.needs["hunger"], eli.money = 20, 300.0
        hh = self.sim.household(eli)
        hh.groceries = 0
        at(self.sim, 2, 20, 20)  # a 13-minute walk and 20 minutes' shopping fit before 21:00
        fork = self.decide_late(eli, hunger_fork, "Buy groceries, then cook", (2, 20, 50))
        self.assertEqual(eli.money, 265.0)  # paid on deciding
        self.run_until(eli, lambda a: a.activity_place != "market" or a.state != "travelling")
        self.assertEqual(hh.groceries, 0)
        self.assertEqual(eli.money, 300.0)
        self.assertNotIn(("eat_home", "home"), eli.plan)  # no cooking from an empty fridge
        self.assertFalse([p for p in eli.pending_outcomes if p["fork"] == fork.id])
        self.assertTrue(any("finds Fresh Market closed" in m for m in eli.memory))

    def test_shut_cafe_charges_nothing_for_the_meal(self):
        omer = self.sim.agents["omer"]
        omer.needs["hunger"], omer.money = 20, 1300.0
        self.sim.household(omer).groceries = 0
        at(self.sim, 2, 21, 50)
        fork = self.decide_late(omer, hunger_fork, "Eat at Corner Cafe", (2, 22, 50))
        self.assertEqual(omer.money, 1286.0)
        self.run_until(omer, lambda a: a.state != "travelling")
        self.assertEqual(omer.money, 1300.0)
        self.assertNotEqual(omer.activity, "eat_out")
        self.assertFalse([p for p in omer.pending_outcomes if p["fork"] == fork.id])  # no food poisoning either

    def test_shut_cafe_on_the_way_to_work_keeps_the_shift(self):
        dana = self.sim.agents["dana"]
        dana.money = 900.0
        coffee = Option("Coffee first", [("coffee", "cafe"), ("work", "job")], cost=4)
        fork = Fork(dana.id, "work", "?", [coffee] * 4, self.sim.clock.tick)
        at(self.sim, 0, 5, 30)  # the cafe opens at 06:00
        self.sim._decide(dana, fork, 0, "model", "")
        self.run_until(dana, lambda a: a.activity_place != "cafe")
        self.assertEqual(dana.money, 900.0)
        self.assertEqual(dana.activity_place, "office")

    def test_open_market_still_sells(self):
        eli = self.sim.agents["eli"]
        eli.needs["hunger"], eli.money = 20, 300.0
        hh = self.sim.household(eli)
        hh.groceries = 0
        at(self.sim, 2, 12, 0)
        fork = hunger_fork(self.sim, eli)
        self.sim._decide(eli, fork, labels(fork).index("Buy groceries, then cook"), "model", "")
        self.run_until(eli, lambda a: a.activity == "eat_home" and a.state == "busy")
        self.assertEqual(eli.money, 265.0)
        self.assertEqual(hh.groceries, 9)  # ten bought, one being cooked


class PaydayAloneTest(unittest.TestCase):
    """Findings 10, 22: people living alone were offered a family dinner with no family."""

    def payday(self, sim: Simulation, aid: str) -> Fork:
        at(sim, 4, 18)  # Friday evening
        agent = sim.agents[aid]
        agent.money = 300.0
        fork = payday_fork(sim, agent)
        self.assertIsNotNone(fork)
        self.assertEqual(len(fork.options), 4)
        self.assertEqual(len(set(labels(fork))), 4)
        return fork

    def assert_no_family_dinner(self, fork: Fork) -> None:
        for opt in fork.options:
            self.assertNotIn("family", opt.label.lower())
            self.assertFalse(opt.extra.get("family"))
            self.assertFalse([o for o in opt.outcomes if "family_bond" in o.effects])
            self.assertTrue(opt.outcomes)

    def test_someone_living_alone_gets_another_treat(self):
        sim = Simulation(seed=SEED)
        self.assertEqual(sim.household(sim.agents["ari"]).member_ids, ["ari"])
        fork = self.payday(sim, "ari")
        self.assert_no_family_dinner(fork)
        self.assertIn("Treat yourself to a takeaway night in", labels(fork))

    def test_widow_gets_no_family_dinner(self):
        sim = Simulation(seed=SEED)
        sim._die(sim.agents["david"], "passed away")
        self.assert_no_family_dinner(self.payday(sim, "ruth"))

    def test_family_still_offered_dinner(self):
        sim = Simulation(seed=SEED)
        self.assertIn("Treat the family to dinner at Corner Cafe", labels(self.payday(sim, "dana")))


class QuietOptionsHaveOutcomesTest(unittest.TestCase):
    """Finding 26: 'Relax at home' (and 'Write in a diary') had no hidden outcomes for Luck to shift."""

    def test_relax_at_home_rolls_luck_shifted_outcomes(self):
        sim = Simulation(seed=SEED)
        at(sim, 2, 10)
        ari = sim.agents["ari"]
        ari.needs["fun"] = 10
        ari.worked_today = sim.clock.day
        fork = free_time_fork(sim, ari)
        relax = fork.options[labels(fork).index("Relax at home")]
        self.assertEqual({o.valence for o in relax.outcomes}, {+1, -1})
        self.assertTrue(all(o.p > 0 for o in relax.outcomes))
        sim._decide(ari, fork, fork.options.index(relax), "model", "")
        rolls = [r for r in sim.luck_log if r["what"].startswith(fork.id + ":")]
        self.assertEqual(len(rolls), len(relax.outcomes))

    def test_diary_has_outcomes(self):
        sim = Simulation(seed=SEED)
        at(sim, 2, 10)
        ari = sim.agents["ari"]
        ari.relationships.clear()
        ari.needs["social"] = 10
        ari.worked_today = sim.clock.day
        fork = lonely_fork(sim, ari)
        self.assertTrue(fork.options[labels(fork).index("Write in a diary")].outcomes)

    def test_every_option_in_a_run_has_outcomes(self):
        built = []
        real = forks.build_fork

        def recording(sim, agent):
            fork = real(sim, agent)
            if fork:
                built.append(fork)
            return fork

        sim = Simulation(seed=SEED)
        with mock.patch.object(sim_module, "build_fork", recording):
            sim.run_days(3)
        bare = {(f.kind, o.label) for f in built for o in f.options if not o.outcomes}
        self.assertEqual(bare, set())


if __name__ == "__main__":
    unittest.main()
