"""The townsfolk on the wire (folk.md 8 and 15, PLAN 2.9-2.11): a seed-1 region with 1,000 townsfolk, served.

One city runs a game day through GameServer's frame loop at speed 16 (the loop's arithmetic without its sleep, as
test_port's python_quiet does), with a God view that keeps every push; then two more days of plain steps. Checked:
the crowd invariant on every frame, `occ` and the region `lots`/`homes` cadence, folk `get_agent`, `set_luck` and
`get_folk`, the richest title and `stats.people` named-only, at most 60 folk-only News lines a day, the welcome
and `welcome.town` sizes, and the 60 staying in Millbrook for three days. TestPortKeys compares the recursive key
sets of the welcome, a frame, `stats`, `get_folk` and the pages with the JS port's LocalHost. TestFolkCityStats
checks that `stats.city` and `stats.districts` count the townsfolk's needs, luck, worths, retired and out of work,
with the same numbers in JS.
"""

from __future__ import annotations

import gc
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from gameofailife import people, server as py_server
from gameofailife.clock import MINUTES_PER_DAY, TICKS_PER_REAL_SECOND
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
FOLK = 1000
WELCOME_MAX, TOWN_MAX = 550 * 1024, 320 * 1024  # PLAN 2.11: json.dumps bytes, default separators
FOLK_NEWS_CAP = 60
ROSTER_KEYS = {"i", "id", "name", "age", "child", "hh", "home", "place", "district", "job", "work", "alive"}
MILLBROOK = (0, 0, 80, 50)  # the named's rectangle: x in [0, 80), y in [0, 50)


class Viewer:
    """GameServer's God socket as the frame loop sees it: every push it is sent, decoded."""

    def __init__(self) -> None:
        self.got: list[dict] = []


def serve_frames(server: GameServer, view: Viewer, ticks: int, every_frame=None) -> int:
    """GameServer._run's loop for `ticks` ticks on an on-time clock (frame_span(FRAME_SECONDS)), pushes to `view`."""
    sim = server.sim
    end = sim.clock.tick + ticks
    frames = 0
    while sim.clock.tick < end:
        server._pending_ticks += (py_server.frame_span(py_server.FRAME_SECONDS) * TICKS_PER_REAL_SECOND
                                  * server.speed)
        stepped = False
        while server._pending_ticks >= 1:
            server._pending_ticks -= 1
            sim.step()
            stepped = True
        server._flush(stepped)
        frames += 1
        if every_frame is not None:
            every_frame(frames)
    return frames


def god_server(sim: Simulation) -> tuple[GameServer, Viewer]:
    server = GameServer(sim, speed=16)
    view = Viewer()
    server.god = view
    server._push = lambda ws, text, inbox=None: ws.got.append(json.loads(text))
    return server, view


def folk_only(ev: dict) -> bool:
    ids = list(ev.get("agents") or [])
    if ev.get("agent"):
        ids.append(ev["agent"])
    return bool(ids) and all(people.is_folk_id(x) for x in ids)


class TestFolkProtocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim = sim = Simulation(1, world="region", folk=FOLK)
        cls.server, cls.view = server, view = god_server(sim)
        cls.welcome = server._welcome_god()
        cls.welcome_bytes = len(json.dumps(cls.welcome))
        cls.town_bytes = len(json.dumps(cls.welcome["town"]))
        print(f"\nregion welcome at folk {FOLK}: {cls.welcome_bytes / 1024:.0f} KB, town {cls.town_bytes / 1024:.0f} KB",
              flush=True)
        cls.bad_frames: list[tuple] = []
        cls.frames: list[dict] = []
        cls.positions: list[tuple] = []  # (tick, id, x, y, activity_place) of every named, hourly
        millbrook = sim.town.millbrook_ids

        def check(frame_no: int) -> None:
            pushed = [m for m in view.got if m["type"] == "state"]
            view.got[:] = [m for m in view.got if m["type"] != "state"]
            for msg in pushed:
                state = msg["state"]
                c = sim.folk.counts(sim)
                seen = len(state["crowd"]) // 4 + c["inside"] + c["aboard"] + c["passengers"]
                if seen != c["present"] or len(state["crowd"]) % 4:
                    cls.bad_frames.append((frame_no, state["tick"], seen, c))
                cls.frames.append({"no": frame_no, "tick": state["tick"], "keys": set(state),
                                   "occ": state.get("occ"), "events": msg["events"], "folk_n": state["folk_n"],
                                   "trains": len(state["trains"])})

        def hourly() -> None:
            if sim.clock.tick % 60 == 0:
                for a in sim.agents.values():
                    if a.alive:
                        cls.positions.append((sim.clock.tick, a.id, a.x, a.y, a.activity_place, a.inside))

        def every_frame(frame_no: int) -> None:
            check(frame_no)

        orig_step = sim.step

        def step() -> None:
            orig_step()
            hourly()
        sim.step = step
        cls.frame_count = serve_frames(server, view, MINUTES_PER_DAY, every_frame)
        cls.stats_pushes = [m for m in view.got if m["type"] == "stats"]
        cls.after_day = {
            "folk_page": server._god({"type": "get_agent", "agent_id": "f0"}),
            "named_page": server._god({"type": "get_agent", "agent_id": "dana"}),
            "get_folk": server._god({"type": "get_folk"}),
            "luck": server._god({"type": "set_luck", "agent_id": "f0", "luck": 30}),
            "bad_luck": server._god({"type": "set_luck", "agent_id": f"f{FOLK + 5}", "luck": 30}),
            "stats": server._god({"type": "get_stats"}),
        }
        for _ in range(2 * MINUTES_PER_DAY):  # two more days, plain steps (the named's rectangle check)
            sim.step()
        cls.millbrook = millbrook

    @classmethod
    def tearDownClass(cls):
        # A 1,000-townsfolk city and a day of frames: let them go, so later modules' CPU-per-tick gates do not pay
        # for collecting them.
        for name in ("sim", "server", "view", "welcome", "frames", "positions", "stats_pushes", "after_day"):
            setattr(cls, name, None)
        gc.collect()

    def test_the_crowd_invariant_holds_on_every_frame(self):
        self.assertGreater(len(self.frames), 600)
        self.assertEqual(self.bad_frames[:5], [])

    def test_every_frame_carries_the_v3_keys(self):
        for f in self.frames:
            self.assertLessEqual({"trains", "crowd", "folk_n", "talks"}, f["keys"])
            self.assertEqual(f["folk_n"], FOLK)
        self.assertTrue(any(f["trains"] for f in self.frames))

    def test_occ_cadence(self):
        n_places = len(self.welcome["town"]["places"])
        self.assertEqual(len(self.welcome["state"]["occ"]), n_places)
        with_occ = [f for f in self.frames if f["occ"] is not None]
        self.assertTrue(with_occ)
        for f in with_occ:
            self.assertEqual(len(f["occ"]), n_places)
            self.assertEqual(f["no"] % py_server.OCC_EVERY, 0)
        for a, b in zip(with_occ, with_occ[1:]):
            self.assertGreaterEqual(b["tick"] - a["tick"], py_server.OCC_TICKS)
        # the welcome's occ counts everyone placed: folk inside plus the named inside
        welcome_occ = sum(self.welcome["state"]["occ"])
        self.assertGreater(welcome_occ, FOLK // 2)

    def test_region_housing_cadence(self):
        housing = [f for f in self.frames if "homes" in f["keys"] or "lots" in f["keys"]]
        self.assertTrue(housing, "every 200th frame sends both")
        for f in housing:
            self.assertEqual(f["no"] % py_server.REGION_HOUSING_CHECK, 0, f["no"])
        for f in self.frames:
            if f["no"] % py_server.REGION_HOUSING_EVERY == 0:
                self.assertLessEqual({"homes", "lots"}, f["keys"])

    def test_folk_get_agent_and_set_luck(self):
        page = self.after_day["folk_page"]
        self.assertEqual(page["type"], "agent")
        self.assertEqual((page["agent"]["kind"], page["agent"]["id"]), ("folk", "f0"))
        self.assertTrue(page["agent"]["luck_settable"])
        self.assertEqual(self.after_day["named_page"]["agent"]["kind"], "named")
        luck = self.after_day["luck"]
        self.assertEqual((luck["type"], luck["ok"], luck["agent_id"], luck["luck"]), ("luck_set", True, "f0", 30.0))
        self.assertEqual(self.after_day["stats"]["folk"]["luck"][0], 30)
        self.assertFalse(self.after_day["bad_luck"]["ok"])

    def test_get_folk(self):
        reply = self.after_day["get_folk"]
        self.assertEqual(reply["type"], "folk")
        self.assertEqual(len(reply["rows"]), FOLK)
        self.assertEqual(reply["v"], self.after_day["stats"]["folk"]["v"])
        for i, row in enumerate(reply["rows"]):
            self.assertEqual(set(row), ROSTER_KEYS)
            self.assertEqual((row["i"], row["id"]), (i, f"f{i}"))

    def test_stats_folk_and_region(self):
        s = self.after_day["stats"]
        self.assertEqual(set(s["folk"]), {"v", "worth", "worth_24h", "mood", "health", "luck"})
        for k in ("worth", "worth_24h", "mood", "health", "luck"):
            self.assertEqual(len(s["folk"][k]), FOLK, k)
            self.assertTrue(all(v is None or isinstance(v, int) for v in s["folk"][k]), k)
        self.assertEqual(s["region"]["named"] + s["region"]["folk"], s["region"]["population"])
        self.assertEqual(s["city"]["population"], s["region"]["population"])
        self.assertGreater(s["city"]["population"], 60 + FOLK // 2)
        for push in self.stats_pushes:
            self.assertIn("folk", push)

    def test_richest_and_people_stay_named(self):
        s = self.after_day["stats"]
        named = set(self.sim.agents)
        self.assertLessEqual({p["id"] for p in s["people"]}, named)
        self.assertIn(self.sim.stats.richest, named | {None})

    def test_folk_only_news_is_capped(self):
        per_day: dict[int, int] = {}
        for f in self.frames:
            for ev in f["events"]:
                if ev["importance"] >= 1 and folk_only(ev):
                    day = ev["tick"] // MINUTES_PER_DAY
                    per_day[day] = per_day.get(day, 0) + 1
        print(f"\nfolk-only News a day: {per_day or 'none'}", flush=True)
        for day, n in per_day.items():
            self.assertLessEqual(n, FOLK_NEWS_CAP, day)

    def test_welcome_and_town_sizes(self):
        self.assertLessEqual(self.town_bytes, TOWN_MAX)
        self.assertLessEqual(self.welcome_bytes, WELCOME_MAX)

    def test_the_named_stay_in_millbrook(self):
        x0, y0, x1, y1 = MILLBROOK
        self.assertGreaterEqual(len(self.positions), 60 * 24)
        outside = [p for p in self.positions if not (x0 <= p[2] < x1 and y0 <= p[3] < y1)]
        self.assertEqual(outside[:5], [])
        for when, aid, _x, _y, place, inside in self.positions:
            for pid in (place, inside):
                if pid is not None:
                    self.assertIn(pid, self.millbrook, (when, aid))
        for a in self.sim.agents.values():
            if a.alive:
                self.assertTrue(x0 <= a.x < x1 and y0 <= a.y < y1, a.id)


class TestFrameLoop(unittest.TestCase):
    """folk.md 9: a pass turns the real time since the last one into ticks, capped at 4 frames."""

    def test_frame_span(self):
        fs = py_server.FRAME_SECONDS
        self.assertEqual(py_server.frame_span(fs), fs)
        self.assertEqual(py_server.frame_span((1000.0 + fs) - 1000.0), fs)  # on time, to the float
        self.assertEqual(py_server.frame_span(0.12), 0.12)  # a slow pass catches up ...
        self.assertEqual(py_server.frame_span(10.0), py_server.CATCH_UP_FRAMES * fs)  # ... at most 4 frames
        self.assertEqual(py_server.frame_span(-1.0), 0.0)

    def test_the_millbrook_cadence_is_v2s(self):
        sim = Simulation(1)
        server, view = god_server(sim)
        seen = []
        serve_frames(server, view, 200, lambda n: seen.append(
            (n, [set(m["state"]) for m in view.got if m["type"] == "state"])) or view.got.clear())
        for n, states in seen:
            for keys in states:
                if n % py_server.HOUSING_EVERY == 0:
                    self.assertLessEqual({"homes", "lots"}, keys, n)
                self.assertEqual("occ" in keys, n % py_server.OCC_EVERY == 0, n)

    def test_the_loop_catches_up_after_a_slow_pass(self):
        import asyncio
        from unittest import mock

        clock = [1000.0]
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
            if len(sleeps) == 3:
                clock[0] += 0.5  # a slow pass: 10 frames late, run 4 frames' worth
            if len(sleeps) > 4:
                raise asyncio.CancelledError

        sim = Simulation(1)
        start = sim.clock.tick
        server = GameServer(sim, speed=1)
        with mock.patch.object(py_server, "time", mock.Mock(monotonic=lambda: clock[0])), \
                mock.patch.object(py_server.asyncio, "sleep", fake_sleep):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(server._run())
        per_frame = py_server.FRAME_SECONDS * TICKS_PER_REAL_SECOND
        self.assertEqual(sleeps[0], py_server.FRAME_SECONDS)
        self.assertAlmostEqual(server._pending_ticks + sim.clock.tick - start, per_frame * (3 + py_server.CATCH_UP_FRAMES),
                               places=6)


    @unittest.skipUnless(NODE, "node is not installed")
    def test_the_js_host_catches_up_the_same_way(self):
        code = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const sim = new G.sim.Simulation(1, null, null, 1);
const clock = { t: 1000.0 };
const host = new G.host.LocalHost(sim, 1, () => clock.t);
const start = sim.clock.tick, out = [];
for (const late of [0, 0, 0.5, 0]) {
  clock.t += G.host.FRAME_SECONDS + late;
  host.frame();
  out.push(sim.clock.tick - start + host._pending_ticks);
}
process.stdout.write(JSON.stringify({ out, span: G.host.frame_span(10), on_time: G.host.frame_span(1000.05 - 1000) }));
"""
        js = json.loads(subprocess.run([NODE, "-e", code, str(ROOT)], capture_output=True, text=True, check=True,
                                       timeout=120).stdout)
        per_frame = py_server.FRAME_SECONDS * TICKS_PER_REAL_SECOND
        for got, frames in zip(js["out"], (1, 2, 2 + py_server.CATCH_UP_FRAMES, 3 + py_server.CATCH_UP_FRAMES)):
            self.assertAlmostEqual(got, per_frame * frames, places=6)
        self.assertEqual((js["span"], js["on_time"]), (py_server.CATCH_UP_FRAMES * py_server.FRAME_SECONDS,
                                                       py_server.FRAME_SECONDS))


JS_KEYS = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const folk = Number(process.argv[2]);
class Client {
  constructor() { this.got = []; }
  _deliver(text) { this.got.push(JSON.parse(text)); }
  _serverClose() {}
}
const sim = new G.sim.Simulation(1, null, null, 1, { world: "region", folk });
const clock = { t: 1000.0 };
const host = new G.host.LocalHost(sim, 16, () => clock.t);
host.sim.town.warm();
const god = new Client();
host.connect(god);
host.receive(god, JSON.stringify({ type: "hello", role: "god", req_id: 1 }));
const welcome = god.got.shift();
let frame = null, occ = null;
for (let i = 0; i < 400 && !(frame && occ); i++) {
  clock.t += G.host.FRAME_SECONDS;
  host.frame();
  for (const m of god.got.splice(0)) {
    if (m.type !== "state") continue;
    frame = frame || m;
    if (m.state.occ && !occ) occ = m;
  }
}
const ask = msg => { host.receive(god, JSON.stringify(msg)); return god.got.pop(); };
const out = { welcome, frame, occ, stats: ask({ type: "get_stats" }), folk: ask({ type: "get_folk" }),
  named: ask({ type: "get_agent", agent_id: "dana" }), page: ask({ type: "get_agent", agent_id: "f0" }),
  has_folk: !!(G.folk && G.folk.Folk) };
process.stdout.write(JSON.stringify(out));
"""


def key_paths(value, ids, path="", out=None) -> set:
    """Every key path in a JSON value; list items share `[]`, and dict keys that are ids or numbers share `*`."""
    out = set() if out is None else out
    if isinstance(value, dict):
        for k, v in value.items():
            name = "*" if (k in ids or people.is_folk_id(k) or k.lstrip("-").isdigit()) else k
            p = f"{path}.{name}"
            out.add(p)
            key_paths(v, ids, p, out)
    elif isinstance(value, list):
        for v in value:
            key_paths(v, ids, path + "[]", out)
    return out


def python_messages(folk: int) -> dict:
    sim = Simulation(1, world="region", folk=folk)
    server, view = god_server(sim)
    sim.town.warm()
    welcome = {**server._welcome_god(), "req_id": 1}
    frame = occ = None
    for _ in range(400):
        serve_frames(server, view, 1)
        for m in view.got:
            if m["type"] == "state":
                frame = frame or m
                if "occ" in m["state"] and occ is None:
                    occ = m
        view.got.clear()
        if frame and occ:
            break
    return {"welcome": welcome, "frame": frame, "occ": occ, "stats": server._god({"type": "get_stats"}),
            "folk": server._god({"type": "get_folk"}), "named": server._god({"type": "get_agent", "agent_id": "dana"}),
            "page": server._god({"type": "get_agent", "agent_id": "f0"}), "sim": sim}


@unittest.skipUnless(NODE, "node is not installed")
class TestPortKeys(unittest.TestCase):
    """Identical recursive key sets in Python and JS (folk.md 15): welcome, frame, stats, get_folk, pages."""

    def compare(self, folk: int) -> dict:
        run = subprocess.run([NODE, "-e", JS_KEYS, str(ROOT), str(folk)], capture_output=True, text=True,
                             timeout=300)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        js = json.loads(run.stdout)
        py = python_messages(folk)
        sim = py.pop("sim")
        ids = set(sim.agents) | set(sim.town.places) | set(sim.homes) | set(sim.households)
        ids |= {d["id"] for d in getattr(sim.town, "districts", [])} | {""}
        for name in ("welcome", "frame", "occ", "stats", "folk", "named", "page"):
            with self.subTest(name):
                self.assertEqual(sorted(key_paths(js[name], ids) ^ key_paths(py[name], ids)), [], name)
        return js

    def test_the_region_without_townsfolk(self):
        self.compare(0)

    def test_the_region_with_townsfolk(self):
        probe = subprocess.run([NODE, "-e", "const G = require(process.argv[1] + '/port/tools/engine.cjs').load();"
                                "process.stdout.write(String(!!(G.folk && G.folk.Folk)))", str(ROOT)],
                               capture_output=True, text=True, timeout=60)
        if probe.stdout.strip() != "true":
            self.skipTest("the JS townsfolk (port/src/folk.js) are not in this build: the integrator runs this half")
        self.compare(FOLK)


# --- the townsfolk in stats.city and stats.districts ------------------------------------------------------------

CITY_STATS_JS = r"""
const G = require(process.argv[1] + "/port/tools/engine.cjs").load();
const sim = new G.sim.Simulation(1, null, null, 1, { world: "region", folk: Number(process.argv[2]) });
for (let i = 0; i < 200; i++) sim.step();
for (let i = 0; i < 200; i++) sim.set_luck(`f${i}`, 95);
for (let i = 0; i < 70; i++) sim.step();
const st = sim.stats_json(true);
process.stdout.write(JSON.stringify({ city: st.city, districts: st.districts }));
"""

STATS_FIELDS = ("needs", "luck", "retired", "out_of_work", "wealth", "homes")


def city_stats_python(folk: int) -> tuple[Simulation, dict]:
    """CITY_STATS_JS's run in Python: 200 steps, God's luck 95 on f0-f199, 70 steps. The named roll the JS port's
    dice (1, as tests.test_port.DiceSim does), so the city's sums of the named can equal the port's too."""
    from tests.test_port import MulberryDice

    class RegionDiceSim(Simulation):
        def _roll_weather(self) -> None:
            if not isinstance(self.rng, MulberryDice):
                self.rng = MulberryDice(1)
            super()._roll_weather()

    sim = RegionDiceSim(1, world="region", folk=folk)
    for _ in range(200):
        sim.step()
    for i in range(200):
        assert sim.set_luck(f"f{i}", 95)
    for _ in range(70):
        sim.step()
    return sim, sim.stats_json(full=True)


class TestFolkCityStats(unittest.TestCase):
    """`stats.city` and `stats.districts` count the townsfolk's needs, luck, worths, retired and out of work too
    (stats.folk_parts over `Folk.city_parts`), in Python and JS alike."""

    @classmethod
    def setUpClass(cls):
        from gameofailife import stats
        cls.sim, cls.st = sim, st = city_stats_python(FOLK)
        f = sim.folk
        cls.named = [a for a in sim.agents.values() if a.alive]
        cls.folk = f.living()
        cls.folk_adult_worths = [f.worth(sim, p) for p in cls.folk if p.age >= 18]
        cls.named_adult_worths = [p.worth for p in stats._people(sim) if p.agent.is_adult]

    @classmethod
    def tearDownClass(cls):
        for name in ("sim", "st", "named", "folk"):
            setattr(cls, name, None)
        gc.collect()

    def test_needs_cover_everyone(self):
        city = self.st["city"]
        n = len(self.named) + len(self.folk)
        self.assertEqual(city["population"], n)
        for k, v in city["needs"].items():
            named_mean = sum(a.needs[k] for a in self.named) / len(self.named)
            everyone = (sum(a.needs[k] for a in self.named) + sum(p.needs[k] for p in self.folk)) / n
            with self.subTest(k):
                self.assertGreater(v, 15, city["needs"])  # 1,060 people's needs, never the 60's sums over 1,060
                self.assertTrue(abs(v - everyone) <= 15 or abs(v - named_mean) <= 15, (k, v, everyone, named_mean))

    def test_gods_luck_on_townsfolk_shows(self):
        luck = self.st["city"]["luck"]
        named_touched = sum(1 for a in self.named if a.luck != 50)
        self.assertGreaterEqual(luck["touched"], 200 + named_touched - 5, luck)  # f0-f199, less any who died
        self.assertGreaterEqual(luck["raised"], 195, luck)
        self.assertGreater(luck["mean"], 50, luck)

    def test_worths_cover_everyone(self):
        from gameofailife import stats
        w = self.st["city"]["wealth"]
        adults = self.named_adult_worths + self.folk_adult_worths
        self.assertEqual(w["median"], stats._int(stats.median(adults)))
        self.assertEqual(w["gini"], stats.gini(adults))
        for d in self.st["districts"]:
            if d["people"] >= 10:
                with self.subTest(d["id"]):
                    self.assertNotEqual(d["median_worth"], 0, d)

    def test_city_homes_keep_to_the_cast_and_districts_count_their_own(self):
        # city.homes describes the cast's 37 homes on their 22 lots, as in the millbrook world; each district counts
        # every home in it (the townsfolk's too), so the districts' homes add up to all of the region's.
        from gameofailife import housing
        sim, homes = self.sim, self.st["city"]["homes"]
        cast = housing.cast_homes(sim)
        self.assertEqual(homes["total"], len(cast))
        self.assertEqual(homes["total"], 37)
        self.assertEqual(homes["owned"] + homes["rented"], sum(1 for h in cast if h.household is not None))
        self.assertEqual(sum(homes["lots_by_stage"]), len({h.place for h in cast}))
        self.assertEqual(sum(homes["lots_by_stage"]), 22)
        self.assertGreater(len(sim.homes), 600)
        self.assertEqual(sum(d["homes"] for d in self.st["districts"]), len(sim.homes))
        self.assertEqual(sum(d["vacant"] for d in self.st["districts"]),
                         sum(1 for h in sim.homes.values() if h.household is None))

    def test_retired_and_out_of_work_count_townsfolk(self):
        city = self.st["city"]
        retired = sum(1 for p in self.folk if p.age >= 65 and p.job is None)
        idle = sum(1 for p in self.folk if 18 <= p.age < 65 and p.job is None)
        named_retired = sum(1 for a in self.named if not a.job and a.age >= 65)
        named_idle = sum(1 for a in self.named if a.is_adult and not a.job and a.age < 65)
        self.assertEqual(city["retired"], retired + named_retired)
        self.assertEqual(city["out_of_work"], idle + named_idle)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_the_js_twin_gives_the_same_numbers(self):
        run = subprocess.run([NODE, "-e", CITY_STATS_JS, str(ROOT), str(FOLK)], capture_output=True, text=True,
                             timeout=300)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        js = json.loads(run.stdout)
        for k in STATS_FIELDS:
            with self.subTest(k):
                self.assertEqual(js["city"][k], self.st["city"][k], k)
        row = lambda d: (d["id"], d["people"], d["median_worth"], d["homes"], d["vacant"], d["shabby_plus"])  # noqa: E731
        self.assertEqual([row(d) for d in js["districts"]], [row(d) for d in self.st["districts"]])


# --- client/dev/fixture_folk.js ---------------------------------------------------------------------------------

FIXTURE = ROOT / "client" / "dev" / "fixture_folk.js"
FIXTURE_AT = "Day 1 Mon 08:00"
FIXTURE_HEAD = f"""// Townsfolk dev fixture (folk.md 14): window.FOLK_FIXTURE = {{welcome, frames}}, recorded from the real server.
//   welcome  GameServer's God welcome for the seed-1 region with 1,000 townsfolk at {FIXTURE_AT} (town, state with
//            crowd, occ, trains and folk_n, history, news, stats with stats.folk and stats.region)
//   frames   the next three state frames at speed 16, as the frame loop sends them
// Made by `python3 -m tests.test_folk_protocol --write-fixture`; the integrator makes it again after a merge
// that changes the engine. Generated data for the client's dev pages; classic script.
"use strict";
"""


def fixture_data() -> dict:
    """The seed-1 region's welcome at FIXTURE_AT and its next three frames, as the engines make them now."""
    sim = Simulation(1, world="region", folk=FOLK)
    while sim.clock.stamp() != FIXTURE_AT:
        sim.step()
        sim.drain()
    server, view = god_server(sim)
    welcome = server._welcome_god()
    frames = []
    while len(frames) < 3:
        serve_frames(server, view, 1)
        frames += [m for m in view.got if m["type"] == "state"]
        view.got.clear()
    return {"welcome": welcome, "frames": frames[:3]}


def fixture_text(data: dict) -> str:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"{FIXTURE_HEAD}window.FOLK_FIXTURE = {body};\n"


class TestFolkFixture(unittest.TestCase):
    """client/dev/fixture_folk.js has the shape the server sends (its values follow the engines at its making)."""

    def test_the_fixture_is_a_region_welcome_and_three_frames(self):
        import re
        m = re.search(r"^window\.FOLK_FIXTURE = (.*?);?\s*\Z", FIXTURE.read_text(), re.M | re.S)
        self.assertTrue(m, "client/dev/fixture_folk.js does not set window.FOLK_FIXTURE")
        data = json.loads(m.group(1))
        welcome = data["welcome"]
        self.assertEqual((welcome["type"], welcome["town"]["world"], welcome["state"]["folk_n"]),
                         ("welcome", "region", FOLK))
        self.assertEqual(welcome["state"]["time"], FIXTURE_AT)
        self.assertEqual(len(welcome["state"]["occ"]), len(welcome["town"]["places"]))
        self.assertEqual(len(data["frames"]), 3)
        for frame in data["frames"]:
            self.assertEqual(frame["type"], "state")
            self.assertLessEqual({"crowd", "trains", "folk_n", "talks", "agents"}, set(frame["state"]))
        self.assertTrue(data["frames"][0]["state"]["crowd"], "08:00 has townsfolk out")
        self.assertLessEqual(set(Simulation(1, world="region").state_json(housing=True)), set(welcome["state"]))


if __name__ == "__main__":
    import sys
    if "--write-fixture" in sys.argv:
        FIXTURE.write_text(fixture_text(fixture_data()))
        print(f"wrote {FIXTURE} ({FIXTURE.stat().st_size:,} bytes)")
    else:
        unittest.main()
