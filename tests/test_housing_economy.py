"""The housing economy over a long run (PLAN 5.6, the P2 merge gate): nobody goes bankrupt by default.

Skipped unless GOAL_SLOW=1. SOAK_DAYS sets the length (default 360). Seeds 1-3 run headless with every
character on its profile defaults. The development loop is `GOAL_SLOW=1 SOAK_DAYS=120 python3 -m unittest
tests.test_housing_economy`.
"""

from __future__ import annotations

import collections
import os
import time
import unittest

from gameofailife import housing
from gameofailife.clock import MINUTES_PER_DAY

SLOW = os.environ.get("GOAL_SLOW") == "1"
DAYS = int(os.environ.get("SOAK_DAYS", "360"))
SEEDS = (1, 2, 3)
FUNDS_FLOOR = -2500
MOVES = (10, 150)
LATE_PURCHASE_DAY = 150  # the market keeps moving: some household still buys a home after this day


def soak(seed: int, days: int) -> dict:
    """Run one city for `days` game days on profile defaults and measure its housing economy."""
    from gameofailife.sim import Simulation

    sim = Simulation(seed=seed, now=lambda: 0.0)
    out = {"seed": seed, "days": days, "forks": collections.Counter(), "bad_forks": [], "moves": 0, "purchases": 0,
           "first_purchase_day": None, "last_purchase_day": None, "forced": 0, "hardship": 0, "emergencies": 0,
           "stuff": collections.Counter(), "max_arrears": 0, "min_monday_funds": None, "house_days": 0,
           "shabby_days": 0, "in_the_red": 0}
    director = sim.director

    def watch(agent, fork):
        out["forks"][fork.kind] += 1
        names = [o.label for o in fork.options]
        if len(names) != 4 or len(set(names)) != 4:
            out["bad_forks"].append((fork.kind, names))
        director(agent, fork)

    sim.director = watch
    move = housing.move_household

    def counted(s, hh, home_id, how, *args, **kw):
        moved = move(s, hh, home_id, how, *args, **kw)
        if moved:
            out["moves"] += 1
            if kw.get("forced"):
                out["forced"] += 1
            if how == "buy":
                out["purchases"] += 1
                out["last_purchase_day"] = s.clock.day
                if out["first_purchase_day"] is None:
                    out["first_purchase_day"] = s.clock.day
        return moved

    housing.move_household = counted  # the engine and the forks reach it through the module
    try:
        end = sim.clock.tick + days * MINUTES_PER_DAY
        while sim.clock.tick < end:
            sim.step()
            events, _, _ = sim.drain()
            for e in events:
                tag = e["tag"]
                if tag == "hardship":
                    out["hardship"] += 1
                elif tag == "emergency":
                    out["emergencies"] += 1
                elif tag == "in_the_red":
                    out["in_the_red"] += 1
                elif tag == "stuff_sold" and e["agent"]:
                    out["stuff"][sim.agents[e["agent"]].household_id] += 1
            m = sim.clock.minute_of_day
            if m % 60 == 0:
                out["max_arrears"] = max([out["max_arrears"]] + [hh.arrears for hh in sim.households.values()])
            if m == 0:
                if sim.clock.weekday == 0:
                    lowest = min(housing.funds(sim, hh) for hh in sim.households.values()
                                 if housing.adults(sim, hh))
                    if out["min_monday_funds"] is None or lowest < out["min_monday_funds"]:
                        out["min_monday_funds"] = lowest
                for home in sim.homes.values():
                    if housing.owner_occupied(home) and home.tier != "flat":
                        out["house_days"] += 1
                        if housing.stage_of(housing.condition_of(sim, home.id)) >= 2:
                            out["shabby_days"] += 1
    finally:
        housing.move_household = move
    return out


def report(r: dict, seconds: float) -> str:
    share = r["shabby_days"] / r["house_days"] if r["house_days"] else 0.0
    return (f"seed {r['seed']}, {r['days']} days ({seconds:.0f}s): moves {r['moves']}, purchases {r['purchases']} "
            f"(first on day {r['first_purchase_day']}, last on day {r['last_purchase_day']}), forced moves "
            f"{r['forced']}, hardship episodes {r['hardship']}, emergencies {r['emergencies']}, owner-occupied "
            f"house-days at stage 2+ {share:.1%}, in the red {r['in_the_red']}, max arrears {r['max_arrears']}, "
            f"lowest Monday funds ${r['min_monday_funds']:,.0f}, belongings sales {sum(r['stuff'].values())}, "
            f"housing forks {dict((k, v) for k, v in r['forks'].items() if k in ('house_hunt', 'upkeep', 'repair', 'housing_trouble'))}")


@unittest.skipUnless(SLOW, "the long housing soak runs with GOAL_SLOW=1 (SOAK_DAYS sets its length)")
class HousingEconomyTest(unittest.TestCase):
    def test_nobody_goes_bankrupt_by_default(self):
        totals = collections.Counter()
        for seed in SEEDS:
            with self.subTest(seed=seed):
                start = time.time()
                r = soak(seed, DAYS)
                print("\n" + report(r, time.time() - start), flush=True)
                totals["moves"] += r["moves"]
                self.assertEqual(r["bad_forks"], [])
                self.assertLess(r["max_arrears"], 4)
                self.assertGreaterEqual(r["min_monday_funds"], FUNDS_FLOOR)
                limit = DAYS // 28 + 1
                self.assertTrue(all(n <= limit for n in r["stuff"].values()), r["stuff"])
                self.assertIsNotNone(r["first_purchase_day"])
                self.assertLess(r["first_purchase_day"], 30)
                if DAYS > LATE_PURCHASE_DAY + 30:  # homes keep changing hands: the market never freezes for good
                    self.assertGreater(r["last_purchase_day"], LATE_PURCHASE_DAY)
                self.assertGreaterEqual(r["moves"], MOVES[0] * DAYS // 360)  # the gate's 10 a year, pro rata
                self.assertLessEqual(r["moves"], MOVES[1])


if __name__ == "__main__":
    unittest.main()
