"""life.py and life_tables.py (L2, life.md 5.5-5.9): tables, the board, health, deaths, births, birthdays."""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import career, dice, folk, life, life_tables, people, social
from gameofailife.agent import Job, RelationKind, Relationship
from gameofailife.folk_model import Person
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


def _activities() -> None:
    """Until F3's hooks add them, life's activities (ward, doctor, baby) are registered for the tests."""
    from gameofailife import sim as sim_mod

    for name, spec in life.ACTIVITIES_EXTRA.items():
        if name not in sim_mod.ACTIVITIES:
            sim_mod.ACTIVITIES[name] = sim_mod.Activity(spec.minutes, dict(spec.gains), spec.inside)


def life_row(sim, a) -> list:
    """parity_life.cjs `row` in Python."""
    L = a.life

    def r2(x):
        return round(x, 2)
    return json.loads(json.dumps([
        a.id, a.age, a.alive, a.state, a.activity, a.inside, r2(a.money), r2(a.savings), r2(a.health),
        r2(a.reputation), [a.job.title, a.job.slot, r2(a.job.hourly_wage)] if a.job else None, a.household_id,
        [[[c.id, c.until, c.off_until, c.doctor] for c in L.conditions], list(L.chronic), list(L.treated),
         L.ward_until, L.pregnant, L.trying, r2(L.lifestyle), r2(L.pay), L.jobless_since, L.warnings,
         L.grief_until] if L else None]))


def python_life_trace(seed: int, days: int, dice: int) -> dict:
    """parity_life.cjs `trace` in Python, with the JS port's dice for v2's sim.rng (tests.test_port.DiceSim)."""
    from gameofailife.clock import MINUTES_PER_DAY
    from tests.test_port import DiceSim

    _activities()
    sim = DiceSim(seed, dice)
    hooked = getattr(sim, "life", None) is not None
    if not hooked:
        life.pre_init(sim)
        life.init(sim)
    out = {"events": [], "hours": []}

    def drain():
        events, _, _ = sim.drain()
        out["events"] += [f"{e['tick']} {e['tag']} {e['importance']} {e['text']}" for e in events]

    drain()
    end = sim.clock.tick + days * MINUTES_PER_DAY
    while sim.clock.tick < end:
        sim.step()
        if not hooked:
            life.tick(sim)
        drain()
        if sim.clock.minute_of_day % 60 == 0:
            out["hours"].append([sim.clock.tick, [life_row(sim, a) for a in sim.agents.values()]])
    out["counts"] = dict(sim.life.counts)
    out["board"] = list(sim.life.board.holder)
    out["block"] = life.stats_block(sim)
    return json.loads(json.dumps(out))


def life_sim(seed: int = 1) -> Simulation:
    """A v2 Simulation with life set up (until the hooks land, the tests call life's entry points themselves)."""
    _activities()
    sim = Simulation(seed)
    if getattr(sim, "life", None) is None:
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
        for name, minutes in (("ward", 1440), ("doctor", 45), ("baby", life.TODDLE_MINUTES)):
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

    def test_friendships_today_counts_the_days_new_friends(self):
        """city.life.friendships_today counts the friendships made since midnight (social counts them as
        "friendships"; the block read a key nothing wrote, so it said 0 every day), and talks_today the talks."""
        sim = life_sim()
        a, b = sim.agents["dana"], sim.agents["sara"]
        for x, y in ((a, b), (b, a)):
            x.relationships[y.id] = Relationship(RelationKind.ACQUAINTANCE, 39.5)
        self.assertEqual(life.stats_block(sim)["friendships_today"], 0)
        a.relationships[b.id].affinity = 40.5
        social.on_affinity(sim, a.id, b.id, 39.5, 40.5)
        self.assertIs(a.relationships[b.id].kind, RelationKind.FRIEND)
        self.assertEqual(life.stats_block(sim)["friendships_today"], 1)
        self.assertEqual(life.stats_block(sim)["friendships_today"], sim.life.today["friendships"])


def run_to(sim: Simulation, tick: int) -> None:
    while sim.clock.tick < tick:
        sim.step()


