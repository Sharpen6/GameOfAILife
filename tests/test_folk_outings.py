"""Days out and children (stage 5 repair), in both engines:

- Every townsperson choice has 4 options, never two with the same activity at the same place (the shopping trip and
  a day at the same mall).
- A child under folk.PLAY_AGE has a child's choices (home, play at home, play in the park or outside, draw and read,
  an early night) and never runs an errand, shops, eats out or hangs out with an adult's money.
- An under-5 is never left at home with nobody aged folk.CARER_AGE or over for longer than folk.NURSERY_CHECK
  minutes (and a sampling step): they go to the nursery (a school, while it is open) or have a sitter at home.
- A named child under forks.CHILD_AGE draws and builds at home and plays rather than hang out at a cafe; nobody off
  sick or on the ward gets the free-time fork.
- The named start the day like a morning (cast.START_ENERGY: energy 85-100) and a sleep begun in the evening runs to
  the wake time (a 3-hour nap only in the daytime).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from collections import Counter
from pathlib import Path

from gameofailife import cast, folk, forks
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
DAY = 1440
DAYS = 2
N = 400
CHILD_ACTS = {"relax_home", "dinner_home", "play_home", "play", "stroll", "draw_home", "sleep"}


def node(code: str) -> dict:
    js = 'const G = require(process.argv[1] + "/port/tools/engine.cjs").load();\n' + code
    out = subprocess.run([NODE, "-e", js, str(ROOT)], capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        raise AssertionError(out.stderr[-3000:])
    return json.loads(out.stdout.strip().splitlines()[-1])


def folk_py(seed: int) -> dict:
    """Run `DAYS` days with N townsfolk and summarise every choice list and the under-5s every 15 minutes."""
    sim = Simulation(seed, world="region", folk=N)
    f = sim.folk
    out = Counter()
    child_acts, child_chosen = Counter(), Counter()
    orig_options, orig_play = f.options, f._play

    def options(sim_, p, now, kind):
        opts = orig_options(sim_, p, now, kind)
        out["lists"] += 1
        if len(opts) != 4:
            out["not4"] += 1
        keys = [(o.activity, o.place) for o in opts if o.place is not None]
        if len(set(keys)) != len(keys):
            out["dup"] += 1
        if 5 <= p.age < folk.PLAY_AGE:
            out["child_lists"] += 1
            for o in opts:
                child_acts[o.activity] += 1
        return opts

    def play(sim_, p, now, opt):
        if 5 <= p.age < folk.PLAY_AGE:
            child_chosen[opt.activity] += 1
        return orig_play(sim_, p, now, opt)

    f.options, f._play = options, play
    alone = {}
    for _ in range(DAYS * DAY):
        sim.step()
        now = sim.clock.tick
        if now % 15:
            continue
        day, m = divmod(now, DAY)
        for p in f.living():
            if p.age >= 5 or p.trip is not None:
                continue
            home = f.home_place(p)
            awake = f._wake_minute(p, day) <= m < f._bed_minute(p)
            out["u5_" + p.activity] += 1
            if p.activity == "nursery":
                out["nursery_at_school"] += sim.town.places[p.inside].kind == "school"
            if p.activity == "baby" and awake and not f._carer_home(p, home):
                alone[p.id] = alone.get(p.id, 0) + 1
                out["alone_max"] = max(out["alone_max"], alone[p.id])
            else:
                alone[p.id] = 0
    out["child_bad"] = sum(n for a, n in child_acts.items() if a not in CHILD_ACTS)
    out["child_bad_chosen"] = sum(n for a, n in child_chosen.items() if a not in CHILD_ACTS)
    out["child_play"] = child_chosen["play"] + child_chosen["play_home"] + child_chosen["draw_home"]
    return dict(out)


FOLK_JS = """
const seed = Number(process.argv[2]);
const sim = new G.sim.Simulation(seed, null, null, null, { world: "region", folk: %d });
const f = sim.folk, F = G.folk, CHILD = new Set(%s);
const out = {}; const inc = (k, n = 1) => { out[k] = (out[k] || 0) + n; };
const childActs = {}, childChosen = {};
const origOptions = f.options.bind(f), origPlay = f._play.bind(f);
f.options = (sim_, p, now, kind) => {
  const opts = origOptions(sim_, p, now, kind);
  inc("lists");
  if (opts.length !== 4) inc("not4");
  const keys = opts.filter(o => o.place !== null && o.place !== undefined).map(o => o.activity + "|" + o.place);
  if (new Set(keys).size !== keys.length) inc("dup");
  if (5 <= p.age && p.age < F.PLAY_AGE) {
    inc("child_lists");
    for (const o of opts) childActs[o.activity] = (childActs[o.activity] || 0) + 1;
  }
  return opts;
};
f._play = (sim_, p, now, opt) => {
  if (5 <= p.age && p.age < F.PLAY_AGE) childChosen[opt.activity] = (childChosen[opt.activity] || 0) + 1;
  return origPlay(sim_, p, now, opt);
};
const alone = {};
for (let i = 0; i < %d * 1440; i++) {
  sim.step();
  const now = sim.clock.tick;
  if (now %% 15) continue;
  const day = Math.floor(now / 1440), m = now %% 1440;
  for (const p of f.living()) {
    if (p.age >= 5 || p.trip !== null) continue;
    const home = f.home_place(p);
    const awake = f._wake_minute(p, day) <= m && m < f._bed_minute(p);
    inc("u5_" + p.activity);
    if (p.activity === "nursery") inc("nursery_at_school", sim.town.places.get(p.inside).kind === "school" ? 1 : 0);
    if (p.activity === "baby" && awake && !f._carer_home(p, home)) {
      alone[p.id] = (alone[p.id] || 0) + 1;
      out.alone_max = Math.max(out.alone_max || 0, alone[p.id]);
    } else alone[p.id] = 0;
  }
}
const bad = (c) => Object.entries(c).reduce((s, [a, n]) => s + (CHILD.has(a) ? 0 : n), 0);
out.child_bad = bad(childActs);
out.child_bad_chosen = bad(childChosen);
out.child_play = (childChosen.play || 0) + (childChosen.play_home || 0) + (childChosen.draw_home || 0);
console.log(JSON.stringify(out));
""" % (N, json.dumps(sorted(CHILD_ACTS)), DAYS)


def folk_js(seed: int) -> dict:
    js = 'const G = require(process.argv[1] + "/port/tools/engine.cjs").load();\n' + FOLK_JS
    out = subprocess.run([NODE, "-e", js, str(ROOT), str(seed)], capture_output=True, text=True, timeout=900)
    if out.returncode != 0:
        raise AssertionError(out.stderr[-3000:])
    return json.loads(out.stdout.strip().splitlines()[-1])


class FolkChoicesTest(unittest.TestCase):
    runs = {}

    @classmethod
    def setUpClass(cls):
        cls.runs = {"py": folk_py(1)}
        if NODE:
            cls.runs["js"] = folk_js(1)

    def _each(self):
        if not NODE:
            self.skipTest("node not found")
        for engine, run in self.runs.items():
            with self.subTest(engine=engine):
                yield engine, run

    def test_four_distinct_options(self):
        for engine, run in self._each():
            self.assertGreater(run["lists"], 1000, engine)
            self.assertEqual(run.get("not4", 0), 0, engine)
            self.assertEqual(run.get("dup", 0), 0, engine)

    def test_children_play_and_run_no_errands(self):
        for engine, run in self._each():
            self.assertGreater(run.get("child_lists", 0), 50, engine)
            self.assertEqual(run["child_bad"], 0, (engine, run))
            self.assertEqual(run["child_bad_chosen"], 0, (engine, run))
            self.assertGreater(run["child_play"], 10, (engine, run))

    def test_no_under_five_is_left_alone(self):
        for engine, run in self._each():
            # A carer leaving is seen within NURSERY_CHECK minutes (two 15-minute samples, plus the one it happens in).
            self.assertLessEqual(run.get("alone_max", 0), folk.NURSERY_CHECK // 15 + 1, (engine, run))
            self.assertGreater(run.get("u5_nursery", 0), 100, (engine, run))  # weekday daytimes at the nursery
            self.assertEqual(run.get("nursery_at_school"), run.get("u5_nursery"), (engine, run))
            self.assertGreater(run.get("u5_sitter", 0), 0, (engine, run))  # after the nursery shuts, no one home
            self.assertGreater(run.get("u5_baby", 0), run.get("u5_sitter", 0), (engine, run))


def dice_sim() -> Simulation:
    """Millbrook seed 1 with the named rolling the JS port's dice from the first weather roll on (test_port's
    DiceSim), so the two engines' runs can be compared."""
    from tests.test_port import MulberryDice

    class DiceSim(Simulation):
        def _roll_weather(self) -> None:
            if not isinstance(self.rng, MulberryDice):
                self.rng = MulberryDice(1)
            super()._roll_weather()

    return DiceSim(1, world="millbrook", folk=0)


