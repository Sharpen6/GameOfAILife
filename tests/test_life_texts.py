"""What the News and the pages say (stage 5 repair), in Python and in the JS port alike.

- Talk lines: a line about a child or a partner asks after the listener's (social.talk_ctx `swap`: the parent
  speaks second), and a pair's talks reach the News log at most once an hour (TALK_LOG_GAP); the talk tables are
  the same in both engines.
- The asked-out fork names the day of the first date as _dates arranges it, not always Friday.
- A falling-out at a school is between two of its staff, so it is over the timetable, not a pencil case.
- A townsperson's page keeps their last talks (FOLK_RING), remembers new friends and dates, and stamps each choice
  with its day.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import people, social, social_forks, talk
from gameofailife.agent import RelationKind
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
DAY = 1440


def node(code: str):
    js = 'const G = require(process.argv[1] + "/port/tools/engine.cjs").load();\n' + code
    out = subprocess.run([NODE, "-e", js, str(ROOT)], capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        raise AssertionError(out.stderr[-3000:])
    return json.loads(out.stdout.strip().splitlines()[-1])


def family_ctx_py() -> list:
    """talk_ctx's family words for every pair of the cast at the start, both ways round."""
    sim = Simulation(1)
    rows = []
    ids = sorted(sim.agents)
    for i, x in enumerate(ids):
        for y in ids[i + 1:]:
            for a_id, b_id in ((x, y), (y, x)):
                a, b = sim.agents[a_id], sim.agents[b_id]
                ctx = social.talk_ctx(sim, a, b, a.relationships.get(b_id) or _Rel(), "work", None)
                rows.append([a_id, b_id, ctx["kid"], ctx["partner"], ctx["swap"], ctx["family"], ctx["baby"]])
    return rows


class _Rel:
    kind = RelationKind.ACQUAINTANCE
    romance = 0.0


FAMILY_CTX_JS = """
const sim = new G.sim.Simulation(1);
const ids = Array.from(sim.agents.keys()).sort();
const rows = [];
const rel = { kind: "acquaintance", romance: 0.0 };
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  for (const [x, y] of [[ids[i], ids[j]], [ids[j], ids[i]]]) {
    const a = sim.agents.get(x), b = sim.agents.get(y);
    const ctx = G.social.talk_ctx(sim, a, b, a.relationships.get(y) || rel, "work", null);
    rows.push([x, y, ctx.kid, ctx.partner, ctx.swap, ctx.family, ctx.baby]);
  }
}
console.log(JSON.stringify(rows));
"""


