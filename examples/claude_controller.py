"""Play GameOfAILife characters with Claude.

Connects to a running city as a controller, claims characters, and asks Claude
(through the Anthropic Messages API, with nothing but the standard library) to
pick one of the four options at every fork. Optionally Claude also answers text
messages in character.

    export ANTHROPIC_API_KEY=sk-ant-...
    python3 -m gameofailife &
    python3 examples/claude_controller.py --characters all
    python3 examples/claude_controller.py --characters ari,tom --model claude-sonnet-5 --chat
    python3 examples/claude_controller.py --characters all --hints

Each fork must be answered within `deadline_seconds` (5s) to be acted on; an
answer that arrives within 10s still teaches the character's profile. Requests
run in a pool of worker threads, two per claimed character, so many forks can be
in flight at once; a fork whose deadline passes before a thread is free is
skipped and the profile decides. Claude is asked at low effort so it answers in
time; pick a model that supports the effort setting (Claude Haiku 4.5 and older
models don't).

Each fork is put to Claude as one short page (about 600 tokens): who the character
is (personality, job, home, the people closest to them), how they are right now,
their last few decisions with what came of them, what is on their mind, and the
question with its four options as a) to d), in a fresh random order each time so
a habit of picking "a" never becomes a personality. Claude answers with a letter
and a few words of why. With --hints each option also says how likely it is for
this character, from the character's own habits (the city's profile scores);
without it the model decides alone.

The characters believe they are real people. Nothing sent to Claude mentions a
game, a simulation, controllers or God.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
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
LETTERS = "abcd"
HISTORY = 8  # past decisions on the page
ABOUT = ("attributes", "relationships", "memory")  # queries the page is built from


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
    lines = re.findall(r"^[a-d]\) .*$", user, re.M)
    if not lines:
        return "Sounds good, talk soon!"
    costs = [option_cost(line) for line in lines]
    return f"{lines[costs.index(min(costs))][0]} - it is the cheapest, and money is tight"


def option_cost(line: str) -> float:
    """What an option line of decision_page costs: "costs $4.00", or minus what it "brings in"."""
    m = re.search(r"(costs|brings in) \$([0-9,]+(?:\.[0-9]+)?)", line)
    if not m:
        return 0.0
    amount = float(m.group(2).replace(",", ""))
    return -amount if m.group(1) == "brings in" else amount


def parse_letter(text: str, order: list[int]) -> tuple[int, str] | None:
    """Read "b - a few words why" from a reply; return the option index the letter stands for and the reason.

    `order[k]` is the option index shown as the k-th letter."""
    letters = LETTERS[:len(order)]
    for line in text.strip().splitlines():
        m = re.match(rf"\W*(?:answer\W*)?([{letters}])\b\W*(.*)", line.strip(), re.I)
        if m:
            return order[letters.index(m.group(1).lower())], m.group(2).strip()[:300]
        if line.strip():
            break
    m = re.search(rf"\b([{letters}])\)", text)  # "I'd go with b) ..."
    if m:
        return order[letters.index(m.group(1))], text.strip()[:300]
    return None


# --- prompts ---------------------------------------------------------------------

def persona(you: dict) -> str:
    name = you.get("name", "someone")
    profile = you.get("profile") or ""
    return (f"You are {name}, a real person living an ordinary life in your town. {profile}\n"
            "Stay fully yourself: think and decide the way you would, with your own worries, habits and hopes.")


def _amount(x, places: int) -> str:
    """Money with its sign in front: "$1,200", and a debt as "-$400" (never "$-400")."""
    if not isinstance(x, (int, float)):
        return "$?"
    x = round(x, places)
    return f"{'-' if x < 0 else ''}${abs(x):,.{places}f}"


def _dollars(x) -> str:
    return _amount(x, 0)


def _cents(x) -> str:
    return _amount(x, 2)


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


def option_line(opt: dict, letter: str, hint: str = "") -> str:
    """One option, with its cost: paid by the character, or from the household's pooled money (`household`)."""
    cost = opt.get("cost") or 0
    money = f"brings in ${-cost:,.2f}" if cost < 0 else f"costs ${cost:,.2f}"
    if opt.get("household"):
        money += " from your household's money and savings"
    line = f"{letter}) {opt['label']} ({money}"
    if opt.get("travel_minutes") is not None:
        line += f", about {opt['travel_minutes']} min away"
    return line + ")" + (f"  [{hint} for you]" if hint else "")


