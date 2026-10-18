"""The browser port (port/): the JS engine against the Python one, and the self-contained page.

The engine in port/src is a file-for-file port of gameofailife/ run by LocalHost (port/src/host.js), and
port/build.py inlines it with the client into port/dist/millbrook.html. These tests check:

* node parity: the Rng(7920) vector and every Rng helper; the seed-1 city equals tests/fixtures/city_seed1.json,
  tiles_sha1 included; the recursive key sets of LocalHost's welcome, state, stats, agent and home messages
  equal the Python server's for seed 1, at the start and after a game day; LocalHost answers odd God messages
  as GameServer does; with the same dice the two engines live the same days (plain, in debt, with friendships
  and rifts, with the ambulance, with taxis): event for event, fork for fork with each fork's options and scores,
  everyone's tile and bus each minute, down to the stats pushes' samples and the final stats message;
  chronicle.on_affinity's rule case by case; the stats cadence with nobody watching;
* a 3-day JS run of the 60 people through LocalHost raises nothing and every fork has four options;
* the build reads its stylesheets and scripts from client/index.html (today's, and one in the PLAN 3.12 order),
  and the page it writes has no http(s):// URL and no href="character.html;
* when Playwright and Chromium are present, the built page runs: a person opens, with no character.html link and
  no console errors.

The node tests skip when node is absent; the browser check skips without Playwright or a browser. The browser check
and the 10-day and 8-day lockstep runs (about 17 s together) run only with GOAL_SLOW=1.
"""

from __future__ import annotations

import collections
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from gameofailife.rng import Rng, r2
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
PORT = ROOT / "port"
PARITY = PORT / "tools" / "parity.cjs"
PAGE_CHECK = PORT / "tools" / "page_check.cjs"
CLIENT = ROOT / "client"
FIXTURE = ROOT / "tests" / "fixtures" / "city_seed1.json"
NODE = os.environ.get("NODE") or shutil.which("node")
BROWSERS = "/opt/pw-browsers"

needs_node = unittest.skipUnless(NODE, "node is not installed")
# The longest runs (about 17 s together) run with GOAL_SLOW=1, like the city view's browser run and the housing soak.
slow = unittest.skipUnless(os.environ.get("GOAL_SLOW") == "1", "runs with GOAL_SLOW=1")

# PLAN 3.12: what client/index.html loads, in this order.
PLAN_STYLES = ["style.css", "view/view.css", "dashboard.css"]
PLAN_SCRIPTS = [f"view/{name}.js" for name in ("proj", "art", "buildings", "actors", "scene", "movers", "camera",
                                                "minimap", "view")] + ["dashboard.js", "game.js"]

# PLAN 3.8: the `stats` message's shape, which LocalHost's must have as well as Python's.
_COUNTERS = {"asked": 0, "in_time": 0, "timeouts": 0, "late": 0, "withdrawn": 0, "against_habit": 0,
             "avg_seconds": 0.0}
STATS_SCHEMA = {
    "type": "stats", "full": False, "tick": 0, "time": "", "day": 0,
    "city": {"population": 0, "start_population": 0, "deaths": 0, "births": 0, "adults": 0, "children": 0,
             "working": 0, "students": 0, "retired": 0, "out_of_work": 0, "mood": 0, "health": 0,
             "needs": {"hunger": 0, "energy": 0, "social": 0, "fun": 0},
             "wealth": {"total": 0, "median": 0, "top10_share": 0, "gini": 0.0, "in_debt": 0},
             "homes": {"total": 0, "owned": 0, "rented": 0, "for_sale": 0, "for_rent": 0, "lots_by_stage": [0],
                       "neglected_lived_in": 0},
             "luck": {"touched": 0, "raised": 0, "lowered": 0, "mean": 0},
             "recent_deaths": [{"id": "", "name": "", "age": 0, "time": "", "how": ""}]},
    "llm": {"controllers": [{"name": "", "model": "", "characters": 0}], "playing": 0, "thinking": 0,
            "today": _COUNTERS, "total": _COUNTERS, "habit_today": 0, "default_today": 0},
    "districts": [{"id": "", "name": "", "people": 0, "mood": 0, "median_worth": 0, "homes": 0, "vacant": 0,
                   "shabby_plus": 0}],
    "households": [{"id": "", "name": "", "members": [""], "home": "", "home_name": "", "place": "",
                    "tier_label": "", "tenure": "", "weekly_cost": 0}],
    "people": [{"id": "", "household": "", "worth": 0, "worth_24h": 0, "cash": 0, "savings": 0, "home_equity": 0,
                "job": "", "health": 0, "llm": 0}],
    "samples": [{"tick": 0, "day": 0, "pop": 0, "mood": 0, "health": 0, "wealth": 0, "median": 0, "top10": 0,
                 "in_debt": 0, "working": 0, "owned": 0, "shabby_plus": 0, "asked": 0, "in_time": 0}],
}
DECISIONS_KEYS = {"type", "agent_id", "forks", "more"}  # PLAN 3.9