def folk_person(sim, i: int = 7, age: int = 30) -> Person:
    """A townsperson outside any folk household (no Folk needed), with a LifeState."""
    p = Person(i, "Yoav Klein", age, "m", 0)
    p.traits = {t: 0.5 for t in ("thrift", "family", "social", "diligence", "health", "adventure")}
    p.money = 500.0
    life.init_person(sim, p)
    return p


FRACTURE_JS = """
const sim = new G.sim.Simulation(1);
const a = sim.agents.get("dana"), DAY = 1440;
const out = {};
for (const [k, asleep] of [[0, true], [1, false]]) {
  sim.life.agenda.clear();
  a.life.conditions = []; a.life.ward_until = 0;
  sim.clock.tick = (2 + 3 * k) * DAY + 3 * 60;
  a.activity = asleep ? "sleep" : "idle"; a.state = asleep ? "busy" : "idle";
  a.busy_until = (2 + 3 * k) * DAY + 6 * 60 + 30;
  G.life._fall_ill(sim, a, G.life.ACUTE.find(r => r[0] === "fracture"), G.dice.stream(1, 5, k));
  out[k] = { now: a.life.conditions.map(c => [c.id, c.since, c.until, c.off_until]),
             agenda: [...sim.life.agenda.entries()].map(([t, rows]) => [t, rows.map(r => r[0])]) };
  for (const [t, rows] of [...sim.life.agenda.entries()].sort((x, y) => x[0] - y[0])) {
    if (!rows.some(r => r[0] === "accident")) continue;
    sim.clock.tick = t;
    a.activity = "idle"; a.state = "idle";
    for (const [kind, pid, arg] of rows) if (kind === "accident") G.life._run_agenda(sim, kind, pid, arg);
  }
  out[k].after = a.life.conditions.map(c => [c.id, c.since, c.until, c.off_until]);
  out[k].ward = a.life.ward_until;
}
console.log(JSON.stringify(out));
"""


def fracture_py() -> dict:
    sim = life_sim()
    a = sim.agents["dana"]
    DAY = life.DAY
    out = {}
    for k, asleep in ((0, True), (1, False)):
        sim.life.agenda.clear()
        a.life.conditions, a.life.ward_until = [], 0
        sim.clock.tick = (2 + 3 * k) * DAY + 3 * 60
        a.activity, a.state = ("sleep", "busy") if asleep else ("idle", "idle")
        a.busy_until = (2 + 3 * k) * DAY + 6 * 60 + 30
        life._fall_ill(sim, a, next(r for r in life.ACUTE if r[0] == "fracture"), dice.stream(1, 5, k))
        row = {"now": [[c.id, c.since, c.until, c.off_until] for c in a.life.conditions],
               "agenda": [[t, [r[0] for r in rows]] for t, rows in sim.life.agenda.items()]}
        for t in sorted(sim.life.agenda):
            rows = sim.life.agenda[t]
            if not any(r[0] == "accident" for r in rows):
                continue
            sim.clock.tick = t
            a.activity, a.state = "idle", "idle"
            for kind, pid, arg in rows:
                if kind == "accident":
                    life._run_agenda(sim, kind, pid, arg)
        row["after"] = [[c.id, c.since, c.until, c.off_until] for c in a.life.conditions]
        row["ward"] = a.life.ward_until
        out[str(k)] = row
    return out


