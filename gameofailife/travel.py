"""Getting around: travel times, the usual way to work and what it costs a week, and the nearest open place.

Everything reads the town's O(1) walk fields through `sim.town.walk_minutes(xy, place_id)`. P0 writes the
simple versions: a trip takes ceil(walk / speed) and the bus counts as walking. P1 adds roads, junction
waits and buses behind the same signatures. `Simulation` has delegating methods of the same names.
Nothing here imports the simulation or the town, so `sim.py` can import this module.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from . import transit
from .transit import BUS_FARE

if TYPE_CHECKING:
    from .agent import Agent
    from .sim import Simulation
    from .town import Place

SPEEDS = {"walk": 1, "run": 2, "car": 4, "taxi": 4, "ambulance": 4, "bus": 1}  # tiles a minute
# "bus" is the rider's own walking legs; the bus itself moves at transit.SPEED.
TAXI_FARE = 12  # flat fare door to door
TRIP_COST = {"walk": 0, "car": 2, "bus": 2 * BUS_FARE}  # a workday's commute, there and back, by usual mode
UNREACHABLE = 65535  # what the walk fields give for a tile that cannot reach the place


def travel_minutes(sim: Simulation, agent: Agent, place_id: str, mode: str, worst: bool = False) -> int:
    """Minutes from where the character is to a place by `mode`: 0 when already inside.

    P0: ceil(walk / SPEEDS[mode]), with the bus as walking; `worst` (count a full headway as the bus
    wait) changes nothing until P1. UNREACHABLE when the place cannot be reached on foot.
    """
    if agent.inside == place_id:
        return 0
    walk = sim.town.walk_minutes((agent.x, agent.y), place_id)
    if walk >= UNREACHABLE:
        return UNREACHABLE
    return -(-walk // SPEEDS.get(mode, 1))


def usual_mode(sim: Simulation, agent: Agent) -> str:
    """How the character usually gets to work: "car" | "bus" | "walk". P0: the car if they own one."""
    return "car" if agent.owns_car else "walk"


def commute_minutes(sim: Simulation, agent: Agent) -> int | None:
    """Minutes from here to the job (or school) by the usual mode, counting the worst bus wait; None without one."""
    if not agent.job:
        return None
    return travel_minutes(sim, agent, agent.job.place_id, usual_mode(sim, agent), worst=True)


def weekly_commute_cost(sim: Simulation, agent: Agent) -> int:
    """What a week of commuting costs: one TRIP_COST of the usual mode for each workday.

    0 without a paid job (school is free); the bus is free under 18 and from 65.
    """
    job = agent.job
    if not job or job.hourly_wage <= 0:
        return 0
    mode = usual_mode(sim, agent)
    if mode == "bus" and not transit.fare(agent.age):
        return 0
    return len(job.workdays) * TRIP_COST.get(mode, 0)


def _spot(sim: Simulation, where) -> tuple[tuple[int, int], str | None]:
    """Where a walk starts: (tile, the id of the place it starts inside, or None).

    `where` is a Place or a place id (its entry tile, inside that place), a character (their tile, inside
    `inside`) or an (x, y) tile (inside nothing). A Place is told from a character by its `entry`: its own
    x and y are the building's corner, usually a tile nobody can walk from.
    """
    if isinstance(where, str):
        where = sim.town.places[where]
    if isinstance(where, (tuple, list)) and len(where) == 2:
        return (where[0], where[1]), None
    if hasattr(where, "entry"):
        return tuple(where.entry), where.id
    if hasattr(where, "x") and hasattr(where, "y"):
        return (where.x, where.y), getattr(where, "inside", None)
    raise TypeError(f"cannot walk from {where!r}: give a character, a Place, a place id or an (x, y) tile")


def _walk(sim: Simulation, spot: tuple[tuple[int, int], str | None], place: Place) -> int:
    """Minutes on foot from a `_spot` to a place: 0 when the spot is inside that place."""
    tile, inside = spot
    if inside == place.id:
        return 0
    return sim.town.walk_minutes(tile, place.id)


def nearest(sim: Simulation, agent: Agent, kinds: tuple[str, ...], origin=None, meet=None,
            stay: int = 0) -> Place | None:
    """The best place of one of `kinds` for the character to go to now, or None when none will do.

    A place qualifies when it is open by the time the character walks in from where they are and still
    open `stay` minutes later (the review fix's `_open_on_arrival`). The best one has the lowest
    walk(origin, place) + walk(meet, place), ties by id. `origin` defaults to the character; `origin` and
    `meet` may each be a character (another Agent), a Place (such as `town.places[job.place_id]` or an
    earlier nearest() result), a place id or an (x, y) tile; anything else raises TypeError.
    """
    if isinstance(kinds, str):
        kinds = (kinds,)
    here = _spot(sim, agent)
    start = None if origin is None else _spot(sim, origin)
    end = None if meet is None else _spot(sim, meet)
    best, best_key = None, None
    for place in sim.town.places.values():
        if place.kind not in kinds:
            continue
        walk = _walk(sim, here, place)
        if walk >= UNREACHABLE:
            continue
        arrive = sim.clock.hour + walk / 60
        if not (place.is_open(arrive) and place.is_open(arrive + stay / 60)):
            continue
        score = walk if start is None else _walk(sim, start, place)
        if end is not None:
            score += _walk(sim, end, place)
        if score >= UNREACHABLE:
            continue
        key = (score, place.id)
        if best_key is None or key < best_key:
            best, best_key = place, key
    return best
