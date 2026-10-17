"""The dashboard's data (P3): the `stats` message of PLAN 3.8, its samples and rings, the richest headline, the
friendship rule (chronicle.on_affinity), `get_decisions` pages and the LLM counters. No sockets here: the
server's side of the dashboard is tests/test_dashboard_server.py."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import math
import re
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import chronicle, housing, stats, ws
from gameofailife.__main__ import run_headless
from gameofailife.agent import RelationKind, Relationship
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Fork, Option
from gameofailife.sim import ANSWER_SECONDS, Simulation
from gameofailife.town import DISTRICTS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
import claude_controller as cc  # noqa: E402

SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence",
               "due", "pending_emergency", "roll", "base_p", "hit"}

# PLAN 3.8, key by key.
TOP_KEYS = {"type", "full", "tick", "time", "day", "city", "llm", "districts", "households", "people", "samples"}
CITY_KEYS = {"population", "start_population", "deaths", "births", "adults", "children", "working", "students",
             "retired", "out_of_work", "mood", "health", "needs", "wealth", "homes", "luck", "recent_deaths"}
WEALTH_KEYS = {"total", "median", "top10_share", "gini", "in_debt"}
HOMES_KEYS = {"total", "owned", "rented", "for_sale", "for_rent", "lots_by_stage", "neglected_lived_in"}
LUCK_KEYS = {"touched", "raised", "lowered", "mean"}
DEATH_KEYS = {"id", "name", "age", "time", "how"}
LLM_KEYS = {"controllers", "playing", "thinking", "today", "total", "habit_today", "default_today"}
COUNTER_KEYS = {"asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "avg_seconds"}
DISTRICT_KEYS = {"id", "name", "people", "mood", "median_worth", "homes", "vacant", "shabby_plus"}
HOUSEHOLD_KEYS = {"id", "name", "members", "home", "home_name", "place", "tier_label", "tenure", "weekly_cost"}
PEOPLE_KEYS = {"id", "household", "worth", "worth_24h", "cash", "savings", "home_equity", "job", "health"}
SAMPLE_KEYS = {"tick", "day", "pop", "mood", "health", "wealth", "median", "top10", "in_debt", "working", "owned",
               "shabby_plus", "asked", "in_time"}

RUN: dict = {}


def setUpModule():
    # Half a day of the starter city: twelve hourly samples, plenty of decisions, a few events.
    sim = Simulation(seed=1)
    for _ in range(12 * 60):
        sim.step()
    RUN["sim"] = sim


def find_secret_keys(obj, path="") -> list[str]:
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in SECRET_KEYS:
                found.append(f"{path}.{k}")
            found += find_secret_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found += find_secret_keys(v, f"{path}[{i}]")
    return found


def numbers(obj, path=""):
    """Every number anywhere in a JSON value, with its path."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from numbers(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from numbers(v, f"{path}[{i}]")


def plain_fork(agent_id: str, tick: int, bases=(0.0, 0.0, 0.0, 0.0)) -> Fork:
    """Four plain options scored only by their base, so the profile's own choice is the first best one."""
    return Fork(agent_id, "test", "What do you do?",
                [Option(f"Option {'ABCD'[i]}", [("idle", None)], base=b) for i, b in enumerate(bases)], tick)


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class TestNumberRules(unittest.TestCase):
    def test_rounding_is_floor_x_plus_half(self):
        self.assertEqual([stats._int(x) for x in (2.5, 3.5, -2.5, -0.4, 0.49999)], [3, 4, -2, 0, 0])

    def test_median(self):
        self.assertEqual(stats.median([]), 0)
        self.assertEqual(stats.median([5, 1, 3]), 3)
        self.assertEqual(stats.median([4, 1, 3, 2]), 2.5)

    def test_gini(self):
        self.assertEqual(stats.gini([]), 0)
        self.assertEqual(stats.gini([5, 5, 5]), 0)
        self.assertEqual(stats.gini([0, 0, 0, 10]), 0.75)
        self.assertEqual(stats.gini([-50, 0, 0, 10]), 0.75)  # debts count as nothing
        self.assertEqual(stats.gini([1, 2]), 0.17)  # 1/6, to two decimals

    def test_top_share(self):
        self.assertEqual(stats.top_share([]), 0)
        self.assertEqual(stats.top_share([10] * 10), 10)
        self.assertEqual(stats.top_share([70] + [10] * 9 + [0]), 50)  # 11 people: the richest 2 hold half

    def test_avg_seconds(self):
        block = stats._zeros()
        self.assertIsNone(stats.avg_seconds(block))
        block.update(in_time=3, seconds=7.0)
        self.assertEqual(stats.avg_seconds(block), 2.3)


