"""Townsfolk days (folk.md 12 Days, F2a): the outdoors curve, at work and at school, shut places, the wheel,
lazy settles, the crowd invariant every tick, and one `career.on_shift_end` per folk shift.

The world is the real `Simulation(seed, world="region", folk=n)` once it takes those keywords and the generator
(`folk_gen.populate`) exists; until then a small stand-in (`StubSim`) on the region map with a plain local
population (`stub_populate`: households in the region's homes, jobs nearest first, pupils at the nearest school).
3 days by default; `GOAL_SLOW=1` runs 14 days x 3 seeds (`SOAK_DAYS`, `SOAK_SEEDS` override them).
"""

from __future__ import annotations

import inspect
import os
import time
import unittest
from collections import Counter

from gameofailife import agent, career, folk, folk_transit
from gameofailife.clock import Clock
from gameofailife.folk_model import FolkHousehold, Person
from gameofailife.rng import Rng

SLOW = bool(os.environ.get("GOAL_SLOW"))
DAYS = int(os.environ.get("SOAK_DAYS", "14" if SLOW else "3"))
SEEDS = [int(s) for s in os.environ.get("SOAK_SEEDS", "1,2,3" if SLOW else "1").split(",")]
N = 1000
DAY = 1440
TRAITS = agent.Profile.TRAITS


def _has_gen() -> bool:
    try:
        from gameofailife import folk_gen
    except ImportError:
        return False
    return hasattr(folk_gen, "populate")


def _sim_takes_world() -> bool:
    from gameofailife.sim import Simulation
    return "world" in inspect.signature(Simulation.__init__).parameters


def integrated() -> bool:
    return _has_gen() and _sim_takes_world()


class StubSim:
    """Just what Folk reads: clock, town (the region), seeds, no named, homes, the life city's luck log."""

    def __init__(self, seed: int, n: int, isolated: bool = False, populate=None):
        from gameofailife import housing, region
        self.seed = seed
        self.dice_seed = seed
        self.clock = Clock()
        self.town = region.build_region(seed)
        self.agents = {}
        self.households = {}
        self.homes = {}
        for hid, pid, unit, tier, beds, value, rent, start, cond in self.town.home_specs:
            if pid in self.town.millbrook_ids:
                continue
            self.homes[hid] = housing.Home(hid, pid, unit, self.town.places[pid].name, tier, beds, value, rent,
                                           start)
        self.events = []
        self.folk = None
        self.folk = folk.Folk(self, n, isolated, populate=populate or stub_populate)

    def person(self, pid):
        return self.agents.get(pid) or self.folk.person(pid)

    def event(self, *args, **kwargs):
        self.events.append(args)
        return None

    def step(self):
        self.clock.advance()
        self.folk.tick(self)
        if self.clock.tick % 60 == 0:
            self.folk.sample_hour(self)


