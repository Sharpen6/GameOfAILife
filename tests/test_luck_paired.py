"""The paired luck run (L2, GOAL_SLOW; life.md 5.10): luck has to matter to a life.

Per seed, Millbrook's 60 for 120 days twice: once with half the adults (alternate ones in id order) at luck 100 and
the rest at 0, once with the halves swapped. Per adult, the change in worth when lucky minus the change when unlucky:
the median must be at least $600 and at least 80% of the adults better off lucky. SOAK_DAYS (120) and SOAK_SEEDS
(1,2,3) override the run. `python3 -m tests.test_luck_paired SEED DAYS` prints one seed's numbers.
"""

import os
import statistics
import sys
import unittest

from gameofailife import housing
from gameofailife.sim import Simulation

SLOW = os.environ.get("GOAL_SLOW") == "1"
DAYS = int(os.environ.get("SOAK_DAYS", "120"))
SEEDS = [int(s) for s in os.environ.get("SOAK_SEEDS", "1,2,3").split(",") if s.strip()]
MEDIAN_AT_LEAST = 600
BETTER_OFF_SHARE = 0.8


def _run(seed: int, days: int, lucky: set) -> dict:
    """Each adult's change in worth over the run, with `lucky` at 100 and the other adults at 0."""
    sim = Simulation(seed, now=lambda: 0.0)
    adults = sorted((a for a in sim.agents.values() if a.is_adult), key=lambda a: a.id)
    for a in adults:
        a.luck = 100.0 if a.id in lucky else 0.0
    start = {a.id: housing.net_worth(sim, a) for a in adults}
    sim.run_days(days)
    return {a.id: housing.net_worth(sim, a) - start[a.id] for a in adults if a.alive}


def paired(seed: int, days: int) -> dict:
    ids = sorted(a.id for a in Simulation(seed, now=lambda: 0.0).agents.values() if a.is_adult)
    half = set(ids[0::2])
    one, two = _run(seed, days, half), _run(seed, days, set(ids) - half)
    diff = []
    for pid in ids:
        if pid in one and pid in two:
            lucky, unlucky = (one[pid], two[pid]) if pid in half else (two[pid], one[pid])
            diff.append(lucky - unlucky)
    better = sum(1 for d in diff if d > 0)
    return {"seed": seed, "days": days, "adults": len(diff), "median": statistics.median(diff),
            "mean": statistics.mean(diff), "better_off": better}


@unittest.skipUnless(SLOW, "the paired luck run is GOAL_SLOW")
class LuckPairedTest(unittest.TestCase):
    def test_luck_pays_per_adult(self):
        for seed in SEEDS:
            with self.subTest(seed=seed):
                r = paired(seed, DAYS)
                print(f"\nluck paired seed {seed}, {DAYS} days: median {r['median']:+,.0f}, mean {r['mean']:+,.0f}, "
                      f"better off {r['better_off']} of {r['adults']}", file=sys.stderr)
                self.assertGreaterEqual(r["median"], MEDIAN_AT_LEAST * DAYS / 120)
                self.assertGreaterEqual(r["better_off"], BETTER_OFF_SHARE * r["adults"])


if __name__ == "__main__":
    args = sys.argv[1:]
    print(paired(int(args[0]) if args else 1, int(args[1]) if len(args) > 1 else DAYS))
