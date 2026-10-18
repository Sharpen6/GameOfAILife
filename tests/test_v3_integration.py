"""Checks the v3 integration needed where two packages' code meet (PLAN 5): each one guards a fix made on the
merged tree, so a later merge cannot quietly undo it."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import housing, life
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


class RegionNoticeTest(unittest.TestCase):
    """v3-fixes's landlord notice sale (notice_home, landlord_notices, _landlord_sells) in the region world, where
    sim.homes also holds the townsfolk's 575 homes (R1b): it looks at the cast's 37 only (PLAN 2.9)."""

    @classmethod
    def setUpClass(cls):
        cls.sim = Simulation(1, world="region", folk=1000)

    @classmethod
    def tearDownClass(cls):
        cls.sim = None

    def test_notice_home_is_one_of_the_37(self):
        home = housing.notice_home(self.sim)
        self.assertIsNotNone(home)
        self.assertTrue(housing.is_v2_home(home.id), home.id)
        self.assertIn(home.household, self.sim.households)

    def test_the_landlord_gives_notice_in_a_drought(self):
        sim = self.sim
        sim.clock.tick = housing.NOTICE_FROM_DAY * housing.DAY + housing.NOTICE_HOUR * 60
        before = {h.id: (h.notice, h.noticed) for h in sim.homes.values()}
        try:
            with mock.patch.object(housing, "house_drought", lambda s, but=None: True):
                housing.landlord_notices(sim)
            noticed = [h for h in sim.homes.values() if h.notice is not None]
            self.assertEqual(len(noticed), 1)
            self.assertTrue(housing.is_v2_home(noticed[0].id), noticed[0].id)
        finally:
            for h in sim.homes.values():
                h.notice, h.noticed = before[h.id]


FOLK_DEATH_JS = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const sim = new G.sim.Simulation(1, null, null, 1, { world: "region", folk: 1000 });
for (let i = 0; i < 60; i++) sim.step();
const f = sim.folk;
const p = f.people.find(q => q.alive && q.is_adult && sim.household_by_id(q.household_id).member_ids.length === 1);
const hh = sim.household_by_id(p.household_id);
const home = sim.homes.get(hh.home_id);
const n = f.living().length;
G.life.die(sim, p, "died");
const deaths = () => [...sim.events].filter(e => e.tag === "death" && (e.agents || []).includes(p.id)).length;
const once = deaths(), counted = sim.life.counts.deaths;
G.life.die(sim, p, "died");
console.log(JSON.stringify({ id: p.id, alive: p.alive, how: p.died && p.died.how, living: [n, f.living().length],
  in_living: f.living().includes(p), home: home.household, gone: hh.gone, deaths: [once, deaths()],
  counted: [counted, sim.life.counts.deaths] }));
"""