def stub_populate(f, sim, n: int) -> None:
    """A plain population for tests before folk_gen: households of 1-5 in the region's homes (value order), adults
    18-64 at the nearest job slot by their best commute (85% seek), pupils 5-17 at the nearest school, cars by
    home tier, everyone asleep at home."""
    town = sim.town
    rng = Rng(sim.seed * 7 + 3)
    homes = sorted(sim.homes.values(), key=lambda h: (-h.base_value, h.id))
    net = folk_transit.net(town)
    slots = []
    for title, pid, wage, start, end, days, count in town.job_slots:
        if f.isolated and pid in town.millbrook_ids:
            continue
        slots += [[title, pid, wage, start, end, tuple(days)] for _ in range(count)]
    schools = [pid for pid, p in town.places.items() if p.kind == "school" and f.allowed(pid)]
    free_by_place = {}
    for s in slots:
        free_by_place.setdefault(s[1], []).append(s)
    i = 0
    for j, home in enumerate(homes):
        if i >= n:
            break
        kind = rng.int(0, 9)
        if kind < 3:
            ages = [rng.int(19, 85)]
        elif kind < 6:
            a = rng.int(22, 80)
            ages = [a, max(19, a + rng.int(-4, 4))]
        else:
            a = rng.int(26, 52)
            ages = [a, max(22, a + rng.int(-4, 4))] + [rng.int(0, min(17, a - 20)) for _ in range(rng.int(1, 3))]
        ages = ages[:n - i]
        hh = FolkHousehold(f"fh{j}", home.id, float(home.rent), 8, [], j=j)
        home.household = hh.id
        home.owner = hh.id if home.start == "owned" else "landlord"
        f.households.append(hh)
        car_p = {"flat": 0.25, "house": 0.6, "big_house": 0.9}.get(home.tier, 0.3)
        for age in ages:
            p = Person(i, f"Folk{i} Stub{j}", age, "f" if rng.random() < 0.5 else "m", j)
            p.traits = {t: round(rng.uniform(0.2, 0.8), 3) for t in TRAITS}
            p._needs = {k: rng.uniform(60, 90) for k in agent.NEEDS}
            p._nt = sim.clock.tick
            p.health = rng.uniform(80, 100)
            p.money = float(rng.int(50, 2500)) if age >= 18 else float(rng.int(0, 40))
            p.savings = float(rng.int(0, 5000)) if age >= 18 else 0.0
            p.owns_car = age >= 18 and rng.random() < car_p
            p.inside = home.place
            p.activity = "sleep"
            if 5 <= age <= 17 and schools:
                s = min(schools, key=lambda sp: (net.minutes(home.place, sp, "car"), sp))
                end = 14 if age < 12 else 15
                p.job = agent.Job("student", s, 0, 8, end, (0, 1, 2, 3, 4))
                w = net.minutes(home.place, s, "walk")
                p.commute = (s, w, "walk") if w <= 25 else (s, net.minutes(home.place, s, "car"), "car")
            elif 18 <= age <= 64 and rng.random() < 0.85:
                best = None
                for pid, free in free_by_place.items():
                    if not free:
                        continue
                    got = folk_transit.best_minutes(town, home.place, pid, p.owns_car)
                    if got is not None and (best is None or (got[0], pid) < (best[0][0], best[1])):
                        best = (got, pid)
                if best is not None:
                    title, pid, wage, start, end, days = free_by_place[best[1]].pop()
                    p.job = agent.Job(title, pid, float(wage), start, end, days)
                    p.commute = (pid, best[0][0], best[0][1])
            hh.member_ids.append(p.id)
            f.people.append(p)
            p.next_tick = 0
            i += 1


def make_world(seed: int, n: int = N, isolated: bool = False):
    if integrated():
        from gameofailife.sim import Simulation
        return Simulation(seed, world="region", folk=n, folk_isolated=isolated)
    return StubSim(seed, n, isolated)


