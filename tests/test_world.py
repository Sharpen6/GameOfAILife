"""Tests for the town map, the starter cast, the forks and the Luck odds."""

from __future__ import annotations

import json
import unittest
from collections import Counter
from unittest import mock

from gameofailife import forks, sim as sim_module
from gameofailife.agent import START_LUCK
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Fork, Option, Outcome, default_scores, luck_odds, payday_fork, work_fork
from gameofailife.sim import Simulation
from gameofailife.town import H, W, build_cast, build_map

SEED = 1
PUBLIC_KEYS = {"index", "label", "cost", "travel_minutes"}


class TownMapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.town = build_map(SEED)

    def test_map_is_40_by_25(self):
        self.assertEqual((W, H), (40, 25))
        self.assertEqual(len(self.town.tiles), 25)
        for row in self.town.tiles:
            self.assertEqual(len(row), 40)
        self.assertEqual([len(r) for r in self.town.rows()], [40] * 25)

    def test_every_entry_tile_is_walkable(self):
        for place in self.town.places.values():
            with self.subTest(place=place.id):
                self.assertTrue(self.town.walkable(*place.entry), f"{place.id} entry {place.entry}")

    def test_every_place_reachable_from_every_home(self):
        homes = [p for p in self.town.places.values() if p.kind == "home"]
        self.assertTrue(homes)
        for home in homes:
            for place in self.town.places.values():
                if place is home:
                    continue
                with self.subTest(home=home.id, place=place.id):
                    path = self.town.path(home.entry, place.entry)
                    self.assertTrue(path, "no path found")
                    self.assertEqual(path[-1], place.entry)

    def test_path_excludes_start_and_is_contiguous(self):
        start = self.town.places["home_cohen"].entry
        goal = self.town.places["hospital"].entry
        path = self.town.path(start, goal)
        self.assertNotIn(start, path)
        self.assertEqual(path[-1], goal)
        prev = start
        for step in path:
            self.assertEqual(abs(step[0] - prev[0]) + abs(step[1] - prev[1]), 1, f"jump {prev} -> {step}")
            self.assertTrue(self.town.walkable(*step))
            prev = step

    def test_path_to_self_is_empty(self):
        start = self.town.places["cafe"].entry
        self.assertEqual(self.town.path(start, start), [])


class CastTest(unittest.TestCase):
    def setUp(self):
        self.town = build_map(SEED)
        self.agents, self.households = build_cast(self.town, SEED)

    def test_twenty_characters_with_luck_50(self):
        self.assertEqual(len(self.agents), 20)
        for agent in self.agents.values():
            self.assertEqual(agent.luck, 50)
            self.assertEqual(agent.luck, START_LUCK)

    def test_households_have_members(self):
        self.assertTrue(self.households)
        seen = []
        for hh in self.households.values():
            with self.subTest(household=hh.id):
                self.assertTrue(hh.member_ids)
                self.assertIn(hh.home_id, self.town.places)
                for m in hh.member_ids:
                    self.assertEqual(self.agents[m].household_id, hh.id)
            seen.extend(hh.member_ids)
        self.assertEqual(sorted(seen), sorted(self.agents))


class LuckOddsTest(unittest.TestCase):
    def test_luck_50_leaves_p_unchanged(self):
        for p in (0.0, 0.05, 0.3, 0.7, 1.0):
            for valence in (-1, 0, 1):
                self.assertAlmostEqual(luck_odds(p, valence, 50), p)

    def test_high_luck_raises_good_and_lowers_bad(self):
        p = 0.3
        for luck in (60, 80, 100):
            self.assertGreater(luck_odds(p, +1, luck), p)
            self.assertLess(luck_odds(p, -1, luck), p)
        self.assertGreater(luck_odds(p, +1, 100), luck_odds(p, +1, 70))
        self.assertLess(luck_odds(p, -1, 100), luck_odds(p, -1, 70))

    def test_low_luck_lowers_good_and_raises_bad(self):
        p = 0.3
        self.assertLess(luck_odds(p, +1, 0), p)
        self.assertGreater(luck_odds(p, -1, 0), p)

    def test_neutral_unchanged(self):
        for luck in (0, 25, 50, 75, 100):
            self.assertAlmostEqual(luck_odds(0.4, 0, luck), 0.4)

    def test_clamped_to_unit_interval(self):
        for p in (0.0, 0.5, 0.9, 1.0):
            for valence in (-1, 0, 1):
                for luck in (0, 50, 100, 1000, -1000):
                    r = luck_odds(p, valence, luck)
                    self.assertGreaterEqual(r, 0.0)
                    self.assertLessEqual(r, 1.0)
        self.assertEqual(luck_odds(0.9, +1, 100), 1.0)
        self.assertEqual(luck_odds(0.9, -1, -1000), 1.0)
        self.assertEqual(luck_odds(0.9, +1, -1000), 0.0)


