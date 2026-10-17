"""Regression tests for review findings in the server and the WebSocket layer.

Every network wait goes through asyncio.wait_for, so a broken server fails a
test instead of hanging the run.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import socket
import struct
import time
import unittest
from unittest import mock

from gameofailife import server as server_module, ws
from gameofailife.server import GameServer
from gameofailife.sim import Simulation

TIMEOUT = 3.0
UPGRADE = (b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")


def nested(depth: int) -> str:
    return "[" * depth + "]" * depth


def masked_frame(fin: bool, opcode: int, payload: bytes) -> bytes:
    """A client frame, built by hand so it may break the rules on purpose."""
    head = bytearray([(0x80 if fin else 0) | opcode])
    if len(payload) < 126:
        head.append(0x80 | len(payload))
    else:
        head += bytes([0x80 | 126]) + struct.pack("!H", len(payload))
    key = os.urandom(4)
    return bytes(head) + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


class FakeWriter:
    def __init__(self, drain_error: Exception | None = None):
        self.sent: list[bytes] = []
        self.drain_error = drain_error

    def write(self, data: bytes) -> None:
        self.sent.append(data)

    async def drain(self) -> None:
        if self.drain_error:
            raise self.drain_error


class Client:
    """Reads every message in the background so a test can wait for one by shape."""

    def __init__(self, sock: ws.WebSocket):
        self.ws = sock
        self.inbox: list[dict] = []
        self.closed = False
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

    async def send(self, msg) -> None:
        await self.ws.send(msg if isinstance(msg, str) else json.dumps(msg))

    async def expect(self, pred, timeout: float = TIMEOUT) -> dict:
        """Remove and return the first message matching pred (a type name or a predicate)."""
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

    async def reply_to(self, text: str, rid) -> dict:
        """Send a raw text message that carries req_id rid and wait for its reply."""
        await self.send(text)
        return await self.expect(lambda m: m.get("req_id") == rid)

    async def close(self) -> None:
        await self.ws.close()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


async def wait_until(cond, timeout: float = TIMEOUT) -> None:
    async def poll():
        while not cond():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(poll(), timeout)


def take_frames(buf: bytearray) -> list[dict]:
    """Remove the whole server frames at the start of buf; returns the messages of the text ones."""
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
            out.append(json.loads(buf[at:at + n]))
        del buf[:at + n]
    return out


async def read_slowly(reader: asyncio.StreamReader, rate: int, seconds: float,
                      got: list | None = None, until=lambda: False) -> bool:
    """Read about rate bytes a second for that long, like a client on a slow link.

    If got is given, the messages read are added to it, and reading stops as soon as until() is true.
    Returns False as soon as the server closes the connection.
    """
    loop = asyncio.get_running_loop()
    end = loop.time() + seconds
    buf = bytearray()
    while loop.time() < end and not until():
        await asyncio.sleep(0.1)
        try:
            data = await asyncio.wait_for(reader.read(rate // 10), 0.1)
        except asyncio.TimeoutError:
            continue
        except ConnectionError:
            return False
        if not data:
            return False
        if got is not None:
            buf += data
            got += take_frames(buf)
    return True


class ServerCase(unittest.IsolatedAsyncioTestCase):
    speed = 0

    async def asyncSetUp(self):
        self.sim = Simulation(seed=1)
        self.server = GameServer(self.sim, speed=self.speed)
        self.port = await self.server.start("127.0.0.1", 0)
        self.clients: list[Client] = []
        self.raw: list[asyncio.StreamWriter] = []

    async def asyncTearDown(self):
        for w in self.raw:
            w.transport.abort()
        for c in self.clients:
            await c.close()
        await asyncio.wait_for(self.server.stop(), TIMEOUT)

    async def client(self) -> Client:
        c = Client(await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{self.port}/ws"), TIMEOUT))
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

    async def raw_ws(self, first: bytes = b"", rcvbuf: int | None = None):
        """A hand-driven WebSocket connection: (reader, writer) just past the handshake."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if rcvbuf:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        sock.setblocking(False)
        await asyncio.wait_for(asyncio.get_running_loop().sock_connect(sock, ("127.0.0.1", self.port)), TIMEOUT)
        reader, writer = await asyncio.open_connection(sock=sock)
        self.raw.append(writer)
        writer.write(UPGRADE + first)
        await writer.drain()
        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), TIMEOUT)
        return reader, writer

    async def stalled_god(self) -> ws.WebSocket:
        """A God view that says hello and never reads again; returns the server's side of it.

        Both ends get small socket buffers so they fill in about a second instead of a minute.
        """
        before = self.server.god
        _, writer = await self.raw_ws(masked_frame(True, ws.OP_TEXT, b'{"type": "hello", "role": "god"}'), 4096)
        writer.transport.pause_reading()
        await wait_until(lambda: self.server.god not in (None, before))
        stalled = self.server.god
        stalled.writer.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        # Wait until the frames it does not read fill the server's write buffer past the point
        # where writer.drain() waits.
        transport = stalled.writer.transport
        await wait_until(lambda: transport.get_write_buffer_size() > transport.get_write_buffer_limits()[1], 10)
        return stalled