class FolkDeathTest(unittest.TestCase):
    """L2 x F2a: a townsperson's death (life.die) marks them dead (folk.kill never changes `alive`) and, through
    housing.on_death, vacates a home nobody is left in; a second call is a no-op. Python and the JS twin."""

    @staticmethod
    def _one_alone():
        sim = Simulation(1, world="region", folk=1000)
        for _ in range(60):
            sim.step()
        f = sim.folk
        p = next(q for q in f.people if q.alive and q.is_adult
                 and len(sim.household_by_id(q.household_id).member_ids) == 1)
        return sim, p

    def test_a_dead_townsperson_is_dead_and_their_home_is_vacated(self):
        sim, p = self._one_alone()
        hh = sim.household_by_id(p.household_id)
        home = sim.homes[hh.home_id]
        self.assertEqual(home.household, hh.id)
        n = len(sim.folk.living())
        life.die(sim, p, "died")
        self.assertFalse(p.alive)
        self.assertEqual(p.died["how"], "died")
        self.assertEqual(p.died["tick"], sim.clock.tick)
        self.assertNotIn(p, sim.folk.living())
        self.assertEqual(len(sim.folk.living()), n - 1)
        self.assertEqual(housing._members(sim, hh), [])
        self.assertIsNone(home.household)
        self.assertTrue(hh.gone)

        def deaths():
            return [e for e in sim.events if e["tag"] == "death" and p.id in (e.get("agents") or [])]

        once, counted = len(deaths()), sim.life.counts["deaths"]
        self.assertEqual(once, 1)
        life.die(sim, p, "died")  # the dead do not die again
        self.assertEqual((len(deaths()), sim.life.counts["deaths"]), (once, counted))

    @unittest.skipUnless(NODE, "node is not installed")
    def test_the_js_twin_does_the_same(self):
        run = subprocess.run([NODE, "-e", FOLK_DEATH_JS, str(ROOT)], capture_output=True, text=True, check=True,
                             timeout=300)
        js = json.loads(run.stdout.strip().splitlines()[-1])
        sim, p = self._one_alone()
        self.assertEqual(js["id"], p.id)
        n = len(sim.folk.living())
        self.assertFalse(js["alive"])
        self.assertEqual(js["how"], "died")
        self.assertEqual(js["living"], [n, n - 1])
        self.assertFalse(js["in_living"])
        self.assertIsNone(js["home"])
        self.assertTrue(js["gone"])
        self.assertEqual(js["deaths"], [1, 1])
        self.assertEqual(js["counted"][0], js["counted"][1])


SICK_DAY_JS = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const sick = process.argv[2] === "1";
const sim = new G.sim.Simulation(1);
const a = sim.agents.get("dana");
const t = sim.clock.tick;
if (sick) a.life.conditions.push(new G.life.Condition("flu", t, t + 5 * 1440, t + 3 * 1440, t + 2 * 1440, 5));
const out = { can_work: G.life.can_work(sim, a), work_forks: 0, at_work: false };
for (let i = 0; i < (a.job.start_hour + 2) * 60 - 5 * 60; i++) {
  sim.step();
  const [, fl] = sim.drain();
  for (const f of fl) if (f.agent === a.id && f.kind === "work") out.work_forks++;
  if (a.activity === "work") out.at_work = true;
}
console.log(JSON.stringify(out));
"""


class SickDayTest(unittest.TestCase):
    """L2's handoff item 3, in F3's work_fork hunk: an illness that keeps a named off work (life.can_work), not only
    a hospital stay, means no work fork and no shift. Dana works 9-5 on Mondays; the run starts Monday 05:00."""

    @staticmethod
    def _morning(sick: bool):
        sim = Simulation(1)
        a = sim.agents["dana"]
        t = sim.clock.tick
        if sick:
            a.life.conditions.append(life.Condition("flu", t, t + 5 * 1440, t + 3 * 1440, t + 2 * 1440, 5))
        out = {"can_work": life.can_work(sim, a), "work_forks": 0, "at_work": False}
        for _ in range((a.job.start_hour + 2) * 60 - 5 * 60):
            sim.step()
            _, fl, _ = sim.drain()
            out["work_forks"] += sum(1 for f in fl if f["agent"] == a.id and f["kind"] == "work")
            out["at_work"] = out["at_work"] or a.activity == "work"
        return out

    def test_off_sick_means_no_shift(self):
        well = self._morning(False)
        self.assertEqual(well, {"can_work": True, "work_forks": 1, "at_work": True})  # the control
        self.assertEqual(self._morning(True), {"can_work": False, "work_forks": 0, "at_work": False})

    @unittest.skipUnless(NODE, "node is not installed")
    def test_the_js_twin_does_the_same(self):
        for sick, want in (("0", {"can_work": True, "work_forks": 1, "at_work": True}),
                           ("1", {"can_work": False, "work_forks": 0, "at_work": False})):
            run = subprocess.run([NODE, "-e", SICK_DAY_JS, str(ROOT), sick], capture_output=True, text=True,
                                 check=True, timeout=120)
            self.assertEqual(json.loads(run.stdout.strip().splitlines()[-1]), want, sick)


if __name__ == "__main__":
    unittest.main()
