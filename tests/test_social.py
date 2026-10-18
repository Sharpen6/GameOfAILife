"""Social life (social.py, life.md 5.1-5.4): rooms and talk, the romance ladder on scripted dice, home units, the
headline rule, the relationship cap, state.talks rows and townsfolk isolation."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import people, social, talk
from gameofailife.agent import RelationKind, Relationship
from gameofailife.rng import Rng
from gameofailife.sim import Simulation

DAY = 24 * 60
ACQ, FRIEND, DATING, PARTNER = (RelationKind.ACQUAINTANCE, RelationKind.FRIEND, RelationKind.DATING,
                                RelationKind.PARTNER)


class Script:
    """Scripted dice: random() returns the values in turn, over and over."""

    def __init__(self, *xs):
        self.xs, self.i = list(xs), 0

    def random(self):
        v = self.xs[self.i % len(self.xs)]
        self.i += 1
        return v


def eligible_pair(sim):
    """The first two named adults (by id) who may date, both with a LifeState."""
    named = sorted(sim.agents.values(), key=lambda a: a.id)
    for a in named:
        for b in named:
            if a.id < b.id and a.life is not None and b.life is not None and social.eligible(sim, a, b):
                return a, b
    raise AssertionError("no eligible pair")


def clear(*ps):
    for p in ps:
        p.life.pending.clear()
        p.life.cooldowns.clear()


class RomanceLadderTest(unittest.TestCase):
    """Flirting, the crush and asked_out forks, dating, moving in, the proposal and the wedding, in order."""

    def test_the_ladder(self):
        sim = Simulation(1)
        a, b = eligible_pair(sim)
        clear(a, b)
        cafe = next(pid for pid, k in sim.social.kind.items() if k == "cafe")
        people.set_rel(sim, a.id, b.id, ACQ, 25)
        t = sim.clock.tick
        with mock.patch.object(social, "chemistry", lambda sim_, x, y: 0.95):
            tones = [social.converse(sim, a, b, "cafe", cafe, t + i, Script(0.0)) for i in range(2)]
        self.assertEqual(tones, ["warm", "warm"])  # x = 0 is always warm
        ra, rb = a.relationships[b.id], b.relationships[a.id]
        self.assertGreaterEqual(ra.romance, social.ASK_ROMANCE)
        self.assertEqual(ra.romance, rb.romance)
        self.assertEqual([q["kind"] for q in a.life.pending], ["crush"])  # a named asker meets the crush fork
        self.assertEqual(a.life.pending[0]["ctx"], {"with": b.id})
        self.assertTrue(any(e["tag"] == "flirt" for e in sim.events))

        crush = people.PROMPTS["crush"](sim, a, {"with": b.id})
        ask = crush.options[0]
        people.HANDLERS["crush"](sim, a, crush, ask, ask.extra["life"])
        self.assertEqual([q["kind"] for q in b.life.pending], ["asked_out"])  # the named target is asked
        asked = people.PROMPTS["asked_out"](sim, b, {"with": a.id})
        yes = asked.options[0]
        self.assertEqual(yes.extra["life"]["act"], "yes")
        people.HANDLERS["asked_out"](sim, b, asked, yes, yes.extra["life"])
        self.assertEqual((ra.kind, rb.kind), (DATING, DATING))
        self.assertIn(sorted([a.id, b.id]), sim.social.couples)
        self.assertIs(social.partner_of(sim, a), b)
        self.assertFalse(social.eligible(sim, a, b))
        self.assertTrue(any(e["tag"] == "partner" and "going out" in e["text"] for e in sim.events))

        # 29 days on, romance 70 and affinity 60 both: moving in comes up (the .025 roll scripted to hit).
        lo, hi = (a, b) if a.id < b.id else (b, a)
        for r in (ra, rb):
            r.since, r.romance, r.affinity = t - 29 * DAY, 70.0, 60.0
        clear(a, b)
        with mock.patch.object(social.dice, "stream", lambda *args: Script(0.0)):
            social._dating_day(sim, lo, hi, lo.relationships[hi.id], hi.relationships[lo.id], sim.clock.day)
        asker = next(p for p in (a, b) if p.life.pending)
        other = b if asker is a else a
        self.assertEqual(asker.life.pending[0]["kind"], "move_in")
        fork = people.PROMPTS["move_in"](sim, asker, asker.life.pending[0]["ctx"])
        host = fork.options[0]
        self.assertEqual(host.extra["life"]["act"], "host")
        people.HANDLERS["move_in"](sim, asker, fork, host, host.extra["life"])
        self.assertEqual(other.household_id, asker.household_id)
        self.assertEqual((ra.kind, rb.kind), (PARTNER, PARTNER))
        self.assertIn(other.household_id, sim.households)
        for hh in sim.households.values():  # nobody left in an emptied household
            self.assertTrue(hh.member_ids)

        # The proposal: the named partner gets the proposal fork; yes means engaged, the wedding on a Saturday.
        clear(a, b)
        propose = people.PROMPTS["propose"](sim, asker, {"with": other.id})
        simple = propose.options[1]
        people.HANDLERS["propose"](sim, asker, propose, simple, simple.extra["life"])
        self.assertEqual(other.life.pending[0]["kind"], "proposal")
        proposal = people.PROMPTS["proposal"](sim, other, other.life.pending[0]["ctx"])
        people.HANDLERS["proposal"](sim, other, proposal, proposal.options[0], proposal.options[0].extra["life"])
        key = f"{lo.id}|{hi.id}"
        day = sim.social.engaged[key]
        self.assertEqual(day % 7, 5)
        self.assertGreaterEqual(day, sim.clock.day + 14)
        sim.clock.tick = day * DAY + social.WEDDING_HOUR * 60
        social._weddings(sim)
        self.assertTrue(ra.married and rb.married)
        self.assertNotIn(key, sim.social.engaged)
        self.assertTrue(any(e["tag"] == "wedding" for e in sim.events))

        # A split: exes, and the one who leaves goes through life.split.
        social.end_couple(sim, a, b)
        self.assertEqual((ra.kind, rb.kind), (RelationKind.EX, RelationKind.EX))
        self.assertFalse(ra.married or rb.married)
        self.assertNotIn(sorted([a.id, b.id]), sim.social.couples)
        self.assertFalse(social.eligible(sim, a, b))  # never back with an ex

    def test_no_chemistry_no_flirt(self):
        sim = Simulation(1)
        a, b = eligible_pair(sim)
        clear(a, b)
        people.set_rel(sim, a.id, b.id, ACQ, 25)
        cafe = next(pid for pid, k in sim.social.kind.items() if k == "cafe")
        with mock.patch.object(social, "chemistry", lambda sim_, x, y: 0.5):
            for i in range(10):
                social.converse(sim, a, b, "cafe", cafe, sim.clock.tick + i, Script(0.0))
        self.assertEqual(a.relationships[b.id].romance, 0.0)
        self.assertEqual(a.life.pending, [])

    def test_the_seeded_start(self):
        sim = Simulation(1)
        efrat, amir = sim.agents["efrat"], sim.agents["amir"]
        r = efrat.relationships["amir"]
        self.assertEqual((r.kind, r.romance, r.affinity), (DATING, 55.0, 50))
        self.assertEqual(sim.clock.tick - r.since, 20 * DAY)
        self.assertIs(social.partner_of(sim, amir), efrat)
        tom = sim.agents["tom"]
        crush = [r for r in tom.relationships.values() if r.romance == 32.0]
        self.assertEqual(len(crush), 1)
        self.assertEqual(crush[0].affinity, 25.0)
        for a in sim.agents.values():  # named couples sharing a surname start married
            for oid, r in a.relationships.items():
                b = sim.agents.get(oid)
                if r.kind is PARTNER and b is not None and a.name.split()[-1] == b.name.split()[-1]:
                    self.assertTrue(r.married)
        self.assertIn(["amir", "efrat"], sim.social.couples)


class HomeRoomsTest(unittest.TestCase):
    """A home unit is its own room: a couple in a flat (six units on one block) talks about as much as a couple
    in a house."""

    def evenings(self, sim, pairs, n=30):
        homes = {a.id: sim.homes[sim.households[a.household_id].home_id].place for a in sim.agents.values()}
        before = [p.relationships[q.id].talks for p, q in pairs]
        start = sim.clock.day + 1
        for d in range(start, start + n):
            for t in range(d * DAY + 17 * 60 + 1, d * DAY + 23 * 60):
                sim.clock.tick = t
                for a in sim.agents.values():  # everyone at home all evening
                    a.inside, a.activity, a.state = homes[a.id], "relax", "idle"
                    if a.life is not None:
                        a.life.talks_today = 0
                social.tick(sim)
        return [p.relationships[q.id].talks - n0 for (p, q), n0 in zip(pairs, before)]

    def test_flat_and_house_couples(self):
        sim = Simulation(1)
        ag = sim.agents
        self.assertEqual(sim.homes["cedar_court_1b"].place, "cedar_court")  # Eli and Shira: a flat
        self.assertEqual(sim.homes["main_29"].place, "main_29")  # Dalia and Ben: a house
        flat, house = self.evenings(sim, [(ag["eli"], ag["shira"]), (ag["dalia"], ag["ben"])])
        self.assertGreater(min(flat, house), 60)
        self.assertLessEqual(abs(flat - house) / max(flat, house), 0.30, (flat, house))

    def test_rooms_split_a_block_by_unit(self):
        sim = Simulation(1)
        ag = sim.agents
        group = [ag[x] for x in ("eli", "shira", "sivan", "karim", "hila")]
        group.append(ag["tom"])  # a visitor
        rooms = social._rooms(sim, "cedar_court", group)
        by_key = {parts: [p.id for p in room] for parts, cls, room in rooms}
        self.assertEqual(by_key[("cedar_court_1b",)][:2], ["eli", "shira"])
        self.assertEqual(by_key[("cedar_court_1a",)], ["sivan", "karim"])
        self.assertEqual(by_key[("cedar_court_3a",)], ["hila"])
        self.assertTrue(all(cls == "home" or parts[-1] == "block" for parts, cls, room in rooms))
        self.assertIn("tom", sum(by_key.values(), []))


class HeadlineTest(unittest.TestCase):
    def test_no_talk_quotes_the_richest(self):
        sim = Simulation(1)
        richest = "Dana Cohen is now the richest person in Millbrook."
        sim.event(richest, None, tag="richest", importance=2)
        self.assertEqual(sim.headlines[-1]["text"], richest)
        self.assertIsNone(social._headline(sim))
        a, b = sim.agents["dana"], sim.agents["tom"]
        if b.id not in a.relationships:
            people.set_rel(sim, a.id, b.id, ACQ, 10)
        ra = a.relationships[b.id]
        ctx = social.talk_ctx(sim, a, b, ra, "cafe", "cafe")
        self.assertIsNone(ctx["headline"])
        rng = Rng(5)
        for tone in talk.TONES:
            for _ in range(20):
                self.assertNotIn("richest", talk.line("news", tone, ctx, rng))
        sim.event("The river floods the park!", None, tag="other", importance=2)
        self.assertEqual(social._headline(sim), "The river floods the park!")
        sim.clock.tick += 3 * DAY
        self.assertIsNone(social._headline(sim))  # more than two days old

    def test_three_days_of_talk(self):
        sim = Simulation(2)
        for _ in range(3 * DAY):
            sim.step()
        rich = [e["text"] for e in sim.history if e["tag"] == "richest"]
        texts = [e["text"] for e in sim.history if e["tag"] == "talk"]
        texts += [t["text"] for a in sim.agents.values() if a.life for t in a.life.talks]
        self.assertGreater(len(texts), 50)
        for text in texts:
            self.assertLessEqual(len(text.split(": “", 1)[-1]), talk.MAX_LINE + 2)
            for r in rich:
                self.assertNotIn(r, text)
            self.assertNotIn("richest", text)
        for a in sim.agents.values():
            self.assertLessEqual(len(a.relationships), people.REL_CAP)
            self.assertLessEqual(len(a.life.talks), social.RING)
            for t in a.life.talks:
                self.assertEqual(set(t), {"time", "with", "name", "topic", "tone", "text", "place"})
        self.assertGreater(sim.social.counts["talks"], 60 * 3 * 3)


class CapTest(unittest.TestCase):
    def test_nobody_over_sixty(self):
        sim = Simulation(1)
        dana, tom, ari = sim.agents["dana"], sim.agents["tom"], sim.agents["ari"]
        for p in (dana, tom, ari):
            dana.relationships.pop(p.id, None)
            p.relationships.pop("dana", None)
        dana.relationships.clear()
        for i in range(people.REL_CAP):
            dana.relationships[f"x{i:02d}"] = Relationship(ACQ, 5.0, seen=100 + i)
        pair = social._ensure(sim, dana, tom, 500)
        self.assertIsNotNone(pair)
        self.assertEqual(len(dana.relationships), people.REL_CAP)
        self.assertNotIn("x00", dana.relationships)  # the acquaintance seen longest ago made room
        self.assertIn("tom", dana.relationships)
        for r in dana.relationships.values():
            r.kind = FRIEND
        self.assertIsNone(social._ensure(sim, dana, ari, 600))  # friends are never let go for a stranger
        self.assertIsNone(social.converse(sim, dana, ari, "cafe", "cafe", 600, Script(0.0)))
        self.assertNotIn("ari", dana.relationships)
        self.assertNotIn("dana", ari.relationships)
        self.assertEqual(len(dana.relationships), people.REL_CAP)
        for i in range(5):
            dana.relationships[f"y{i}"] = Relationship(ACQ, 1.0, seen=0)
        social._upkeep(sim, dana, 700)
        self.assertLessEqual(len(dana.relationships), people.REL_CAP)


class TalksJsonTest(unittest.TestCase):
    def test_rows(self):
        sim = Simulation(1)
        st = sim.social
        st.talks.clear()
        t = sim.clock.tick
        home = "main_20"
        cafe = next(pid for pid, k in st.kind.items() if k == "cafe")
        st.talks.append((t - 30, "dana", "tom", 1, cafe))  # too old
        st.talks.append((t - 5, "f1", "f2", 0, cafe))
        st.talks.append((t - 4, "f3", "f4", -1, cafe))  # the same place: only the newest folk row
        st.talks.append((t - 3, "dana", "f5", 1, home))
        st.talks.append((t - 2, "f6", "f7", 0, "nowhere"))  # a street: -1
        st.talks.append((t - 1, "yossi", "noa", 0, home))
        rows = social.talks_json(sim)
        idx = st.place_index
        self.assertEqual(rows, [[idx[home], "yossi", "noa", 0, t - 1], [idx[home], "dana", "f5", 1, t - 3],
                                [-1, "f6", "f7", 0, t - 2], [idx[cafe], "f3", "f4", -1, t - 4]])
        for i in range(45):
            st.talks.append((t, "dana", "yossi", 1, home))
        self.assertEqual(len(social.talks_json(sim)), social.TALKS_SHOWN)
        self.assertEqual(len(st.talks), 40)
        self.assertEqual(list(idx), list(sim.town.places))


class FolkRoomsTest(unittest.TestCase):
    """Townsfolk in the rooms of a region with folk: mixed, they meet the named; isolated, never."""

    def named_folk_ties(self, sim):
        return sum(1 for a in sim.agents.values() for oid in a.relationships if people.is_folk_id(oid))

    def run_day(self, isolated):
        sim = Simulation(1, world="region", folk=300, folk_isolated=isolated)
        ties = self.named_folk_ties(sim)
        for _ in range(DAY):
            sim.step()
        return sim, ties

    def test_mixed(self):
        sim, ties = self.run_day(False)
        self.assertGreater(self.named_folk_ties(sim), ties)
        folk_talks = sum(1 for p in sim.folk.living() for r in p.relationships.values() if r.talks)
        self.assertGreater(folk_talks, 300)
        for p in people.everyone(sim):
            self.assertLessEqual(len(p.relationships), people.REL_CAP)

    def test_isolated(self):
        sim, ties = self.run_day(True)
        self.assertEqual(self.named_folk_ties(sim), ties)
        self.assertGreater(sim.social.counts["talks"], 1000)  # their own rooms still run
        a = sim.agents["tom"]
        f = sim.folk.living()[0]
        self.assertFalse(social.eligible(sim, a, f))
        cafe = next(pid for pid, k in sim.social.kind.items() if k == "cafe")
        self.assertIsNone(social.invite_folk(sim, a, f.id, cafe))


NODE = os.environ.get("NODE") or shutil.which("node")
PARITY = Path(__file__).resolve().parent.parent / "port" / "tools" / "parity_social.cjs"
SOCIAL_TAGS = {"talk", "flirt", "new_friend", "falling_out", "rival", "row", "partner", "breakup", "divorce",
               "moved_in", "engaged", "wedding", "loan", "meetup", "invite", "invite_accepted", "invite_declined",
               "text"}


class MulberryDice:
    """port/src/sim.js's SimDice for the Python engine (as tests/test_port.py's)."""

    def __init__(self, seed: int):
        self.r = Rng((seed * 0x2545F491 + 0x6A09E667) & 0xFFFFFFFF)

    def random(self) -> float:
        return self.r.random()

    def uniform(self, a: float, b: float) -> float:
        return a + (b - a) * self.r.random()

    def randrange(self, a: int, b: int) -> int:
        return a + int(self.r.random() * (b - a))

    def choice(self, seq):
        return seq[int(self.r.random() * len(seq))]


class DiceSim(Simulation):
    """A Python Simulation rolling the JS port's dice, from the first weather roll on."""

    def __init__(self, seed: int, dice: int):
        self._dice = dice
        super().__init__(seed=seed, dice_seed=dice)

    def _roll_weather(self) -> None:
        if not isinstance(self.rng, MulberryDice):
            self.rng = MulberryDice(self._dice)
        super()._roll_weather()


