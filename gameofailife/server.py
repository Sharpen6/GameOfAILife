"""The game server: serves the web client and runs the city over one WebSocket endpoint.

Two kinds of connection share `/ws`, picked by the first `hello` message:

* `god`: the player's web view. Receives the town, then a `state` frame every
  step, plus events and decided forks. May change luck, speed and profiles.
* `controller`: anything that plays characters (an LLM, a script, a person).
  Claims characters, receives their forks, answers with a choice, asks what a
  character owns or knows, and sends messages between characters.

See `docs/protocol.md` for every message.
"""

from __future__ import annotations

import asyncio
import errno
import ipaddress
import json
import math
import mimetypes
import os
import socket
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

from . import people, transit
from .clock import TICKS_PER_REAL_SECOND
from .sim import Simulation
from .ws import ConnectionClosed, MessageTooBig, WebSocket, server_handshake

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"
FRAME_SECONDS = 0.05
SPEEDS = (0, 1, 2, 4, 8, 16)
GOD_ONLY = {"set_luck", "set_speed", "pause", "resume", "set_profile"}
HOUSING_EVERY = 40  # frames carry `lots` and `homes` when they change, and in every 40th frame anyway
REGION_HOUSING_CHECK = 20  # the region's `lots` and `homes` are compared every 20th frame ...
REGION_HOUSING_EVERY = 200  # ... and sent anyway every 200th (PLAN 2.11)
OCC_EVERY = 40  # a frame carries `occ` at most every 40th frame ...
OCC_TICKS = 10  # ... once the last one sent is 10 ticks old (PLAN 2.11)
CATCH_UP_FRAMES = 4  # a late loop pass runs at most this many frames' worth of ticks (folk.md 9)
WELCOME_HISTORY, WELCOME_NEWS, WELCOME_HEADLINES, WELCOME_LLM_LOG = 80, 120, 20, 80
STALL_SECONDS = 5.0  # how long a push may wait to be sent before its client is dropped
AHEAD_SECONDS = 0.5  # how long a fork may wait behind texts that are already in the inbox
UNSENT_BYTES = 16384  # how much the kernel may hold that is not on its way to the client yet
PACED = ("send_message", "invite")  # what lands on other controllers and in every view's frames
PACE_RATE, PACE_BURST = 20, 100  # how many of those one controller may send a second, after a burst
STATS_SECONDS = 3.0  # a stats push this often while the city runs ...
STATS_MAJOR_SECONDS = 0.5  # ... and this soon after the last one when a major event happened
HEADER_SECONDS = 10.0  # how long a client may take to send its request line and headers; a session has no limit
HEADER_LINES, HEADER_BYTES = 100, 16384  # the most header lines, and bytes of them, one request may carry


class Encoded(str):
    """An encoded push that keeps its message and kind ("state" or "stats"), so a client's queue can merge it
    into the push of that kind still waiting there. It is the text itself, so it is sent like any other."""

    kind: str
    msg: dict


def encoded(kind: str, msg: dict) -> Encoded:
    text = Encoded(json.dumps(msg))
    text.kind, text.msg = kind, msg
    return text


def local_host(host: str) -> bool:
    """True when a Host header names `localhost` or an IP address (with or without a port): never a DNS name, which
    whoever runs that name's DNS could point at this machine (DNS rebinding)."""
    try:
        parts = urlsplit(f"//{host}")
        _ = parts.port  # a port that is not a number from 0 to 65535 raises ValueError
    except ValueError:  # also an unclosed "[" and the like
        return False
    if "@" in parts.netloc or parts.path or parts.query or parts.fragment:
        return False
    name = parts.hostname or ""
    if name == "localhost":
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def origin_allowed(headers: dict[str, str]) -> bool:
    """Whether a WebSocket upgrade may go ahead (docs/protocol.md, Connecting). Its Host must be `localhost` or an
    IP address, whatever the client. A browser also sends `Origin`, and that must be this very address: the page God
    loaded from here. The Python and Node controllers send no Origin."""
    host = headers.get("host", "").lower()
    if not local_host(host):
        return False
    origin = headers.get("origin")
    if origin is None:
        return True
    try:
        return urlsplit(origin).netloc.lower() == host
    except ValueError:
        return False