class TestStatsSchema(unittest.TestCase):
    def setUp(self):
        self.sim = RUN["sim"]
        self.full = self.sim.stats_json(full=True)

    def test_keys_are_exactly_plan_3_8(self):
        s = self.full
        self.assertEqual(set(s), TOP_KEYS)
        self.assertEqual((s["type"], s["full"], s["tick"], s["time"], s["day"]),
                         ("stats", True, self.sim.clock.tick, self.sim.clock.stamp(), self.sim.clock.day))
        self.assertEqual(set(s["city"]), CITY_KEYS)
        self.assertEqual(set(s["city"]["wealth"]), WEALTH_KEYS)
        self.assertEqual(set(s["city"]["homes"]), HOMES_KEYS)
        self.assertEqual(set(s["city"]["luck"]), LUCK_KEYS)
        self.assertEqual(set(s["city"]["needs"]), {"hunger", "energy", "social", "fun"})
        self.assertEqual(set(s["llm"]), LLM_KEYS)
        self.assertEqual(set(s["llm"]["today"]), COUNTER_KEYS)
        self.assertEqual(set(s["llm"]["total"]), COUNTER_KEYS)
        for row in s["districts"]:
            self.assertEqual(set(row), DISTRICT_KEYS)
        for row in s["households"]:
            self.assertEqual(set(row), HOUSEHOLD_KEYS)
        for row in s["people"]:
            self.assertEqual(set(row), PEOPLE_KEYS)
        self.assertEqual(len(s["samples"]), 12)
        for row in s["samples"]:
            self.assertEqual(set(row), SAMPLE_KEYS)
        json.dumps(s)  # plain JSON

    def test_every_number_is_an_integer_but_gini_and_avg_seconds(self):
        for path, x in numbers(self.full):
            with self.subTest(path=path):
                if path.endswith(".gini"):
                    self.assertEqual(x, math.floor(x * 100 + 0.5) / 100)
                elif path.endswith(".avg_seconds"):
                    self.assertEqual(x, math.floor(x * 10 + 0.5) / 10)
                else:
                    self.assertIsInstance(x, int)
        self.assertIsInstance(self.full["city"]["wealth"]["gini"], float)

    def test_people_are_the_living_richest_first(self):
        sim, people = self.sim, self.full["people"]
        self.assertEqual([p["id"] for p in people], [a.id for a in sorted(sim.living(), key=lambda a: (
            -housing.net_worth(sim, a), a.id))])
        self.assertEqual(len(people), self.full["city"]["population"])
        keys = [(-p["worth"], p["id"]) for p in people]
        self.assertEqual(keys, sorted(keys))

    def test_worth_is_cash_savings_and_home_equity(self):
        sim = self.sim
        for row in self.full["people"]:
            with self.subTest(id=row["id"]):
                a = sim.agents[row["id"]]
                hh = sim.households[a.household_id]
                self.assertEqual(row["worth"], row["cash"] + row["savings"] + row["home_equity"])
                self.assertEqual(row["cash"], math.floor(a.money + 0.5))
                saved = a.goal["saved"] if a.goal else 0
                self.assertEqual(row["savings"], math.floor(a.savings + saved + 0.5))
                owners = housing.adults(sim, hh)
                if a.is_adult and sim.homes[hh.home_id].owner == hh.id:
                    self.assertEqual(row["home_equity"], math.floor(housing.value(sim, hh.home_id) / len(owners) + 0.5))
                else:
                    self.assertEqual(row["home_equity"], 0)
                self.assertEqual(row["household"], a.household_id)
                self.assertEqual(row["job"], a.job.title if a.job else None)

    def test_worth_counts_the_goal_pot_and_splits_an_owned_home(self):
        sim = Simulation(seed=1)
        owned = next(hh for hh in sim.households.values()
                     if sim.homes[hh.home_id].owner == hh.id and len(housing.adults(sim, hh)) == 2)
        a, b = housing.adults(sim, owned)
        a.money, a.savings, a.goal = 100.4, 50, {"name": "a bike", "saved": 30, "target": 400}
        rows = {p["id"]: p for p in sim.stats_json()["people"]}
        share = housing.value(sim, owned.home_id) / 2
        self.assertEqual((rows[a.id]["cash"], rows[a.id]["savings"], rows[a.id]["home_equity"]),
                         (100, 80, math.floor(share + 0.5)))
        self.assertEqual(rows[a.id]["worth"], 180 + math.floor(share + 0.5))
        sim._die(b, "passed away")
        rows = {p["id"]: p for p in sim.stats_json()["people"]}
        self.assertEqual(rows[a.id]["home_equity"], housing.value(sim, owned.home_id))  # one owner left
        self.assertNotIn(b.id, rows)

    def test_wealth_block(self):
        people, w = self.full["people"], self.full["city"]["wealth"]
        adults = [p["worth"] for p in people if self.sim.agents[p["id"]].is_adult]
        self.assertEqual(w["total"], sum(p["worth"] for p in people))
        self.assertEqual(w["median"], math.floor(stats.median(adults) + 0.5))
        self.assertEqual(w["gini"], stats.gini(adults))
        self.assertEqual(w["top10_share"], stats.top_share(adults))
        self.assertEqual(w["in_debt"], sum(1 for p in people if self.sim.agents[p["id"]].is_adult
                                           and p["cash"] + p["savings"] < 0))

    def test_lots_by_stage_counts_the_22_residential_lots(self):
        homes = self.full["city"]["homes"]
        self.assertEqual(len(self.sim.lots), 22)
        self.assertEqual(len(homes["lots_by_stage"]), 5)
        self.assertEqual(sum(homes["lots_by_stage"]), 22)
        self.assertEqual(homes["total"], len(self.sim.homes))
        self.assertEqual(homes["owned"] + homes["rented"], sum(1 for h in self.sim.homes.values() if h.household))
        sim = Simulation(seed=1)
        lot = next(iter(sim.lots.values()))
        lot.condition = 10  # derelict
        self.assertEqual(sim.stats_json()["city"]["homes"]["lots_by_stage"][4], 1)

    def test_only_districts_with_homes_in_town_order(self):
        sim = self.sim
        with_homes = {sim.town.places[h.place].district for h in sim.homes.values()}
        rows = self.full["districts"]
        self.assertEqual([r["id"] for r in rows], [d for d, *_ in DISTRICTS if d in with_homes])
        self.assertLess(len(rows), len(DISTRICTS), "some districts have no homes")
        for r in rows:
            self.assertGreater(r["homes"], 0)
        self.assertEqual(sum(r["homes"] for r in rows), len(sim.homes))
        self.assertEqual(sum(r["people"] for r in rows), self.full["city"]["population"])
        self.assertEqual(sum(r["vacant"] for r in rows), sum(1 for h in sim.homes.values() if h.household is None))

    def test_households_with_their_tier_labels(self):
        rows = self.full["households"]
        living = [hh for hh in self.sim.households.values() if any(self.sim.agents[m].alive for m in hh.member_ids)]
        self.assertEqual([r["id"] for r in rows], [hh.id for hh in living])
        self.assertEqual({r["tier_label"] for r in rows} - {"flat", "house", "big house"}, set())
        self.assertIn("big house", {r["tier_label"] for r in rows})
        for r in rows:
            self.assertIn(r["tenure"], ("owned", "rented"))

    def test_city_counts(self):
        city, sim = self.full["city"], self.sim
        alive = sim.living()
        self.assertEqual(city["population"], len(alive))
        self.assertEqual(city["start_population"], len(sim.agents))
        self.assertEqual(city["adults"] + city["children"], city["population"])
        self.assertEqual(city["births"], 0)
        self.assertEqual(city["mood"], math.floor(sum(a.mood for a in alive) / len(alive) + 0.5))
        self.assertEqual(city["luck"], {"touched": 0, "raised": 0, "lowered": 0, "mean": 50})

    def test_recent_deaths_newest_first(self):
        sim = Simulation(seed=1)
        sim._die(sim.agents["david"], "passed away peacefully in their sleep")
        sim.clock.tick += 30
        sim._die(sim.agents["ruth"], "passed away")
        city = sim.stats_json()["city"]
        self.assertEqual([d["id"] for d in city["recent_deaths"]], ["ruth", "david"])
        self.assertEqual(set(city["recent_deaths"][0]), DEATH_KEYS)
        self.assertEqual(city["recent_deaths"][1]["how"], "passed away peacefully in their sleep")
        self.assertEqual((city["deaths"], city["population"]), (2, len(sim.agents) - 2))

    def test_no_secrets_in_stats(self):
        self.assertEqual(find_secret_keys(self.full), [])
        self.assertEqual(find_secret_keys(self.sim.stats_json(full=False)), [])


