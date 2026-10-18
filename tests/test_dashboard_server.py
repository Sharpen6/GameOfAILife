"""The dashboard's server side (P3): the God welcome's new fields, get_stats and get_decisions (also for a demoted
watcher), the stats cadence, per-client coalescing (PLAN 3.14), and the God view's page.

The real-time checks (a client reading 100 KB/s at 16x for 10 s; stats pushes 3 s apart at 1x, none while paused)
run in a child process that starts when this module is imported, and `CoalescingAndCadenceTest` reads the child's
report. load_tests holds that class's tests back until the whole run ends (see `_AtTheEnd`), so the child's 10 s
overlap the rest of the suite instead of adding to it. The child is `python3 -c` on `scenario_main()` below, with
GOAL_DASHBOARD_SCENARIO=1 set, and can be run by hand the same way.
"""

from __future__ import annotations

import asyncio
import atexit
import copy
import json
import os
import socket
import struct
import subprocess
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gameofailife import server as server_module, ws
from gameofailife.clock import TICKS_PER_REAL_SECOND
from gameofailife.forks import Fork, Option
from gameofailife.server import GameServer, Outbox, _Entry, encoded, merge_state, merge_stats
from gameofailife.sim import Simulation

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client"
TIMEOUT = 3.0
SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence",
               "due", "pending_emergency", "roll", "base_p", "hit"}
SCRIPTS = [f"view/{n}.js" for n in ("proj", "art", "buildings", "towers", "rail_art", "actors", "region", "lod", "lowart",
                                    "scene", "movers", "crowd", "trains", "pings", "camera", "minimap", "view")] + \
    ["dashboard.js", "game.js"]  # view.md 3.1 (v3), in order
STYLES = ["style.css", "view/view.css", "dashboard.css"]
STATS_BYTES = 20 * 1024

SCENARIO_SECONDS = 10.0
SLOW_RATE = 100_000  # bytes a second the slow view reads
SCENARIO_ENV = "GOAL_DASHBOARD_SCENARIO"  # set in the child, so importing this module there starts nothing


def find_secret_keys(obj, path="") -> list[str]:
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in SECRET_KEYS:
                found.append(f"{path}.{k}")
            found += find_secret_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found += find_secret_keys(v, f"{path}[{i}]")
    return found


def plain_fork(agent_id: str, tick: int) -> Fork:
    return Fork(agent_id, "test", "What do you do?", [Option(f"Option {c}", [("idle", None)]) for c in "ABCD"], tick)


# --- the real-time scenario (run in a child process) ------------------------------------------------------------

UPGRADE = (b"GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")


def masked_text(payload: bytes) -> bytes:
    """One masked client text frame."""
    head = bytearray([0x80 | ws.OP_TEXT])
    if len(payload) < 126:
        head.append(0x80 | len(payload))
    else:
        head += bytes([0x80 | 126]) + struct.pack("!H", len(payload))
    key = os.urandom(4)
    return bytes(head) + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def take_frames(buf: bytearray) -> list[tuple[dict, int]]:
    """Remove the whole server frames at the start of buf; returns each text message with its size in bytes."""
    out = []
    while len(buf) >= 2:
        n, at = buf[1] & 0x7F, 2
        if n >= 126:
            at = 4 if n == 126 else 10
            if len(buf) < at:
                break
            n = int.from_bytes(buf[2:at], "big")
        if len(buf) < at + n:
            break
        if buf[0] & 0x0F == ws.OP_TEXT:
            out.append((json.loads(buf[at:at + n]), n))
        del buf[:at + n]
    return out