def url_host(host: str, bound: str) -> str:
    """The host for the startup message's URLs, for --host `host` listening on address `bound`: one that /ws lets
    in. Every interface (0.0.0.0) is `localhost` here; a DNS name is the address it resolved to."""
    if host in ("", "0.0.0.0", "::") or host.lower() == "localhost":
        return "localhost"
    for address in (host, bound):
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        return f"[{ip}]" if ip.version == 6 else str(ip)
    return bound


def frame_span(elapsed: float) -> float:
    """The real seconds a loop pass turns into ticks: the time since the last pass, exactly FRAME_SECONDS when it
    was on time (to the float, so an on-time loop runs v2's tick sequence), at most CATCH_UP_FRAMES frames."""
    if abs(elapsed - FRAME_SECONDS) < 1e-9:
        return FRAME_SECONDS
    return max(0.0, min(elapsed, CATCH_UP_FRAMES * FRAME_SECONDS))


def merge_state(old: dict, new: dict) -> dict:
    """One state frame for two (PLAN 3.14): the newer frame, with the older one's events before its own, the
    older one's fork summaries upserted by id (the newer copy wins, in the older one's place), and the older one's
    `lots`, `homes` and `occ` when the newer frame lacks them. Neither frame is changed."""
    state = new["state"]
    kept = {k: old["state"][k] for k in ("lots", "homes", "occ") if k in old["state"] and k not in state}
    if kept:
        state = {**state, **kept}
    forks = list(old["forks"])
    at = {f["id"]: i for i, f in enumerate(forks)}
    for f in new["forks"]:
        if f["id"] in at:
            forks[at[f["id"]]] = f
        else:
            at[f["id"]] = len(forks)
            forks.append(f)
    return {**new, "state": state, "events": old["events"] + new["events"], "forks": forks}


def merge_stats(old: dict, new: dict) -> dict:
    """One stats push for two: the newer one, with both pushes' samples (deduped by tick, oldest first) and
    `full` if either was full."""
    samples = {s["tick"]: s for s in old["samples"]}
    samples.update((s["tick"], s) for s in new["samples"])
    return {**new, "full": bool(old.get("full") or new.get("full")), "samples": [samples[t] for t in sorted(samples)]}


MERGE = {"state": merge_state, "stats": merge_stats}


class _Entry:
    """One push waiting in a client's outbox. `text` is None for a merged push (encoded when it is sent) and for
    the note that makes the sender report skipped texts. `inbox` names the character of a controller's text."""

    __slots__ = ("queued", "text", "inbox", "kind", "msg", "matters")

    def __init__(self, queued: float, text: str | None, inbox: str | None = None):
        self.queued = queued  # when it was queued, or merged into
        self.text = text
        self.inbox = inbox
        self.kind = getattr(text, "kind", None) if text is not None and not inbox else None
        self.msg = getattr(text, "msg", None) if self.kind else None
        self.matters = text is not None and not inbox  # a push that is never skipped


class Outbox:
    """One client's pushes waiting to be sent, oldest first (PLAN 3.14).

    A new state frame merges into the state frame still waiting here, and a new stats push into the stats push,
    each stamped with the time of the merge; so a slow view gets fewer, fresher frames and holds at most one of
    each. Everything else is first in, first out.
    """

    def __init__(self) -> None:
        self._items: deque[_Entry] = deque()
        self._ready = asyncio.Event()
        self._fifo: deque[float] = deque()  # when each unsent first-in-first-out push that matters was queued
        self._merging: dict[str, _Entry] = {}  # the waiting state frame and stats push, by kind
        self.sending: _Entry | None = None  # the push the sender is on ...
        self.started = 0.0  # ... and when it started sending it

    def qsize(self) -> int:
        return len(self._items)

    def empty(self) -> bool:
        return not self._items

    def put(self, entry: _Entry) -> None:
        old = self._merging.get(entry.kind) if entry.kind else None
        if old is not None:
            old.msg = MERGE[entry.kind](old.msg, entry.msg)
            old.text, old.queued = None, entry.queued  # re-encoded for this client when it is sent
            return
        if entry.kind:
            self._merging[entry.kind] = entry
        elif entry.matters:
            self._fifo.append(entry.queued)
        self._items.append(entry)
        self._ready.set()

    async def get(self) -> _Entry:
        while not self._items:
            self._ready.clear()
            await self._ready.wait()
        entry = self._items.popleft()
        if entry.kind:
            del self._merging[entry.kind]  # taken to be sent: a newer push of its kind is queued afresh
        return entry

    def begin(self, entry: _Entry, now: float) -> None:
        """The sender starts sending an entry it got."""
        self.sending, self.started = entry, now

    def done(self, entry: _Entry) -> None:
        """The sender is through with an entry it got: sent, or skipped."""
        if entry.matters and not entry.kind:
            self._fifo.popleft()  # first in, first out: it is the oldest
        if self.sending is entry:
            self.sending = None

    def waiting(self) -> bool:
        """True when a push that matters is queued behind the one being sent."""
        return bool(self._merging) or len(self._fifo) > (self.sending is not None and self.sending.matters
                                                         and not self.sending.kind)

    def stalled(self, now: float) -> bool:
        """True when the client is too far behind to keep: a first-in-first-out push that matters was queued
        more than STALL_SECONDS ago and is still unsent, or one send has taken that long while it or another
        push that matters waits. A merged frame counts from its last merge, so a slow view is not dropped for
        merely reading slowly."""
        if self._fifo and now - self._fifo[0] > STALL_SECONDS:
            return True
        return (self.sending is not None and now - self.started > STALL_SECONDS
                and (self.sending.matters or self.waiting()))


