"""Play GameOfAILife characters with Claude.

Connects to a running city as a controller, claims characters, and asks Claude
(through the Anthropic Messages API, with nothing but the standard library) to
pick one of the four options at every fork. Optionally Claude also answers text
messages in character.

    export ANTHROPIC_API_KEY=sk-ant-...
    python3 -m gameofailife &
    python3 examples/claude_controller.py --characters all
    python3 examples/claude_controller.py --characters ari,tom --model claude-sonnet-5 --chat

Each fork must be answered within `deadline_seconds` (5s) to be acted on; an
answer that arrives within 10s still teaches the character's profile. Requests
run in a pool of worker threads, two per claimed character, so many forks can be
in flight at once; a fork whose deadline passes before a thread is free is
skipped and the profile decides. Claude is asked at low effort so it answers in
time; pick a model that supports the effort setting (Claude Haiku 4.5 and older
models don't).

The characters believe they are real people. Nothing sent to Claude mentions a
game, a simulation, controllers or God.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gameofailife.ws import ConnectionClosed, connect  # noqa: E402

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-haiku-5-5"
HTTP_TIMEOUT = 9.0
CHAT_COOLDOWN = 30.0  # real seconds between replies in one conversation, so two Claudes don't chat forever


# --- talking to Claude ---------------------------------------------------------

def call_claude(api_key: str, model: str, system: str, user: str, max_tokens: int = 1024) -> str:
    """One blocking Messages API call; returns the text of the reply."""
    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,  # thinking counts toward this, so leave room beyond the short answer
        "output_config": {"effort": "low"},  # think little: the answer is due within 5s
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    # Read blocks by type: the reply can start with thinking blocks, or hold nothing else.
    text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
    if not text.strip() or data.get("stop_reason") == "refusal":
        raise RuntimeError(f"no reply text (stop_reason {data.get('stop_reason')})")
    return text


def fake_claude(api_key: str, model: str, system: str, user: str, max_tokens: int = 1024) -> str:
    """Offline stand-in for testing without a key: picks the cheapest option."""
    time.sleep(0.3)
    if "Options:" not in user:
        return "Sounds good, talk soon!"
    costs = [option_cost(line) for line in re.findall(r"^\d+\. .*$", user, re.M)] or [0.0]
    choice = costs.index(min(costs))
    return f'Sure. {{"choice": {choice}, "reason": "it is the cheapest, and money is tight"}}'


def option_cost(line: str) -> float:
    """What an option line of fork_prompt costs: "costs $4.00", or minus what it "brings in"."""
    m = re.search(r"(costs|brings in) \$([0-9,]+(?:\.[0-9]+)?)", line)
    if not m:
        return 0.0
    amount = float(m.group(2).replace(",", ""))
    return -amount if m.group(1) == "brings in" else amount


def parse_choice(text: str, n_options: int) -> tuple[int, str] | None:
    """Pull {"choice": n, "reason": "..."} out of a reply, tolerating chatter around it."""
    for match in re.finditer(r"\{.*?\}", text, re.S):
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "choice" in obj:
            try:
                choice = int(obj["choice"])
            except (TypeError, ValueError):
                continue
            if 0 <= choice < n_options:
                return choice, str(obj.get("reason", ""))[:300]
    m = re.search(r'"?choice"?\s*[:=]\s*"?(\d)', text) or re.search(r"\b(\d)\b", text)
    if m and 0 <= int(m.group(1)) < n_options:
        return int(m.group(1)), text.strip()[:300]
    return None


# --- prompts ---------------------------------------------------------------------

def persona(you: dict) -> str:
    name = you.get("name", "someone")
    profile = you.get("profile") or ""
    return (f"You are {name}, a real person living an ordinary life in your town. {profile}\n"
            "Stay fully yourself: think and decide the way you would, with your own worries, habits and hopes.")


def _dollars(x) -> str:
    return f"${x:,.0f}" if isinstance(x, (int, float)) else "$?"


def home_line(you: dict) -> str:
    """Where the character lives, what it costs a week and what shape it is in (the fork's `you.home`)."""
    home = you.get("home")
    if not isinstance(home, dict):
        return f"You live at {you.get('home_name')}." if you.get("home_name") else ""
    tier = str(home.get("tier") or "home").replace("_", " ")
    owned = home.get("tenure") == "owned"
    cost = (f"you own it and pay {_dollars(home.get('weekly_cost'))} a week in property tax" if owned
            else f"you rent it for {_dollars(home.get('weekly_cost'))} a week")
    line = f"You live at {home.get('name')}, a {tier}; {cost}. It is {home.get('stage_name')} (condition {home.get('condition')}/100)"
    return line + (f" and worth about {_dollars(home.get('value'))}." if owned else ".")


def option_line(opt: dict) -> str:
    """One option, with its cost: paid by the character, or from the household's pooled money (`household`)."""
    cost = opt.get("cost") or 0
    money = f"brings in ${-cost:,.2f}" if cost < 0 else f"costs ${cost:,.2f}"
    if opt.get("household"):
        money += " from your household's money and savings"
    line = f"{opt['index']}. {opt['label']} ({money}"
    if opt.get("travel_minutes") is not None:
        line += f", about {opt['travel_minutes']} min away"
    return line + ")"


def fork_prompt(msg: dict) -> str:
    you = msg.get("you", {})
    needs = ", ".join(f"{k} {v}/100" for k, v in (you.get("needs") or {}).items())
    goal = you.get("goal")
    goal_line = (f"You are saving for {goal.get('name')}: ${goal.get('saved', 0):.0f} of ${goal.get('target')}."
                 if isinstance(goal, dict) else "No particular savings goal right now.")
    memory = "\n".join(f"- {m}" for m in you.get("recent_memory") or []) or "- nothing much"
    options = [option_line(opt) for opt in msg.get("options", [])]
    where = you.get("where_name") or you.get("where")
    if where and where == you.get("home_name"):
        where = "home"
    money = f"You have ${you.get('money', 0):,.2f} on you and ${you.get('savings') or 0:,.2f} in savings"
    if you.get("household_funds") is not None:
        money += f"; your household has {_dollars(you['household_funds'])} between you, savings included"
    return (
        f"It is {msg.get('time')}, {msg.get('season')}, weather: {msg.get('weather')}.\n"
        f"You are at: {where}. {money}. Health {you.get('health')}/100.\n"
        f"{home_line(you)}\n"
        f"How you feel (higher means more satisfied): {needs}.\n"
        f"Groceries at home: {you.get('groceries_at_home')}. {goal_line}\n"
        f"Recently:\n{memory}\n\n"
        f"{msg.get('question')}\n\nOptions:\n" + "\n".join(options) + "\n\n"
        'Decide quickly. Reply with only JSON: {"choice": <option number>, "reason": "<a few words, in your own voice>"}'
    )


def chat_prompt(msg: dict) -> str:
    return (f"It is {msg.get('time')}. You get a text from {msg.get('from_name')}:\n\"{msg.get('text')}\"\n\n"
            "Write your text back: one or two short, natural sentences. Reply with only the text itself.")


# --- the controller ----------------------------------------------------------------

class ClaudeController:
    def __init__(self, args: argparse.Namespace, api_key: str):
        self.args = args
        self.api_key = api_key
        self.ask = fake_claude if args.fake else call_claude
        self.pool: ThreadPoolExecutor | None = None  # sized once we know how many characters we play
        self.ws = None
        self.profiles: dict[str, str] = {}
        self.names: dict[str, str] = {}
        self.pending: dict[str, dict] = {}  # fork_id -> what we sent, printed when the ack arrives
        self.last_chat: dict[tuple[str, str], float] = {}
        self.tasks: set[asyncio.Task] = set()
        self.decisions = 0

    def spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def send(self, msg: dict) -> None:
        try:
            await self.ws.send(json.dumps(msg))
        except ConnectionClosed:
            pass

    async def run(self) -> None:
        self.ws = await connect(self.args.url)
        chars = self.args.characters
        wanted = "all" if chars == "all" else [c.strip() for c in chars.split(",") if c.strip()]
        await self.send({"type": "hello", "role": "controller", "name": self.args.name, "characters": wanted,
                         "model": self.args.model})  # shown to God's dashboard, never to the characters
        try:
            while True:
                msg = json.loads(await self.ws.recv())
                self.handle(msg)
        except ConnectionClosed:
            print("Disconnected from the city.")
        finally:
            for task in list(self.tasks):
                task.cancel()
            if self.pool:
                self.pool.shutdown(wait=False, cancel_futures=True)

    def handle(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "welcome":
            self.profiles.update(msg.get("profiles") or {})
            claimed = msg.get("characters") or []
            # A thread per character for its fork and one for a chat reply, so a burst of forks
            # never waits behind the small default pool and misses the deadline.
            self.pool = ThreadPoolExecutor(max_workers=2 * max(len(claimed), 1))
            print(f"Connected as {msg.get('name')} with model {self.args.model}"
                  f"{' (fake)' if self.args.fake else ''}; playing {len(claimed)} characters: {', '.join(claimed) or 'none'}")
            if claimed:  # learn everyone's full name, for texts that arrive before any fork
                self.spawn(self.send({"type": "query", "agent_id": claimed[0], "what": "people"}))
            else:
                print(f"Nobody claimed. Free characters: {', '.join(msg.get('available') or []) or 'none'}")
        elif t == "answer" and msg.get("what") == "people":
            self.names.update(msg.get("data") or {})
        elif t == "fork":
            self.spawn(self.decide(msg))
        elif t == "message" and self.args.chat:
            self.spawn(self.reply(msg))
        elif t == "ack":
            self.report(msg)
        elif t == "error":
            print(f"server: {msg.get('error')}")

    async def decide(self, msg: dict) -> None:
        fork_id, you = msg["fork_id"], msg.get("you", {})
        self.names[msg["agent_id"]] = you.get("name", msg["agent_id"])
        if you.get("profile"):
            self.profiles[msg["agent_id"]] = you["profile"]
        else:
            you = {**you, "profile": self.profiles.get(msg["agent_id"], "")}
        options = msg.get("options", [])
        started = time.monotonic()
        deadline = started + msg.get("deadline_seconds", 5)
        try:
            text = await asyncio.get_running_loop().run_in_executor(
                self.pool, self.ask_in_time, deadline, persona(you), fork_prompt(msg))
        except Exception as exc:  # network trouble, timeouts, bad key: the city falls back to the profile
            print(f"{msg.get('time')}  {you.get('name')}: no answer ({exc}); the profile will decide")
            return
        if text is None:
            print(f"{msg.get('time')}  {you.get('name')}: no free worker before the deadline; the profile will decide")
            return
        parsed = parse_choice(text, len(options))
        if parsed is None:
            print(f"{msg.get('time')}  {you.get('name')}: could not read a choice from {text[:80]!r}")
            return
        choice, reason = parsed
        self.pending[fork_id] = {"time": msg.get("time"), "name": you.get("name"), "label": options[choice]["label"],
                                 "reason": reason, "seconds": time.monotonic() - started,
                                 "deadline": msg.get("deadline_seconds", 5)}
        await self.send({"type": "choose", "fork_id": fork_id, "choice": choice, "reason": reason})

    def ask_in_time(self, deadline: float, system: str, user: str) -> str | None:
        """Runs in a worker thread. Returns None, without calling the API, if the deadline passed while queued."""
        if time.monotonic() > deadline:
            return None
        return self.ask(self.api_key, self.args.model, system, user)

    def report(self, ack: dict) -> None:
        info = self.pending.pop(str(ack.get("fork_id")), None)
        if not info:
            return
        self.decisions += 1
        if ack.get("applied"):
            status = "applied"
        elif ack.get("accepted"):
            status = "late, learned"
        else:
            status = f"rejected: {ack.get('error')}"
        print(f"{info['time']}  {info['name']}: {info['label']} - {info['reason']} "
              f"[{info['seconds']:.1f}s, {status}]")

    async def reply(self, msg: dict) -> None:
        me, other = msg.get("agent_id"), msg.get("from")
        now = time.monotonic()
        if now - self.last_chat.get((me, other), -CHAT_COOLDOWN) < CHAT_COOLDOWN:
            return
        self.last_chat[(me, other)] = now
        you = {"name": self.names.get(me, me), "profile": self.profiles.get(me, "")}
        try:
            text = await asyncio.get_running_loop().run_in_executor(
                self.pool, self.ask, self.api_key, self.args.model, persona(you), chat_prompt(msg))
        except Exception as exc:
            print(f"{msg.get('time')}  {you['name']}: could not reply to {msg.get('from_name')} ({exc})")
            return
        text = text.strip().strip('"')[:300]
        if text:
            await self.send({"type": "send_message", "agent_id": me, "to": other, "text": text})
            print(f"{msg.get('time')}  {you['name']} -> {msg.get('from_name')}: {text}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Play GameOfAILife characters with Claude.")
    ap.add_argument("--url", default="ws://localhost:8000/ws")
    ap.add_argument("--name", default="claude", help="controller name shown in the city")
    ap.add_argument("--characters", default="all", help="'all' or comma-separated character ids")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model id (default {DEFAULT_MODEL})")
    ap.add_argument("--chat", action="store_true", help="also answer incoming text messages in character")
    ap.add_argument("--fake", action="store_true", help=argparse.SUPPRESS)  # offline testing without a key
    args = ap.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key and not args.fake:
        sys.exit("ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and run:\n"
                 "  export ANTHROPIC_API_KEY=sk-ant-...")
    try:
        asyncio.run(ClaudeController(args, api_key).run())
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as exc:  # nothing listening there, or not a ws:// URL
        sys.exit(f"Could not reach the city at {args.url}: {exc}")


if __name__ == "__main__":
    main()