class FractureTimingTest(unittest.TestCase):
    """A fracture rolled while asleep (the slot minute is any hour) happens ACCIDENT_AWAKE minutes after waking."""

    def test_in_bed_it_waits_for_waking(self):
        got = fracture_py()
        asleep, awake = got["0"], got["1"]
        wake = 2 * life.DAY + 6 * 60 + 30
        self.assertEqual(asleep["now"], [])
        self.assertEqual(asleep["agenda"], [[wake + life.ACCIDENT_AWAKE, ["accident"]]])
        self.assertEqual([c[:2] for c in asleep["after"]], [["fracture", wake + life.ACCIDENT_AWAKE]])
        self.assertGreater(asleep["ward"], wake)
        self.assertEqual([c[:2] for c in awake["now"]], [["fracture", 5 * life.DAY + 3 * 60]])
        if NODE:
            self.assertEqual(node_eval(FRACTURE_JS), got)

    def test_a_sleeping_townsperson_waits_too(self):
        sim = Simulation(1, world="region", folk=200)
        while sim.clock.minute_of_day != 3 * 60:
            sim.step()
        p = next(q for q in sim.folk.living() if q.age >= 18 and q.activity == "sleep" and q.trip is None)
        wake = sim.folk.stay[p.i][1]
        self.assertGreater(wake, sim.clock.tick)
        life._fall_ill(sim, p, next(r for r in life.ACUTE if r[0] == "fracture"), dice.stream(1, 5))
        self.assertEqual(p.life.conditions, [])
        self.assertIn(("accident", p.id), [(r[0], r[1]) for r in sim.life.agenda.get(wake + life.ACCIDENT_AWAKE, [])])


class HealthTest(unittest.TestCase):
    def onset_odds(self, season: str, age: int = 30) -> float:
        sim = life_sim()
        a = sim.agents["dana"]
        a.age, a.life.conditions, a.life.chronic, a.life.treated = age, [], [], []
        seen = {}
        with mock.patch.object(type(sim.clock), "season", new=property(lambda c: season)), \
                mock.patch.object(people, "log_roll", lambda s, p, what, prob, roll: seen.setdefault(what, prob)):
            life._health(sim, a, dice.stream(1, dice.DAY_HEALTH, "dana", 0), 0)
        return seen["ill"]

    def test_onset_rates_by_season(self):
        rates = {s: self.onset_odds(s) for s in ("spring", "summer", "autumn", "winter")}
        self.assertGreater(rates["winter"], rates["autumn"])
        self.assertGreater(rates["autumn"], rates["spring"])
        self.assertGreater(rates["spring"], rates["summer"])
        heart = life_tables.HEART_YEAR[30]
        winter = (2.0 * 1.8 + 0.12 * 3.0 + 0.4 + 0.12 + 0.02 + heart * 0.6 + heart * 0.4) / 360
        self.assertAlmostEqual(rates["winter"], winter, places=12)
        # About 2.6 acute illnesses a year for an adult: 3-12% of people ill at any time.
        self.assertTrue(2.0 < sum(rates.values()) / 4 * 360 < 3.5)

    def test_max_health(self):
        sim = life_sim()
        a = sim.agents["dana"]
        a.life.chronic = []
        a.age = 40
        self.assertEqual(life.max_health(a), 100.0)
        a.age, a.life.chronic = 65, ["diabetes", "arthritis"]
        self.assertAlmostEqual(life.max_health(a), 100 - 10 * 0.8 - 10)

    def test_a_fracture_goes_to_the_ward_and_pays_at_discharge(self):
        sim = life_sim()
        a = sim.agents["ari"]
        a.life.conditions = []
        row = next(r for r in life.ACUTE if r[0] == "fracture")
        life._fall_ill(sim, a, row, dice.stream(1, dice.DAY_HEALTH, "ari", "test"))
        self.assertTrue(life.in_hospital(a))
        self.assertFalse(life.can_work(sim, a))
        self.assertEqual(a.plan[:0], [])
        self.assertIn(a.activity, ("ward",))
        until = a.life.ward_until
        before = a.money + a.savings
        run_to(sim, until + 1)
        self.assertEqual(a.life.ward_until, 0)
        self.assertTrue(any(e["tag"] == "discharged" and e["agent"] == "ari" for e in sim.history))
        self.assertLess(a.money + a.savings, before)

    def test_cold_spreads_at_home_and_clears(self):
        sim = life_sim()
        a, b = sim.agents["shira"], sim.agents["eli"]
        for p in (a, b):
            p.life.conditions = []
        row = next(r for r in life.ACUTE if r[0] == "cold")
        life._fall_ill(sim, a, row, dice.stream(1, dice.DAY_HEALTH, "x", 1))
        self.assertTrue(life.ill(a))
        caught = 0
        for day in range(200):  # .08 a day, luck 50: the housemate catches it on about 1 in 12 tries
            b.life.conditions = []
            with mock.patch.object(life, "_hit", lambda sim_, p, what, base, v, rr, k=1.0: what == "catch"):
                life._health(sim, b, dice.stream(1, dice.DAY_HEALTH, "eli", day), day)
            caught += bool(b.life.conditions)
        self.assertEqual(caught, 200)
        a.life.conditions[0].until = sim.clock.tick
        life._health(sim, a, dice.stream(1, dice.DAY_HEALTH, "shira", 9), 9)
        self.assertFalse(life.ill(a))


