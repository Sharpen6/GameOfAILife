"""The engineering review's server and controller fixes, over real sockets where it matters.

* ENG-1: a WebSocket upgrade from another site's page (its Origin is not this server) or through a DNS name pointed
  at this machine (DNS rebinding) gets 403; the God page (same origin) and controllers that send no Origin connect.
* ENG-2: frames are unmasked in one operation, and the server reads at most SERVER_MAX_MESSAGE (64 KiB) from a
  client, while clients still read up to MAX_MESSAGE.
* ENG-4: Claude's page tells a flat's resident at home that they are at home, and writes a debt as -$400.00.
* ENG-5: the request line and headers are read within HEADER_SECONDS and capped at HEADER_LINES / HEADER_BYTES (431);
  a WebSocket session after the upgrade has no time limit.
* ENG-6: a controller hello that repeats an id claims and announces it once.
* ENG-7: a port already in use stops the server with one line and a non-zero exit code, no traceback.

Also: examples/claude_controller.py said "Nobody claimed" after every welcome, even one that claimed characters.

Every network wait goes through asyncio.wait_for, so a broken server fails a test instead of hanging the run.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import random
import socket
import struct
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from gameofailife import server as server_module, ws
from gameofailife.forks import Fork, Option
from gameofailife.server import GameServer, local_host, origin_allowed, serve
from gameofailife.sim import Simulation

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
import claude_controller as cc  # noqa: E402

TIMEOUT = 3.0
REPO = Path(__file__).resolve().parent.parent
KEY = "dGhlIHNhbXBsZSBub25jZQ=="


def masked_frame(fin: bool, opcode: int, payload: bytes) -> bytes:
    """A client frame built by hand, masked byte by byte the way the RFC describes it."""
    head = bytearray([(0x80 if fin else 0) | opcode])
    if len(payload) < 126:
        head.append(0x80 | len(payload))
    elif len(payload) < 1 << 16:
        head += bytes([0x80 | 126]) + struct.pack("!H", len(payload))
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", len(payload))
    key = os.urandom(4)
    return bytes(head) + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def upgrade_request(host: str | None, origin: str | None = None, path: str = "/ws") -> bytes:
    lines = [f"GET {path} HTTP/1.1"]
    if host is not None:
        lines.append(f"Host: {host}")
    if origin is not None:
        lines.append(f"Origin: {origin}")
    lines += ["Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {KEY}", "Sec-WebSocket-Version: 13"]
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


async def read_head(reader: asyncio.StreamReader) -> tuple[int, dict[str, str]]:
    """The status code and headers of an HTTP response."""
    head = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), TIMEOUT)).decode()
    lines = head.strip().split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
    return int(lines[0].split()[1]), headers


async def wait_until(cond, timeout: float = TIMEOUT) -> None:
    async def poll():
        while not cond():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(poll(), timeout)


class ServerCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sim = Simulation(seed=1)
        self.server = GameServer(self.sim, speed=0)
        self.port = await self.server.start("127.0.0.1", 0)
        self.writers: list[asyncio.StreamWriter] = []
        self.sockets: list[ws.WebSocket] = []

    async def asyncTearDown(self):
        for s in self.sockets:
            s.abort()
        for w in self.writers:
            w.close()
        await asyncio.wait_for(self.server.stop(), TIMEOUT)

    async def open(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.port), TIMEOUT)
        self.writers.append(writer)
        return reader, writer

    async def upgrade(self, host: str | None, origin: str | None = None):
        """Send an upgrade with these Host and Origin headers: (status, headers, reader, writer)."""
        reader, writer = await self.open()
        writer.write(upgrade_request(host, origin))
        await writer.drain()
        status, headers = await read_head(reader)
        return status, headers, reader, writer

    async def connect(self) -> ws.WebSocket:
        sock = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{self.port}/ws"), TIMEOUT)
        self.sockets.append(sock)
        return sock

    async def hello(self, sock: ws.WebSocket, **msg) -> dict:
        await sock.send(json.dumps({"type": "hello", **msg}))
        return json.loads(await asyncio.wait_for(sock.recv(), TIMEOUT))


# --- ENG-1: the origin check --------------------------------------------------------------------------------------


class TestOriginRules(unittest.TestCase):
    def test_local_hosts(self):
        for host in ("localhost", "localhost:8000", "LOCALHOST:8000", "127.0.0.1", "127.0.0.1:8000", "[::1]:8000",
                     "192.168.1.20:8000", "10.0.0.7"):
            self.assertTrue(local_host(host), host)
        for host in ("evil.example", "evil.example:8000", "mypc.local:8000", "localhost.evil.example:8000",
                     "127.0.0.1.nip.io:8000", "", "[::1:8000", "x"):
            self.assertFalse(local_host(host), host)

    def test_origin_must_be_this_server_on_a_local_address(self):
        allowed = origin_allowed
        self.assertTrue(allowed({"host": "127.0.0.1:8000"}), "no Origin: not a browser")
        self.assertTrue(allowed({"host": "x"}), "no Origin: not a browser, whatever Host it sends")
        self.assertTrue(allowed({}), "no Origin and no Host")
        self.assertTrue(allowed({"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8000"}))
        self.assertTrue(allowed({"host": "localhost:8000", "origin": "http://localhost:8000"}))
        self.assertTrue(allowed({"host": "Localhost:8000", "origin": "http://localhost:8000"}), "names ignore case")
        self.assertTrue(allowed({"host": "192.168.1.20:8000", "origin": "http://192.168.1.20:8000"}), "a LAN friend")
        self.assertTrue(allowed({"host": "[::1]:8000", "origin": "http://[::1]:8000"}))
        for host, origin in (("127.0.0.1:8000", "http://evil.example"),
                             ("127.0.0.1:8000", "http://localhost:8000"),  # the same machine, but not this origin
                             ("127.0.0.1:8000", "http://127.0.0.1:8001"),  # another local site
                             ("127.0.0.1:8000", "null"),  # a sandboxed frame or a file:// page
                             ("127.0.0.1:8000", ""),
                             ("evil.example:8000", "http://evil.example:8000"),  # DNS rebinding
                             ("mypc.local:8000", "http://mypc.local:8000"),
                             ("[::1:8000", "http://[::1:8000")):
            self.assertFalse(allowed({"host": host, "origin": origin}), (host, origin))
        self.assertFalse(allowed({"origin": "http://127.0.0.1:8000"}), "an Origin with no Host")


class TestOriginCheck(ServerCase):
    async def assert_refused(self, host: str | None, origin: str | None) -> None:
        status, headers, reader, _ = await self.upgrade(host, origin)
        self.assertEqual(status, 403, (host, origin))
        self.assertEqual((headers.get("content-length"), headers.get("connection")), ("0", "close"))
        self.assertEqual(await asyncio.wait_for(reader.read(), TIMEOUT), b"", "closed, with no session")

    async def assert_god(self, host: str | None, origin: str | None) -> None:
        """The upgrade goes through and the connection is a working God view."""
        status, headers, reader, writer = await self.upgrade(host, origin)
        self.assertEqual(status, 101, (host, origin))
        self.assertEqual(headers["sec-websocket-accept"], ws.accept_key(KEY))
        sock = ws.WebSocket(reader, writer, mask=True)
        self.sockets.append(sock)
        welcome = await self.hello(sock, role="god")
        self.assertEqual((welcome["type"], welcome["role"]), ("welcome", "god"))
        self.assertIsNotNone(self.server.god)

    async def test_another_sites_page_gets_403(self):
        p = self.port
        await self.assert_refused(f"127.0.0.1:{p}", "http://evil.example")
        await self.assert_refused(f"127.0.0.1:{p}", f"http://localhost:{p + 1}")
        await self.assert_refused(f"127.0.0.1:{p}", "null")
        self.assertIsNone(self.server.god, "nobody took over")
        self.assertEqual(self.server.controllers, {})

    async def test_the_god_page_on_its_own_origin_gets_101(self):
        p = self.port
        await self.assert_god(f"127.0.0.1:{p}", f"http://127.0.0.1:{p}")
        await self.assert_god(f"localhost:{p}", f"http://localhost:{p}")
        await self.assert_god(f"192.168.1.20:{p}", f"http://192.168.1.20:{p}")  # a friend on --host 0.0.0.0, by IP

    async def test_dns_rebinding_gets_403(self):
        # A page loaded from evil.example, whose DNS then points at 127.0.0.1: Origin and Host agree, on a DNS name.
        p = self.port
        await self.assert_refused(f"evil.example:{p}", f"http://evil.example:{p}")
        await self.assert_refused(f"evil.example:{p}", "http://evil.example")
        await self.assert_refused(f"127.0.0.1.nip.io:{p}", f"http://127.0.0.1.nip.io:{p}")

    async def test_no_origin_gets_101(self):
        # Controllers and tools are not browsers: they send no Origin. Their Host is not checked, on purpose:
        # every browser context sends an Origin on a WebSocket upgrade (so no web page is behind them), and a
        # program could write Host: 127.0.0.1 as easily. ws.connect sends the URL's name, so a friend's
        # controller pointed at ws://mypc.local:8000/ws connects.
        await self.assert_god(f"127.0.0.1:{self.port}", None)
        await self.assert_god("x", None)
        await self.assert_god(f"evil.example:{self.port}", None)
        await self.assert_god(f"mypc.local:{self.port}", None)
        sock = await self.connect()  # gameofailife.ws.connect, as the example controllers use it
        welcome = await self.hello(sock, role="controller", name="bot", characters=["tom"])
        self.assertEqual(welcome["characters"], ["tom"])

    async def test_static_files_are_served_whatever_the_origin(self):
        reader, writer = await self.open()
        request = f"GET / HTTP/1.1\r\nHost: evil.example:{self.port}\r\nOrigin: http://evil.example\r\n\r\n"
        writer.write(request.encode())
        await writer.drain()
        status, _ = await read_head(reader)
        self.assertEqual(status, 200, "the client's files are no secret; only /ws is guarded")


# --- ENG-2: unmasking and the server's inbound limit --------------------------------------------------------------


class TestMasking(unittest.TestCase):
    def test_apply_mask_matches_the_byte_loop(self):
        rng = random.Random(7)
        for n in (0, 1, 2, 3, 4, 5, 7, 8, 125, 126, 127, 65535, 65536, 70_001, 4 * 1024 * 1024 - 1):
            data = rng.randbytes(n)
            key = rng.randbytes(4)
            slow = bytes(b ^ key[i % 4] for i, b in enumerate(data))
            self.assertEqual(ws.apply_mask(data, key), slow, n)
            self.assertEqual(ws.apply_mask(slow, key), data, f"unmasking is masking again ({n})")
        self.assertEqual(ws.apply_mask(b"\x00\x00\x00\x00\x00", b"\x00\x00\x00\x80"), b"\x00\x00\x00\x80\x00",
                         "the top bit of the last byte survives")

    def test_limits(self):
        self.assertEqual(ws.SERVER_MAX_MESSAGE, 64 * 1024)
        self.assertEqual(ws.MAX_MESSAGE, 4 * 1024 * 1024)
        self.assertEqual(ws.WebSocket(None, None, mask=True).max_message, ws.MAX_MESSAGE, "a client's default")

    def test_the_largest_client_messages_fit_with_room_to_spare(self):
        # What a client may need to send at most: every character's id in one hello, the longest text, reason and
        # prompt the server keeps (500, 300 and 1000 characters), in 4-byte characters.
        sim = Simulation(seed=1)
        biggest = [
            {"type": "hello", "role": "controller", "name": "n" * 40, "model": "m" * 60,
             "characters": list(sim.agents), "req_id": "r" * 64},
            {"type": "send_message", "agent_id": "dana", "to": "tom", "text": "🌍" * 500, "req_id": "r" * 64},
            {"type": "choose", "fork_id": "f" * 40, "choice": 3, "reason": "🌍" * 300, "req_id": "r" * 64},
            {"type": "set_profile", "agent_id": "dana", "prompt": "🌍" * 1000,
             "traits": {t: 0.5 for t in ("thrift", "family", "social", "diligence", "health", "adventure")}},
        ]
        for msg in biggest:
            self.assertLess(len(json.dumps(msg, ensure_ascii=False).encode()) * 8, ws.SERVER_MAX_MESSAGE, msg["type"])


class TestServerLimit(ServerCase):
    async def test_server_sockets_take_64_kib(self):
        sock = await self.connect()
        await self.hello(sock, role="controller", name="bot", characters=[])
        (server_side,) = self.server._outboxes
        self.assertEqual(server_side.max_message, ws.SERVER_MAX_MESSAGE)

    async def test_a_frame_one_byte_over_is_dropped_unread(self):
        status, _, reader, writer = await self.upgrade(f"127.0.0.1:{self.port}")
        self.assertEqual(status, 101)
        writer.write(bytes([0x81, 0x80 | 127]) + struct.pack("!Q", ws.SERVER_MAX_MESSAGE + 1) + os.urandom(4))
        await writer.drain()
        rest = await asyncio.wait_for(reader.read(), TIMEOUT)  # reaching EOF is the point
        self.assertLessEqual(len(rest), 4, "nothing but, at most, a close frame")

    async def test_fragments_adding_up_to_one_byte_over_are_dropped(self):
        status, _, reader, writer = await self.upgrade(f"127.0.0.1:{self.port}")
        self.assertEqual(status, 101)
        half = ws.SERVER_MAX_MESSAGE // 2
        writer.write(masked_frame(False, ws.OP_TEXT, b" " * half) + masked_frame(True, ws.OP_CONT, b" " * (half + 1)))
        await writer.drain()
        rest = await asyncio.wait_for(reader.read(), TIMEOUT)
        self.assertLessEqual(len(rest), 4)

    async def test_fragments_adding_up_to_the_limit_are_read(self):
        status, _, reader, writer = await self.upgrade(f"127.0.0.1:{self.port}")
        self.assertEqual(status, 101)
        text = json.dumps({"type": "hello", "role": "god", "pad": ""}).encode()
        text = text[:-2] + b" " * (ws.SERVER_MAX_MESSAGE - len(text)) + text[-2:]  # pad inside the pad string
        self.assertEqual(len(text), ws.SERVER_MAX_MESSAGE)
        half = len(text) // 2
        writer.write(masked_frame(False, ws.OP_TEXT, text[:half]) + masked_frame(True, ws.OP_CONT, text[half:]))
        await writer.drain()
        sock = ws.WebSocket(reader, writer, mask=True)
        self.sockets.append(sock)
        self.assertEqual(json.loads(await asyncio.wait_for(sock.recv(), TIMEOUT))["type"], "welcome")


class TestClientsReadMore(unittest.IsolatedAsyncioTestCase):
    async def test_a_client_reads_what_the_server_would_refuse(self):
        # God's welcome outgrows 64 KiB after a few game days: clients keep the 4 MiB limit.
        sides: list[ws.WebSocket] = []

        async def handle(reader, writer):
            head = (await reader.readuntil(b"\r\n\r\n")).decode().split("\r\n")
            headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in head[1:])}
            sides.append(await ws.server_handshake(reader, writer, headers))

        srv = await asyncio.start_server(handle, "127.0.0.1", 0)
        client = await asyncio.wait_for(ws.connect(f"ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}/ws"), TIMEOUT)
        try:
            await wait_until(lambda: sides)
            big = "w" * (4 * ws.SERVER_MAX_MESSAGE)
            await sides[0].send(big)
            self.assertEqual(await asyncio.wait_for(client.recv(), TIMEOUT), big)
            await client.send(big)  # the other way round it is too big
            with self.assertRaises(ws.ConnectionClosed):
                await asyncio.wait_for(sides[0].recv(), TIMEOUT)
        finally:
            client.abort()
            for s in sides:
                s.abort()
            srv.close()
            await asyncio.wait_for(srv.wait_closed(), TIMEOUT)


# --- ENG-5: the HTTP preamble's limits ----------------------------------------------------------------------------


class TestPreambleLimits(ServerCase):
    async def get(self, header_lines: list[str]) -> tuple[int, dict[str, str], asyncio.StreamReader]:
        reader, writer = await self.open()
        writer.write(("GET / HTTP/1.1\r\n" + "".join(f"{h}\r\n" for h in header_lines) + "\r\n").encode())
        await writer.drain()
        status, headers = await read_head(reader)
        return status, headers, reader

    def test_the_documented_limits(self):
        self.assertEqual((server_module.HEADER_SECONDS, server_module.HEADER_LINES, server_module.HEADER_BYTES),
                         (10.0, 100, 16384))

    async def test_200_header_lines_get_431(self):
        status, headers, reader = await self.get([f"X-{i}: y" for i in range(200)])
        self.assertEqual(status, 431)
        self.assertEqual(headers["connection"], "close")
        self.assertEqual(await asyncio.wait_for(reader.read(), TIMEOUT), b"")
        status, _, _ = await self.get(["Host: localhost"] + [f"X-{i}: y" for i in range(99)])
        self.assertEqual(status, 200, "100 lines are fine")

    async def test_too_many_lines_or_bytes_get_431(self):
        with mock.patch.object(server_module, "HEADER_LINES", 5), mock.patch.object(server_module, "HEADER_BYTES", 200):
            self.assertEqual((await self.get([f"X-{i}: y" for i in range(5)]))[0], 200)
            self.assertEqual((await self.get([f"X-{i}: y" for i in range(6)]))[0], 431)
            self.assertEqual((await self.get(["X-A: " + "a" * 90, "X-B: " + "b" * 90]))[0], 200)
            self.assertEqual((await self.get(["X-A: " + "a" * 90, "X-B: " + "b" * 90, "X-C: c"]))[0], 431)
            self.assertEqual((await self.get(["X-A: " + "a" * 300]))[0], 431, "one long line")

    async def test_an_upgrade_with_too_many_headers_gets_431(self):
        with mock.patch.object(server_module, "HEADER_LINES", 4):
            status, _, _, _ = await self.upgrade(f"127.0.0.1:{self.port}")  # a Host and four lines of its own
            self.assertEqual(status, 431)
            self.assertIsNone(self.server.god)

    async def test_a_silent_connection_is_closed(self):
        with mock.patch.object(server_module, "HEADER_SECONDS", 0.3):
            reader, _ = await self.open()
            self.assertEqual(await asyncio.wait_for(reader.read(), TIMEOUT), b"")
            await wait_until(lambda: not self.server._connections)

    async def test_headers_that_never_end_are_cut_off(self):
        # A header line every 0.1 s, forever: the time limit is for the whole preamble, not for each line.
        with mock.patch.object(server_module, "HEADER_SECONDS", 0.5):
            reader, writer = await self.open()
            writer.write(b"GET / HTTP/1.1\r\n")

            async def trickle():
                try:
                    for i in range(100):
                        writer.write(b"X-%d: y\r\n" % i)
                        await writer.drain()
                        await asyncio.sleep(0.1)
                except ConnectionError:
                    pass

            dripping = asyncio.create_task(trickle())
            try:
                self.assertEqual(await asyncio.wait_for(reader.read(), TIMEOUT), b"")
            finally:
                dripping.cancel()

    async def test_a_websocket_session_has_no_time_limit(self):
        with mock.patch.object(server_module, "HEADER_SECONDS", 0.3):
            sock = await self.connect()
            welcome = await self.hello(sock, role="controller", name="bot", characters=["tom"])
            self.assertEqual(welcome["characters"], ["tom"])
            await asyncio.sleep(0.8)  # idle well past HEADER_SECONDS
            await sock.send(json.dumps({"type": "query", "agent_id": "tom", "what": "people", "req_id": 1}))
            reply = json.loads(await asyncio.wait_for(sock.recv(), TIMEOUT))
            self.assertEqual((reply["type"], reply["req_id"]), ("answer", 1))
            self.assertEqual(self.sim.agents["tom"].controller, "bot")


# --- ENG-6: repeated ids in a hello -------------------------------------------------------------------------------


class TestHelloRepeats(ServerCase):
    def joined(self) -> list[dict]:
        return [e for e in self.sim.history if e["tag"] == "controller_joined"]

    async def test_a_repeated_id_is_claimed_and_announced_once(self):
        welcome = await self.hello(await self.connect(), role="controller", name="bot", characters=["dana", "dana"])
        self.assertEqual(welcome["characters"], ["dana"])
        self.assertEqual(list(welcome["profiles"]), ["dana"])
        (event,) = self.joined()
        self.assertEqual(event["text"], "Dana Cohen is now played by bot.")
        self.assertEqual(event["agents"], ["dana"])

    async def test_order_is_kept_and_each_id_counts_once(self):
        welcome = await self.hello(await self.connect(), role="controller", name="bot",
                                   characters=["tom", "ari", "tom", "ari", "tom"])
        self.assertEqual(welcome["characters"], ["tom", "ari"])
        (event,) = self.joined()
        self.assertEqual(event["text"], "Tom Levi and Ari Ben-David are now played by bot.")
        self.assertEqual(sorted(self.sim.controllers["bot"]["characters"]), ["ari", "tom"])

    async def test_a_flood_of_one_id(self):
        welcome = await self.hello(await self.connect(), role="controller", name="bot", characters=["dana"] * 5000)
        self.assertEqual(welcome["characters"], ["dana"])
        self.assertEqual(self.joined()[0]["text"], "Dana Cohen is now played by bot.")


# --- ENG-7: a busy port at startup --------------------------------------------------------------------------------


class TestBusyPort(unittest.TestCase):
    def run_game(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "gameofailife", *args], cwd=REPO, capture_output=True,
                              text=True, timeout=60)

    def test_a_port_in_use_gives_one_line(self):
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            done = self.run_game("--port", str(port))
        self.assertNotEqual(done.returncode, 0)
        self.assertNotIn("Traceback", done.stderr)
        lines = done.stderr.strip().splitlines()
        self.assertEqual(len(lines), 1, done.stderr)
        self.assertIn(f"Port {port} is already in use", lines[0])
        self.assertIn("--port 0", lines[0])
        self.assertNotIn("is running", done.stdout)

    def test_an_address_not_on_this_machine_gives_one_line(self):
        done = self.run_game("--host", "192.0.2.1", "--port", "0")  # TEST-NET-1: never one of ours
        self.assertNotEqual(done.returncode, 0)
        self.assertNotIn("Traceback", done.stderr)
        lines = done.stderr.strip().splitlines()
        self.assertEqual(len(lines), 1, done.stderr)
        self.assertTrue(lines[0].startswith("Could not listen on 192.0.2.1:0: "), lines[0])


class TestServeStartup(unittest.IsolatedAsyncioTestCase):
    async def test_serve_turns_only_the_bind_error_into_a_message(self):
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            caught = None
            try:  # awaited here, not in a task of its own, so the SystemExit stops at this except
                await serve(Simulation(seed=1), "127.0.0.1", port)
            except SystemExit as exc:
                caught = exc
        self.assertIsNotNone(caught)
        self.assertIn(f"Port {port} is already in use", str(caught.code))
        self.assertIsNone(caught.__cause__, "no traceback of the bind error behind it")


# --- ENG-4: where the character is, and debts, on Claude's page ---------------------------------------------------


def a_fork(sim: Simulation, agent_id: str) -> dict:
    fork = Fork(agent_id, "test", "What do you do?", [Option(f"Option {c}", [("idle", None)]) for c in "ABCD"],
                sim.clock.tick)
    return sim.fork_message(sim.agents[agent_id], fork)


def where_line(page: str) -> str:
    (line,) = [ln for ln in page.splitlines() if "You are at: " in ln]
    return line.split("You are at: ", 1)[1]


class TestClaudePage(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation(seed=1)

    def resident(self, flat: bool) -> str:
        """Someone at home first thing in the morning, in a flat or in a house."""
        for a in self.sim.agents.values():
            home = self.sim.homes[self.sim.household(a).home_id]
            if (", flat " in home.name) == flat and a.inside == home.place:
                return a.id
        self.fail("nobody at home")

    def test_a_flat_resident_at_home_is_told_so(self):
        aid = self.resident(flat=True)
        msg = a_fork(self.sim, aid)
        you = msg["you"]
        self.assertNotEqual(you["where_name"], you["home_name"], "precondition: a flat is named after its building")
        self.assertTrue(you["home_name"].startswith(you["where_name"] + ", flat "))
        self.assertEqual(where_line(cc.decision_page(msg)), "home.")

    def test_a_house_resident_at_home_is_told_so(self):
        msg = a_fork(self.sim, self.resident(flat=False))
        self.assertEqual(msg["you"]["where_name"], msg["you"]["home_name"])
        self.assertEqual(where_line(cc.decision_page(msg)), "home.")

    def test_away_from_home_names_the_place(self):
        aid = self.resident(flat=True)
        agent = self.sim.agents[aid]
        elsewhere = next(p for p in self.sim.town.places.values() if p.kind == "cafe")
        agent.inside = elsewhere.id
        msg = a_fork(self.sim, aid)
        self.assertEqual(where_line(cc.decision_page(msg)), f"{elsewhere.name}.")
        # A place whose name only begins like the building's is not home either.
        msg["you"]["where_name"] = msg["you"]["home_name"].split(",")[0][:-1]
        self.assertNotEqual(where_line(cc.decision_page(msg)), "home.")

    def test_debts_have_the_minus_in_front(self):
        msg = a_fork(self.sim, "dana")
        msg["you"].update(money=-400.0, savings=-12.5, household_funds=-800)
        page = cc.decision_page(msg)
        self.assertIn("Money -$400.00 on you, -$12.50 in savings, household -$800 between you.", page)
        self.assertNotIn("$-", page)
        msg["you"].update(money=1234.5, savings=0, household_funds=15900)
        self.assertIn("Money $1,234.50 on you, $0.00 in savings, household $15,900 between you.", cc.decision_page(msg))

    def test_amounts(self):
        self.assertEqual(cc._dollars(-1500), "-$1,500")
        self.assertEqual(cc._dollars(1500.4), "$1,500")
        self.assertEqual(cc._cents(-0.004), "$0.00", "rounds to nothing: no minus")
        self.assertEqual(cc._cents(-0.5), "-$0.50")
        self.assertEqual(cc._dollars(None), "$?")
        self.assertIn("you rent it for -$5 a week", cc.home_line({"home": {"name": "X", "weekly_cost": -5}}))


class TestClaudeWelcome(unittest.IsolatedAsyncioTestCase):
    async def welcome_output(self, claimed: list[str]) -> str:
        class FakeWS:
            async def send(self, text: str) -> None:
                pass

        args = types.SimpleNamespace(fake=True, model="claude-haiku-5-5", chat=False, characters="all",
                                     name="claude", url="ws://localhost:8000/ws")
        ctl = cc.ClaudeController(args, "")
        ctl.ws = FakeWS()
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            ctl.handle({"type": "welcome", "name": "claude", "characters": claimed, "available": ["tom"]})
        for task in list(ctl.tasks):
            await task
        ctl.pool.shutdown(wait=False)
        return printed.getvalue()

    async def test_nobody_claimed_only_when_nobody_was(self):
        self.assertNotIn("Nobody claimed", await self.welcome_output(["dana", "ari"]))
        self.assertIn("Nobody claimed. Free characters: tom", await self.welcome_output([]))


if __name__ == "__main__":
    unittest.main()
