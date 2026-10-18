"""The life soak (L2, GOAL_SLOW; life.md 6): the region with 1,000 townsfolk (1,060 people) for 180 days on seeds 1-3
(SOAK_DAYS and SOAK_SEEDS override them). Bounds that are counts over the run scale with the days.

births and deaths over three seeds 15-45; ill now 3-12%; at luck 0 <= 15% of workers fired; News importance 1+ <= 30
a day; raises 1 in 6 to 1 in 2 reviews; money at the end: median adult worth 0.9-1.7x start, 25-50% poorer, 3-15%
in debt, Gini 0.48-0.72; nobody starves (the food bank, life's ward care and affordable homes: stage 5), at luck 0
too. Deaths and News leave out folk.py's starvation deaths (F2a's), which are reported apart.

`python3 -m tests.test_life_soak SEED DAYS [LUCK]` prints one run's numbers.
"""

import collections
import os
import statistics
import sys
import time
import unittest

from gameofailife import career, housing, people, stats
from gameofailife.sim import Simulation

SLOW = os.environ.get("GOAL_SLOW") == "1"
DAYS = int(os.environ.get("SOAK_DAYS", "180"))
SEEDS = [int(s) for s in os.environ.get("SOAK_SEEDS", "1,2,3").split(",") if s.strip()]
FOLK = 1000


def worth(sim, p) -> float:
    """Cash, savings and (for a named) home equity."""
    if p.id in sim.agents:
        return float(housing.net_worth(sim, p))
    return p.money + p.savings


def measure(seed: int, days: int, luck: float | None = None, folk: int = FOLK) -> dict:
    """One soak run: the region with `folk` townsfolk for `days`; `luck` sets everyone's luck at the start."""
    sim = Simulation(seed, world="region", folk=folk)
    if luck is not None:
        for p in people.everyone(sim):
            p.luck = luck
    adults = [p for p in people.everyone(sim) if p.is_adult and p.alive]
    w0 = {p.id: worth(sim, p) for p in adults}
    workers0 = sum(1 for p in adults if career.worker(p))
    news = collections.Counter()
    news_life = collections.Counter()  # without folk.py's starvation deaths (F2a), as for the deaths bound
    t0 = time.process_time()
    for _ in range(days):
        sim.run_days(1)
        events, _, _ = sim.drain()
        for e in events:
            if e["importance"] >= 1:
                news[e["tick"] // 1440] += 1
                if not (e["tag"] == "death" and " starved, aged " in e["text"]):
                    news_life[e["tick"] // 1440] += 1
    cpu = time.process_time() - t0
    everyone = [p for p in people.everyone(sim) if p.alive]
    stayed = [p for p in adults if p.alive and people.person(sim, p.id) is not None]
    ratios = [worth(sim, p) / w0[p.id] if w0[p.id] > 0 else 1.0 for p in stayed]
    c = sim.life.counts
    return {
        "seed": seed, "days": days, "luck": luck, "cpu": round(cpu, 1), "people": len(everyone),
        "births": c["births"], "deaths": c["deaths"],
        "starved": getattr(sim.folk, "counters", {}).get("starved", 0),  # folk.py's (F2a), not life's mortality
        "food_parcels": getattr(sim.folk, "counters", {}).get("food_parcels", 0),
        "ill_now": sum(1 for p in everyone if p.life is not None and p.life.conditions) / max(1, len(everyone)),
        "workers": workers0, "fired": c["fired"], "laid_off": c["laid_off"], "hired": c["hired"],
        "reviews": c["reviews"], "raises": c["raises"], "warnings": c["warnings"],
        "news_max": max(news.values(), default=0), "news_mean": sum(news.values()) / max(1, days),
        "news_life_max": max(news_life.values(), default=0),
        "worth_median": statistics.median(ratios) if ratios else 1.0,
        "poorer": sum(1 for p in stayed if worth(sim, p) < w0[p.id]) / max(1, len(stayed)),
        "in_debt": sum(1 for p in stayed if p.money + p.savings < 0) / max(1, len(stayed)),
        "gini": stats.gini([worth(sim, p) for p in everyone if p.is_adult]),
        "standing_median": statistics.median([p.reputation for p in everyone if career.worker(p)] or [50.0]),
    }


@unittest.skipUnless(SLOW, "the life soak is GOAL_SLOW")
class LifeSoak(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runs = [measure(seed, DAYS) for seed in SEEDS]
        cls.unlucky = measure(SEEDS[0], DAYS, luck=0.0)
        for r in cls.runs + [cls.unlucky]:
            print("\nsoak", {k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()}, file=sys.stderr)

    def test_births_and_deaths(self):
        scale = DAYS / 180 * len(SEEDS) / 3
        births = sum(r["births"] for r in self.runs)
        deaths = sum(r["deaths"] - r["starved"] for r in self.runs)  # life's mortality; starving is folk.py's
        self.assertTrue(15 * scale <= births <= 45 * scale, births)
        self.assertTrue(15 * scale <= deaths <= 45 * scale, deaths)

    def test_nobody_starves(self):
        for r in self.runs + [self.unlucky]:
            self.assertEqual(r["starved"], 0, r)

    def test_ill_now(self):
        for r in self.runs:
            self.assertTrue(0.03 <= r["ill_now"] <= 0.12, r)

    def test_at_luck_0_few_are_fired(self):
        r = self.unlucky
        self.assertLessEqual(r["fired"] + r["laid_off"], 0.15 * DAYS / 180 * r["workers"], r)

    def test_news_stays_readable(self):
        for r in self.runs:
            self.assertLessEqual(r["news_life_max"], 30, r)

    def test_raises_per_review(self):
        reviews = sum(r["reviews"] for r in self.runs)
        raises = sum(r["raises"] for r in self.runs)
        self.assertGreater(reviews, 0)
        self.assertTrue(1 / 6 <= raises / reviews <= 1 / 2, (raises, reviews))

    def test_money(self):
        for r in self.runs:
            with self.subTest(seed=r["seed"]):
                self.assertTrue(0.9 <= r["worth_median"] <= 1.7, r)
                self.assertTrue(0.25 <= r["poorer"] <= 0.50, r)
                self.assertTrue(0.03 <= r["in_debt"] <= 0.15, r)
                self.assertTrue(0.48 <= r["gini"] <= 0.72, r)


if __name__ == "__main__":
    args = sys.argv[1:]
    out = measure(int(args[0]) if args else 1, int(args[1]) if len(args) > 1 else 30,
                  float(args[2]) if len(args) > 2 else None)
    print({k: round(v, 3) if isinstance(v, float) else v for k, v in out.items()})
