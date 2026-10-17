"""End-to-end tests of GameServer and the WebSocket layer over real sockets.

Every network wait goes through asyncio.wait_for, so a broken server fails a
test instead of hanging the run.
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import unittest

from gameofailife import forks, ws
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

TIMEOUT = 3.0
SECRET_KEYS = {"p", "outcomes", "odds", "probability", "probabilities", "luck_log", "scores", "valence"}


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


class Client:
    """A test client: reads every message in the background so we can wait for one by shape."""

    def __init__(self, sock: ws.WebSocket):
        self.ws = sock
        self.inbox: list[dict] = []
        self.raw: list[str] = []
        self.closed = False
        self._changed = asyncio.Event()
        self._task = asyncio.create_task(self._read())

    @classmethod
    async def connect(cls, port: int) -> "Client":
        sock = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{port}/ws"), TIMEOUT)
        return cls(sock)

    async def _read(self) -> None:
        try:
            while True:
                text = await self.ws.recv()
                self.raw.append(text)
                self.inbox.append(json.loads(text))
                self._changed.set()
        except (ws.ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            self.closed = True
            self._changed.set()

    async def send(self, msg) -> None:
        await self.ws.send(msg if isinstance(msg, str) else json.dumps(msg))

    async def expect(self, pred, timeout: float = TIMEOUT) -> dict:
        """Remove and return the first message (old or new) matching pred."""
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

    async def request(self, msg: dict, reply_type: str | None = None, timeout: float = TIMEOUT) -> dict:
        """Send with a req_id and wait for the reply that echoes it."""
        rid = os.urandom(4).hex()
        await self.send({**msg, "req_id": rid})
        reply = await self.expect(lambda m: m.get("req_id") == rid, timeout)
        if reply_type:
            assert reply.get("type") == reply_type, reply
        return reply

    async def close(self) -> None:
        await self.ws.close()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


async def http_get(port: int, path: str) -> tuple[int, dict, bytes]:
    reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), TIMEOUT)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
    await writer.drain()
    data = await asyncio.wait_for(reader.read(), TIMEOUT)  # the server closes after one response
    writer.close()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    status = int(lines[0].split()[1])
    headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
    return status, headers, body


async def wait_until(cond, timeout: float = TIMEOUT) -> None:
    async def poll():
        while not cond():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(poll(), timeout)


class ServerCase(unittest.IsolatedAsyncioTestCase):
    speed = 0  # paused unless a test needs time to run; the outbox still flushes

    async def asyncSetUp(self):
        self.sim = Simulation(seed=1)
        self.server = GameServer(self.sim, speed=self.speed)
        self.port = await self.server.start("127.0.0.1", 0)
        self.clients: list[Client] = []

    async def asyncTearDown(self):
        for c in self.clients:
            await c.close()
        await asyncio.wait_for(self.server.stop(), TIMEOUT)

    async def client(self) -> Client:
        c = await Client.connect(self.port)
        self.clients.append(c)
        return c

    async def god(self) -> tuple[Client, dict]:
        c = await self.client()
        await c.send({"type": "hello", "role": "god"})
        return c, await c.expect("welcome")

    async def controller(self, name: str, characters) -> tuple[Client, dict]:
        c = await self.client()
        await c.send({"type": "hello", "role": "controller", "name": name, "characters": characters})
        return c, await c.expect("welcome")

    def ask_hunger_fork(self, agent_id: str = "tom") -> forks.Fork:
        """Put a real, non-obvious hunger fork to the character, as the sim would."""
        agent = self.sim.agents[agent_id]
        agent.needs["hunger"] = 20
        fork = forks.hunger_fork(self.sim, agent)
        scores = sorted(forks.default_scores(agent, fork), reverse=True)
        self.assertLess(scores[0] - scores[1], forks.OBVIOUS_MARGIN, "precondition: the fork must not be obvious")
        self.sim.director(agent, fork)
        self.assertEqual(fork.status, "asked")
        return fork


class TestHttp(ServerCase):
    async def test_index_served_at_root(self):
        status, headers, body = await http_get(self.port, "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["content-type"])
        self.assertEqual(int(headers["content-length"]), len(body))
        with open(os.path.join(os.path.dirname(__file__), "..", "client", "index.html"), "rb") as f:
            self.assertEqual(body, f.read())

    async def test_other_client_files_served(self):
        status, headers, _ = await http_get(self.port, "/style.css")
        self.assertEqual(status, 200)
        self.assertIn("text/css", headers["content-type"])

    async def test_missing_file_is_404(self):
        for path in ("/nope.html", "/missing/deep/file.js"):
            status, _, _ = await http_get(self.port, path)
            self.assertEqual(status, 404, path)

    async def test_traversal_is_404(self):
        for path in ("/../README.md", "/../gameofailife/server.py", "/../../../../etc/passwd",
                     "/x/../../README.md", "/%2e%2e/README.md", "//etc/passwd", "/..", "/../"):
            status, _, body = await http_get(self.port, path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"GameServer", body)

    async def test_ws_path_without_upgrade_is_not_a_crash(self):
        status, _, _ = await http_get(self.port, "/ws")
        self.assertEqual(status, 404)
        status, _, _ = await http_get(self.port, "/")
        self.assertEqual(status, 200)


class TestGod(ServerCase):
    async def test_welcome_has_town_and_state(self):
        _, welcome = await self.god()
        self.assertEqual(welcome["role"], "god")
        tiles = welcome["town"]["tiles"]
        self.assertEqual(len(tiles), 25)
        self.assertTrue(all(len(row) == 40 for row in tiles))
        self.assertEqual((welcome["town"]["w"], welcome["town"]["h"]), (40, 25))
        self.assertEqual(len(welcome["state"]["agents"]), 20)
        self.assertEqual(welcome["speed"], 0)

    async def test_speed_pause_resume(self):
        god, _ = await self.god()
        self.assertEqual((await god.request({"type": "set_speed", "speed": 4}, "speed"))["speed"], 4)
        self.assertEqual(self.server.speed, 4)
        self.assertEqual((await god.request({"type": "set_speed", "speed": 3}, "speed"))["speed"], 1)
        self.assertEqual((await god.request({"type": "pause"}, "speed"))["speed"], 0)
        tick = self.sim.clock.tick
        await asyncio.sleep(0.3)
        self.assertEqual(self.sim.clock.tick, tick, "paused sim must not advance")
        self.assertEqual((await god.request({"type": "resume"}, "speed"))["speed"], 1)
        await god.request({"type": "set_speed", "speed": 16}, "speed")
        await wait_until(lambda: self.sim.clock.tick > tick)

    async def test_state_frames_arrive_when_running(self):
        god, _ = await self.god()
        await god.request({"type": "set_speed", "speed": 16}, "speed")
        first = await god.expect("state")
        second = await god.expect("state")
        self.assertEqual(first["speed"], 16)
        self.assertEqual(len(first["state"]["agents"]), 20)
        self.assertGreater(second["state"]["tick"], first["state"]["tick"] - 1)
        self.assertIn("events", first)
        self.assertIn("forks", first)
        self.assertEqual(find_secret_keys(first), [])

    async def test_set_luck_and_clamp(self):
        god, _ = await self.god()
        r = await god.request({"type": "set_luck", "agent_id": "tom", "luck": 80}, "luck_set")
        self.assertTrue(r["ok"])
        self.assertEqual(r["luck"], 80)
        self.assertEqual(self.sim.agents["tom"].luck, 80)
        r = await god.request({"type": "set_luck", "agent_id": "tom", "luck": 250}, "luck_set")
        self.assertEqual(r["luck"], 100)
        r = await god.request({"type": "set_luck", "agent_id": "tom", "luck": -40}, "luck_set")
        self.assertEqual(r["luck"], 0)
        self.assertEqual(self.sim.agents["tom"].luck, 0)
        r = await god.request({"type": "set_luck", "agent_id": "nobody", "luck": 10}, "luck_set")
        self.assertFalse(r["ok"])
        r = await god.request({"type": "set_luck", "agent_id": "tom", "luck": "lots"}, "error")
        self.assertEqual(self.sim.agents["tom"].luck, 0)

    async def test_get_agent_has_no_outcome_probabilities(self):
        # Give Tom some decided forks and a pending outcome so there is history to leak.
        self.sim.agents["tom"].controller = None
        for _ in range(3):
            agent = self.sim.agents["tom"]
            agent.needs["hunger"] = 20
            agent.cooldowns.clear()
            fork = forks.hunger_fork(self.sim, agent)
            self.sim.director(agent, fork)
        god, _ = await self.god()
        r = await god.request({"type": "get_agent", "agent_id": "tom"}, "agent")
        agent = r["agent"]
        self.assertEqual(agent["id"], "tom")
        for key in ("money", "needs", "profile", "possessions", "relationships", "luck", "forks"):
            self.assertIn(key, agent)
        self.assertTrue(agent["forks"], "expected decided forks in the history")
        self.assertEqual(find_secret_keys(r), [])
        self.assertNotIn("pending_outcomes", json.dumps(r))
        r = await god.request({"type": "get_agent", "agent_id": "nobody"}, "error")

    async def test_set_profile(self):
        god, _ = await self.god()
        r = await god.request({"type": "set_profile", "agent_id": "tom", "prompt": "Loves the sea."}, "agent")
        self.assertEqual(r["agent"]["profile"]["prompt"], "Loves the sea.")

    async def test_unknown_type_is_error(self):
        god, _ = await self.god()
        await god.request({"type": "explode"}, "error")


class TestGodTakeover(ServerCase):
    async def test_second_god_takes_over(self):
        first, _ = await self.god()
        second, welcome = await self.god()
        self.assertEqual(welcome["role"], "god")
        demoted = await first.expect("demoted")
        self.assertIn("reason", demoted)
        r = await second.request({"type": "set_luck", "agent_id": "ari", "luck": 77}, "luck_set")
        self.assertTrue(r["ok"])
        # The demoted view still watches and may read character pages.
        await first.request({"type": "get_agent", "agent_id": "tom"}, "agent")

    async def test_demoted_god_cannot_change_luck(self):
        first, _ = await self.god()
        await self.god()
        await first.expect("demoted")
        before = self.sim.agents["tom"].luck
        await first.request({"type": "set_luck", "agent_id": "tom", "luck": 99}, "error")
        self.assertEqual(self.sim.agents["tom"].luck, before)

    async def test_demoted_god_cannot_change_speed(self):
        first, _ = await self.god()
        await self.god()
        await first.expect("demoted")
        await first.request({"type": "set_speed", "speed": 8}, "error")
        self.assertEqual(self.server.speed, 0)


class TestController(ServerCase):
    async def test_claims_characters(self):
        c, welcome = await self.controller("bot", ["tom", "ari", "nobody"])
        self.assertEqual(welcome["role"], "controller")
        self.assertEqual(welcome["name"], "bot")
        self.assertEqual(sorted(welcome["characters"]), ["ari", "tom"])
        self.assertIn("tom", welcome["profiles"])
        self.assertNotIn("tom", welcome["available"])
        self.assertEqual(self.sim.agents["tom"].controller, "bot")
        # Someone else cannot take Tom, and the second "bot" gets a unique name.
        other, w2 = await self.controller("bot", ["tom", "dana"])
        self.assertEqual(w2["name"], "bot-2")
        self.assertEqual(w2["characters"], ["dana"])
        r = await other.request({"type": "claim", "agent_id": "tom"}, "claimed")
        self.assertFalse(r["ok"])

    async def test_fork_choose_ack(self):
        c, _ = await self.controller("bot", ["tom"])
        fork = self.ask_hunger_fork("tom")
        msg = await c.expect(lambda m: m.get("type") == "fork" and m.get("fork_id") == fork.id)
        self.assertEqual(msg["agent_id"], "tom")
        self.assertEqual(len(msg["options"]), 4)
        self.assertEqual(find_secret_keys(msg), [], "fork must not reveal outcome odds")
        bad = await c.request({"type": "choose", "fork_id": fork.id, "choice": 9}, "ack")
        self.assertFalse(bad["accepted"])
        r = await c.request({"type": "choose", "fork_id": fork.id, "choice": 1, "reason": "want company"}, "ack")
        self.assertTrue(r["accepted"])
        self.assertTrue(r["applied"])
        self.assertEqual(fork.choice, 1)
        self.assertEqual(fork.decided_by, "model")
        again = await c.request({"type": "choose", "fork_id": "f-nope", "choice": 0}, "ack")
        self.assertFalse(again["accepted"])

    async def test_fork_seen_by_god_without_odds(self):
        god, _ = await self.god()
        c, _ = await self.controller("bot", ["tom"])
        fork = self.ask_hunger_fork("tom")
        await c.expect("fork")
        await c.request({"type": "choose", "fork_id": fork.id, "choice": 0}, "ack")
        frame = await god.expect(lambda m: m.get("type") == "state" and any(f["id"] == fork.id for f in m["forks"]))
        summary = next(f for f in frame["forks"] if f["id"] == fork.id)
        self.assertEqual(summary["decided_by"], "model")
        self.assertEqual(find_secret_keys(frame), [])

    async def test_other_controllers_cannot_answer_my_fork(self):
        mine, _ = await self.controller("mine", ["tom"])
        theirs, _ = await self.controller("theirs", ["ari"])
        fork = self.ask_hunger_fork("tom")
        await mine.expect("fork")
        r = await theirs.request({"type": "choose", "fork_id": fork.id, "choice": 0}, "ack")
        self.assertFalse(r["accepted"])
        self.assertEqual(fork.status, "asked")

    async def test_queries(self):
        c, _ = await self.controller("bot", ["tom"])
        r = await c.request({"type": "query", "agent_id": "tom", "what": "possessions"}, "answer")
        self.assertEqual(r["data"]["home"]["place"], "home_levi")
        self.assertIn("money", r["data"])
        r = await c.request({"type": "query", "agent_id": "tom", "what": "attributes"}, "answer")
        self.assertEqual(r["data"]["age"], 29)
        self.assertIn("needs", r["data"])
        r = await c.request({"type": "query", "agent_id": "tom", "what": "world"}, "answer")
        self.assertIn("time", r["data"])
        self.assertIn("cafe", r["data"]["places"])
        for what in ("relationships", "memory", "inbox", "people"):
            await c.request({"type": "query", "agent_id": "tom", "what": what}, "answer")
        await c.request({"type": "query", "agent_id": "tom", "what": "secrets"}, "error")

    async def test_query_not_owned_is_error(self):
        c, _ = await self.controller("bot", ["tom"])
        r = await c.request({"type": "query", "agent_id": "dana", "what": "possessions"}, "error")
        self.assertIn("not your character", r["error"])
        await c.request({"type": "query", "agent_id": "nobody", "what": "world"}, "error")
        await c.request({"type": "send_message", "agent_id": "dana", "to": "tom", "text": "hi"}, "error")

    async def test_send_message_between_owned_characters(self):
        c, _ = await self.controller("bot", ["tom", "ari"])
        r = await c.request({"type": "send_message", "agent_id": "tom", "to": "ari", "text": "Coffee later?"}, "sent")
        self.assertTrue(r["ok"])
        push = await c.expect("message")
        self.assertEqual(push["from"], "tom")
        self.assertEqual(push["to"], "ari")
        self.assertEqual(push["agent_id"], "ari")
        self.assertEqual(push["text"], "Coffee later?")
        self.assertEqual(self.sim.agents["ari"].inbox[-1]["text"], "Coffee later?")

    async def test_message_to_other_controller(self):
        a, _ = await self.controller("a", ["tom"])
        b, _ = await self.controller("b", ["ari"])
        await a.request({"type": "send_message", "agent_id": "tom", "to": "ari", "text": "yo"}, "sent")
        push = await b.expect("message")
        self.assertEqual(push["text"], "yo")
        await asyncio.sleep(0.15)
        self.assertFalse([m for m in a.inbox if m.get("type") == "message"])

    async def test_disconnect_releases_characters(self):
        c, _ = await self.controller("bot", ["tom", "ari"])
        self.assertEqual(self.sim.agents["tom"].controller, "bot")
        await c.close()
        self.clients.remove(c)
        await wait_until(lambda: self.sim.agents["tom"].controller is None and self.sim.agents["ari"].controller is None)
        await wait_until(lambda: "bot" not in self.server.controllers)
        # Now someone else may claim them.
        _, welcome = await self.controller("next", ["tom"])
        self.assertEqual(welcome["characters"], ["tom"])

    async def test_release(self):
        c, _ = await self.controller("bot", ["tom"])
        await c.request({"type": "release", "agent_id": "tom"}, "released")
        self.assertIsNone(self.sim.agents["tom"].controller)

    async def test_claim_all(self):
        _, welcome = await self.controller("all", "all")
        self.assertEqual(len(welcome["characters"]), 20)
        self.assertEqual(welcome["available"], [])


class TestRobustness(ServerCase):
    async def test_oversized_frame_drops_connection(self):
        # A frame declaring more than MAX_MESSAGE is refused and the socket is dropped.
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.port), TIMEOUT)
        try:
            writer.write(b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
            writer.write(bytes([0x81, 0x80 | 127]) + struct.pack("!Q", ws.MAX_MESSAGE + 1) + os.urandom(4))
            await writer.drain()
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), TIMEOUT)
            rest = await asyncio.wait_for(reader.read(), TIMEOUT)  # reaching EOF is the point
            self.assertLessEqual(len(rest), 4)  # nothing but, at most, a close frame
        finally:
            writer.close()

    async def test_malformed_json_gets_error(self):
        c = await self.client()
        await c.send("{this is not json")
        r = await c.expect("error")
        self.assertIn("JSON", r["error"])
        await c.send("[1, 2, 3]")  # valid JSON but not an object
        r = await c.expect("error")
        self.assertIn("object", r["error"])
        await c.send({"type": "get_agent", "agent_id": "tom"})
        r = await c.expect("error")
        self.assertIn("hello", r["error"])
        await c.send({"type": "hello", "role": "god"})
        await c.expect("welcome")
        await c.send("not json either")
        await c.expect("error")
        await c.request({"type": "get_agent", "agent_id": "tom"}, "agent")
        status, _, _ = await http_get(self.port, "/")
        self.assertEqual(status, 200)

    async def test_bad_role_closes(self):
        c = await self.client()
        await c.send({"type": "hello", "role": "emperor"})
        r = await c.expect("error")
        self.assertIn("role", r["error"])
        await wait_until(lambda: c.closed)
        _, welcome = await self.god()
        self.assertEqual(welcome["role"], "god")

    async def test_large_message_extended_length(self):
        god, _ = await self.god()
        pad = "x" * 100_000  # > 64KB: needs the 8-byte extended payload length
        r = await god.request({"type": "get_agent", "agent_id": "tom", "pad": pad}, "agent")
        self.assertEqual(r["agent"]["id"], "tom")
        # A long prompt round-trips through set_profile (truncated by the sim to 1000 chars).
        r = await god.request({"type": "set_profile", "agent_id": "tom", "prompt": "y" * 70_000}, "agent")
        self.assertEqual(len(r["agent"]["profile"]["prompt"]), 1000)

    async def test_ping_gets_pong(self):
        # A controller at speed 0 gets no unsolicited frames, so the next frame is the pong.
        reader_ws = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{self.port}/ws"), TIMEOUT)
        try:
            await reader_ws.send(json.dumps({"type": "hello", "role": "controller", "name": "p", "characters": []}))
            json.loads(await asyncio.wait_for(reader_ws.recv(), TIMEOUT))
            await reader_ws._raw_control(ws.OP_PING, b"are-you-there")
            fin, opcode, data = await asyncio.wait_for(reader_ws._read_frame(), TIMEOUT)
            self.assertTrue(fin)
            self.assertEqual(opcode, ws.OP_PONG)
            self.assertEqual(data, b"are-you-there")
            # The connection still works after the ping.
            await reader_ws.send(json.dumps({"type": "query", "agent_id": "tom", "what": "world"}))
            r = json.loads(await asyncio.wait_for(reader_ws.recv(), TIMEOUT))
            self.assertEqual(r["type"], "error")
        finally:
            await reader_ws.close()


class TestWsFraming(unittest.IsolatedAsyncioTestCase):
    """ws.py on its own: a tiny echo server built from server_handshake."""

    async def asyncSetUp(self):
        self.server_sockets: list[ws.WebSocket] = []

        async def handle(reader, writer):
            await reader.readline()
            headers = {}
            while True:
                line = (await reader.readline()).decode().strip()
                if not line:
                    break
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()
            sock = await ws.server_handshake(reader, writer, headers)
            self.server_sockets.append(sock)
            try:
                while True:
                    await sock.send(await sock.recv())
            except ws.ConnectionClosed:
                pass

        self.srv = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = self.srv.sockets[0].getsockname()[1]
        self.client = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{port}/"), TIMEOUT)

    async def asyncTearDown(self):
        await self.client.close()
        for s in self.server_sockets:
            await s.close()
        self.srv.close()
        await asyncio.wait_for(self.srv.wait_closed(), TIMEOUT)

    async def echo(self, text: str) -> str:
        await self.client.send(text)
        return await asyncio.wait_for(self.client.recv(), TIMEOUT)

    def test_accept_key_matches_rfc_example(self):
        self.assertEqual(ws.accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    async def test_round_trip_every_length_class(self):
        for n in (0, 1, 125, 126, 127, 65535, 65536, 70_000, 300_000):
            text = ("ab€" * (n // 3 + 1))[:n]
            self.assertEqual(await self.echo(text), text, f"length {n}")

    async def test_unicode_round_trip(self):
        text = "שלום, עולם 🌍 “quotes”"
        self.assertEqual(await self.echo(text), text)

    async def test_client_frames_are_masked_and_server_frames_are_not(self):
        self.assertTrue(self.client.mask)
        await self.echo("warm up")
        self.assertFalse(self.server_sockets[0].mask)

    async def test_wire_format_of_extended_length(self):
        sent = []

        class FakeWriter:
            def write(self, data):
                sent.append(data)

            async def drain(self):
                pass

        server_side = ws.WebSocket(None, FakeWriter(), mask=False)
        await server_side.send("z" * 70_000)
        frame = sent[0]
        self.assertEqual(frame[0], 0x81)
        self.assertEqual(frame[1], 127)
        self.assertEqual(struct.unpack("!Q", frame[2:10])[0], 70_000)
        sent.clear()
        await server_side.send("z" * 300)
        self.assertEqual(sent[0][1], 126)
        self.assertEqual(struct.unpack("!H", sent[0][2:4])[0], 300)

    async def test_fragmented_message_is_reassembled(self):
        def masked_frame(fin: bool, opcode: int, payload: bytes) -> bytes:
            key = os.urandom(4)
            head = bytes([(0x80 if fin else 0) | opcode, 0x80 | len(payload)])
            return head + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))

        w = self.client.writer
        w.write(masked_frame(False, ws.OP_TEXT, b"hel"))
        w.write(masked_frame(False, ws.OP_CONT, b"lo, "))
        w.write(masked_frame(True, ws.OP_PING, b"mid"))  # control frames may interleave
        w.write(masked_frame(True, ws.OP_CONT, b"world"))
        await w.drain()
        # The pong arrives first, then the echoed whole message; recv() skips the pong.
        self.assertEqual(await asyncio.wait_for(self.client.recv(), TIMEOUT), "hello, world")

    async def test_close_raises_connection_closed(self):
        await self.echo("hi")
        await self.server_sockets[0].close()
        with self.assertRaises(ws.ConnectionClosed):
            await asyncio.wait_for(self.client.recv(), TIMEOUT)

    async def test_oversized_frame_is_refused(self):
        # Only the header is fed: the reader must refuse on the declared length alone.
        reader = asyncio.StreamReader()
        reader.feed_data(bytes([0x81, 0x80 | 127]) + struct.pack("!Q", ws.MAX_MESSAGE + 1) + os.urandom(4))
        sock = ws.WebSocket(reader, None, mask=False)
        with self.assertRaises(ws.ConnectionClosed):
            await asyncio.wait_for(sock.recv(), TIMEOUT)

    async def test_truncated_stream_raises_connection_closed(self):
        reader = asyncio.StreamReader()
        reader.feed_data(bytes([0x81, 10]) + b"abc")
        reader.feed_eof()
        sock = ws.WebSocket(reader, None, mask=False)
        with self.assertRaises(ws.ConnectionClosed):
            await asyncio.wait_for(sock.recv(), TIMEOUT)
        self.assertTrue(sock.closed)

    async def test_connect_rejects_non_ws_url(self):
        with self.assertRaises(ValueError):
            await ws.connect("http://127.0.0.1:1/")


if __name__ == "__main__":
    unittest.main()