class GameServer:
    def __init__(self, sim: Simulation, speed: int = 1):
        self.sim = sim
        self.speed = speed
        self.god: WebSocket | None = None
        self.observers: set[WebSocket] = set()
        self.controllers: dict[str, WebSocket] = {}
        self._outboxes: dict[WebSocket, Outbox] = {}  # every session's pushes waiting to be sent
        self._sending: dict[WebSocket, float] = {}  # when the push each sender is on was queued
        self._skipped: dict[WebSocket, dict[str, int]] = {}  # texts skipped for each character, not yet reported
        self._connections: set[asyncio.StreamWriter] = set()
        self._server: asyncio.base_events.Server | None = None
        self._loop_task: asyncio.Task | None = None
        self._pending_ticks = 0.0
        self._frames = 0  # state frames encoded so far
        self._occ_tick: int | None = None  # the tick of the last `occ` a frame carried
        self._housing_sent: dict[str, str] = {}  # the encoded `lots` and `homes` the views last got
        self._stats_at = time.monotonic()  # when the last stats push went out
        self._stats_stepped = False  # a tick ran since then
        self._stats_major = False  # an importance-2 event was drained since then

    # --- lifecycle ------------------------------------------------------------

    async def start(self, host: str = "127.0.0.1", port: int = 8000) -> int:
        self.sim.town.warm()  # every place's walk field, before the first tick needs one
        self._server = await asyncio.start_server(self._handle, host, port)
        self._loop_task = asyncio.create_task(self._run())
        return self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        if self._server:
            self._server.close()
        # ws.close() gives up on a client that has stopped reading, so none of them can hold this up.
        await asyncio.gather(*(ws.close() for ws in list(self._outboxes)))
        if self._server:
            # Then drop what is left, such as idle or half-sent HTTP requests: wait_closed()
            # waits for every connection (Python 3.12+).
            for writer in list(self._connections):
                writer.transport.abort()
            await self._server.wait_closed()

    async def _run(self) -> None:
        # folk.md 9: each pass sleeps what is left of its frame after the last pass's work, then runs the ticks
        # the real time since the last pass is worth (frame_span), so a slow tick costs speed, not ticks.
        last = time.monotonic()
        while True:
            await asyncio.sleep(max(0.0, FRAME_SECONDS - (time.monotonic() - last)))
            now = time.monotonic()
            self._pending_ticks += frame_span(now - last) * TICKS_PER_REAL_SECOND * self.speed
            last = now
            stepped = False
            while self._pending_ticks >= 1:
                self._pending_ticks -= 1
                self.sim.step()
                stepped = True
            if not stepped:
                self.sim._check_timeouts()  # answers can time out while paused, too
            self._flush(stepped)

    def _flush(self, stepped: bool) -> None:
        events, forks, outbox = self.sim.drain()
        for name, msg in outbox:
            ws = self.controllers.get(name)
            if ws:
                self._push(ws, json.dumps(msg), inbox=msg["agent_id"] if msg["type"] == "message" else None)
        viewers = [ws for ws in [self.god, *self.observers] if ws]
        self._stats_stepped = self._stats_stepped or stepped
        self._stats_major = self._stats_major or any(ev["importance"] >= 2 for ev in events)
        if viewers and (stepped or events or forks):
            state = self.sim.state_json(housing=False)
            state.update(self._housing_changes())
            self._add_occ(state)
            frame = encoded("state", {"type": "state", "speed": self.speed, "state": state, "events": events,
                                      "forks": forks})
            for ws in viewers:
                self._push(ws, frame)
        self._push_stats(viewers)

    def _push_stats(self, viewers: list[WebSocket]) -> None:
        """The stats cadence (PLAN 3.8): a push when STATS_SECONDS have passed since the last one and a tick ran,
        or STATS_MAJOR_SECONDS when a major event happened; nothing while paused and quiet. Encoded once for all
        viewers."""
        since = time.monotonic() - self._stats_at
        if not (self._stats_stepped and since >= STATS_SECONDS or self._stats_major and since >= STATS_MAJOR_SECONDS):
            return
        self._stats_at += since
        self._stats_stepped = self._stats_major = False
        if not viewers:
            self.sim.stats.take_new_samples()  # nobody to carry them to: a new view's welcome has them all
            return
        push = encoded("stats", self.sim.stats_json(full=False))
        for ws in viewers:
            self._push(ws, push)

    def _housing_changes(self) -> dict:
        """The frame's `lots` and `homes`: each one when its encoded JSON differs from what was last sent, and
        both in every HOUSING_EVERY-th frame. In the region they are compared only every REGION_HOUSING_CHECK-th
        frame and sent anyway every REGION_HOUSING_EVERY-th (PLAN 2.11). Views keep the last copy they got."""
        self._frames += 1
        if self.sim.world == "region":
            if self._frames % REGION_HOUSING_CHECK:
                return {}
            every = self._frames % REGION_HOUSING_EVERY == 0
        else:
            every = self._frames % HOUSING_EVERY == 0
        out = {}
        for key, value in self.sim.housing_maps().items():
            text = json.dumps(value)
            if every or self._housing_sent.get(key) != text:
                self._housing_sent[key] = text
                out[key] = value
        return out

    def _add_occ(self, state: dict) -> None:
        """`occ` in every OCC_EVERY-th frame once the last one sent is OCC_TICKS old (the welcome always has it)."""
        tick = self.sim.clock.tick
        if self._frames % OCC_EVERY == 0 and (self._occ_tick is None or tick - self._occ_tick >= OCC_TICKS):
            state["occ"] = self.sim.folk.occ()
            self._occ_tick = tick

    def _welcome_god(self) -> dict:
        """A new God view's (or watcher's) start: the town once, the full state, and the recent past."""
        sim = self.sim
        state = sim.state_json(housing=True)
        state["occ"] = sim.folk.occ()  # who is in each place, folk and named (PLAN 2.11; frames send it now and then)
        return {"type": "welcome", "role": "god", "town": sim.town_json(), "state": state,
                "history": sim.history[-WELCOME_HISTORY:], "news": sim.news[-WELCOME_NEWS:],
                "headlines": sim.headlines[-WELCOME_HEADLINES:], "llm_log": sim.llm_log[-WELCOME_LLM_LOG:],
                "host": {"kind": "server", "controllers": True}, "stats": sim.stats_json(full=True),
                "speed": self.speed}

    # --- HTTP -----------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            # The request line and headers get HEADER_SECONDS (a TimeoutError is an OSError); the session after
            # an upgrade has no time limit.
            parts, headers = await asyncio.wait_for(self._preamble(reader), HEADER_SECONDS)
            if len(parts) < 2:
                return
            if headers is None:
                await self._refuse(writer, "431 Request Header Fields Too Large")
                return
            path = parts[1].split("?")[0]
            if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
                if not origin_allowed(headers):  # another site's page, or a DNS name pointed here
                    await self._refuse(writer, "403 Forbidden")
                    return
                ws = await server_handshake(reader, writer, headers)
                await self._session(ws)
                return
            await self._static(writer, path)
        except (OSError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self._connections.discard(writer)
            writer.close()  # after a session too: before Python 3.13 nothing else closes the socket

    async def _preamble(self, reader: asyncio.StreamReader) -> tuple[list[str], dict[str, str] | None]:
        """The request line's words and the headers (names lowercased). The headers are None when there are more
        than HEADER_LINES of them or more than HEADER_BYTES in all; the rest is then left unread."""
        parts = (await reader.readline()).decode(errors="replace").split()
        headers: dict[str, str] = {}
        if len(parts) < 2:
            return parts, headers
        lines = size = 0
        while True:
            raw = await reader.readline()
            line = raw.decode(errors="replace").strip()
            if not line:
                return parts, headers
            lines, size = lines + 1, size + len(raw)
            if lines > HEADER_LINES or size > HEADER_BYTES:
                return parts, None
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()

    async def _refuse(self, writer: asyncio.StreamWriter, status: str) -> None:
        writer.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()

    async def _static(self, writer: asyncio.StreamWriter, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        file = (CLIENT_DIR / rel).resolve()
        if CLIENT_DIR not in file.parents or not file.is_file():
            body, status, ctype = b"Not found", "404 Not Found", "text/plain"
        else:
            body, status = file.read_bytes(), "200 OK"
            ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                     "Cache-Control: no-cache\r\nConnection: close\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()

    # --- WebSocket sessions -----------------------------------------------------

    async def _send(self, ws: WebSocket, msg: dict) -> None:
        await self._send_raw(ws, json.dumps(msg))

    async def _send_raw(self, ws: WebSocket, text: str) -> None:
        try:
            await ws.send(text)
        except ConnectionClosed:
            pass

    async def _reply(self, ws: WebSocket, msg: dict, reply: dict) -> None:
        """Send the direct reply to msg, with its req_id if it had one and it can be written back."""
        if "req_id" in msg:
            reply["req_id"] = msg["req_id"]
        try:
            text = json.dumps(reply)
        except (RecursionError, ValueError):  # Python 3.11 can read nesting it cannot write back
            reply.pop("req_id", None)
            try:
                text = json.dumps(reply)  # the reply still arrives, only without its req_id
            except (RecursionError, ValueError):  # it echoes another field nested that deep
                text = json.dumps({"type": "error", "error": "bad message: nested too deeply to echo back"})
        await self._send_raw(ws, text)

    def _push(self, ws: WebSocket, text: str, inbox: str | None = None) -> None:
        """Queue a message the client did not ask for, without waiting on the client.

        A client with a push that matters still unsent after STALL_SECONDS (it stopped
        reading, or one send takes that long) is dropped, so it can never hold up the
        city or pile up more than that many seconds of pushes. A burst of pushes is not lag.
        A state frame or stats push (an Encoded text) merges into the one of its kind still
        queued for that client (Outbox), so a view that reads slowly gets fewer, fresher
        frames and is not dropped for it; the merged push counts as queued when it was merged.
        A controller's `message` push names the character whose inbox has its text, and
        never gets a client dropped: _sender skips it once the client falls behind, and a
        client still on a push queued STALL_SECONDS ago gets no more texts queued, so it
        piles up none. Views see every text as an event in their state frames, which
        are never skipped, but merged, so flooding controllers only make those frames longer.
        """
        outbox = self._outboxes.get(ws)
        if outbox is None or ws.closed:
            return
        now = asyncio.get_running_loop().time()
        skipped = self._skipped[ws]
        if outbox.stalled(now):
            ws.abort()
            return
        if inbox and now - self._sending.get(ws, now) > STALL_SECONDS:
            if not skipped:
                outbox.put(_Entry(now, None))  # so _sender reports it even if nothing else comes
            skipped[inbox] = skipped.get(inbox, 0) + 1
            return
        outbox.put(_Entry(now, text, inbox))

    async def _sender(self, ws: WebSocket, outbox: Outbox) -> None:
        """Send one client's pushes in order, so a slow client only ever holds up itself.

        A text the client is falling behind on is skipped: one that has waited half of
        STALL_SECONDS, or AHEAD_SECONDS with a push that matters (a fork) waiting behind it.
        The client is told how many it missed for each character, so it can query the inbox.
        A merged state frame or stats push is encoded here, once, for this client.
        """
        loop = asyncio.get_running_loop()
        skipped = self._skipped[ws]
        try:
            while True:
                entry = await outbox.get()
                text, inbox = entry.text, entry.inbox
                waited = loop.time() - entry.queued
                # What matters and is still queued was queued after this text: earlier pushes are sent.
                if inbox and (waited > STALL_SECONDS / 2 or waited > AHEAD_SECONDS and outbox.waiting()):
                    skipped[inbox] = skipped.get(inbox, 0) + 1
                    if not outbox.empty():
                        outbox.done(entry)
                        continue
                    text = None  # the queue is empty, so report the skipped texts now
                self._sending[ws] = entry.queued  # everything still queued is newer, so this is the lag
                outbox.begin(entry, loop.time())
                while skipped:  # _push may skip more meanwhile
                    aid, n = skipped.popitem()
                    await ws.send(json.dumps({"type": "messages_skipped", "agent_id": aid, "count": n}))
                if text is None and entry.msg is not None:
                    text = json.dumps(entry.msg)
                if text is not None:
                    await ws.send(text)
                outbox.done(entry)
                del self._sending[ws]
        except ConnectionClosed:
            pass  # the connection is gone: the session's recv() sees that too and ends

    async def _pace(self, due: float) -> float:
        """Wait until a controller may send its next PACED message; takes and returns when the last was due.

        After a burst of PACE_BURST, one controller gets PACE_RATE a second, so it cannot push
        messages at someone faster than an ordinary link carries them and get that client
        dropped for lagging. Meanwhile nothing more is read from it, which holds the sender back.
        """
        now = asyncio.get_running_loop().time()
        due = max(due, now - PACE_BURST / PACE_RATE) + 1 / PACE_RATE
        if due > now:
            await asyncio.sleep(due - now)
        return due

    async def _session(self, ws: WebSocket) -> None:
        role, name = None, None
        paced = 0.0  # when this controller's last PACED message was due
        try:
            # Otherwise the kernel takes megabytes a slow client has not read, and the texts among
            # them can no longer be skipped. Kept in the outbox instead, a fork gets ahead of them.
            sock = ws.writer.get_extra_info("socket")
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NOTSENT_LOWAT, UNSENT_BYTES)
        except (AttributeError, OSError):  # not on every system
            pass
        try:
            # Nor may asyncio's own buffer take more than that (64 KB by default): a view's frames wait in the
            # outbox instead, where a newer frame merges into them, so a slow view's frames stay fresh.
            ws.writer.transport.set_write_buffer_limits(high=UNSENT_BYTES)
        except AttributeError:
            pass
        self._outboxes[ws] = outbox = Outbox()
        self._skipped[ws] = {}
        sender = asyncio.create_task(self._sender(ws, outbox))
        try:
            while True:
                try:
                    msg = json.loads(await ws.recv())
                except MessageTooBig as exc:  # read past unparsed, so it has no req_id to answer with
                    why = f"the most the server reads is {exc.limit:,} bytes, so it was dropped unread"
                    await self._send(ws, {"type": "error", "error": f"message too large: {why}"})
                    continue
                except (ValueError, RecursionError):  # also bad UTF-8, a too-long number, deep nesting
                    await self._send(ws, {"type": "error", "error": "messages must be JSON"})
                    continue
                if not isinstance(msg, dict):
                    await self._send(ws, {"type": "error", "error": "messages must be JSON objects"})
                    continue
                if role is None:
                    if msg.get("type") != "hello":
                        await self._reply(ws, msg, {"type": "error", "error": "say hello first"})
                        continue
                    try:
                        role, name = await self._hello(ws, msg)
                    except (ValueError, TypeError, AttributeError) as exc:
                        await self._reply(ws, msg, {"type": "error", "error": f"bad hello: {exc}"})
                    continue
                watching = role == "god" and ws is not self.god
                try:
                    if watching and isinstance(msg.get("type"), str) and msg["type"] in GOD_ONLY:
                        reply = {"type": "error", "error": "only God can do that; this view is watching"}
                    elif role == "god":
                        reply = self._god(msg)
                    else:
                        if msg.get("type") in PACED:
                            paced = await self._pace(paced)
                        reply = self._controller(name, msg)
                except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
                    reply = {"type": "error", "error": f"bad message: {exc}"}
                if reply:
                    await self._reply(ws, msg, reply)
        except ConnectionClosed:
            pass
        finally:
            sender.cancel()
            del self._outboxes[ws]
            self._sending.pop(ws, None)
            self._skipped.pop(ws, None)
            if role == "controller" and self.controllers.get(name) is ws:
                del self.controllers[name]
                self.sim.controller_left(name, self.sim.release(name))
            if ws is self.god:
                self.god = None
            self.observers.discard(ws)
            await ws.close()

    async def _hello(self, ws: WebSocket, msg: dict) -> tuple[str, str | None]:
        role = msg.get("role")
        if role == "god":
            # One God per city: the newest God view takes over and the old one keeps watching.
            if self.god:
                self.observers.add(self.god)
                self._push(self.god, json.dumps({"type": "demoted", "reason": "another God view took over"}))
            self.god = ws
            await self._reply(ws, msg, self._welcome_god())
            return "god", None
        if role == "controller":
            name = str(msg.get("name") or "controller")[:40]
            base, n = name, 2
            while name in self.controllers:
                name, n = f"{base}-{n}", n + 1
            model = msg.get("model")
            model = str(model)[:60] if model is not None else None  # shown to God only, never to characters
            self.controllers[name] = ws
            try:
                wanted = msg.get("characters") or []
                if wanted == "all":
                    wanted = [a.id for a in self.sim.living() if not a.controller]
                if not isinstance(wanted, list):
                    raise TypeError('characters must be a list of ids or "all"')
                wanted = list(dict.fromkeys(str(w) for w in wanted))  # a repeated id is claimed, and announced, once
                claimed = [aid for aid in wanted if self.sim.claim(aid, name)]
                welcome = {
                    "type": "welcome", "role": "controller", "name": name, "characters": claimed,
                    "profiles": {aid: self.sim.agents[aid].profile.prompt for aid in claimed},
                    "answer_seconds": 5, "time": self.sim.clock.stamp(),
                    "available": [a.id for a in self.sim.living() if not a.controller],
                }
                self.sim.controller_joined(name, model, claimed)  # one event for the whole hello
                await self._reply(ws, msg, welcome)
            except BaseException:
                # _session does not know this name yet, so a hello that fails undoes itself here.
                del self.controllers[name]
                self.sim.controller_left(name, self.sim.release(name))
                raise
            return "controller", name
        await self._reply(ws, msg, {"type": "error", "error": "role must be god or controller"})
        await ws.close()
        raise ConnectionClosed()

    def _god(self, msg: dict) -> dict | None:
        t = msg.get("type")
        if t == "set_luck":
            luck = msg.get("luck", 50)
            if isinstance(luck, bool) or not isinstance(luck, (int, float)) or not math.isfinite(luck):
                raise TypeError("luck must be a number")
            ok = self.sim.set_luck(str(msg.get("agent_id")), float(luck))
            return {"type": "luck_set", "ok": ok, "agent_id": msg.get("agent_id"),
                    "luck": self.sim.luck_of(str(msg["agent_id"])) if ok else None}
        if t == "set_speed":
            speed = int(msg.get("speed", 1))
            self.speed = speed if speed in SPEEDS else 1
            return {"type": "speed", "speed": self.speed}
        if t == "pause":
            self.speed = 0
            return {"type": "speed", "speed": 0}
        if t == "resume":
            self.speed = self.speed or 1
            return {"type": "speed", "speed": self.speed}
        if t == "get_agent":
            data = self.sim.agent_json(str(msg.get("agent_id")))
            return {"type": "agent", "agent": data} if data else {"type": "error", "error": "unknown character"}
        if t == "get_home":
            home = self.sim.home_page(str(msg.get("home_id")))
            return {"type": "home", "home": home} if home else {"type": "error", "error": "unknown home"}
        if t == "get_stats":
            return self.sim.stats_json(full=True)
        if t == "get_folk":
            return {"type": "folk", "v": self.sim.folk.v, "rows": self.sim.folk.roster_rows(self.sim)}
        if t == "get_decisions":
            page = self.sim.decisions(msg.get("agent_id"), msg.get("before"), msg.get("limit"))
            return page if page is not None else {"type": "error", "error": "unknown character"}
        if t == "set_profile":
            ok = self.sim.set_profile(str(msg.get("agent_id")), msg.get("prompt"), msg.get("traits"))
            return {"type": "agent", "agent": self.sim.agent_json(msg["agent_id"])} if ok else {"type": "error", "error": "unknown character"}
        return {"type": "error", "error": f"unknown message type {t!r}"}

    def _controller(self, name: str, msg: dict) -> dict | None:
        t = msg.get("type")
        sim = self.sim
        if t == "choose":
            res = sim.answer(str(msg.get("fork_id")), msg.get("choice"), str(msg.get("reason", ""))[:300], controller=name)
            return {"type": "ack", "fork_id": msg.get("fork_id"), **res}
        if t == "claim":
            aid = str(msg.get("agent_id"))
            mine = aid in sim.agents and sim.agents[aid].controller == name
            ok = sim.claim(aid, name)
            if ok and not mine:
                sim.controller_joined(name, None, [aid])
            return {"type": "claimed", "agent_id": aid, "ok": ok,
                    "profile": sim.agents[aid].profile.prompt if ok else None}
        if t == "release":
            sim.controller_left(name, sim.release(name, str(msg.get("agent_id"))), release=True)
            return {"type": "released", "agent_id": msg.get("agent_id")}
        agent = sim.agents.get(str(msg.get("agent_id")))
        if t in ("query", "send_message", "invite") and (not agent or agent.controller != name):
            return {"type": "error", "error": "not your character"}
        if t == "query":
            what = msg.get("what", "attributes")
            answers = {
                "possessions": lambda: sim.possessions(agent),
                "attributes": agent.attributes,
                "relationships": lambda: {oid: people.rel_row(sim, oid, r) for oid, r in agent.relationships.items()},
                "memory": lambda: agent.memory[-30:],
                "inbox": lambda: agent.inbox[-20:],
                "world": lambda: {"time": sim.clock.stamp(), "season": sim.clock.season, "weather": sim.weather,
                                  "places": {p.id: {"name": p.name, "kind": p.kind, "district": p.district,
                                                    "open": p.is_open(sim.clock.hour)}
                                             for p in sim.town.places.values()
                                             if sim.town.millbrook_ids is None or p.id in sim.town.millbrook_ids},
                                  "timetable": transit.timetable_json()},
                "people": lambda: {a.id: a.name for a in sim.living()},
                "market": lambda: sim.market_json(),
            }
            if what not in answers:
                return {"type": "error", "error": f"what must be one of {sorted(answers)}"}
            return {"type": "answer", "agent_id": agent.id, "what": what, "data": answers[what]()}
        if t == "send_message":
            res = sim.send_message(agent.id, str(msg.get("to")), str(msg.get("text", "")))
            return {"type": "sent", **res}
        if t == "invite":
            inv = sim.invite(agent, str(msg.get("to")), str(msg.get("place", "cafe")))
            return {"type": "invited", "ok": bool(inv), "invite": inv}
        return {"type": "error", "error": f"unknown message type {t!r}"}


def _listen_failed(exc: OSError, host: str, port: int) -> SystemExit:
    """The one-line startup error for a port that is taken or an address that is not this machine's."""
    if exc.errno == errno.EADDRINUSE:
        return SystemExit(f"Port {port} is already in use on {host} (is GameOfAILife already running?). "
                          "Try --port 0 for any free port, or another --port.")
    why = os.strerror(exc.errno) if exc.errno and exc.errno > 0 else exc.strerror or str(exc)  # gaierror: < 0
    return SystemExit(f"Could not listen on {host}:{port}: {why}. Check --host and --port.")


def check_listen(host: str, port: int) -> None:
    """Fail fast, before the region and its townsfolk are built (a few seconds), when the server could not listen
    on host:port; `serve` checks again when it really starts."""
    try:
        infos = socket.getaddrinfo(host or None, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE)
        family, kind, proto, _, address = infos[0]
        with socket.socket(family, kind, proto) as probe:
            if os.name == "posix":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as asyncio.start_server does
            probe.bind(address)
    except OSError as exc:
        raise _listen_failed(exc, host, port) from None


async def serve(sim: Simulation, host: str, port: int, speed: int = 1) -> None:
    server = GameServer(sim, speed)
    try:
        actual = await server.start(host, port)
    except OSError as exc:  # only here, at startup: the port is taken, or --host is not an address of this machine
        raise _listen_failed(exc, host, port) from None
    shown = url_host(host, server._server.sockets[0].getsockname()[0])
    print(f"GameOfAILife is running. Open http://{shown}:{actual} to watch as God.")
    print(f"Controllers connect to ws://{shown}:{actual}/ws")
    try:
        await asyncio.Event().wait()
    finally:
        await server.stop()