class TestSlowClients(ServerCase):
    speed = 16

    def frames(self, c: Client) -> int:
        return sum(m.get("type") == "state" for m in c.inbox)

    async def test_stalled_viewer_does_not_freeze_the_city(self):
        # Finding 11: one view that stops reading froze ticks, frames, forks and new hellos for everyone.
        watcher, _ = await self.god()
        stalled = await self.stalled_god()
        await watcher.expect("demoted")
        tick, frames = self.sim.clock.tick, self.frames(watcher)
        await asyncio.sleep(1.0)
        self.assertGreater(self.sim.clock.tick, tick + 10, "the game clock must keep running")
        self.assertGreater(self.frames(watcher), frames + 5, "other views must keep getting state frames")
        # A new God is welcomed although the old one cannot take its 'demoted' message.
        _, welcome = await self.god()
        self.assertEqual(welcome["role"], "god")
        self.assertFalse(stalled.closed, "under STALL_SECONDS behind, the stalled view is still kept")
        # The view that falls too far behind is dropped.
        with mock.patch.object(server_module, "STALL_SECONDS", 0.5):
            await wait_until(lambda: stalled.closed and stalled not in self.server.observers, 10)

    async def test_message_burst_does_not_drop_a_reading_controller(self):
        # Finding 11, follow-up: a cap on queued pushes let another controller knock this one
        # off with 101 pipelined send_message requests (one frame's worth) and take its characters.
        victim, _ = await self.controller("victim", ["tom", "ari"])
        other, _ = await self.controller("other", ["dana"])
        n = 300
        with mock.patch.object(server_module, "PACE_BURST", n):  # this is about queued pushes, not pacing
            for i in range(n):
                await other.send({"type": "send_message", "agent_id": "dana", "to": "tom", "text": f"hi {i}"})
            await wait_until(lambda: victim.closed or sum(m.get("type") == "message" for m in victim.inbox) == n)
        self.assertFalse(victim.closed, "a controller that keeps reading must not be dropped")
        self.assertEqual([self.sim.agents[a].controller for a in ("tom", "ari")], ["victim", "victim"])
        r = await other.reply_to('{"type": "claim", "agent_id": "tom", "req_id": "c"}', "c")
        self.assertFalse(r["ok"])

    async def test_message_burst_to_own_characters_does_not_drop_the_sender(self):
        c, _ = await self.controller("chatty", ["tom", "ari"])
        n = 150
        with mock.patch.object(server_module, "PACE_BURST", n):
            for i in range(n):
                await c.send({"type": "send_message", "agent_id": "tom", "to": "ari", "text": f"hi {i}"})
            await wait_until(lambda: c.closed or sum(m.get("type") == "message" for m in c.inbox) == n)
        self.assertFalse(c.closed, "a controller that keeps reading must not be dropped")
        self.assertEqual(self.sim.agents["ari"].controller, "chatty")

    async def test_connection_timeout_does_not_kill_the_tick_loop(self):
        # Finding 12: TCP giving up on a vanished peer (ETIMEDOUT) is an OSError but not a
        # ConnectionError; it escaped the frame loop and the city never moved again.
        stalled = await self.stalled_god()
        # This is what asyncio does when the kernel reports ETIMEDOUT for the socket.
        stalled.writer.transport._fatal_error(TimeoutError(errno.ETIMEDOUT, "Connection timed out"))
        await wait_until(lambda: self.server.god is None)
        tick = self.sim.clock.tick
        await asyncio.sleep(0.3)
        self.assertFalse(self.server._loop_task.done(), "the tick loop must survive a dead connection")
        self.assertGreater(self.sim.clock.tick, tick)
        god, _ = await self.god()
        await god.expect("state")