class DefaultScoresTest(unittest.TestCase):
    def test_unaffordable_option_is_penalized(self):
        sim = Simulation(seed=SEED)
        agent = sim.agents["ari"]
        agent.money = 20.0
        same = dict(tags={"social": 0.5}, gains={"fun": 20})
        fork = Fork(agent.id, "test", "?", [
            Option("free", [("relax_home", "home")], cost=0, **same),
            Option("cheap", [("relax_home", "home")], cost=10, **same),
            Option("too dear", [("relax_home", "home")], cost=500, **same),
            Option("also too dear", [("relax_home", "home")], cost=21, **same),
        ], sim.clock.tick)
        scores = default_scores(agent, fork)
        self.assertEqual(len(scores), 4)
        self.assertGreater(scores[0], scores[2])
        self.assertGreater(scores[1], scores[2])
        self.assertGreater(scores[1], scores[3])
        # Unaffordable options take the flat penalty, well below an affordable one.
        self.assertLessEqual(scores[2] - scores[0], -2.0 + 1e-9)
        self.assertAlmostEqual(scores[2], scores[3])


def _assert_public_hides_outcomes(case: unittest.TestCase, fork: Fork) -> None:
    for i, opt in enumerate(fork.options):
        for minutes in (None, 7):
            pub = opt.public(i, minutes)
            case.assertLessEqual(set(pub), PUBLIC_KEYS, f"{fork.kind}: extra keys {set(pub) - PUBLIC_KEYS}")
            text = json.dumps(pub)
            for key in ("outcome", "valence", "effects", "\"p\""):
                case.assertNotIn(key, text)
            for out in opt.outcomes:
                case.assertNotIn(out.label, text, f"{fork.kind}: outcome label leaked")


class ForksDuringSimulationTest(unittest.TestCase):
    """Run three days, recording every fork the builders produce."""

    @classmethod
    def setUpClass(cls):
        cls.built: list[Fork] = []
        real = forks.build_fork

        def recording(sim, agent):
            fork = real(sim, agent)
            if fork is not None:
                cls.built.append(fork)
            return fork

        cls.sim = Simulation(seed=SEED)
        with mock.patch.object(sim_module, "build_fork", recording):
            cls.sim.run_days(3)

    def test_forks_fired(self):
        kinds = {f.kind for f in self.built}
        self.assertGreaterEqual(len(self.built), 20)
        for kind in ("work", "sleep", "hunger"):
            self.assertIn(kind, kinds)

    def test_every_fork_has_four_options(self):
        for fork in self.built:
            with self.subTest(kind=fork.kind, fork=fork.id):
                self.assertEqual(len(fork.options), 4)
                for opt in fork.options:
                    self.assertIsInstance(opt, Option)

    def test_public_never_exposes_outcomes(self):
        for fork in self.built:
            with self.subTest(kind=fork.kind, fork=fork.id):
                _assert_public_hides_outcomes(self, fork)

    def test_fork_message_hides_outcomes(self):
        for fork in self.built[:60]:
            agent = self.sim.agents[fork.agent_id]
            msg = self.sim.fork_message(agent, fork)
            # recent_memory may name outcomes that already happened; the options must not.
            options = json.dumps(msg["options"])
            for pub in msg["options"]:
                self.assertLessEqual(set(pub), PUBLIC_KEYS)
            for opt in fork.options:
                for out in opt.outcomes:
                    self.assertNotIn(out.label, options)
            whole = json.dumps(msg, default=str)
            for key in ("valence", "\"outcomes\"", "\"effects\""):
                self.assertNotIn(key, whole)

    def test_outcome_probabilities_are_valid(self):
        for fork in self.built:
            for opt in fork.options:
                for out in opt.outcomes:
                    self.assertIsInstance(out, Outcome)
                    self.assertGreaterEqual(out.p, 0.0)
                    self.assertLessEqual(out.p, 1.0)
                    self.assertIn(out.valence, (-1, 0, 1))

    def test_same_outcome_under_several_options(self):
        """Design rule: one outcome can appear under several options at different odds."""
        shared = set()
        for fork in self.built:
            counts = Counter(out_id for opt in fork.options for out_id in {o.id for o in opt.outcomes})
            shared.update((fork.kind, oid) for oid, n in counts.items() if n >= 2)
        self.assertTrue(shared, "no fork kind repeats an outcome across options")
        self.assertIn(("work", "late"), shared)


