"""The eight social forks (social_forks.py, life.md 6): four distinct options each, major, an `about` with no
odds; what each choice does; the life_rel / life_rom outcome keys; and a queued prompt reaching the character as a
real fork in a running city."""

from __future__ import annotations

import unittest

from gameofailife import people, social, social_forks
from gameofailife.agent import RelationKind
from gameofailife.sim import Simulation

DAY = 24 * 60
ACQ, DATING, PARTNER, EX = (RelationKind.ACQUAINTANCE, RelationKind.DATING, RelationKind.PARTNER,
                            RelationKind.EX)


def pair(sim):
    named = sorted(sim.agents.values(), key=lambda a: a.id)
    for a in named:
        for b in named:
            if a.id < b.id and social.eligible(sim, a, b):
                a.life.pending.clear()
                b.life.pending.clear()
                return a, b
    raise AssertionError("no eligible pair")


def cafe_of(sim):
    return next(pid for pid, k in sim.social.kind.items() if k == "cafe")


class Setup:
    """Each kind's builder with a situation it accepts: (kind, relationship kind, extra fields, ctx extras)."""

    CASES = [
        ("crush", ACQ, {"romance": 35.0}, {}),
        ("asked_out", ACQ, {"romance": 30.0}, {}),
        ("date", DATING, {"romance": 50.0}, {"place": None}),
        ("move_in", DATING, {"romance": 70.0, "since": -40 * DAY}, {}),
        ("propose", PARTNER, {"romance": 75.0}, {}),
        ("proposal", PARTNER, {"romance": 75.0}, {}),
        ("relationship_trouble", DATING, {"romance": 30.0}, {}),
        ("partner_split", PARTNER, {"romance": 10.0}, {}),
        ("friend_in_need", RelationKind.FRIEND, {}, {"amount": 600}),
    ]

    @staticmethod
    def build(kind, rel_kind, fields, extra):
        sim = Simulation(1)
        a, b = pair(sim)
        people.set_rel(sim, a.id, b.id, rel_kind, 45, **fields)
        ctx = {"with": b.id}
        for k, v in extra.items():
            ctx[k] = cafe_of(sim) if k == "place" else v
        if kind == "friend_in_need":
            b.money = -600
        fork = people.PROMPTS[kind](sim, a, ctx)
        return sim, a, b, fork


class OptionsTest(unittest.TestCase):
    def test_four_distinct_options_each(self):
        self.assertEqual(set(social_forks.KINDS), set(people.PROMPTS) & set(social_forks.KINDS))
        for kind, rk, fields, extra in Setup.CASES:
            with self.subTest(kind=kind):
                sim, a, b, fork = Setup.build(kind, rk, fields, extra)
                self.assertIsNotNone(fork, kind)
                self.assertEqual(fork.kind, kind)
                self.assertEqual(len(fork.options), 4)
                labels = [o.label for o in fork.options]
                self.assertEqual(len(set(labels)), 4, labels)
                shapes = {(repr(o.extra), tuple(x.id for x in o.outcomes), o.cost, repr(o.steps)) for o in fork.options}
                self.assertEqual(len(shapes), 4, f"{kind}: two options do the same thing")
                self.assertTrue(fork.major)
                self.assertTrue(fork.about and fork.about[0].startswith(b.name))
                for text in labels + fork.about + [fork.question]:
                    self.assertNotIn("%", text)  # odds stay hidden
                    self.assertNotRegex(text, r"\b0\.\d")
                for o in fork.options:
                    life = o.extra.get("life")
                    if life is not None:
                        self.assertEqual(life["with"], b.id)
                        self.assertIn(life["act"], ACTS[kind])
                msg = sim.fork_message(a, fork) if hasattr(sim, "fork_message") else None
                if msg is not None:
                    self.assertEqual(len(msg["options"]), 4)

    def test_builders_decline_what_does_not_fit(self):
        sim = Simulation(1)
        a, b = pair(sim)
        self.assertIsNone(people.PROMPTS["date"](sim, a, {"with": b.id, "place": cafe_of(sim)}))  # not dating
        self.assertIsNone(people.PROMPTS["propose"](sim, a, {"with": b.id}))  # not partners
        self.assertIsNone(people.PROMPTS["crush"](sim, a, {"with": "nobody"}))
        self.assertIsNone(people.PROMPTS["friend_in_need"](sim, a, {"with": b.id, "amount": 300}))  # b is not short
        dana, yossi = sim.agents["dana"], sim.agents["yossi"]
        self.assertTrue(dana.relationships["yossi"].married)
        self.assertIsNone(people.PROMPTS["propose"](sim, dana, {"with": "yossi"}))  # already married
        self.assertIsNone(people.PROMPTS["crush"](sim, dana, {"with": "tom"}))  # she has a partner
        self.assertIsNotNone(yossi)


