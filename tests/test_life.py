"""life.py and life_tables.py (L2, life.md 5.5-5.9): tables, the board, health, deaths, births, birthdays."""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife import career, life, life_tables
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("NODE") or shutil.which("node")


def node_eval(code: str) -> object:
    """Run `code` in node with the port engine loaded as G; it prints one JSON value."""
    script = (f"const G = require({json.dumps(str(ROOT / 'port' / 'tools' / 'engine.cjs'))}).load();\n" + code)
    run = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=300)
    if run.returncode:
        raise AssertionError(run.stderr)
    return json.loads(run.stdout)


def life_sim(seed: int = 1) -> Simulation:
    """A v2 Simulation with life set up (until the hooks land, the tests call life's entry points themselves)."""
    sim = Simulation(seed)
    if not hasattr(sim, "life"):
        life.pre_init(sim)
        life.init(sim)
    return sim


class TablesTest(unittest.TestCase):
    def test_shapes(self):
        for name in ("DEATH_YEAR", "HEART_YEAR", "CHRONIC_YEAR"):
            self.assertEqual(len(getattr(life_tables, name)), 121, name)
        self.assertEqual(len(life_tables.MULT_UNTREATED), 7)
        self.assertEqual(life_tables.MULT_TREATED[1], 1.25)
        self.assertEqual(life_tables.DEATH_YEAR[0], 0.0005)
        self.assertEqual(life_tables.HEART_YEAR[29], 0.0)

    def test_no_runtime_math(self):
        src = (ROOT / "gameofailife" / "life_tables.py").read_text()
        for word in ("exp(", "log(", "pow(", "import"):
            self.assertNotIn(word, src)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_js_arrays_equal(self):
        names = ["DEATH_YEAR", "HEART_YEAR", "CHRONIC_YEAR", "MULT_UNTREATED", "MULT_TREATED"]
        js = node_eval("console.log(JSON.stringify(%s.map(n => G.life_tables[n])));" % json.dumps(names))
        for name, arr in zip(names, js):
            self.assertEqual(getattr(life_tables, name), arr, name)


class BoardTest(unittest.TestCase):
    def test_named_jobs_are_the_first_slots(self):
        sim = life_sim()
        b = career.board(sim)
        paid = [a for a in sim.agents.values() if a.job and a.job.hourly_wage > 0]
        self.assertEqual(b.named, len(paid))
        for a in paid:
            self.assertEqual(b.holder[a.job.slot], a.id)
            self.assertIs(b.jobs[a.job.slot], a.job)

    def test_free_take_vacant(self):
        sim = life_sim()
        b = career.board(sim)
        a = next(a for a in sim.agents.values() if a.job and a.job.hourly_wage > 0)
        slot = a.job.slot
        self.assertEqual(b.vacant(sim, a), [])
        b.free(slot, sim.clock.day + 7)
        self.assertEqual(b.vacant(sim, a), [])
        b.reopen[slot] = sim.clock.day
        self.assertEqual(b.vacant(sim, a), [slot])
        b.take(slot, a.id)
        self.assertEqual(b.vacant(sim, a), [])


class SkeletonTest(unittest.TestCase):
    def test_everyone_has_a_life(self):
        sim = life_sim()
        for a in sim.agents.values():
            self.assertIsInstance(a.life, life.LifeState)
            self.assertIn(a.id, sim.life.by_slot[a.life.slot])
            self.assertTrue(0 <= a.life.slot < 1380 and 0 <= a.life.birthday < 360)

    def test_stage(self):
        sim = life_sim()
        a = next(iter(sim.agents.values()))
        for age, want in ((0, "baby"), (4, "child"), (13, "teen"), (30, "adult"), (70, "senior")):
            a.age = age
            self.assertEqual(life.stage(a), want)

    def test_activities_extra(self):
        for name, minutes in (("ward", 1440), ("doctor", 45), ("baby", 1440)):
            spec = life.ACTIVITIES_EXTRA[name]
            self.assertEqual(spec["minutes"], minutes)
            self.assertEqual(spec.minutes, minutes)
        self.assertEqual(life.ACTIVITIES_EXTRA["ward"].gains, {"hunger": 40})

    def test_pages_are_json(self):
        sim = life_sim()
        a = sim.agents["shira"]
        json.dumps(life.page(sim, a))
        json.dumps(life.fork_you(sim, a))
        block = life.stats_block(sim)
        self.assertEqual(set(block), {"ill_now", "in_hospital", "couples", "births", "deaths", "jobless", "in_debt",
                                      "talks_today", "friendships_today"})
        self.assertTrue(all(isinstance(v, int) for v in block.values()))


if __name__ == "__main__":
    unittest.main()