def free_time_py() -> dict:
    sim = dice_sim()
    while sim.clock.minute_of_day != 17 * 60:
        sim.step()
    out = {}
    for a in sorted(sim.agents.values(), key=lambda a: a.id):
        if not (5 <= a.age < forks.CHILD_AGE):
            continue
        a.needs["fun"] = 10
        fork = forks.free_time_fork(sim, a)
        labels = [o.label for o in fork.options] if fork else None
        a.life.ward_until = sim.clock.tick + 600
        sick = forks.free_time_fork(sim, a)
        a.life.ward_until = 0
        out[a.id] = {"labels": labels, "sick": sick is not None}
    return out


FREE_TIME_JS = """
const sim = new G.sim.Simulation(1, null, null, null, { world: "millbrook", folk: 0 });
while (sim.clock.minute_of_day !== 17 * 60) sim.step();
const out = {};
for (const a of [...sim.agents.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
  if (!(5 <= a.age && a.age < G.forks.CHILD_AGE)) continue;
  a.needs.fun = 10;
  const fork = G.forks.free_time_fork(sim, a);
  const labels = fork ? fork.options.map(o => o.label) : null;
  a.life.ward_until = sim.clock.tick + 600;
  const sick = G.forks.free_time_fork(sim, a);
  a.life.ward_until = 0;
  out[a.id] = { labels, sick: sick !== null && sick !== undefined };
}
console.log(JSON.stringify(out));
"""


