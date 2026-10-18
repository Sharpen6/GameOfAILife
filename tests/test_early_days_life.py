"""The first week with life on (L2, life.md 5.6 and 6): a birth by day 7 on seeds 1-3, and the town's first days
read as a life (someone ill, Ari Ben-David's bill, no one starving)."""

import unittest

from gameofailife import life
from gameofailife.sim import Simulation

DAYS = 7


class FirstWeekTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sims = {}
        for seed in (1, 2, 3):
            sim = Simulation(seed)
            sim.run_days(DAYS)  # no server drains sim.events, so it holds the whole week
            cls.sims[seed] = sim

    def test_a_birth_by_day_7(self):
        for seed, sim in self.sims.items():
            with self.subTest(seed=seed):
                births = [e for e in sim.events if e["tag"] == "birth"]
                self.assertGreaterEqual(len(births), 1)
                self.assertGreaterEqual(sim.life.counts["births"], 1)
                self.assertLess(births[0]["tick"], DAYS * 1440)

    def test_shira_peretz_has_her_baby_on_day_4(self):
        for seed, sim in self.sims.items():
            with self.subTest(seed=seed):
                born = next(e for e in sim.events if e["tag"] == "birth" and "Shira" in e["text"])
                self.assertEqual(born["tick"] // 1440, life.SHIRA_DUE[0])
                self.assertEqual(len(sim.agents), 61)
                baby = next(a for a in sim.agents.values() if a.age == 0)
                self.assertEqual(baby.household_id, sim.agents["shira"].household_id)
                self.assertIsNone(sim.agents["shira"].life.pregnant)

    def test_the_week_has_illness_and_no_one_starves(self):
        for seed, sim in self.sims.items():
            with self.subTest(seed=seed):
                tags = {e["tag"] for e in sim.events}
                self.assertTrue(tags & {"ill", "doctor", "injury", "recovered"}, tags)
                for a in sim.agents.values():
                    if a.alive:
                        self.assertGreater(a.health, 0, a.id)
                        self.assertGreater(a.needs["hunger"], 0, a.id)

    def test_ari_ben_davids_bill_lands_on_day_2(self):
        for seed, sim in self.sims.items():
            with self.subTest(seed=seed):
                day = life.ARI_BILL[0]
                bills = [e for e in sim.events if e["tag"] == "expense" and e.get("agent") == "ari"
                         and e["tick"] // 1440 == day]
                self.assertTrue(bills, [e for e in sim.events if e.get("agent") == "ari" and e["tag"] == "expense"])


if __name__ == "__main__":
    unittest.main()