class TestSamples(unittest.TestCase):
    def test_hourly_samples_and_pushes(self):
        sim = Simulation(seed=1)
        for _ in range(3 * 60):
            sim.step()
        self.assertEqual([s["tick"] for s in sim.stats.samples], [7 * 60, 8 * 60, 9 * 60])
        self.assertEqual(len(sim.stats_json(full=False)["samples"]), 3)  # a push carries what is new ...
        self.assertEqual(sim.stats_json(full=False)["samples"], [])  # ... once
        self.assertEqual(len(sim.stats_json(full=True)["samples"]), 3)  # full carries everything, every time
        for _ in range(60):
            sim.step()
        push = sim.stats_json(full=False)
        self.assertEqual([s["tick"] for s in push["samples"]], [10 * 60])
        self.assertFalse(push["full"])

    def test_a_sample_is_the_city_at_that_hour(self):
        sim = Simulation(seed=1)
        for _ in range(60):
            sim.step()
        s, city = sim.stats.samples[-1], sim.stats_json()["city"]
        self.assertEqual((s["pop"], s["mood"], s["health"], s["wealth"], s["median"], s["top10"], s["in_debt"],
                          s["working"], s["owned"], s["shabby_plus"]),
                         (city["population"], city["mood"], city["health"], city["wealth"]["total"],
                          city["wealth"]["median"], city["wealth"]["top10_share"], city["wealth"]["in_debt"],
                          city["working"], city["homes"]["owned"], sum(city["homes"]["lots_by_stage"][2:])))

    def test_rings_keep_168_samples_and_25_worths(self):
        sim = Simulation(seed=1)
        dana = sim.agents["dana"]
        for hour in range(200):
            sim.clock.tick += 60
            dana.money = 1000 + hour
            sim.stats.sample(sim)
        samples = sim.stats.samples
        self.assertEqual(len(samples), stats.SAMPLES_KEPT)
        ticks = [s["tick"] for s in samples]
        self.assertEqual(ticks, sorted(ticks))
        self.assertEqual(ticks[-1], sim.clock.tick)
        ring = sim.stats.worth["dana"]
        self.assertEqual(len(ring), stats.WORTH_HOURS)
        row = next(p for p in sim.stats_json()["people"] if p["id"] == "dana")
        self.assertEqual(row["worth"] - row["worth_24h"], 24)  # one dollar an hour, 24 hours ago
        self.assertEqual(row["worth_24h"], ring[0])

    def test_asked_and_in_time_are_per_hour(self):
        sim = Simulation(seed=1)
        sim.stats.count("asked")
        sim.stats.count("asked")
        sim.stats.count("in_time", 1.0)
        sim.stats.sample(sim)
        sim.stats.count("asked")
        sim.stats.sample(sim)
        self.assertEqual([(s["asked"], s["in_time"]) for s in sim.stats.samples], [(2, 1), (1, 0)])

    def test_an_empty_city_records_nothing(self):
        sim = Simulation(seed=1)
        sim.agents = {}
        self.assertIsNone(sim.stats.sample(sim))
        self.assertEqual(sim.stats.samples, [])


