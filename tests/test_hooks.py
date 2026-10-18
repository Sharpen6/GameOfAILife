"""v3's hook lines (life.md 7, PLAN 2.1-2.4): every shared engine file calls into the owning package's module.

F3's `v3-skel-hooks` commit lands each hook as a one-line call into `life`, `career`, `people`, `social`, `rail`,
`region` and `sim.folk`, keeping v2's behaviour in the `millbrook` world with no townsfolk (the v2 suite checks
that). These tests check the wiring itself: the region world builds and runs; a city with no townsfolk (`NoFolk`)
runs a day; and every hook reaches its module's function, which is wrapped here to count the calls.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gameofailife import career, forks, life, people, social
from gameofailife.agent import Relationship, RelationKind
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.forks import Outcome
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

# (module, function) for every hook line of life.md 7 and PLAN 2.4 that a plain day, or one nudge below, reaches.
HOOKS = [
    (life, "pre_init"), (life, "init"), (social, "init"), (people, "make_folk"),
    (life, "tick"), (social, "tick"), (life, "legacy_ageing"), (life, "max_health"), (life, "toddle"),
    (life, "hospitalise"), (life, "on_death"), (life, "fork_you"), (life, "page"), (life, "ill"), (life, "stage"),
    (life, "in_hospital"), (life, "stats_block"), (career, "on_shift_end"),
    (people, "news_gate"), (people, "apply_effect"), (people, "apply_extra"), (people, "pending_fork"),
    (people, "rel_row"), (people, "person"), (people, "household_by_id"), (people, "log_roll"),
    (social, "talks_json"), (social, "invite_folk"), (social, "message_folk"),
]
FOLK_HOOKS = ("tick", "nightly", "pensions", "weekly", "crowd", "riders", "page_json", "set_luck", "sample_hour")
REGION_ONLY = ("riders",)  # the trains ask the townsfolk who rides: the region world only


class Recorder(people.NoFolk):
    """`sim.folk` with no townsfolk that counts which of its methods the simulation calls."""

    def __init__(self, calls: Counter) -> None:
        super().__init__()
        self.calls = calls

    def __getattribute__(self, name):
        if name in FOLK_HOOKS:
            object.__getattribute__(self, "calls")[f"folk.{name}"] += 1
        return object.__getattribute__(self, name)


def step_until(sim: Simulation, weekday: int, minute: int) -> None:
    """Jump the clock to just before weekday/minute and step through it."""
    day = sim.clock.day + (weekday - sim.clock.weekday) % 7
    sim.clock.tick = max(sim.clock.tick, day * MINUTES_PER_DAY + minute - 2)
    for _ in range(3):
        sim.step()


class TestConstructor(unittest.TestCase):
    def test_defaults_are_v2s_city(self):
        sim = Simulation(1)
        self.assertEqual((sim.world, sim.folk.n, sim.dice_seed, sim.folk_isolated), ("millbrook", 0, 1, False))
        self.assertIsInstance(sim.folk, people.NoFolk)
        self.assertEqual(Simulation(3, dice_seed=7).dice_seed, 7)

    def test_folk_live_in_the_region_only(self):
        self.assertEqual(Simulation(1, folk=50).folk.n, 0)  # PLAN 2.1: forced to 0 in millbrook

    def test_an_unknown_world_is_refused(self):
        with self.assertRaises(ValueError):
            Simulation(1, world="atlantis")

    def test_the_region_world_builds_and_runs(self):
        sim = Simulation(1, world="region")
        calls = Counter()
        sim.folk = Recorder(calls)
        self.assertEqual(sim.world, "region")
        self.assertEqual(sim.town.world, "region")
        for _ in range(120):
            sim.step()
        town = sim.town_json()
        self.assertEqual((town["world"], town["w"], town["h"]), ("region", 256, 192))
        self.assertIn("train", town["timetable"])
        self.assertTrue({"homes", "housing", "stops", "rail", "decor"} <= set(town))
        state = sim.state_json()
        self.assertTrue(state["trains"], "the region's trains run from the first minute")
        self.assertTrue(all(calls[f"folk.{n}"] for n in REGION_ONLY))
        self.assertEqual((state["crowd"], state["folk_n"]), ([], 0))
        self.check_talks(state["talks"], sim)
        s = sim.stats_json(full=True)
        self.assertIn("region", s)
        self.assertNotIn("folk", s)  # stats.folk only with townsfolk
        self.assertEqual(s["region"]["named"], 60)
        self.assertEqual(json.loads(json.dumps(s)), s)

    def check_talks(self, talks, sim):
        """PLAN 2.10's rows: [place_index | -1, a_id, b_id, tone, tick], at most 20 (empty while social is a stub)."""
        self.assertIsInstance(talks, list)
        self.assertLessEqual(len(talks), 20)
        for row in talks:
            self.assertEqual(len(row), 5, row)
            self.assertTrue(-1 <= row[0] < len(sim.town.places), row)
            self.assertIn(row[3], (-1, 0, 1), row)

    def test_millbrook_keeps_v2s_keys_plus_v3s(self):
        sim = Simulation(1)
        state = sim.state_json()
        self.assertEqual((state["trains"], state["crowd"], state["folk_n"]), ([], [], 0))
        self.check_talks(state["talks"], sim)
        self.assertNotIn("train", sim.town_json()["timetable"])
        s = sim.stats_json()
        self.assertNotIn("region", s)
        self.assertNotIn("folk", s)
        self.assertIn("life", s["city"])
        page = sim.agent_json("dana")
        self.assertEqual(page["kind"], "named")
        self.assertIn("life", page)


