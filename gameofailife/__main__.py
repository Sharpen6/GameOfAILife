"""Run the city: `python3 -m gameofailife` serves the web view; `--headless` just simulates."""

from __future__ import annotations

import argparse
import asyncio
import collections

from .server import serve
from .sim import Simulation


def main() -> None:
    ap = argparse.ArgumentParser(prog="gameofailife", description="A city of AI characters, watched over by God.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=1, help="seed for the starter town and its dice")
    ap.add_argument("--speed", type=int, default=1, choices=(0, 1, 2, 4, 8, 16),
                    help="1 means one game day per ten real minutes")
    ap.add_argument("--luck-log", help="append every hidden odds roll to this JSONL file")
    ap.add_argument("--headless", action="store_true", help="simulate without a server and print what happened")
    ap.add_argument("--days", type=float, default=3, help="days to simulate with --headless")
    args = ap.parse_args()

    sim = Simulation(seed=args.seed, luck_log_path=args.luck_log)
    if args.headless:
        run_headless(sim, args.days)
        return
    try:
        asyncio.run(serve(sim, args.host, args.port, args.speed))
    except KeyboardInterrupt:
        pass


def run_headless(sim: Simulation, days: float) -> None:
    kinds: collections.Counter = collections.Counter()
    deciders: collections.Counter = collections.Counter()
    seen: set[str] = set()
    for _ in range(int(days * 24 * 60)):
        sim.step()
        events, forks, _ = sim.drain()
        for ev in events:
            if ev["kind"] not in ("outcome",):
                print(f"{ev['time']}  {ev['text']}")
        for f in forks:
            if f["id"] in seen:
                continue  # sent again once its outcomes landed; count each decision once
            seen.add(f["id"])
            kinds[f["kind"]] += 1
            deciders[f["decided_by"]] += 1
    print()
    print(f"Forks: {sum(kinds.values())} ({', '.join(f'{k} {v}' for k, v in kinds.most_common())})")
    print(f"Decided by: {', '.join(f'{k} {v}' for k, v in deciders.most_common())}")
    print()
    for a in sim.agents.values():
        status = "alive" if a.alive else "died"
        goal = f", saving for {a.goal['name']} ${a.goal['saved']:.0f}/{a.goal['target']}" if a.goal else ""
        print(f"{a.name:<16} {status:<5} ${a.money:>8.2f}  health {a.health:>3.0f}  mood {a.mood:>3.0f}{goal}")


if __name__ == "__main__":
    main()
