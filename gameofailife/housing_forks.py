"""The four housing forks: house hunting, upkeep, emergency repairs and housing trouble.

Each builder returns a Fork with exactly four options, or None when the fork doesn't come up. For now none
does; `forks.build_fork` resolves these lazily, so this module may import `forks` freely.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agent import Agent
    from .forks import Fork
    from .sim import Simulation

MAJOR_KINDS = {"house_hunt", "housing_trouble"}  # forks the Director settles by habit only with a lead of MAJOR_MARGIN


def repair_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """A live emergency at an owner-occupied home: call the trade, fix it yourself, ask a friend, or wait."""
    return None


def housing_trouble_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """In the red after the Sunday charge, or a home falling apart that can't be fixed."""
    return None


def house_hunt_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """A better home the household can afford is on the market."""
    return None


def upkeep_fork(sim: Simulation, agent: Agent) -> Fork | None:
    """An owned home is wearing: builders, DIY, a tidy-up, or leave it."""
    return None
