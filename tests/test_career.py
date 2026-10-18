"""career.py (L2, life.md 5.7): the one job board, standing, reviews, layoffs and hiring, for both tiers."""

import os
import statistics
import unittest
from unittest import mock

from gameofailife import career, dice, folk, life, people
from gameofailife.agent import Job, Relationship, RelationKind
from gameofailife.sim import Simulation
from tests.test_life import NODE, folk_person, life_sim, node_eval

SLOW = os.environ.get("GOAL_SLOW") == "1"


def holders(sim) -> dict:
    return {pid: slot for slot, pid in enumerate(career.board(sim).holder) if pid is not None}


class BoardTest(unittest.TestCase):
    def test_slots_are_conserved_through_layoffs_and_hiring(self):
        sim = life_sim()
        b = career.board(sim)
        n = len(b.jobs)
        rr = dice.stream(1, dice.DAY_CAREER, "test", 0)
        laid = [a for a in sim.agents.values() if career.worker(a)][:5]
        for a in laid:
            career.lose_job(sim, a, rr, "laid_off")
            self.assertIsNone(a.job)
            self.assertEqual(a.life.jobless_since, sim.clock.day)
        self.assertEqual(len(b.jobs), n)
        self.assertEqual(sum(h is None for h in b.holder), 5)
        self.assertEqual(b.vacant(sim, laid[0]), [])  # not before they reopen
        for slot in list(b.reopen):
            b.reopen[slot] = sim.clock.day
        for a in laid:
            self.assertTrue(career.hire(sim, a, rr))
        self.assertEqual(len(b.jobs), n)
        got = holders(sim)
        self.assertEqual(len(got), n)
        for pid, slot in got.items():
            self.assertIs(sim.agents[pid].job, b.jobs[slot])
            self.assertEqual(sim.agents[pid].job.slot, slot)

    def test_hiring_respects_the_pay_cap(self):
        sim = life_sim()
        b = career.board(sim)
        a = next(a for a in sim.agents.values() if career.worker(a))
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        b.reopen.clear()
        a.life.last_wage = 1.0  # nothing pays as little as this, or less than 1.25x it
        self.assertFalse(career.hire(sim, a, dice.stream(1, 0)))
        self.assertIsNone(a.job)

    def test_the_benefit_lasts_13_weeks(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        self.assertEqual(career.benefit(sim, a), 0.0)
        career.lose_job(sim, a, dice.stream(1, 0), "laid_off")
        self.assertEqual(career.benefit(sim, a), career.BENEFIT)
        a.life.jobless_since = sim.clock.day - 7 * career.BENEFIT_WEEKS
        self.assertEqual(career.benefit(sim, a), 0.0)

    def test_folk_hiring_goes_nearest_first_and_skips_out_of_reach(self):
        sim = life_sim()
        b = career.board(sim)
        far = Job("clerk", "office", 20, 9, 17, (0, 1, 2, 3, 4))
        near = Job("clerk", "grocer", 20, 9, 17, (0, 1, 2, 3, 4))
        gone = Job("clerk", "nowhere", 25, 9, 17, (0, 1, 2, 3, 4))
        s_far, s_near, s_gone = b.add(far, None), b.add(near, None), b.add(gone, None)
        p = folk_person(sim)
        p.life.jobless_since, p.life.last_wage = 0, 20.0
        minutes = {"office": 40, "grocer": 12, "nowhere": None}
        fake = mock.Mock()
        fake.commute_minutes = lambda person, place: minutes[place]
        fake.isolated = False
        with mock.patch.object(sim, "folk", fake), mock.patch.object(folk, "on_job_change") as changed, \
                mock.patch.object(career, "coworkers"):  # the mock folk has no people to meet
            self.assertTrue(career.hire(sim, p, dice.stream(1, 0)))
        self.assertEqual(p.job.slot, s_near)
        changed.assert_called_once()
        self.assertIsNone(b.holder[s_far])
        self.assertIsNone(b.holder[s_gone])

    def test_a_network_lead_skips_a_slot_a_townsperson_cannot_reach(self):
        sim = life_sim()
        b = career.board(sim)
        friend = next(a for a in sim.agents.values() if career.worker(a))
        lead = b.add(Job("clerk", friend.job.place_id, 5.0, 9, 17, (0, 1, 2, 3, 4)), None)
        p = folk_person(sim)
        p.relationships = {friend.id: Relationship(RelationKind.FRIEND, 45)}
        fake = mock.Mock()
        fake.isolated = False
        for minutes, want in ((None, None), (25, lead)):
            fake.commute_minutes = lambda person, place, m=minutes: m
            with mock.patch.object(sim, "folk", fake):
                self.assertEqual(career.network_slot(sim, p, [lead], None), want)

    def test_a_freed_slot_goes_back_to_its_own_title_and_pay(self):
        sim = life_sim()
        b = career.board(sim)
        a, c = [w for w in sorted(sim.agents.values(), key=lambda w: w.id) if career.worker(w)
                and not w.job.title.startswith(("senior ", "head "))][:2]
        slot, title, wage = a.job.slot, a.job.title, a.job.hourly_wage
        rr = dice.stream(1, 0)
        career.promote(sim, a)
        career.promote(sim, a)
        career.lose_job(sim, a, rr, "laid_off")
        self.assertEqual(a.life.last_wage, round(round(wage * 1.2, 2) * 1.2, 2))  # theirs, not the slot's
        self.assertEqual((b.jobs[slot].title, b.jobs[slot].hourly_wage), (title, wage))
        b.reopen.clear()
        career.lose_job(sim, c, rr, "laid_off")
        b.reopen.clear()
        self.assertTrue(career.hire(sim, c, rr, slot))
        self.assertEqual((c.job.title, c.job.hourly_wage, c.job.slot), (title, wage, slot))
        self.assertIs(b.jobs[slot], c.job)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_a_freed_slot_goes_back_to_its_own_title_and_pay_in_js(self):
        got = node_eval("""
const sim = new G.sim.Simulation(1);
const b = G.career.board(sim);
const [a, c] = [...sim.agents.values()].filter(w => G.career.worker(w) && !/^(senior|head) /.test(w.job.title))
  .sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, 2);
const slot = a.job.slot, title = a.job.title, wage = a.job.hourly_wage;
const rr = G.dice.stream(1, 0);
G.career.promote(sim, a); G.career.promote(sim, a);
G.career.lose_job(sim, a, rr, "laid_off");
b.reopen.clear();
G.career.lose_job(sim, c, rr, "laid_off");
b.reopen.clear();
G.career.hire(sim, c, rr, slot);
console.log(JSON.stringify([a.life.last_wage, c.job.title === title, c.job.hourly_wage === wage, b.jobs[slot] === c.job]));
""")
        self.assertTrue(all(got[1:]))
        self.assertGreater(got[0], 1.4 * 1.0)  # the promoted holder's own last wage stays raised


class StandingTest(unittest.TestCase):
    def test_on_shift_end_on_a_folk_worker(self):
        sim = life_sim()
        b = career.board(sim)
        p = folk_person(sim)
        p.job = Job("porter", "hospital", 18, 7, 15, (0, 1, 2, 3, 4))
        b.add(p.job, p.id)
        events = len(sim.history)
        moved = set()
        for day in range(40):
            sim.clock.tick = 300 + day * 1440
            before = p.reputation
            career.on_shift_end(sim, p)  # a Person: no profile, traits via people.traits
            moved.add(round(p.reputation - before, 3))
        self.assertEqual(len(sim.history), events)  # raises nothing
        self.assertTrue(moved <= {1.2, -1.5, 0.1})
        self.assertGreater(len(moved), 1)

    def test_a_pupil_keeps_v2s_half_point(self):
        sim = life_sim()
        kid = next(a for a in sim.agents.values() if a.job and a.job.hourly_wage == 0)
        rep = kid.reputation
        career.on_shift_end(sim, kid)
        self.assertEqual(kid.reputation, min(100.0, rep + 0.5))

    def test_review_warns_and_fires(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        a.reputation = 15.0
        career.review(sim, a, dice.stream(1, 0))
        self.assertEqual(a.life.warnings, 1)
        self.assertIsNotNone(a.job)
        career.review(sim, a, dice.stream(1, 1))
        self.assertIsNone(a.job)
        self.assertTrue(any(e["tag"] == "job_lost" for e in sim.history))


def run_career_agenda(sim) -> list:
    """Run the career rows on life's agenda in tick order at their ticks (nothing else); their ticks."""
    ran = []
    for t in sorted(sim.life.agenda):
        rows = sim.life.agenda[t]
        keep = [r for r in rows if r[0] != "career"]
        sim.clock.tick = t
        for kind, pid, arg in rows:
            if kind == "career":
                ran.append(t)
                life._run_agenda(sim, kind, pid, arg)
        if keep:
            sim.life.agenda[t] = keep
        else:
            del sim.life.agenda[t]
    return ran


class TimingTest(unittest.TestCase):
    """A review, layoff, offer or hire rolled at any hour happens on a weekday in WORK_HOURS, and someone at work
    then has it at the end of the shift (the verifiers saw layoffs at 04:32 and on Sundays)."""

    def test_rolled_events_wait_for_working_hours(self):
        sim = life_sim()
        a = next(x for x in sim.agents.values() if career.worker(x))
        for start in (3 * 60, 5 * life.DAY + 10 * 60, 6 * life.DAY + 23 * 60, 2 * life.DAY + 16 * 60 + 59,
                      8 * life.DAY + 9 * 60):
            sim.life.agenda.clear()
            sim.clock.tick = start
            career._defer(sim, a, dice.stream(1, 99, start), "laid_off")
            (t, rows), = sim.life.agenda.items()
            day, m = divmod(t, life.DAY)
            self.assertGreater(t, start)
            self.assertLess(day % 7, 5, (start, t))
            self.assertTrue(career.WORK_HOURS[0] <= m < career.WORK_HOURS[1], (start, t))
            self.assertLessEqual(t - start, 3 * life.DAY + career.WORK_HOURS[1], (start, t))
            self.assertEqual(rows, [("career", a.id, ("laid_off", None, start // life.DAY, a.job.slot, False))])

    def test_at_work_it_waits_for_the_end_of_the_shift(self):
        sim = life_sim()
        a = next(x for x in sim.agents.values() if career.worker(x) and 0 in x.job.workdays
                 and x.job.start_hour <= 10 < x.job.end_hour)
        sim.life.agenda.clear()
        sim.clock.tick = 10 * 60  # Monday 10:00, at work
        a.activity, a.worked_today = "work", sim.clock.day
        self.assertTrue(sim.on_shift_now(a))
        slot = a.job.slot
        career.due(sim, a, ("laid_off", None, 0, slot, False))
        self.assertTrue(career.worker(a))  # not yet
        (t, rows), = sim.life.agenda.items()
        self.assertEqual(t, a.job.end_hour * 60)
        self.assertEqual(run_career_agenda(sim), [t])
        self.assertIsNone(a.job)  # laid off at the end of the shift
        self.assertEqual(sim.life.counts["laid_off"], 1)

    def test_a_changed_job_drops_the_old_roll(self):
        sim = life_sim()
        a = next(x for x in sim.agents.values() if career.worker(x))
        sim.clock.tick = 2 * life.DAY + 12 * 60
        career.due(sim, a, ("laid_off", None, 2, a.job.slot + 1000, False))  # rolled in another job
        self.assertTrue(career.worker(a))


@unittest.skipUnless(NODE, "node is not installed")
class TimingTwinTest(unittest.TestCase):
    def test_the_port_defers_the_same(self):
        sim = life_sim()
        a = next(x for x in sim.agents.values() if career.worker(x))
        py = []
        for start in range(0, 9 * life.DAY, 197):
            sim.life.agenda.clear()
            sim.clock.tick = start
            career._defer(sim, a, dice.stream(1, 99, start), "offer")
            py.append(next(iter(sim.life.agenda)))
        js = node_eval(f"""
const sim = new G.sim.Simulation(1);
const a = [...sim.agents.values()].find(x => G.career.worker(x) && x.id === {a.id!r});
const out = [];
for (let start = 0; start < 9 * 1440; start += 197) {{
  sim.life.agenda.clear();
  sim.clock.tick = start;
  G.career._defer(sim, a, G.dice.stream(1, 99, start), "offer");
  out.push([...sim.life.agenda.keys()][0]);
}}
console.log(JSON.stringify(out));
""")
        self.assertEqual(js, py)


class ReviewTest(unittest.TestCase):
    def test_a_city_owns_its_jobs(self):
        a, b = Simulation(1), Simulation(1)
        x = next(p for p in a.agents.values() if career.worker(p))
        career.promote(a, x)
        self.assertIsNot(x.job, b.agents[x.id].job)
        self.assertFalse(b.agents[x.id].job.title.startswith("senior senior"))
        self.assertNotEqual(x.job.title, b.agents[x.id].job.title)

    def test_a_new_hire_meets_up_to_4_coworkers(self):
        sim = life_sim()
        b = career.board(sim)
        place = max({j.place_id for j in b.jobs}, key=lambda pl: sum(1 for j in b.jobs if j.place_id == pl))
        seeker = next(a for a in sim.agents.values() if career.worker(a) and a.job.place_id != place)
        career.lose_job(sim, seeker, dice.stream(1, 0), "laid_off")
        b.reopen.clear()
        seeker.life.last_wage = 1000.0
        slot = b.add(Job("clerk", place, 5.0, 9, 17, (0, 1, 2, 3, 4)), None)
        before = set(seeker.relationships)
        self.assertTrue(career.hire(sim, seeker, dice.stream(1, 0), slot))
        met = [oid for oid in seeker.relationships if oid not in before]
        self.assertTrue(1 <= len(met) <= career.NEW_COWORKERS, met)
        for oid in met:
            r = seeker.relationships[oid]
            self.assertEqual(getattr(r.kind, "value", r.kind), "coworker")
            self.assertTrue(15 <= r.affinity <= 25)
            self.assertIn(seeker.id, sim.agents[oid].relationships)

    def test_promotion_senior_then_head(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values()
                 if career.worker(a) and not a.job.title.startswith(("senior ", "head ")))
        title, wage = a.job.title, a.job.hourly_wage
        career.promote(sim, a)
        self.assertEqual(a.job.title, "senior " + title)
        career.promote(sim, a)
        self.assertEqual(a.job.title, "head " + title)
        self.assertAlmostEqual(a.job.hourly_wage, round(round(wage * 1.2, 2) * 1.2, 2))
        self.assertIs(career.board(sim).jobs[a.job.slot], a.job)

    def test_promotion_needs_85_and_120_days(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a) and a.age < 60
                 and not a.job.title.startswith(("senior ", "head ")))
        a.reputation, a.life.job_since = 90.0, -200
        promoted = False
        for k in range(40):
            career.review(sim, a, dice.stream(1, dice.DAY_CAREER, a.id, k))
            if a.job.title.startswith("senior "):
                promoted = True
                break
        self.assertTrue(promoted)
        b = next(b for b in sim.agents.values() if career.worker(b) and b.age < 60 and b is not a
                 and not b.job.title.startswith(("senior ", "head ")))
        b.reputation, b.life.job_since = 90.0, sim.clock.day - 100
        for k in range(40):
            career.review(sim, b, dice.stream(1, dice.DAY_CAREER, b.id, k))
        self.assertFalse(b.job.title.startswith("senior "))

    def test_retirement_at_67_is_certain(self):
        sim = life_sim()
        a = next(a for a in sim.agents.values() if career.worker(a))
        slot = a.job.slot
        a.age = 67
        career.review(sim, a, dice.stream(1, 0))
        self.assertIsNone(a.job)
        self.assertIsNone(a.life.jobless_since)  # not looking for work
        self.assertIsNone(career.board(sim).holder[slot])
        self.assertEqual(career.benefit(sim, a), 0.0)
        self.assertTrue(any(e["tag"] == "retired" for e in sim.history))

    def test_an_offer_pays_10_to_25_percent_more(self):
        sim = life_sim()
        b = career.board(sim)
        a = next(a for a in sim.agents.values() if career.worker(a))
        old_slot, wage = a.job.slot, a.job.hourly_wage
        better = b.add(Job("manager", a.job.place_id, round(wage * 1.2, 2), 9, 17, (0, 1, 2, 3, 4)), None)
        b.add(Job("director", a.job.place_id, round(wage * 1.5, 2), 9, 17, (0, 1, 2, 3, 4)), None)
        took = career.offer(sim, a, dice.stream(1, 0))
        if took:
            self.assertEqual(a.job.slot, better)
            self.assertIsNone(b.holder[old_slot])
            self.assertGreater(b.reopen[old_slot], sim.clock.day)
        else:
            self.assertEqual(a.job.slot, old_slot)
        self.assertEqual(sim.life.counts["offers"], 1)

    def test_the_network_term_takes_a_friends_workplace(self):
        sim = life_sim()
        b = career.board(sim)
        friend = next(a for a in sim.agents.values() if career.worker(a))
        seeker = next(a for a in sim.agents.values() if career.worker(a) and a.job.place_id != friend.job.place_id)
        career.lose_job(sim, seeker, dice.stream(1, 0), "laid_off")
        b.reopen.clear()
        seeker.life.last_wage = 1000.0
        lead = b.add(Job("clerk", friend.job.place_id, 5.0, 9, 17, (0, 1, 2, 3, 4)), None)
        seeker.relationships = {}  # no friends: no lead
        self.assertIsNone(career.network_slot(sim, seeker, b.vacant(sim, seeker), None))
        seeker.relationships[friend.id] = Relationship(RelationKind.FRIEND, 45)
        self.assertEqual(career.network_slot(sim, seeker, b.vacant(sim, seeker), None), lead)
        logged = []
        with mock.patch.object(people, "log_roll", lambda s, p, what, prob, roll: logged.append((what, prob))):
            for k in range(200):
                career.daily(sim, seeker, dice.stream(1, dice.DAY_CAREER, seeker.id, k))
                run_career_agenda(sim)  # the hire happens in working hours (career._defer)
                if seeker.job is not None:
                    break
        self.assertEqual(seeker.job.slot, lead)
        self.assertAlmostEqual(logged[0][1], dice.odds(career.HIRE_BASE + career.HIRE_REP * seeker.reputation
                                                       + career.HIRE_NETWORK, +1, seeker.luck))


TWIN = """
const out = [];
const sim = new G.sim.Simulation(1);
const ws = [...sim.agents.values()].filter(a => G.career.worker(a)).sort((a, b) => (a.id < b.id ? -1 : 1));
ws[0].age = 67;
G.career.review(sim, ws[0], G.dice.stream(1, G.dice.DAY_CAREER, ws[0].id, 0));
for (const a of ws.slice(1, 7)) {
  a.reputation = 90; a.life.job_since = -200;
  for (let k = 0; k < 6; k++) G.career.review(sim, a, G.dice.stream(1, G.dice.DAY_CAREER, a.id, k));
}
for (const a of ws.slice(7, 9)) G.career.lose_job(sim, a, G.dice.stream(1, G.dice.DAY_CAREER, a.id, 9), "fired");
sim.life.board.reopen.clear();
for (const a of ws.slice(9, 14)) G.career.offer(sim, a, G.dice.stream(1, G.dice.DAY_CAREER, a.id, 10));
for (const a of ws) out.push([a.id, a.job ? a.job.title : null, a.job ? a.job.hourly_wage : null,
  a.job ? a.job.slot : null, a.life.last_wage]);
const c = sim.life.counts;
out.push(["counts", ...["reviews", "raises", "promotions", "retired", "offers", "hired", "fired"].map(k => c[k] ?? 0)]);
console.log(JSON.stringify(out));
"""


def twin_py() -> list:
    out = []
    sim = Simulation(1)
    ws = sorted((a for a in sim.agents.values() if career.worker(a)), key=lambda a: a.id)
    ws[0].age = 67
    career.review(sim, ws[0], dice.stream(1, dice.DAY_CAREER, ws[0].id, 0))
    for a in ws[1:7]:
        a.reputation, a.life.job_since = 90, -200
        for k in range(6):
            career.review(sim, a, dice.stream(1, dice.DAY_CAREER, a.id, k))
    for a in ws[7:9]:
        career.lose_job(sim, a, dice.stream(1, dice.DAY_CAREER, a.id, 9), "fired")
    sim.life.board.reopen.clear()
    for a in ws[9:14]:
        career.offer(sim, a, dice.stream(1, dice.DAY_CAREER, a.id, 10))
    for a in ws:
        out.append([a.id, a.job.title if a.job else None, a.job.hourly_wage if a.job else None,
                    a.job.slot if a.job else None, a.life.last_wage])
    c = sim.life.counts
    out.append(["counts"] + [c[k] for k in ("reviews", "raises", "promotions", "retired", "offers", "hired", "fired")])
    return out


@unittest.skipUnless(NODE, "node is not installed")
class CareerTwinTest(unittest.TestCase):
    def test_reviews_promotions_retirement_and_offers_match_in_js(self):
        py = twin_py()
        js = node_eval(TWIN)
        self.assertEqual(js, py)
        counts = py[-1]
        self.assertGreater(counts[3], 0)  # someone retired
        self.assertGreater(counts[2], 0)  # someone was promoted


@unittest.skipUnless(SLOW, "the 120-day standing run is GOAL_SLOW")
class StandingSoak(unittest.TestCase):
    def test_standing_at_luck_50_after_120_days(self):
        days = int(os.environ.get("SOAK_DAYS", "120"))
        sim = Simulation(1)
        sim.run_days(days)
        reps = [a.reputation for a in sim.agents.values() if a.alive and career.worker(a)]
        med = statistics.median(reps)
        low = sum(1 for r in reps if r < 20)
        print(f"\nstanding at luck 50 after {days} days: median {med:.1f}, below 20: {low} of {len(reps)}")
        self.assertTrue(45 <= med <= 58, med)
        self.assertLessEqual(low, 0.1 * len(reps))


if __name__ == "__main__":
    unittest.main()