class TestRichest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=1)
        self.sim.stats.sample(self.sim)  # the first sample names the leader without a headline
        self.holder = self.sim.agents[self.sim.stats.richest]

    def headlines(self) -> list[dict]:
        return [e for e in self.sim.drain()[0] if e["tag"] == "richest"]

    def worth(self, a) -> int:
        return housing.net_worth(self.sim, a)

    def challenger(self):
        adults = sorted((a for a in self.sim.living() if a.is_adult), key=lambda a: (-self.worth(a), a.id))
        return adults[1]

    def test_first_sample_is_silent(self):
        self.assertEqual(self.headlines(), [])
        adults = sorted((a for a in self.sim.living() if a.is_adult), key=lambda a: (-self.worth(a), a.id))
        self.assertIs(self.holder, adults[0])

    def test_a_challenger_needs_two_percent_and_fifty_dollars_more(self):
        c = self.challenger()
        need = self.worth(self.holder) * 1.02 + 50
        c.money += need - self.worth(c) - 2  # just short
        self.sim.stats.sample(self.sim)
        self.assertEqual(self.headlines(), [])
        self.assertEqual(self.sim.stats.richest, self.holder.id)
        c.money += 3  # just over
        self.sim.stats.sample(self.sim)
        (ev,) = self.headlines()
        self.assertEqual(self.sim.stats.richest, c.id)
        self.assertEqual((ev["importance"], ev["kind"], ev["agent"], ev["agents"]),
                         (2, "money", c.id, [c.id, self.holder.id]))
        self.assertEqual(ev["text"], f"{c.name} is now the richest person in Millbrook "
                                     f"(${self.worth(c):,}), ahead of {self.holder.name}.")
        for a in (c, self.holder):  # God-only: nobody remembers it
            self.assertFalse(any("richest" in m for m in a.memory), a.id)
        self.sim.stats.sample(self.sim)
        self.assertEqual(self.headlines(), [], "once a sample")

    def test_the_holder_dying_passes_the_title_on(self):
        c = self.challenger()
        self.sim._die(self.holder, "passed away")
        self.sim.drain()
        self.sim.stats.sample(self.sim)
        (ev,) = self.headlines()
        self.assertEqual(self.sim.stats.richest, c.id)
        runner_up = sorted((a for a in self.sim.living() if a.is_adult), key=lambda a: (-self.worth(a), a.id))[1]
        self.assertEqual(ev["agents"], [c.id, runner_up.id])


