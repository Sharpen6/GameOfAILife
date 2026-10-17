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
        with mock.patch.object(server_module, "SEND_QUEUE", 40):
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
            # The view that fell too far behind is dropped.
            await wait_until(lambda: stalled.closed and stalled not in self.server.observers, 10)

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