class TalkLinesTest(unittest.TestCase):
    def test_the_kid_and_partner_are_the_listeners(self):
        sim = Simulation(1)
        kid_of = {a.id: social._kid_of(sim, a) for a in sim.agents.values()}
        parent = next(a for a in sim.agents.values() if a.is_adult and kid_of[a.id] is not None)
        other = next(a for a in sim.agents.values() if a.is_adult and kid_of[a.id] is None
                     and social.partner_of(sim, a) is None and a.household_id != parent.household_id)
        rel = parent.relationships.get(other.id) or _Rel()
        ctx = social.talk_ctx(sim, parent, other, rel, "work", None)  # the parent would speak first
        self.assertTrue(ctx["swap"])
        self.assertEqual(ctx["kid"], kid_of[parent.id].name.split()[0])
        ctx = social.talk_ctx(sim, other, parent, rel, "work", None)  # the parent listens
        self.assertFalse(ctx["swap"])
        self.assertEqual(ctx["kid"], kid_of[parent.id].name.split()[0])
        # the parent is asked after their child: the News line names the other person first
        place = next(pid for pid, k in sim.social.kind.items() if k == "work")
        with mock.patch.object(talk, "topic", lambda ctx, u: "family"):
            social._named_talk(sim, parent, other, rel, "warm", "work", place)
        line = [e for e in sim.history if e["tag"] == "talk"][-1]["text"]
        self.assertTrue(line.startswith(f"{other.name} and {parent.name} chat about family"), line)
        kid = kid_of[parent.id].name.split()[0]
        self.assertTrue(kid not in line or "How is little" in line or "Is " + kid in line or "for " + kid in line,
                        line)

    def test_no_line_about_your_own_child(self):
        # Every family line that names a child names the listener's (b, or a when swapped), across the cast.
        rows = family_ctx_py()
        sim = Simulation(1)
        first = {a.id: a.name.split()[0] for a in sim.agents.values()}
        for a_id, b_id, kid, partner, swap, family, _baby in rows:
            listener = sim.agents[a_id if swap else b_id]
            if kid is not None:
                k = social._kid_of(sim, listener)
                self.assertIsNotNone(k, (a_id, b_id))
                self.assertEqual(kid, first[k.id])
            if partner is not None:
                q = social.partner_of(sim, listener)
                self.assertEqual(partner, q.name.split()[0], (a_id, b_id))
            self.assertEqual(family, kid is not None or partner is not None)
        self.assertTrue(any(r[4] for r in rows))  # some talks are swapped
        if NODE:
            self.assertEqual(node(FAMILY_CTX_JS), rows)

    def test_a_pair_is_logged_once_an_hour(self):
        sim = Simulation(1)
        a, b = _two_adults(sim)
        rel = a.relationships.get(b.id) or _Rel()
        place = next(pid for pid, k in sim.social.kind.items() if k == "work")
        talks = lambda: [e for e in sim.history if e["tag"] == "talk"]  # noqa: E731
        ring = len(a.life.talks)
        for dt in (0, 20, 59, 60, 90, 120):
            sim.clock.tick = 600 + dt
            social._named_talk(sim, a, b, rel, "argument", "work", place)
        self.assertEqual(len(talks()), 3)  # at +0, +60 and +120
        self.assertEqual(len(a.life.talks), min(social.RING, ring + 6))  # every talk is in the ring
        if NODE:
            got = node(f"""
const sim = new G.sim.Simulation(1);
const a = sim.agents.get({json.dumps(a.id)}), b = sim.agents.get({json.dumps(b.id)});
const rel = a.relationships.get(b.id) || {{ kind: "acquaintance", romance: 0 }};
for (const dt of [0, 20, 59, 60, 90, 120]) {{
  sim.clock.tick = 600 + dt;
  G.social._named_talk(sim, a, b, rel, "argument", "work", {json.dumps(place)});
}}
console.log(JSON.stringify(sim.history.filter(e => e.tag === "talk").map(e => e.tick)));
""")
            self.assertEqual(got, [e["tick"] for e in talks()])

    def test_the_talk_tables_are_the_same(self):
        if not NODE:
            self.skipTest("node is not installed")
        js = node("console.log(JSON.stringify(G.talk.LINES));")
        py = {t: {tone: [list(p) for p in pairs] for tone, pairs in tones.items()} for t, tones in talk.LINES.items()}
        self.assertEqual(js, py)


def _two_adults(sim):
    adults = sorted((a for a in sim.agents.values() if a.is_adult), key=lambda a: a.id)
    a = adults[0]
    b = next(x for x in adults[1:] if x.household_id != a.household_id)
    return a, b


