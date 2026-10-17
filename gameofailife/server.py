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
import mimetypes
from pathlib import Path

from .clock import TICKS_PER_REAL_SECOND
from .sim import Simulation
from .ws import ConnectionClosed, WebSocket, server_handshake

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"
FRAME_SECONDS = 0.05
SPEEDS = (0, 1, 2, 4, 8, 16)


class GameServer:
    def __init__(self, sim: Simulation, speed: int = 1):
        self.sim = sim
        self.speed = speed
        self.god: WebSocket | None = None
        self.observers: set[WebSocket] = set()
        self.controllers: dict[str, WebSocket] = {}
        self._server: asyncio.base_events.Server | None = None
        self._loop_task: asyncio.Task | None = None
        self._pending_ticks = 0.0

    # --- lifecycle ------------------------------------------------------------

    async def start(self, host: str = "127.0.0.1", port: int = 8000) -> int:
        self._server = await asyncio.start_server(self._handle, host, port)
        self._loop_task = asyncio.create_task(self._run())
        return self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        for ws in [self.god, *self.observers, *self.controllers.values()]:
            if ws:
                await ws.close()
        if self._server:
            self._server.close()
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
            await self._flush(stepped)

    async def _flush(self, stepped: bool) -> None:
        events, forks, outbox = self.sim.drain()
        for name, msg in outbox:
            ws = self.controllers.get(name)
            if ws:
                await self._send(ws, msg)
        viewers = [ws for ws in [self.god, *self.observers] if ws]
        if not viewers or not (stepped or events or forks):
            return
        frame = json.dumps({"type": "state", "speed": self.speed, "state": self.sim.state_json(),
                            "events": events, "forks": forks})
        for ws in viewers:
            await self._send_raw(ws, frame)

    # --- HTTP -----------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await reader.readline()
            parts = request.decode(errors="replace").split()
            if len(parts) < 2:
                writer.close()
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
        except (ConnectionError, asyncio.IncompleteReadError, ValueError):
            writer.close()

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

    async def _session(self, ws: WebSocket) -> None:
        role, name = None, None
        try:
            while True:
                try:
                    msg = json.loads(await ws.recv())
                except json.JSONDecodeError:
                    await self._send(ws, {"type": "error", "error": "messages must be JSON"})
                    continue
                if not isinstance(msg, dict):
                    continue
                if role is None:
                    if msg.get("type") != "hello":
                        await self._send(ws, {"type": "error", "error": "say hello first"})
                        continue
                    role, name = await self._hello(ws, msg)
                    continue
                try:
                    reply = self._god(msg) if role in ("god", "observer") else self._controller(name, msg)
                except (ValueError, TypeError, KeyError) as exc:
                    reply = {"type": "error", "error": f"bad message: {exc}"}
                if role == "observer" and msg.get("type") in ("set_luck", "set_speed", "pause", "resume", "set_profile"):
                    reply = {"type": "error", "error": "only God can do that; this view is watching"}
                if reply:
                    if "req_id" in msg:
                        reply["req_id"] = msg["req_id"]
                    await self._send(ws, reply)
        except ConnectionClosed:
            pass
        finally:
            if role == "controller" and self.controllers.get(name) is ws:
                del self.controllers[name]
                self.sim.release(name)
            if ws is self.god:
                self.god = None
            self.observers.discard(ws)

    async def _hello(self, ws: WebSocket, msg: dict) -> tuple[str, str | None]:
        role = msg.get("role")
        if role == "god":
            # One God per city: the newest God view takes over and the old one keeps watching.
            if self.god:
                self.observers.add(self.god)
                await self._send(self.god, {"type": "demoted", "reason": "another God view took over"})
            self.god = ws
            await self._send(ws, {"type": "welcome", "role": "god", "town": self.sim.town_json(),
                                  "state": self.sim.state_json(), "history": self.sim.history[-80:],
                                  "speed": self.speed})
            return "god", None
        if role == "controller":
            name = str(msg.get("name") or "controller")[:40]
            base, n = name, 2
            while name in self.controllers:
                name, n = f"{base}-{n}", n + 1
            self.controllers[name] = ws
            wanted = msg.get("characters") or []
            if wanted == "all":
                wanted = [a.id for a in self.sim.living() if not a.controller]
            claimed = [aid for aid in wanted if self.sim.claim(aid, name)]
            await self._send(ws, {
                "type": "welcome", "role": "controller", "name": name, "characters": claimed,
                "profiles": {aid: self.sim.agents[aid].profile.prompt for aid in claimed},
                "answer_seconds": 5, "time": self.sim.clock.stamp(),
                "available": [a.id for a in self.sim.living() if not a.controller],
            })
            for aid in claimed:
                self.sim.event(f"{self.sim.agents[aid].name} is now played by {name}.", kind="controller")
            return "controller", name
        await self._send(ws, {"type": "error", "error": "role must be god or controller"})
        raise ConnectionClosed()

    def _god(self, msg: dict) -> dict | None:
        t = msg.get("type")
        if t == "set_luck":
            ok = self.sim.set_luck(str(msg.get("agent_id")), float(msg.get("luck", 50)))
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
            ok = sim.claim(aid, name)
            return {"type": "claimed", "agent_id": aid, "ok": ok,
                    "profile": sim.agents[aid].profile.prompt if ok else None}
        if t == "release":
            sim.release(name, str(msg.get("agent_id")))
            return {"type": "released", "agent_id": msg.get("agent_id")}
        agent = sim.agents.get(str(msg.get("agent_id")))
        if t in ("query", "send_message", "invite") and (not agent or agent.controller != name):
            return {"type": "error", "error": "not your character"}
        if t == "query":
            hh = sim.household(agent)
            what = msg.get("what", "attributes")
            answers = {
                "possessions": lambda: agent.possessions(hh, sim.town.places[hh.home_id].name),
                "attributes": agent.attributes,
                "relationships": lambda: {oid: {**r.to_json(), "name": sim.agents[oid].name}
                                          for oid, r in agent.relationships.items()},
                "memory": lambda: agent.memory[-30:],
                "inbox": lambda: agent.inbox[-20:],
                "world": lambda: {"time": sim.clock.stamp(), "season": sim.clock.season, "weather": sim.weather,
                                  "places": {p.id: {"name": p.name, "kind": p.kind, "open": p.is_open(sim.clock.hour)}
                                             for p in sim.town.places.values()},
                                  "timetable": sim.timetable()},
                "people": lambda: {a.id: a.name for a in sim.living()},
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