class TestNoFolkDay(unittest.TestCase):
    def test_a_city_with_no_townsfolk_runs_a_day(self):
        sim = Simulation(2)
        self.assertIsInstance(sim.folk, people.NoFolk)
        sim.run_days(1)
        self.assertGreater(len(sim.history), 20)
        self.assertEqual(sim.state_json()["crowd"], [])


class TestEveryHookCallsItsStub(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls = calls = Counter()
        patches = []
        for module, name in HOOKS:
            fn = getattr(module, name)

            def counted(*a, _fn=fn, _key=f"{module.__name__.rpartition('.')[2]}.{name}", **k):
                calls[_key] += 1
                return _fn(*a, **k)
            patches.append(mock.patch.object(module, name, counted))
        for p in patches:
            p.start()
        try:
            sim = Simulation(1)
            sim.folk = Recorder(calls)
            sim.run_days(1)
            step_until(sim, 4, 9 * 60)  # Friday's pensions
            step_until(sim, 6, 23 * 60)  # Sunday's charges
            dana, ari = sim.agents["dana"], sim.agents["ari"]
            sim.state_json()
            sim.stats_json(full=True)
            sim.agent_json("dana")
            sim.agent_json("f3")
            sim.set_luck("f3", 20)
            sim.luck_of("dana")
            sim.household_by_id(dana.household_id)
            sim.invite(ari, "f3", "cafe")
            sim.send_message("ari", "f3", "Coffee?")
            sim._log_roll(sim.agents["tom"], "test", 0.5, 0.25)
            sim._log_roll(SimpleNamespace(id="f3", luck=50.0), "test", 0.5, 0.25)
            sim._apply_outcome(ari, {"fork": "f0", "outcome": Outcome("x", "Something", 1.0, 0, {"life_effect": 1})})
            fork = forks.build_fork(sim, dana) or forks.Fork("dana", "test", "?", [], sim.clock.tick)
            cls.message = sim.fork_message(dana, fork)
            kid = next(a for a in sim.living() if not a.is_adult)
            kid.age, kid.state, kid.plan = 3, "idle", []
            sim._next(kid)  # under FORK_AGE: life.toddle
            kid.age = 8
            sick = sim.agents["tom"]
            sick.health, sick.state, sick.plan, sick.fork_id = 20.0, "idle", [], None
            sim._next(sick)  # very unwell: life.hospitalise
            ward = sim.agents["omer"]
            ward.life.ward_until = sim.clock.tick + 300
            ward.inside, (ward.x, ward.y) = "hospital", sim.town.places["hospital"].entry
            sim.start_plan(ward, [("ward", "hospital")], "walk")
            cls.ward = (ward.activity, ward.busy_until, ward.life.ward_until)
            sim._die(sim.agents["ruth"], "passed away")
        finally:
            for p in patches:
                p.stop()

    def test_every_module_hook_is_called(self):
        missing = [f"{m.__name__.rpartition('.')[2]}.{n}" for m, n in HOOKS
                   if not self.calls[f"{m.__name__.rpartition('.')[2]}.{n}"]]
        self.assertEqual(missing, [])

    def test_every_folk_hook_is_called(self):
        self.assertEqual([n for n in FOLK_HOOKS if n not in REGION_ONLY and not self.calls[f"folk.{n}"]], [])

    def test_ticks_call_life_and_social_each_minute(self):
        self.assertGreaterEqual(self.calls["life.tick"], MINUTES_PER_DAY)
        self.assertEqual(self.calls["life.tick"], self.calls["social.tick"])
        self.assertEqual(self.calls["life.tick"], self.calls["folk.tick"])

    def test_the_fork_message_carries_about_and_life(self):
        self.assertIn("about", self.message)
        self.assertIsInstance(self.message["about"], list)
        self.assertIn("life", self.message["you"])

    def test_the_ward_lasts_until_ward_until(self):
        activity, busy_until, until = self.ward
        self.assertEqual((activity, busy_until), ("ward", until))


class TestFolkIds(unittest.TestCase):
    """Folk ids reach the townsfolk (or nobody) and never raise in a city without townsfolk."""

    def test_no_townsfolk_answers_nothing(self):
        sim = Simulation(1)
        self.assertIsNone(sim.agent_json("f3"))
        self.assertFalse(sim.set_luck("f3", 10))
        self.assertIsNone(sim.luck_of("f3"))
        self.assertIsNone(sim.person("f3"))
        self.assertIsNone(sim.invite(sim.agents["ari"], "f3", "cafe"))
        self.assertFalse(sim.send_message("ari", "f3", "hi")["ok"])

    def test_forks_skip_folk_relationships(self):
        sim = Simulation(1)
        dana = sim.agents["dana"]
        kid = next(a for a in sim.living() if not a.is_adult)
        for a in (dana, kid):  # a townsperson the fork builders would pick if they did not check sim.agents
            a.relationships["f7"] = Relationship(RelationKind.FRIEND, 99.0)
        self.assertNotEqual(getattr(forks._best_friend(sim, dana), "id", None), "f7")
        self.assertNotEqual(getattr(forks._playmate(sim, kid), "id", None), "f7")
        dana.relationships["f7"] = Relationship(RelationKind.FAMILY, 99.0)
        self.assertNotEqual(getattr(forks._closest_family(sim, dana), "id", None), "f7")


@unittest.skipUnless(NODE, "node is not installed")
class TestPortHooks(unittest.TestCase):
    """The JS twin: the same constructor options, and the same keys in both worlds."""

    def test_the_port_builds_both_worlds_with_pythons_keys(self):
        code = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const out = {};
for (const world of ["millbrook", "region"]) {
  const sim = new G.sim.Simulation(1, null, null, 1, { world, folk: 0 });
  for (let i = 0; i < 120; i++) sim.step();
  out[world] = { world: sim.world, dice_seed: sim.dice_seed, state: Object.keys(sim.state_json()).sort(),
    agent: Object.keys(sim.state_json().agents[0]).sort(), stats: Object.keys(sim.stats_json()).sort(),
    city: Object.keys(sim.stats_json().city).sort(), town: Object.keys(sim.town_json()).sort(),
    page: Object.keys(sim.agent_json("dana")).sort(), trains: sim.trains().length };
}
process.stdout.write(JSON.stringify(out));
"""
        js = json.loads(subprocess.run([NODE, "-e", code, str(ROOT)], capture_output=True, text=True, check=True,
                                       timeout=120).stdout)
        for world in ("millbrook", "region"):
            sim = Simulation(1, world=world)
            for _ in range(120):
                sim.step()
            want = {"world": world, "dice_seed": 1, "state": sorted(sim.state_json()),
                    "agent": sorted(sim.state_json()["agents"][0]), "stats": sorted(sim.stats_json()),
                    "city": sorted(sim.stats_json()["city"]), "town": sorted(sim.town_json()),
                    "page": sorted(sim.agent_json("dana")), "trains": len(sim.trains())}
            self.assertEqual(js[world], want, world)


if __name__ == "__main__":
    unittest.main()