class TestFloods(ServerCase):
    """Finding 11, round 3: one controller pipelining send_message got any client on a link
    slower than the server makes pushes dropped for lagging (and could then claim its characters)."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.floods: list[tuple[asyncio.Task, Client]] = []

    async def asyncTearDown(self):
        for task, c in self.floods:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, ws.ConnectionClosed):
                pass
            c.ws.abort()  # the server is not reading it, so no close handshake
        await super().asyncTearDown()

    async def slow_client(self, hello: dict) -> tuple[asyncio.StreamReader, ws.WebSocket]:
        """A raw connection that says hello; returns its reader and the server's side of it.

        Both ends get small socket buffers, as on a slow link, where the kernel cannot soak up
        seconds of frames the way it does on localhost.
        """
        before = set(self.server._outboxes)
        reader, _ = await self.raw_ws(masked_frame(True, ws.OP_TEXT, json.dumps(hello).encode()), 16384)
        await wait_until(lambda: set(self.server._outboxes) - before)
        (theirs,) = set(self.server._outboxes) - before
        theirs.writer.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16384)
        return reader, theirs

    def flood(self, c: Client, agent_id: str, to: str) -> None:
        """Pipeline 500-character texts from c for the rest of the test."""
        msg = json.dumps({"type": "send_message", "agent_id": agent_id, "to": to, "text": "é" * 500})

        async def pipeline():
            while True:
                await c.send(msg)
                await asyncio.sleep(0)  # as fast as it can, but let the rest of this loop run too

        self.floods.append((asyncio.create_task(pipeline()), c))

    async def test_message_flood_does_not_drop_a_slow_controller(self):
        # The victim reads 1 MB/s; once dropped, 'other' could claim its characters.
        reader, victim = await self.slow_client({"type": "hello", "role": "controller", "name": "victim",
                                                 "characters": ["tom", "ari"]})
        await wait_until(lambda: self.sim.agents["tom"].controller == "victim")
        other, _ = await self.controller("other", ["dana"])
        start = asyncio.get_running_loop().time()
        self.flood(other, "dana", "tom")
        with mock.patch.object(server_module, "STALL_SECONDS", 1.0):  # drop sooner, so the test is quick
            kept = await read_slowly(reader, 1_000_000, 2.5)
        self.assertTrue(kept and not victim.closed, "a controller that keeps reading must not be dropped")
        self.assertEqual([self.sim.agents[a].controller for a in ("tom", "ari")], ["victim", "victim"])
        handled = sum(m.get("type") == "sent" for m in other.inbox)
        elapsed = asyncio.get_running_loop().time() - start
        self.assertLessEqual(handled, server_module.PACE_BURST + server_module.PACE_RATE * elapsed + 2,
                             "the sender is held back instead")

    async def test_message_flood_does_not_drop_a_slow_god_view(self):
        # Every text is also an event in every view's state frames. This view reads 250 KB/s.
        reader, god = await self.slow_client({"type": "hello", "role": "god"})
        await wait_until(lambda: self.server.god is god)
        other, _ = await self.controller("other", ["dana"])
        self.flood(other, "dana", "tom")  # tom has no controller, so the texts reach only the views
        with mock.patch.object(server_module, "STALL_SECONDS", 1.0):
            kept = await read_slowly(reader, 250_000, 2.5)
        self.assertTrue(kept and not god.closed, "a God view that keeps reading must not be dropped")
        self.assertIs(self.server.god, god)

    async def test_floods_from_several_connections_do_not_drop_a_slow_controller(self):
        # Round 4: pacing is per connection, so five flooding controllers still got a victim reading
        # 500 KB/s dropped for lagging, and anyone could then claim its characters.
        reader, victim = await self.slow_client({"type": "hello", "role": "controller", "name": "victim",
                                                 "characters": ["tom", "ari"]})
        await wait_until(lambda: self.sim.agents["tom"].controller == "victim")
        thief, _ = await self.controller("thief", [])
        for i, aid in enumerate([a.id for a in self.sim.living() if not a.controller][:5]):
            self.flood((await self.controller(f"flooder{i}", [aid]))[0], aid, "tom")
        with mock.patch.object(server_module, "STALL_SECONDS", 1.0):
            kept = await read_slowly(reader, 500_000, 2.5)
            self.assertTrue(kept and not victim.closed, "a controller that keeps reading must not be dropped")
            self.assertEqual([self.sim.agents[a].controller for a in ("tom", "ari")], ["victim", "victim"])
            r = await thief.reply_to('{"type": "claim", "agent_id": "tom", "req_id": "c"}', "c")
            self.assertFalse(r["ok"])
            # Skipped texts are still in tom's inbox. A controller that stops reading is still dropped.
            self.assertEqual(self.sim.agents["tom"].inbox[-1]["text"], "é" * 500)
            await wait_until(lambda: victim.closed, 5)
        await wait_until(lambda: self.sim.agents["tom"].controller is None)

    async def test_fork_does_not_wait_behind_texts(self):
        # Round 5: a fork queued behind a flood of texts waited until they were old enough to skip,
        # about STALL_SECONDS / 2 of the ANSWER_SECONDS (5) the controller has to answer it.
        reader, victim = await self.slow_client({"type": "hello", "role": "controller", "name": "victim",
                                                 "characters": ["tom", "ari"]})
        await wait_until(lambda: self.sim.agents["tom"].controller == "victim")
        for i, aid in enumerate([a.id for a in self.sim.living() if not a.controller][:5]):
            self.flood((await self.controller(f"flooder{i}", [aid]))[0], aid, "tom")
        loop = asyncio.get_running_loop()
        asked: list[float] = []

        def ask() -> None:  # what Simulation.director does for a character with a controller
            self.sim.outbox.append(("victim", {"type": "fork", "fork_id": "f1", "agent_id": "tom"}))
            asked.append(loop.time())

        loop.call_later(1.0, ask)  # once the victim is well behind
        got: list[dict] = []
        kept = await read_slowly(reader, 500_000, 6, got, until=lambda: any(m["type"] == "fork" for m in got))
        self.assertTrue(kept and not victim.closed, "a controller that keeps reading must not be dropped")
        self.assertTrue(any(m["type"] == "fork" for m in got), "the fork must arrive")
        # The texts already in the socket buffers on both ends take about half a second to read.
        self.assertLess(loop.time() - asked[0], 1.5, "a fork must not wait behind texts")
        before = [m["type"] for m in got[:[m["type"] for m in got].index("fork")]]
        self.assertIn("messages_skipped", before, "it skips texts to get ahead, and says so")

    async def test_skipped_texts_are_reported(self):
        # Round 5: texts skipped for a lagging controller vanished without a word, and `query inbox`
        # shows only the last 20, so a controller could not tell what it had missed.
        reader, victim = await self.slow_client({"type": "hello", "role": "controller", "name": "victim",
                                                 "characters": ["tom", "ari"]})
        await wait_until(lambda: self.sim.agents["tom"].controller == "victim")
        other, _ = await self.controller("other", ["dana"])
        n = 300
        text = json.dumps({"type": "send_message", "agent_id": "dana", "to": "tom", "text": "é" * 500})
        got: list[dict] = []
        skips = lambda: [m for m in got if m["type"] == "messages_skipped"]  # noqa: E731
        accounted = lambda: sum(m["type"] == "message" for m in got) + sum(m["count"] for m in skips())  # noqa: E731
        with mock.patch.object(server_module, "PACE_BURST", n), mock.patch.object(server_module, "STALL_SECONDS", 1.0):
            for _ in range(n):
                await other.send(text)
            kept = await read_slowly(reader, 200_000, 5, got, until=lambda: accounted() >= n)
        self.assertTrue(kept and not victim.closed, "a controller that keeps reading must not be dropped")
        self.assertTrue(skips(), "a slow reader misses some of these texts")
        self.assertEqual({m["agent_id"] for m in skips()}, {"tom"}, "it is told whose inbox to query")
        self.assertEqual(accounted(), n, "every text is pushed or counted as skipped")


class TestWsLayer(unittest.IsolatedAsyncioTestCase):
    async def test_send_os_errors_are_connection_closed(self):
        # Finding 12: TimeoutError and EHOSTUNREACH from drain() mean the connection is gone.
        for exc in (TimeoutError(errno.ETIMEDOUT, "Connection timed out"),
                    OSError(errno.EHOSTUNREACH, "No route to host"), BrokenPipeError()):
            sock = ws.WebSocket(None, FakeWriter(exc), mask=False)
            with self.assertRaises(ws.ConnectionClosed, msg=repr(exc)):
                await sock.send("hi")
            self.assertTrue(sock.closed)

    async def test_recv_os_errors_are_connection_closed(self):
        for exc in (TimeoutError(errno.ETIMEDOUT, "Connection timed out"),
                    OSError(errno.EHOSTUNREACH, "No route to host")):
            reader = asyncio.StreamReader()
            reader.set_exception(exc)
            sock = ws.WebSocket(reader, None, mask=False)
            with self.assertRaises(ws.ConnectionClosed, msg=repr(exc)):
                await asyncio.wait_for(sock.recv(), TIMEOUT)
            self.assertTrue(sock.closed)

    async def test_many_fragments_reassemble_in_linear_time(self):
        # Finding 13: 30,000 one-byte fragments took about 11 s of blocked event loop.
        n = 30_000
        reader = asyncio.StreamReader()
        reader.feed_data(bytes([ws.OP_TEXT, 1]) + b"a" + (bytes([ws.OP_CONT, 1]) + b"a") * (n - 2)
                         + bytes([0x80 | ws.OP_CONT, 1]) + b"a")
        sock = ws.WebSocket(reader, None, mask=False)
        asyncio.get_running_loop().slow_callback_duration = 60  # this test blocks on purpose; no warning
        start = time.perf_counter()
        text = await sock.recv()
        self.assertEqual(text, "a" * n)
        self.assertLess(time.perf_counter() - start, 2.0)

    async def test_control_frame_length_is_always_encoded_correctly(self):
        # Finding 18: a 200-byte payload was written straight into the 7-bit length field.
        writer = FakeWriter()
        sock = ws.WebSocket(None, writer, mask=False)
        await sock._raw_control(ws.OP_PONG, b"A" * 200)
        frame = writer.sent[0]
        self.assertEqual(frame[0], 0x80 | ws.OP_PONG)
        self.assertLessEqual(frame[1], 125, "no mask bit, and a length that fits a control frame")
        self.assertEqual(len(frame), 2 + frame[1])


class TestBadInput(ServerCase):
    async def assert_still_playing(self, c: Client) -> None:
        self.assertEqual(self.sim.agents["tom"].controller, "bot")
        await c.send({"type": "query", "agent_id": "tom", "what": "world", "req_id": "ok"})
        self.assertEqual((await c.expect(lambda m: m.get("req_id") == "ok"))["type"], "answer")

    async def test_invalid_utf8_gets_error_and_keeps_characters(self):
        # Finding 16: bad UTF-8 dropped the connection and released every character it held.
        c, _ = await self.controller("bot", ["tom"])
        for opcode, payload in ((ws.OP_TEXT, b"\xff"), (ws.OP_BINARY, b"\xff\xfe"),
                                (ws.OP_TEXT, b'{"type": "query", "x": "\xc3"}')):
            await c.ws._write_frame(opcode, payload)
            r = await c.expect("error")
            self.assertEqual(r["error"], "messages must be JSON", payload)
            await self.assert_still_playing(c)

    async def test_unreadable_json_gets_error_and_keeps_characters(self):
        # Finding 16: a 5000-digit integer (ValueError) and deep nesting (RecursionError).
        c, _ = await self.controller("bot", ["tom"])
        for text in ('{"type": "query", "n": ' + "1" * 5000 + "}", "[" * 100_000):
            await c.send(text)
            r = await c.expect("error")
            self.assertEqual(r["error"], "messages must be JSON")
            await self.assert_still_playing(c)

    async def test_non_object_json_gets_error(self):
        c, _ = await self.controller("bot", ["tom"])
        for text in ("[1, 2, 3]", "42", '"hello"', "null"):
            await c.send(text)
            r = await c.expect("error")
            self.assertIn("object", r["error"], text)
            await self.assert_still_playing(c)

    async def test_overflowing_numbers_get_bad_message(self):
        # Finding 17: OverflowError escaped the handler and dropped God's connection.
        god, _ = await self.god()
        probes = [
            '{"type": "set_luck", "agent_id": "tom", "luck": ' + "1" * 401,
            '{"type": "set_speed", "speed": Infinity',
            '{"type": "set_speed", "speed": -Infinity',
            '{"type": "set_speed", "speed": 1e400',
            '{"type": "set_profile", "agent_id": "tom", "traits": {"thrift": 1' + "0" * 400 + "}",
        ]
        for i, probe in enumerate(probes):
            r = await god.reply_to(probe + f', "req_id": "o{i}"}}', f"o{i}")
            self.assertEqual(r["type"], "error", probe)
            self.assertTrue(r["error"].startswith("bad message"), r)
        self.assertEqual(self.server.speed, 0)
        r = await god.reply_to('{"type": "get_agent", "agent_id": "tom", "req_id": "after"}', "after")
        self.assertEqual(r["type"], "agent")

    async def test_set_luck_requires_a_number(self):
        # Finding 51: true became luck 1 and "80" became 80.
        god, _ = await self.god()
        before = self.sim.agents["tom"].luck
        for i, value in enumerate(("true", "false", '"80"', '" 42 "', '"nan"', "NaN", "Infinity", "null", "[1]")):
            r = await god.reply_to(f'{{"type": "set_luck", "agent_id": "tom", "luck": {value}, "req_id": {i}}}', i)
            self.assertEqual(r["type"], "error", value)
            self.assertTrue(r["error"].startswith("bad message"), r)
            self.assertEqual(self.sim.agents["tom"].luck, before, value)
        for value, luck in (("80", 80), ("62.5", 62.5)):
            r = await god.reply_to(f'{{"type": "set_luck", "agent_id": "tom", "luck": {value}, "req_id": "n"}}', "n")
            self.assertEqual((r["type"], r["luck"]), ("luck_set", luck))
        r = await god.reply_to('{"type": "set_luck", "agent_id": "tom", "req_id": "d"}', "d")
        self.assertEqual(r["luck"], 50, "a missing luck still means 50")

    async def test_long_ping_fails_the_connection_with_1002(self):
        # Finding 18: a 126-255 byte ping got a corrupt pong; over 255 bytes, no close frame at all.
        for n in (126, 200, 300):
            reader, writer = await self.raw_ws()
            writer.write(masked_frame(True, ws.OP_PING, b"A" * n))
            await writer.drain()
            data = await asyncio.wait_for(reader.read(), TIMEOUT)  # the server closes after its close frame
            self.assertEqual(data[:2], bytes([0x80 | ws.OP_CLOSE, 2]), f"ping of {n} bytes")
            self.assertEqual(struct.unpack("!H", data[2:4])[0], 1002, f"ping of {n} bytes")
            self.assertEqual(len(data), 4)

    async def test_fragmented_ping_fails_the_connection_with_1002(self):
        reader, writer = await self.raw_ws()
        writer.write(masked_frame(False, ws.OP_PING, b"x"))
        await writer.drain()
        data = await asyncio.wait_for(reader.read(), TIMEOUT)
        self.assertEqual(struct.unpack("!H", data[2:4])[0], 1002)


class TestReqId(ServerCase):
    async def test_req_id_on_hello_replies_and_pre_hello_errors(self):
        # Finding 46: hello replies and errors before hello never carried the req_id.
        c = await self.client()
        await c.send({"type": "ping", "req_id": "p1"})
        r = await c.expect(lambda m: m.get("req_id") == "p1")
        self.assertEqual(r["error"], "say hello first")
        await c.send({"type": "hello", "role": "controller", "characters": 5, "req_id": "h0"})
        r = await c.expect(lambda m: m.get("req_id") == "h0")
        self.assertTrue(r["error"].startswith("bad hello"), r)
        await c.send({"type": "hello", "role": "controller", "name": "bot", "characters": ["tom"], "req_id": "h1"})
        r = await c.expect(lambda m: m.get("req_id") == "h1")
        self.assertEqual((r["type"], r["characters"]), ("welcome", ["tom"]))

        g = await self.client()
        await g.send({"type": "hello", "role": "god", "req_id": {"any": ["json", 1]}})
        r = await g.expect(lambda m: m.get("req_id") == {"any": ["json", 1]})
        self.assertEqual((r["type"], r["role"]), ("welcome", "god"))

        bad = await self.client()
        await bad.send({"type": "hello", "role": "emperor", "req_id": 9})
        r = await bad.expect(lambda m: m.get("req_id") == 9)
        self.assertEqual(r["error"], "role must be god or controller")
        await wait_until(lambda: bad.closed)

    def depths_near_the_limit(self) -> range:
        """req_id depths just under what json.loads takes here, where (on Python 3.11) writing the
        reply that echoes the req_id can still raise RecursionError."""
        lo, hi = 1, 100_000
        while lo < hi:
            mid = (lo + hi + 1) // 2
            try:
                json.loads('{"req_id": ' + nested(mid) + "}")
                lo = mid
            except RecursionError:
                hi = mid - 1
        return range(lo - 25, lo + 6)

    async def test_deep_req_id_never_drops_a_controller(self):
        # Finding 16: on 3.11 a req_id about 980 deep was read, but writing it back raised
        # RecursionError, so the connection dropped with no reply and tom was released.
        c, _ = await self.controller("bot", ["tom"])
        for depth in self.depths_near_the_limit():
            await c.send('{"type": "nothing", "req_id": ' + nested(depth) + "}")
            r = await c.expect("error")
            self.assertTrue(r["error"].startswith(("unknown message type", "messages must be JSON", "bad message")), r)
            r = await c.reply_to('{"type": "query", "agent_id": "tom", "what": "attributes", "req_id": "ok"}', "ok")
            self.assertEqual(r["type"], "answer", depth)
        self.assertEqual(self.sim.agents["tom"].controller, "bot")

    async def test_deep_req_id_on_hello_leaves_no_ghost(self):
        # Finding 46: on 3.11 the welcome echoing such a req_id raised RecursionError after the hello
        # had claimed tom. The session died without releasing it, so tom was held until a restart.
        for depth in self.depths_near_the_limit():
            c = await self.client()
            await c.send('{"type": "hello", "role": "controller", "name": "deep", "characters": ["tom"], "req_id": '
                         + nested(depth) + "}")
            await c.expect(lambda m: m.get("type") in ("welcome", "error"))
            await c.close()
            await wait_until(lambda: self.sim.agents["tom"].controller is None and not self.server.controllers)
        _, welcome = await self.controller("next", ["tom"])
        self.assertEqual(welcome["characters"], ["tom"])

    async def test_failed_controller_hello_releases_what_it_claimed(self):
        # Finding 46: any error in a hello after its claims left them held by a controller no session knew.
        c = await self.client()
        with mock.patch.object(self.sim, "living", side_effect=TypeError("no town")):  # breaks the welcome
            r = await c.reply_to('{"type": "hello", "role": "controller", "name": "bot", "characters": ["tom"], '
                                 '"req_id": "h"}', "h")
        self.assertTrue(r["error"].startswith("bad hello"), r)
        self.assertIsNone(self.sim.agents["tom"].controller)
        self.assertNotIn("bot", self.server.controllers)
        r = await c.reply_to('{"type": "hello", "role": "controller", "name": "bot", "characters": ["tom"], '
                             '"req_id": "h2"}', "h2")
        self.assertEqual((r["type"], r["name"], r["characters"]), ("welcome", "bot", ["tom"]))

    async def test_reply_that_cannot_be_written_is_an_error(self):
        # Findings 16 and 46 on any Python: a reply json.dumps cannot write is replaced by an error.
        writer = FakeWriter()
        deep: list = []
        for _ in range(100_000):
            deep = [deep]
        await self.server._reply(ws.WebSocket(None, writer, mask=False), {"req_id": deep}, {"type": "answer"})
        frame = writer.sent[0]
        payload = frame[2:] if frame[1] < 126 else frame[4:]
        self.assertEqual(json.loads(payload)["type"], "error")


class TestShutdown(ServerCase):
    async def test_stop_is_prompt_with_idle_connections(self):
        # Finding 19: Ctrl-C hung while any TCP connection sat in the request readline.
        _, idle = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.port), TIMEOUT)
        _, half = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.port), TIMEOUT)
        self.raw += [idle, half]
        half.write(b"GET / HTTP/1.1\r\n")  # never finished
        await half.drain()
        await asyncio.sleep(0.1)
        await asyncio.wait_for(self.server.stop(), 2.0)

    async def test_stop_is_prompt_with_a_stalled_websocket(self):
        self.server.speed = 16
        await self.stalled_god()
        await asyncio.wait_for(self.server.stop(), 4.0)


class TestSocketsClosed(ServerCase):
    async def test_socket_closed_when_client_vanishes(self):
        # Finding 49: the server never closed the writer when a session ended (socket leak before 3.13).
        c, _ = await self.controller("bot", ["tom"])
        mine = self.server.controllers["bot"]
        c.ws.writer.transport.abort()  # the client's TCP goes away without a close frame
        await wait_until(lambda: self.sim.agents["tom"].controller is None)
        await wait_until(lambda: mine.writer.transport.is_closing())

    async def test_oversized_frame_closes_the_socket(self):
        reader, writer = await self.raw_ws(bytes([0x81, 0x80 | 127]) + struct.pack("!Q", ws.MAX_MESSAGE + 1)
                                           + os.urandom(4))
        rest = await asyncio.wait_for(reader.read(), TIMEOUT)  # reaching EOF is the point
        self.assertLessEqual(len(rest), 4)


if __name__ == "__main__":
    unittest.main()