class TestFriendship(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=1)
        self.a, self.b = self.sim.agents["dana"], self.sim.agents["omer"]
        self.relate(RelationKind.ACQUAINTANCE, 35)
        self.sim.drain()

    def relate(self, kind, affinity, back=None):
        self.a.relationships[self.b.id] = Relationship(kind, affinity)
        self.b.relationships[self.a.id] = Relationship(back or kind, affinity)

    def tagged(self, tag) -> list[dict]:
        return [e for e in self.sim.drain()[0] if e["tag"] == tag]

    def test_acquaintances_become_friends_at_40(self):
        self.sim._bump(self.a, self.b.id, 4.9)  # 39.9
        self.assertEqual(self.tagged("new_friend"), [])
        self.sim._bump(self.a, self.b.id, 0.1)  # 40
        (ev,) = self.tagged("new_friend")
        self.assertEqual((ev["importance"], ev["agents"], ev["text"]),
                         (2, [self.a.id, self.b.id], "Dana Cohen and Omer Katz have become friends."))
        self.assertEqual(self.a.relationships[self.b.id].kind, RelationKind.FRIEND)
        self.assertEqual(self.b.relationships[self.a.id].kind, RelationKind.FRIEND)
        self.assertIn(ev["text"], self.a.memory[-1])
        self.assertIn(ev["text"], self.b.memory[-1])
        self.sim._bump(self.a, self.b.id, 10)
        self.assertEqual(self.tagged("new_friend"), [], "friends already")

    def test_coworkers_too_but_family_keeps_its_kind(self):
        self.relate(RelationKind.COWORKER, 39)
        self.sim._bump(self.a, self.b.id, 2)
        self.assertEqual(len(self.tagged("new_friend")), 1)
        self.relate(RelationKind.ACQUAINTANCE, 39, back=RelationKind.FAMILY)
        self.sim._bump(self.a, self.b.id, 2)
        self.assertEqual(len(self.tagged("new_friend")), 1)
        self.assertEqual(self.b.relationships[self.a.id].kind, RelationKind.FAMILY)
        self.relate(RelationKind.FAMILY, 39)
        self.sim._bump(self.a, self.b.id, 2)
        self.assertEqual(self.tagged("new_friend"), [])

    def test_falling_out_below_zero_once_a_week(self):
        self.relate(RelationKind.FRIEND, 2)
        self.sim._bump(self.a, self.b.id, -2)  # 0: not below yet
        self.assertEqual(self.tagged("falling_out"), [])
        self.sim._bump(self.a, self.b.id, -1)
        (ev,) = self.tagged("falling_out")
        self.assertEqual((ev["importance"], ev["kind"], ev["agents"], ev["text"]),
                         (2, "social", [self.a.id, self.b.id], "Dana Cohen and Omer Katz have fallen out."))
        self.assertEqual(self.a.relationships[self.b.id].kind, RelationKind.FRIEND, "the kind stays")
        self.relate(RelationKind.PARTNER, 5)
        self.sim.clock.tick += 7 * MINUTES_PER_DAY - 1
        self.sim._bump(self.b, self.a.id, -10)  # the other way round is the same pair
        self.assertEqual(self.tagged("falling_out"), [], "at most once a pair in 7 days")
        self.relate(RelationKind.PARTNER, 5)
        self.sim.clock.tick += 1
        self.sim._bump(self.a, self.b.id, -10)
        self.assertEqual(len(self.tagged("falling_out")), 1)
        self.relate(RelationKind.ACQUAINTANCE, 5)
        self.sim.clock.tick += 7 * MINUTES_PER_DAY
        self.sim._bump(self.a, self.b.id, -10)
        self.assertEqual(self.tagged("falling_out"), [], "acquaintances just drift apart")

    def test_unknown_characters_do_nothing(self):
        self.assertIsNone(chronicle.on_affinity(self.sim, "nobody", self.b.id, 35, 45))
        self.assertIsNone(chronicle.on_affinity(self.sim, self.a.id, "nobody", 35, 45))
        self.assertEqual(self.sim.drain()[0], [])
        self.assertEqual(chronicle.rift_key("b", "a"), chronicle.rift_key("a", "b"))