class DeathTest(unittest.TestCase):
    def test_on_death_frees_the_slot_widows_and_closes_loans(self):
        sim = life_sim()
        eli, shira = sim.agents["eli"], sim.agents["shira"]
        slot = eli.job.slot
        sim.life.loans.append({"id": "l1", "lender": "eli", "borrower": "tom", "amount": 300, "since": 0})
        sim.life.loans.append({"id": "l2", "lender": "dana", "borrower": "tom", "amount": 100, "since": 0})
        life.die(sim, eli, "died suddenly")
        self.assertFalse(eli.alive)
        b = career.board(sim)
        self.assertIsNone(b.holder[slot])
        self.assertTrue(7 <= b.reopen[slot] - sim.clock.day <= 30)
        self.assertEqual(shira.life.widowed_day, sim.clock.day)
        self.assertEqual(shira.life.grief_until, sim.clock.day + life.GRIEF_DAYS)
        self.assertEqual([r["id"] for r in sim.life.loans], ["l2"])
        self.assertEqual(sim.life.counts["deaths"], 1)
        self.assertNotIn("eli", sim.life.by_slot[eli.life.slot])
        life.on_death(sim, eli)  # once only
        self.assertEqual(sim.life.counts["deaths"], 1)

    def test_a_dead_mother_gives_no_birth(self):
        sim = life_sim()
        shira = sim.agents["shira"]
        life.die(sim, shira, "died suddenly")
        run_to(sim, life.SHIRA_DUE[0] * life.DAY + life.BIRTH_MINUTE + 1)
        self.assertEqual(sim.life.counts["births"], 0)


class BirthTest(unittest.TestCase):
    def test_shira_has_a_named_baby_on_day_4(self):
        sim = life_sim()
        self.assertEqual(sim.agents["shira"].life.pregnant, (life.SHIRA_DUE[0], "eli"))
        page = life.page(sim, sim.agents["shira"])
        self.assertEqual(page["pregnant"]["with"], "eli")
        run_to(sim, life.SHIRA_DUE[0] * life.DAY + life.BIRTH_MINUTE)
        self.assertEqual(len(sim.agents), 61)
        baby = list(sim.agents.values())[-1]
        self.assertEqual(baby.age, 0)
        self.assertTrue(baby.name.endswith("Peretz"))
        self.assertFalse(any(ch.isdigit() for ch in baby.id))
        self.assertEqual(baby.household_id, sim.agents["shira"].household_id)
        self.assertIn(baby.id, sim.households[baby.household_id].member_ids)
        self.assertEqual(baby.relationships["shira"].kind, RelationKind.FAMILY)
        self.assertEqual(sim.agents["eli"].relationships[baby.id].kind, RelationKind.FAMILY)
        self.assertEqual(life.stage(baby), "baby")
        self.assertIn(baby.sex, ("f", "m"))
        ev = [e for e in sim.history if e["tag"] == "birth"]
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["importance"], 2)
        run_to(sim, sim.clock.tick + 3 * 60)
        self.assertEqual(baby.activity, "baby")  # toddle: no forks under 5
        self.assertIsNone(baby.fork_id)

    def test_a_folk_mother_goes_to_add_baby(self):
        sim = life_sim()
        mum = folk_person(sim, 3, 28)
        mum.sex = "f"
        with mock.patch.object(folk, "add_baby", return_value=None) as add:
            life.birth(sim, mum, None)
        add.assert_called_once()
        self.assertEqual(sim.life.counts["births"], 1)


