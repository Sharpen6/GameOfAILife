"""Package D: the fixes from the 2-hour run of v2 (how the 60 named decide and spend their days), one class per item."""

from __future__ import annotations

import collections
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife.clock import MINUTES_PER_DAY, TICKS_PER_REAL_SECOND
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
            for _ in range(30 * MINUTES_PER_DAY):
                sim.step()
                ev, fl, _ = sim.drain()
                events += ev
                for f in fl:
                    forks[f["id"]] = f
            cls._run = (sim, events, forks, met)
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


def python_played(seed: int, days: int, dice: int, seconds: float) -> dict:
    """port/tools/parity_decisions.cjs in Python (the JS port's dice, through test_port's DiceSim)."""
    from tests.test_port import DiceSim

    clock = FakeClock()
    sim = DiceSim(seed, dice)
    sim.now = clock
    for a in sim.agents.values():
        sim.claim(a.id, "fake")
    due, asked = [], 0
    out = {"events": [], "forks": [], "hours": []}
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
    """Every item lands in the JS port too: a played city lives the same two days in both engines."""

    def test_two_played_days_in_lockstep(self):
        root = Path(__file__).resolve().parent.parent
        js = json.loads(subprocess.run(["node", str(root / "port/tools/parity_decisions.cjs"), "1", "2", "5", "3"],
                                       capture_output=True, text=True, check=True).stdout)
        py = python_played(1, 2, 5, 3.0)
        ids = lambda rows: [re.sub(r" f\d+ ", " f# ", r, count=1) for r in rows]  # noqa: E731
        for name, a, b in (("events", py["events"], js["events"]), ("forks", ids(py["forks"]), ids(js["forks"])),
                           ("hours", py["hours"], [json.loads(h) for h in js["hours"]])):
            at = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            self.assertEqual(a[at:at + 1], b[at:at + 1], f"{name} differ first at #{at} (Python first)")
            self.assertEqual(len(a), len(b), name)
        self.assertTrue(any("instead" in f for f in py["forks"]))


if __name__ == "__main__":
    unittest.main()