class AskedOutTest(unittest.TestCase):
    def test_the_fork_names_the_first_dates_day(self):
        sim = Simulation(1)
        adults = sorted((a for a in sim.agents.values() if a.is_adult), key=lambda a: a.id)
        seen = set()
        rows = []
        for tick in (7 * 60 + 38, 16 * 60 + 59, 17 * 60, 18 * 60 + 2 * DAY, 12 * 60 + 4 * DAY, 18 * 60 + 11 * DAY):
            sim.clock.tick = tick
            for a in adults[:8]:
                for b in adults[8:14]:
                    day = social.first_date_day(sim, a.id, b.id)
                    m = tick % DAY
                    self.assertGreaterEqual(day, sim.clock.day + (1 if m >= social.DATE_HOUR * 60 else 0))
                    self.assertEqual((social.dice.sid(a.id) + social.dice.sid(b.id) + day) % 3, 0)  # _dates' rule
                    self.assertLess(day - sim.clock.day, 4)
                    when = social_forks._date_when(sim, a, b)
                    seen.add(when.split()[0])
                    rows.append([tick, a.id, b.id, when])
                    if day == sim.clock.day:
                        self.assertEqual(when, "tonight")
                    elif day == sim.clock.day + 1:
                        self.assertEqual(when, "tomorrow evening")
                    else:
                        self.assertEqual(when, f"on {social_forks.DAY_FULL[day % 7]}")
        self.assertEqual(seen, {"tonight", "tomorrow", "on"})
        a, b = next((x, y) for x in adults for y in adults if x.id < y.id and social.eligible(sim, x, y))
        people.set_rel(sim, a.id, b.id, RelationKind.ACQUAINTANCE, 45, romance=30.0)
        fork = people.PROMPTS["asked_out"](sim, a, {"with": b.id})
        self.assertIsNotNone(fork)
        self.assertTrue(fork.question.endswith(f" asks you out {social_forks._date_when(sim, a, b)}."), fork.question)
        self.assertTrue(re.fullmatch(r".+ asks you out (tonight|tomorrow evening|on [A-Z][a-z]+day)\.", fork.question),
                        fork.question)
        if NODE:
            got = node(f"""
const sim = new G.sim.Simulation(1);
const rows = [];
for (const [tick, a, b] of {json.dumps([r[:3] for r in rows])}) {{
  sim.clock.tick = tick;
  rows.push([tick, a, b, G.social_forks._date_when(sim, sim.agents.get(a), sim.agents.get(b))]);
}}
console.log(JSON.stringify(rows));
""")
            self.assertEqual(got, rows)


INCIDENT_JS = """
const sim = new G.sim.Simulation(1);
while (sim.clock.tick < 2 * 1440 + 11 * 60) sim.step();
const staff = Array.from(sim.agents.values()).filter(a => a.is_adult && sim.social.kind.get(G.social._named_place(a) || "") === "school");
for (let i = 0; i < staff.length; i++) for (let j = i + 1; j < staff.length; j++)
  G.people.set_rel(sim, staff[i].id, staff[j].id, "coworker", 5);
const odds = G.dice.odds;
G.dice.odds = () => 1.0;
const n = sim.history.length;
G.social._incidents(sim, ["work", "school"]);
G.dice.odds = odds;
console.log(JSON.stringify(sim.history.slice(n).filter(e => e.tag === "row").map(e => e.text)));
"""


class SchoolRowTest(unittest.TestCase):
    def test_teachers_fall_out_over_the_timetable(self):
        sim = Simulation(1)
        while sim.clock.tick < 2 * DAY + 11 * 60:  # Wednesday 11:00, when workplaces and schools have theirs
            sim.step()
        staff = [a for a in sim.agents.values() if a.is_adult and sim.social.kind.get(social._named_place(a) or "")
                 == "school"]
        self.assertGreaterEqual(len(staff), 3)
        for i, x in enumerate(staff):
            for y in staff[i + 1:]:
                people.set_rel(sim, x.id, y.id, RelationKind.COWORKER, 5)
        n = len(sim.history)
        with mock.patch.object(social.dice, "odds", lambda *a, **k: 1.0):
            social._incidents(sim, ("work", "school"))
        rows = [e["text"] for e in list(sim.history)[n:] if e["tag"] == "row"]
        school = [t for t in rows if "School" in t]
        self.assertEqual(len(school), 1, rows)
        self.assertIn("over the timetable", school[0])
        self.assertFalse(any("pencil" in t for t in rows), rows)
        if NODE:
            js = node(INCIDENT_JS)
            self.assertTrue(any("over the timetable" in t and "School" in t for t in js), js)
            self.assertFalse(any("pencil" in t for t in js), js)


FOLK = 300
STEPS = DAY + 6 * 60