class TestDecisions(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=1)
        self.dana, self.tom = self.sim.agents["dana"], self.sim.agents["tom"]
        self.ids = []  # model and timeout decisions, oldest first
        self.mine: dict[str, list[str]] = {"dana": [], "tom": []}  # ... and each one's
        for i in range(120):
            who = self.dana if i % 2 else self.tom
            by = ("model", "timeout", "habit", "default")[i % 4]
            fork = plain_fork(who.id, self.sim.clock.tick)
            self.sim._decide(who, fork, 0, by, "because")
            if by in ("model", "timeout"):
                self.ids.append(fork.id)
                self.mine[who.id].append(fork.id)

    def test_the_city_ring_newest_first(self):
        page = self.sim.decisions()
        self.assertEqual(set(page), {"type", "agent_id", "forks", "more"})
        self.assertEqual((page["type"], page["agent_id"], page["more"]), ("decisions", None, True))
        self.assertEqual([f["id"] for f in page["forks"]], self.ids[::-1][:stats.DECISIONS_LIMIT])
        self.assertTrue(all(f["decided_by"] in ("model", "timeout") for f in page["forks"]))

    def test_paging_with_before(self):
        seen, before, more = [], None, True
        while more:
            page = self.sim.decisions(None, before, 10)
            seen += [f["id"] for f in page["forks"]]
            more = page["more"]
            before = seen[-1]
        self.assertEqual(seen, self.ids[::-1])
        self.assertEqual(self.sim.decisions(None, self.ids[0])["forks"], [])
        self.assertEqual(self.sim.decisions(None, "f-unknown"), {"type": "decisions", "agent_id": None,
                                                                   "forks": [], "more": False})

    def test_limits(self):
        many = Simulation(seed=1)
        ari = many.agents["ari"]
        for _ in range(150):
            many._decide(ari, plain_fork(ari.id, many.clock.tick), 0, "timeout", "late")
        self.assertEqual(len(many.decisions(limit=1000)["forks"]), stats.DECISIONS_MAX)
        self.assertEqual(len(many.decisions(limit=0)["forks"]), 1)
        self.assertEqual(len(many.decisions(limit=-5)["forks"]), 1)
        self.assertEqual(len(many.decisions(limit=2.9)["forks"]), 2)
        self.assertEqual(len(many.decisions(limit=None)["forks"]), stats.DECISIONS_LIMIT)
        for bad in ("10", True, float("nan"), float("inf"), [3]):
            with self.subTest(limit=bad), self.assertRaises(TypeError):
                many.decisions(limit=bad)
        with self.assertRaises(TypeError):
            many.decisions(before=7)

    def test_a_character_ring(self):
        page = self.sim.decisions("dana", limit=100)
        self.assertEqual(page["agent_id"], "dana")
        self.assertEqual(len(self.mine["dana"]), 30, "precondition: dana's ring is full")
        self.assertEqual([f["id"] for f in page["forks"]], self.mine["dana"][::-1])
        self.assertFalse(page["more"])
        tom = self.sim.decisions("tom", limit=3)
        self.assertEqual(([f["id"] for f in tom["forks"]], tom["more"]), (self.mine["tom"][::-1][:3], True))
        self.assertEqual(self.sim.decisions("tom", self.mine["tom"][-3], 30)["forks"][0]["id"], self.mine["tom"][-4])
        self.assertIsNone(self.sim.decisions("nobody"))

    def test_no_secrets_in_decisions(self):
        dana = self.dana
        fork = Fork(dana.id, "test", "What do you do?", [Option("Go", [("idle", None)])] * 4, self.sim.clock.tick)
        self.sim._decide(dana, fork, 1, "model", "why not")
        for page in (self.sim.decisions(), self.sim.decisions("dana"), self.sim.decisions(limit=100)):
            self.assertEqual(find_secret_keys(page), [])


