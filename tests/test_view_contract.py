"""The view contract on the real engine (view.md 8, Contracts): seed 1, region world, 1000 townsfolk, 2 game hours
from the morning start.

`crowd` is `[i, x, y, k, ...]` with i ascending, unique and < `folk_n`, positions on the map and `k < 16`, and
never a named character; `occ` has one count a place; every `stats.folk` array and the roster (`get_folk` rows) has
length `folk_n`, also after a birth; folk pages carry `choices` and `life`; the housing maps travel apart from the
state (PLAN 2.11: `state_json(housing=False)` leaves them out and the server sends `housing_maps()` when it changed).
"""

from __future__ import annotations

import inspect
import json
import unittest

from gameofailife import folk as folk_mod
from gameofailife import people, stats
from gameofailife.sim import Simulation

SEED = 1
FOLK = 1000
HOURS = 2
ROSTER_KEYS = {"i", "id", "name", "age", "child", "hh", "home", "place", "district", "job", "work", "alive"}
STATS_FOLK = ("worth", "worth_24h", "mood", "health", "luck")


def integrated() -> bool:
    return "world" in inspect.signature(Simulation.__init__).parameters


class ViewContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not integrated():
            raise unittest.SkipTest("Simulation does not take world= yet")
        cls.sim = sim = Simulation(seed=SEED, world="region", folk=FOLK)
        cls.frames = []  # (tick, state without housing maps, occ)
        end = sim.clock.tick + HOURS * 60
        while sim.clock.tick < end:
            sim.step()
            if sim.clock.tick % 5 == 0:
                cls.frames.append((sim.clock.tick, sim.state_json(housing=False), sim.folk.occ()))
        cls.full = sim.state_json()
        cls.maps = sim.housing_maps()
        # a birth, then a few minutes: folk_n, stats.folk and the roster all grow together
        mother = next(p for p in sim.folk.living() if p.sex == "f" and 20 <= p.age <= 40 and p.household_id)
        cls.baby = folk_mod.add_baby(sim, mother)
        for _ in range(3):
            sim.step()
        cls.after_birth = (sim.state_json(housing=False), stats.stats_json(sim)["folk"], sim.folk.roster_rows(sim))

    def test_crowd(self):
        sim = self.sim
        w, h = sim.town.w, sim.town.h
        named = set(sim.agents)
        seen_some = 0
        for tick, state, _ in self.frames:
            crowd, n = state["crowd"], state["folk_n"]
            self.assertEqual(n, FOLK)
            self.assertEqual(len(crowd) % 4, 0, tick)
            ids = crowd[0::4]
            self.assertEqual(ids, sorted(set(ids)), f"tick {tick}: i not ascending and unique")
            for k in range(0, len(crowd), 4):
                i, x, y, kind = crowd[k:k + 4]
                self.assertTrue(all(isinstance(v, int) for v in (i, x, y, kind)), crowd[k:k + 4])
                self.assertTrue(0 <= i < n, (tick, i))
                self.assertTrue(0 <= x < w and 0 <= y < h, (tick, i, x, y))
                self.assertTrue(0 <= kind < 16, (tick, i, kind))
                p = sim.folk.people[i]
                self.assertTrue(people.is_folk_id(p.id) and p.id not in named, p.id)
                self.assertTrue(p.alive and not p.gone, p.id)
            seen_some += len(ids)
        self.assertGreater(seen_some, 0, "nobody was ever outdoors")

    def test_occ(self):
        places = len(self.sim.town.places)
        for tick, _, occ in self.frames:
            self.assertEqual(len(occ), places, tick)
            self.assertTrue(all(isinstance(c, int) and c >= 0 for c in occ), tick)

    def test_stats_folk_and_roster(self):
        sim = self.sim
        n = sim.folk.n
        block = stats.stats_json(sim)["folk"]
        self.assertIn("v", block)
        for key in STATS_FOLK:
            self.assertEqual(len(block[key]), n, key)
        rows = sim.folk.roster_rows(sim)
        self.assertEqual(len(rows), n)
        self.assertEqual([r["i"] for r in rows], list(range(n)))
        for r in rows[:50]:
            self.assertEqual(set(r), ROSTER_KEYS)
        json.dumps(block)
        json.dumps(rows)

    def test_folk_pages(self):
        sim = self.sim
        for i in (0, 1, 17, 250, FOLK - 1):
            page = sim.agent_json(f"f{i}")
            self.assertIsNotNone(page, i)
            self.assertEqual(page["kind"], "folk")
            self.assertIn("choices", page)
            self.assertIn("life", page)
            self.assertIsInstance(page["choices"], list)
            json.dumps(page)
        self.assertIsNone(sim.agent_json(f"f{FOLK + 5}"))

    def test_housing_maps_apart(self):
        for tick, state, _ in self.frames:
            self.assertNotIn("lots", state, tick)
            self.assertNotIn("homes", state, tick)
        self.assertEqual(set(self.maps), {"lots", "homes"})
        for key in ("lots", "homes"):
            self.assertEqual(json.dumps(self.full[key], sort_keys=True), json.dumps(self.maps[key], sort_keys=True))

    def test_lengths_after_a_birth(self):
        self.assertIsNotNone(self.baby)
        state, block, rows = self.after_birth
        n = state["folk_n"]
        self.assertEqual(n, FOLK + 1)
        self.assertEqual(n, self.baby.i + 1)
        for key in STATS_FOLK:
            self.assertEqual(len(block[key]), n, key)
        self.assertEqual(len(rows), n)
        self.assertTrue(all(0 <= i < n for i in state["crowd"][0::4]))


if __name__ == "__main__":
    unittest.main()