def folk_pages_py() -> dict:
    """A region of FOLK townsfolk, a day and six hours on the JS port's dice for the named (as
    tests.test_folk_protocol.city_stats_python does), then two townsfolk become friends and two start dating; the
    talks, memories and choices on every townsperson's page."""
    from tests.test_port import MulberryDice

    class RegionDiceSim(Simulation):
        def _roll_weather(self) -> None:
            if not isinstance(self.rng, MulberryDice):
                self.rng = MulberryDice(1)
            super()._roll_weather()

    sim = RegionDiceSim(1, world="region", folk=FOLK)
    for _ in range(STEPS):
        sim.step()
    f = sim.folk
    adults = [p for p in f.living() if p.age >= 25 and social.partner_of(sim, p) is None]
    a, b, c, d = adults[0], adults[1], adults[2], adults[3]
    people.set_rel(sim, a.id, b.id, RelationKind.ACQUAINTANCE, social.FRIEND_AT - 1)
    a.relationships[b.id].affinity = social.FRIEND_AT + 1
    social.on_affinity(sim, a.id, b.id, social.FRIEND_AT - 1, social.FRIEND_AT + 1)
    social.start_dating(sim, c, d)
    pages = {}
    for p in f.living():
        page = f.page_json(sim, p.id)
        pages[p.id] = {"talks": page["life"]["talks"], "memory": page["memory"], "choices": page["choices"]}
    return {"pages": pages, "pair": [a.id, b.id], "couple": [c.id, d.id]}


FOLK_PAGES_JS = f"""
const sim = new G.sim.Simulation(1, null, null, 1, {{ world: "region", folk: {FOLK} }});
for (let i = 0; i < {STEPS}; i++) sim.step();
const f = sim.folk;
const adults = f.living().filter(p => p.age >= 25 && G.social.partner_of(sim, p) === null);
const [a, b, c, d] = adults;
G.people.set_rel(sim, a.id, b.id, "acquaintance", G.social.FRIEND_AT - 1);
a.relationships.get(b.id).affinity = G.social.FRIEND_AT + 1;
G.social.on_affinity(sim, a.id, b.id, G.social.FRIEND_AT - 1, G.social.FRIEND_AT + 1);
G.social.start_dating(sim, c, d);
const pages = {{}};
for (const p of f.living()) {{
  const page = f.page_json(sim, p.id);
  pages[p.id] = {{ talks: page.life.talks, memory: page.memory, choices: page.choices }};
}}
console.log(JSON.stringify({{ pages, pair: [a.id, b.id], couple: [c.id, d.id] }}));
"""


class FolkPagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.got = folk_pages_py()

    def test_townsfolk_pages_keep_talks(self):
        pages = self.got["pages"]
        with_talks = [p for p in pages.values() if p["talks"]]
        self.assertGreater(len(with_talks), FOLK // 3, len(with_talks))
        for p in with_talks:
            self.assertLessEqual(len(p["talks"]), social.FOLK_RING)
            for t in p["talks"]:
                self.assertEqual(set(t), {"time", "with", "name", "topic", "tone", "text", "place"})
                self.assertTrue(t["time"].startswith("Day "), t)

    def test_new_friends_and_dates_are_remembered(self):
        pages = self.got["pages"]
        a, b = self.got["pair"]
        c, d = self.got["couple"]
        self.assertTrue(any("Became friends with" in m for m in pages[a]["memory"]), pages[a]["memory"])
        self.assertTrue(any("Became friends with" in m for m in pages[b]["memory"]), pages[b]["memory"])
        self.assertTrue(any("Started going out with" in m for m in pages[c]["memory"]), pages[c]["memory"])
        self.assertTrue(any("Started going out with" in m for m in pages[d]["memory"]), pages[d]["memory"])

    def test_choices_carry_their_day(self):
        times = [c["time"] for p in self.got["pages"].values() for c in p["choices"]]
        self.assertGreater(len(times), FOLK)
        self.assertTrue(all(re.fullmatch(r"Day \d+ \d\d:\d\d", t) for t in times), times[:5])
        self.assertIn("Day 2", {t.rsplit(" ", 1)[0] for t in times})

    def test_the_js_twin_keeps_the_same_pages(self):
        if not NODE:
            self.skipTest("node is not installed")
        self.assertEqual(node(FOLK_PAGES_JS), self.got)


if __name__ == "__main__":
    unittest.main()
