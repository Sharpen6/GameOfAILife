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


def _money(x: float) -> str:
    return f"{'−' if x < 0 else ''}${abs(x):,.0f}"


def _change(x: float) -> str:
    return "±$0" if not x else f"{'−' if x < 0 else '+'}${abs(x):,.0f}"


def run_headless(sim: Simulation, days: float) -> None:
    """Simulate without a server: print the headlines as they happen, then a summary of the city, the AI players'
    decisions and everyone's worth, richest first (what God's dashboard shows)."""
    kinds: collections.Counter = collections.Counter()
    deciders: collections.Counter = collections.Counter()
    news: collections.Counter = collections.Counter()  # notable and major events, by tag
    seen: set[str] = set()
    for _ in range(int(days * 24 * 60)):
        sim.step()
        events, forks, _ = sim.drain()
        for ev in events:
            if ev["importance"] >= 1:
                news[ev["tag"]] += 1
            if ev["importance"] >= 2:  # the headlines; everyday and notable events only count
                print(f"{ev['time']}  {ev['text']}")
        for f in forks:
            if f["id"] in seen:
                continue  # sent again once its outcomes landed; count each decision once
            seen.add(f["id"])
            kinds[f["kind"]] += 1
            deciders[f["decided_by"]] += 1
    stats = sim.stats_json(full=True)
    city, llm = stats["city"], stats["llm"]
    print()
    print(f"Forks: {sum(kinds.values())} ({', '.join(f'{k} {v}' for k, v in kinds.most_common())})")
    print(f"Decided by: {', '.join(f'{k} {v}' for k, v in deciders.most_common())}")
    total = llm["total"]
    avg = f", {total['avg_seconds']} s on average" if total["avg_seconds"] is not None else ""
    print(f"AI players: asked {total['asked']}, in time {total['in_time']}{avg}, timed out {total['timeouts']}, "
          f"late {total['late']}, withdrawn {total['withdrawn']}, against habit {total['against_habit']}")
    print(f"News: {', '.join(f'{k} {v}' for k, v in news.most_common()) or 'none'}")
    print(f"People: {city['population']} of {len(sim.agents)} alive")
    w, h = city["wealth"], city["homes"]
    print(f"Wealth: {_money(w['total'])} in all, median adult {_money(w['median'])}, the richest tenth hold "
          f"{w['top10_share']}%, gini {w['gini']}, {w['in_debt']} in debt")
    print(f"Homes: {h['total']}, {h['owned']} owned, {h['rented']} rented, {h['for_sale']} for sale, "
          f"{h['for_rent']} for rent")
    print()
    print("Richest to poorest:")
    for rank, row in enumerate(stats["people"], 1):
        a = sim.agents[row["id"]]
        home = sim.homes[sim.household(a).home_id].name
        goal = f", saving for {a.goal['name']} ${a.goal['saved']:.0f}/{a.goal['target']}" if a.goal else ""
        print(f"{rank:>3}. {a.name:<18} {_money(row['worth']):>9} ({_change(row['worth'] - row['worth_24h']):>7} in 24 h)"
              f"  cash {_money(row['cash']):>8}  saved {_money(row['savings']):>8}  home {_money(row['home_equity']):>8}"
              f"  health {a.health:>3.0f}  mood {a.mood:>3.0f}  {home}{goal}")
    dead = [a for a in sim.agents.values() if not a.alive]
    for a in dead:
        print(f"     {a.name:<18} died {a.died['time'] if a.died else ''}")


if __name__ == "__main__":
    main()