class TestLlmCounters(unittest.TestCase):
    def test_the_llm_block(self):
        clock = FakeClock()
        sim = Simulation(seed=1, now=clock)
        dana, tom = sim.agents["dana"], sim.agents["tom"]
        for a in (dana, tom):
            sim.claim(a.id, "bot")
        sim.controller_joined("bot", "test-model", ["dana", "tom"])
        llm = sim.stats_json()["llm"]
        self.assertEqual(llm["controllers"], [{"name": "bot", "model": "test-model", "characters": 2}])
        self.assertEqual((llm["playing"], llm["thinking"]), (2, 0))
        self.assertEqual(llm["today"], {"asked": 0, "in_time": 0, "timeouts": 0, "late": 0, "withdrawn": 0,
                                        "against_habit": 0, "avg_seconds": None})
        # Against habit: the profile picks option B (the best base); the model picks D, then B.
        f1 = plain_fork("dana", sim.clock.tick, (0.0, 0.5, 0.1, 0.0))
        sim.director(dana, f1)
        self.assertEqual(sim.stats_json()["llm"]["thinking"], 1)
        clock.t += 2.0
        sim.answer(f1.id, 3, "fancy that", controller="bot")
        f2 = plain_fork("dana", sim.clock.tick, (0.0, 0.5, 0.1, 0.0))
        sim.director(dana, f2)
        clock.t += 1.0
        sim.answer(f2.id, 1, "as usual", controller="bot")
        # A timeout, then a late answer.
        f3 = plain_fork("tom", sim.clock.tick, (0.0, 0.5, 0.1, 0.0))
        sim.director(tom, f3)
        clock.t += ANSWER_SECONDS + 0.5
        sim._check_timeouts()
        clock.t += 1.0
        sim.answer(f3.id, 0, "sorry, slow", controller="bot")
        # Withdrawn: the character dies while asked.
        f4 = plain_fork("tom", sim.clock.tick, (0.0, 0.5, 0.1, 0.0))
        sim.director(tom, f4)
        sim._die(tom, "passed away")
        llm = sim.stats_json()["llm"]
        want = {"asked": 4, "in_time": 2, "timeouts": 1, "late": 1, "withdrawn": 1, "against_habit": 1,
                "avg_seconds": 1.5}
        self.assertEqual(llm["today"], want)
        self.assertEqual(llm["total"], want)
        self.assertEqual(llm["controllers"], [{"name": "bot", "model": "test-model", "characters": 1}])
        self.assertEqual(llm["playing"], 1)
        sim.stats.reset_day()
        llm = sim.stats_json()["llm"]
        self.assertEqual(llm["today"]["asked"], 0)
        self.assertEqual(llm["total"], want)

    def test_habit_and_default_today(self):
        sim = RUN["sim"]
        llm = sim.stats_json()["llm"]
        self.assertEqual((llm["habit_today"], llm["default_today"]),
                         (sim.stats.today["habit"], sim.stats.today["default"]))
        self.assertGreater(llm["habit_today"] + llm["default_today"], 50)
        self.assertEqual((llm["controllers"], llm["playing"], llm["today"]["asked"]), ([], 0, 0))


class TestHeadlessSummary(unittest.TestCase):
    def test_headlines_counts_and_the_ranking(self):
        sim = Simulation(seed=1)
        step = sim.step

        def step_with_news():
            step()
            if sim.clock.tick == 7 * 60:
                sim.event("Dana Cohen wins the raffle.", sim.agents["dana"], tag="big_money")
                sim.event("Tom Levi trips on the stairs.", sim.agents["tom"], tag="injury")

        sim.step = step_with_news
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            run_headless(sim, 0.25)
        out = printed.getvalue()
        self.assertIn("Day 1 Mon 07:00  Dana Cohen wins the raffle.", out, "headlines as they happen")
        self.assertNotIn("trips on the stairs", out, "notable news is only counted")
        self.assertRegex(out, r"(?m)^News: .*\binjury 1\b")
        self.assertRegex(out, r"(?m)^AI players: asked 0, in time 0, timed out 0, late 0, withdrawn 0, against habit 0$")
        ranked = re.findall(r"(?m)^ *(\d+)\. (.+?) {2,}", out)
        people = sim.stats_json()["people"]
        self.assertEqual([int(n) for n, _ in ranked], list(range(1, len(people) + 1)))
        self.assertEqual([name.strip() for _, name in ranked], [sim.agents[p["id"]].name for p in people])


