"""Integration (P6): a session recorded from a running server, checked against docs/protocol.md.

By default (a few seconds):

- RecordedSession records one session against an in-process server on seed 1. The simulation runs on a fake
  clock (Simulation(now=...)), so a fork times out and takes a late answer without any real waiting, and the
  stats cadence is moved on with server._stats_at. It records God's welcome, state frames with and without
  `lots` and `homes`, a stats push, a controller's welcome (with a model), forks, in-time and late acks, every
  `query`, a text and its push, an invite and its answer, every God request, claim and release, a second God
  view taking over and the watcher's refusal, and the errors. Then:
    - every field name in those messages, both ways, is written in docs/protocol.md (in backticks or as a
      "quoted" key), except the keys of id maps (characters, places, homes, tiers);
    - every message type the server sent is shown in docs/protocol.md as "type": "<it>";
    - the message types docs/protocol.md lists under God messages and Controller messages are exactly the ones
      server.py handles, and the session sent each of them and was not told it was an unknown type;
    - no key that could reveal hidden odds (SECRET_KEYS) appears anywhere in the session;
    - the agent row's `vehicle` lists exactly the vehicles the engine has (travel.SPEEDS), and every `vehicle` and
      `state` in the recorded frames is one the row lists.
- DevFixture checks that client/dev/fixture_town.js is the seed-1 city the engine makes now (its town, and its
  state at Day 1 Mon 08:15). After an engine change it fails until the fixture is made again with

      python3 -m tests.test_integration --write-fixture

With GOAL_SLOW=1:

- Headless7Days runs seven game days headless on seeds 1 and 2 (about 7 s): no exceptions, every fork has four
  distinct options; on seed 2 a fake controller plays every other character and answers in time.
- FullAppSmoke runs tests/browser/full_app_smoke.cjs (about a minute) when node is installed; it skips itself
  without Playwright or a browser.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import itertools
import json
import os
import random
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from gameofailife import ws
from gameofailife.__main__ import run_headless
from gameofailife.server import HOUSING_EVERY, STATS_SECONDS, GameServer
from gameofailife.sim import ANSWER_SECONDS, Simulation
from gameofailife.travel import SPEEDS

ROOT = Path(__file__).resolve().parent.parent
PROTOCOL = ROOT / "docs" / "protocol.md"
SERVER_PY = ROOT / "gameofailife" / "server.py"
SMOKE = ROOT / "tests" / "browser" / "full_app_smoke.cjs"
FIXTURE = ROOT / "client" / "dev" / "fixture_town.js"
FIXTURE_AT = "Day 1 Mon 08:15"  # the first morning: people on their way to work and school
TIMEOUT = 5.0

# Keys that would reveal hidden odds or outcome tables (the same set as tests/test_server.py's).
SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence", "due",
               "pending_emergency", "roll", "base_p", "hit"}

# Objects keyed by ids (characters, places, homes, tiers), not by field names: (message type, path).
ID_MAPS = {("welcome", "profiles"), ("welcome", "state.lots"), ("welcome", "state.homes"),
           ("welcome", "town.housing.tiers"), ("state", "state.lots"), ("state", "state.homes"),
           ("agent", "agent.relationships"), ("answer:relationships", "data"), ("answer:people", "data"),
           ("answer:world", "data.places")}

QUERIES = ("possessions", "attributes", "relationships", "memory", "inbox", "world", "people", "market")


def find_secret_keys(obj, path="") -> list[str]:
    """Every key anywhere in a JSON value that would reveal outcome odds."""
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


def field_names(kind: str, obj, path: str = "", out: dict | None = None) -> dict[str, str]:
    """Every field name in a message -> one path it was seen at; the keys of ID_MAPS objects are skipped (their
    values' fields are not)."""
    out = {} if out is None else out
    if isinstance(obj, dict):
        ids = (kind, path) in ID_MAPS
        for k, v in obj.items():
            here = f"{path}.{k}" if path else k
            if ids:
                field_names(kind, v, f"{path}.*", out)
            else:
                out.setdefault(k, f"{kind}: {here}")
                field_names(kind, v, here, out)
    elif isinstance(obj, list):
        for v in obj:
            field_names(kind, v, path + "[]", out)
    return out


def kind_of(msg: dict) -> str:
    return f"answer:{msg.get('what')}" if msg.get("type") == "answer" else str(msg.get("type"))


def documented_names(text: str) -> set[str]:
    """The names docs/protocol.md writes in backticks (`state.lots`, `you.home`, ...) or as "quoted" keys."""
    names: set[str] = set()
    for span in re.findall(r"`([^`\n]+)`", text):
        names.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", span))
    names.update(re.findall(r'"([A-Za-z_][A-Za-z0-9_]*)"', text))
    return names


def documented_requests(text: str) -> dict[str, set[str]]:
    """The message types under '## God messages' and '## Controller messages': their '### `type`' headings."""
    out = {}
    for role, title in (("god", "God messages"), ("controller", "Controller messages")):
        m = re.search(rf"^## {title}\n(.*?)(?=^## )", text, re.M | re.S)
        assert m, f"docs/protocol.md has no '## {title}' section"
        out[role] = set(re.findall(r"^### `(\w+)`", m.group(1), re.M))
    return out


AGENT_ROW = "An agent in `agents`:"  # docs/protocol.md's table of an agent row's fields follows this line


def documented_values(text: str, field: str, after: str = AGENT_ROW) -> set[str]:
    """The values that the first table row for `field` (| `field` | ... |) after the line `after` in
    docs/protocol.md lists in backticks, before any note in brackets."""
    at = text.find(after)
    assert at >= 0, f"docs/protocol.md has no line {after!r}"
    m = re.compile(rf"^\| `{field}` +\|(.*)\|\s*$", re.M).search(text, at)
    assert m, f"docs/protocol.md has no table row for `{field}` after {after!r}"
    return set(re.findall(r"`([^`]+)`", m.group(1).split(" (")[0]))


def handled_requests() -> dict[str, set[str]]:
    """The message types server.py's _god and _controller handle (`t == "x"` and `t in ("x", ...)`)."""
    src = SERVER_PY.read_text()
    out = {}
    for role, fn in (("god", "_god"), ("controller", "_controller")):
        m = re.search(rf"    def {fn}\(.*?(?=\n    def |\nasync def |\Z)", src, re.S)
        assert m, f"server.py has no {fn}"
        body = m.group(0)
        types = set(re.findall(r'\bt == "(\w+)"', body))
        for group in re.findall(r"\bt in \(([^)]*)\)", body):
            types.update(re.findall(r'"(\w+)"', group))
        out[role] = types
    return out


class Clock:
    """The fork clock the simulation reads (Simulation(now=...)): real seconds, moved on by hand."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Peer:
    """One connection: reads every message in the background into the session log, and waits for one by shape."""

    _ids = itertools.count(1)

    def __init__(self, who: str, sock: ws.WebSocket, log: list):
        self.who, self.ws, self.log = who, sock, log
        self.inbox: list[dict] = []
        self.auto_answer = False  # answer each new fork at once (in time: the clock stands still)
        self._changed = asyncio.Event()
        self._task = asyncio.create_task(self._read())

    @classmethod
    async def open(cls, who: str, port: int, log: list) -> "Peer":
        sock = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{port}/ws"), TIMEOUT)
        return cls(who, sock, log)

    async def _read(self) -> None:
        try:
            while True:
                msg = json.loads(await self.ws.recv())
                self.log.append(("got", self.who, msg))
                self.inbox.append(msg)
                if self.auto_answer and msg.get("type") == "fork":
                    asyncio.ensure_future(self.send({"type": "choose", "fork_id": msg["fork_id"], "choice": 0,
                                                     "reason": "It suits me."}))
                self._changed.set()
        except (ws.ConnectionClosed, asyncio.CancelledError, OSError):
            pass
        finally:
            self._changed.set()

    async def send(self, msg: dict) -> None:
        self.log.append(("sent", self.who, msg))
        await self.ws.send(json.dumps(msg))

    async def expect(self, pred, timeout: float = TIMEOUT) -> dict:
        """Remove and return the first message, already read or still to come, that matches pred."""
        if isinstance(pred, str):
            kind = pred
            pred = lambda m: m.get("type") == kind  # noqa: E731

        async def wait() -> dict:
            while True:
                for i, m in enumerate(self.inbox):
                    if pred(m):
                        return self.inbox.pop(i)
                self._changed.clear()
                await self._changed.wait()
        return await asyncio.wait_for(wait(), timeout)

    async def request(self, msg: dict, timeout: float = TIMEOUT) -> dict:
        """Send msg with a fresh req_id and return its direct reply."""
        rid = next(self._ids)
        await self.send({**msg, "req_id": rid})
        return await self.expect(lambda m: m.get("req_id") == rid, timeout)

    async def close(self) -> None:
        self._task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.ws.close(), 1.0)


async def record_session() -> tuple[list, dict]:
    """Play one session against a real server on seed 1; returns the log [(direction, who, message)] and notes."""
    clock = Clock()
    sim = Simulation(seed=1, now=clock)
    server = GameServer(sim, speed=16)
    port = await server.start("127.0.0.1", 0)
    log: list = []
    notes: dict = {}
    peers: list[Peer] = []
    try:
        god = await Peer.open("god", port, log)
        peers.append(god)
        notes["welcome"] = await god.request({"type": "hello", "role": "god"})
        ctl = await Peer.open("controller", port, log)
        peers.append(ctl)
        notes["controller_welcome"] = await ctl.request(
            {"type": "hello", "role": "controller", "name": "rec", "model": "fake-model-1", "characters": "all"})
        # An invite early, so the guest meets it soon after the clock moves on.
        notes["invited"] = await ctl.request({"type": "invite", "agent_id": "ari", "to": "tom", "place": "cafe"})

        # Two forks: one answered in time, one left to time out and answered late (the clock moves on 6 s).
        first, second = await ctl.expect("fork"), await ctl.expect("fork")
        notes["fork"] = first
        notes["ack"] = await ctl.request({"type": "choose", "fork_id": first["fork_id"], "choice": 1,
                                          "reason": "In time."})
        clock.t += ANSWER_SECONDS + 1
        late_id = second["fork_id"]
        await god.expect(lambda m: m.get("type") == "state" and any(
            f["id"] == late_id and f["decided_by"] == "timeout" for f in m["forks"]))
        notes["late_ack"] = await ctl.request({"type": "choose", "fork_id": late_id, "choice": 2,
                                               "reason": "Sorry, too slow."})
        notes["late_frame"] = await god.expect(lambda m: m.get("type") == "state" and any(
            f["id"] == late_id and f["late"] for f in m["forks"]))
        notes["too_late"] = await ctl.request({"type": "choose", "fork_id": late_id, "choice": 3})
        notes["unknown_fork"] = await ctl.request({"type": "choose", "fork_id": "f999999", "choice": 0})
        ctl.inbox = [m for m in ctl.inbox if m.get("type") != "fork"]  # all timed out with the clock
        ctl.auto_answer = True

        # Every query, then texts, claim and release.
        notes["queries"] = {what: await ctl.request({"type": "query", "agent_id": "ari", "what": what})
                            for what in QUERIES}
        notes["bad_query"] = await ctl.request({"type": "query", "agent_id": "ari", "what": "odds"})
        notes["sent"] = await ctl.request({"type": "send_message", "agent_id": "ari", "to": "tom",
                                           "text": "Coffee later?"})
        notes["message"] = await ctl.expect("message")
        notes["sent_self"] = await ctl.request({"type": "send_message", "agent_id": "ari", "to": "ari",
                                                "text": "Hello me."})
        notes["released"] = await ctl.request({"type": "release", "agent_id": "dana"})
        notes["not_yours"] = await ctl.request({"type": "query", "agent_id": "dana", "what": "memory"})
        notes["claimed"] = await ctl.request({"type": "claim", "agent_id": "dana"})
        notes["ctl_unknown_type"] = await ctl.request({"type": "get_stats"})

        # Every God request.
        g = notes["god"] = {}
        g["agent"] = await god.request({"type": "get_agent", "agent_id": "ari"})
        g["unknown_agent"] = await god.request({"type": "get_agent", "agent_id": "nobody"})
        g["home_flat"] = await god.request({"type": "get_home", "home_id": "birch_court_2b"})
        g["home_house"] = await god.request({"type": "get_home", "home_id": "main_20"})
        g["unknown_home"] = await god.request({"type": "get_home", "home_id": "birch_court"})
        g["stats"] = await god.request({"type": "get_stats"})
        g["decisions"] = await god.request({"type": "get_decisions"})
        g["decisions_agent"] = await god.request({"type": "get_decisions", "agent_id": second["agent_id"],
                                                  "limit": 5})
        g["bad_limit"] = await god.request({"type": "get_decisions", "limit": "lots"})
        g["luck"] = await god.request({"type": "set_luck", "agent_id": "tom", "luck": 75})
        g["profile"] = await god.request({"type": "set_profile", "agent_id": "tom", "traits": {"thrift": 0.9}})
        g["pause"] = await god.request({"type": "pause"})
        g["resume"] = await god.request({"type": "resume"})
        g["speed"] = await god.request({"type": "set_speed", "speed": 16})
        g["unknown_type"] = await god.request({"type": "choose", "fork_id": "f1", "choice": 0})

        # A stats push: the cadence moved on by STATS_SECONDS.
        server._stats_at -= STATS_SECONDS
        notes["stats_push"] = await god.expect(lambda m: m.get("type") == "stats" and "req_id" not in m)

        # The invite's answer (the guest is free soon after 06:00 on Monday).
        invite_id = notes["invited"]["invite"]["id"]
        notes["invite_answer"] = await ctl.expect(
            lambda m: m.get("type") == "invite_answer" and m.get("invite_id") == invite_id, timeout=15)

        # A second God view takes over; the first one watches.
        god2 = await Peer.open("god2", port, log)
        peers.append(god2)
        await god2.request({"type": "hello", "role": "god"})
        notes["demoted"] = await god.expect("demoted")
        notes["watcher_luck"] = await god.request({"type": "set_luck", "agent_id": "tom", "luck": 10})
        notes["watcher_home"] = await god.request({"type": "get_home", "home_id": "main_20"})

        # Bad hellos and messages before hello.
        bad = await Peer.open("bad", port, log)
        peers.append(bad)
        notes["before_hello"] = await bad.request({"type": "get_stats"})
        notes["bad_hello"] = await bad.request({"type": "hello", "role": "controller", "characters": 5})
        notes["bad_role"] = await bad.request({"type": "hello", "role": "mayor"})

        # Frames with and without the housing maps: wait out one HOUSING_EVERY round if none came yet.
        def frames(with_maps: bool) -> list:
            return [m for d, w, m in log if d == "got" and w == "god" and m.get("type") == "state"
                    and ("lots" in m["state"]) == with_maps]
        for _ in range(HOUSING_EVERY * 2):
            if frames(True) and frames(False):
                break
            await asyncio.sleep(0.05)
        notes["frames_with_maps"], notes["frames_without_maps"] = len(frames(True)), len(frames(False))
    finally:
        for peer in peers:
            await peer.close()
        await server.stop()
    return log, notes


class RecordedSession(unittest.TestCase):
    """One session from a real server, and docs/protocol.md."""

    @classmethod
    def setUpClass(cls):
        cls.log, cls.notes = asyncio.run(asyncio.wait_for(record_session(), 60))
        cls.doc = PROTOCOL.read_text()

    def received(self, who: str | None = None) -> list[dict]:
        return [m for d, w, m in self.log if d == "got" and (who is None or w == who)]

    def test_the_session_covers_the_protocol(self):
        n = self.notes
        welcome, cw = n["welcome"], n["controller_welcome"]
        self.assertEqual(welcome["type"], "welcome")
        for key in ("town", "state", "history", "news", "headlines", "llm_log", "host", "stats", "speed"):
            self.assertIn(key, welcome)
        self.assertEqual(welcome["host"], {"kind": "server", "controllers": True})
        self.assertTrue(welcome["stats"]["full"])
        self.assertIn("lots", welcome["state"])
        self.assertIn("homes", welcome["state"])
        self.assertEqual((cw["role"], cw["name"], cw["answer_seconds"]), ("controller", "rec", 5))
        self.assertEqual(len(cw["characters"]), 60)
        self.assertEqual(len(n["fork"]["options"]), 4)
        self.assertEqual((n["ack"]["accepted"], n["ack"]["applied"]), (True, True))
        self.assertEqual((n["late_ack"]["accepted"], n["late_ack"]["applied"]), (True, False))
        self.assertEqual(n["late_ack"]["note"], "too late to act on; saved to the profile")
        late = next(f for f in n["late_frame"]["forks"] if f["late"])
        self.assertEqual((late["decided_by"], late["controller"], late["model"]), ("timeout", "rec", "fake-model-1"))
        self.assertEqual(late["late"]["choice"], 2)
        self.assertGreater(late["late"]["seconds"], 5)
        self.assertEqual(n["too_late"]["error"], "too late")
        self.assertEqual(n["unknown_fork"]["error"], "unknown fork")
        self.assertEqual({w: q["type"] for w, q in n["queries"].items()}, {w: "answer" for w in QUERIES})
        self.assertIn("for_sale", n["queries"]["market"]["data"])
        self.assertTrue(n["bad_query"]["error"].startswith("what must be one of"))
        self.assertEqual(n["sent"], {"type": "sent", "ok": True, "req_id": n["sent"]["req_id"]})
        self.assertEqual(n["message"]["from_name"], "Ari Ben-David")
        self.assertEqual(n["sent_self"]["error"], "can't message yourself")
        self.assertEqual(n["not_yours"]["error"], "not your character")
        self.assertTrue(n["claimed"]["ok"])
        self.assertEqual(n["ctl_unknown_type"]["error"], "unknown message type 'get_stats'")
        g = n["god"]
        self.assertEqual((g["agent"]["type"], g["home_flat"]["type"], g["home_house"]["type"]), ("agent", "home", "home"))
        self.assertEqual(g["unknown_agent"]["error"], "unknown character")
        self.assertEqual(g["unknown_home"]["error"], "unknown home")
        self.assertEqual((g["stats"]["type"], g["stats"]["full"]), ("stats", True))
        self.assertEqual((g["decisions"]["type"], g["decisions"]["agent_id"]), ("decisions", None))
        self.assertTrue(any(f["late"] for f in g["decisions_agent"]["forks"]), g["decisions_agent"])
        self.assertEqual(g["bad_limit"]["error"], "bad message: limit must be a number")
        self.assertEqual((g["luck"]["ok"], g["luck"]["luck"]), (True, 75.0))
        self.assertEqual([g[k]["speed"] for k in ("pause", "resume", "speed")], [0, 1, 16])
        self.assertEqual(g["unknown_type"]["error"], "unknown message type 'choose'")
        self.assertFalse(n["stats_push"]["full"])
        self.assertEqual(n["invite_answer"]["agent_id"], "ari")
        self.assertEqual(n["demoted"]["reason"], "another God view took over")
        self.assertEqual(n["watcher_luck"]["error"], "only God can do that; this view is watching")
        self.assertEqual(n["watcher_home"]["type"], "home")
        self.assertEqual(n["before_hello"]["error"], "say hello first")
        self.assertTrue(n["bad_hello"]["error"].startswith("bad hello:"))
        self.assertEqual(n["bad_role"]["error"], "role must be god or controller")
        self.assertGreater(n["frames_with_maps"], 0, "no state frame carried lots and homes")
        self.assertGreater(n["frames_without_maps"], 0, "every state frame carried lots and homes")

    def test_every_field_name_is_in_the_protocol(self):
        names = documented_names(self.doc)
        seen: dict[str, str] = {}
        for _, _, msg in self.log:  # both ways: what the server sent and what the session sent it
            field_names(kind_of(msg), msg, out=seen)
        missing = sorted(f"{name} ({where})" for name, where in seen.items() if name not in names)
        self.assertEqual(missing, [], "field names docs/protocol.md does not mention")

    def test_every_message_type_the_server_sent_is_in_the_protocol(self):
        sent = {m["type"] for m in self.received()}
        self.assertTrue({"welcome", "state", "stats", "fork", "ack", "answer", "message", "invite_answer",
                         "demoted", "error"} <= sent, sent)
        missing = sorted(t for t in sent if f'"type": "{t}"' not in self.doc)
        self.assertEqual(missing, [], 'message types docs/protocol.md never shows as "type": "<it>"')

    def test_the_protocol_lists_the_requests_the_server_handles(self):
        documented, handled = documented_requests(self.doc), handled_requests()
        self.assertEqual(documented, handled)
        # ... and the session sent each one on its role and was not told it was an unknown type
        replies = {}
        for d, who, msg in self.log:
            if d == "got" and "req_id" in msg:
                replies[(who, msg["req_id"])] = msg
        for role, who in (("god", "god"), ("controller", "controller")):
            for t in sorted(documented[role]):
                sent = [m for d, w, m in self.log if d == "sent" and w == who and m.get("type") == t]
                self.assertTrue(sent, f"the session never sent {t}")
                for m in sent:
                    reply = replies.get((who, m.get("req_id")))
                    if reply is not None:
                        self.assertFalse(str(reply.get("error", "")).startswith("unknown message type"), (m, reply))

    def test_the_agent_rows_values_are_in_the_protocol(self):
        vehicles, states = documented_values(self.doc, "vehicle"), documented_values(self.doc, "state")
        self.assertEqual(vehicles, set(SPEEDS), "the `vehicle` row must list every vehicle in travel.SPEEDS")
        seen = {"vehicle": set(), "state": set()}
        for msg in self.received("god"):
            for a in msg.get("state", {}).get("agents", []):
                for key in seen:
                    seen[key].add(a[key])
        self.assertIn("walk", seen["vehicle"])
        self.assertLessEqual(seen["vehicle"], vehicles)
        self.assertLessEqual(seen["state"], states)

    def test_no_message_reveals_hidden_odds(self):
        for d, who, msg in self.log:
            if d == "got":
                self.assertEqual(find_secret_keys(msg), [], f"{who} got {msg.get('type')}")
        self.assertGreater(len(self.log), 50)


# --- the view's dev fixture ----------------------------------------------------------------------------------

FIXTURE_HEAD = f"""// CityView dev fixture (PLAN decision 81): window.CITY_FIXTURE = {{town, state}}, generated from the real seed-1 city.
//   town   sim.town_json() (PLAN 3.2): the 80 x 50 Millbrook of city.md 3.4 with its places, the 37 homes of
//          PLAN 4.2, housing, districts, streets, junctions, stops and the bus timetable
//   state  sim.state_json(housing=True) (PLAN 3.3) at {FIXTURE_AT}, the first morning: 60 people on their way to
//          work and school, 8 buses, and PLAN 4.2's start conditions and listings in lots and homes
// view.html adapts it for fake_state.js and picks each adult's workplace and hours itself (the state does not
// carry them). Made by `python3 -m tests.test_integration --write-fixture`, which steps
// gameofailife.sim.Simulation(seed=1) to {FIXTURE_AT}; tests/test_integration.py's DevFixture fails when
// the engine no longer makes this city.
// Generated data for client/dev/view.html; classic script.
"use strict";
"""


def fixture_data() -> dict:
    """The seed-1 city's town and its state at FIXTURE_AT, as the engine makes them now."""
    sim = Simulation(seed=1)
    town = sim.town_json()
    for _ in range(24 * 60):
        if sim.state_json(housing=False)["time"] == FIXTURE_AT:
            return {"town": town, "state": sim.state_json(housing=True)}
        sim.step()
        sim.drain()
    raise AssertionError(f"the seed-1 city never reached {FIXTURE_AT}")


def fixture_text(data: dict) -> str:
    """client/dev/fixture_town.js's text for fixture_data()."""
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"{FIXTURE_HEAD}window.CITY_FIXTURE = {body};\n"


def read_fixture() -> dict:
    m = re.search(r"^window\.CITY_FIXTURE = (.*?);?\s*\Z", FIXTURE.read_text(), re.M | re.S)
    assert m, "client/dev/fixture_town.js does not set window.CITY_FIXTURE"
    return json.loads(m.group(1))


@unittest.skipIf(os.environ.get("GOAL_SKIP_DEVFIXTURE") == "1",
                 "GOAL_SKIP_DEVFIXTURE=1: fixture_town.js is regenerated by the integrator after the v3 merge")
class DevFixture(unittest.TestCase):
    """client/dev/fixture_town.js (the city view's dev page and view_smoke.cjs) is the real seed-1 city."""

    def test_the_dev_fixture_is_the_seed_1_city(self):
        have, want = read_fixture(), fixture_data()
        stale = [f"town.{k}" for k in sorted(set(have["town"]) | set(want["town"]))
                 if have["town"].get(k) != want["town"].get(k)]
        stale += [f"state.{k}" for k in sorted(set(have["state"]) | set(want["state"]))
                  if have["state"].get(k) != want["state"].get(k)]
        self.assertEqual(stale, [], "client/dev/fixture_town.js is not the city the engine makes now; make it again "
                                    "with `python3 -m tests.test_integration --write-fixture`")
        same = FIXTURE.read_text() == fixture_text(want)  # not assertEqual: no diff of a 40 KB line
        self.assertTrue(same, "client/dev/fixture_town.js's text is not what --write-fixture writes")


@unittest.skipUnless(os.environ.get("GOAL_SLOW") == "1", "the 7-day headless runs (about 7 s) run with GOAL_SLOW=1")
class Headless7Days(unittest.TestCase):
    """Seven game days on seeds 1 and 2 through `python3 -m gameofailife --headless`'s run_headless."""

    def run_days(self, seed: int, controller: bool) -> None:
        sim = Simulation(seed=seed)
        rng = random.Random(seed)
        decided, asked, problems = [], [], []
        if controller:
            ids = [a.id for a in sim.living()][::2]
            sim.controller_joined("bot", "fake-model", [i for i in ids if sim.claim(i, "bot")])
        drain = sim.drain

        def checked_drain():
            events, forks, outbox = drain()
            for f in forks:
                decided.append(f["id"])
                if len(f["options"]) != 4 or len(set(f["options"])) != 4 or f["choice"] not in range(4):
                    problems.append(f)
            for name, msg in outbox:
                if msg["type"] != "fork":
                    continue
                asked.append(msg["fork_id"])
                labels = [o["label"] for o in msg["options"]]
                if [o["index"] for o in msg["options"]] != [0, 1, 2, 3] or len(set(labels)) != 4:
                    problems.append(msg)
                ack = sim.answer(msg["fork_id"], rng.randrange(4), "A fake controller's choice.", controller=name)
                if ack != {"accepted": True, "applied": True}:
                    problems.append((msg["fork_id"], ack))
            return events, forks, outbox

        sim.drain = checked_drain
        with contextlib.redirect_stdout(io.StringIO()) as out:
            run_headless(sim, 7)
        self.assertEqual(problems[:3], [])
        self.assertGreater(len(decided), 1000)
        self.assertEqual(sim.clock.day, 7)
        self.assertIn("Richest to poorest:", out.getvalue())
        if controller:
            self.assertGreater(len(asked), 50)

    def test_seed_1_on_profiles(self):
        self.run_days(1, controller=False)

    def test_seed_2_with_a_controller(self):
        self.run_days(2, controller=True)


class FullAppSmoke(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("GOAL_SLOW") == "1", "the full-app browser run (about a minute) runs with GOAL_SLOW=1")
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_full_app_smoke(self):
        # tests/browser/full_app_smoke.cjs prints SKIP and exits 0 without Playwright or a browser to launch
        try:
            run = subprocess.run(["node", str(SMOKE)], capture_output=True, text=True, timeout=600, cwd=str(ROOT))
        except subprocess.TimeoutExpired:
            self.fail("full_app_smoke.cjs did not finish in 10 minutes")
        if run.returncode == 0 and run.stdout.startswith("SKIP"):
            self.skipTest(run.stdout.strip())
        self.assertEqual(run.returncode, 0, (run.stdout + run.stderr)[-4000:])
        self.assertRegex(run.stdout, r"\d+ passed, 0 failed")


if __name__ == "__main__":
    if sys.argv[1:] == ["--write-fixture"]:  # python3 -m tests.test_integration --write-fixture
        FIXTURE.write_text(fixture_text(fixture_data()))
        print(f"wrote {FIXTURE.relative_to(ROOT)} ({FIXTURE_AT} on seed 1)")
    else:
        unittest.main()