class Probe:
    """Runs a world tick by tick and keeps what the checks read."""

    def __init__(self, sim):
        self.sim = sim
        self.f = sim.folk
        self.outdoors = {}  # tick -> folk outdoors (on a trip or strolling)
        self.last_step = {}
        self.bad_invariant = []
        self.shut_inside = []
        self.home_at_3 = []
        self.work_1030 = []
        self.school_1030 = []
        self.shift_calls = Counter()
        self.shift_arrivals = Counter()
        self.peak = 0
        f = self.f
        orig_step = f.step
        probe = self

        def step(sim_, p, now):
            probe.last_step[p.i] = now
            was = p.activity if p.trip is None else None
            orig_step(sim_, p, now)
            if was not in ("work", "school") and p.trip is None and p.activity in ("work", "school"):
                probe.shift_arrivals[(p.i, now // DAY)] += 1

        f.step = step
        self._orig_on_shift_end = career.on_shift_end

        def on_shift_end(sim_, p):
            if isinstance(p, Person):
                probe.shift_calls[(p.i, sim_.clock.tick // DAY)] += 1
            return probe._orig_on_shift_end(sim_, p)

        career.on_shift_end = on_shift_end

    def close(self):
        career.on_shift_end = self._orig_on_shift_end

    def run(self, days: int, every_tick=True):
        sim, f = self.sim, self.f
        end = sim.clock.tick + days * DAY
        while sim.clock.tick < end:
            sim.step()
            tick = sim.clock.tick
            m = tick % DAY
            out = len(f.out) + len(f.strollers)
            self.outdoors[tick] = out
            self.peak = max(self.peak, out)
            if every_tick or m % 10 == 0:
                c = f.counts(sim)
                if c["crowd"] + c["inside"] + c["aboard"] + c["passengers"] != c["present"]:
                    self.bad_invariant.append((tick, c))
            if m % 60 == 30:
                self._shut(tick)
            if m == 180:
                self._home(tick)
            if m == 630 and (tick // DAY) % 7 < 5:
                self._at_work(tick)

    def _shut(self, tick):
        hour = (tick % DAY) / 60
        town = self.f.town
        for pid, occ in self.f.occupants.items():
            place = town.places[pid]
            if place.kind == "home" or place.is_open(hour) or not occ:
                continue
            for i in occ:
                p = self.f.people[i]
                staff = p.job is not None and p.job.place_id == pid and p.activity in ("work", "school")
                if not staff:
                    self.shut_inside.append((tick, pid, p.id, p.activity))

    def _home(self, tick):
        f = self.f
        at_home = total = 0
        for p in f.living():
            if p.activity in ("work", "ward"):
                continue
            total += 1
            if p.inside is not None and p.inside == f.home_place(p):
                at_home += 1
        self.home_at_3.append((at_home, total))

    def _at_work(self, tick):
        f = self.f
        day, m = divmod(tick, DAY)
        w_at = w_all = s_at = s_all = 0
        for p in f.living():
            job = p.job
            if job is None or day % 7 not in job.workdays or not (job.start_hour * 60 <= m < job.end_hour * 60):
                continue
            if not career_can_work(self.sim, p):
                continue
            here = p.inside == job.place_id
            if job.title == "student" or p.age < 18:
                s_all += 1
                s_at += here
            else:
                w_all += 1
                w_at += here
        self.work_1030.append((w_at, w_all))
        self.school_1030.append((s_at, s_all))

    def share(self, m0, m1, fn=max):
        n = max(1, len(self.f.living()))
        vals = [v for t, v in self.outdoors.items() if m0 <= t % DAY <= m1 and (t // DAY) % 7 < 5]
        return fn(vals) / n if vals else 0.0


def career_can_work(sim, p):
    from gameofailife import life
    return life.can_work(sim, p)


def _weekday_ticks(probe, minute):
    return [t for t in probe.outdoors if t % DAY == minute and (t // DAY) % 7 < 5]


class FolkDaysTest(unittest.TestCase):
    probes = {}

    @classmethod
    def setUpClass(cls):
        cls.probes = {}
        cls.cpu = {}
        for seed in SEEDS:
            c = time.process_time()
            sim = make_world(seed)
            probe = Probe(sim)
            try:
                probe.run(DAYS)
            finally:
                probe.close()
            cls.cpu[seed] = time.process_time() - c
            cls.probes[seed] = probe

    def test_outdoors_curve(self):
        for seed, probe in self.probes.items():
            n = len(probe.f.living())
            for t in _weekday_ticks(probe, 180):
                self.assertLessEqual(probe.outdoors[t] / n, 0.01, (seed, t))
            for t in _weekday_ticks(probe, 720):
                self.assertLessEqual(probe.outdoors[t] / n, 0.08, (seed, t, probe.outdoors[t]))
            days = sorted({t // DAY for t in probe.outdoors if (t // DAY) % 7 < 5 and t % DAY == 600})
            for d in days:
                morning = max(probe.outdoors[t] for t in range(d * DAY + 420, d * DAY + 541) if t in probe.outdoors)
                evening = max(probe.outdoors[t] for t in range(d * DAY + 960, d * DAY + 1111) if t in probe.outdoors)
                self.assertTrue(0.08 <= morning / n <= 0.30, (seed, d, morning, n))
                self.assertTrue(0.12 <= evening / n <= 0.35, (seed, d, evening, n))
            self.assertLessEqual(probe.peak, 400, seed)

    def test_home_at_night(self):
        for seed, probe in self.probes.items():
            for at_home, total in probe.home_at_3:
                self.assertGreaterEqual(at_home, 0.95 * total, (seed, at_home, total))

    def test_at_work_and_school(self):
        for seed, probe in self.probes.items():
            for at, total in probe.work_1030:
                self.assertGreaterEqual(at, 0.85 * total, (seed, at, total))
            for at, total in probe.school_1030:
                self.assertGreaterEqual(at, 0.95 * total, (seed, at, total))

    def test_nobody_inside_a_shut_place_but_staff(self):
        for seed, probe in self.probes.items():
            self.assertEqual(probe.shut_inside[:5], [], seed)

    def test_an_event_within_a_day_for_everyone(self):
        for seed, probe in self.probes.items():
            now = probe.sim.clock.tick
            for p in probe.f.living():
                self.assertGreaterEqual(probe.last_step.get(p.i, -10 ** 9), now - DAY, (seed, p.id, p.activity))

    def test_crowd_invariant_every_tick(self):
        for seed, probe in self.probes.items():
            self.assertEqual(probe.bad_invariant[:3], [], seed)

    def test_one_shift_end_per_shift(self):
        for seed, probe in self.probes.items():
            self.assertGreater(sum(probe.shift_calls.values()), 0, seed)
            self.assertTrue(all(v == 1 for v in probe.shift_calls.values()), seed)
            self.assertTrue(all(v == 1 for v in probe.shift_arrivals.values()), seed)
            missing = [key for key in probe.shift_calls if key not in probe.shift_arrivals]
            self.assertEqual(missing[:5], [], seed)
            # work shifts and pupils' school days both end in one career.on_shift_end
            self.assertEqual(sum(probe.shift_calls.values()),
                             probe.f.counters["shifts"] + probe.f.counters["school_days"], seed)

    def test_perf(self):
        for seed, probe in self.probes.items():
            perf = probe.f.perf()
            print(f"\nfolk seed {seed}: {perf['total_mean_ms']:.3f} ms/tick mean, p99 {perf['p99_ms']:.3f} ms "
                  f"(last day), load {os.getloadavg()[0]:.1f}, run {self.cpu[seed]:.1f} s cpu, "
                  f"steps {probe.f.counters['steps']}, boardings {probe.f.counters['boardings']}")
            self.assertLessEqual(perf["total_mean_ms"], 0.6, seed)
            self.assertLessEqual(perf["p99_ms"], 3.0, seed)


class SettleTest(unittest.TestCase):
    """needs/mood/x/y read lazily mid-trip and mid-shift equal a fresh settle from the last step's state."""

    def test_settle_equality(self):
        from unittest import mock

        sim = make_world(SEEDS[0], 300)
        f = sim.folk
        seen_trip = seen_shift = 0
        snap = {}
        touched = set()  # people whose needs another rule moved (a talk's social gain, L1) since the last check
        real_adjust = Person.adjust

        def adjust(p, need, delta):
            touched.add(p.i)
            real_adjust(p, need, delta)

        patch = mock.patch.object(Person, "adjust", adjust)
        patch.start()
        self.addCleanup(patch.stop)
        for _ in range(DAY):
            sim.step()
            tick = sim.clock.tick
            for i in touched:
                snap.pop(i, None)  # a fresh settle from the old snapshot cannot know of the change: snapshot again
            touched.clear()
            for p in f.people:
                if not p.alive or p.gone:
                    continue
                if p.next_tick > tick and p.i not in snap and p.age >= 5 and (
                        p.trip is not None or p.activity == "work"):
                    snap[p.i] = (tick, dict(p._needs), p._nt, p.activity, p.state, p.trip)
            for i, (t0, needs0, nt0, act, state, trip) in list(snap.items()):
                p = f.people[i]
                if p.next_tick <= tick or p.activity != act or p.trip is not trip:
                    del snap[i]
                    continue
                if tick - t0 < 5 or (tick - t0) % 7:
                    continue
                q = Person(p.i, p.name, p.age, p.sex, p.hh)
                q._needs, q._nt, q.activity, q.state = dict(needs0), nt0, act, state
                q.settle(tick)
                for k in agent.NEEDS:
                    self.assertAlmostEqual(p.needs[k], q._needs[k], places=6)
                self.assertAlmostEqual(p.mood, q.mood, places=6)
                if trip is not None:
                    leg = folk_transit.leg_at(trip.legs, tick)
                    if leg[0] in (folk_transit.WALK, folk_transit.DRIVE):
                        x, y, _ = leg[3].at(tick - leg[1])
                        self.assertEqual((p.x, p.y), (x, y))
                    seen_trip += 1
                else:
                    e = f.town.places[p.inside].entry
                    self.assertEqual((p.x, p.y), (e[0], e[1]))
                    seen_shift += 1
        self.assertGreater(seen_trip, 10)
        self.assertGreater(seen_shift, 10)


class ApiTest(unittest.TestCase):
    """The life.md 3.2 folk functions and the frame shapes on a small world."""

    @classmethod
    def setUpClass(cls):
        cls.sim = make_world(SEEDS[0], 200)
        for _ in range(9 * 60):  # to 14:00 on day 0
            cls.sim.step()

    def test_shapes(self):
        sim, f = self.sim, self.sim.folk
        crowd = f.crowd(sim)
        self.assertEqual(len(crowd) % 4, 0)
        ids = crowd[0::4]
        self.assertEqual(ids, sorted(set(ids)))
        self.assertTrue(all(k < 16 for k in crowd[3::4]))
        self.assertEqual(len(f.occ()), len(sim.town.places))
        st = f.stats_json(sim)
        self.assertEqual(set(st), {"v", "worth", "worth_24h", "mood", "health", "luck"})
        for k in ("worth", "worth_24h", "mood", "health", "luck"):
            self.assertEqual(len(st[k]), len(f.people))
        rows = f.roster_rows(sim)
        self.assertEqual(set(rows[0]), {"i", "id", "name", "age", "child", "hh", "home", "place", "district", "job",
                                        "work", "alive"})
        self.assertIsInstance(f.riders(sim.clock.tick), dict)

    def test_present_and_send_to(self):
        sim, f = self.sim, self.sim.folk
        free = [p for p in f.living() if folk.is_free(sim, p) and p.trip is None]
        self.assertTrue(free)
        p = free[0]
        cafe = next(pid for pid, pl in sim.town.places.items() if pl.kind == "cafe" and pl.is_open(14.5)
                    and f.allowed(pid))
        self.assertTrue(folk.send_to(sim, p, cafe, "hang_out", 60))
        for _ in range(200):
            sim.step()
            if p.inside == cafe:
                break
        self.assertEqual(p.inside, cafe)
        self.assertIn(p.i, f.present(cafe))
        busy = [q for q in f.living() if q.activity == "work"]
        if busy:
            self.assertFalse(folk.is_free(sim, busy[0]))
            self.assertFalse(folk.send_to(sim, busy[0], cafe, "hang_out", 60))

    def test_ward_and_kill(self):
        sim, f = self.sim, self.sim.folk
        p = next(q for q in f.living() if q.age >= 18 and q.activity != "work")
        self.assertTrue(folk.hospitalise(sim, p, 1))
        self.assertEqual(p.trip.mode, "ambulance")
        q = next(r for r in f.living() if r is not p and r.age >= 18)
        folk.kill(sim, q, "test")
        self.assertTrue(q.alive)
        self.assertIsNone(q.inside)
        self.assertNotIn(q.i, f.out)
        for _ in range(60):
            sim.step()
        self.assertEqual(p.inside and sim.town.places[p.inside].kind, "hospital")

    def test_page(self):
        sim, f = self.sim, self.sim.folk
        page = f.page_json(sim, "f3")
        for k in ("kind", "luck_settable", "money", "job", "home", "household", "relationships", "memory", "sex",
                  "needs", "household_id", "reputation", "vehicle", "choices", "life"):
            self.assertIn(k, page)
        self.assertEqual(page["kind"], "folk")
        self.assertTrue(f.set_luck("f3", 80))
        self.assertEqual(f.person("f3").luck, 80)
        for c in page["choices"]:
            self.assertEqual(len(c["options"]), 4)
            self.assertIn(c["by"], ("habit", "default"))

    def test_commute_minutes(self):
        sim, f = self.sim, self.sim.folk
        p = next(q for q in f.living() if q.job is not None and q.age >= 18)
        m = f.commute_minutes(p, p.job.place_id)
        self.assertIsNotNone(m)


class CompanionTest(unittest.TestCase):
    """Someone sent on an errand (`send_to`: an invite, a date, a friend's outing) keeps it: nobody's company for
    another outing and never re-sent until its stay ends; nobody at work, at school or asleep is company either."""

    def test_an_errand_is_kept(self):
        if not integrated():
            self.skipTest("needs the real Simulation and social.pick_companion")
        from gameofailife import people, social
        from gameofailife.agent import RelationKind
        sim = make_world(SEEDS[0], 200)
        for _ in range(9 * 60):  # to 14:00 on day 0
            sim.step()
        f = sim.folk
        free = [p for p in f.living() if p.age >= 18 and folk.is_free(sim, p) and p.trip is None]
        p = free[0]
        q = next(x for x in free if x.household_id != p.household_id)
        p.relationships = {}
        people.set_rel(sim, p.id, q.id, RelationKind.FRIEND, 70)
        self.assertIs(social.pick_companion(sim, p, "visit"), q)
        cafes = [pid for pid, pl in sim.town.places.items() if pl.kind == "cafe" and pl.is_open(14.5)
                 and f.allowed(pid) and pid != q.inside]
        self.assertTrue(folk.send_to(sim, q, cafes[0], "hang_out", 60))
        self.assertFalse(folk.is_free(sim, q))
        self.assertIsNone(social.pick_companion(sim, p, "visit"))
        self.assertFalse(folk.send_to(sim, q, cafes[1], "hang_out", 60))
        self.assertEqual(q.trip.dest if q.trip is not None else q.inside, cafes[0])
        for _ in range(400):
            sim.step()
            if q.i not in f.sent:
                break
        self.assertNotIn(q.i, f.sent)  # the errand's stay ended: free time is theirs again

    def test_company_is_free_all_day(self):
        if not integrated():
            self.skipTest("needs the real Simulation and social.pick_companion")
        from unittest import mock

        from gameofailife import social
        sim = make_world(SEEDS[0], N)
        f = sim.folk
        real_send, real_pick = folk.send_to, social.pick_companion
        bad, picks, resent, sent = [], [], [], []

        def send_to(sim_, p, place_id, activity, minutes):
            was = p.i in f.sent
            ok = real_send(sim_, p, place_id, activity, minutes)
            if ok and activity != folk.WARD:
                sent.append(p.id)
                if was:
                    resent.append((sim_.clock.tick, p.id, place_id))
            return ok

        def pick(sim_, p, why):
            q = real_pick(sim_, p, why)
            if q is not None:
                picks.append(q.id)
                if q.i in f.sent or q.activity in ("work", "school", "sleep") or q.trip is not None and \
                        q.trip.then in ("work", "school", "sleep"):
                    bad.append((sim_.clock.tick, q.id, q.activity))
            return q

        with mock.patch.object(folk, "send_to", send_to), mock.patch.object(social, "pick_companion", pick):
            for _ in range(DAY):
                sim.step()
        self.assertGreater(len(picks), 0)
        self.assertGreater(len(sent), 0)
        self.assertEqual(bad[:5], [])
        self.assertEqual(resent[:5], [])


class GroceriesAndHealthTest(unittest.TestCase):
    """Nobody with money starves: a household with no grocer in reach (no market or grocer's within FAV_WALK on
    foot, or FAV_CAR by car) orders its groceries in for DELIVERY_FEE more. Health heals as a named's does (every
    need above WELL_ABOVE) up to life.max_health, hunger at 0 costs HUNGER_HEALTH a minute, both in closed form; and
    a townsperson whose health runs out while fed collapses rather than starves."""

    def test_no_grocer_in_reach_orders_in(self):
        sim = make_world(SEEDS[0], N)
        f = sim.folk
        now = sim.clock.tick
        far = [p for p in f.living() if p.age >= 18 and not f._grocer_in_reach(p)]
        near = [p for p in f.living() if p.age >= 18 and f._grocer_in_reach(p)]
        self.assertTrue(far and near)
        p, q = far[0], near[0]
        for r in (p, q):
            f.hh_of(r).groceries = 0
        for kind in ("after_work", "day_off"):
            opt = f.options(sim, p, now, kind)[1]
            self.assertEqual((opt.activity, opt.place, opt.cost),
                             ("order_groceries", f.home_place(p), folk.GROCERY_COST + folk.DELIVERY_FEE))
            self.assertEqual(f.options(sim, q, now, kind)[1].activity, "buy_groceries")
        hh = f.hh_of(p)
        purse = p.money
        f._play(sim, p, now, f.options(sim, p, now, "day_off")[1])
        self.assertEqual(hh.groceries, folk.GROCERY_MEALS)
        self.assertAlmostEqual(p.money, purse - folk.GROCERY_COST - folk.DELIVERY_FEE)
        self.assertEqual((p.activity, p.inside), ("order_groceries", f.home_place(p)))
        self.assertIsNone(p.trip)

    def test_health_heals_and_hunger_costs(self):
        from gameofailife import folk_model, life

        def person(age=40, health=50.0, hunger=90.0):
            q = Person(0, "Test Person", age, "f", 0)
            q._needs = {n: 90.0 for n in agent.NEEDS}
            q._needs["hunger"] = hunger
            q._nt, q.activity, q.state, q.health = 0, "relax_home", "busy", health
            return q

        q = person()
        q.settle(100)
        self.assertAlmostEqual(q.health, 50.0 + folk_model.HEAL * 100)
        pieces = person()
        for t in range(10, 101, 10):
            pieces.settle(t)
        self.assertAlmostEqual(pieces.health, q.health, places=9)
        for n in agent.NEEDS:
            self.assertAlmostEqual(pieces._needs[n], q._needs[n], places=9)
        rate = agent.NEED_DECAY["hunger"]
        q = person(hunger=60.0)  # heals until hunger is down to WELL_ABOVE, then not
        q.settle(400)
        self.assertAlmostEqual(q.health, 50.0 + folk_model.HEAL * (60.0 - folk_model.WELL_ABOVE) / rate)
        q = person(hunger=0.9)  # 10 minutes to empty, then 100 starving
        q.settle(110)
        self.assertAlmostEqual(q.health, 50.0 - folk_model.HUNGER_HEALTH * (110 - 0.9 / rate))
        old = person(age=80, health=79.9)
        old.settle(1000)
        self.assertAlmostEqual(old.health, life.max_health(old))
        baby = person(age=2, hunger=10.0)  # held at 75 by folk.py: always well
        baby.settle(100)
        self.assertAlmostEqual(baby.health, 50.0 + folk_model.HEAL * 100)

    def test_off_sick_they_rest_and_eat_at_home(self):
        if not integrated():
            self.skipTest("needs life's conditions")
        from gameofailife import life
        sim = make_world(SEEDS[0], 200)
        f = sim.folk
        p = next(q for q in f.living() if q.age >= 18 and q.job is not None and q.job.hourly_wage > 0
                 and q.job.workdays[:3] == (0, 1, 2) and q.life is not None)
        home = f.home_place(p)
        t = sim.clock.tick
        p.life.conditions.append(life.Condition("flu", t, t + 6 * DAY, t + 3 * DAY, t, 20))
        meals, acts, low = Counter(), Counter(), 100.0
        last = None
        for _ in range(3 * DAY):
            sim.step()
            if p.activity != last:
                last = p.activity
                acts[last] += 1
                if last == "eat_home":
                    meals[sim.clock.tick // DAY] += 1
            self.assertIn(p.inside, (home, None))
            low = min(low, p.needs["hunger"])
        self.assertTrue(p.alive)
        self.assertNotIn("work", acts)
        self.assertGreater(acts["sick_home"], 0)
        self.assertEqual([meals[d] >= 3 for d in range(3)], [True] * 3, meals)  # breakfast, lunch, dinner
        self.assertGreater(low, 0.0)

    def test_collapse_is_not_starving(self):
        if not integrated():
            self.skipTest("needs life.die")
        sim = make_world(SEEDS[0], 200)
        f = sim.folk
        now = sim.clock.tick
        fed, hungry = [p for p in f.living() if p.age >= 18][:2]
        for p, hunger in ((fed, 80.0), (hungry, 0.0)):
            f.settle(p, now)
            p._needs["hunger"] = hunger
            p.health = 0.0
        f.step(sim, fed, now)
        self.assertFalse(fed.alive)
        self.assertEqual(fed.died["how"], "collapsed and could not be saved")
        self.assertEqual(f.counters["starved"], 0)
        f.step(sim, hungry, now)
        self.assertEqual(hungry.died["how"], "starved")
        self.assertEqual(f.counters["starved"], 1)


if __name__ == "__main__":
    unittest.main()