class TestClaudeController(unittest.TestCase):
    """examples/claude_controller.py: the model in hello; place names, the home and household money in prompts."""

    def fork_message(self) -> dict:
        sim = Simulation(seed=1)
        sim.claim("dana", "claude")
        for _ in range(3 * 60):
            sim.step()
            forks = [m for _, m in sim.outbox if m["type"] == "fork"]
            if forks:
                return forks[0]
        self.fail("no fork for dana in three hours")

    def test_the_page_shows_places_the_home_and_household_money(self):
        msg = self.fork_message()
        you, home = msg["you"], msg["you"]["home"]
        page = cc.decision_page(msg)
        at_home = you["where_name"] == you["home_name"] or you["home_name"].startswith(f"{you['where_name']}, ")
        where = "home" if at_home else you["where_name"]  # a flat ("Birch Court, flat 2A") is in its building
        self.assertIn(f"You are at: {where}.", page)
        self.assertNotIn(you["where"], page, "a place's name, never its id")
        self.assertIn(f"${you['savings']:,.2f} in savings", page)
        self.assertIn(f"household ${you['household_funds']:,} between you", page)
        self.assertIn(f"You live at {home['name']}, a {home['tier'].replace('_', ' ')}; you rent it for "
                      f"${home['weekly_cost']:,} a week. It is {home['stage_name']} (condition {home['condition']}/100).",
                      page)
        owned = cc.home_line({"home": {**home, "tenure": "owned", "weekly_cost": 60, "value": 15900}})
        self.assertIn("you own it and pay $60 a week in property tax", owned)
        self.assertTrue(owned.endswith("and worth about $15,900."))

    def test_household_paid_and_money_making_options(self):
        msg = self.fork_message()
        msg["options"] = [{"index": 0, "label": "Repaint the house", "cost": 900, "household": True},
                          {"index": 1, "label": "Leave it", "cost": 0},
                          {"index": 2, "label": "Sell up and rent", "cost": -12400, "household": True},
                          {"index": 3, "label": "A coffee", "cost": 4, "travel_minutes": 5}]
        order = [3, 2, 1, 0]
        page = cc.decision_page(msg, order=order)
        self.assertIn("d) Repaint the house (costs $900.00 from your household's money and savings)", page)
        self.assertIn("c) Leave it (costs $0.00)", page)
        self.assertIn("b) Sell up and rent (brings in $12,400.00 from your household's money and savings)", page)
        self.assertIn("a) A coffee (costs $4.00, about 5 min away)", page)
        with mock.patch.object(cc.time, "sleep"):
            self.assertEqual(cc.parse_letter(cc.fake_claude("", "", "", page), order)[0], 2, "the cheapest")

    def test_the_page_has_the_character_their_past_and_no_hints_unless_asked(self):
        sim = Simulation(seed=1)
        sim.claim("dana", "claude")
        about = {}
        history = []
        msg = None
        for _ in range(2 * 24 * 60):
            sim.step()
            _, _, out = sim.drain()
            for _, m in out:
                if m["type"] == "fork":
                    if len(history) >= 4:
                        msg = msg or m
                    fork = sim.forks[m["fork_id"]]
                    choice = sim.default_choice(fork)
                    history.append({"time": m["time"], "question": m["question"],
                                    "label": m["options"][choice]["label"]})
                    sim.answer(m["fork_id"], choice, "", "claude")
            if msg:
                break
        self.assertIsNotNone(msg, "dana met five forks in two days")
        agent = sim.agents["dana"]
        about = {"attributes": agent.attributes(), "memory": agent.memory[-30:],
                 "relationships": {o: {"kind": r.kind.value if hasattr(r.kind, "value") else r.kind,
                                       "affinity": r.affinity, "name": sim.agents[o].name}
                                   for o, r in agent.relationships.items()}}
        page = cc.decision_page(msg, about, history[:-1])
        self.assertIn(f"Job: {agent.job.title}", page)
        self.assertIn("Personality: ", page)
        self.assertIn("Closest people: ", page)
        self.assertIn(f"-> {history[-2]['label']}. Then: ", page)
        self.assertNotIn("for you]", page)
        self.assertEqual(len(msg["profile_scores"]), 4)
        hinted = cc.decision_page(msg, about, history[:-1], show_hints=True)
        self.assertEqual(hinted.count(" for you]"), 4)
        self.assertLess(len(hinted), 3500, "about one short page")

    def test_reading_the_letter(self):
        order = [2, 0, 3, 1]
        self.assertEqual(cc.parse_letter("b - I'm hungry", order), (0, "I'm hungry"))
        self.assertEqual(cc.parse_letter("D) too tired", order), (1, "too tired"))
        self.assertEqual(cc.parse_letter("Answer: c, it's cheap", order), (3, "it's cheap"))
        self.assertEqual(cc.parse_letter("a", order), (2, ""))
        self.assertIsNone(cc.parse_letter("Hard to say.", order))

    def test_what_came_of_each_decision(self):
        history = [{"time": "Day 2 Tue 15:00", "question": "You're hungry. What do you do?", "label": "Cook at home"},
                   {"time": "Day 2 Tue 17:00", "question": "Free time?", "label": "Walk in the park"}]
        memory = ["Day 2 Tue 15:49: Nadia: Makes a really tasty meal.", "Day 2 Tue 18:10: Nadia: Gets caught in the rain."]
        self.assertEqual(cc.past_decisions(history, memory), [
            "- 2 Tue 15:00: You're hungry. What do you do -> Cook at home. Then: Makes a really tasty meal.",
            "- 2 Tue 17:00: Free time -> Walk in the park. Then: Gets caught in the rain."])

    def test_hello_names_the_model(self):
        sent = []

        class Socket:
            async def send(self, text):
                sent.append(json.loads(text))

            async def recv(self):
                raise ws.ConnectionClosed()

        async def connect(url):
            return Socket()

        args = types.SimpleNamespace(fake=True, model="claude-sonnet-5", chat=False, characters="ari,tom",
                                     name="claude", url="ws://localhost:8000/ws")
        with mock.patch.object(cc, "connect", connect), contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(cc.ClaudeController(args, "").run())
        self.assertEqual(sent, [{"type": "hello", "role": "controller", "name": "claude", "characters": ["ari", "tom"],
                                 "model": "claude-sonnet-5"}])


if __name__ == "__main__":
    unittest.main()