ACTS = {
    "crush": {"ask", "let_go"}, "asked_out": {"yes", "coffee", "friends", "flat"},
    "date": {"go", "later", "no", "end"}, "move_in": {"host", "join", "together", "wait"},
    "propose": {"propose", "wait", "never"}, "proposal": {"yes", "long", "not_yet", "no"},
    "relationship_trouble": {"space", "end"}, "partner_split": {"agree", "storm"},
    "friend_in_need": {"lend", "give", "no"},
}


class HandlersTest(unittest.TestCase):
    def choose(self, sim, a, fork, i):
        opt = fork.options[i]
        people.apply_extra(sim, a, fork, opt)
        return opt

    def test_friend_in_need(self):
        sim, a, b, fork = Setup.build("friend_in_need", RelationKind.FRIEND, {}, {"amount": 600})
        a.money = 2000.0
        self.assertFalse(fork.options[0].charge)  # the handler moves the money, once
        self.choose(sim, a, fork, 0)
        loans = sim.life.loans if getattr(sim.life, "loans", None) is not None else sim.social.loans
        row = loans[-1]
        self.assertEqual((row["lender"], row["borrower"], row["amount"]), (a.id, b.id, 600))
        self.assertEqual((a.money, b.money), (1400.0, 0.0))
        self.assertTrue(any(e["tag"] == "loan" for e in sim.events))
        b.money = 3 * 600
        social._repay(sim, sim.clock.day + 1)
        self.assertEqual((a.money, b.money), (2000.0, 1200.0))
        self.assertNotIn(row, loans)

    def test_give_and_refuse(self):
        sim, a, b, fork = Setup.build("friend_in_need", RelationKind.FRIEND, {}, {"amount": 600})
        a.money = 1000.0
        before = b.relationships[a.id].affinity
        self.choose(sim, a, fork, 2)
        self.assertEqual((a.money, b.money), (850.0, -450.0))
        self.assertGreater(b.relationships[a.id].affinity, before)
        before = b.relationships[a.id].affinity
        self.choose(sim, a, fork, 3)
        self.assertEqual(b.relationships[a.id].affinity, before - 8)

    def test_trouble_space_holds_off_the_breakup(self):
        sim, a, b, fork = Setup.build("relationship_trouble", DATING, {"romance": 20.0}, {})
        self.choose(sim, a, fork, 2)
        self.assertEqual(a.life.cooldowns["breakup"], sim.clock.day + 7)
        for r in (a.relationships[b.id], b.relationships[a.id]):
            r.romance, r.affinity = 10.0, 40.0
        a.life.cooldowns["relationship_trouble"] = sim.clock.day + 7
        lo, hi = (a, b) if a.id < b.id else (b, a)
        social._dating_day(sim, lo, hi, lo.relationships[hi.id], hi.relationships[lo.id], sim.clock.day)
        if a is lo or a.relationships[b.id].affinity <= b.relationships[a.id].affinity:
            self.assertEqual(a.relationships[b.id].kind, DATING)
        self.choose(sim, a, fork, 3)
        self.assertEqual((a.relationships[b.id].kind, b.relationships[a.id].kind), (EX, EX))

    def test_split_and_storm(self):
        sim, a, b, fork = Setup.build("partner_split", PARTNER, {"romance": 10.0}, {})
        self.choose(sim, a, fork, 0)
        self.assertEqual(a.relationships[b.id].kind, EX)
        sim, a, b, fork = Setup.build("partner_split", PARTNER, {"romance": 10.0}, {})
        before = a.relationships[b.id].affinity
        self.choose(sim, a, fork, 3)
        self.assertEqual(a.relationships[b.id].kind, EX)
        self.assertEqual(a.relationships[b.id].affinity, before - 35)

    def test_date_go_and_end(self):
        sim, a, b, fork = Setup.build("date", DATING, {"romance": 50.0}, {"place": None})
        self.choose(sim, a, fork, 0)
        self.assertTrue(any(e["tag"] == "meetup" for e in sim.events))
        self.assertEqual(sim.social.counts["dates"], 1)
        self.choose(sim, a, fork, 3)
        self.assertEqual(a.relationships[b.id].kind, EX)

    def test_asked_out_no_thanks(self):
        sim, a, b, fork = Setup.build("asked_out", ACQ, {"romance": 30.0}, {})
        b.relationships[a.id].romance = 40.0
        self.choose(sim, a, fork, 3)
        self.assertEqual(b.relationships[a.id].romance, 10.0)
        sim, a, b, fork = Setup.build("asked_out", ACQ, {"romance": 30.0}, {})
        self.choose(sim, a, fork, 2)
        self.assertLessEqual(a.relationships[b.id].romance, 10.0)

    def test_crush_let_go_and_proposal_no(self):
        sim, a, b, fork = Setup.build("crush", ACQ, {"romance": 35.0}, {})
        self.choose(sim, a, fork, 3)
        self.assertEqual(a.relationships[b.id].romance, 10.0)
        sim, a, b, fork = Setup.build("proposal", PARTNER, {"romance": 75.0}, {})
        self.choose(sim, a, fork, 3)
        self.assertEqual(a.relationships[b.id].romance, 55.0)
        self.assertEqual(sim.social.engaged, {})
        sim, a, b, fork = Setup.build("proposal", PARTNER, {"romance": 75.0}, {})
        self.choose(sim, a, fork, 1)
        self.assertEqual(len(sim.social.engaged), 1)
        self.assertGreaterEqual(min(sim.social.engaged.values()), sim.clock.day + 90)

    def test_move_in_together(self):
        sim, a, b, fork = Setup.build("move_in", DATING, {"romance": 70.0, "since": -40 * DAY}, {})
        self.choose(sim, a, fork, 1)  # into b's place
        self.assertEqual(a.household_id, b.household_id)
        self.assertEqual(a.relationships[b.id].kind, PARTNER)
        sim, a, b, fork = Setup.build("move_in", DATING, {"romance": 70.0, "since": -40 * DAY}, {})
        old = (a.household_id, b.household_id)
        self.choose(sim, a, fork, 2)  # a place together (or b moves in when no rental is free)
        self.assertEqual(a.household_id, b.household_id)
        self.assertEqual(a.relationships[b.id].kind, PARTNER)
        self.assertTrue(a.household_id not in old or b.household_id == a.household_id)


