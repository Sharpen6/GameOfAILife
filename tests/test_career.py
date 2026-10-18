"""career.py (L2, life.md 5.7): the one job board, standing, reviews, layoffs and hiring, for both tiers."""

import os
import statistics
import unittest
from unittest import mock

from gameofailife import career, dice, folk, life
from gameofailife.agent import Job
from gameofailife.sim import Simulation
from tests.test_life import folk_person, life_sim

SLOW = os.environ.get("GOAL_SLOW") == "1"


def holders(sim) -> dict:
    return {pid: slot for slot, pid in enumerate(career.board(sim).holder) if pid is not None}


class BoardTest(unittest.TestCase):
    def test_slots_are_conserved_through_layoffs_and_hiring(self):
        sim = life_sim()
        b = career.board(sim)
        n = len(b.jobs)
        rr = dice.stream(1, dice.DAY_CAREER, "test", 0)
        laid = [a for a in sim.agents.values() if career.worker(a)][:5]
        for a in laid:
            career.lose_job(sim, a, rr, "laid_off")
            self.assertIsNone(a.job)
            self.assertEqual(a.life.jobless_since, sim.clock.day)
        self.assertEqual(len(b.jobs), n)
        self.assertEqual(sum(h is None for h in b.holder), 5)
        self.assertEqual(b.vacant(sim, laid[0]), [])  # not before they reopen
        for slot in list(b.reopen):
            b.reopen[slot] = sim.clock.day
        for a in laid:
            self.assertTrue(career.hire(sim, a, rr))
        self.assertEqual(len(b.jobs), n)
        got = holders(sim)
        self.assertEqual(len(got), n)
        for pid, slot in got.items():
            self.assertIs(sim.agents[pid].job, b.jobs[slot])
            self.assertEqual(sim.agents[pid].job.slot, slot)

    def test_hiring_respects_the_pay_cap(self):
        sim = life_sim()
        b = career.board(sim)
        a = next(a for a in sim.agents.values() if career.worker(a))
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        b.reopen.clear()
        a.life.last_wage = 1.0  # nothing pays as little as this, or less than 1.25x it
        self.assertFalse(career.hire(sim, a, dice.stream(1, 0)))
        self.assertIsNone(a.job)

    def test_the_benefit_lasts_13_weeks(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        self.assertEqual(career.benefit(sim, a), 0.0)
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        self.assertEqual(career.benefit(sim, a), career.BENEFIT)
        a.life.jobless_since = sim.clock.day - 7 * career.BENEFIT_WEEKS
        self.assertEqual(career.benefit(sim, a), 0.0)

    def test_folk_hiring_goes_nearest_first_and_skips_out_of_reach(self):
        sim = life_sim()
        b = career.board(sim)
        far = Job("clerk", "office", 20, 9, 17, (0, 1, 2, 3, 4))
        near = Job("clerk", "grocer", 20, 9, 17, (0, 1, 2, 3, 4))
        gone = Job("clerk", "nowhere", 25, 9, 17, (0, 1, 2, 3, 4))
        s_far, s_near, s_gone = b.add(far, None), b.add(near, None), b.add(gone, None)
        p = folk_person(sim)
        p.life.jobless_since, p.life.last_wage = 0, 20.0
        minutes = {"office": 40, "grocer": 12, "nowhere": None}
        fake = mock.Mock()
        fake.commute_minutes = lambda person, place: minutes[place]
        fake.isolated = False
        with mock.patch.object(sim, "folk", fake), mock.patch.object(folk, "on_job_change") as changed:
            self.assertTrue(career.hire(sim, p, dice.stream(1, 0)))
        self.assertEqual(p.job.slot, s_near)
        changed.assert_called_once()
        self.assertIsNone(b.holder[s_far])
        self.assertIsNone(b.holder[s_gone])


class StandingTest(unittest.TestCase):
    def test_on_shift_end_on_a_folk_worker(self):
        sim = life_sim()
        b = career.board(sim)
        p = folk_person(sim)
        p.job = Job("porter", "hospital", 18, 7, 15, (0, 1, 2, 3, 4))
        b.add(p.job, p.id)
        events = len(sim.history)
        moved = set()
        for day in range(40):
            sim.clock.tick = 300 + day * 1440
            before = p.reputation
            career.on_shift_end(sim, p)  # a Person: no profile, traits via people.traits
            moved.add(round(p.reputation - before, 3))
        self.assertEqual(len(sim.history), events)  # raises nothing
        self.assertTrue(moved <= {1.2, -1.5, 0.1})
        self.assertGreater(len(moved), 1)

    def test_a_pupil_keeps_v2s_half_point(self):
        sim = life_sim()
        kid = next(a for a in sim.agents.values() if a.job and a.job.hourly_wage == 0)
        rep = kid.reputation
        career.on_shift_end(sim, kid)
        self.assertEqual(kid.reputation, min(100.0, rep + 0.5))

    def test_review_warns_and_fires(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        a.reputation = 15.0
        career.review(sim, a, dice.stream(1, 0))
        self.assertEqual(a.life.warnings, 1)
        self.assertIsNotNone(a.job)
        career.review(sim, a, dice.stream(1, 1))
        self.assertIsNone(a.job)
        self.assertTrue(any(e["tag"] == "job_lost" for e in sim.history))


@unittest.skipUnless(SLOW, "the 120-day standing run is GOAL_SLOW")
class StandingSoak(unittest.TestCase):
    def test_standing_at_luck_50_after_120_days(self):
        days = int(os.environ.get("SOAK_DAYS", "120"))
        sim = Simulation(1)
        sim.run_days(days)
        reps = [a.reputation for a in sim.agents.values() if a.alive and career.worker(a)]
        med = statistics.median(reps)
        low = sum(1 for r in reps if r < 20)
        print(f"\nstanding at luck 50 after {days} days: median {med:.1f}, below 20: {low} of {len(reps)}")
        self.assertTrue(45 <= med <= 58, med)
        self.assertLessEqual(low, 0.1 * len(reps))


if __name__ == "__main__":
    unittest.main()
