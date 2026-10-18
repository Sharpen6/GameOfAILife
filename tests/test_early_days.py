"""The first week with the 1,000 (life.md 1, "By day 7"): on seeds 1-3, at least 5 new friendships and at least one
romance event for a named (a flirt, a date, going out, a crush or asked-out fork) by the end of day 7. Each seed
stops as soon as both have happened. L2's half of the first week is tests/test_early_days_life.py."""

from __future__ import annotations

import unittest

from gameofailife import people
from gameofailife.sim import Simulation

DAY = 24 * 60
ROMANCE_TAGS = {"flirt", "partner", "meetup", "engaged", "wedding", "moved_in"}
ROMANCE_FORKS = {"crush", "asked_out", "date", "move_in", "propose", "proposal"}


def first_week(seed: int, folk: int = 1000) -> dict:
    sim = Simulation(seed, world="region", folk=folk)
    romance = None
    for minute in range(7 * DAY):
        sim.step()
        events, forks, _ = sim.drain()
        if romance is None:
            for e in events:
                ids = [e.get("agent")] + list(e.get("agents") or [])
                if e["tag"] in ROMANCE_TAGS and any(i in sim.agents for i in ids if i):
                    romance = (sim.clock.day, e["text"])
                    break
            for f in forks:
                if romance is None and f.get("kind") in ROMANCE_FORKS and f.get("agent") in sim.agents:
                    romance = (sim.clock.day, f["question"])
        if romance is not None and sim.social.counts["friendships"] >= 5:
            break
    return {"day": sim.clock.day, "friendships": sim.social.counts["friendships"], "romance": romance,
            "talks": sim.social.counts["talks"], "folk": sim.folk.n, "people": len(people.everyone(sim))}


class EarlyDaysTest(unittest.TestCase):
    def test_seeds_one_to_three(self):
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                out = first_week(seed)
                self.assertEqual(out["folk"], 1000)
                self.assertGreaterEqual(out["friendships"], 5, out)
                self.assertIsNotNone(out["romance"], out)
                self.assertLess(out["day"], 7, out)  # within the first seven days


if __name__ == "__main__":
    unittest.main()