class NamedChildFreeTimeTest(unittest.TestCase):
    def test_children_play_and_the_sick_rest(self):
        py = free_time_py()
        offered = [v["labels"] for v in py.values() if v["labels"]]
        self.assertGreaterEqual(len(offered), 3, py)
        for labels in offered:
            self.assertEqual(len(labels), 4)
            self.assertIn("Draw and build at home", labels)
            self.assertNotIn("Work on a side project", labels)
            self.assertFalse(any(lb.startswith("Hang out at") for lb in labels), labels)
        self.assertFalse(any(v["sick"] for v in py.values()), py)
        if NODE:
            self.assertEqual(node(FREE_TIME_JS), py)


def morning_py() -> dict:
    sim = dice_sim()
    energy = sorted(round(a.needs["energy"], 6) for a in sim.agents.values())
    sleeps = []
    orig = sim._begin_activity

    def begin(agent):
        orig(agent)
        if agent.activity == "sleep":
            sleeps.append((sim.clock.minute_of_day, agent.busy_until - sim.clock.tick))

    sim._begin_activity = begin
    for _ in range(3 * DAY):
        sim.step()
    return {"energy": energy, "sleeps": sleeps}


MORNING_JS = """
const sim = new G.sim.Simulation(1, null, null, null, { world: "millbrook", folk: 0 });
const energy = [...sim.agents.values()].map(a => Math.round(a.needs.energy * 1e6) / 1e6).sort((x, y) => x - y);
const sleeps = [];
const orig = sim._begin_activity.bind(sim);
sim._begin_activity = (agent) => {
  orig(agent);
  if (agent.activity === "sleep") sleeps.push([sim.clock.minute_of_day, agent.busy_until - sim.clock.tick]);
};
for (let i = 0; i < 3 * 1440; i++) sim.step();
console.log(JSON.stringify({ energy, sleeps }));
"""


class MorningAndNightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.py = morning_py()

    def test_the_day_starts_like_a_morning(self):
        energy = self.py["energy"]
        self.assertGreaterEqual(min(energy), cast.START_ENERGY)
        self.assertLessEqual(max(energy), 100)

    def test_an_evening_sleep_runs_to_the_wake_time(self):
        evening = [mins for m, mins in self.py["sleeps"] if 19 * 60 <= m]
        self.assertGreater(len(evening), 100)
        self.assertGreaterEqual(min(evening), 5 * 60, sorted(evening)[:5])
        self.assertLessEqual(max(mins for _, mins in self.py["sleeps"]), 13 * 60)

    def test_the_port_agrees(self):
        if not NODE:
            self.skipTest("node not found")
        js = node(MORNING_JS)
        self.assertEqual(js["energy"], self.py["energy"])
        self.assertEqual([list(s) for s in self.py["sleeps"]], js["sleeps"])


if __name__ == "__main__":
    unittest.main()