def r6(x: float) -> float:
    return math.floor(x * 1e6 + 0.5) / 1e6


def snapshot(sim) -> dict:
    rels = []
    for a in sorted(sim.agents.values(), key=lambda x: x.id):
        for oid in sorted(a.relationships):
            r = a.relationships[oid]
            rels.append([a.id, oid, r.kind.value, r6(r.affinity), r6(r.trust), r6(r.romance), r.since, r.seen,
                         r.talks, r.married])
    st = sim.social
    return {
        "tick": sim.clock.tick, "counts": {k: st.counts[k] for k in sorted(st.counts)}, "rels": rels,
        "couples": sorted("|".join(c) for c in st.couples), "engaged": sorted([k, v] for k, v in st.engaged.items()),
        "pending": [[a.id, [q["kind"] for q in a.life.pending]] for a in sim.agents.values()
                    if a.life is not None and a.life.pending],
        "talks": social.talks_json(sim),
        "households": sorted([h.id, sorted(h.member_ids)] for h in sim.households.values()),
    }


def python_social(seed: int, days: int, dice: int) -> dict:
    sim = DiceSim(seed, dice)
    out = {"days": [], "events": []}
    for _ in range(days * DAY):
        sim.step()
        events, _, _ = sim.drain()
        out["events"] += [[e["tick"], e["tag"], e["text"]] for e in events if e["tag"] in SOCIAL_TAGS]
        if sim.clock.minute_of_day == 0:
            out["days"].append(snapshot(sim))
    return out


@unittest.skipUnless(NODE, "node is not installed")
class SocialParityTest(unittest.TestCase):
    """port/tools/parity_social.cjs: the 60 live eight days with social on, the same in both engines."""

    def test_eight_days(self):
        days = 8
        run = subprocess.run([NODE, str(PARITY), "1", str(days), "5"], capture_output=True, text=True, timeout=600)
        self.assertEqual(run.returncode, 0, run.stderr)
        js = json.loads(run.stdout)
        py = python_social(1, days, 5)
        a, b = py["events"], js["events"]
        at = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        self.assertEqual(a[at:at + 1], b[at:at + 1], f"social events differ first at #{at} (Python first)")
        self.assertEqual(len(a), len(b))
        self.assertEqual(len(py["days"]), days)
        for d, (got, want) in enumerate(zip(js["days"], py["days"]), 1):
            for key in want:
                self.assertEqual(got[key], want[key], f"day {d}: {key} differs (JS first)")
        last = py["days"][-1]
        self.assertGreater(last["counts"]["talks"], 60 * days * 3)
        self.assertGreater(len(py["events"]), 100)


if __name__ == "__main__":
    unittest.main()
