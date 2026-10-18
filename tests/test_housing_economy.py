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
LATE_PURCHASE_DAY = 150  # the market keeps moving: some household still buys a home after this day ...
LATE_PURCHASES_FROM, LATE_PURCHASES = 120, 3  # ... and at least this many after this one
# ... and from FLATS_ONLY_FROM to FLATS_ONLY_UNTIL there is never a stretch longer than FLATS_ONLY_MAX_DAYS with only
# flats on the market. The houses that come up are the ones households outgrow and sell on downsizing, a landlord
# sells, or a death leaves; a closed town has only so many, so the limit is measured to FLATS_ONLY_UNTIL, not for the
# whole run (the report shows the whole run).
FLATS_ONLY_FROM = 60
FLATS_ONLY_UNTIL = 240
FLATS_ONLY_MAX_DAYS = 30


def soak(seed: int, days: int) -> dict:
    """Run one city for `days` game days on profile defaults and measure its housing economy."""
    from gameofailife.sim import Simulation

    sim = Simulation(seed=seed, now=lambda: 0.0)
    out = {"seed": seed, "days": days, "forks": collections.Counter(), "bad_forks": [], "moves": 0, "purchases": 0,
           "first_purchase_day": None, "last_purchase_day": None, "purchase_days": [], "forced": 0, "hardship": 0, "emergencies": 0,
           "stuff": collections.Counter(), "max_arrears": 0, "min_monday_funds": None, "house_days": 0,
           "shabby_days": 0, "in_the_red": 0, "flats_only": []}
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
                out["purchase_days"].append(s.clock.day)
                if out["first_purchase_day"] is None:
                    out["first_purchase_day"] = s.clock.day
        return moved

    housing.move_household = counted  # the engine and the forks reach it through the module
    open_run = None  # the last hour of the stretch still running
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
                day = sim.clock.tick / MINUTES_PER_DAY
                if day > FLATS_ONLY_FROM:  # stretches with nothing but flats on the market, [first day, last day]
                    if all(h.tier == "flat" for h in housing.vacancies(sim)):
                        runs = out["flats_only"]
                        if runs and runs[-1][1] == open_run:
                            runs[-1][1] = day
                        else:
                            runs.append([day, day])
                        open_run = day
                    else:
                        open_run = None
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


def flats_only_days(r: dict, until: float | None = None) -> float:
    """The longest stretch with only flats on the market, in days, counting up to day `until` when given."""
    return max([min(b, until or b) - a for a, b in r["flats_only"] if until is None or a < until], default=0.0)


def report(r: dict, seconds: float) -> str:
    share = r["shabby_days"] / r["house_days"] if r["house_days"] else 0.0
    last = r["flats_only"][-1] if r["flats_only"] else None
    until = min(r["days"], FLATS_ONLY_UNTIL)
    late = sum(d >= LATE_PURCHASES_FROM for d in r["purchase_days"])
    return (f"seed {r['seed']}, {r['days']} days ({seconds:.0f}s): moves {r['moves']}, purchases {r['purchases']} "
            f"(first on day {r['first_purchase_day']}, last on day {r['last_purchase_day']}, {late} from day "
            f"{LATE_PURCHASES_FROM}), forced moves "
            f"{r['forced']}, hardship episodes {r['hardship']}, emergencies {r['emergencies']}, owner-occupied "
            f"house-days at stage 2+ {share:.1%}, in the red {r['in_the_red']}, max arrears {r['max_arrears']}, "
            f"lowest Monday funds ${r['min_monday_funds']:,.0f}, belongings sales {sum(r['stuff'].values())}, "
            f"housing forks {dict((k, v) for k, v in r['forks'].items() if k in ('house_hunt', 'upkeep', 'repair', 'housing_trouble'))}, "
            f"longest flats-only market after day {FLATS_ONLY_FROM} {flats_only_days(r, until):.1f} days "
            f"to day {until}, {flats_only_days(r):.1f} in all"
            + (f" (the last from day {last[0]:.1f} to day {last[1]:.1f})" if last else ""))


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
                    late = [d for d in r["purchase_days"] if d >= LATE_PURCHASES_FROM]
                    self.assertGreaterEqual(len(late), LATE_PURCHASES, r["purchase_days"])
                if DAYS >= LATE_PURCHASE_DAY:  # nor is it only flats for long
                    until = min(DAYS, FLATS_ONLY_UNTIL)
                    self.assertLessEqual(flats_only_days(r, until), FLATS_ONLY_MAX_DAYS, r["flats_only"])
                self.assertGreaterEqual(r["moves"], MOVES[0] * DAYS // 360)  # the gate's 10 a year, pro rata
                self.assertLessEqual(r["moves"], MOVES[1])


if __name__ == "__main__":
    unittest.main()
