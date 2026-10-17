#!/usr/bin/env python3
"""A rule-based GameOfAILife controller: no LLM, just a few readable rules.

It exists to show that *any* program speaking the controller protocol can play
characters. It connects to the game's WebSocket, claims some characters, and
answers every fork (a decision moment) within the deadline:

    python3 examples/simple_controller.py --url ws://localhost:8000/ws \
        --name simple-bot --characters ari,tom --style thrifty

Styles:
  thrifty  fix the most urgent need as cheaply as possible; never overspend
  social   prefer options that involve other people, then the urgent need
  random   pick any option the character can afford

The four housing forks (house_hunt, upkeep, repair, housing_trouble) have their own rules in
choose_housing(): their costs come from the household's pooled money ("household": true on an option), so
they are weighed against `you.household_funds`, and moves are only made with money to spare.

Only the standard library and the game's own client (gameofailife.ws) are used.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # run from anywhere

from gameofailife.ws import ConnectionClosed, connect  # noqa: E402

# Words in an option's label that hint at which need it helps.
NEED_WORDS = {
    "hunger": ("cook", "eat", "food", "snack", "meal", "groceries", "dinner", "lunch",
               "breakfast", "leftovers", "cupboard", "coffee"),
    "energy": ("sleep", "rest", "relax", "nap", "bed", "drive"),
    "social": ("meet", "friend", "family", "hang out", "accept", "together", "people",
               "invite", "call", "visit", "treat"),
    "fun": ("show", "game", "park", "book", "play", "project", "diary", "watch",
            "something nice", "cafe"),
}
SOCIAL_WORDS = NEED_WORDS["social"] + ("cafe",)
BAD_WORDS = ("skip", "ignore", "push on", "sick")  # options that neglect the character or the job
REPLIES = ("Sounds good!", "Thanks for the message, talk soon.", "Ha, same here.",
           "Can't right now, but let's catch up later.", "Hope your day is going well!")


def mentions(label: str, words) -> bool:
    """True if a word of the label starts with one of `words`: 'eat' finds 'Eat out' but not 'Treat'."""
    return any(re.search(rf"\b{re.escape(w)}", label, re.I) for w in words)


def helps(label: str, words) -> bool:
    """Like mentions(), but an option that neglects the character or the job never counts as helping."""
    return mentions(label, words) and not mentions(label, BAD_WORDS)


HOUSING_KINDS = ("house_hunt", "upkeep", "repair", "housing_trouble")
SPARE = 2  # a household spends on its home only when it keeps this many times the cost
MOVE_CUSHION = 2000  # dollars a household keeps after a move, at least


def choose_housing(fork: dict, style: str) -> tuple[int, str] | None:
    """The housing rules, or None to fall back on the general rules (the random style, other kinds).

    Option order is fixed by the game: house_hunt 0 best home, 1 haggle for it, 2 the cheaper home (or keep
    looking), 3 stay; upkeep 0 builders, 1 DIY, 2 tidy up, 3 leave it; repair 0 call the trade, 1 fix it
    yourself, 2 ask a friend (or a cheap handyman), 3 wait; housing_trouble 0-1 the ways out on offer (downsize,
    ask for help, sell the car or belongings, ask for grace, odd jobs), 2 cut back, 3 hope.
    """
    kind = fork.get("kind")
    if kind not in HOUSING_KINDS or style == "random":
        return None
    you = fork.get("you", {})
    money = float(you.get("money", 0))
    funds = float(you.get("household_funds", money + float(you.get("savings", 0))))
    opts = fork["options"]

    def cost(i: int) -> float:
        return float(opts[i].get("cost", 0))

    def can(i: int, spare: float = SPARE) -> bool:
        """The household (or the character, for a personal cost) keeps `spare` times the cost."""
        pot = funds if opts[i].get("household") else money
        return cost(i) == 0 or pot >= spare * cost(i)

    if kind == "house_hunt":
        # A move costs most of the savings, so the test is what is left: a cushion of ten weeks of today's
        # housing cost, and never under MOVE_CUSHION.
        cushion = max(MOVE_CUSHION, 10 * float((you.get("home") or {}).get("weekly_cost", 0)))
        order = (1, 2, 0) if style == "thrifty" else (0, 1, 2)  # thrifty haggles; social wants room
        for i in order:
            if cost(i) > 0 and funds - cost(i) >= cushion:
                return i, f"can afford it and keep ${funds - cost(i):,.0f}"
        return 3, f"moving would leave less than ${cushion:,.0f}"
    if kind == "upkeep":
        if style == "social" and can(0, 3):
            return 0, "the family deserves a proper job"
        if "falling apart" in fork.get("question", "") and can(0):
            return 0, "too far gone for a weekend of DIY"
        for i, why in ((1, "a weekend of DIY saves the builders' bill"), (2, "a quick tidy-up is all we can spare")):
            if can(i):
                return i, why
        return 3, "no money for it this weekend"
    if kind == "repair":
        friend = opts[2]["label"].startswith("Ask ")
        if style == "social" and friend:
            return 2, "a friend will help, and it's cheaper"
        if funds > 1000 and can(0):
            return 0, "fix it properly, now"
        if style == "thrifty" and friend:
            return 2, "a friend will help, and it's cheaper"
        return (1, "try fixing it ourselves") if can(1, 1) else (3, "nothing to pay for it with")
    # housing_trouble: never just hope. From the final warning on, take the first way out on offer.
    question = fork.get("question", "")
    if "final warning" in question or "wants its money" in question:
        return 0, "it's serious now: take the first way out"
    if style == "social" and opts[1]["label"].startswith("Ask "):
        return 1, "ask for help before it gets worse"
    if style == "social" and opts[0]["label"].startswith("Ask "):
        return 0, "ask for help before it gets worse"
    return 2, "cut back hard until we're out of the red"


def choose(fork: dict, style: str, rng: random.Random) -> tuple[int, str]:
    """Return (option index, short reason) for a fork message."""
    housing = choose_housing(fork, style)
    if housing:
        return housing
    you = fork.get("you", {})
    money = float(you.get("money", 0))
    needs = you.get("needs", {})
    options = fork["options"]
    affordable = [o for o in options if o.get("cost", 0) <= max(money, 0)]  # free options stay affordable in debt
    if not affordable:  # nothing fits the budget: stick to the cheapest
        cheapest = min(o.get("cost", 0) for o in options)
        affordable = [o for o in options if o.get("cost", 0) == cheapest]

    if style == "random":
        pick = rng.choice(affordable)
        return pick["index"], f"picked at random among {len(affordable)} affordable options"

    # The most urgent need is the lowest one (needs run 0..100, 100 = satisfied).
    urgent = min(needs, key=needs.get) if needs else None
    urgent_level = needs.get(urgent, 100) if urgent else 100

    def score(o: dict) -> float:
        label, cost = o["label"], float(o.get("cost", 0))
        s = 0.0
        if urgent and helps(label, NEED_WORDS.get(urgent, ())):
            s += (100 - urgent_level) / 10  # the hungrier, the more food matters
        if mentions(label, BAD_WORDS):
            s -= 6
        if style == "thrifty":
            s -= cost / max(money, 1) * 20  # spending a big share of savings hurts
            s -= cost / 10
        elif style == "social":
            if helps(label, SOCIAL_WORDS):
                s += 4
            s -= cost / max(money, 1) * 5
        s -= o.get("travel_minutes", 0) / 60  # mild dislike of long trips
        return s

    best = max(affordable, key=score)
    cost = float(best.get("cost", 0))
    if style == "social" and helps(best["label"], SOCIAL_WORDS):
        why = "prefers being around people"
    elif urgent and helps(best["label"], NEED_WORDS.get(urgent, ())):
        why = f"{urgent} is lowest ({urgent_level})"
    else:
        why = "best value of the options"
    why += f"; costs ${cost:.2f} of ${money:.2f}" if cost else "; free"
    return best["index"], why


async def run(args: argparse.Namespace) -> int:
    rng = random.Random(args.seed)
    characters = "all" if args.characters == "all" else [c.strip() for c in args.characters.split(",") if c.strip()]
    try:
        ws = await connect(args.url)
    except (OSError, ConnectionError, ValueError) as exc:
        print(f"Could not connect to {args.url}: {exc}")
        return 1

    await ws.send(json.dumps({"type": "hello", "role": "controller", "name": args.name,
                              "characters": characters}))
    welcome = json.loads(await ws.recv())
    if welcome.get("type") != "welcome":
        print(f"Server refused: {welcome}")
        return 1
    mine = welcome.get("characters", [])
    print(f"Welcome, {welcome.get('name')}! Game time {welcome.get('time')}, "
          f"answer within {welcome.get('answer_seconds')}s.")
    print(f"Playing: {', '.join(mine) or '(none)'}   style: {args.style}")
    if not mine:
        print(f"No characters claimed. Still free: {', '.join(welcome.get('available', []))}")

    # Show querying: ask once what each character owns.
    for aid in mine:
        await ws.send(json.dumps({"type": "query", "agent_id": aid, "what": "possessions",
                                  "req_id": f"poss-{aid}"}))

    names: dict[str, str] = {}
    decided = applied = 0
    try:
        while True:
            msg = json.loads(await ws.recv())
            t = msg.get("type")
            if t == "fork":
                aid = msg["agent_id"]
                names[aid] = msg.get("you", {}).get("name", aid)
                idx, reason = choose(msg, args.style, rng)
                await ws.send(json.dumps({"type": "choose", "fork_id": msg["fork_id"],
                                          "choice": idx, "reason": reason}))
                label = msg["options"][idx]["label"]
                decided += 1
                print(f"[{msg.get('time')}] {names[aid]:<14} {msg['kind']:<10} -> {idx} {label!r} ({reason})")
            elif t == "ack":
                applied += bool(msg.get("applied"))
                detail = msg.get("note") or msg.get("error") or ""
                print(f"    ack {msg.get('fork_id')}: accepted={msg.get('accepted')} "
                      f"applied={msg.get('applied')} {detail}".rstrip())
            elif t == "message":
                me = msg.get("agent_id")
                print(f"  message to {me} from {msg.get('from_name')}: {msg.get('text')!r}")
                if me in mine and rng.random() < args.reply_chance:
                    text = rng.choice(REPLIES)
                    await ws.send(json.dumps({"type": "send_message", "agent_id": me,
                                              "to": msg.get("from"), "text": text}))
                    print(f"  {me} replies to {msg.get('from')}: {text!r}")
            elif t == "answer" and msg.get("what") == "possessions":
                data = msg.get("data", {})
                summary = ", ".join(f"{k}={v}" for k, v in data.items()
                                    if not isinstance(v, (dict, list)))
                print(f"  {msg['agent_id']} owns: {summary or json.dumps(data)[:200]}")
            elif t == "sent":
                if not msg.get("ok"):
                    print(f"  message not sent: {msg.get('error')}")
            elif t == "error":
                print(f"  server error: {msg.get('error')}")
            else:
                print(f"  ({t}) {json.dumps(msg)[:160]}")
    except ConnectionClosed:
        print(f"Disconnected from the server. Made {decided} decisions, {applied} applied in time.")
        return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="A rule-based GameOfAILife controller (no LLM).")
    ap.add_argument("--url", default="ws://localhost:8000/ws")
    ap.add_argument("--name", default="simple-bot")
    ap.add_argument("--characters", default="all", help="comma-separated ids such as ari,tom, or 'all'")
    ap.add_argument("--style", choices=("thrifty", "social", "random"), default="thrifty")
    ap.add_argument("--reply-chance", type=float, default=0.4, help="chance of replying to a message")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
