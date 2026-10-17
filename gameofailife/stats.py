"""City statistics: the decision counters now, and (from P3) the hourly samples behind God's `stats` push.

One CityStats belongs to each Simulation (`sim.stats`). The simulation counts every fork it asks a
controller about and how each fork was decided; `today` restarts at midnight, `total` never does.
Nothing here imports the simulation, so `sim.py` can import this module.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .sim import Simulation

# The decision counters, as in the `stats.llm.today` and `stats.llm.total` blocks:
#   asked          forks sent to a controller
#   in_time        answered within the deadline (count with the answer's seconds)
#   timeouts       no answer in time: the profile default played
#   late           answered after the deadline but in time to teach the profile
#   withdrawn      asked, then withdrawn (the character or the host died)
#   against_habit  in-time answers that differ from the profile's own first choice
#   habit, default forks nobody was asked about, decided by habit or by the profile
COUNTERS = ("asked", "in_time", "timeouts", "late", "withdrawn", "against_habit", "habit", "default")

# A fork summary's `decided_by` -> the counter its decision adds to.
DECIDED_BY = {"habit": "habit", "default": "default", "model": "in_time", "timeout": "timeouts",
              "withdrawn": "withdrawn"}


def _zeros() -> dict:
    """A fresh counter block: every counter at 0, plus `seconds`, the summed seconds of in-time answers."""
    block: dict = {name: 0 for name in COUNTERS}
    block["seconds"] = 0.0
    return block


def avg_seconds(block: dict) -> float | None:
    """Mean seconds of a block's in-time answers to one decimal (floor(x * 10 + 0.5) / 10), or None."""
    if not block["in_time"]:
        return None
    return math.floor(block["seconds"] / block["in_time"] * 10 + 0.5) / 10


class CityStats:
    """The city's counters (P0) and, from P3, its hourly samples, worth rings and `stats_json`."""

    def __init__(self) -> None:
        self.today: dict = _zeros()  # since midnight
        self.total: dict = _zeros()  # since the city began

    def count(self, name: str, seconds: float | None = None) -> None:
        """Add one to a counter, today and in total. `seconds` goes with `in_time` only: the answer time."""
        if name not in COUNTERS:
            raise KeyError(f"unknown counter {name!r}; one of {', '.join(COUNTERS)}")
        if seconds is not None and name != "in_time":
            raise ValueError("only in_time answers carry seconds")
        for block in (self.today, self.total):
            block[name] += 1
            if seconds is not None:
                block["seconds"] += seconds

    def reset_day(self) -> None:
        """Midnight: today's counters start again from 0."""
        self.today = _zeros()

    def sample(self, sim: Simulation) -> None:
        """Called on every whole game hour, after the agents moved. P0: records nothing; P3 fills it in."""
        return None
