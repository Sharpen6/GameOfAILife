"""Package D: the fixes from the 2-hour run of v2 (how the 60 named decide and spend their days), one class per item.

Measured on 14-day runs of seeds 1, 2 and 3 with all 60 played by a fake controller answering every fork in 3 s at
speed 8 (before -> after package D):
- routine share of the log (outcome lines / all lines): 0.770 / 0.776 / 0.745 -> 0.558 / 0.597 / 0.603
- first meetings more than 3 tiles apart: 69 of 71 / 75 of 81 / 84 of 90 -> 2 of 35 / 1 of 39 / 3 of 31
- workers at work at the first minute of their shift: 16 / 20 / 20 of 534 -> 519 / 518 / 518 of 534 (529 / 528 /
  528 counting the park's outdoor jobs)
- family dinners out outside Saturday 17:00-20:00: 24 of 24 / 23 of 23 / 9 of 9 -> 0 of 4 / 0 of 5 / 0 of 7
"""

from __future__ import annotations

import collections
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife.clock import MINUTES_PER_DAY, TICKS_PER_REAL_SECOND
from gameofailife import forks
from gameofailife.sim import Simulation

SPEED = 8  # the 2-hour run's speed: a game day in about 79 seconds


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class Played:
    """A city whose characters are all played by a fake controller that answers each fork `seconds` after it is
    asked, at SPEED, with `pick(msg)` (the profile's favourite by default)."""

    def __init__(self, seed: int = 1, seconds: float = 3.0, pick=None, ids=None):
        self.clock = FakeClock()
        self.sim = Simulation(seed, now=self.clock)
        self.seconds = seconds
        self.pick = pick or (lambda msg: msg["profile_scores"].index(max(msg["profile_scores"])))
        for a in self.sim.agents.values():
            if ids is None or a.id in ids:
                self.sim.claim(a.id, "fake")
        self.due: list[tuple[float, str, int]] = []
        self.events: list[dict] = []
        self.forks: dict[str, dict] = {}
        self.asked: dict[str, dict] = {}
        self.on_minute = []  # callbacks run after every tick

    def run(self, minutes: int) -> None:
        sim = self.sim
        for _ in range(minutes):
            self.clock.t += 1 / (TICKS_PER_REAL_SECOND * SPEED)
            for d in [d for d in self.due if d[0] <= self.clock.t]:
                self.due.remove(d)
                sim.answer(d[1], d[2], "because", "fake")
            sim.step()
            for f in self.on_minute:
                f(sim)
            events, forks, outbox = sim.drain()
            self.events += events
            for f in forks:
                self.forks[f["id"]] = f
            for _, msg in outbox:
                if msg["type"] == "fork":
                    self.asked[msg["fork_id"]] = msg
                    self.due.append((self.clock.t + self.seconds, msg["fork_id"], self.pick(msg)))


class OnTimeCount:
    """Counts, at each shift's first minute, who is at work."""

    def __init__(self):
        self.scheduled = self.present = 0

    def __call__(self, sim):
        m = sim.clock.minute_of_day
        for a in sim.living():
            j = a.job
            if j and sim.clock.weekday in j.workdays and m == j.start_hour * 60:
                self.scheduled += 1
                if a.state == "busy" and a.activity == "work" and a.activity_place == j.place_id:
                    self.present += 1


