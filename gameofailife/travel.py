"""Getting around: travel times, the usual way to work and what it costs a week, the usual way for any one trip
(trip_mode, with where the car is parked), and the nearest open place.

Walking and running read the town's O(1) walk fields (`sim.town.walk_minutes(xy, place_id)`). Cars and taxis
follow the roads (`sim.town.drive_length`, memoized on the shared map) and lose about a minute at each
junction's lights; an ambulance doesn't wait. A bus trip is the walk to the stop, the wait, the ride and the
walk from the stop (`transit.best_trip`), and falls back to walking when the bus doesn't save
transit.MIN_SAVING minutes. `Simulation` has delegating methods of the same names. Nothing here imports the
simulation or the town, so `sim.py` can import this module.
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
ROAD_MODES = ("car", "taxi", "ambulance")  # they follow the roads
LIGHT_WAIT = 1  # minutes a car or taxi loses at each junction on its way (about 0.75 on average, rounded up)
BUS_MIN_WALK = 25  # the bus is someone's usual way to work only when the walk is longer than this
TAXI_MIN_WALK = 40  # the work fork offers a taxi to an adult without a car only when the walk is longer than this
USUAL = "usual"  # Option.vehicle and start_plan's vehicle meaning "the usual way, trip by trip" (trip_mode)
SHORT_WALK = 8  # minutes: a walk this short from home leaves the car on the driveway
# --- region ---
MAX_OUTING_MINUTES = 40  # region world: a place beyond Millbrook qualifies only within this walk (Rule R)


def bus_trip(sim: Simulation, agent: Agent, place_id: str,
             worst: bool = False) -> tuple[int, str, str, str] | None:
    """The bus trip the character would make to a place leaving now: (minutes door to door, line, board stop,
    alight stop), or None when they are inside it or no bus saves transit.MIN_SAVING minutes over walking.
    With `worst`, the slowest departure minute's trip instead (see transit.best_trip)."""
    if agent.inside == place_id:
        return None
    return transit.best_trip(sim.town, (agent.x, agent.y), place_id, sim.clock.tick, worst)


def travel_minutes(sim: Simulation, agent: Agent, place_id: str, mode: str, worst: bool = False) -> int:
    """Minutes from where the character is to a place by `mode`: 0 when already inside.

    walk and run: ceil(walk / speed). car and taxi: ceil(road tiles / 4) plus LIGHT_WAIT at each junction on
    the drive path; ambulance: the same without the lights. bus: the trip leaving now (`bus_trip`), or with
    `worst` the slowest departure minute's trip, and walking when no bus saves transit.MIN_SAVING minutes.
    Any other mode walks. UNREACHABLE when the place cannot be reached on foot.
    """
    if agent.inside == place_id:
        return 0
    return _minutes(sim, (agent.x, agent.y), place_id, mode, worst)


def leg_minutes(sim: Simulation, start, place_id: str, mode: str, worst: bool = True) -> int:
    """Minutes by `mode` from `start` (a place id, whose entry the leg starts at, or an (x, y) tile) to a place,
    as travel_minutes counts them: 0 when start is that place. It is the later leg of a trip with a stop on the
    way, such as a coffee before work, so a bus leg counts the worst wait by default: when it starts depends on
    how long the stop takes."""
    if isinstance(start, str):
        if start == place_id:
            return 0
        start = sim.town.places[start].entry
    return _minutes(sim, (start[0], start[1]), place_id, mode, worst)


