"""Townsfolk money and households (folk.md 12 Money, PLAN 2.3) on the SimStub: 14 days of shift pay, Friday pensions
and Sunday charges with each household's books balanced to the cent; arrears; join, split and leaving town keep
everyone in exactly one household and never put two households in one home; birthdays move pupils.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife import folk_gen, folk_life, housing
from gameofailife.clock import MINUTES_PER_DAY
from gameofailife.rng import r2
from tests.support.folk_stub import SimStub

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def cents(x: float) -> int:
    return folk_life._cents(x)


def worth(p) -> int:
    return cents(p.money) + cents(p.savings)


def household_cents(folk, hh) -> int:
    total = 0
    for p in folk_life.adults(folk, hh):
        total += worth(p)
    return total


def check_households(test, sim):
    """Everyone in town is in exactly one live household, the one they name; one household a home."""
    folk = sim.folk
    seen = {}
    homes = {}
    for hh in folk.households:
        if hh.gone:
            continue
        test.assertNotIn(hh.home_id, homes, (hh.id, homes.get(hh.home_id)))
        homes[hh.home_id] = hh.id
        test.assertEqual(sim.homes[hh.home_id].household, hh.id, hh.id)
        for pid in hh.member_ids:
            p = folk.person(pid)
            if p.gone or not p.alive:
                continue
            test.assertNotIn(pid, seen, (pid, seen.get(pid), hh.id))
            seen[pid] = hh.id
            test.assertEqual(p.household_id, hh.id)
    for p in folk.people:
        if p.alive and not p.gone:
            test.assertIn(p.id, seen, p.id)
    for h in sim.homes.values():
        if h.household is not None and h.household.startswith("fh"):
            test.assertEqual(homes.get(h.id), h.household, h.id)


def rehearse(sim, days: int = 22) -> dict:
    """Three scripted weeks of folk_life on generated townsfolk: joins, splits and leavers on day 3, broke households
    (some laid off, so the third Sunday moves them somewhere cheaper) on day 5, birthdays on day 10, every workday's
    shift pay, Friday pensions and Sunday books. Line by line with rehearse in port/tools/parity_folk_gen.cjs."""
    folk = sim.folk
    for day in range(days):
        weekday = day % 7
        sim.clock.tick = day * MINUTES_PER_DAY + 8 * 60
        if day == 3:
            adults = [p for p in folk.people if p.age >= 25 and not p.gone]
            hosts = adults[::9]
            for k, p in enumerate(adults[::37][:15]):
                if p.gone:
                    continue
                if k % 3 == 0:
                    host = hosts[(k * 7) % len(hosts)]
                    if not host.gone:
                        folk_life.join(sim, p, host)
                elif k % 3 == 1:
                    folk_life.split(sim, p)
                else:
                    folk_life.release(sim, p)
        if day == 5:
            for k, hh in enumerate(folk.households):
                if k % 30 == 0 or k % 50 == 7:
                    for p in folk_life.adults(folk, hh):
                        p.money = r2(p.money - 4000)
                        p.savings = 0.0
                        if k % 50 == 7 and p.job is not None and p.job.hourly_wage > 0:
                            folk_gen.board(sim).free(p.job.slot)  # laid off: no pay to climb back with
                            p.job = None
        if day == 10:
            for p in folk.people[::40]:
                if p.alive and not p.gone:
                    p.age += 1
                    folk_life.on_birthday(sim, p)
        for p in folk.people:
            job = p.job
            if p.gone or job is None or job.hourly_wage <= 0 or weekday not in job.workdays:
                continue
            folk_life.pay_shift(sim, p)
        if weekday == 4:
            sim.clock.tick = day * MINUTES_PER_DAY + 9 * 60
            folk_life.pensions(sim)
        if weekday == 6:
            sim.clock.tick = day * MINUTES_PER_DAY + 23 * 60
            folk_life.weekly(sim)
    out = folk_gen.dump(sim)
    out["gone"] = [p.id for p in folk.people if p.gone]
    out["books"] = [[hh.id, hh.arrears, hh.clean_sundays, hh.gone, hh.last_funds] for hh in folk.households]
    out["homes"] = [[h.id, h.household, h.owner, h.listing, h.rent] for h in sim.homes.values()]
    out["events"] = [ev["text"] for ev in sim.events]
    return out


class BooksTest(unittest.TestCase):
    def test_fourteen_days_balance_to_the_cent(self):
        sim = SimStub(1)
        folk = sim.folk
        start_day = sim.clock.day
        paid = pensions = sundays = 0
        for day in range(start_day, start_day + 14):
            weekday = day % 7
            # each worker's shift on a workday, paid at its end
            for p in folk.people:
                job = p.job
                if p.gone or job is None or job.hourly_wage <= 0 or weekday not in job.workdays:
                    continue
                before = worth(p)
                pay = folk_life.pay_shift(sim, p)
                self.assertEqual(worth(p) - before, cents(pay))
                self.assertGreater(pay, 0)
                paid += 1
            sim.clock.tick = day * MINUTES_PER_DAY + 9 * 60
            if weekday == 4:
                before = {p.i: worth(p) for p in folk.people}
                folk_life.pensions(sim)
                for p in folk.people:
                    got = worth(p) - before[p.i]
                    want = 40000 if (p.age >= 65 and (p.job is None or p.job.hourly_wage <= 0)) else 0
                    self.assertEqual(got, want, p.id)
                    pensions += got > 0
            if weekday == 6:
                sim.clock.tick = day * MINUTES_PER_DAY + 23 * 60
                before = {}
                charge = {}
                for hh in folk.households:
                    if hh.gone or not folk_life.adults(folk, hh):
                        continue
                    before[hh.id] = household_cents(folk, hh)
                    payers = folk_life.adults(folk, hh)
                    bills = 0
                    for p in payers:
                        bills += 8000 + (4000 if p.owns_car else 0)
                    charge[hh.id] = cents(housing.weekly_cost(sim, hh)) + bills
                arrears = {hh.id for hh in folk.households if hh.arrears >= folk_life.ARREARS_MOVE - 1}
                folk_life.weekly(sim)
                sundays += 1
                for hh in folk.households:
                    if hh.id not in before or hh.id in arrears or hh.gone:
                        continue
                    if sim.homes[hh.home_id].emergency is not None:
                        continue
                    self.assertEqual(household_cents(folk, hh) - before[hh.id], -charge[hh.id], hh.id)
                check_households(self, sim)
        self.assertEqual(sundays, 2)
        self.assertGreater(paid, 3000)
        self.assertGreater(pensions, 200)
        # money does not just rise: rent and bills take most households down on a Sunday
        for p in folk.people:
            self.assertEqual(p.money, round(p.money, 2))
            self.assertEqual(p.savings, round(p.savings, 2))
            self.assertGreaterEqual(p.savings, 0)

    def test_saving_moves_cash_to_savings(self):
        sim = SimStub(2)
        folk = sim.folk
        rich = None
        for hh in folk.households:
            ad = folk_life.adults(folk, hh)
            if len(ad) == 1 and ad[0].job is not None and ad[0].job.hourly_wage > 0:
                rich = ad[0]
                break
        rich.money = 5000.0
        rich.savings = 0.0
        sim.clock.tick = 6 * MINUTES_PER_DAY + 23 * 60
        folk_life.weekly(sim)
        self.assertGreater(rich.savings, 0)
        self.assertLess(rich.money, 5000.0)


class ArrearsTest(unittest.TestCase):
    def _broke(self, sim):
        folk = sim.folk
        for hh in folk.households:
            ad = folk_life.adults(folk, hh)
            if len(ad) == 2 and sim.homes[hh.home_id].owner != hh.id:
                for p in ad:
                    p.money, p.savings = -3000.0, 0.0
                return hh
        raise AssertionError("no renting couple")

    def test_three_sundays_in_the_red_move_somewhere_cheaper(self):
        sim = SimStub(1)
        hh = self._broke(sim)
        old_home, old_rent = hh.home_id, hh.weekly_rent
        for week in range(3):
            sim.clock.tick = (6 + 7 * week) * MINUTES_PER_DAY + 23 * 60
            folk_life.weekly(sim)
            if hh.home_id != old_home or hh.gone:
                break
        self.assertTrue(hh.home_id != old_home or hh.gone)
        if not hh.gone:
            self.assertLess(hh.weekly_rent, old_rent)
            self.assertIsNone(sim.homes[old_home].household)
            self.assertEqual(sim.homes[hh.home_id].household, hh.id)
        check_households(self, sim)

    def test_no_cheaper_home_means_leaving_town(self):
        sim = SimStub(1)
        hh = self._broke(sim)
        for h in folk_life.vacancies(sim):
            h.listing = None  # nothing to move to
        mem = folk_life.members(sim.folk, hh)
        slots = [p.job.slot for p in mem if p.job is not None and p.job.hourly_wage > 0]
        home = hh.home_id
        for week in range(3):
            sim.clock.tick = (6 + 7 * week) * MINUTES_PER_DAY + 23 * 60
            folk_life.weekly(sim)
        self.assertTrue(hh.gone)
        for p in mem:
            self.assertTrue(p.gone)
        self.assertIsNone(sim.homes[home].household)
        for s in slots:
            self.assertIsNone(sim.job_board.holder[s])
        self.assertTrue(any(ev["tag"] == "left_town" for ev in sim.events))
        check_households(self, sim)


class HouseholdTest(unittest.TestCase):
    def test_join_split_release(self):
        sim = SimStub(3)
        folk = sim.folk
        adults = [p for p in folk.people if p.age >= 25 and not p.gone]
        hosts = adults[::7]
        moved = left = split_ok = 0
        for k, p in enumerate(adults[::5][:60]):
            if p.gone:
                continue
            if k % 3 == 0:
                host = hosts[(k * 11) % len(hosts)]
                if not host.gone and host.household_id != p.household_id:
                    folk_life.join(sim, p, host)
                    self.assertEqual(p.household_id, host.household_id)
                    moved += 1
            elif k % 3 == 1:
                if folk_life.split(sim, p):
                    split_ok += 1
                else:
                    left += 1
            else:
                folk_life.release(sim, p)
                self.assertTrue(p.gone)
                left += 1
            check_households(self, sim)
        self.assertGreater(moved, 5)
        self.assertGreater(split_ok, 5)
        self.assertGreater(left, 5)

    def test_new_household_takes_a_vacant_rental(self):
        sim = SimStub(1)
        folk = sim.folk
        p = next(q for q in folk.people if q.age >= 25 and q.job is not None and q.job.hourly_wage > 0
                 and len(folk.household(q.household_id).member_ids) >= 3)
        hh = folk_life.new_household(folk, [p.id], None, "rent")
        self.assertIsNotNone(hh)
        self.assertEqual(p.household_id, hh.id)
        self.assertEqual(sim.homes[hh.home_id].household, hh.id)
        self.assertEqual(hh.weekly_rent, float(sim.homes[hh.home_id].rent))
        self.assertIsNone(sim.homes[hh.home_id].listing)
        check_households(self, sim)

    def test_birthdays(self):
        sim = SimStub(1)
        folk = sim.folk
        baby = next(p for p in folk.people if p.age == 4)
        baby.age = 5
        folk_life.on_birthday(sim, baby)
        self.assertEqual(baby.job.title, "student")
        self.assertEqual(sim.town.places[baby.job.place_id].kind, "school")
        teen = next(p for p in folk.people if p.age == 17 and p.job is not None and p.job.title == "student")
        teen.age = 18
        folk_life.on_birthday(sim, teen)
        self.assertIsNone(teen.job)
        kid = next(p for p in folk.people if p.age == 10 and p.job is not None and p.job.place_id != "school")
        kid.age = 11
        folk_life.on_birthday(sim, kid)
        self.assertEqual(kid.job.place_id, folk_gen.HIGH_SCHOOL)
        self.assertEqual(kid.job.end_hour, folk_gen.student_job(11, folk_gen.HIGH_SCHOOL).end_hour)


class NodeParityTest(unittest.TestCase):
    """folk_life.js keeps the same books as folk_life.py over the scripted three weeks."""

    def test_rehearsal(self):
        sim = folk_gen.generate(1)
        got = rehearse(sim)
        self.assertGreater(len(got["gone"]), 0)
        self.assertTrue(any(b[1] > 0 for b in got["books"]))
        self.assertTrue(any(hh["kind"] == "split" for hh in got["households"]))
        if not NODE or not (ROOT / "port" / "src" / "folk_life.js").is_file():
            self.skipTest("node or folk_life.js missing")
        tool = ROOT / "port" / "tools" / "parity_folk_gen.cjs"
        out = subprocess.run([NODE, str(tool), "--money", "1"], capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stdout[-2000:] + out.stderr[-2000:])
        node = json.loads(out.stdout.strip().splitlines()[-1])
        py = json.loads(json.dumps(got))
        for key in ("gone", "books", "homes", "events", "households"):
            self.assertEqual(node[key], py[key], key)
        for a, b in zip(node["people"], py["people"]):
            self.assertEqual(a, b, a["id"])
        self.assertEqual(len(node["people"]), len(py["people"]))


if __name__ == "__main__":
    unittest.main()