class BirthdayTest(unittest.TestCase):
    def test_a_folk_five_year_old_reaches_folk_on_birthday(self):
        sim = life_sim()
        kid = folk_person(sim, 11, 4)
        calls = []
        with mock.patch.object(folk, "on_birthday", lambda s, p: calls.append(("birthday", p.id, p.age))), \
                mock.patch.object(folk, "on_job_change", lambda s, p: calls.append(("job", p.id))):
            life.birthday(sim, kid)
        self.assertEqual(calls, [("birthday", kid.id, 5), ("job", kid.id)])
        self.assertIsNone(kid.job)  # never cast._student_job for a townsperson

    def test_a_named_child_starts_and_finishes_school(self):
        sim = life_sim()
        a = sim.agents["lior"]
        a.age, a.job = 4, None
        life.birthday(sim, a)
        self.assertEqual((a.age, a.job.title, a.job.place_id), (5, "student", "school"))
        a.age = 17
        life.birthday(sim, a)
        self.assertIsNone(a.job)
        self.assertEqual(a.life.jobless_since, sim.clock.day)
        self.assertTrue(any(e["tag"] == "came_of_age" for e in sim.history))

    def test_birthdays_age_people_on_their_own_day(self):
        sim = life_sim()
        a = sim.agents["dana"]
        age = a.age
        day = a.life.birthday or 360
        with mock.patch.object(life, "_health"), mock.patch.object(life, "_family"), \
                mock.patch.object(career, "daily"):
            life.daily(sim, a, day - 1)
            self.assertEqual(a.age, age)
            life.daily(sim, a, day)
        self.assertEqual(a.age, age + 1)


class FolkEventsTest(unittest.TestCase):
    def test_no_folk_importance_0_event(self):
        sim = life_sim()
        p = folk_person(sim)
        with mock.patch.object(sim, "event") as ev:
            life._event(sim, p, "x", "ill", 0)
            life._event(sim, p, "x", "recovered")
            ev.assert_not_called()
            life._event(sim, p, "x", "hospital", 1)
            ev.assert_called_once()


class HouseholdTest(unittest.TestCase):
    def test_split_keeps_everyone_in_one_household(self):
        sim = life_sim()
        a = sim.agents["eli"]
        self.assertTrue(life.split(sim, a))
        homes = [hid for hid, hh in sim.households.items() if "eli" in hh.member_ids]
        self.assertEqual(homes, [a.household_id])
        for agent in sim.agents.values():
            self.assertEqual(sum(agent.id in hh.member_ids for hh in sim.households.values()), 1, agent.id)
        self.assertEqual(sim.homes[sim.households[a.household_id].home_id].household, a.household_id)


@unittest.skipUnless(NODE, "node is not installed")
class LifeLockstep(unittest.TestCase):
    """parity_life.cjs: the 60 with life on, event for event and hour by hour (8 days with GOAL_SLOW=1, else 2)."""

    def test_lockstep(self):
        days = 8 if os.environ.get("GOAL_SLOW") == "1" else 2
        run = subprocess.run([NODE, str(ROOT / "port" / "tools" / "parity_life.cjs"), "1", str(days), "1"],
                             capture_output=True, text=True, timeout=900)
        self.assertEqual(run.returncode, 0, run.stderr)
        js = json.loads(run.stdout)
        py = python_life_trace(1, days, 1)
        for key in ("counts", "board", "block"):
            self.assertEqual(py[key], js[key], key)
        for i, (a, b) in enumerate(zip(py["events"], js["events"])):
            self.assertEqual(a, b, f"event #{i}")
        self.assertEqual(len(py["events"]), len(js["events"]))
        for (ta, ra), (tb, rb) in zip(py["hours"], js["hours"]):
            self.assertEqual(ta, tb)
            for x, y in zip(ra, rb):
                self.assertEqual(x, y, f"tick {ta}")


if __name__ == "__main__":
    unittest.main()