def node(*args: object, timeout: float = 300) -> dict | list:
    run = subprocess.run([NODE, str(PARITY), *map(str, args)], capture_output=True, text=True, timeout=timeout)
    if run.returncode:
        raise AssertionError(f"parity.cjs {' '.join(map(str, args))} failed:\n{run.stderr}")
    return json.loads(run.stdout)


def _load_build():
    spec = importlib.util.spec_from_file_location("port_build", PORT / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = _load_build()


# --- recursive key sets ---------------------------------------------------------------------------------------

def key_paths(x, root: str = "$", rename: set[str] = frozenset()) -> tuple[set[str], set[str]]:
    """(every key path, the paths whose value is null). A list's items share the path "<list>[]"; a dict key in
    `rename` (agent ids, which differ between runs) becomes "<id>"."""
    paths, nulls = set(), set()

    def walk(v, p):
        if v is None:
            nulls.add(p)
        elif isinstance(v, dict):
            for k, w in v.items():
                q = f"{p}.{'<id>' if k in rename else k}"
                paths.add(q)
                walk(w, q)
        elif isinstance(v, list):
            for w in v:
                paths.add(p + "[]")
                walk(w, p + "[]")

    walk(x, root)
    return paths, nulls


def _ancestors(path: str) -> list[str]:
    out, i = [], len(path)
    while True:
        j = max(path.rfind(".", 0, i), path.rfind("[]", 0, i))
        if j <= 0:
            return out
        out.append(path[:j + 2] if path.startswith("[]", j) else path[:j])
        i = j


def key_diff(a, b, rename: set[str] = frozenset()) -> tuple[list[str], list[str]]:
    """The key paths only `a` has and only `b` has. A path under a list that is empty on the other side, or under
    a value that is null there, is not a difference: what the dice made happen is not the shape."""
    pa, na = key_paths(a, rename=rename)
    pb, nb = key_paths(b, rename=rename)

    def real(p, other, other_nulls):
        return not any((x.endswith("[]") and x not in other) or x in other_nulls for x in _ancestors(p))

    return sorted(p for p in pa - pb if real(p, pb, nb)), sorted(p for p in pb - pa if real(p, pa, na))


def python_messages(seed: int = 1, days: float = 0) -> dict:
    """What the Python server sends a God view of the same city, built the way GameServer builds it."""
    sim = Simulation(seed=seed)
    if days:
        sim.run_days(days)
    server = GameServer(sim, speed=16)
    welcome = server._welcome_god()
    welcome["req_id"] = 1  # GameServer._reply echoes the hello's req_id, as the JS hello carried one
    sim.step()
    events, forks, _ = sim.drain()
    state = sim.state_json(housing=False)
    state.update(server._housing_changes())
    out = {"welcome": welcome,
           "state": {"type": "state", "speed": server.speed, "state": state, "events": events, "forks": forks},
           "agent": server._god({"type": "get_agent", "agent_id": "dana"}),
           "home": server._god({"type": "get_home", "home_id": "main_20"}),
           "stats": server._god({"type": "get_stats"}),
           "decisions": server._god({"type": "get_decisions", "limit": 5}),
           "agent_ids": list(sim.agents)}
    return json.loads(json.dumps(out))


# Hand-written God messages with values the dashboard never sends: numbers as strings, out-of-range traits, and
# the bare NaN and Infinity that Python's json.loads reads (JSON.parse does not).
ODD_GOD_TEXTS = [
    json.dumps({"type": "set_profile", "agent_id": "dana", "traits": {"thrift": "nan"}}),
    json.dumps({"type": "set_profile", "agent_id": "dana", "traits": {"social": "-inf", "health": "2"}}),
    '{"type": "set_profile", "agent_id": "dana", "traits": {"family": NaN, "adventure": Infinity, "diligence": -Infinity}}',
    '{"type": "set_profile", "agent_id": "dana", "traits": {"thrift": 1e999}, "req_id": 3}',
    '{"type": "set_luck", "agent_id": "dana", "luck": NaN}',
    '{"type": "set_luck", "agent_id": "dana", "luck": -Infinity}',
    json.dumps({"type": "set_luck", "agent_id": "dana", "luck": "nan"}),
    '{"type": "set_speed", "speed": NaN}',
    '{"type": "set_speed", "speed": Infinity}',
    '{"type": NaN}',
    '{"type": "get_agent", "agent_id": NaN}',
    '[NaN]',
    'NaN',
    '{"type": "pause", "x": -NaN}',
    '{"type": "pause", "x": +Infinity}',
]


def python_god(seed: int, texts: list[str]) -> list:
    """parity.cjs `god` in Python: GameServer's replies to a God view's raw messages, read and answered the way
    its message loop does, then the luck sim.set_luck("dana", "nan") leaves."""
    sim = Simulation(seed=seed)
    server = GameServer(sim, speed=16)
    out = []
    for text in texts:
        try:
            msg = json.loads(text)
        except (ValueError, RecursionError):
            out.append({"type": "error", "error": "messages must be JSON"})
            continue
        if not isinstance(msg, dict):
            out.append({"type": "error", "error": "messages must be JSON objects"})
            continue
        try:
            reply = server._god(msg)
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
            reply = {"type": "error", "error": f"bad message: {exc}"}
        if "req_id" in msg:
            reply["req_id"] = msg["req_id"]
        out.append(json.loads(json.dumps(reply)))  # written when sent, as _reply does: the profile is live
    sim.set_luck("dana", "nan")
    out.append({"direct_luck": sim.agents["dana"].luck})
    return out


# --- node parity --------------------------------------------------------------------------------------------

@needs_node
class RngParity(unittest.TestCase):
    def test_rng_7920_vector(self):
        js = node("rng", 7920, 3)
        self.assertEqual([f"{u:.12f}" for u in js], ["0.166736019310", "0.824670854257", "0.208481384674"])
        py = Rng(7920)
        self.assertEqual(js, [py.random() for _ in range(3)])

    def test_long_streams_and_wrapped_seeds_are_bit_identical(self):
        for seed in (1, 7920, 2 ** 32 + 5, 4294967295):
            py = Rng(seed)
            self.assertEqual(node("rng", seed, 500), [py.random() for _ in range(500)], seed)

    def test_every_helper_draws_the_same(self):
        js = node("dice", 99)
        rng = Rng(99)
        items = list(range(10))
        py = {"random": [rng.random() for _ in range(5)], "int": [rng.int(-4, 4) for _ in range(5)],
              "uniform": [rng.uniform(60, 90) for _ in range(5)], "pick": [rng.pick(items) for _ in range(5)]}
        rng.shuffle(items)
        py["shuffle"] = items
        py["r2"] = [r2(u) for u in py["uniform"]]
        self.assertEqual(js, py)


@needs_node
class GoldenCity(unittest.TestCase):
    def test_seed_1_city_equals_the_fixture(self):
        js = node("golden", 1)
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual(js["tiles_sha1"], fixture["tiles_sha1"])
        self.assertEqual(len(js["people"]), 60)
        for got, want in zip(js["people"], fixture["people"]):
            self.assertEqual(got, want)
        self.assertEqual(js, fixture)


@needs_node
class MessageSchemas(unittest.TestCase):
    """The recursive key sets of LocalHost's messages equal the Python server's, for seed 1."""

    @classmethod
    def setUpClass(cls):
        cls.js = node("messages", 1, 0)
        cls.py = python_messages(1, 0)
        cls.js_day = node("messages", 1, 1)
        cls.py_day = python_messages(1, 1)

    def assertSameKeys(self, js, py, what, rename=frozenset()):
        only_js, only_py = key_diff(js, py, rename)
        self.assertEqual((only_js, only_py), ([], []), f"{what}: keys only in JS / only in Python")

    def test_welcome(self):
        self.assertSameKeys(self.js["welcome"], self.py["welcome"], "welcome")
        self.assertSameKeys(self.js["welcome"]["stats"], STATS_SCHEMA, "welcome.stats against PLAN 3.8")
        self.assertIs(self.js["welcome"]["stats"]["full"], True)
        self.assertEqual(self.js["welcome"]["host"], {"kind": "browser", "controllers": False})
        self.assertEqual(self.js["welcome"]["req_id"], 1)

    def test_state(self):
        frame = self.js["state"]
        self.assertSameKeys(frame, self.py["state"], "state")
        self.assertIn("lots", frame["state"])  # the first frame after a welcome carries the housing maps
        self.assertEqual(len(frame["state"]["agents"]), 60)

    def test_stats(self):
        want = self.py["stats"]
        self.assertSameKeys(self.js["get_stats"], want, "get_stats")
        self.assertSameKeys(self.js["stats"], want, "stats push")
        self.assertSameKeys(self.js["get_stats"], STATS_SCHEMA, "get_stats against PLAN 3.8")
        self.assertIs(self.js["get_stats"]["full"], True)
        self.assertIs(self.js["stats"]["full"], False)
        self.assertEqual(self.js["get_stats"]["city"]["population"], 60)

    def test_agent(self):
        self.assertSameKeys(self.js["agent"], self.py["agent"], "agent")
        self.assertEqual(self.js["agent"]["agent"]["id"], "dana")

    def test_home(self):
        self.assertSameKeys(self.js["home"], self.py["home"], "home")
        self.assertEqual(self.js["home"]["home"]["id"], "main_20")

    def test_decisions(self):
        for reply in (self.js["decisions"], self.js["decisions_agent"]):
            self.assertEqual(set(reply), DECISIONS_KEYS)
            self.assertEqual(reply["type"], "decisions")
        self.assertIsNone(self.js["decisions"]["agent_id"])
        self.assertEqual(self.js["decisions_agent"]["agent_id"], "dana")
        self.assertSameKeys(self.js["decisions"], self.py["decisions"], "decisions")

    def test_after_a_day(self):
        js, py = self.js_day, self.py_day
        ids = set(js["agent_ids"]) | set(py["agent_ids"])
        self.assertSameKeys(js["welcome"], py["welcome"], "welcome after a day", ids)
        self.assertSameKeys(js["state"], py["state"], "state after a day", ids)
        self.assertSameKeys(js["agent"], py["agent"], "agent after a day", ids)
        self.assertSameKeys(js["get_stats"], py["stats"], "stats after a day", ids)
        self.assertSameKeys(js["get_stats"], STATS_SCHEMA, "stats after a day against PLAN 3.8")
        pushed = js["stats"]["samples"]  # the first push carries every sample so far: one per whole hour
        self.assertGreaterEqual(len(pushed), 24)
        self.assertEqual(pushed, js["get_stats"]["samples"][:len(pushed)])
        self.assertTrue(js["agent"]["agent"]["forks"], "Dana decided nothing in a day")

    def test_god_replies(self):
        js = self.js
        self.assertEqual(js["errors"], {
            "unknown_agent": {"type": "error", "error": "unknown character"},
            "unknown_home": {"type": "error", "error": "unknown home"},
            "unknown_decisions": {"type": "error", "error": "unknown character"},
            "bad_luck": {"type": "error", "error": "bad message: luck must be a number"},
            "unknown_type": {"type": "error", "error": "unknown message type 'fly'"},
        })
        self.assertEqual(js["luck"], {"type": "luck_set", "ok": True, "agent_id": "dana", "luck": 80.0, "req_id": "r1"})
        self.assertEqual([js["speed"], js["pause"], js["resume"]],
                         [{"type": "speed", "speed": 4}, {"type": "speed", "speed": 0}, {"type": "speed", "speed": 1}])
        self.assertEqual(js["profile"]["agent"]["profile"]["traits"]["thrift"], 0.9)

    def test_god_replies_to_odd_values(self):
        # Python clamps with min/max, where min(1.0, nan) is 1.0; Math.min would give NaN and a NaN trait would
        # make every later fork score of the character NaN.
        js = node("god", 1, json.dumps(ODD_GOD_TEXTS))
        py = python_god(1, ODD_GOD_TEXTS)
        self.assertEqual(len(js), len(py))
        for text, got, want in zip(ODD_GOD_TEXTS + ['sim.set_luck("dana", "nan")'], js, py):
            self.assertEqual(got, want, text)
        profile = js[0]["agent"]["profile"]
        self.assertEqual(profile["traits"]["thrift"], 1.0)
        self.assertIn("careful with money", profile["prompt"].lower())
        traits = js[2]["agent"]["profile"]["traits"]
        self.assertEqual([traits["family"], traits["adventure"], traits["diligence"]], [1.0, 1.0, 0.0])
        self.assertEqual(js[4], {"type": "error", "error": "bad message: luck must be a number"})
        self.assertEqual(js[7], {"type": "error", "error": "bad message: cannot convert float NaN to integer"})
        self.assertEqual(js[9], {"type": "error", "error": "unknown message type nan"})
        self.assertEqual(js[-1], {"direct_luck": 100.0})

    def test_sessions(self):
        p = self.js["protocol"]
        self.assertEqual(p["not_json"], {"type": "error", "error": "messages must be JSON"})
        self.assertEqual(p["not_object"], {"type": "error", "error": "messages must be JSON objects"})
        self.assertEqual(p["before_hello"], {"type": "error", "error": "say hello first", "req_id": 7})
        self.assertEqual(p["demoted"], {"type": "demoted", "reason": "another God view took over"})
        self.assertEqual(p["watcher_luck"], {"type": "error", "error": "only God can do that; this view is watching"})
        self.assertEqual(p["watcher_agent"], "agent")
        self.assertEqual(p["controller"]["type"], "error")
        self.assertTrue(p["controller_closed"])


class MulberryDice:
    """port/src/sim.js's SimDice for the Python engine: random.Random's four helpers the simulation uses, drawn
    from mulberry32 the way the JS port draws them."""

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
        super().__init__(seed=seed)

    def _roll_weather(self) -> None:
        if not isinstance(self.rng, MulberryDice):
            self.rng = MulberryDice(self._dice)
        super()._roll_weather()


def python_trace(seed: int, days: int, dice: int, scenario: str = "") -> dict:
    """parity.cjs `trace` in Python: every event and decided fork, each fork's options and scores as the Director gets
    it, a checksum of everyone's tile and who rides which bus each minute, every agent at each whole hour, the
    samples a stats push would carry at each midnight, and the full stats message and the richest person at the end.
    """
    from gameofailife.agent import NEEDS
    from gameofailife.clock import MINUTES_PER_DAY

    sim = DiceSim(seed, dice)
    if scenario == "debt":
        for a in sim.agents.values():
            if a.is_adult:
                a.money, a.savings = -3000.0, 0.0
    if scenario == "bonds":
        from gameofailife.chronicle import FRIEND_AT, FRIENDS_FROM, RIFT_AT, RIFT_KINDS
        for a in sim.agents.values():
            for rel in a.relationships.values():
                if rel.kind.value in FRIENDS_FROM:
                    rel.affinity = FRIEND_AT - 1.0
                elif rel.kind.value in RIFT_KINDS:
                    rel.affinity = RIFT_AT + 1.0
    if scenario == "ill":
        for i, a in enumerate(sim.agents.values()):
            if i % 5 == 0:
                a.health = 20.0
    if scenario == "taxi":
        for i, a in enumerate([a for a in sim.agents.values() if a.job and a.job.hourly_wage > 0]):
            if i % 2 == 0:
                sim.start_plan(a, [("work", "job")], "taxi")
    out = {"events": [], "forks": [], "hours": [], "pushes": [], "ticks": [], "asked": []}
    agents = list(sim.agents.values())
    director = sim.director

    def asked(agent, fork):
        options = sim.fork_message(agent, fork)["options"]
        result = director(agent, fork)
        out["asked"].append([fork.kind, options, fork.scores])
        return result

    sim.director = asked

    def drain():
        events, forks, _ = sim.drain()
        out["events"] += [f"{e['tick']} {e['tag']} {e['text']}" for e in events]
        out["forks"] += [f"{f['tick']} {f['id']} {f['agent']} {f['kind']} {f['choice']} {f['decided_by']} "
                         f"{'|'.join(f['happened'])}" for f in forks]

    drain()
    end = sim.clock.tick + days * MINUTES_PER_DAY
    while sim.clock.tick < end:
        sim.step()
        drain()
        where = sum((i + 1) * (a.x * 131 + a.y) for i, a in enumerate(agents))
        out["ticks"].append(f"{sim.clock.tick} {where} " + ",".join(f"{a.id}@{a.riding}" for a in agents if a.riding))
        if sim.clock.minute_of_day % 60 == 0:
            out["hours"].append([sim.clock.tick, [
                [a.id, a.x, a.y, a.state, a.activity, a.inside, round(a.money, 2), round(a.savings, 2),
                 round(a.health, 2), [round(a.needs[n], 2) for n in NEEDS], a.household_id,
                 sim.households[a.household_id].home_id, a.vehicle, a.riding, a.trip["phase"] if a.trip else None]
                for a in sim.agents.values()]])
        if sim.clock.minute_of_day == 0:
            out["pushes"].append(sim.stats_json(full=False)["samples"])
    out["stats"] = sim.stats_json(full=True)
    out["richest"] = sim.stats.richest
    return json.loads(json.dumps(out))


@needs_node
class LockstepRun(unittest.TestCase):
    """With the same dice, the two engines live the same days: every event, decision and hourly position.

    The Python engine is given the JS port's dice (DiceSim), so any difference is a porting difference. Fork ids
    are compared by order: Python numbers them from a counter shared by every Simulation in the process.
    """

    def assertLockstep(self, seed, days, dice, scenario=""):
        js = node("trace", seed, days, dice, "-", scenario)
        py = python_trace(seed, days, dice, scenario)
        ids = lambda rows: [re.sub(r" f\d+ ", " f# ", r, count=1) for r in rows]  # noqa: E731
        for name, a, b in (("events", py["events"], js["events"]), ("forks", ids(py["forks"]), ids(js["forks"])),
                           ("minutes", py["ticks"], js["ticks"])):
            at = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            self.assertEqual(a[at:at + 1], b[at:at + 1], f"{name} differ first at #{at} (Python first)")
            self.assertEqual(len(a), len(b), f"{name}: Python has {len(a)}, JS {len(b)}")
        for i, (got, want) in enumerate(zip(js["asked"], py["asked"])):
            self.assertEqual(got, want, f"fork #{i} offered to the Director differs (JS first)")
        self.assertEqual(len(js["asked"]), len(py["asked"]))
        for (tick, rows), (_, js_rows) in zip(py["hours"], js["hours"]):
            js_rows = [json.loads(r) for r in js_rows.split(";")]
            for row, js_row in zip(rows, js_rows):
                self.assertEqual(js_row, row, f"tick {tick}: {row[0]} differs (JS first)")
        self.assertEqual(len(py["hours"]), len(js["hours"]))
        self.assertGreater(len(py["forks"]), 100)
        # God's dashboard: each push's samples (each sample in one push only), then the whole stats message.
        self.assertEqual(len(js["pushes"]), len(py["pushes"]))
        for day, (got, want) in enumerate(zip(js["pushes"], py["pushes"]), 1):
            self.assertEqual(got, want, f"the stats push at midnight {day} carries other samples")
        pushed = [s["tick"] for push in py["pushes"] for s in push]  # every whole hour once, up to the last midnight
        self.assertEqual(pushed, [t for t, _ in py["hours"]][:len(pushed)])
        self.assertEqual(pushed[-1] % (24 * 60), 0)
        for key in py["stats"]:
            self.assertEqual(js["stats"][key], py["stats"][key], f"stats.{key} differs (JS first)")
        self.assertEqual(js["stats"], py["stats"])
        self.assertEqual(js["richest"], py["richest"])
        self.assertIsNotNone(py["richest"])
        return js, py

    def tags(self, trace):
        return collections.Counter(e.split(" ", 2)[1] for e in trace["events"])

    def riders(self, trace):
        return collections.Counter(r.split("@")[0] for t in trace["ticks"] for r in t.split(" ", 2)[2].split(",") if r)

    def test_three_days(self):
        js, py = self.assertLockstep(1, 3, 5)
        self.assertGreater(len(self.riders(py)), 3)  # people ride the buses ...
        self.assertTrue(any(r[12] == "car" for _, rows in py["hours"] for r in rows))  # ... and drive

    def test_four_days_with_the_ambulance(self):
        # Every fifth character starts at health 20: the ambulance (free, on the roads, no lights) takes them in,
        # they walk home after, and the hospital's fee is paid.
        js, py = self.assertLockstep(1, 4, 1, "ill")
        tags = self.tags(py)
        self.assertGreaterEqual(tags["hospital"], 12)
        self.assertGreaterEqual(tags["discharged"], 12)

    def test_a_day_with_taxis(self):
        # Every other worker takes a taxi to work at the start: on the roads, waiting at red lights, then on foot.
        js, py = self.assertLockstep(1, 1, 6, "taxi")
        first_hour = py["hours"][0][1]  # 07:00: every taxi has arrived and gone, so its riders are on foot again
        self.assertEqual([r[0] for r in first_hour if r[12] == "taxi"], [])

    @slow
    def test_ten_days_in_debt(self):
        # Every adult starts $3,000 in debt: the Sunday charges, arrears, hardship and the housing extras.
        js, py = self.assertLockstep(1, 10, 2, "debt")
        self.assertGreater(self.tags(py)["richest"], 0)  # a new richest person makes a headline
        self.assertEqual(len(py["stats"]["samples"]), 168)  # 7 days of hourly samples are kept, no more

    @slow
    def test_eight_days_of_friendships_and_rifts(self):
        # Every acquaintance and coworker starts one point short of a friendship, every friend and partner one
        # point from a falling-out: chronicle.on_affinity's both rules, and its 7-day gap between rifts.
        js, py = self.assertLockstep(1, 8, 2, "bonds")  # dice 2: rifts on this tree (dice 4 has none since the v2 review fixes)
        tags = self.tags(py)
        self.assertGreater(tags["new_friend"], 0)
        self.assertGreater(tags["falling_out"], 0)


DAY = 24 * 60
# chronicle.on_affinity's cases, as [a_id, b_id, before, after, tick, kind_ab, kind_ba] (see parity.cjs affinity).
AFFINITY_STEPS = [
    ["dana", "omer", 39, 40, 1000, None, None],  # coworkers rise to 40: friends, both sides
    ["dana", "omer", 0.5, -0.5, 1100, None, None],  # friends drop below 0: a falling-out
    ["omer", "dana", 0, -1, 1100 + 6 * DAY, None, None],  # the same pair from the other side, 6 days on: no rift
    ["dana", "omer", 0, -2, 1100 + 7 * DAY - 1, None, None],  # a minute short of 7 days: still none
    ["dana", "omer", 0, -2, 1100 + 7 * DAY, None, None],  # 7 days on: the next falling-out
    ["dana", "sara", 30, 45, 1200, None, "family"],  # the other side is family: it stays family
    ["dana", "lina", 39.9, 40, 1300, None, "-"],  # no relationship back: only dana's side becomes a friend
    ["dana", "yossi", 0, -0.1, 1400, None, None],  # partners fall out and stay partners
    ["dana", "noa", 0, -5, 1500, None, None],  # family never falls out ...
    ["dana", "noa", 39, 41, 1600, None, None],  # ... nor becomes a friend
    ["dana", "nobody", 39, 41, 1700, None, None],  # an unknown character: nothing
    ["nobody", "dana", 0, -1, 1700, None, None],
    ["dana", "gal", 41, 39, 1800, None, None],  # a friend still at or above 0: nothing
    ["dana", "ari", -1, -2, 1900, None, None],  # already below 0: no new falling-out
    ["yossi", "rina", 40, 41, 2000, None, None],  # a coworker already at 40: no new friendship
    ["yossi", "rina", 38, 39.99, 2100, None, None],  # ... nor one still short of it
    ["noa", "amira", 39, 40, 2200, "acquaintance", "acquaintance"],  # acquaintances become friends too
    ["amira", "noa", 0, -1, 2300, None, None],  # and new friends can fall out
]


def python_affinity(seed: int, steps: list) -> list:
    """parity.cjs `affinity` in Python: chronicle.on_affinity on the same scripted bumps."""
    from gameofailife import chronicle
    from gameofailife.agent import RelationKind

    sim = Simulation(seed=seed)
    sim.drain()

    def rel(x, y):
        return sim.agents[x].relationships.get(y) if x in sim.agents else None

    out = []
    for a_id, b_id, before, after, tick, kind_ab, kind_ba in steps:
        sim.clock.tick = tick
        if kind_ab:
            rel(a_id, b_id).kind = RelationKind(kind_ab)
        if kind_ba == "-":
            del sim.agents[b_id].relationships[a_id]
        elif kind_ba:
            rel(b_id, a_id).kind = RelationKind(kind_ba)
        if rel(a_id, b_id):
            rel(a_id, b_id).affinity = after
        chronicle.on_affinity(sim, a_id, b_id, before, after)
        events, _, _ = sim.drain()
        b = sim.agents.get(b_id)
        out.append({"events": [[e["tick"], e["tag"], e["importance"], e["text"], e["agent"], e["agents"], e["place"]]
                               for e in events],
                    "kinds": [r.kind.value if (r := rel(a_id, b_id)) else None,
                              r.kind.value if (r := rel(b_id, a_id)) else None],
                    "memory": (b.memory[-1] if b.memory else None) if b else None})
    out.append({"rifts": sorted([k, v] for k, v in getattr(sim, "_rifts", {}).items())})
    return json.loads(json.dumps(out))


def python_quiet(seed: int, frames: int) -> dict:
    """parity.cjs `quiet` in Python, up to the God view: GameServer's frames on a hand-driven monotonic clock, in a
    city rolling the JS port's dice (a major event brings a push forward, so the events must be the same)."""
    from unittest import mock

    from gameofailife import server as py_server
    from gameofailife.clock import TICKS_PER_REAL_SECOND

    clock = [1000.0]
    with mock.patch.object(py_server, "time", mock.Mock(monotonic=lambda: clock[0])):
        sim = DiceSim(seed, seed)
        server = GameServer(sim, speed=16)
        for _ in range(frames):  # GameServer._run's loop, without the sleep
            clock[0] += py_server.FRAME_SECONDS
            server._pending_ticks += py_server.FRAME_SECONDS * TICKS_PER_REAL_SECOND * server.speed
            stepped = False
            while server._pending_ticks >= 1:
                server._pending_ticks -= 1
                sim.step()
                stepped = True
            server._flush(stepped)
    return {"tick": sim.clock.tick, "samples": len(sim.stats.samples), "pushed": sim.stats._pushed,
            "stats_at": server._stats_at}


@needs_node
class StatsCadence(unittest.TestCase):
    def test_pushes_with_nobody_watching(self):
        # 1,000 frames at speed 16 is about 32 game hours and 16 pushes that fall due with no view to take them.
        js = node("quiet", 1, 1000)
        py = python_quiet(1, 1000)
        self.assertEqual({k: js[k] for k in py}, py)
        self.assertGreater(py["pushed"], 0)  # the samples went to nobody ...
        self.assertEqual(len(js["welcome_samples"]), js["samples"])  # ... the welcome has them all ...
        self.assertTrue(js["push_samples"])  # ... and the view's first push only what came after
        self.assertEqual(js["push_samples"][0], js["pushed"] + 60)


@needs_node
class FriendshipRule(unittest.TestCase):
    """chronicle.on_affinity, the friendship and falling-out rule P3 added, case by case in both engines."""

    def test_scripted_bumps(self):
        js = node("affinity", 1, json.dumps(AFFINITY_STEPS))
        py = python_affinity(1, AFFINITY_STEPS)
        self.assertEqual(len(js), len(py))
        for step, got, want in zip(AFFINITY_STEPS + ["rifts"], js, py):
            self.assertEqual(got, want, step)
        tags = [[e[1] for e in row["events"]] for row in py[:-1]]
        self.assertEqual(tags, [["new_friend"], ["falling_out"], [], [], ["falling_out"], ["new_friend"],
                                ["new_friend"], ["falling_out"], [], [], [], [], [], [], [], [],
                                ["new_friend"], ["falling_out"]])
        self.assertEqual(py[0]["kinds"], ["friend", "friend"])
        self.assertEqual(py[5]["kinds"], ["friend", "family"])
        self.assertEqual(py[6]["kinds"], ["friend", None])
        self.assertEqual(py[7]["kinds"], ["partner", "partner"])
        self.assertEqual(py[-1]["rifts"], [["amira|noa", 2300], ["dana|omer", 1100 + 7 * DAY], ["dana|yossi", 1400]])


@needs_node
class ThreeDayRun(unittest.TestCase):
    def test_sixty_people_three_days_four_options_each(self):
        got = node("run", 1, 3, 1)
        self.assertEqual(got["people"], 60)
        self.assertEqual(got["bad"], [])
        self.assertGreater(got["forks"], 300)
        self.assertGreaterEqual(got["ticks"], 5 * 60 + 3 * 24 * 60)  # the world starts on Monday at 05:00
        self.assertGreater(got["states"], 0)
        self.assertGreater(got["stats_pushes"], 0)
        for kind in ("work", "hunger", "sleep", "free_time"):
            self.assertIn(kind, got["kinds"])


# --- the sources ----------------------------------------------------------------------------------------------

class PortSources(unittest.TestCase):
    SRC = PORT / "src"

    def spec(self) -> dict:
        return json.loads((self.SRC / "engine.json").read_text())

    def test_engine_json_lists_every_script_once(self):
        listed = [name for group in self.spec().values() for name in group]
        self.assertEqual(sorted(listed), sorted(p.name for p in self.SRC.glob("*.js")))
        self.assertEqual(len(listed), len(set(listed)))

    def test_one_engine_file_per_python_module(self):
        for name in self.spec()["engine"]:
            if name != "py.js":  # Python's own semantics (round, sorted, str.split, ...): no twin
                self.assertTrue((ROOT / "gameofailife" / name.replace(".js", ".py")).is_file(), name)

    def test_classic_scripts_on_one_namespace(self):
        module = re.compile(r"^\s*(import\s.+\sfrom\s|import\s*['\"]|export\s)", re.M)
        for path in self.SRC.glob("*.js"):
            text = path.read_text()
            self.assertIsNone(module.search(text), f"{path.name} uses ES module syntax")
            self.assertIsNone(re.search(r"https?://", text), f"{path.name} has a URL")
            code = re.sub(r"^\s*//.*\n", "", text, flags=re.M).strip()
            self.assertTrue(code.startswith("(function ("), f"{path.name} is not wrapped in a function")
            self.assertRegex(code, r"\}\)\((globalThis\.GameOfAILife \|\| \(globalThis\.GameOfAILife = \{\}\)|"
                                   r"typeof window !== \"undefined\" \? window : globalThis)\);$", path.name)


# --- the build ------------------------------------------------------------------------------------------------

def plan_index(text: str) -> str:
    """Today's index.html with its stylesheets and scripts replaced by the PLAN 3.12 list (the same page once P3
    lands)."""
    text = re.sub(r'[ \t]*<link rel="stylesheet"[^>]*>\n?', "", text)
    text = re.sub(r'[ \t]*<script src="[^"]*"></script>\n?', "", text)
    text = text.replace("</head>", "".join(f'  <link rel="stylesheet" href="{h}">\n' for h in PLAN_STYLES) + "</head>")
    return text.replace("</body>", "".join(f'  <script src="{s}"></script>\n' for s in PLAN_SCRIPTS) + "</body>")


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="port-build-")
        tmp = Path(cls.tmp.name)
        cls.today = build.build(CLIENT / "index.html", tmp / "today.html")
        cls.plan_index = tmp / "index.html"
        cls.plan_index.write_text(plan_index((CLIENT / "index.html").read_text()))
        cls.plan = build.build(cls.plan_index, tmp / "plan.html", CLIENT)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def pages(self):
        return [(got, Path(got["out"]).read_text(encoding="utf-8")) for got in (self.today, self.plan)]

    def test_lists_come_from_index_html(self):
        text = (CLIENT / "index.html").read_text()
        styles = re.findall(r'<link rel="stylesheet" href="([^"]+)"', text)
        scripts = re.findall(r'<script src="([^"]+)"', text)
        self.assertEqual((self.today["styles"], self.today["scripts"]), (styles, scripts))
        self.assertEqual((self.plan["styles"], self.plan["scripts"]), (PLAN_STYLES, PLAN_SCRIPTS))

    def test_everything_is_inlined_in_order(self):
        for got, page in self.pages():
            self.assertNotRegex(page, r"<script[^>]*\ssrc=")
            self.assertNotRegex(page, r"<link[^>]*stylesheet")
            names = re.findall(r'<(?:script data-src|style data-href)="([^"]+)"', page)
            port = [f"port/{name}" for name in got["port"]]
            self.assertEqual(names, got["styles"] + port + got["scripts"])
            self.assertEqual(port[0], "port/guard.js")
            self.assertEqual(port[-2:], ["port/host.js", "port/page.js"])
            for url in got["styles"] + got["scripts"]:
                body = (CLIENT / url).read_text(encoding="utf-8")
                body = re.sub(r"</(script|style)", r"<\\/\1", body, flags=re.I)
                self.assertIn(body.replace('href="character.html', 'hidden data-page="character.html'), page, url)

    def test_no_external_urls(self):
        for got, page in self.pages():
            self.assertIsNone(re.search(r"https?://", page, re.I), got["out"])

    def test_no_character_page_links(self):
        for got, page in self.pages():
            self.assertNotIn('href="character.html', page)

    def test_an_external_asset_fails_the_build(self):
        tmp = Path(self.tmp.name)
        bad = tmp / "bad.html"
        bad.write_text(plan_index((CLIENT / "index.html").read_text())
                       .replace("</body>", '<script src="https://example.com/x.js"></script></body>'))
        with self.assertRaises(build.BuildError):
            build.build(bad, tmp / "bad-out.html", CLIENT)

    def test_default_build_writes_port_dist(self):
        run = subprocess.run(["python3", str(PORT / "build.py")], capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        page = (PORT / "dist" / "millbrook.html").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"https?://", page, re.I))
        self.assertNotIn('href="character.html', page)

    @slow
    @needs_node
    def test_page_runs_in_a_browser(self):
        env = dict(os.environ)
        if Path(BROWSERS).is_dir():
            env.setdefault("PLAYWRIGHT_BROWSERS_PATH", BROWSERS)
        for got, _ in self.pages():
            run = subprocess.run([NODE, str(PAGE_CHECK), got["out"]], capture_output=True, text=True, timeout=180,
                                 env=env)
            result = json.loads(run.stdout.strip().splitlines()[-1]) if run.stdout.strip() else {"error": run.stderr}
            if "skip" in result:
                self.skipTest(result["skip"])
            self.assertEqual(run.returncode, 0, f"{got['out']}: {result}")
            self.assertEqual(result["character_links"], 0)
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["external"], [])


if __name__ == "__main__":
    unittest.main()
