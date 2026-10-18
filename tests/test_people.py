"""The person contract (people.py, life.md 3.2, PLAN 2.2): lookups, relationships, the news cap, prompts, settled
choices, NoFolk, and the agent.py additions (new kinds, Relationship fields, night shifts)."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from gameofailife import chronicle, people
from gameofailife.agent import Job, RelationKind, Relationship
from gameofailife.forks import Option
from gameofailife.sim import Simulation


def life_of(agent):
    """A stand-in LifeState with the fields people.prompt / pending_fork read (L2 owns the real one)."""
    if agent.life is None:
        agent.life = SimpleNamespace(pending=[], cooldowns={}, recent={}, talks=[], talks_today=0)
    return agent.life


class IdsTest(unittest.TestCase):
    def test_folk_ids(self):
        for good in ("f0", "f17", "f999"):
            self.assertTrue(people.is_folk_id(good))
        for bad in ("f", "fh3", "dana", "fi2", "F1", "", None, 7, "f1a"):
            self.assertFalse(people.is_folk_id(bad), bad)
        self.assertEqual(people.folk_index("f17"), 17)

    def test_named_sex_covers_the_sixty(self):
        for seed in (1, 2, 3):
            sim = Simulation(seed)
            for aid, a in sim.agents.items():
                self.assertIn(aid, people.NAMED_SEX)
                self.assertIn(people.sex(a), ("f", "m"))
        self.assertEqual(people.sex(Simulation(1).agents["shira"]), "f")


class LookupTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(1)

    def test_person_and_household(self):
        dana = self.sim.agents["dana"]
        self.assertIs(people.person(self.sim, "dana"), dana)
        self.assertIsNone(people.person(self.sim, "f3"))
        self.assertIsNone(people.person(self.sim, "nobody"))
        self.assertIs(people.household(self.sim, dana), self.sim.households[dana.household_id])
        self.assertEqual(people.home_id(self.sim, dana), "main_20")
        self.assertEqual({p.id for p in people.members(self.sim, dana)}, {"dana", "yossi", "noa"})
        self.assertEqual(people.name_of(self.sim, "f12"), "f12")
        self.assertEqual(people.name_of(self.sim, "dana"), "Dana Cohen")
        self.assertEqual([p.id for p in people.everyone(self.sim)], [a.id for a in self.sim.agents.values()])
        self.assertFalse(people.mixed(self.sim))
        self.assertTrue(people.is_named(dana))
        self.assertIs(people.traits(dana), dana.profile.traits)

    def test_set_rel_writes_both_sides(self):
        people.set_rel(self.sim, "dana", "tom", "dating", 50, 45, romance=55, since=-20 * 1440)
        a, b = self.sim.agents["dana"], self.sim.agents["tom"]
        self.assertEqual(a.relationships["tom"].kind, RelationKind.DATING)
        self.assertEqual(a.relationships["tom"].affinity, 50)
        self.assertEqual(b.relationships["dana"].affinity, 45)
        self.assertEqual(b.relationships["dana"].romance, 55)
        self.assertIs(people.rel(a, "tom"), a.relationships["tom"])
        row = people.rel_row(self.sim, "tom", a.relationships["tom"])
        self.assertEqual(row, {"id": "tom", "name": "Tom Levi", "named": True, "kind": "dating", "affinity": 50,
                               "trust": 50, "romance": 55, "married": False})

    def test_relationship_fields(self):
        r = Relationship(RelationKind.RIVAL, -20.0)
        self.assertEqual((r.trust, r.romance, r.since, r.seen, r.married, r.talks), (50.0, 0.0, 0, 0, False, 0))
        self.assertEqual(r.to_json(), {"kind": "rival", "affinity": -20, "trust": 50})
        with self.assertRaises(AttributeError):
            r.anything = 1  # slots
        self.assertEqual([k.value for k in (RelationKind.DATING, RelationKind.EX, RelationKind.RIVAL)],
                         ["dating", "ex", "rival"])

    def test_night_shift(self):
        night = Job("night nurse", "hospital", 40, 22, 6, (0, 1, 2))
        self.assertTrue(night.on_shift(0, 23))
        self.assertTrue(night.on_shift(0, 3))
        self.assertFalse(night.on_shift(0, 12))
        self.assertFalse(night.on_shift(5, 23))
        day = Job("clerk", "cityhall", 26, 8, 16, (0, 1))
        self.assertTrue(day.on_shift(0, 8) and not day.on_shift(0, 16))
        self.assertEqual(day.slot, -1)
        self.assertNotIn("slot", day.to_json())
        self.assertIsNone(self.sim.agents["dana"].life)


class NewsGateTest(unittest.TestCase):
    def test_folk_only_news_is_capped(self):
        sim = Simulation(1)
        dana = sim.agents["dana"]
        folk = SimpleNamespace(id="f3")
        self.assertTrue(people.news_gate(sim, "talk", None, folk, ["f4"]))  # importance 0 always passes
        for _ in range(people.FOLK_NEWS_CAP):
            self.assertTrue(people.news_gate(sim, "rival", None, None, ["f3", "f4"]))
        self.assertFalse(people.news_gate(sim, "rival", None, None, ["f3", "f4"]))
        self.assertFalse(people.news_gate(sim, "talk", 1, folk, None))
        self.assertTrue(people.news_gate(sim, "rival", None, dana, ["f3"]))  # names a named
        self.assertTrue(people.news_gate(sim, "rival", None, folk, ["dana"]))
        self.assertTrue(people.news_gate(sim, "weather", 2, None, None))  # names nobody
        sim.clock.tick += 1440  # a new day
        self.assertTrue(people.news_gate(sim, "rival", None, None, ["f3"]))

    def test_tags_resolve_importance(self):
        self.assertEqual(chronicle.EVENT_TAGS["talk"][1], 0)
        self.assertEqual(chronicle.EVENT_TAGS["rival"][1], 1)


class PromptTest(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(1)
        self.dana = self.sim.agents["dana"]
        self.saved = dict(people.PROMPTS)

    def tearDown(self):
        people.PROMPTS.clear()
        people.PROMPTS.update(self.saved)

    def test_no_life_no_prompt(self):
        self.assertFalse(people.prompt(self.sim, self.dana, "crush", {}))
        self.assertIsNone(people.pending_fork(self.sim, self.dana))

    def test_queue_one_per_kind_three_at_most_two_days(self):
        life = life_of(self.dana)
        self.assertTrue(people.prompt(self.sim, self.dana, "crush", {"with": "tom"}))
        self.assertFalse(people.prompt(self.sim, self.dana, "crush", {"with": "ari"}))
        self.assertTrue(people.prompt(self.sim, self.dana, "date", {}))
        self.assertTrue(people.prompt(self.sim, self.dana, "move_in", {}))
        self.assertFalse(people.prompt(self.sim, self.dana, "propose", {}))
        self.assertEqual(len(life.pending), 3)
        built = []

        def builder(sim, agent, ctx):
            built.append(ctx)
            return SimpleNamespace(kind="crush", major=False)

        people.PROMPTS["crush"] = builder
        self.dana.activity, self.dana.state = "idle", "idle"
        self.sim.clock.tick = 2 * 1440 + 20 * 60  # 20:00 two days on, off shift
        fork = people.pending_fork(self.sim, self.dana)
        self.assertIsNone(fork)  # all three were queued over two days ago
        self.assertEqual(life.pending, [])
        people.prompt(self.sim, self.dana, "crush", {"with": "tom"})
        fork = people.pending_fork(self.sim, self.dana)
        self.assertTrue(fork.major)
        self.assertEqual(built, [{"with": "tom"}])


class SettleChoiceTest(unittest.TestCase):
    def test_deterministic_and_trait_led(self):
        sim = Simulation(1)
        tom = sim.agents["tom"]
        tom.profile.traits["social"] = 1.0
        opts = [Option("Stay in", [], tags={"social": -1.0}), Option("Go out", [], tags={"social": 1.0}),
                Option("Read", [], tags={}), Option("Nap", [], tags={"social": -0.5})]
        self.assertEqual(people.settle_choice(sim, tom, "test", opts), 1)
        self.assertEqual(people.settle_choice(sim, tom, "test", opts), people.settle_choice(sim, tom, "test", opts))


class EffectsTest(unittest.TestCase):
    def test_unknown_keys_fall_through(self):
        sim = Simulation(1)
        self.assertFalse(people.apply_effect(sim, sim.agents["dana"], "home_condition", 3))
        seen = []
        people.EFFECTS["life_test"] = lambda s, a, v: seen.append(v)
        try:
            self.assertTrue(people.apply_effect(sim, sim.agents["dana"], "life_test", 5))
        finally:
            del people.EFFECTS["life_test"]
        self.assertEqual(seen, [5])


class NoFolkTest(unittest.TestCase):
    def test_every_method_is_a_no_op(self):
        f = people.make_folk(None, 0)
        self.assertIsInstance(f, people.NoFolk)
        self.assertEqual((f.n, f.isolated, f.v, len(f.luck_log)), (0, False, 0, 0))
        self.assertIsNone(f.person("f1"))
        self.assertIsNone(f.get("f1"))
        for name in ("living", "occ"):
            self.assertEqual(getattr(f, name)(), [])
        self.assertEqual(f.present("cafe"), [])
        self.assertEqual(f.crowd(None), [])
        self.assertEqual(f.riders(0), {})
        self.assertIsNone(f.stats_json(None))
        for name in ("tick", "nightly", "pensions", "weekly", "sample_hour"):
            self.assertIsNone(getattr(f, name)(None))
        self.assertIsNone(f.commute_minutes(None, "cafe"))
        self.assertIsNone(f.page_json(None, "f1"))
        self.assertFalse(f.set_luck("f1", 10))
        self.assertIsNone(f.household("fh1"))


if __name__ == "__main__":
    unittest.main()
