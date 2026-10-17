"""GameOfAILife: a tick-based simulation of agents living a life in a city."""

from .scenario import build_simulation
from .sim import Simulation

__all__ = ["Simulation", "build_simulation"]
