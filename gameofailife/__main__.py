"""Run the starter town from the command line: python -m gameofailife --days 7"""

from __future__ import annotations

import argparse

from .clock import TICKS_PER_DAY
from .scenario import build_simulation


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulate a small town of agents living their lives.")
    parser.add_argument("--days", type=float, default=3, help="in-game days to simulate")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--quiet", action="store_true", help="only print the end-of-day summaries")
    args = parser.parse_args()

    sim = build_simulation(seed=args.seed, verbose=not args.quiet)
    for _ in range(int(args.days * TICKS_PER_DAY) // TICKS_PER_DAY or 1):
        sim.run(1)
        print(f"\n=== End of {sim.clock.stamp()} — {sim.city.name} ===")
        for a in sim.agents.values():
            needs = " ".join(f"{k}={v:3.0f}" for k, v in a.needs.items())
            friends = sum(1 for r in a.relationships.values() if r.affinity > 20)
            print(f"  {a.name:<15} ${a.money:8.2f}  {needs}  close={friends}  now: {a.activity}")
        fridge = ", ".join(f"{h.id}={h.groceries}" for h in sim.households.values())
        print(f"  groceries: {fridge}\n")


if __name__ == "__main__":
    main()
