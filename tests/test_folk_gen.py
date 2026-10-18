"""Townsfolk generation (folk.md 12 Generation, PLAN 2.6 and 2.15) on the SimStub, seeds 1-3.

1,000 folk in 410-440 households in the region's homes; ages; employment, commutes and Millbrook's 142 job rows;
named workers' folk coworkers and named pupils' folk classmates; money against the named; unique names; every job
slot on the board; the isolated case; the 2 s generation budget; the fixture (and the Node fixture when node and
the JS rail are present). The train commuters and teen riders are printed for the handoff.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path

from gameofailife import folk_gen, housing
from tests.support.folk_stub import SimStub

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "folk_seed1.json"
NODE = shutil.which("node")
SEEDS = (1, 2, 3)
_CACHE: dict = {}


def stub(seed: int, isolated: bool = False) -> SimStub:
    key = (seed, isolated)
    if key not in _CACHE:
        _CACHE[key] = SimStub(seed, isolated=isolated)
    return _CACHE[key]


def median(xs: list) -> float:
    xs = sorted(xs)
    return xs[len(xs) // 2]


def coworkers(sim, a) -> int:
    """Folk with a job at a's place on a shift that shares an hour with a's."""
    j = a.job
    n = 0
    for p in sim.folk.people:
        q = p.job
        if q is None or q.hourly_wage <= 0 or q.place_id != j.place_id:
            continue
        if folk_gen._overlap(q.start_hour, q.end_hour, j.start_hour, j.end_hour):
            n += 1
    return n


def open_to(sim, a) -> int:
    """Folk job slots on the board at a's place on a shift that shares an hour with a's."""
    j = a.job
    n = 0
    for job in sim.job_board.jobs:
        if job.place_id == j.place_id and folk_gen._overlap(job.start_hour, job.end_hour, j.start_hour, j.end_hour):
            n += 1
    return n


def classmates(sim, a) -> int:
    n = 0
    for p in sim.folk.people:
        q = p.job
        if q is not None and q.title == "student" and q.place_id == a.job.place_id and abs(p.age - a.age) <= 1:
            n += 1
    return n


class GenerationTest(unittest.TestCase):
    def test_population_and_households(self):
        for seed in SEEDS:
            sim = stub(seed)
            folk = sim.folk
            self.assertEqual(len(folk.people), 1000, seed)
            self.assertTrue(410 <= len(folk.households) <= 440, (seed, len(folk.households)))
            seen = set()
            for hh in folk.households:
                self.assertTrue(hh.member_ids, hh.id)
                for pid in hh.member_ids:
                    self.assertNotIn(pid, seen)
                    seen.add(pid)
                    self.assertEqual(folk.person(pid).household_id, hh.id)
            self.assertEqual(len(seen), 1000)
            for k, p in enumerate(folk.people):
                self.assertEqual(p.id, f"f{k}")
                self.assertEqual(folk.household(p.household_id).j, p.hh)

    def test_homes(self):
        for seed in SEEDS:
            sim = stub(seed)
            v2 = {spec[0] for spec in housing.HOME_SPECS}
            region = [h for h in sim.homes.values() if h.id not in v2]
            vacant = [h for h in region if h.household is None]
            self.assertGreaterEqual(len(vacant), 0.07 * len(region), seed)
            used = {}
            for hh in sim.folk.households:
                home = sim.homes[hh.home_id]
                self.assertNotIn(home.id, v2)
                self.assertEqual(home.household, hh.id)
                self.assertNotIn(home.id, used)
                used[home.id] = hh.id
                self.assertLessEqual(len(hh.member_ids), 3 * home.bedrooms, hh.id)
                if home.owner == hh.id:
                    self.assertEqual(hh.weekly_rent, 0.0)
                else:
                    self.assertEqual(home.owner, "landlord")
                    self.assertEqual(hh.weekly_rent, float(home.rent))
            for hh in sim.households.values():  # the cast stays in v2's 37
                self.assertIn(hh.home_id, v2)

    def test_ages(self):
        for seed in SEEDS:
            ages = [p.age for p in stub(seed).folk.people]
            kids = sum(1 for a in ages if a < 18) / 1000
            mid = sum(1 for a in ages if 18 <= a <= 64) / 1000
            old = sum(1 for a in ages if a >= 65) / 1000
            self.assertTrue(0.20 <= kids <= 0.26, (seed, kids))
            self.assertTrue(0.58 <= mid <= 0.66, (seed, mid))
            self.assertTrue(0.13 <= old <= 0.18, (seed, old))

    def test_jobs_and_commutes(self):
        for seed in SEEDS:
            sim = stub(seed)
            workers = [p for p in sim.folk.people if p.job is not None and p.job.hourly_wage > 0]
            self.assertGreaterEqual(len(workers), 0.94 * sim.folk.seekers, seed)
            for p in workers:
                self.assertTrue(18 <= p.age <= 64, p.id)
                self.assertIsNotNone(p.commute, p.id)
                self.assertEqual(p.commute[0], p.job.place_id)
                self.assertIn(p.commute[2], ("walk", "car", "train"))
                if p.commute[2] == "car":
                    self.assertTrue(p.owns_car, p.id)
            self.assertLessEqual(median([p.commute[1] for p in workers]), 25, seed)

    def test_board(self):
        for seed in SEEDS:
            sim = stub(seed)
            b = sim.job_board
            self.assertEqual(len(b.jobs), sum(row[6] for row in sim.town.job_slots))
            held = 0
            for slot, job in enumerate(b.jobs):
                self.assertEqual(job.slot, slot)
                h = b.holder[slot]
                if h is not None:
                    held += 1
                    self.assertIs(sim.folk.person(h).job, job)
            workers = [p for p in sim.folk.people if p.job is not None and p.job.hourly_wage > 0]
            self.assertEqual(held, len(workers))

    def test_millbrook_rows_filled(self):
        for seed in SEEDS:
            sim = stub(seed)
            mb = sim.town.millbrook_ids
            rows = [s for s, job in enumerate(sim.job_board.jobs) if job.place_id in mb]
            self.assertEqual(len(rows), 142)
            filled = sum(1 for s in rows if sim.job_board.holder[s] is not None)
            self.assertGreaterEqual(filled, 130, seed)

    def test_named_meet_folk(self):
        for seed in SEEDS:
            sim = stub(seed)
            for a in sim.agents.values():
                if a.job is None:
                    continue
                if a.job.title == "student":
                    self.assertGreaterEqual(classmates(sim, a), 2, (seed, a.id))
                elif a.job.hourly_wage > 0:
                    # Where region.json gives the place fewer than 2 folk slots on the shift (Millbrook Green has
                    # one gardener row), every one of them is filled.
                    want = min(2, open_to(sim, a))
                    self.assertGreaterEqual(want, 1, (seed, a.id, a.job.place_id))
                    self.assertGreaterEqual(coworkers(sim, a), want, (seed, a.id, a.job.place_id))

    def test_ties(self):
        sim = stub(1)
        folk_ties = named_ties = 0
        for p in sim.folk.people:
            for oid, r in p.relationships.items():
                other = sim.person(oid)
                self.assertIsNotNone(other, oid)
                self.assertIn(p.id, other.relationships, (p.id, oid))
                folk_ties += 1
                if oid in sim.agents:
                    named_ties += 1
        self.assertGreater(folk_ties, 2000)
        self.assertGreater(named_ties, 40)
        couples = 0
        for hh in sim.folk.households:
            for pid in hh.member_ids:
                p = sim.folk.person(pid)
                for oid in hh.member_ids:
                    if oid != pid:
                        self.assertIn(oid, p.relationships, (pid, oid))
                        couples += p.relationships[oid].kind.value == "partner"
        self.assertGreater(couples, 300)

    def test_money(self):
        for seed in SEEDS:
            sim = stub(seed)
            folk = [p.money + p.savings for p in sim.folk.people if p.age >= 18]
            named = [a.money + a.savings for a in sim.agents.values() if a.is_adult]
            ratio = median(folk) / median(named)
            self.assertTrue(0.7 <= ratio <= 1.5, (seed, ratio))
            self.assertLessEqual(max(folk), 25000, seed)
            for p in sim.folk.people:
                self.assertEqual(p.money, round(p.money, 2))
                self.assertGreaterEqual(p.savings, 0)

    def test_names(self):
        for seed in SEEDS:
            sim = stub(seed)
            names = [p.name for p in sim.folk.people] + [a.name for a in sim.agents.values()]
            self.assertEqual(len(names), len(set(names)), seed)
            named_first = {a.name.split()[0] for a in sim.agents.values()}
            for p in sim.folk.people:
                self.assertNotIn(p.name.split()[0], named_first, p.name)
                self.assertIn(p.sex, ("f", "m"))

    def test_start_asleep_at_home(self):
        sim = stub(1)
        now = sim.clock.tick
        for p in sim.folk.people:
            home = sim.homes[sim.folk.household(p.household_id).home_id]
            self.assertEqual(p.inside, home.place)
            self.assertEqual(p.activity, "sleep")
            self.assertGreater(p.next_tick, now)
            self.assertLessEqual(p.next_tick, now - sim.clock.minute_of_day + 450)
            self.assertEqual(len(p.traits), 6)
            self.assertIsNone(p.life)

    def test_baby_name_unique(self):
        sim = stub(1)
        taken = {p.name for p in sim.folk.people} | {a.name for a in sim.agents.values()}
        for k in range(20):
            name = folk_gen.baby_name(sim, "f" if k % 2 else "m", "Shalev", k)
            self.assertNotIn(name, taken)
            self.assertTrue(name.endswith(" Shalev"))
        self.assertEqual(folk_gen.baby_name(sim, "f", "Shalev", 3), folk_gen.baby_name(sim, "f", "Shalev", 3))

    def test_generation_budget(self):
        sim = SimStub(4, populate=False)  # a seed no other test builds: the road trees start cold
        c = time.process_time()
        folk_gen.populate(sim.folk, sim, 1000)
        took = time.process_time() - c
        print(f"\n[folk_gen] populate seed 4: {took:.2f} s process_time, load {os.getloadavg()[0]:.1f}",
              file=sys.stderr)
        self.assertLessEqual(took, 2.0)

    def test_report(self):
        for seed in SEEDS:
            s = folk_gen.summary(stub(seed))
            print(f"\n[folk_gen] seed {seed}: {s['households']} households, workers {s['workers']}/{s['seekers']},"
                  f" modes {s['modes']}, median commute {s['commute_median']}, teen riders {s['teen_riders']},"
                  f" Millbrook rows {s['mb_filled']}/{s['mb_rows']}, vacant {s['vacant']}/{s['region_homes']}",
                  file=sys.stderr)
            self.assertGreater(s["modes"].get("train", 0), 0)


class IsolatedTest(unittest.TestCase):
    def test_isolated_touches_no_named(self):
        sim = stub(1, isolated=True)
        mb = sim.town.millbrook_ids
        named = set(sim.agents)
        for p in sim.folk.people:
            for oid in p.relationships:
                self.assertNotIn(oid, named, p.id)
            if p.job is not None:
                self.assertNotIn(p.job.place_id, mb, p.id)
        for a in sim.agents.values():
            for oid in a.relationships:
                self.assertFalse(oid.startswith("f") and oid[1:].isdigit(), (a.id, oid))
        for job in sim.job_board.jobs:
            self.assertNotIn(job.place_id, mb)
        self.assertEqual(len(sim.folk.people), 1000)


class FixtureTest(unittest.TestCase):
    def test_fixture_matches_python(self):
        got = folk_gen.dump(folk_gen.generate(1))
        want = json.loads(FIXTURE.read_text())
        self.assertEqual(got["households"], want["households"])
        self.assertEqual(got["people"], want["people"])

    @unittest.skipUnless(NODE, "node not installed")
    def test_fixture_matches_node(self):
        tool = ROOT / "port" / "tools" / "parity_folk_gen.cjs"
        if not (ROOT / "port" / "src" / "folk_gen.js").is_file():
            self.skipTest("folk_gen.js not yet ported")
        out = subprocess.run([NODE, str(tool), "1"], capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stdout[-2000:] + out.stderr[-2000:])
        self.assertIn("folk_gen parity ok", out.stdout)


if __name__ == "__main__":
    unittest.main()
