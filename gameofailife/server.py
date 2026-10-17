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
import json
import math
import mimetypes
import socket
from collections import deque
from pathlib import Path

from . import transit
from .clock import TICKS_PER_REAL_SECOND
from .sim import Simulation
from .ws import ConnectionClosed, WebSocket, server_handshake

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"
FRAME_SECONDS = 0.05
SPEEDS = (0, 1, 2, 4, 8, 16)
GOD_ONLY = {"set_luck", "set_speed", "pause", "resume", "set_profile"}
HOUSING_EVERY = 40  # frames carry `lots` and `homes` when they change, and in every 40th frame anyway
WELCOME_HISTORY, WELCOME_NEWS, WELCOME_HEADLINES, WELCOME_LLM_LOG = 80, 120, 20, 80
STALL_SECONDS = 5.0  # how long a push may wait to be sent before its client is dropped
AHEAD_SECONDS = 0.5  # how long a fork may wait behind texts that are already in the inbox
UNSENT_BYTES = 16384  # how much the kernel may hold that is not on its way to the client yet
PACED = ("send_message", "invite")  # what lands on other controllers and in every view's frames
PACE_RATE, PACE_BURST = 20, 100  # how many of those one controller may send a second, after a burst


class GameServer:
    def __init__(self, sim: Simulation, speed: int = 1):
        self.sim = sim
        self.speed = speed
        self.god: WebSocket | None = None
        self.observers: set[WebSocket] = set()
        self.controllers: dict[str, WebSocket] = {}
        self._outboxes: dict[WebSocket, asyncio.Queue] = {}  # every session's pushes waiting to be sent
        self._sending: dict[WebSocket, float] = {}  # when the push each sender is on was queued
        self._urgent: dict[WebSocket, deque[float]] = {}  # when each session's unsent never-skipped pushes were queued
        self._skipped: dict[WebSocket, dict[str, int]] = {}  # texts skipped for each character, not yet reported
        self._connections: set[asyncio.StreamWriter] = set()
        self._server: asyncio.base_events.Server | None = None
        self._loop_task: asyncio.Task | None = None
        self._pending_ticks = 0.0
        self._frames = 0  # state frames encoded so far
        self._housing_sent: dict[str, str] = {}  # the encoded `lots` and `homes` the views last got

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
        while True:
            await asyncio.sleep(FRAME_SECONDS)
            self._pending_ticks += FRAME_SECONDS * TICKS_PER_REAL_SECOND * self.speed
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
        if not viewers or not (stepped or events or forks):
            return
        state = self.sim.state_json(housing=False)
        state.update(self._housing_changes())
        frame = json.dumps({"type": "state", "speed": self.speed, "state": state, "events": events, "forks": forks})
        for ws in viewers:
            self._push(ws, frame)

    def _housing_changes(self) -> dict:
        """The frame's `lots` and `homes`: each one when its encoded JSON differs from what was last sent, and
        both in every HOUSING_EVERY-th frame. Views keep the last copy they got."""
        self._frames += 1
        every = self._frames % HOUSING_EVERY == 0
        out = {}
        for key, value in self.sim.housing_maps().items():
            text = json.dumps(value)
            if every or self._housing_sent.get(key) != text:
                self._housing_sent[key] = text
                out[key] = value
        return out

    def _welcome_god(self) -> dict:
        """A new God view's (or watcher's) start: the town once, the full state, and the recent past."""
        sim = self.sim
        state = sim.state_json(housing=True)
        return {"type": "welcome", "role": "god", "town": sim.town_json(), "state": state,
                "history": sim.history[-WELCOME_HISTORY:], "news": sim.news[-WELCOME_NEWS:],
                "headlines": sim.headlines[-WELCOME_HEADLINES:], "llm_log": sim.llm_log[-WELCOME_LLM_LOG:],
                "host": {"kind": "server", "controllers": True}, "speed": self.speed}

    # --- HTTP -----------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            request = await reader.readline()
            parts = request.decode(errors="replace").split()
            if len(parts) < 2:
                return
            headers = {}
            while True:
                line = (await reader.readline()).decode(errors="replace").strip()
                if not line:
                    break
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()
            path = parts[1].split("?")[0]
            if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
                ws = await server_handshake(reader, writer, headers)
                await self._session(ws)
                return
            await self._static(writer, path)
        except (OSError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self._connections.discard(writer)
            writer.close()  # after a session too: before Python 3.13 nothing else closes the socket

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
        reading, or reads too slowly to keep up) is dropped, so it can never hold up the
        city or pile up more than that many seconds of pushes. A burst of pushes is not lag.
        A controller's `message` push names the character whose inbox has its text, and
        never gets a client dropped: _sender skips it once the client falls behind, and a
        client still on a push queued STALL_SECONDS ago gets no more texts queued, so it
        piles up none. Views see every text as an event in their state frames, which
        are never skipped, so enough flooding controllers can still get a slow view
        dropped; anyone may take over as God, so that is a nuisance, not a theft.
        """
        outbox = self._outboxes.get(ws)
        if outbox is None or ws.closed:
            return
        now = asyncio.get_running_loop().time()
        urgent, skipped = self._urgent[ws], self._skipped[ws]
        if urgent and now - urgent[0] > STALL_SECONDS:
            ws.abort()
            return
        if inbox and now - self._sending.get(ws, now) > STALL_SECONDS:
            if not skipped:
                outbox.put_nowait((now, None, None))  # so _sender reports it even if nothing else comes
            skipped[inbox] = skipped.get(inbox, 0) + 1
            return
        if not inbox:
            urgent.append(now)
        outbox.put_nowait((now, text, inbox))

    async def _sender(self, ws: WebSocket, outbox: asyncio.Queue) -> None:
        """Send one client's pushes in order, so a slow client only ever holds up itself.

        A text the client is falling behind on is skipped: one that has waited half of
        STALL_SECONDS, or AHEAD_SECONDS with a push that matters (a fork) waiting behind it.
        The client is told how many it missed for each character, so it can query the inbox.
        """
        loop = asyncio.get_running_loop()
        urgent, skipped = self._urgent[ws], self._skipped[ws]
        try:
            while True:
                queued, text, inbox = await outbox.get()
                waited = loop.time() - queued
                # Anything still in urgent was queued after this text: earlier pushes are sent.
                if inbox and (waited > STALL_SECONDS / 2 or waited > AHEAD_SECONDS and urgent):
                    skipped[inbox] = skipped.get(inbox, 0) + 1
                    if not outbox.empty():
                        continue
                    text = None  # the queue is empty, so report the skipped texts now
                self._sending[ws] = queued  # everything still queued is newer, so this is the lag
                while skipped:  # _push may skip more meanwhile
                    aid, n = skipped.popitem()
                    await ws.send(json.dumps({"type": "messages_skipped", "agent_id": aid, "count": n}))
                if text is not None:
                    await ws.send(text)
                    if not inbox:
                        urgent.popleft()
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
        self._outboxes[ws] = outbox = asyncio.Queue()
        self._urgent[ws], self._skipped[ws] = deque(), {}
        sender = asyncio.create_task(self._sender(ws, outbox))
        try:
            while True:
                try:
                    msg = json.loads(await ws.recv())
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
            self._urgent.pop(ws, None)
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
                wanted = [str(w) for w in wanted]
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
                    "luck": self.sim.agents[msg["agent_id"]].luck if ok else None}
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
                "relationships": lambda: {oid: {**r.to_json(), "name": sim.agents[oid].name}
                                          for oid, r in agent.relationships.items()},
                "memory": lambda: agent.memory[-30:],
                "inbox": lambda: agent.inbox[-20:],
                "world": lambda: {"time": sim.clock.stamp(), "season": sim.clock.season, "weather": sim.weather,
                                  "places": {p.id: {"name": p.name, "kind": p.kind, "district": p.district,
                                                    "open": p.is_open(sim.clock.hour)}
                                             for p in sim.town.places.values()},
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


async def serve(sim: Simulation, host: str, port: int, speed: int = 1) -> None:
    server = GameServer(sim, speed)
    actual = await server.start(host, port)
    print(f"GameOfAILife is running. Open http://{host if host != '0.0.0.0' else 'localhost'}:{actual} to watch as God.")
    print(f"Controllers connect to ws://{host if host != '0.0.0.0' else 'localhost'}:{actual}/ws")
    try:
        await asyncio.Event().wait()
    finally:
        await server.stop()