TRAIT_WORDS = {
    "thrift": ("careful with money", "spends freely"),
    "family": ("puts family first", "values independence"),
    "social": ("loves company", "enjoys time alone"),
    "diligence": ("diligent at work", "takes work lightly"),
    "health": ("looks after your health", "ignores your health"),
    "adventure": ("tries new things", "sticks to routine"),
}


def personality(traits: dict) -> str:
    """Traits (0..1, 0.5 is neutral) in words, strongest first: "very careful with money; enjoys time alone"."""
    words = []
    for trait, value in sorted(traits.items(), key=lambda kv: -abs(kv[1] - 0.5)):
        if trait not in TRAIT_WORDS or abs(value - 0.5) < 0.05:
            continue
        lean = abs(value - 0.5)
        strength = "very " if lean > 0.3 else ("" if lean > 0.12 else "somewhat ")
        words.append(strength + TRAIT_WORDS[trait][0 if value >= 0.5 else 1])
    return "; ".join(words)


def hints(scores: list | None) -> list[str]:
    """How likely each option is for this character, from the city's profile scores (softmax)."""
    if not isinstance(scores, list) or not scores:
        return []
    weights = [math.exp(3 * float(s)) for s in scores]
    total = sum(weights)
    return ["likely" if w / total >= 0.4 else "plausible" if w / total >= 0.2 else "unlikely" for w in weights]


def stamp_key(stamp: str) -> tuple[int, int] | None:
    """Order of a game time stamp like "Day 2 Tue 15:49" (or a memory line that starts with one)."""
    m = re.match(r"Day (\d+) \w+ (\d+):(\d+)", stamp or "")
    return (int(m.group(1)), int(m.group(2)) * 60 + int(m.group(3))) if m else None


def past_decisions(history: list[dict], memory: list[str]) -> list[str]:
    """The character's recent decisions, each with what followed it.

    What followed a decision is what the character remembered between it and the next one (which may have
    other causes too). Decisions that
    led to something come first in line for the page, so the eighth quiet night's sleep does not crowd out
    the dinner that went wrong; the three most recent always stay."""
    rows = []
    for i, d in enumerate(history):
        start = stamp_key(d["time"])
        end = stamp_key(history[i + 1]["time"]) if i + 1 < len(history) else None
        results = []
        for line in memory:
            at = stamp_key(line)
            if start and at and start <= at and (end is None or at < end):
                text = line.split(": ", 1)[-1]
                results.append((text.split(": ", 1)[-1] if text.count(": ") else text).rstrip("."))
        rows.append((d, results[-2:]))
    keep = {id(d) for d, _ in rows[-3:]} | {id(d) for d, r in rows if r}
    rows = [(d, r) for d, r in rows if id(d) in keep][-HISTORY:]
    return [f"- {d['time'].removeprefix('Day ')}: {d['question'].rstrip('?. ')} -> {d['label']}. "
            f"Then: {'; '.join(r) if r else 'nothing notable'}." for d, r in rows]