class PaydayTest(unittest.TestCase):
    def _sim_at(self, day: int, hour: int) -> Simulation:
        sim = Simulation(seed=SEED)
        sim.clock.tick = day * MINUTES_PER_DAY + hour * 60
        return sim

    def test_payday_fork_on_friday_evening_for_working_adult(self):
        sim = self._sim_at(4, 18)  # day 4 is Friday
        self.assertEqual(sim.clock.weekday, 4)
        dana = sim.agents["dana"]
        self.assertTrue(dana.is_adult and dana.job)
        fork = payday_fork(sim, dana)
        self.assertIsNotNone(fork)
        self.assertEqual(fork.kind, "payday")
        self.assertEqual(len(fork.options), 4)
        _assert_public_hides_outcomes(self, fork)
        # Once per week.
        self.assertIsNone(payday_fork(sim, dana))

    def test_no_payday_on_other_days_or_for_others(self):
        thu = self._sim_at(3, 18)
        self.assertIsNone(payday_fork(thu, thu.agents["dana"]))
        fri_morning = self._sim_at(4, 10)
        self.assertIsNone(payday_fork(fri_morning, fri_morning.agents["dana"]))
        fri = self._sim_at(4, 18)
        self.assertIsNone(payday_fork(fri, fri.agents["noa"]))  # a child

    def test_retirees_get_a_payday_for_their_pension(self):
        fri = self._sim_at(4, 18)
        self.assertIsNotNone(payday_fork(fri, fri.agents["miriam"]))

    def test_payday_appears_in_simulated_friday_evening(self):
        sim = Simulation(seed=SEED)
        end = 4 * MINUTES_PER_DAY + 21 * 60
        log = []
        while sim.clock.tick < end:
            sim.step()
            log.extend(sim.drain()[1])
        paydays = [f for f in log if f["kind"] == "payday"]
        self.assertTrue(paydays, "no payday fork by Friday 21:00")
        for f in paydays:
            agent = sim.agents[f["agent"]]
            self.assertTrue(agent.is_adult and (agent.job is not None or agent.age >= 65))
            self.assertIn("Fri", f["time"])
            self.assertEqual(len(f["options"]), 4)


class WorkForkSharedOutcomeTest(unittest.TestCase):
    def test_late_outcome_under_several_work_options(self):
        sim = Simulation(seed=SEED)
        sim.clock.tick = 8 * 60 + 30  # Monday 08:30, Dana starts at 09:00
        fork = work_fork(sim, sim.agents["dana"])
        self.assertIsNotNone(fork)
        having_late = [o for o in fork.options if any(out.id == "late" for out in o.outcomes)]
        self.assertGreaterEqual(len(having_late), 2)
        odds = {next(out.p for out in o.outcomes if out.id == "late") for o in having_late}
        self.assertGreater(len(odds), 1, "shared outcome should carry different odds")


if __name__ == "__main__":
    unittest.main()