def _minutes(sim: Simulation, xy: tuple[int, int], place_id: str, mode: str, worst: bool) -> int:
    walk = sim.town.walk_minutes(xy, place_id)
    if walk >= UNREACHABLE:
        return UNREACHABLE
    if mode in ROAD_MODES:
        tiles, junctions = sim.town.drive_length(xy, place_id)
        if tiles >= UNREACHABLE:
            return UNREACHABLE
        return -(-tiles // SPEEDS[mode]) + (junctions * LIGHT_WAIT if mode != "ambulance" else 0)
    if mode == "bus":
        trip = transit.best_trip(sim.town, xy, place_id, sim.clock.tick, worst)
        return trip[0] if trip else walk
    return -(-walk // SPEEDS.get(mode, 1))


def usual_mode(sim: Simulation, agent: Agent) -> str:
    """How the character usually gets to work: "car" | "bus" | "walk".

    The car if they own one. Otherwise the bus when the walk from home to the job (or school) is longer than
    BUS_MIN_WALK minutes and, whenever they leave, a bus saves transit.MIN_SAVING minutes or more (the
    worst-case trip from home is at most walk - MIN_SAVING). Otherwise walking. It depends only on where they
    live (`sim.home_of`, a place id) and work, not on where they are now.
    """
    if agent.owns_car:
        return "car"
    job = agent.job
    if not job:
        return "walk"
    home = sim.town.places[sim.home_of(agent)].entry
    walk = sim.town.walk_minutes(home, job.place_id)
    if BUS_MIN_WALK < walk < UNREACHABLE and transit.best_trip(sim.town, home, job.place_id, 0, worst=True):
        return "bus"
    return "walk"


def commute_minutes(sim: Simulation, agent: Agent) -> int | None:
    """Minutes from here to the job (or school) by the usual mode, counting the worst bus wait; None without one.

    A bus commuter's minutes are the worst-case trip from here (walking, when no bus saves time from here), so
    setting off that long before the shift is always in time whatever the timetable.
    """
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


def car_place(sim: Simulation, agent: Agent) -> str:
    """The place id where the character's car is parked: where it was last driven to (`agent.car_at`, set as a
    car sets off), or home (car_at None, so a car at home moves house with its household)."""
    return getattr(agent, "car_at", None) or sim.home_of(agent)


def car_here(sim: Simulation, agent: Agent) -> bool:
    """True when the character owns a car and it is with them: they are travelling in it, or it is parked at the
    place they are in, at its door, or (a park) anywhere inside it."""
    if not agent.owns_car:
        return False
    if agent.vehicle == "car":
        return True
    place = sim.town.places[car_place(sim, agent)]
    if agent.inside is not None:
        return agent.inside == place.id
    if (agent.x, agent.y) == tuple(place.entry):
        return True
    return place.kind == "park" and place.x <= agent.x < place.x + place.w and place.y <= agent.y < place.y + place.h


def trip_mode(sim: Simulation, agent: Agent, place_id: str) -> str:
    """How the character makes one trip their usual way (an option's vehicle "usual"): "car" | "bus" | "walk".

    The car when they own one and it is with them (car_here), unless it stands on the driveway at home and the walk
    is SHORT_WALK minutes or less. Otherwise the bus when the walk is longer than BUS_MIN_WALK and a bus leaving
    now saves transit.MIN_SAVING minutes (bus_trip). Otherwise on foot, as for a trip to where they already are.
    On foot too when the car (with every light green) or the bus would get there before the place opens and the
    walk would not: `nearest` and the builders judge opening times by the walk.
    """
    if agent.inside == place_id:
        return "walk"
    walk = sim.walk_minutes(agent, place_id)
    mode, soonest = "walk", walk
    if car_here(sim, agent):
        home = sim.home_of(agent)
        if not (walk <= SHORT_WALK and car_place(sim, agent) == home and agent.inside == home):
            mode = "car"
    if mode == "walk" and BUS_MIN_WALK < walk < UNREACHABLE:
        trip = bus_trip(sim, agent, place_id)
        if trip is not None:
            mode, soonest = "bus", trip[0]
    hours = sim.town.places[place_id].hours
    if mode != "walk" and hours:
        if mode == "car":
            soonest = travel_minutes(sim, agent, place_id, "ambulance")  # the drive with no red lights
        now, opens = sim.clock.minute_of_day, hours[0] * 60
        if now + soonest < opens <= now + walk:
            return "walk"
    return mode


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
            stay: int = 0, max_minutes: int | None = None) -> Place | None:
    """The best place of one of `kinds` for the character to go to now, or None when none will do.

    A place qualifies when it is open by the time the character walks in from where they are and still
    open `stay` minutes later (the review fix's `_open_on_arrival`). The best one has the lowest
    walk(origin, place) + walk(meet, place), ties by id. `origin` defaults to the character; `origin` and
    `meet` may each be a character (another Agent), a Place (such as `town.places[job.place_id]` or an
    earlier nearest() result), a place id or an (x, y) tile; anything else raises TypeError.

    Rule R (region world, region.md 6.3): a character standing in the frozen rectangle (Millbrook) is offered
    only Millbrook's places; elsewhere a place beyond Millbrook also qualifies when it is within `max_minutes`
    on foot (default MAX_OUTING_MINUTES). In the millbrook world nothing changes.
    """
    if isinstance(kinds, str):
        kinds = (kinds,)
    here = _spot(sim, agent)
    start = None if origin is None else _spot(sim, origin)
    end = None if meet is None else _spot(sim, meet)
    best, best_key = None, None
    # --- region ---
    town = sim.town
    region = town.world == "region"
    if region:
        local = town.in_frozen(*here[0])
        cap = MAX_OUTING_MINUTES if max_minutes is None else max_minutes
        ids = town.millbrook_ids
    # --- end region ---
    for place in sim.town.places.values():
        if place.kind not in kinds:
            continue
        # --- region ---
        far = region and place.id not in ids
        if far and (local or _manhattan(here[0], place.entry) > cap):
            continue  # Rule R; no walk is shorter than its Manhattan distance
        # --- end region ---
        walk = _walk(sim, here, place)
        if walk >= UNREACHABLE:
            continue
        if far and walk > cap:  # --- region ---
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


# --- region ---
def _manhattan(a, b) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def named_may_visit(sim: Simulation, agent: Agent, place_id: str, max_minutes: int | None = None) -> bool:
    """Rule R for a builder that names a place directly (region.md 6.3, PLAN 2.9): True in the millbrook world
    and for Millbrook's places; a place beyond Millbrook only for a character outside the frozen rectangle and
    within `max_minutes` on foot (default MAX_OUTING_MINUTES). An unknown place id is never visitable."""
    town = sim.town
    place = town.places.get(place_id)
    if place is None:
        return False
    if town.world != "region" or place_id in town.millbrook_ids:
        return True
    here = _spot(sim, agent)
    if town.in_frozen(*here[0]):
        return False
    cap = MAX_OUTING_MINUTES if max_minutes is None else max_minutes
    return _manhattan(here[0], place.entry) <= cap and _walk(sim, here, place) <= cap
# --- end region ---