def decision_page(msg: dict, about: dict | None = None, history: list[dict] | None = None,
                  order: list[int] | None = None, show_hints: bool = False) -> str:
    """The one page a fork is decided from. `about` holds query answers for the character ("attributes",
    "relationships", "memory"); `history` is what this controller chose for them before; `order[k]` is the
    option shown as the k-th letter."""
    you, about = msg.get("you", {}), about or {}
    attrs = about.get("attributes") or {}
    options = msg.get("options", [])
    order = order if order is not None else list(range(len(options)))

    who = []
    job = attrs.get("job")
    if isinstance(job, dict):
        hours = job.get("hours") or ["?", "?"]
        who.append(f"Job: {job.get('title')}, ${job.get('hourly_wage')}/hour, {hours[0]}:00 to {hours[1]}:00. "
                   f"Standing at work {attrs.get('reputation', '?')}/100.")
    elif attrs:
        who.append("No job right now.")
    if attrs.get("traits"):
        who.append(f"Personality: {personality(attrs['traits'])}.")
    if home_line(you):
        who.append(home_line(you))
    rels = about.get("relationships") or {}
    close = sorted(rels.values(), key=lambda r: -(r.get("affinity") or 0))[:5]
    if close:
        who.append("Closest people: " + "; ".join(
            f"{str(r.get('name', '?')).split()[0]} ({r.get('kind')}, {round(r.get('affinity') or 0)})" for r in close) + ".")

    needs = ", ".join(f"{k} {v}" for k, v in (you.get("needs") or {}).items())
    goal = you.get("goal")
    goal_line = (f"Saving for {goal.get('name')}: ${goal.get('saved', 0):.0f} of ${goal.get('target')}."
                 if isinstance(goal, dict) else "No particular savings goal.")
    where = you.get("where_name") or you.get("where")
    home_name = you.get("home_name") or ""
    # A flat is named after its building ("Birch Court, flat 2A"), and the building is the place they are in.
    if where and (where == home_name or home_name.startswith(f"{where}, ")):
        where = "home"
    money = f"Money {_cents(you.get('money', 0))} on you, {_cents(you.get('savings') or 0)} in savings"
    if you.get("household_funds") is not None:
        money += f", household {_dollars(you['household_funds'])} between you"
    now = [f"{msg.get('time')}, {msg.get('season')}, {msg.get('weather')}. You are at: {where}.",
           f"{money}. {goal_line}",
           f"Health {you.get('health')}; {needs} (100 means fully satisfied). Groceries at home: {you.get('groceries_at_home')}."]

    memory = list(about.get("memory") or [])
    memory += [m for m in you.get("recent_memory") or [] if m not in memory]  # the fork's lines are the freshest
    memory.sort(key=lambda m: stamp_key(m) or (0, 0))
    decisions = past_decisions(history or [], memory)
    mind = [f"- {m}" for m in memory[-4:]] or ["- nothing much"]

    tags = hints(msg.get("profile_scores")) if show_hints else []
    lines = [option_line(options[i], LETTERS[k], tags[i] if i < len(tags) else "") for k, i in enumerate(order)]
    sections = [("WHO YOU ARE", who), ("RIGHT NOW", now), ("YOUR RECENT DECISIONS", decisions or ["- none yet"]),
                ("ON YOUR MIND", mind)]
    body = "\n\n".join(f"{title}\n" + "\n".join(rows) for title, rows in sections if rows)
    return (f"{body}\n\nDECISION: {msg.get('question')}\n" + "\n".join(lines) + "\n\n"
            f"Decide quickly. Reply on one line: the letter ({', '.join(LETTERS[:len(order)])}), "
            "then a few words in your own voice saying why. Example: b - I'm saving every dollar this month.")


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
        self.about: dict[str, dict] = {}  # character id -> latest query answers: attributes, relationships, memory
        self.history: dict[str, list[dict]] = {}  # character id -> the decisions this controller made for them
        self.rng = random.Random()
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
            for agent_id in claimed:
                self.refresh(agent_id)
            if not claimed:
                print(f"Nobody claimed. Free characters: {', '.join(msg.get('available') or []) or 'none'}")
        elif t == "answer" and msg.get("what") == "people":
            self.names.update(msg.get("data") or {})
        elif t == "answer" and msg.get("what") in ABOUT:
            self.about.setdefault(msg.get("agent_id"), {})[msg["what"]] = msg.get("data")
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
        order = list(range(len(options)))
        self.rng.shuffle(order)  # a fresh order each time, so a liking for "a" never becomes a personality
        page = decision_page(msg, self.about.get(msg["agent_id"]), self.history.get(msg["agent_id"]), order,
                             getattr(self.args, "hints", False))
        self.refresh(msg["agent_id"])  # fresh answers for the next page; this one uses what is already here
        try:
            text = await asyncio.get_running_loop().run_in_executor(
                self.pool, self.ask_in_time, deadline, persona(you), page)
        except Exception as exc:  # network trouble, timeouts, bad key: the city falls back to the profile
            print(f"{msg.get('time')}  {you.get('name')}: no answer ({exc}); the profile will decide")
            return
        if text is None:
            print(f"{msg.get('time')}  {you.get('name')}: no free worker before the deadline; the profile will decide")
            return
        parsed = parse_letter(text, order)
        if parsed is None:
            print(f"{msg.get('time')}  {you.get('name')}: could not read a choice from {text[:80]!r}")
            return
        choice, reason = parsed
        self.pending[fork_id] = {"time": msg.get("time"), "name": you.get("name"), "label": options[choice]["label"],
                                 "agent_id": msg["agent_id"], "question": msg.get("question", ""),
                                 "reason": reason, "seconds": time.monotonic() - started,
                                 "deadline": msg.get("deadline_seconds", 5)}
        await self.send({"type": "choose", "fork_id": fork_id, "choice": choice, "reason": reason})

    def refresh(self, agent_id: str) -> None:
        """Ask the city about a character; the answers land in self.about when they arrive."""
        for what in ABOUT:
            self.spawn(self.send({"type": "query", "agent_id": agent_id, "what": what}))

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
            past = self.history.setdefault(info["agent_id"], [])
            past.append({"time": info["time"], "question": info["question"], "label": info["label"]})
            del past[:-3 * HISTORY]
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
    ap.add_argument("--hints", action="store_true",
                    help="tell the model how likely each option is for the character, from their habits")
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