class ThinkFreeze(unittest.TestCase):
    """Item 1: a character whose controller is thinking sets off for work the usual way at once."""

    def test_three_second_answers_at_speed_8_get_workers_in_on_time(self):
        city = Played(seed=1, seconds=3.0)
        count = OnTimeCount()
        city.on_minute.append(count)
        city.run(2 * MINUTES_PER_DAY)
        self.assertGreater(count.scheduled, 60)
        self.assertGreaterEqual(count.present / count.scheduled, 0.9, (count.present, count.scheduled))

    def test_a_slow_coffee_is_played_as_the_fastest_way_still_on_time(self):
        city = Played(seed=1, seconds=3.0, pick=lambda msg: 2 if msg["kind"] == "work" else 0)
        count = OnTimeCount()
        city.on_minute.append(count)
        city.run(MINUTES_PER_DAY)
        work = [f for f in city.forks.values() if f["kind"] == "work" and f["decided_by"] == "model"]
        self.assertTrue(work)
        swapped = [f for f in work if f["choice"] != 2]
        self.assertTrue(swapped, "some coffee answers came too late to play")
        for f in swapped:
            self.assertIn("instead", f["reason"])
        self.assertGreaterEqual(count.present / count.scheduled, 0.85, (count.present, count.scheduled))

    def test_outcomes_are_rolled_once_for_the_option_played(self):
        city = Played(seed=1, seconds=3.0)
        city.run(MINUTES_PER_DAY)
        work = {f["id"]: f for f in city.forks.values() if f["kind"] == "work" and f["decided_by"] == "model"}
        rolled = collections.Counter(e["what"].split(":")[0] for e in city.sim.luck_log if e["what"].split(":")[0] in work)
        self.assertTrue(rolled)
        for fid, n in rolled.items():
            self.assertLessEqual(n, 3, fid)  # one option's outcomes (at most three), never two options'

    def test_the_character_moves_while_asked(self):
        city = Played(seed=1, seconds=4.5)
        moved = []

        def watch(sim):
            for fid, msg in city.asked.items():
                a = sim.agents[msg["agent_id"]]
                if msg["kind"] == "work" and sim.forks.get(fid) and sim.forks[fid].status == "asked":
                    moved.append(a.state)
        city.on_minute.append(watch)
        city.run(MINUTES_PER_DAY // 2)
        self.assertIn("travelling", moved)

    def test_waiting_forks_other_than_work_still_stand_and_wait(self):
        city = Played(seed=1, seconds=4.5)
        states = collections.Counter()

        def watch(sim):
            for fid, fork in sim.forks.items():
                if fork.status == "asked" and fork.kind != "work":
                    states[sim.agents[fork.agent_id].state] += 1
        city.on_minute.append(watch)
        city.run(MINUTES_PER_DAY)
        self.assertEqual(set(states), {"deciding"})

    def watch_answers_at_work(self, pick):
        """Plays two days with 4.9 s answers (about 78 game minutes at speed 8, often after the shift began) and
        returns, for each work fork answered by someone already at work on the set-off plan, (option played, the
        provisional option, whether it goes to work, money gained by the decision)."""
        city = Played(seed=1, seconds=4.9, pick=pick)
        sim = city.sim
        seen = []
        orig = sim._decide

        def decide(agent, fork, choice, by, reason):
            at_work = (getattr(agent, "thinking", None) == fork.id and agent.state == "busy"
                       and agent.activity == "work")
            before = agent.money
            orig(agent, fork, choice, by, reason)
            if at_work:
                goes = any(s[0] == "work" for s in fork.options[fork.choice].steps)
                seen.append((fork.choice, getattr(agent, "provisional", 0), goes, agent.money - before))
        sim._decide = decide
        city.run(2 * MINUTES_PER_DAY)
        return seen

    def test_an_answer_landing_after_arrival_keeps_the_shift_going(self):
        # More than WORK_LATE after the shift's start the answer was once played as given: a coffee or breakfast
        # at home took a worker off the job, unpaid, and a walk restarted the shift.
        seen = self.watch_answers_at_work(lambda msg: 1 if msg["kind"] == "work" else
                                          msg["profile_scores"].index(max(msg["profile_scores"])))
        self.assertTrue(seen, "no answer landed after the worker got in")
        for played, prov, goes, _ in seen:
            if goes:
                self.assertEqual(played, prov)

    def test_calling_in_sick_after_arrival_pays_the_minutes_worked(self):
        def sick(msg):
            if msg["kind"] != "work":
                return msg["profile_scores"].index(max(msg["profile_scores"]))
            return next((i for i, o in enumerate(msg["options"]) if o["label"].startswith("Call in sick")), 0)
        skips = [s for s in self.watch_answers_at_work(sick) if not s[2]]
        self.assertTrue(skips, "nobody called in sick after getting in")
        for _, _, _, gained in skips:
            self.assertGreater(gained, 0)


PAIRS = [("Sleeps deeply", "Lies awake for hours"), ("Makes a really tasty meal", "Burns the food"),
         ("Properly unwinds", "Gets restless and bored"), ("A peaceful evening", "Feels lonely"),
         ("A lovely long talk", "The call turns into an argument"), ("Gets some warm replies", "No reply comes"),
         ("Gets a warm reply", "No reply comes"), ("Has a great time together", "Conversation feels awkward"),
         ("Arrives late", "Arrives buzzing with energy"), ("The boss is annoyed", "A lovely lazy day"),
         ("The teacher calls home", "A lovely lazy day"), ("A warm family evening", "An argument at the table"),
         ("Everyone loves the feast", "The delivery is very late"), ("A cosy night in", "The delivery is very late"),
         ("Loves the purchase", "Regrets the spending"), ("Makes a breakthrough", "Gets stuck and frustrated")]


class Month:
    """Thirty seeded days of the city with nobody playing, shared by the classes that read them."""
    _run = None

    @classmethod
    def get(cls):
        if cls._run is None:
            sim = Simulation(1)
            events, forks, met = [], {}, []
            meet = sim._meet_someone

            def watched(agent, pool=None):  # a meeting drawn from the people about (housing's neighbours have a pool)
                other = meet(agent, pool)
                if other is not None and pool is None:
                    met.append((agent.inside is not None and agent.inside == other.inside) or (
                        agent.inside is None and other.inside is None
                        and max(abs(agent.x - other.x), abs(agent.y - other.y)) <= 3))
                return other
            sim._meet_someone = watched
            dinners, weekend_sleep = [], collections.Counter()
            for _ in range(30 * MINUTES_PER_DAY):
                sim.step()
                ev, fl, _ = sim.drain()
                for e in ev:
                    if e["tag"] == "family_dinner":  # who is left at home as the family goes out
                        host = sim.agents[e["agent"]]
                        home = sim.home_of(host)
                        hh = [sim.agents[m] for m in sim.household(host).member_ids if m != host.id]
                        adults_home = [o for o in hh if o.is_adult and o.id not in e["agents"] and o.inside == home]
                        alone = [o.id for o in hh if o.age < 10 and o.id not in e["agents"] and not adults_home]
                        dinners.append((e, alone))
                if sim.clock.minute_of_day == 8 * 60:
                    asleep = sum(1 for a in sim.living() if a.activity == "sleep")
                    weekend_sleep["weekend" if sim.clock.weekday in (5, 6) else "weekday"] += asleep
                events += ev
                for f in fl:
                    forks[f["id"]] = f
            cls._run = (sim, events, forks, met)
            cls.dinners, cls.weekend_sleep = dinners, weekend_sleep
        return cls._run


class OppositeOutcomes(unittest.TestCase):
    """Item 2: an option never logs both outcomes of an opposed pair."""

    def test_no_decision_in_30_days_logs_both_of_a_pair(self):
        _, _, forks, _ = Month.get()
        both = [(f["id"], a, b) for f in forks.values() for a, b in PAIRS
                if a in f["happened"] and b in f["happened"]]
        self.assertEqual(both, [])
        self.assertTrue(any(f["happened"] for f in forks.values()))


class NearbyMeetings(unittest.TestCase):
    """Item 3: first meetings only with people right there, in one line."""

    def test_every_first_meeting_is_nearby(self):
        _, events, _, met = Month.get()
        self.assertGreater(len(met), 10)
        self.assertTrue(all(met))

    def test_no_meets_someone_new_echo(self):
        _, events, _, _ = Month.get()
        self.assertFalse([e for e in events if "Meets someone new" in e["text"]])

    def test_nobody_nearby_means_nothing_happens(self):
        sim = Simulation(1)
        a = sim.agents["dana"]
        home = sim.home_of(a)
        a.inside = home
        for other in sim.agents.values():
            if other is not a and other.inside == home:
                other.inside = "hospital"
        self.assertIsNone(sim._meet_someone(a))
        self.assertFalse([e for e in sim.events if e["tag"] == "first_meet"])


def at(sim: Simulation, day: int, hour: int, minute: int = 0) -> None:
    sim.clock.tick = day * MINUTES_PER_DAY + hour * 60 + minute


class LonelyFork(unittest.TestCase):
    """Item 4: no calls across the hall, time with a housemate instead, children play, a named friend on the walk,
    and a longer wait after a choice that does not help."""

    def lonely(self, sim, aid, day=6, hour=11):
        at(sim, day, hour)
        a = sim.agents[aid]
        a.needs["social"] = 10
        a.inside = sim.home_of(a)
        return forks.lonely_fork(sim, a)

    def test_nobody_phones_a_housemate(self):
        sim = Simulation(1)
        calls = 0
        for aid, a in sim.agents.items():
            fork = self.lonely(sim, aid)
            if not fork:
                continue
            self.assertEqual(len(fork.options), 4)
            for o in fork.options:
                if "call" in o.extra:
                    calls += 1
                    self.assertNotIn(o.extra["call"], sim.household(a).member_ids, (aid, o.label))
        self.assertGreater(calls, 5)

    def test_time_with_a_housemate_at_home(self):
        sim = Simulation(1)
        fork = self.lonely(sim, "dana", hour=18)
        together = [o for o in fork.options if "together" in o.extra]
        self.assertEqual(len(together), 1)
        mate = sim.agents[together[0].extra["together"]]
        self.assertIn(mate.id, sim.household(sim.agents["dana"]).member_ids)
        self.assertEqual(together[0].label, f"Spend the evening with {mate.name.split()[0]}")
        sim._decide(sim.agents["dana"], fork, fork.options.index(together[0]), "model", "")
        self.assertEqual(mate.plan, [("board_game", "home")])

    def test_children_play(self):
        sim = Simulation(1)
        kids = [a for a in sim.agents.values() if not a.is_adult and a.age >= 6]
        for kid in kids:
            kid.money = 100.0
            fork = self.lonely(sim, kid.id, hour=15)
            if fork:
                self.assertEqual(fork.options[0].steps[0][0], "play", fork.options[0].label)

    def test_a_friend_is_named_on_the_walk(self):
        sim = Simulation(1)
        fork = self.lonely(sim, "tom", hour=10)
        walk = [o for o in fork.options if o.steps[0][0] == "walk_park"][0]
        if "invite_to" in walk.extra:
            self.assertIn(sim.agents[walk.extra["invite_to"]].name.split()[0], walk.label)
        named = 0
        for aid, a in sim.agents.items():
            f = self.lonely(sim, aid, hour=10)
            named += bool(f and any(o.steps[0][0] == "walk_park" and "invite_to" in o.extra for o in f.options))
        self.assertGreater(named, 3)

    def test_longer_wait_after_staying_home_alone(self):
        sim = Simulation(1)
        ari = sim.agents["ari"]  # lives alone
        fork = self.lonely(sim, "ari")
        alone = [i for i, o in enumerate(fork.options) if o.label == "Stay home alone"][0]
        sim._decide(ari, fork, alone, "model", "")
        self.assertEqual(ari.cooldowns["lonely"], sim.clock.tick + forks.LONELY_IDLE_COOLDOWN)


class FamilyDinner(unittest.TestCase):
    """Item 5: family dinners out on Saturday evenings only, naming who comes, never leaving a small child alone."""

    def test_only_on_saturday_evening_naming_who_comes(self):
        Month.get()
        self.assertTrue(Month.dinners)
        for e, alone in Month.dinners:
            _, _, weekday, hm = e["time"].split()
            self.assertEqual(weekday, "Sat", e["text"])
            self.assertTrue(forks.DINNER_FROM * 60 <= int(hm[:2]) * 60 + int(hm[3:]) <= forks.DINNER_UNTIL * 60, e)
            self.assertNotIn("the family", e["text"])
            self.assertEqual(alone, [], e["text"])

    def test_payday_on_friday_offers_no_dinner_out(self):
        sim = Simulation(1)
        at(sim, 4, 18)
        dana = sim.agents["dana"]
        dana.money = 500.0
        fork = forks.payday_fork(sim, dana)
        self.assertFalse([o for o in fork.options if o.extra.get("family")])

    def test_no_dinner_out_while_a_small_child_would_be_left(self):
        sim = Simulation(1)
        at(sim, 5, 17, 30)
        small = [a for a in sim.agents.values() if a.age < 10]
        self.assertTrue(small)
        kid = small[0]
        parent = next(sim.agents[m] for m in sim.household(kid).member_ids if sim.agents[m].is_adult)
        kid.state, kid.activity = "busy", "sleep"  # not free to come
        for m in sim.household(kid).member_ids:
            o = sim.agents[m]
            if o is not kid and o is not parent:
                o.inside = None  # the other adults are out
        self.assertIsNone(forks._dinner_party(sim, parent))


class WakeAndBedtime(unittest.TestCase):
    """Item 6: a lie-in before a day off, and later bedtimes on Friday and Saturday."""

    def test_people_lie_in_at_the_weekend(self):
        Month.get()
        self.assertGreater(Month.weekend_sleep["weekend"] / 8, 3 * Month.weekend_sleep["weekday"] / 22 + 5)

    def test_bedtime_is_later_on_friday(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        tom.needs["energy"] = 50
        at(sim, 2, 22, 30)
        self.assertIsNotNone(forks.sleep_fork(sim, tom))
        at(sim, 4, 22, 30)
        self.assertIsNone(forks.sleep_fork(sim, tom))
        at(sim, 4, 23, 59)
        self.assertIsNotNone(forks.sleep_fork(sim, tom))


class IdleDaysOff(unittest.TestCase):
    """Item 7: hours idle at home open the free-time fork, and fun drains faster while idle."""

    def test_idle_hours_open_free_time(self):
        sim = Simulation(1)
        at(sim, 6, 11)
        dana = sim.agents["dana"]
        dana.inside, dana.needs["fun"] = sim.home_of(dana), 70
        self.assertIsNone(forks.free_time_fork(sim, dana))
        dana.idle_home = forks.IDLE_HOME + forks.IDLE_SPREAD
        self.assertIsNotNone(forks.free_time_fork(sim, dana))

    def test_fun_drains_faster_idle(self):
        sim = Simulation(1)
        a, b = sim.agents["dana"], sim.agents["tom"]
        for x in (a, b):
            x.needs["fun"] = 80.0
        a.state, a.activity = "busy", "idle"
        b.state, b.activity = "busy", "read"
        sim._decay(a)
        sim._decay(b)
        self.assertLess(a.needs["fun"], b.needs["fun"])


class Rain(unittest.TestCase):
    """Item 8: outdoor options lose ground in the rain, more in winter."""

    def test_rain_penalty(self):
        sim = Simulation(1)
        at(sim, 2, 11)
        tom = sim.agents["tom"]
        tom.needs["fun"] = 10
        fork = forks.free_time_fork(sim, tom)
        walk = [i for i, o in enumerate(fork.options) if o.steps[0][0] == "walk_park"][0]
        sim.weather = "clear"
        dry = forks.default_scores(tom, fork, sim)
        sim.weather = "rain"
        wet = forks.default_scores(tom, fork, sim)
        self.assertAlmostEqual(dry[walk] - wet[walk], forks.RAIN_PENALTY[sim.clock.season], places=2)
        self.assertEqual([d for i, d in enumerate(dry) if i != walk], [w for i, w in enumerate(wet) if i != walk])
        self.assertGreater(forks.RAIN_PENALTY["winter"], forks.RAIN_PENALTY["summer"])


class SavingsGoals(unittest.TestCase):
    """Item 9: "Buy <goal> now" when the cash covers it."""

    def test_buy_the_goal(self):
        sim = Simulation(1)
        at(sim, 4, 18)
        ari = sim.agents["ari"]
        target = ari.goal["target"]
        money = ari.money
        fork = forks.payday_fork(sim, ari)
        self.assertEqual(fork.options[0].label, f"Buy {ari.goal['name']} now")
        sim._decide(ari, fork, 0, "model", "")
        self.assertIsNone(ari.goal)
        self.assertEqual(ari.money, money - target)
        self.assertTrue([e for e in sim.events if e["tag"] == "goal_reached"])


class Invites(unittest.TestCase):
    """Item 10: ignoring an invite is the worst manners, and the host learns the answer."""

    def test_bases_and_host_memory(self):
        sim = Simulation(1)
        at(sim, 6, 11)
        tom, ari = sim.agents["tom"], sim.agents["ari"]
        sim.invite(tom, "ari", "cafe")
        fork = forks.invite_fork(sim, ari)
        bases = {o.extra["answer"]: o.base for o in fork.options}
        self.assertLess(bases["ignore"], 0)
        self.assertGreater(bases["decline"], 0)
        sim._decide(ari, fork, [o.extra["answer"] for o in fork.options].index("decline"), "model", "")
        self.assertIn("Ari declines my invite to", tom.memory[-1])

    def test_a_friend_asked_on_a_walk_comes_along(self):
        # The lonely fork's "Ask <friend> to walk in <park>": the invite once lapsed within a minute, as a walk was
        # not an activity an invite meets at, so the friend never saw it.
        sim = Simulation(1)
        statuses = collections.Counter()
        together = set()
        for _ in range(14 * MINUTES_PER_DAY):
            sim.step()
            for inv in sim.invites.values():
                host, guest = sim.agents[inv["from"]], sim.agents[inv["to"]]
                if not host.is_adult or sim.town.places[inv["place"]].kind != "park":
                    continue
                statuses[inv["id"], inv["status"]] += 1
                if (inv["status"] == "accept" and host.activity == guest.activity == "walk_park"
                        and host.activity_place == guest.activity_place == inv["place"]
                        and host.state == guest.state == "busy"):
                    together.add(inv["id"])
            if together:
                break
        self.assertTrue(together, sorted(statuses))


class ScheduleLine(unittest.TestCase):
    """Item 11: the fork message says what today holds, and no free-time or lonely fork opens in the work window."""

    def test_today_line(self):
        sim = Simulation(1)
        dana = sim.agents["dana"]
        job = dana.job
        day = min(job.workdays)
        hours = f"{job.start_hour:02d}:00-{job.end_hour:02d}:00"
        at(sim, day, job.start_hour - 1, 14)
        self.assertEqual(forks.today_line(sim, dana), f"work {hours} (in 46 min)")
        off = next(d for d in range(7) if d not in job.workdays)
        at(sim, off, 11)
        nxt = next(d for d in range(1, 8) if (off + d) % 7 in job.workdays)
        label = "tomorrow" if nxt == 1 else ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[(off + nxt) % 7]
        self.assertEqual(forks.today_line(sim, dana), f"Day off; next shift {label} {job.start_hour:02d}:00")
        fork = forks.sleep_fork(sim, dana) or forks.free_time_fork(sim, dana) or forks.hunger_fork(sim, dana)
        dana.needs["hunger"] = 5
        fork = fork or forks.hunger_fork(sim, dana)
        msg = sim.fork_message(dana, fork)
        self.assertEqual(msg["you"]["today"], forks.today_line(sim, dana))
        from examples import claude_controller as cc
        self.assertIn(f"Today: Day off; next shift {label}", cc.decision_page(msg))
        kid = next(a for a in sim.agents.values() if not a.is_adult and a.job)
        self.assertTrue(forks.today_line(sim, kid).startswith(("Day off; next school", "school ")))

    def test_no_free_time_or_lonely_inside_the_work_window(self):
        sim = Simulation(1)
        checked = 0
        for a in sim.living():
            if not a.job or not a.is_adult:
                continue
            at(sim, min(a.job.workdays), a.job.start_hour, 0)
            sim.clock.tick -= forks.work_lead(sim, a) - 5
            a.inside, a.worked_today = sim.home_of(a), -1
            if not forks.in_work_window(sim, a):
                continue
            a.needs["social"], a.needs["fun"], a.idle_home = 5, 5, 10 ** 4
            self.assertIsNone(forks.lonely_fork(sim, a), a.id)
            self.assertIsNone(forks.free_time_fork(sim, a), a.id)
            checked += 1
        self.assertGreater(checked, 20)


def pupil_fork(sim, kid):
    at(sim, min(kid.job.workdays), kid.job.start_hour - 1, 20)
    kid.inside, kid.worked_today = sim.home_of(kid), -1
    (kid.x, kid.y) = sim.town.places[kid.inside].entry
    return forks.work_fork(sim, kid)


class ChildrensPages(unittest.TestCase):
    """Item 12: a pupil's page reads like school, offers no coffee, and says the family pays."""

    def test_no_coffee_for_pupils(self):
        sim = Simulation(1)
        kids = [a for a in sim.living() if not a.is_adult and a.job and a.job.hourly_wage == 0]
        self.assertGreater(len(kids), 5)
        for kid in kids:
            for minute in range(kid.job.start_hour * 60 - 60, kid.job.start_hour * 60 + 1, 5):
                at(sim, min(kid.job.workdays), 0, minute)
                kid.inside, kid.worked_today = sim.home_of(kid), -1
                fork = forks.work_fork(sim, kid)
                if fork is None:
                    continue
                slot = fork.options[2]
                self.assertNotIn("coffee", slot.label.lower(), (kid.id, slot.label))
                self.assertIn(slot.steps[0], [("coffee", "home"), ("snack", None)], kid.id)
                self.assertEqual(slot.cost if slot.steps[0][0] == "coffee" else 0, 0)

    def test_the_page_reads_like_school(self):
        from examples import claude_controller as cc
        sim = Simulation(1)
        kid = next(a for a in sim.living() if not a.is_adult and a.job and a.job.hourly_wage == 0)
        kid.money = 0.0
        fork = pupil_fork(sim, kid)
        msg = json.loads(json.dumps(sim.fork_message(kid, fork)))
        self.assertIsNotNone(msg["you"]["payer"])
        payer = sim._payer_for(kid, float("inf"))
        self.assertEqual(msg["you"]["payer"]["name"], payer.name)
        about = {"attributes": kid.attributes()}
        page = cc.decision_page(msg, about)
        self.assertIn(f"School {kid.job.start_hour}:00-{kid.job.end_hour}:00, doing well ", page)
        self.assertNotIn("Job:", page)
        self.assertNotIn("Standing at work", page)
        self.assertNotIn("at work", page.split("RIGHT NOW")[0])
        self.assertIn("your family pays", page)
        msg["options"][1]["cost"] = 2
        self.assertIn(f", which {payer.name.split()[0]} pays", cc.decision_page(msg, about))
        adult = sim.agents["dana"]
        self.assertIsNone(sim.fork_message(adult, fork)["you"]["payer"])


class ThenLines(unittest.TestCase):
    """Item 13: "Then:" rows come from the city's own record of each decision (keyed by fork id), habit marked."""

    def test_recent_comes_from_the_record(self):
        run = Played(1, seconds=3.0, ids={"dana"})
        run.run(MINUTES_PER_DAY + 600)
        dana = run.sim.agents["dana"]
        msg = list(run.asked.values())[-1]
        recent = msg["you"]["recent"]
        self.assertTrue(recent)
        record = {f["id"]: f for f in dana.forks}
        for r in recent:
            self.assertEqual(r["label"], record[r["id"]]["options"][record[r["id"]]["choice"]])
            self.assertEqual(r["by"], record[r["id"]]["decided_by"])
        self.assertTrue(any(r["happened"] for r in recent))

    def test_rows_and_habit(self):
        from examples import claude_controller as cc
        recent = [{"id": "f1", "time": "Day 2 Tue 07:10", "question": "How do you go?", "label": "Walk",
                   "by": "habit", "happened": ["Arrives late."]},
                  {"id": "f2", "time": "Day 2 Tue 18:00", "question": "You're hungry. What do you do?",
                   "label": "Cook at home", "by": "model", "happened": []}]
        self.assertEqual(cc.recent_decisions(recent), [
            "- 2 Tue 07:10: How do you go -> Walk (out of habit). Then: Arrives late.",
            "- 2 Tue 18:00: You're hungry. What do you do -> Cook at home. Then: nothing notable."])
        page = cc.decision_page({"question": "?", "options": [], "you": {"recent": recent}})
        self.assertIn("Walk (out of habit). Then: Arrives late.", page)


class Wording(unittest.TestCase):
    """Item 15: the way home on options at home, "really" before verbs, a daytime question when worn out."""

    def test_home_options(self):
        from examples import claude_controller as cc
        sim = Simulation(1)
        at(sim, 6, 11)
        tom = sim.agents["tom"]
        tom.needs["fun"] = 10
        tom.inside, (tom.x, tom.y) = None, sim.town.places["bakery"].entry
        fork = forks.free_time_fork(sim, tom)
        msg = sim.fork_message(tom, fork)
        relax = [o for o in msg["options"] if o["label"] == "Relax at home"][0]
        self.assertTrue(relax.get("home"))
        line = cc.option_line(relax, "a")
        self.assertNotIn("min away", line)
        if relax.get("travel_minutes") is not None:
            self.assertIn(f"home in {relax['travel_minutes']} min", line)
        self.assertTrue(all(not o.get("home") for o in msg["options"] if o["label"].startswith("Walk in")))

    def test_really_before_verbs(self):
        from examples import claude_controller as cc
        words = cc.personality({"social": 0.05, "thrift": 0.95, "diligence": 0.5})
        self.assertIn("really enjoys time alone", words)
        self.assertIn("very careful with money", words)
        self.assertNotIn("very enjoys", words)
        self.assertIn("works hard at school", cc.personality({"diligence": 0.75}, pupil=True))

    def test_a_daytime_question_when_worn_out(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        tom.needs["energy"] = 5
        tom.inside = sim.home_of(tom)
        at(sim, 6, 14)
        day = forks.sleep_fork(sim, tom)
        at(sim, 6, 23)
        night = forks.sleep_fork(sim, tom)
        self.assertNotIn("late", day.question)
        self.assertEqual(night.question, "It's late and you're tired. What now?")


class Arcade(unittest.TestCase):
    """Item 16: weekend free time can be a wander round the Arcade."""

    def test_buy_something_nice_at_the_weekend(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        tom.needs["fun"], tom.money = 10, 200.0
        tom.inside = sim.home_of(tom)
        at(sim, 5, 11)  # Saturday
        fork = forks.free_time_fork(sim, tom)
        nice = [o for o in fork.options if o.label.startswith("Buy something nice at")]
        self.assertEqual(len(nice), 1)
        self.assertEqual(sim.town.places[nice[0].steps[0][1]].kind, "shop")
        self.assertEqual(len({o.label for o in fork.options}), 4)
        at(sim, 2, 11)  # Wednesday
        self.assertFalse([o for o in forks.free_time_fork(sim, tom).options if o.label.startswith("Buy something")])


class TraitDrift(unittest.TestCase):
    """Item 17 (the call site): a choice teaches what sets it apart from the fork's other options, not its own tags."""

    def test_learning_is_relative_to_the_options(self):
        sim = Simulation(1)
        dana = sim.agents["dana"]
        opts = [forks.Option(f"Thrifty {i}", [("rest", "home")], tags={"thrift": 1.0, "social": 0.4 * i})
                for i in range(4)]
        fork = forks.Fork("dana", "test", "Which thrifty way?", opts, sim.clock.tick)
        before = dict(dana.profile.traits)
        sim._learn(dana, fork, 3, "")
        self.assertEqual(dana.profile.traits["thrift"], before["thrift"])  # all four were thrifty
        self.assertAlmostEqual(dana.profile.traits["social"], round(before["social"] + 0.04 * (1.2 - 0.6), 3))
        sim._learn(dana, fork, 0, "")
        self.assertLess(dana.profile.traits["social"], round(before["social"] + 0.04 * 0.6, 3))


class LogVariety(unittest.TestCase):
    """Item 14: common outcomes read several ways, routine good nights and meals stay out of the log (but in the
    decision's `happened`), a dinner out is one line, and a breakthrough is not always $50."""

    def test_the_month_reads_varied(self):
        from gameofailife import sim as sim_module
        _, events, forks, _ = Month.get()
        texts = [re.sub(r"^[^:]*: ", "", e["text"]) for e in events if e["tag"] in ("outcome", "money_swing")]
        for quiet in ("Sleeps deeply.", "Makes a really tasty meal.", "Properly unwinds.", "A warm family evening.",
                      "Everyone loves the feast.", "A cosy night in."):
            self.assertNotIn(quiet, texts)
        happened = collections.Counter(h for f in forks.values() for h in f["happened"])
        self.assertGreater(happened["Sleeps deeply"], 20)  # still came true, and the pages' "Then:" says so
        for oid, ways in sim_module.PHRASINGS.items():
            self.assertTrue(3 <= len(ways) <= 6, oid)
        seen = collections.Counter()
        for t in texts:
            for oid, ways in sim_module.PHRASINGS.items():
                if any(t.startswith(w) for w in ways):
                    seen[oid] += 1
        common = [oid for oid, n in seen.items() if n >= 20]
        self.assertTrue(common)
        for oid in common:
            used = {w for w in sim_module.PHRASINGS[oid] for t in texts if t.startswith(w)}
            self.assertGreaterEqual(len(used), 2, oid)
        tags = collections.Counter(e["tag"] for e in events)
        self.assertLess(tags["outcome"] / len(events), 0.68)  # 0.77 in the 2-hour run

    def test_breakthroughs_pay_varied_amounts(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        out = forks.Outcome("breakthrough", "Makes a breakthrough", 1.0, +1, {"fun": 15, "money": 50})
        fork = forks.Fork("tom", "free_time", "?", [forks.Option("x", [("rest", "home")])] * 4, sim.clock.tick)
        sim._decide(tom, fork, 0, "model", "")
        amounts = set()
        for _ in range(12):
            before = tom.money
            sim._apply_outcome(tom, {"fork": fork.id, "outcome": out, "due": None})
            amounts.add(tom.money - before)
        self.assertGreater(len(amounts), 4)
        self.assertTrue(all(20 <= a <= 120 for a in amounts))


def python_played(seed: int, days: int, dice: int, seconds: float) -> dict:
    """port/tools/parity_decisions.cjs in Python (the JS port's dice, through test_port's DiceSim)."""
    from tests.test_port import DiceSim

    clock = FakeClock()
    sim = DiceSim(seed, dice)
    sim.now = clock
    for a in sim.agents.values():
        sim.claim(a.id, "fake")
    due, asked = [], 0
    out = {"events": [], "forks": [], "hours": [], "asks": []}
    end = sim.clock.tick + days * MINUTES_PER_DAY
    while sim.clock.tick < end:
        clock.t += 1 / (TICKS_PER_REAL_SECOND * 8)
        for d in [d for d in due if d[0] <= clock.t]:
            due.remove(d)
            sim.answer(d[1], d[2], "because", "fake")
        sim.step()
        events, forks, outbox = sim.drain()
        out["events"] += [f"{e['tick']} {e['tag']} {e['text']}" for e in events]
        out["forks"] += [f"{f['tick']} {f['id']} {f['agent']} {f['kind']} {f['choice']} {f['decided_by']} {f['reason']} "
                         f"{'|'.join(f['happened'])}" for f in forks]
        for _, msg in outbox:
            if msg["type"] != "fork":
                continue
            you = msg["you"]
            out["asks"].append([sim.clock.tick, msg["agent_id"], msg["kind"], msg["question"], you["today"], you["payer"],
                                [[r["kind"], r["label"], r["by"], r["happened"]] for r in you["recent"]],
                                [[o.get("home", False), o.get("travel_minutes")] for o in msg["options"]]])
            s = msg["profile_scores"]
            pick = s.index(max(s))
            asked += 1
            if asked % 3 == 0:
                pick = (pick + 1) % 4
            due.append((clock.t + seconds, msg["fork_id"], pick))
        if sim.clock.minute_of_day % 60 == 0:
            out["hours"].append([sim.clock.tick, [[a.id, a.x, a.y, a.state, a.activity, a.inside, round(a.money, 2),
                                                   a.vehicle] for a in sim.agents.values()]])
    return out


@unittest.skipUnless(shutil.which("node"), "needs node")
class DecisionsParity(unittest.TestCase):
    """Every item lands in the JS port too: a played city lives the same week in both engines."""

    def test_a_played_week_in_lockstep(self):
        root = Path(__file__).resolve().parent.parent
        js = json.loads(subprocess.run(["node", str(root / "port/tools/parity_decisions.cjs"), "1", "7", "5", "3"],
                                       capture_output=True, text=True, check=True).stdout)
        py = python_played(1, 7, 5, 3.0)
        ids = lambda rows: [re.sub(r" f\d+ ", " f# ", r, count=1) for r in rows]  # noqa: E731
        for name, a, b in (("events", py["events"], js["events"]), ("forks", ids(py["forks"]), ids(js["forks"])),
                           ("hours", py["hours"], [json.loads(h) for h in js["hours"]]),
                           ("asks", json.loads(json.dumps(py["asks"])), [json.loads(h) for h in js["asks"]])):
            at = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            self.assertEqual(a[at:at + 1], b[at:at + 1], f"{name} differ first at #{at} (Python first)")
            self.assertEqual(len(a), len(b), name)
        self.assertTrue(any("instead" in f for f in py["forks"]))
        self.assertGreater(len(py["asks"]), 200)
        self.assertTrue(any(a[5] for a in py["asks"]))  # a child's payer


if __name__ == "__main__":
    unittest.main()