async def _slow_view(port: int, sim: Simulation, seconds: float) -> dict:
    """A God view on a 100 KB/s link: a small receive buffer, read 10 KB every 0.1 s. Notes each state frame's
    age when it is read: how far the city has moved on since, in real seconds at the frame's speed."""
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16384)
    sock.setblocking(False)
    await loop.sock_connect(sock, ("127.0.0.1", port))
    await loop.sock_sendall(sock, UPGRADE + masked_text(b'{"type": "hello", "role": "god"}'))
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        buf += await loop.sock_recv(sock, 1)
    buf.clear()
    start = loop.time()
    got: list[dict] = []
    ages: list[tuple[float, float]] = []  # (when read, age)
    eof = False
    try:
        while loop.time() - start < seconds:
            await asyncio.sleep(0.1)
            try:
                data = await asyncio.wait_for(loop.sock_recv(sock, SLOW_RATE // 10), 0.1)
            except asyncio.TimeoutError:
                continue
            except ConnectionError:
                eof = True
                break
            if not data:
                eof = True
                break
            buf += data
            for msg, _ in take_frames(buf):
                got.append(msg)
                if msg["type"] == "state":
                    ages.append((loop.time() - start, (sim.clock.tick - msg["state"]["tick"])
                                 / (TICKS_PER_REAL_SECOND * msg["speed"])))
    finally:
        sock.close()
    return {"got": got, "ages": ages, "eof": eof}


async def _steady_view(port: int, seconds: float) -> list[tuple[float, dict, int]]:
    """A God view that reads everything at once: (when, message, size in bytes) for each message."""
    loop = asyncio.get_running_loop()
    sock = await ws.connect(f"ws://127.0.0.1:{port}/ws")
    await sock.send(json.dumps({"type": "hello", "role": "god"}))
    start, out = loop.time(), []
    try:
        while True:
            left = seconds - (loop.time() - start)
            if left <= 0:
                break
            try:
                text = await asyncio.wait_for(sock.recv(), left)
            except asyncio.TimeoutError:
                break
            out.append((loop.time() - start, json.loads(text), len(text.encode())))
    finally:
        sock.abort()
    return out


async def scenario() -> dict:
    """Three cities at once for SCENARIO_SECONDS: `fast` at 16x with the slow view; `steady` at 1x with a view
    that reads at once (the stats cadence and push size); `paused` at 0x with a view (no stats pushes)."""
    fast, steady, paused = (GameServer(Simulation(seed=1), speed=s) for s in (16, 1, 0))
    for s in (fast, steady, paused):
        s.sim.drain()  # the first morning's weather, before anyone watches
    ports = [await s.start("127.0.0.1", 0) for s in (fast, steady, paused)]
    produced: list[tuple[int, list[int], list[str]]] = []  # every flush of fast: (tick, event seqs, fork ids)
    drain = fast.sim.drain

    def recording_drain():
        out = drain()
        produced.append((fast.sim.clock.tick, [e["seq"] for e in out[0]], [f["id"] for f in out[1]]))
        return out

    fast.sim.drain = recording_drain

    async def chatter():  # 16x makes few events of its own in a morning: add 20 a second, as texts would
        people, n = fast.sim.living(), 0
        while True:
            await asyncio.sleep(0.05)
            a = people[n % len(people)]
            fast.sim.event(f"{a.name} calls a friend ({n}).", a, tag="call")
            n += 1

    noise = asyncio.create_task(chatter())
    try:
        slow, steady_msgs, paused_msgs = await asyncio.gather(
            _slow_view(ports[0], fast.sim, SCENARIO_SECONDS), _steady_view(ports[1], SCENARIO_SECONDS),
            _steady_view(ports[2], SCENARIO_SECONDS))
        kept = fast.god is not None and not fast.god.closed
    finally:
        noise.cancel()
        for s in (fast, steady, paused):
            await s.stop()

    # The slow view: what it read against what the city made after its welcome.
    got = slow["got"]
    welcome = next(m for m in got if m["type"] == "welcome")
    frames = [m for m in got if m["type"] == "state"]
    last_tick = frames[-1]["state"]["tick"] if frames else None
    due = [p for p in produced if last_tick is not None and welcome["state"]["tick"] < p[0] <= last_tick]
    seqs = [e["seq"] for f in frames for e in f["events"]]
    fork_ids = {x["id"] for f in frames for x in f["forks"]}
    samples = [s["tick"] for m in got if m["type"] == "stats" for s in m["samples"]]
    pushes = [(t, m, n) for t, m, n in steady_msgs if m["type"] == "stats"]
    majors, gaps = 0, []  # gaps between steady's pushes with no major event between them (that makes one sooner)
    for t, m, n in steady_msgs:
        if m["type"] == "state":
            majors += sum(e["importance"] == 2 for e in m["events"])
        elif m["type"] == "stats":
            if gaps and gaps[-1][1] is None:
                gaps[-1][1] = t if not majors else -1
            gaps.append([t, None])
            majors = 0
    return {
        "slow": {"kept": kept and not slow["eof"], "frames": len(frames), "flushes": len(due),
                 "ages": slow["ages"], "seqs": seqs, "due_seqs": [s for p in due for s in p[1]],
                 "missing_forks": sorted({f for p in due for f in p[2]} - fork_ids), "due_forks": sum(len(p[2]) for p in due),
                 "samples": samples},
        "steady": {"pushes": [(t, n, m["full"], len(m["samples"])) for t, m, n in pushes],
                   "gaps": [b - a for a, b in gaps if b is not None and b >= 0]},
        "paused": {"stats": sum(m["type"] == "stats" for _, m, _ in paused_msgs),
                   "frames": sum(m["type"] == "state" for _, m, _ in paused_msgs),
                   "welcomed": any(m["type"] == "welcome" for _, m, _ in paused_msgs)},
    }


def scenario_main() -> None:
    print(json.dumps(asyncio.run(scenario())))


def _start_scenario() -> subprocess.Popen | None:
    if os.environ.get(SCENARIO_ENV):
        return None
    child = subprocess.Popen(
        [sys.executable, "-c", "import tests.test_dashboard_server as t; t.scenario_main()"], cwd=ROOT,
        env={**os.environ, SCENARIO_ENV: "1"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    atexit.register(lambda: child.poll() is None and child.kill())
    return child


SCENARIO = _start_scenario()
_REPORT: dict = {}  # "report" once the child has answered, or "error" if it failed


def scenario_report() -> dict:
    """The child's report, waiting for it the first time."""
    if SCENARIO is None:
        raise unittest.SkipTest("this is the scenario's own process")
    if not _REPORT:
        out, err = SCENARIO.communicate(timeout=SCENARIO_SECONDS + 30)
        _REPORT.update({"error": f"the scenario failed:\n{err}"} if SCENARIO.returncode else {"report": json.loads(out)})
    if "error" in _REPORT:
        raise AssertionError(_REPORT["error"])
    return _REPORT["report"]


class CoalescingAndCadenceTest(unittest.TestCase):
    """PLAN 3.8 and 3.14 in real time; see the module docstring. Its tests run when the whole run ends."""

    def setUp(self):
        self.report = scenario_report()

    def test_a_100_kb_a_second_view_at_16x_is_kept_with_fresh_frames(self):
        slow = self.report["slow"]
        self.assertTrue(slow["kept"], "a view that keeps reading must not be dropped")
        self.assertGreater(slow["frames"], 20)
        self.assertLess(slow["frames"], slow["flushes"] / 2, "precondition: it reads slower than frames come, so they merge")
        when, age = slow["ages"][-1]
        self.assertGreater(when, SCENARIO_SECONDS - 1, "frames keep coming to the end")
        self.assertLessEqual(age, 1.0, "its last frame is at most 1 s old")
        self.assertLessEqual(max(a for t, a in slow["ages"] if t > 3), 1.5, "and so are the others, once it caught up")

    def test_events_and_forks_survive_coalescing(self):
        slow = self.report["slow"]
        self.assertGreater(len(slow["due_seqs"]), 100, "precondition: the city made events")
        self.assertGreater(slow["due_forks"], 20, "precondition: and decided forks")
        self.assertEqual(slow["seqs"], slow["due_seqs"], "every event once, in order")
        self.assertEqual(slow["missing_forks"], [])
        samples = slow["samples"]
        self.assertEqual(samples, sorted(set(samples)), "stats samples merged once each, oldest first")

    def test_stats_pushes_3_s_apart_at_1x_and_under_20_kb(self):
        steady = self.report["steady"]
        self.assertGreaterEqual(len(steady["pushes"]), 2)
        self.assertTrue(steady["gaps"], "two pushes with no major event between them")
        for gap in steady["gaps"]:
            self.assertAlmostEqual(gap, server_module.STATS_SECONDS, delta=0.5)
        for when, size, full, samples in steady["pushes"]:
            self.assertLess(size, STATS_BYTES)
            self.assertFalse(full)

    def test_no_stats_while_paused(self):
        paused = self.report["paused"]
        self.assertTrue(paused["welcomed"])
        self.assertEqual((paused["stats"], paused["frames"]), (0, 0))


# --- coalescing, in pieces ----------------------------------------------------------------------------------------

def frame(tick, events=(), forks=(), **housing) -> dict:
    return {"type": "state", "speed": 16, "state": {"tick": tick, **housing}, "events": list(events),
            "forks": list(forks)}


class TestMerging(unittest.TestCase):
    def test_a_newer_state_frame_carries_the_older_ones_events_forks_and_housing(self):
        old = frame(1, [{"seq": 1}], [{"id": "f1", "v": 1}, {"id": "f2", "v": 1}], lots={"a": 1}, homes={"h": 1})
        new = frame(2, [{"seq": 2}], [{"id": "f2", "v": 2}, {"id": "f3", "v": 1}])
        before = json.dumps([old, new])
        merged = merge_state(old, new)
        self.assertEqual(merged["state"], {"tick": 2, "lots": {"a": 1}, "homes": {"h": 1}})
        self.assertEqual(merged["events"], [{"seq": 1}, {"seq": 2}])
        self.assertEqual(merged["forks"], [{"id": "f1", "v": 1}, {"id": "f2", "v": 2}, {"id": "f3", "v": 1}])
        self.assertEqual(json.dumps([old, new]), before, "neither frame is changed")
        newer = merge_state(merged, frame(3, lots={"a": 2}))
        self.assertEqual(newer["state"], {"tick": 3, "lots": {"a": 2}, "homes": {"h": 1}}, "the newest lots win")

    def test_stats_pushes_merge_their_samples(self):
        old = {"type": "stats", "full": True, "tick": 1, "samples": [{"tick": 60, "v": 1}, {"tick": 120, "v": 1}]}
        new = {"type": "stats", "full": False, "tick": 2, "samples": [{"tick": 120, "v": 2}, {"tick": 180, "v": 2}]}
        merged = merge_stats(old, new)
        self.assertEqual((merged["tick"], merged["full"]), (2, True))
        self.assertEqual(merged["samples"], [{"tick": 60, "v": 1}, {"tick": 120, "v": 2}, {"tick": 180, "v": 2}])


class TestOutbox(unittest.TestCase):
    def test_one_state_frame_and_one_stats_push_wait_at_a_time(self):
        box = Outbox()
        box.put(_Entry(0.0, encoded("state", frame(1, [{"seq": 1}]))))
        box.put(_Entry(0.1, encoded("stats", {"type": "stats", "full": False, "samples": [{"tick": 60}]})))
        box.put(_Entry(0.2, json.dumps({"type": "demoted"})))
        box.put(_Entry(0.3, encoded("state", frame(2, [{"seq": 2}]))))
        box.put(_Entry(0.4, encoded("stats", {"type": "stats", "full": False, "samples": [{"tick": 120}]})))
        self.assertEqual(box.qsize(), 3)
        first = asyncio.run(box.get())
        self.assertEqual((first.kind, first.text, first.queued), ("state", None, 0.3), "merged: encoded when sent")
        self.assertEqual([e["seq"] for e in first.msg["events"]], [1, 2])
        box.put(_Entry(0.5, encoded("state", frame(3))))  # the merged one is being sent: this one waits anew
        second = asyncio.run(box.get())
        self.assertEqual([s["tick"] for s in second.msg["samples"]], [60, 120])
        self.assertEqual(json.loads(asyncio.run(box.get()).text), {"type": "demoted"}, "everything else in order")
        third = asyncio.run(box.get())
        self.assertEqual((third.msg["state"]["tick"], third.text), (3, encoded("state", frame(3))))

    def test_a_view_is_dropped_only_for_a_stalled_send_or_a_push_that_waits(self):
        box = Outbox()
        box.put(_Entry(0.0, encoded("state", frame(1))))
        box.put(_Entry(4.9, encoded("state", frame(2))))
        self.assertFalse(box.stalled(9.0), "a frame merged into counts from its last merge")
        sending = asyncio.run(box.get())
        box.begin(sending, 9.0)
        self.assertFalse(box.stalled(13.9))
        self.assertTrue(box.stalled(14.1), "one send took over STALL_SECONDS")
        box.done(sending)
        self.assertFalse(box.stalled(20.0))
        box.put(_Entry(20.0, json.dumps({"type": "demoted"})))
        self.assertFalse(box.stalled(24.9))
        self.assertTrue(box.stalled(25.1), "a first-in-first-out push waited over STALL_SECONDS")

    def test_a_slow_text_alone_never_drops_a_controller(self):
        box = Outbox()
        box.put(_Entry(0.0, json.dumps({"type": "message"}), inbox="tom"))
        text = asyncio.run(box.get())
        box.begin(text, 0.0)
        self.assertFalse(box.waiting())
        self.assertFalse(box.stalled(60.0), "texts are skipped instead")
        box.put(_Entry(1.0, json.dumps({"type": "fork"})))
        self.assertTrue(box.waiting())
        self.assertTrue(box.stalled(6.1), "a fork waits behind it")


class TestStatsCadence(unittest.TestCase):
    """The cadence on a fake clock, frame by frame (the real-time version is CoalescingAndCadenceTest)."""

    def setUp(self):
        self.now = 1000.0
        clock = mock.patch.object(server_module, "time", SimpleNamespace(monotonic=lambda: self.now))
        clock.start()
        self.addCleanup(clock.stop)
        self.sim = Simulation(seed=1)
        self.sim.drain()  # the first morning's weather
        self.server = GameServer(self.sim, speed=1)
        self.pending = 0.0
        self.pushes: list[tuple[float, object, str]] = []
        self.server._push = lambda ws_, text, inbox=None: self.pushes.append((self.now, ws_, text))
        self.server.god = "god"
        self.server.observers = {"watcher"}

    def run_frames(self, seconds: float, stepped: bool = True) -> None:
        """What GameServer._run does at 1x (or paused), one frame at a time."""
        for _ in range(round(seconds / server_module.FRAME_SECONDS)):
            self.now += server_module.FRAME_SECONDS
            ran = False
            if stepped:
                self.pending += server_module.FRAME_SECONDS * TICKS_PER_REAL_SECOND
                while self.pending >= 1:
                    self.pending -= 1
                    self.sim.step()
                    ran = True
            self.server._flush(ran)

    def stats_times(self) -> list[float]:
        return sorted({t for t, _, text in self.pushes if json.loads(text)["type"] == "stats"})

    def test_every_3_s_while_the_city_runs(self):
        self.run_frames(10)
        times = self.stats_times()
        self.assertEqual(len(times), 3)
        for a, b in zip([1000.0] + times, times):
            self.assertAlmostEqual(b - a, 3.0, delta=server_module.FRAME_SECONDS + 1e-9)

    def test_encoded_once_for_every_view(self):
        self.run_frames(3.1)
        texts = [text for _, _, text in self.pushes if '"type": "stats"' in text[:20]]
        self.assertEqual(len(texts), 2)
        self.assertIs(texts[0], texts[1])
        self.assertEqual({ws_ for _, ws_, text in self.pushes if text is texts[0]}, {"god", "watcher"})

    def test_none_while_paused_and_quiet(self):
        self.run_frames(10, stepped=False)
        self.assertEqual(self.pushes, [])

    def test_half_a_second_after_a_major_event(self):
        self.run_frames(3.1)
        last = self.stats_times()[-1]
        self.run_frames(0.2, stepped=False)
        self.sim.event("Dana Cohen won the raffle.", self.sim.agents["dana"], tag="big_money")
        self.run_frames(1.0, stepped=False)  # paused, but news is news
        self.assertAlmostEqual(self.stats_times()[-1] - last, 0.5, delta=server_module.FRAME_SECONDS + 1e-9)
        self.run_frames(5, stepped=False)
        self.assertEqual(len(self.stats_times()), 2, "then quiet again")

    def test_samples_nobody_was_sent_are_not_pushed_later(self):
        self.server.god, self.server.observers = None, set()
        self.run_frames(80)  # 80 s at 1x is 192 game minutes: three samples, taken while nobody watched
        self.assertEqual(len(self.sim.stats.samples), 3)
        self.server.god = "god"  # (a new view's welcome carries them all)
        self.run_frames(30)  # the fourth comes 100 s in
        self.assertEqual(len(self.sim.stats.samples), 4)
        pushed = [s["tick"] for _, _, text in self.pushes if json.loads(text)["type"] == "stats"
                  for s in json.loads(text)["samples"]]
        self.assertEqual(pushed, [self.sim.stats.samples[-1]["tick"]])

    def test_a_push_is_under_20_kb(self):
        for _ in range(26 * 60):
            self.sim.step()
        self.sim.stats.take_new_samples()
        for _ in range(60):
            self.sim.step()
        push = self.sim.stats_json(full=False)
        self.assertEqual(len(push["samples"]), 1)
        self.assertLess(len(json.dumps(push).encode()), STATS_BYTES)


# --- the God welcome and the dashboard's requests ------------------------------------------------------------------

class Client:
    """Reads every message in the background, so a test can wait for one by shape."""

    def __init__(self, sock: ws.WebSocket):
        self.ws, self.inbox, self.closed = sock, [], False
        self._changed = asyncio.Event()
        self._task = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            while True:
                self.inbox.append(json.loads(await self.ws.recv()))
                self._changed.set()
        except (ws.ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            self.closed = True
            self._changed.set()

    async def expect(self, pred, timeout: float = TIMEOUT) -> dict:
        if isinstance(pred, str):
            kind = pred
            pred = lambda m: m.get("type") == kind  # noqa: E731

        async def wait():
            while True:
                for i, m in enumerate(self.inbox):
                    if pred(m):
                        return self.inbox.pop(i)
                if self.closed:
                    raise AssertionError("connection closed while waiting")
                self._changed.clear()
                await self._changed.wait()

        return await asyncio.wait_for(wait(), timeout)

    async def request(self, msg: dict) -> dict:
        rid = os.urandom(4).hex()
        await self.ws.send(json.dumps({**msg, "req_id": rid}))
        return await self.expect(lambda m: m.get("req_id") == rid)

    async def close(self) -> None:
        await self.ws.close()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


class ServerCase(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Built once and copied for each test, all outside the event loop: its debug mode reports any step that
        # holds the loop for 0.1 s, and 600 steps do.
        super().setUpClass()
        sim = Simulation(seed=1)
        for _ in range(10 * 60):  # to 16:00: news, a headline or two, hourly samples
            sim.step()
        dana = sim.agents["dana"]
        if not sim.news:  # seed 1's first news now comes at 18:00 (v3 D: meetings only nearby, fewer routine lines)
            sim.event("Dana: Makes a breakthrough (+$50).", dana, tag="money_swing")
        for by in ("model", "timeout", "habit"):
            sim._decide(dana, plain_fork("dana", sim.clock.tick), 1, by, "because")
        cls.city = sim

    def setUp(self):
        self.sim = copy.deepcopy(self.city)

    async def asyncSetUp(self):
        self.server = GameServer(self.sim, speed=0)
        self.port = await self.server.start("127.0.0.1", 0)
        self.clients: list[Client] = []

    async def asyncTearDown(self):
        for c in self.clients:
            await c.close()
        await asyncio.wait_for(self.server.stop(), TIMEOUT)

    async def god(self) -> tuple[Client, dict]:
        c = Client(await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{self.port}/ws"), TIMEOUT))
        self.clients.append(c)
        await c.ws.send(json.dumps({"type": "hello", "role": "god"}))
        return c, await c.expect("welcome")


class TestWelcome(ServerCase):
    async def test_the_welcome_fields(self):
        _, welcome = await self.god()
        sim = self.sim
        self.assertEqual(welcome["host"], {"kind": "server", "controllers": True})
        stats = welcome["stats"]
        self.assertEqual((stats["type"], stats["full"], stats["tick"]), ("stats", True, sim.clock.tick))
        self.assertEqual([s["tick"] for s in stats["samples"]], [s["tick"] for s in sim.stats.samples])
        self.assertEqual(len(stats["samples"]), 10)
        self.assertEqual(welcome["news"], sim.news[-server_module.WELCOME_NEWS:])
        self.assertTrue(welcome["news"] and all(e["importance"] >= 1 for e in welcome["news"]))
        self.assertTrue(all(e["importance"] == 2 for e in welcome["headlines"]))
        self.assertEqual([f["decided_by"] for f in welcome["llm_log"]], ["model", "timeout"])
        self.assertEqual(find_secret_keys(welcome), [])

    async def test_nobody_playing_is_the_browser_hosts_empty_state(self):
        # The browser port has no controllers: its welcome says host.kind "browser" and its LLM log is empty. A
        # server city nobody plays sends the same empty data, and the dashboard renders the browser's empty state
        # from host.kind alone (no character pages either).
        sim = Simulation(seed=1)
        server = GameServer(sim, speed=0)
        welcome = server._welcome_god()
        self.assertEqual(welcome["llm_log"], [])
        llm = welcome["stats"]["llm"]
        self.assertEqual((llm["controllers"], llm["playing"], llm["thinking"]), ([], 0, 0))
        self.assertEqual(set(llm["today"].values()) - {0}, {None}, "every counter 0, avg_seconds null")
        self.assertEqual(sim.decisions(), {"type": "decisions", "agent_id": None, "forks": [], "more": False})
        dash = (CLIENT / "dashboard.js").read_text()
        self.assertRegex(dash, r'function characterHref\(id\) \{\s*if \(!S \|\| S\.host\.kind === "browser"')
        self.assertIn("This browser version", dash)
        browser = {**welcome, "host": {"kind": "browser", "controllers": False}}
        self.assertEqual(find_secret_keys(browser), [])


class TestRequests(ServerCase):
    async def check_requests(self, c: Client) -> None:
        stats = await c.request({"type": "get_stats"})
        self.assertEqual((stats["type"], stats["full"]), ("stats", True))
        self.assertEqual(len(stats["samples"]), len(self.sim.stats.samples))
        city = await c.request({"type": "get_decisions"})
        self.assertEqual((city["type"], city["agent_id"], city["more"]), ("decisions", None, False))
        self.assertEqual([f["decided_by"] for f in city["forks"]], ["timeout", "model"], "newest first")
        page = await c.request({"type": "get_decisions", "agent_id": "dana", "before": city["forks"][0]["id"],
                                "limit": 5})
        self.assertEqual((page["agent_id"], [f["id"] for f in page["forks"]]), ("dana", [city["forks"][1]["id"]]))
        unknown = await c.request({"type": "get_decisions", "agent_id": "nobody"})
        self.assertEqual(unknown, {"type": "error", "error": "unknown character", "req_id": unknown["req_id"]})
        bad = await c.request({"type": "get_decisions", "limit": "lots"})
        self.assertEqual((bad["type"], bad["error"]), ("error", "bad message: limit must be a number"))
        home_id = self.sim.households[self.sim.agents["dana"].household_id].home_id
        home = await c.request({"type": "get_home", "home_id": home_id})
        self.assertEqual((home["type"], home["home"]["id"]), ("home", home_id))
        missing = await c.request({"type": "get_home", "home_id": "nowhere"})
        self.assertEqual((missing["type"], missing["error"]), ("error", "unknown home"))
        for reply in (stats, city, page, home):
            self.assertEqual(find_secret_keys(reply), [])

    async def test_god_asks(self):
        god, _ = await self.god()
        await self.check_requests(god)

    async def test_a_demoted_watcher_asks_too(self):
        watcher, _ = await self.god()
        await self.god()
        await watcher.expect("demoted")
        await self.check_requests(watcher)
        refused = await watcher.request({"type": "set_speed", "speed": 4})
        self.assertEqual(refused["type"], "error", "but changes nothing")


# --- the God view's page --------------------------------------------------------------------------------------------

class _Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts, self.styles, self.ids, self.stack = [], [], {}, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and a.get("src"):
            self.scripts.append(a["src"])
        if tag == "link" and a.get("rel") == "stylesheet":
            self.styles.append(a["href"])
        if "id" in a:
            self.ids[a["id"]] = (tag, [t for t, _ in self.stack], a)
        if tag not in ("meta", "link", "br", "img", "input"):
            self.stack.append((tag, a.get("id")))

    def handle_endtag(self, tag):
        while self.stack and self.stack.pop()[0] != tag:
            pass


async def http_get(port: int, path: str) -> tuple[int, dict, bytes]:
    reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), TIMEOUT)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
    await writer.drain()
    data = await asyncio.wait_for(reader.read(), TIMEOUT)
    writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
    return int(lines[0].split()[1]), headers, body


class TestPage(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.page = _Page()
        self.page.feed((CLIENT / "index.html").read_text())

    def test_the_plan_3_12_order(self):
        self.assertEqual(self.page.scripts, SCRIPTS)
        self.assertEqual(self.page.styles, STYLES)

    def test_the_dom_dash_and_the_view_expect(self):
        ids = self.page.ids
        self.assertEqual(ids["map"][0], "canvas")
        for name in ("map", "hud", "overlay-chips", "toasts", "ticker", "tooltip"):
            self.assertEqual(ids[name][1][-1], "section", name)  # straight inside #world
            self.assertIn("main", ids[name][1])
        self.assertIn("hidden", ids["tooltip"][2])
        self.assertEqual((ids["world"][0], ids["panel"][0], ids["stage"][0]), ("section", "aside", "main"))
        self.assertNotIn("toast", ids, "errors go to #toasts now")
        self.assertNotRegex((CLIENT / "game.js").read_text(), r"\btoast\(")

    def test_style_css_never_styles_the_views_controls(self):
        self.assertNotIn(".cv-", (CLIENT / "style.css").read_text())

    async def test_every_script_is_served_as_javascript(self):
        server = GameServer(Simulation(seed=1), speed=0)
        port = await server.start("127.0.0.1", 0)
        try:
            for src in SCRIPTS:
                status, headers, body = await http_get(port, "/" + src)
                self.assertEqual(status, 200, src)
                self.assertRegex(headers["content-type"], r"^(text|application)/javascript", src)
                self.assertEqual(body, (CLIENT / src).read_bytes(), src)
            for href in STYLES:
                status, headers, _ = await http_get(port, "/" + href)
                self.assertEqual((status, headers["content-type"].split(";")[0]), (200, "text/css"), href)
        finally:
            await server.stop()


class _AtTheEnd(unittest.TestSuite):
    """Holds its tests back until the run ends. In the run it only wraps the result's stopTestRun, which
    TextTestRunner (so `python3 -m unittest` in any form) calls once after all the tests: the held tests run there,
    before the runner's own stopTestRun and its report, and count like any other. With any other result (a
    caller that may never call stopTestRun), or in a debug run, they run in place. They run as bare test cases,
    outside any suite's class and module fixtures (the run's last ones are torn down by then), so they need none."""

    def _cases(self, suite):
        for t in suite:
            yield from (self._cases(t) if isinstance(t, unittest.TestSuite) else (t,))

    def run(self, result, debug=False):
        if debug or not isinstance(result, unittest.TextTestResult):
            return super().run(result, debug)
        stop = result.stopTestRun
        held = list(self._cases(self))

        def stop_test_run():
            result.stopTestRun = stop
            for test in held:
                if result.shouldStop:
                    break
                test(result)
            stop()

        result.stopTestRun = stop_test_run
        return result


def load_tests(loader, tests, pattern):
    """This module's tests, with the real-time report's held until the whole run ends: by then the child is done
    (when the suite outlasts it), or has had every other test's time as its head start."""
    rest, last = [], []
    for suite in tests:
        (last if any(isinstance(t, CoalescingAndCadenceTest) for t in suite) else rest).append(suite)
    return unittest.TestSuite(rest + [_AtTheEnd(last)])


if __name__ == "__main__":
    unittest.main()