class EffectsTest(unittest.TestCase):
    def test_life_rel_and_life_rom(self):
        sim = Simulation(1)
        a, b = pair(sim)
        people.set_rel(sim, a.id, b.id, ACQ, 20, romance=10.0)
        self.assertTrue(people.apply_effect(sim, a, "life_rel", [b.id, 8]))
        self.assertEqual((b.relationships[a.id].affinity, a.relationships[b.id].affinity), (28, 24))
        self.assertTrue(people.apply_effect(sim, a, "life_rom", [b.id, 5]))
        self.assertEqual((a.relationships[b.id].romance, b.relationships[a.id].romance), (15.0, 15.0))
        self.assertTrue(people.apply_effect(sim, a, "life_rom", [b.id, -50]))
        self.assertEqual(a.relationships[b.id].romance, 0.0)
        self.assertFalse(people.apply_effect(sim, a, "money", 5))


class LiveForkTest(unittest.TestCase):
    """A queued prompt reaches the character as a real fork, decided by habit, its choice played."""

    def test_crush_in_a_running_city(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        target = next(oid for oid, r in tom.relationships.items() if r.romance == 32.0)
        tom.life.pending.clear()
        self.assertTrue(people.prompt(sim, tom, "crush", {"with": target}))
        seen = []
        for _ in range(DAY):
            sim.step()
            _, forks, _ = sim.drain()
            seen += [f for f in forks if f.get("agent") == "tom" and f.get("kind") == "crush"]
            if seen:
                break
        self.assertTrue(seen, "the crush fork never came")
        self.assertEqual(len(seen[0]["options"]), 4)
        self.assertEqual(tom.life.pending, [])


if __name__ == "__main__":
    unittest.main()
