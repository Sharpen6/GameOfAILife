"""money.py (L2, life.md 5.8): lifestyle spending, shocks, debt interest, child and chronic costs, benefit."""

import unittest
from unittest import mock

from gameofailife import career, dice, life, money, people
from tests.test_life import life_sim


def no_shocks():
    return mock.patch.object(money, "_shock", return_value=0)


class LifestyleTest(unittest.TestCase):
    def test_first_week_spends_the_target(self):
        sim = life_sim()
        a = sim.agents["ari"]
        t = people.traits(a)
        pay = money._income(sim, a)
        target = (0.25 + 0.30 * (1 - t["thrift"]) + 0.10 * (t["adventure"] - 0.5)) * pay
        before = a.money + a.savings
        with no_shocks():
            money.weekly(sim, a)
        self.assertAlmostEqual(a.life.lifestyle, target)
        self.assertAlmostEqual(a.life.pay, pay)
        self.assertLess(a.money + a.savings, before - target + 1)

    def test_lifestyle_rises_fast_and_falls_slowly(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks():
            money.weekly(sim, a)
            target = a.life.lifestyle
            a.life.lifestyle = target - 100
            money.weekly(sim, a)
            self.assertAlmostEqual(a.life.lifestyle, target - 75)
            a.life.lifestyle = target + 100
            money.weekly(sim, a)
            self.assertAlmostEqual(a.life.lifestyle, target + 94)

    def test_halved_while_belt_tightening(self):
        sim = life_sim()
        a = sim.agents["ari"]
        sim.households[a.household_id].tight_until = sim.clock.tick + 10_000
        with no_shocks():
            m0 = a.money
            money.weekly(sim, a)
            spent_tight = m0 - a.money
        sim2 = life_sim()
        c = sim2.agents["ari"]
        with no_shocks():
            m2 = c.money
            money.weekly(sim2, c)
        self.assertAlmostEqual(spent_tight, (m2 - c.money) / 2, places=6)


class ShockTest(unittest.TestCase):
    def test_bad_and_good_rolls_are_luck_shifted_and_logged(self):
        sim = life_sim()
        a = sim.agents["dana"]
        seen = []
        with mock.patch.object(people, "log_roll", lambda s, p, what, prob, roll: seen.append((what, prob))):
            money.weekly(sim, a)
        whats = [w for w, _ in seen]
        self.assertIn("shock_bad", whats)
        self.assertIn("shock_good", whats)
        bad = dict(seen)["shock_bad"]
        total = sum(r[1] for r in money.BAD if r[4] != "car" or a.owns_car)
        self.assertAlmostEqual(bad, dice.odds(total, -1, a.luck))

    def test_importance_by_amount(self):
        sim = life_sim()
        a = sim.agents["dana"]
        self.assertEqual([money._importance(sim, a, x) for x in (299, 300, 1999, 2000)], [0, 1, 1, 2])

        class Folk:
            id = "f1"
        self.assertEqual([money._importance(sim, Folk, x) for x in (999, 1000, 4999, 5000)], [0, 1, 1, 2])


class DebtTest(unittest.TestCase):
    def test_interest_on_debt(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks(), mock.patch.object(money, "_income", return_value=0.0):
            a.money, a.savings = -1000.0, 0.0
            a.life.lifestyle, a.life.pay = 0.0, 0.0
            money.weekly(sim, a)
        self.assertAlmostEqual(a.money, -1000.0 * (1 + money.DEBT_RATE))

    def test_savings_cover_a_negative_purse(self):
        sim = life_sim()
        a = sim.agents["ari"]
        with no_shocks():
            a.money, a.savings = -50.0, 5000.0
            money.weekly(sim, a)
        self.assertGreaterEqual(a.money, 0.0)

    def test_children_cost_the_richest_adult(self):
        sim = life_sim()
        shira, eli = sim.agents["shira"], sim.agents["eli"]
        for q in (shira, eli):
            q.life.chronic, q.life.treated = [], []  # chronic costs are their own line
        kids = [m for m in people.members(sim, shira) if m.age < 18]
        cost = sum(next(c for u, c in money.CHILD_COST if k.age < u) for k in kids)
        richer, poorer = (shira, eli) if shira.money + shira.savings >= eli.money + eli.savings else (eli, shira)
        with no_shocks(), mock.patch.object(money, "_income", return_value=0.0):
            m = poorer.money
            money.weekly(sim, poorer)
            self.assertAlmostEqual(poorer.money, m)  # nothing for the poorer partner (and no pay: no lifestyle)
            r = richer.money
            money.weekly(sim, richer)
        if kids:
            self.assertLessEqual(richer.money, r - cost + 1e-9)

    def test_benefit_is_paid_to_the_laid_off(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        with no_shocks():
            money.weekly(sim, a)
        self.assertEqual(a.life.pay, career.BENEFIT)


if __name__ == "__main__":
    unittest.main()
